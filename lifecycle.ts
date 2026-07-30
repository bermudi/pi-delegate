import * as fs from "node:fs";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentProgressUpdate,
  AcquiredSession,
  ResolvedTask,
  TaskProgress,
  TaskResult,
  TaskRunEnv,
} from "./types.ts";
import * as pool from "./pool.ts";
import { isSessionBusy } from "./tickets.ts";
import {
  createSubagentSessionManager,
  setParentSession,
  persistSessionHeader,
} from "./sessions.ts";
import { runAgentSession } from "./runner.ts";
import { getGitChangedFiles } from "./file-tracking.ts";
import { getHostDeps } from "./host.ts";
import { resolveCwd, validateResumeFromPath } from "./utils.ts";
import { getWholeTaskMaxRetries, getWholeTaskBaseDelayMs } from "./config.ts";
import { addUsage, emptyUsage } from "./usage.ts";

/**
 * Test-only overrides for whole-task retry settings. When set, these bypass
 * the config-driven values so retry integration tests don't sleep real seconds.
 * Set via `_setWholeTaskRetryForTesting`.
 */
let testWholeTaskMaxRetries: number | undefined;
let testWholeTaskBaseDelayMs: number | undefined;

/** @internal Test-only override for whole-task retry count and base delay. */
export function _setWholeTaskRetryForTesting(
  opts:
    | {
        maxRetries?: number;
        baseDelayMs?: number;
      }
    | undefined,
): void {
  testWholeTaskMaxRetries = opts?.maxRetries;
  testWholeTaskBaseDelayMs = opts?.baseDelayMs;
}

function resolvedWholeTaskMaxRetries(): number {
  return testWholeTaskMaxRetries ?? getWholeTaskMaxRetries();
}
function resolvedWholeTaskBaseDelayMs(): number {
  return testWholeTaskBaseDelayMs ?? getWholeTaskBaseDelayMs();
}

/** Build a failed TaskResult. Used for early-failure paths (abort, busy, validation). */
function failTask(
  task: ResolvedTask,
  error: string,
  sessionFile?: string,
): TaskResult {
  return {
    agent: task.agentName,
    output: "",
    error,
    durationMs: 0,
    tokens: 0,
    usage: emptyUsage(),
    sessionFile,
    touchedFiles: [],
  };
}

/** Build a successful TaskResult for session-management actions (close/list).
 *  Pass elapsedMs to record wall time since delegate started (matches the live progress UI). */
function completeSessionAction(
  task: ResolvedTask,
  output: string,
  elapsedMs?: number,
): TaskResult {
  return {
    agent: task.agentName,
    output,
    durationMs: elapsedMs ?? 0,
    tokens: 0,
    usage: emptyUsage(),
    sessionFile: undefined,
    touchedFiles: [],
  };
}

/** Dispose a materialized session that was never committed to the pool.
 * Pool hits remain live and must not be disposed by a failed task. */
function disposeUncommittedSession(acquired: AcquiredSession): void {
  if (!acquired.disposeOnAbort) return;
  try {
    acquired.session.dispose();
  } catch (error) {
    // Preserve the cancellation result, but emit the cleanup failure so a
    // broken provider/session implementation is not silently ignored.
    console.error("[delegate] aborted subagent disposal failed", error);
  }
}

/** Mirror a progress update from runAgent into a TaskProgress row. */
export function updateProgressFromRun(
  p: TaskProgress,
  u: AgentProgressUpdate,
): void {
  p.tokens = u.tokens;
  p.toolUses = u.toolUses;
  p.durationMs = u.durationMs;
  p.lastActivityAt = u.lastActivityAt;
  p.activities = u.activities;
  p.failureKind = u.failureKind;
}

/** Mirror a completed TaskResult into a TaskProgress row (status/duration/error). */
function updateProgressFromResult(p: TaskProgress, r: TaskResult): void {
  p.status = r.error ? "failed" : "done";
  p.durationMs = r.durationMs;
  p.tokens = r.tokens;
  p.error = r.error;
  p.failureKind = r.failureKind;
}

/** Apply a TaskResult to progress and notify the env (sync fires onUpdate).
 *  Used at every return point in runResolvedTask — mirrors the old fire() pattern
 *  that the duplicated sync/async bodies used after every early-return. */
function finishTask(
  env: TaskRunEnv,
  p: TaskProgress,
  r: TaskResult,
): TaskResult {
  updateProgressFromResult(p, r);
  env.onStatusChange?.();
  return r;
}

function isClearlyTransientFinalError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  if (e.includes("abort")) return false;
  return (
    /\b429\b/.test(e) ||
    /\b5\d\d\b/.test(e) ||
    e.includes('"code":"1305"') ||
    e.includes("temporarily overloaded") ||
    e.includes("temporarily unavailable") ||
    e.includes("overloaded") ||
    e.includes("rate limit") ||
    e.includes("too many requests") ||
    e.includes("timeout") ||
    e.includes("timed out") ||
    e.includes("connection reset") ||
    e.includes("econnreset") ||
    e.includes("connection refused") ||
    e.includes("network error")
  );
}

function canRetryWholeTask(task: ResolvedTask, result: TaskResult): boolean {
  // Whole-task retry can repeat tool side effects. Keep it to stateless fresh
  // tasks, and only when our touched-file accounting says the failed attempt
  // did not write/edit anything.
  return (
    result.failureKind !== "stalled" &&
    !task.sessionId &&
    !task.resumeFrom &&
    result.touchedFiles.length === 0 &&
    isClearlyTransientFinalError(result.error)
  );
}

async function sleepForWholeTaskRetry(
  signal: AbortSignal | undefined,
  delayMs: number,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timeout = setTimeout(done, delayMs);
    if (!signal) return;
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Build the AgentSession for a fresh or resumed subagent via createAgentSession.
 *  Reuses the caller-supplied sessionManager (so parent-linking + per-task .jsonl
 *  files stay under our control) and the shared host deps (cached per-cwd
 *  resourceLoader/settingsManager/modelRuntime). */
async function buildDelegateSession(
  task: ResolvedTask,
  sessionManager: SessionManager,
  modelRegistry: TaskRunEnv["modelRegistry"],
): Promise<AgentSession> {
  // Resolve shared host deps for this task's cwd + system prompt (cached after
  // the first call). resourceLoader is cwd-scoped (it scans for AGENTS.md/skills)
  // and the system prompt is per named-agent, so the cache key is (cwd + prompt).
  // The custom prompt overrides the default AgentSession system prompt.
  // Pass only the provider needed by this task. This keeps a non-Kilo task
  // from receiving Kilo's provider/auth adapter merely because Kilo is also
  // configured in the parent runtime.
  const providerConfig = modelRegistry.getRegisteredProviderConfig?.(
    task.model.provider,
  );
  const providerConfigs = providerConfig
    ? ([[task.model.provider, providerConfig]] as const)
    : [];
  const hostDeps = await getHostDeps({
    cwd: task.cwd,
    systemPrompt: task.systemPrompt,
    providerConfigs,
  });

  const { session } = await createAgentSession({
    cwd: task.cwd,
    model: task.model,
    thinkingLevel: task.thinking,
    tools: task.tools,
    sessionManager,
    // Shared, read-only heavy deps (cached per cwd+prompt): the canonical
    // model/auth runtime (reads the same ~/.pi/agent files as the parent),
    // settings manager, and resource loader (reload() runs once per cwd).
    // Since pi 0.80.8 `createAgentSession` takes `modelRuntime` in place of
    // the removed `authStorage`/`modelRegistry` options.
    modelRuntime: hostDeps.modelRuntime,
    settingsManager: hostDeps.settingsManager,
    resourceLoader: hostDeps.resourceLoader,
  });
  return session;
}

/** Resolve the agent + session for a task. Single source of truth for pool, resume, and miss logic. */
async function acquireAgentSession(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
): Promise<AcquiredSession | { error: TaskResult }> {
  let sessionManager: SessionManager | undefined;
  let sessionFile: string | undefined;

  // ── Pool hit (reuse live stateful session) ───────────────────────────────
  // The SessionPool owns the freeze compare — checkout returns a structured
  // mismatch; lifecycle only formats the error. checkout is pure (no lastUsed
  // bump), so a speculative checkout that bails leaves no trace; lastUsed is
  // bumped by commit() on a successful run.
  if (task.sessionId) {
    const co = pool.checkout(task.sessionId, {
      cwd: task.cwd,
      thinking: task.thinking,
      tools: task.tools,
      ...task.reuseIntent,
    });
    if (co.status === "mismatch") {
      const detail = co.mismatches
        .map((m) => `${m.field}: '${m.frozen}' vs '${m.requested}'`)
        .join("; ");
      return {
        error: failTask(
          task,
          `Session '${task.sessionId}' config mismatch. Close and recreate: ${detail}`,
        ),
      };
    }
    if (co.status === "hit") {
      // A pooled session has its own accumulated context — resumeFrom pointing
      // elsewhere is contradictory. This folds the old defensive agentPool.has
      // precheck: checkout already told us the session is live.
      if (task.resumeFrom) {
        return {
          error: failTask(
            task,
            `resumeFrom conflicts with active sessionId '${task.sessionId}'. The pooled session has its own accumulated context. Close the session first if you want to resume from a different point.`,
          ),
        };
      }
      p.model = co.modelId;
      return {
        session: co.session,
        sessionManager: co.sessionManager,
        sessionFile: co.sessionFile,
        disposeOnAbort: false,
      };
    }
    // status === "miss" → fall through to resume / fresh materialization.
  }

  // ── Resume from a previous session file ──────────────────────────────────
  // Resume takes precedence over a fresh sessionId miss: resumeFrom points at a
  // concrete prior conversation we must continue, whereas a sessionId miss just
  // means "create a new pooled session under this id".
  if (task.resumeFrom) {
    const resumeFromPathError = validateResumeFromPath(task.resumeFrom);
    if (resumeFromPathError) {
      return {
        error: failTask(
          task,
          `resumeFrom: invalid session path: ${resumeFromPathError}; got ${JSON.stringify(task.resumeFrom)}`,
        ),
      };
    }
    const resolvedPath = resolveCwd(task.resumeFrom);
    if (!fs.existsSync(resolvedPath)) {
      return {
        error: failTask(
          task,
          `resumeFrom: file not found: ${resolvedPath}`,
          resolvedPath,
        ),
      };
    }
    // Open the existing session and let createAgentSession restore its messages
    // internally (sdk.js reads buildSessionContext().messages + model/thinking).
    let resumed: SessionManager;
    try {
      resumed = SessionManager.open(resolvedPath);
    } catch {
      return {
        error: failTask(
          task,
          `resumeFrom: corrupt session: ${resolvedPath}`,
          resolvedPath,
        ),
      };
    }
    // Non-empty sessions have at least the header + the restored branch. An
    // empty/corrupt file surfaces as a session with no restorable messages.
    if (!resumed.buildSessionContext().messages.length) {
      return {
        error: failTask(
          task,
          `resumeFrom: empty session: ${resolvedPath}`,
          resolvedPath,
        ),
      };
    }

    // Link resumed session to parent for /resume discoverability.
    const parentFile = env.parentSessionManager?.getSessionFile?.();
    if (parentFile) setParentSession(resumed, parentFile);

    const session = await buildDelegateSession(
      task,
      resumed,
      env.modelRegistry,
    );
    return {
      session,
      sessionManager: resumed,
      sessionFile: resolvedPath,
      disposeOnAbort: true,
    };
  }

  // ── Fresh session (no resume) ────────────────────────────────────────────
  const fresh = createSubagentSessionManager(
    env.parentSessionManager,
    task.cwd,
  );
  if (!fresh) {
    return { error: failTask(task, "Internal: could not create session file") };
  }
  sessionManager = fresh.manager;
  sessionFile = fresh.file;

  const session = await buildDelegateSession(
    task,
    sessionManager,
    env.modelRegistry,
  );
  return {
    session,
    sessionManager,
    sessionFile,
    disposeOnAbort: true,
  };
}

/**
 * Resolve the `sessionFile` to report on a TaskResult.
 *
 * On failure, the upstream SessionManager may never have written the `.jsonl`
 * (it gates the first write behind an assistant message — a documented contract).
 * A first-call failure (e.g. Cloudflare 524) leaves the planned path uncreated,
 * yet delegate would otherwise report it as if it existed. So when a run failed,
 * force-flush the header first so the path becomes real and resumable.
 *
 * Defense-in-depth: regardless of success/failure, only report the path if the
 * file actually exists on disk, so the TaskResult never points at nothing.
 */
function resolveResumableSessionFile(
  sessionFile: string | undefined,
  sessionManager: SessionManager | undefined,
  error: string | undefined,
): string | undefined {
  if (!sessionFile) return undefined;
  // On failure, the header may not have been written yet — force it now.
  if (error && sessionManager) persistSessionHeader(sessionManager);
  return fs.existsSync(sessionFile) ? sessionFile : undefined;
}

/** Run a single resolved task. Single source of truth for the per-task lifecycle.
 *  Used by both sync (params.async === false) and async (params.async === true) paths.
 *  When task.sessionId is set, the entire acquire/run/close lifecycle runs under
 *  a per-session mutex so concurrent tasks with the same sessionId serialize
 *  cleanly. The lock also covers action='close' and the early-busy/abort paths. */
export async function runResolvedTask(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  taskIndex: number,
): Promise<TaskResult> {
  if (task.sessionId) {
    return pool.withSessionLock(task.sessionId, () =>
      runResolvedTaskUnlocked(env, task, p, taskIndex),
    );
  }
  return runResolvedTaskUnlocked(env, task, p, taskIndex);
}

async function runResolvedTaskUnlocked(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  taskIndex: number,
): Promise<TaskResult> {
  try {
    // ── Aborted before we started? ───────────────────────────────────
    if (env.signal?.aborted) {
      return finishTask(env, p, failTask(task, "Aborted"));
    }

    // ── Session busy guard (defense-in-depth) ────────────────────────
    // Primary validation is in execute() before ticket creation.
    // This catches edge cases where validation missed a conflict.
    if (task.sessionId) {
      const busyTicketId = isSessionBusy(task.sessionId);
      if (busyTicketId && busyTicketId !== env.ticketId) {
        const msg = `Session '${task.sessionId}' is already in use by ticket ${busyTicketId}. Each session can only handle one task at a time.`;
        return finishTask(env, p, failTask(task, msg));
      }
    }

    p.status = "running";
    p.model = task.model?.id;

    // ── Session action handling ───────────────────────────────────────
    if (task.action === "close") {
      if (!task.sessionId) {
        return finishTask(
          env,
          p,
          failTask(task, "action='close' requires sessionId."),
        );
      }
      const closed = await pool.closePooledAgent(task.sessionId);
      return finishTask(
        env,
        p,
        completeSessionAction(
          task,
          closed
            ? `Session '${task.sessionId}' closed.`
            : `Session '${task.sessionId}' not found.`,
          Date.now() - env.delegateStartedAt,
        ),
      );
    }

    if (task.action === "list") {
      return finishTask(
        env,
        p,
        completeSessionAction(
          task,
          `Active sessions:\n${pool.listPooledAgents().join("\n")}`,
          Date.now() - env.delegateStartedAt,
        ),
      );
    }

    const runAttempt = async (): Promise<TaskResult> => {
      // ── Pool / resume / fresh-agent resolution ────────────────────────
      const acquired = await acquireAgentSession(env, task, p);
      if ("error" in acquired) return acquired.error;

      // Re-check abort after acquisition. The pre-acquire check at the top can
      // miss a signal that fires during getHostDeps/createAgentSession/git
      // baseline. runAgentSession re-checks after attaching its listener, but a
      // cancelled ticket should not even start the subagent (no file writes, no
      // pool insert). Return the just-acquired session to its owner: pool hits
      // remain live, while fresh/resumed sessions must be disposed because they
      // were never committed anywhere else.
      if (env.signal?.aborted) {
        disposeUncommittedSession(acquired);
        return failTask(task, "Aborted");
      }

      // ── Run the agent ─────────────────────────────────────────────────
      try {
        // Snapshot git status before the run so touchedFiles can diff after.
        // AgentSession owns retry/compaction internally — runAgentSession just
        // drives the prompt and maps events to the progress model.
        const gitBaseline = await getGitChangedFiles(task.cwd);
        let r = await runAgentSession(
          acquired.session,
          task.prompt,
          { cwd: task.cwd },
          env.signal,
          (u) => env.onProgress(p, u),
          gitBaseline,
          Date.now(),
        );

        // The signal can fire after the pre-run check or while the runner is
        // collecting post-prompt evidence. Keep cancellation from looking like
        // success and dispose any uncommitted materialized session in that race.
        if (env.signal?.aborted && !r.error) {
          r = { ...r, error: "Aborted" };
        }
        if (env.signal?.aborted || r.error === "Aborted") {
          disposeUncommittedSession(acquired);
        }

        // A stalled prompt was explicitly aborted and is no longer a safe
        // continuation. Close a pooled hit; if this task materialized a fresh
        // or resumed session (including a pool miss), dispose that owned
        // session directly instead of leaving it behind.
        if (r.failureKind === "stalled") {
          let closed = false;
          if (task.sessionId) {
            try {
              closed = await pool.closePooledAgent(task.sessionId);
            } catch (error) {
              // The session is removed from the pool before close reports
              // abort/dispose/timeout failures. Preserve the primary stalled
              // result while logging the cleanup failure explicitly.
              console.error(
                `[delegate] failed to dispose stalled pooled session '${task.sessionId}'`,
                error,
              );
            }
          }
          if (!closed) disposeUncommittedSession(acquired);
        }

        // Pool bookkeeping. commit() is the sole mutator: it decides
        // insert-vs-recordUse by map presence (sound because the session lock
        // serializes same-sessionId tasks). Skipped on failure — insert-only-
        // on-success — so there is nothing to clean up.
        if (task.sessionId && !r.error) {
          pool.commit(task.sessionId, {
            session: acquired.session,
            sessionManager: acquired.sessionManager,
            sessionFile: acquired.sessionFile,
            frozen: {
              systemPrompt: task.systemPrompt,
              model: task.model,
              thinking: task.thinking,
              tools: task.tools,
              cwd: task.cwd,
            },
            tokens: r.tokens,
          });
        }

        return {
          agent: task.agentName,
          output: r.output,
          error: r.error,
          failureKind: r.failureKind,
          durationMs: r.durationMs,
          tokens: r.tokens,
          usage: r.usage,
          sessionFile: resolveResumableSessionFile(
            acquired.sessionFile,
            acquired.sessionManager,
            r.error,
          ),
          touchedFiles: r.touchedFiles,
        };
      } catch (err) {
        // Abnormal error (runAgentSession threw rather than returning r.error).
        // No pool entry to clean up — fresh sessions are inserted only on success.
        throw err;
      }
    };

    // The session lock is now taken at the top of runResolvedTask (covers the
    // full acquire/run/close lifecycle), so attempts execute serially per
    // sessionId without needing an inner lock here.
    let result = await runAttempt();
    // Accumulate usage across whole-task retries: the parent pays for every
    // attempt, including the transient failures that retry.
    let accumulatedUsage = result.usage;
    const maxRetries = resolvedWholeTaskMaxRetries();
    const baseDelayMs = resolvedWholeTaskBaseDelayMs();
    for (
      let retry = 0;
      retry < maxRetries && canRetryWholeTask(task, result);
      retry++
    ) {
      const delayMs = baseDelayMs * 2 ** retry;
      await sleepForWholeTaskRetry(env.signal, delayMs);
      if (env.signal?.aborted) {
        // Preserve any partial output/session path from the last failed attempt
        // while recording that the retry loop was aborted.
        result = {
          ...result,
          error: "Aborted",
          usage: accumulatedUsage,
        };
        break;
      }
      p.status = "running";
      p.error = undefined;
      p.failureKind = undefined;
      env.onStatusChange?.();
      result = await runAttempt();
      accumulatedUsage = addUsage(accumulatedUsage, result.usage);
      result.usage = accumulatedUsage;
    }
    return finishTask(env, p, result);
  } catch (err) {
    // If we synchronously claimed a sessionId before the error, clean it up.
    return finishTask(
      env,
      p,
      failTask(task, err instanceof Error ? err.message : String(err)),
    );
  }
}

import * as fs from "node:fs";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentProgressUpdate,
  AcquiredSession,
  ResolvedTask,
  TaskProgress,
  TaskResult,
  TaskRunEnv,
} from "./types.ts";
import {
  agentPool,
  closePooledAgent,
  listPooledAgents,
  withSessionLock,
} from "./pool.ts";
import { isSessionBusy } from "./tickets.ts";
import {
  createSubagentSessionManager,
  setParentSession,
  persistSessionHeader,
} from "./sessions.ts";
import { runAgentSession } from "./runner.ts";
import { getGitChangedFiles } from "./file-tracking.ts";
import { getHostDeps } from "./host.ts";
import { resolveCwd } from "./utils.ts";

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
    sessionFile: undefined,
    touchedFiles: [],
  };
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
}

/** Mirror a completed TaskResult into a TaskProgress row (status/duration/error). */
function updateProgressFromResult(p: TaskProgress, r: TaskResult): void {
  p.status = r.error ? "failed" : "done";
  p.durationMs = r.durationMs;
  p.tokens = r.tokens;
  p.error = r.error;
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

/** Build the AgentSession for a fresh or resumed subagent via createAgentSession.
 *  Reuses the caller-supplied sessionManager (so parent-linking + per-task .jsonl
 *  files stay under our control) and the shared host deps (cached per-cwd
 *  resourceLoader/settingsManager/authStorage). */
async function buildDelegateSession(
  env: TaskRunEnv,
  task: ResolvedTask,
  sessionManager: SessionManager,
): Promise<AgentSession> {
  // Resolve shared host deps for this task's cwd + system prompt (cached after
  // the first call). resourceLoader is cwd-scoped (it scans for AGENTS.md/skills)
  // and the system prompt is per named-agent, so the cache key is (cwd + prompt).
  // The custom prompt overrides the default AgentSession system prompt.
  const hostDeps = await getHostDeps({
    cwd: task.cwd,
    systemPrompt: task.systemPrompt,
  });

  const { session } = await createAgentSession({
    cwd: task.cwd,
    model: task.model,
    thinkingLevel: task.thinking,
    tools: task.tools,
    sessionManager,
    // Reuse the extension's shared registry (parent's) for consistent auth/model resolution.
    modelRegistry: env.modelRegistry,
    // Shared, read-only heavy deps (resourceLoader.reload() runs once per cwd, cached).
    authStorage: hostDeps.authStorage,
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
  let isPoolHit = false;
  let shouldPoolAfter = false;

  // ── Pool hit (reuse live stateful session) ───────────────────────────────
  if (task.sessionId) {
    const pooled = agentPool.get(task.sessionId);
    if (pooled) {
      // Validate frozen config matches the new task's request.
      const frozen = pooled.config;
      const mismatches: string[] = [];
      if (frozen.cwd !== task.cwd)
        mismatches.push(`cwd: '${frozen.cwd}' vs '${task.cwd}'`);
      if (frozen.thinking !== task.thinking)
        mismatches.push(`thinking: '${frozen.thinking}' vs '${task.thinking}'`);
      const frozenToolSet = [...frozen.tools].sort().join(",");
      const newToolSet = [...task.tools].sort().join(",");
      if (frozenToolSet !== newToolSet)
        mismatches.push(`tools: [${frozenToolSet}] vs [${newToolSet}]`);
      if (mismatches.length) {
        return {
          error: failTask(
            task,
            `Session '${task.sessionId}' config mismatch. Close and recreate: ${mismatches.join("; ")}`,
          ),
        };
      }
      pooled.lastUsed = Date.now();
      p.model = frozen.model.id;
      return {
        session: pooled.session,
        sessionManager: pooled.sessionManager,
        sessionFile: pooled.sessionFile,
        isPoolHit: true,
        shouldPoolAfter: false,
        syncInserted: false,
      };
    }
  }

  // ── Resume from a previous session file ──────────────────────────────────
  // Resume takes precedence over a fresh sessionId miss: resumeFrom points at a
  // concrete prior conversation we must continue, whereas a sessionId miss just
  // means "create a new pooled session under this id".
  if (task.resumeFrom) {
    if (task.sessionId && agentPool.has(task.sessionId)) {
      // Defensive — the pool-hit branch above returns early, so reaching here
      // with a live pooled session is unreachable. Kept for clarity.
      return {
        error: failTask(
          task,
          `resumeFrom conflicts with active sessionId '${task.sessionId}'. The pooled session has its own accumulated context. Close the session first if you want to resume from a different point.`,
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

    const session = await buildDelegateSession(env, task, resumed);
    return {
      session,
      sessionManager: resumed,
      sessionFile: resolvedPath,
      isPoolHit: false,
      // A resumed session under a sessionId becomes poolable after success.
      shouldPoolAfter: Boolean(task.sessionId),
      syncInserted: false,
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

  const session = await buildDelegateSession(env, task, sessionManager);
  return {
    session,
    sessionManager,
    sessionFile,
    isPoolHit: false,
    shouldPoolAfter: Boolean(task.sessionId),
    syncInserted: false,
  };
}

/** Insert a freshly-run session into the pool. Called after a successful run for
 *  a new pooled session (first use of a sessionId, or a resumed session). */
function commitPoolInsert(
  sessionId: string,
  task: ResolvedTask,
  acquired: AcquiredSession,
  result: { tokens: number },
): void {
  if (!acquired.sessionManager || !acquired.sessionFile) return;
  agentPool.set(sessionId, {
    session: acquired.session,
    sessionManager: acquired.sessionManager,
    sessionFile: acquired.sessionFile,
    config: {
      systemPrompt: task.systemPrompt,
      model: task.model,
      thinking: task.thinking,
      tools: task.tools,
      cwd: task.cwd,
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    totalTokens: result.tokens,
    promptCount: 1,
  });
}

/** Update pool stats for a subsequent prompt on an existing pooled session. */
function commitPoolStats(sessionId: string, result: { tokens: number }): void {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return;
  pooled.lastUsed = Date.now();
  pooled.totalTokens += result.tokens;
  pooled.promptCount++;
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
    return withSessionLock(task.sessionId, () =>
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
      const closed = closePooledAgent(task.sessionId);
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
          `Active sessions:\n${listPooledAgents().join("\n")}`,
          Date.now() - env.delegateStartedAt,
        ),
      );
    }

    // ── Pool / resume / fresh-agent resolution ────────────────────────
    const acquired = await acquireAgentSession(env, task, p);
    if ("error" in acquired) {
      return finishTask(env, p, acquired.error);
    }

    // ── Run the agent ─────────────────────────────────────────────────
    const doRun = async (): Promise<TaskResult> => {
      try {
        // Snapshot git status before the run so touchedFiles can diff after.
        // AgentSession owns retry/compaction internally — runAgentSession just
        // drives the prompt and maps events to the progress model.
        const gitBaseline = await getGitChangedFiles(task.cwd);
        const r = await runAgentSession(
          acquired.session,
          task.prompt,
          { cwd: task.cwd },
          env.signal,
          (u) => env.onProgress(p, u),
          gitBaseline,
          Date.now(),
        );

        // Pool bookkeeping. With synchronous pool-insertion removed (the session
        // lock serializes same-sessionId tasks), a fresh session is inserted only
        // after success; pool hits just bump stats. On failure, nothing was
        // inserted, so there is nothing to clean up.
        if (task.sessionId && !r.error) {
          if (acquired.shouldPoolAfter) {
            commitPoolInsert(task.sessionId, task, acquired, r);
          } else {
            // Pool hit: session is already in pool, just bump stats.
            commitPoolStats(task.sessionId, r);
          }
        }

        return {
          agent: task.agentName,
          output: r.output,
          error: r.error,
          durationMs: r.durationMs,
          tokens: r.tokens,
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
    // full acquire/run/close lifecycle), so doRun executes serially per sessionId
    // without needing an inner lock here.
    const result = await doRun();
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

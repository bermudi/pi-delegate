import * as fs from "node:fs";
import * as path from "node:path";
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
  ToolActivity,
} from "./types.ts";
import * as pool from "./pool.ts";
import { isSessionBusy } from "./tickets.ts";
import {
  createSubagentSessionManager,
  persistSessionHeader,
} from "./sessions.ts";
import { runAgentSession, formatDeadlineExceededError } from "./runner.ts";
import {
  getGitChangedFiles,
  projectedAttributionPath,
} from "./file-tracking.ts";
import { getHostDeps } from "./host.ts";
import { resolveCwd, validateResumeFromPath } from "./utils.ts";
import { getWholeTaskMaxRetries, getWholeTaskBaseDelayMs } from "./config.ts";
import { addUsage, emptyUsage } from "./usage.ts";
import { scheduleDeadline } from "./timer.ts";
import { recordTask } from "./telemetry.ts";
import { createScratchWorkspace, ScratchDeadlineError } from "./workspace.ts";
import {
  isResumeFromIdentityQuarantined,
  isSessionIdQuarantined,
  markSessionQuarantined,
  observeQuarantineSafety,
  propagateSessionQuarantine,
  reserveSessionQuarantine,
  sessionQuarantineOf,
  withResumeTranscriptLock,
  type SessionQuarantine,
} from "./session-quarantine.ts";

/** Internal seam for lifecycle-level tests without replacing session ownership. */
type RunAgentSession = typeof runAgentSession;
let runAgentSessionForTesting: RunAgentSession = runAgentSession;
type CreateScratchWorkspace = typeof createScratchWorkspace;
let createScratchWorkspaceForTesting: CreateScratchWorkspace =
  createScratchWorkspace;
type DetachQuarantinedPooledSession =
  typeof pool._quarantinePooledAgentWithoutDisposal;
let detachQuarantinedPooledSessionForTesting: DetachQuarantinedPooledSession =
  pool._quarantinePooledAgentWithoutDisposal;

export function _setRunAgentSessionForTesting(
  override: RunAgentSession | undefined,
): void {
  runAgentSessionForTesting = override ?? runAgentSession;
}

/** @internal Test-only scratch materialization seam. */
export function _setCreateScratchWorkspaceForTesting(
  override: CreateScratchWorkspace | undefined,
): void {
  createScratchWorkspaceForTesting = override ?? createScratchWorkspace;
}

/** @internal Simulate a pooled-detachment invariant failure in lifecycle tests. */
export function _setQuarantinePooledSessionDetachForTesting(
  override: DetachQuarantinedPooledSession | undefined,
): void {
  detachQuarantinedPooledSessionForTesting =
    override ?? pool._quarantinePooledAgentWithoutDisposal;
}

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

function resolvedWholeTaskMaxRetries(env: TaskRunEnv): number {
  return (
    testWholeTaskMaxRetries ?? getWholeTaskMaxRetries(env.config ?? undefined)
  );
}
function resolvedWholeTaskBaseDelayMs(env: TaskRunEnv): number {
  return (
    testWholeTaskBaseDelayMs ?? getWholeTaskBaseDelayMs(env.config ?? undefined)
  );
}

/** Build a failed TaskResult. Used for early-failure paths (abort, busy, validation). */
function failTask(
  task: ResolvedTask,
  error: string,
  sessionFile?: string,
  failureKind?: TaskResult["failureKind"],
): TaskResult {
  return {
    id: task.id,
    agent: task.agentName,
    output: "",
    error,
    failureKind,
    durationMs: 0,
    tokens: 0,
    usage: emptyUsage(),
    sessionFile,
    touchedFiles: [],
    attributedFiles: [],
  };
}

function scratchSetupFailureResult(
  task: ResolvedTask,
  error: unknown,
  signalAborted: boolean,
  startedAt: number,
): TaskResult {
  let message = error instanceof Error ? error.message : String(error);
  let failureKind: TaskResult["failureKind"];
  if (signalAborted) {
    message = "Aborted";
    failureKind = "cancelled";
  } else if (error instanceof ScratchDeadlineError) {
    message = formatDeadlineExceededError(task.deadlineMs ?? 0);
    failureKind = "deadline_exceeded";
  }
  return {
    ...failTask(task, message, undefined, failureKind),
    durationMs: Date.now() - startedAt,
  };
}

/** Preserve every core evidence channel when the outer scratch projection
 * itself fails. Paths cannot be trusted as projected, so structured evidence
 * is retained verbatim and downgraded to uncertain rather than erased. */
function scratchProjectionFailureResult(
  task: ResolvedTask,
  result: TaskResult | undefined,
  error: unknown,
  startedAt: number,
): TaskResult {
  const reason = error instanceof Error ? error.message : String(error);
  const projectionError = `Scratch evidence projection failed: ${reason}`;
  if (!result) {
    return {
      ...failTask(task, projectionError),
      workspace: "scratch",
      durationMs: Date.now() - startedAt,
    };
  }

  let combinedError = projectionError;
  if (result.error) combinedError = `${result.error}\n${projectionError}`;
  const fallback: TaskResult = {
    ...result,
    error: combinedError,
    workspace: "scratch",
    sessionFile: undefined,
    durationMs: Math.max(result.durationMs, Date.now() - startedAt),
    touchedFiles: [...result.touchedFiles],
    attributedFiles: result.attributedFiles
      ? [...result.attributedFiles]
      : undefined,
    fileAttributions: result.fileAttributions?.map((entry) => ({
      ...entry,
      uncertain: true,
    })),
  };
  return propagateSessionQuarantine(result, fallback);
}

/** Build a successful TaskResult for session-management actions (close/list).
 *  Pass elapsedMs to record wall time since delegate started (matches the live progress UI). */
function completeSessionAction(
  task: ResolvedTask,
  output: string,
  elapsedMs?: number,
): TaskResult {
  return {
    id: task.id,
    agent: task.agentName,
    output,
    durationMs: elapsedMs ?? 0,
    tokens: 0,
    usage: emptyUsage(),
    sessionFile: undefined,
    touchedFiles: [],
    attributedFiles: [],
  };
}

/** Dispose a materialized session that remains lifecycle-owned.
 * Pool hits and successfully committed sessions remain pool-owned. */
function disposeOwnedSession(acquired: AcquiredSession): void {
  if (!acquired.lifecycleOwnsSession) return;
  disposeSession(acquired.session, "uncommitted subagent");
}

function disposeSession(session: AgentSession, description: string): void {
  try {
    session.dispose();
  } catch (error) {
    // Cleanup must not replace the task's primary result, but it must emit a
    // signal: extension-bearing sessions can retain callbacks/resources when a
    // provider's dispose implementation misbehaves.
    console.error(`[delegate] ${description} disposal failed`, error);
  }
}

/** Detach an abandoned session from every owner immediately, then dispose it
 * only after runner's background termination monitor proves quiescence. */
function quarantineAcquiredSession(
  task: ResolvedTask,
  acquired: AcquiredSession,
  quarantine: SessionQuarantine,
): void {
  let mayDisposeAfterSafety = acquired.lifecycleOwnsSession;
  if (!acquired.lifecycleOwnsSession) {
    const detached = task.sessionId
      ? detachQuarantinedPooledSessionForTesting(
          task.sessionId,
          acquired.session,
        )
      : false;
    mayDisposeAfterSafety = detached;
    if (!detached) {
      // The pool may still index this exact object. Keep its quarantine
      // reservation fail-closed until safety, but never schedule disposal of an
      // object that another owner still retains. Once safe, normal pooled reuse
      // is preferable to poisoning the indexed session with a deferred dispose.
      console.error(
        `[delegate] CRITICAL: could not detach abandoned pooled AgentSession${task.sessionId ? ` '${task.sessionId}'` : ""}; retaining the indexed session without disposal until it is safe for pooled reuse`,
      );
    }
  }

  // Publish the admission reservation before this task can return and its
  // active dispatch reservation is released. task.resumeFrom is already the
  // canonical path passed to acquisition; never resolve the caller's alias
  // again here.
  reserveSessionQuarantine(task, quarantine, task.resumeFrom);
  console.error(
    mayDisposeAfterSafety
      ? `[delegate] AgentSession${task.sessionId ? ` '${task.sessionId}'` : ""} quarantined; deferred disposal is waiting for background quiescence confirmation`
      : `[delegate] AgentSession${task.sessionId ? ` '${task.sessionId}'` : ""} quarantined; pooled reuse remains blocked until background quiescence confirmation`,
  );
  const onSafetyFailure = (error: unknown): void => {
    // A rejected safety proof is not permission to clean anything.
    console.error(
      "[delegate] quarantined AgentSession safety monitor failed; retaining the session indefinitely",
      error,
    );
  };
  if (mayDisposeAfterSafety) {
    observeQuarantineSafety(
      quarantine,
      "quarantined AgentSession disposal",
      () => disposeSession(acquired.session, "quarantined subagent"),
      onSafetyFailure,
    );
  } else {
    // Observe only for a loud monitor failure. No disposal callback may be
    // attached while the pool still indexes the session object.
    observeQuarantineSafety(
      quarantine,
      "retained pooled AgentSession safety",
      () => {},
      onSafetyFailure,
    );
  }
}

/** Merge per-attempt activities into a live history list while preserving
 * prior-attempt evidence. Activity IDs are used as a stable handle so in-flight
 * updates can replace earlier skeletons for the same call. */
function mergeToolActivities(
  existing: TaskProgress["activities"],
  incoming: ToolActivity[],
): ToolActivity[] {
  const byId = new Map<string, number>();
  for (let i = 0; i < existing.length; i++) {
    byId.set(existing[i]!.id, i);
  }

  const merged = [...existing];
  for (const incomingActivity of incoming) {
    const index = byId.get(incomingActivity.id);
    if (index === undefined) {
      byId.set(incomingActivity.id, merged.length);
      merged.push(incomingActivity);
    } else {
      merged[index] = { ...merged[index], ...incomingActivity };
    }
  }
  return merged;
}

/** Optional counters are used by retry-aware accounting to keep live progress
 * monotonic across attempts. */
interface RunUpdateOffset {
  tokensOffset?: number;
  toolUsesOffset?: number;
}
/** Advance cumulative progress counters without ever moving backwards —
 *  a live TaskProgress row is monotonic across attempts and retries. */
function bumpProgressCounters(
  p: TaskProgress,
  tokens: number,
  toolUses: number,
  durationMs: number,
): void {
  p.tokens = Math.max(p.tokens, tokens);
  p.toolUses = Math.max(p.toolUses, toolUses);
  if (durationMs > p.durationMs) p.durationMs = durationMs;
}

/** Mirror a progress update from runAgent into a TaskProgress row.
 *
 * Runner callbacks report attempt-local counters. Offset/merge them so a single
 * TaskProgress row is monotonic across whole-task retries.
 */
export function updateProgressFromRun(
  p: TaskProgress,
  u: AgentProgressUpdate,
  offsets: RunUpdateOffset = {},
): void {
  bumpProgressCounters(
    p,
    (offsets.tokensOffset ?? 0) + u.tokens,
    (offsets.toolUsesOffset ?? 0) + u.toolUses,
    u.durationMs,
  );
  p.lastActivityAt = u.lastActivityAt;
  p.activities = mergeToolActivities(p.activities, u.activities);
  p.failureKind = u.failureKind;
}
/** Mirror a completed TaskResult into a TaskProgress row (status/duration/error). */
function updateProgressFromResult(p: TaskProgress, r: TaskResult): void {
  p.status = r.error ? "failed" : "done";
  p.durationMs = r.durationMs;
  p.tokens = r.tokens;
  p.error = r.error;
  p.failureKind = r.failureKind;
  p.incomplete = r.incomplete;
}

/** Outcome of one logical task run: the final result plus how many same-model
 *  retries it took. Telemetry is recorded by the caller at the outermost
 *  lifecycle boundary (see recordTaskOutcome). */
interface TaskOutcome {
  result: TaskResult;
  retries: number;
}

/** Notify the optional status observer without making UI/progress delivery part
 * of task correctness. In particular, a host callback must not replace a task
 * result or skip the outer telemetry write. */
function notifyStatusChange(env: TaskRunEnv): void {
  if (!env.onStatusChange) return;
  try {
    env.onStatusChange();
  } catch (error) {
    console.error("[delegate] task status callback threw; continuing", error);
  }
}

/** Apply a TaskResult to progress and notify the env (sync fires onUpdate).
 *  Used at every return point in runResolvedTask — mirrors the old fire() pattern
 *  that the duplicated sync/async bodies used after every early-return.
 *  Telemetry is NOT recorded here: the scratch wrapper may still rewrite the
 *  result (path mapping, cleanup errors), so recording happens exactly once,
 *  in runResolvedTaskUnlocked, on the final object. */
function finishTask(
  env: TaskRunEnv,
  p: TaskProgress,
  r: TaskResult,
  retries = 0,
): TaskOutcome {
  updateProgressFromResult(p, r);
  notifyStatusChange(env);
  return { result: r, retries };
}

/** Record the telemetry task row at the outermost lifecycle boundary — once
 *  per runResolvedTask, on the final (post-scratch-wrap) result. Returns the
 *  result so call sites stay flat. */
function recordTaskOutcome(
  env: TaskRunEnv,
  p: TaskProgress,
  task: ResolvedTask,
  outcome: TaskOutcome,
): TaskResult {
  if (env.telemetryCallId) {
    recordTask({
      callId: env.telemetryCallId,
      generation: env.telemetryGeneration,
      telemetryConfig: env.telemetryConfig,
      async: env.async ?? false,
      taskIndex: p.index,
      task,
      progress: p,
      result: outcome.result,
      retries: outcome.retries,
    });
  }
  return outcome.result;
}

/** A failure attributable to the resolved model/provider — not transient for
 *  that model, so same-model retry is pointless. Distinguished from a bare
 *  transient 429 (per-minute rate limit) by the *account-level* wording:
 *  "usage limit", "quota", "upgrade for higher limits", "exceeded your
 *  … quota", or an auth/credential failure (401/403 with word boundaries so a
 *  port like 4019 doesn't false-positive). The parent should resume with a
 *  different `model` (see `resumeFrom` + `model`). */
export function isModelAttributableError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  if (e.includes("abort")) return false;
  return (
    e.includes("usage limit") ||
    e.includes("upgrade for higher limits") ||
    e.includes("quota") ||
    e.includes("exceeded your") ||
    e.includes("insufficient credit") ||
    e.includes("insufficient quota") ||
    e.includes("insufficient funds") ||
    e.includes("billing") ||
    e.includes("unauthorized") ||
    e.includes("unauthenticated") ||
    e.includes("authentication") ||
    e.includes("invalid api key") ||
    (e.includes("api key") && e.includes("invalid")) ||
    /\b401\b/.test(e) ||
    /\b403\b/.test(e)
  );
}

function isClearlyTransientFinalError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  if (e.includes("abort")) return false;
  // A model-attributable error (usage limit, auth) is NOT transient for this
  // model — exclude it so whole-task retry doesn't burn attempts into the same
  // wall. The parent gets one clean failure and a "switch model" hint instead.
  if (isModelAttributableError(error)) return false;
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

function canRetryWholeTask(
  task: ResolvedTask,
  result: TaskResult,
  hasBashExecution = false,
): boolean {
  // Whole-task retry can repeat tool side effects. Keep it to stateless fresh
  // tasks, and only when our touched-file accounting says the failed attempt
  // did not write/edit anything. A `model_error` (usage limit, auth, quota) is
  // not transient for the resolved model — retrying with the same model just
  // hits the same wall, so skip it and let the parent resume with a different
  // model (see the hint in formatFailedTask). Similarly, once bash executes,
  // any retry would replay non-idempotent side effects, so suppress it.
  // We gate on *observed* bash activity plus touchedFiles, not on the tool set
  // itself: the default tool set includes `bash` for most tasks, and suppressing
  // retry for every bash-capable task would disable the useful transient-error
  // retry path even when no side effects occurred. The stricter “any bash tool
  // → no retry” rule matches the “no filesystem isolation” stance, but is too
  // restrictive for retry safety — touched-file accounting and observed activity
  // are the direct side-effect signals.
  return (
    !sessionQuarantineOf(result) &&
    result.failureKind !== "cancelled" &&
    result.failureKind !== "stalled" &&
    result.failureKind !== "model_error" &&
    result.failureKind !== "deadline_exceeded" &&
    !task.sessionId &&
    !task.resumeFrom &&
    result.touchedFiles.length === 0 &&
    !hasBashExecution &&
    isClearlyTransientFinalError(result.error)
  );
}

async function sleepForWholeTaskRetry(
  signal: AbortSignal | undefined,
  delayMs: number,
  deadlineAt?: number,
): Promise<void> {
  if (signal?.aborted) return;
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) return;

  const retryAt = Date.now() + delayMs;
  const wakeAt =
    deadlineAt !== undefined ? Math.min(retryAt, deadlineAt) : retryAt;

  await new Promise<void>((resolve) => {
    let clear: (() => void) | undefined;
    const done = () => {
      clear?.();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    clear = scheduleDeadline(wakeAt, done);
    if (!signal) return;
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Build the AgentSession for a fresh or resumed subagent via createAgentSession.
 *  Reuses the caller-supplied sessionManager (so per-task .jsonl files stay under
 *  our control). Extension-free host deps may be cached, while
 *  provider-configured or allowlisted-extension deps are session-local because
 *  Pi binds mutable extension callbacks onto each loader runtime. */
async function buildDelegateSession(
  task: ResolvedTask,
  sessionManager: SessionManager,
  env: TaskRunEnv,
): Promise<AgentSession> {
  // Resolve host deps for this task's cwd + system prompt. Extension-free
  // resource loaders are cached after the first call; provider-configured or
  // allowlisted-extension loaders are deliberately fresh per session because
  // their extension runtime is mutable. The resourceLoader is cwd-scoped (it
  // scans for project AGENTS.md/skills) and the system prompt is per named-agent.
  // The custom prompt overrides the default AgentSession system prompt.
  // Pass only the provider needed by this task. This keeps a non-Kilo task
  // from receiving Kilo's provider/auth adapter merely because Kilo is also
  // configured in the parent runtime.
  const providerConfig = env.modelRegistry.getRegisteredProviderConfig?.(
    task.model.provider,
  );
  const providerConfigs = providerConfig
    ? ([[task.model.provider, providerConfig]] as const)
    : [];
  const hostDeps = await getHostDeps({
    cwd: task.cwd,
    systemPrompt: task.systemPrompt,
    providerConfigs,
    modelProvider: task.model.provider,
    // Freeze the provider-extension allowlist to the dispatch-scoped snapshot
    // so a later delegate.json edit cannot change which executable code an
    // already-spawned async worker is allowed to load.
    delegateConfig: env.config,
  });

  const { session } = await createAgentSession({
    cwd: task.cwd,
    model: task.model,
    thinkingLevel: task.thinking,
    tools: task.tools,
    sessionManager,
    // Extension-free host deps may be shared: the canonical model/auth runtime
    // (reads the same ~/.pi/agent files as the parent), settings manager, and
    // resource loader. Provider-configured or allowlisted-extension tasks get
    // fresh instances so Pi's mutable extension runtime cannot cross-wire
    // sessions. Since pi 0.80.8 `createAgentSession` takes `modelRuntime` in
    // place of the removed `authStorage`/`modelRegistry` options.
    modelRuntime: hostDeps.modelRuntime,
    settingsManager: hostDeps.settingsManager,
    resourceLoader: hostDeps.resourceLoader,
  });
  return session;
}

type AcquireResult = AcquiredSession | { error: TaskResult };

/**
 * Try a live pooled session. Returns a hit, a formatted mismatch/conflict
 * error, or `undefined` on miss so the caller can resume or create fresh.
 * checkout is pure (no lastUsed bump); lastUsed is bumped by commit().
 */
function checkoutPooledSession(
  task: ResolvedTask,
  p: TaskProgress,
): AcquireResult | undefined {
  if (!task.sessionId) return undefined;
  const co = pool.checkout(task.sessionId, {
    cwd: task.cwd,
    thinking: task.thinking,
    tools: task.tools,
    providerExtensions: task.providerExtensionSources ?? "",
    ...task.reuseIntent,
  });
  if (co.status === "mismatch") {
    const detail = co.mismatches
      .map((m) =>
        m.field === "providerExtensions"
          ? "providerExtensions: changed"
          : `${m.field}: '${m.frozen}' vs '${m.requested}'`,
      )
      .join("; ");
    return {
      error: failTask(
        task,
        `Session '${task.sessionId}' config mismatch. Close and recreate: ${detail}`,
      ),
    };
  }
  if (co.status !== "hit") return undefined;
  // A pooled session has its own accumulated context — resumeFrom pointing
  // elsewhere is contradictory.
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
    lifecycleOwnsSession: false,
  };
}

/** Resume takes precedence over a fresh sessionId miss: resumeFrom points at a
 *  concrete prior conversation we must continue. */
async function resumeFromSessionFile(
  env: TaskRunEnv,
  task: ResolvedTask,
  resumeFrom: string,
): Promise<AcquireResult> {
  const resumeFromPathError = validateResumeFromPath(resumeFrom);
  if (resumeFromPathError) {
    return {
      error: failTask(
        task,
        `resumeFrom: invalid session path: ${resumeFromPathError}; got ${JSON.stringify(resumeFrom)}`,
      ),
    };
  }
  const resolvedPath = resolveCwd(resumeFrom);
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

  const session = await buildDelegateSession(task, resumed, env);
  return {
    session,
    sessionManager: resumed,
    sessionFile: resolvedPath,
    lifecycleOwnsSession: true,
  };
}

async function createFreshSession(
  env: TaskRunEnv,
  task: ResolvedTask,
): Promise<AcquireResult> {
  let sessionManager: SessionManager;
  let sessionFile: string | undefined;
  if (task.workspace === "scratch" || task.workspace === "isolated") {
    // A discarded filesystem must not advertise a resumable conversation: a
    // later resume would run against the source cwd and silently lose scratch
    // isolation. Keep scratch transcripts in memory only.
    sessionManager = SessionManager.inMemory(task.cwd);
  } else {
    const fresh = createSubagentSessionManager(task.cwd);
    if (!fresh) {
      return {
        error: failTask(task, "Internal: could not create session file"),
      };
    }
    sessionManager = fresh.manager;
    sessionFile = fresh.file;
  }

  const session = await buildDelegateSession(task, sessionManager, env);
  return {
    session,
    sessionManager,
    sessionFile,
    lifecycleOwnsSession: true,
  };
}

/** Resolve the agent + session for a task. Pool hit / resume / fresh. */
async function acquireAgentSession(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
): Promise<AcquireResult> {
  if (task.sessionId) {
    const pooled = checkoutPooledSession(task, p);
    if (pooled) return pooled;
  }
  if (task.resumeFrom) return resumeFromSessionFile(env, task, task.resumeFrom);
  return createFreshSession(env, task);
}

let acquireAgentSessionForTesting = acquireAgentSession;

/** @internal Test-only session-acquisition seam. */
export function _setAcquireAgentSessionForTesting(
  override: typeof acquireAgentSession | undefined,
): void {
  acquireAgentSessionForTesting = override ?? acquireAgentSession;
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
 *  sessionId work is serialized by the pool lock; resumeFrom work is also
 *  serialized by canonical transcript identity. The quarantine check happens
 *  only after both applicable locks are held, closing the validation-to-run
 *  race for a queued call. */
export async function runResolvedTask(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  taskIndex: number,
): Promise<TaskResult> {
  return withResumeTranscriptLock(task.resumeFrom, async (transcript) => {
    let executionTask = task;
    if (task.resumeFrom) {
      const resumeFromPathError = validateResumeFromPath(task.resumeFrom);
      if (resumeFromPathError) {
        return recordTaskOutcome(
          env,
          p,
          task,
          finishTask(
            env,
            p,
            failTask(
              task,
              `resumeFrom: invalid session path: ${resumeFromPathError}; got ${JSON.stringify(task.resumeFrom)}`,
            ),
          ),
        );
      }
      if (!transcript?.canonicalPath || !transcript.exists) {
        const missingPath =
          transcript?.lexicalPath ?? resolveCwd(task.resumeFrom);
        return recordTaskOutcome(
          env,
          p,
          task,
          finishTask(
            env,
            p,
            failTask(
              task,
              `resumeFrom: file not found or could not be resolved: ${missingPath}`,
              missingPath,
            ),
          ),
        );
      }
      // Every check, acquisition, and quarantine publication below uses this
      // one physical identity. Never consult the caller's mutable alias again.
      executionTask = { ...task, resumeFrom: transcript.canonicalPath };
    }

    const runLocked = async (): Promise<TaskResult> => {
      let quarantineError: string | undefined;
      if (
        executionTask.sessionId &&
        isSessionIdQuarantined(executionTask.sessionId)
      ) {
        quarantineError = `SessionId '${executionTask.sessionId}' is quarantined after abandonment. Wait for background safety confirmation before reusing it.`;
      } else if (
        executionTask.resumeFrom &&
        isResumeFromIdentityQuarantined(executionTask.resumeFrom)
      ) {
        quarantineError = `resumeFrom transcript '${task.resumeFrom}' is quarantined after abandonment. Wait for background safety confirmation before resuming it.`;
      }
      if (quarantineError) {
        return recordTaskOutcome(
          env,
          p,
          executionTask,
          finishTask(env, p, failTask(executionTask, quarantineError)),
        );
      }
      return runResolvedTaskUnlocked(env, executionTask, p, taskIndex);
    };

    return executionTask.sessionId
      ? pool.withSessionLock(executionTask.sessionId, runLocked)
      : runLocked();
  });
}

async function runResolvedTaskUnlocked(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  taskIndex: number,
): Promise<TaskResult> {
  if (
    task.workspace === "isolated" &&
    (task.sessionId || task.resumeFrom || task.sessionAction)
  ) {
    return recordTaskOutcome(
      env,
      p,
      task,
      finishTask(
        env,
        p,
        failTask(
          task,
          "workspace 'isolated' is one-shot and cannot be combined with sessionId, resumeFrom, or sessionAction.",
        ),
      ),
    );
  }
  if (task.workspace !== "scratch") {
    const outcome = await runResolvedTaskCore(env, task, p, taskIndex);
    return recordTaskOutcome(env, p, task, outcome);
  }
  if (task.sessionId || task.resumeFrom || task.sessionAction) {
    return recordTaskOutcome(
      env,
      p,
      task,
      finishTask(
        env,
        p,
        failTask(
          task,
          "workspace 'scratch' is one-shot and cannot be combined with sessionId, resumeFrom, or sessionAction.",
        ),
      ),
    );
  }

  const startedAt = Date.now();
  const deadlineAt =
    task.deadlineMs && task.deadlineMs > 0
      ? startedAt + task.deadlineMs
      : undefined;
  let workspace: Awaited<ReturnType<typeof createScratchWorkspace>>;
  try {
    workspace = await createScratchWorkspaceForTesting(
      task.cwd,
      env.signal,
      deadlineAt,
    );
  } catch (error) {
    const setupFailure = scratchSetupFailureResult(
      task,
      error,
      env.signal?.aborted === true,
      startedAt,
    );
    return recordTaskOutcome(env, p, task, finishTask(env, p, setupFailure));
  }

  const executionTask: ResolvedTask = {
    ...task,
    cwd: workspace.cwd,
  };
  let outcome: TaskOutcome | undefined;
  let result: TaskResult | undefined;
  let cleanupError: string | undefined;
  let needsCorrection = false;
  try {
    outcome = await runResolvedTaskCore(env, executionTask, p, taskIndex, {
      taskStartedAt: startedAt,
      deadlineAt,
    });
    // Keep the pre-mapping result in `result` so the catch below can preserve
    // its paid-for counters if path mapping throws mid-rewrite.
    result = outcome.result;
    const fileAttributions = result.fileAttributions ?? [];
    const attributionByLexical = new Map(
      fileAttributions.map((entry) => [path.resolve(entry.lexicalPath), entry]),
    );
    const attributedPhysicalPaths = new Set(
      fileAttributions
        .filter(
          (entry) =>
            entry.preExecutionPhysicalPath !== undefined &&
            path.resolve(entry.preExecutionPhysicalPath) !==
              path.resolve(entry.lexicalPath),
        )
        .map((entry) => path.resolve(entry.preExecutionPhysicalPath!)),
    );
    const logProjectionFailure = (
      kind: string,
      candidate: string,
      error: unknown,
    ) => {
      const safeJson = (value: string) =>
        JSON.stringify(
          value.length > 1_024
            ? `${value.slice(0, 1_024)}…[truncated ${value.length - 1_024} chars]`
            : value,
        )
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029");
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[delegate] scratch ${kind} projection failed for ${safeJson(candidate)} (reason=${safeJson(reason)}); retaining conservative lexical evidence`,
      );
    };
    const attributionSettled = await Promise.allSettled(
      fileAttributions.map((entry) =>
        workspace.resolveFileAttribution
          ? workspace.resolveFileAttribution(entry)
          : Promise.resolve(entry),
      ),
    );
    const projectedAttributions = attributionSettled
      .map((settled, index) => {
        if (settled.status === "fulfilled") return settled.value;
        const entry = fileAttributions[index]!;
        logProjectionFailure("attribution", entry.lexicalPath, settled.reason);
        return {
          ...entry,
          lexicalPath: workspace.mapPathToSource(entry.lexicalPath),
          preExecutionPhysicalPath: entry.preExecutionPhysicalPath
            ? workspace.mapPathToSource(entry.preExecutionPhysicalPath)
            : undefined,
          uncertain: true,
        };
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      );
    const touchedSettled = await Promise.allSettled(
      result.touchedFiles.map(async (file) => {
        const absolute = path.resolve(file);
        // Preserve this touched-file evidence, but project it lexically: a
        // realpath now could follow a replacement symlink. attributedFiles
        // separately decides whether the physical target was disposable.
        if (attributedPhysicalPaths.has(absolute)) {
          return workspace.mapPathToSource(absolute);
        }
        const attribution = attributionByLexical.get(absolute);
        if (attribution && workspace.resolveAttributedLexicalTouch) {
          return workspace.resolveAttributedLexicalTouch(attribution);
        }
        return workspace.resolveReportedPath(file);
      }),
    );
    const projectedTouched = touchedSettled
      .map((settled, index) => {
        if (settled.status === "fulfilled") return settled.value;
        const file = result!.touchedFiles[index]!;
        logProjectionFailure("touched-path", file, settled.reason);
        return workspace.mapPathToSource(file);
      })
      .filter((file): file is string => file !== undefined);
    let projectedAttributedFiles: string[];
    if (fileAttributions.length) {
      projectedAttributedFiles = projectedAttributions.map(
        projectedAttributionPath,
      );
    } else {
      const legacy = result.attributedFiles ?? [];
      const legacySettled = await Promise.allSettled(
        legacy.map((file) => workspace.resolveAttributedPath(file)),
      );
      projectedAttributedFiles = legacySettled
        .map((settled, index) => {
          if (settled.status === "fulfilled") return settled.value;
          const file = legacy[index]!;
          logProjectionFailure("attributed-path", file, settled.reason);
          return workspace.mapPathToSource(file);
        })
        .filter((file): file is string => file !== undefined);
    }
    result = {
      ...result,
      workspace: "scratch",
      sessionFile: undefined,
      fileAttributions: projectedAttributions,
      touchedFiles: [
        ...new Set([
          ...projectedTouched,
          ...(fileAttributions.length ? projectedAttributedFiles : []),
        ]),
      ],
      // Certain writes inside scratch are discarded. External and uncertain
      // evidence remains attributable without re-resolving physical snapshots.
      attributedFiles: [...new Set(projectedAttributedFiles)],
    };
  } catch (error) {
    result = scratchProjectionFailureResult(task, result, error, startedAt);
    // runResolvedTaskCore may already have notified a successful result
    // before path mapping failed. Correct that observable outcome below.
    needsCorrection = true;
  } finally {
    const quarantine = sessionQuarantineOf(result);
    if (quarantine) {
      console.error(
        `[delegate] retaining abandoned scratch workspace '${workspace.scratchRoot}' until its AgentSession is confirmed quiescent`,
      );
      observeQuarantineSafety(
        quarantine,
        "deferred scratch workspace cleanup",
        async () => {
          try {
            await workspace.cleanup();
            console.error(
              `[delegate] safely cleaned deferred scratch workspace '${workspace.scratchRoot}'`,
            );
          } catch (error) {
            console.error(
              `[delegate] deferred scratch workspace cleanup failed for '${workspace.scratchRoot}'; retaining it`,
              error,
            );
          }
        },
        (error) => {
          console.error(
            `[delegate] scratch AgentSession safety monitor failed; retaining workspace '${workspace.scratchRoot}' indefinitely`,
            error,
          );
        },
      );
    } else {
      try {
        await workspace.cleanup();
      } catch (error) {
        cleanupError = `Scratch workspace cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error("[delegate] scratch workspace cleanup failed", error);
      }
    }
  }

  if (!result) {
    result = {
      ...failTask(task, "Scratch task failed before producing a result."),
      workspace: "scratch",
      durationMs: Date.now() - startedAt,
    };
  }
  if (cleanupError || needsCorrection) {
    result = {
      ...result,
      error: cleanupError
        ? result.error
          ? `${result.error}\n${cleanupError}`
          : cleanupError
        : result.error,
      durationMs: Math.max(result.durationMs, Date.now() - startedAt),
    };
    updateProgressFromResult(p, result);
    notifyStatusChange(env);
  }
  // Single telemetry write for the whole logical task — after scratch
  // wrapping and cleanup, on the result actually returned, so no correction
  // upsert is ever needed.
  return recordTaskOutcome(env, p, task, {
    result,
    retries: outcome?.retries ?? 0,
  });
}

interface AttemptTiming {
  taskStartedAt: number;
  deadlineAt: number | undefined;
}

interface AttemptAccounting {
  hasBashExecution: boolean;
  cumulativeTokens: number;
  cumulativeToolUses: number;
  accumulatedUsage: ReturnType<typeof emptyUsage>;
}

function resolveAttemptTiming(
  task: ResolvedTask,
  timing?: AttemptTiming,
): AttemptTiming {
  const taskStartedAt = timing?.taskStartedAt ?? Date.now();
  return {
    taskStartedAt,
    deadlineAt:
      timing?.deadlineAt ??
      (task.deadlineMs && task.deadlineMs > 0
        ? taskStartedAt + task.deadlineMs
        : undefined),
  };
}

/** Close/list short-circuits. Returns undefined when the task should prompt. */
async function applySessionAction(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
): Promise<TaskOutcome | undefined> {
  if (task.sessionAction === "close") {
    if (!task.sessionId) {
      return finishTask(
        env,
        p,
        failTask(task, "sessionAction='close' requires sessionId."),
      );
    }
    // The per-session lock for action-based operations is already held by the
    // outer runResolvedTask() wrapper. Use the internal close helper to avoid a
    // reentrant deadlock on the same key.
    const closed = await pool._closePooledAgentWithoutLock(task.sessionId);
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

  if (task.sessionAction === "list") {
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
  return undefined;
}

function busySessionConflict(
  env: TaskRunEnv,
  task: ResolvedTask,
): TaskResult | undefined {
  if (!task.sessionId) return undefined;
  const busyTicketId = isSessionBusy(task.sessionId);
  if (busyTicketId && busyTicketId !== env.ticketId) {
    return failTask(
      task,
      `Session '${task.sessionId}' is already in use by ticket ${busyTicketId}. Each session can only handle one task at a time.`,
    );
  }
  return undefined;
}

function deadlineExceededResult(
  task: ResolvedTask,
  timing: AttemptTiming,
  prior?: TaskResult,
): TaskResult {
  const budgetMs = Math.max(0, (timing.deadlineAt ?? 0) - timing.taskStartedAt);
  return {
    id: task.id,
    agent: task.agentName,
    output: prior?.output ?? "",
    error: formatDeadlineExceededError(budgetMs),
    failureKind: "deadline_exceeded",
    durationMs: prior?.durationMs ?? 0,
    tokens: prior?.tokens ?? 0,
    usage: prior?.usage ?? emptyUsage(),
    sessionFile: prior?.sessionFile,
    touchedFiles: prior?.touchedFiles ?? [],
    attributedFiles: prior?.attributedFiles ?? [],
    fileAttributions: prior?.fileAttributions,
  };
}

function abandonedAcquisitionResult(
  task: ResolvedTask,
  timing: AttemptTiming,
  reason: "parent-aborted" | "deadline",
): TaskResult {
  if (reason === "parent-aborted") {
    return failTask(task, "Aborted", undefined, "cancelled");
  }
  return deadlineExceededResult(task, timing);
}

function noteAttemptProgress(
  env: TaskRunEnv,
  p: TaskProgress,
  u: AgentProgressUpdate,
  timing: AttemptTiming,
  accounting: AttemptAccounting,
): void {
  if (
    !accounting.hasBashExecution &&
    u.activities.some((activity) => activity.name === "bash")
  ) {
    accounting.hasBashExecution = true;
  }

  const mapped: AgentProgressUpdate = {
    ...u,
    tokens: accounting.cumulativeTokens + u.tokens,
    toolUses: accounting.cumulativeToolUses + u.toolUses,
    durationMs: Date.now() - timing.taskStartedAt,
  };

  // Keep live totals monotonic across attempts.
  bumpProgressCounters(p, mapped.tokens, mapped.toolUses, mapped.durationMs);
  env.onProgress(p, mapped);
}

/** Commit, record, or evict a pooled session after one prompt attempt. */
async function settlePooledAttempt(
  task: ResolvedTask,
  acquired: AcquiredSession,
  r: {
    error?: string;
    failureKind?: TaskResult["failureKind"];
    prompted?: boolean;
    tokens: number;
  },
  sessionReleased: boolean,
): Promise<boolean> {
  if (!task.sessionId) return sessionReleased;
  if (acquired.lifecycleOwnsSession) {
    // Pool misses (including resumeFrom) transfer ownership only on
    // successful completion; failures are owned by lifecycle and must
    // be disposed in this finally path.
    if (
      !r.error &&
      r.failureKind !== "stalled" &&
      r.failureKind !== "deadline_exceeded"
    ) {
      const committed = pool.commit(task.sessionId, {
        session: acquired.session,
        sessionManager: acquired.sessionManager,
        sessionFile: acquired.sessionFile,
        frozen: {
          systemPrompt: task.systemPrompt,
          model: task.model,
          thinking: task.thinking,
          tools: task.tools,
          cwd: task.cwd,
          providerExtensions: task.providerExtensionSources ?? "",
        },
        tokens: r.tokens,
      });
      return sessionReleased || committed;
    }
    return sessionReleased;
  }

  // A stalled, parent-aborted, or mid-prompt deadline-exceeded pooled
  // attempt is not safe to keep; the session may have been mutated.
  // A pre-prompt deadline (runner never called session.prompt()) left
  // the session in its pre-task state, so return it to the pool intact.
  if (
    r.failureKind === "cancelled" ||
    r.failureKind === "stalled" ||
    (r.failureKind === "deadline_exceeded" && r.prompted !== false)
  ) {
    try {
      return (
        (await pool._closePooledAgentWithoutLock(task.sessionId)) ||
        sessionReleased
      );
    } catch (error) {
      // Preserve the primary failure result while logging the cleanup
      // failure explicitly. A pooled session may still be removed by
      // the pool; a pool-miss remains lifecycle-owned and is handled
      // by the finally path above.
      console.error(
        `[delegate] failed to dispose aborted, stalled, or deadline-exceeded pooled session '${task.sessionId}'`,
        error,
      );
      return sessionReleased;
    }
  }
  if (r.failureKind !== "deadline_exceeded") {
    // Pool hits stay owned by the pool, and non-stalled, non-aborted
    // completions (including failed attempts) must still count usage.
    pool.recordUse(task.sessionId, r.tokens);
  }
  // Pre-prompt deadline (prompted === false): the pooled session was
  // checked out but never used. Leave it in the pool with no usage
  // recorded.
  return sessionReleased;
}

type AcquisitionOutcome =
  | { status: "acquired"; value: AcquireResult }
  | { status: "abandoned"; reason: "parent-aborted" | "deadline" };

/**
 * Wait for materialization only while the task remains live. Host dependency or
 * session construction can wedge without yielding an AgentSession to abort, so
 * cancellation/deadline must have an explicit abandoned-acquisition path too.
 * A session that materializes late is disposed immediately and is never
 * prompted or pooled.
 */
async function awaitSessionAcquisition(
  acquisition: Promise<AcquireResult>,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): Promise<AcquisitionOutcome> {
  let stop!: (reason: "parent-aborted" | "deadline") => void;
  const stopped = new Promise<"parent-aborted" | "deadline">((resolve) => {
    stop = resolve;
  });
  const onAbort = () => stop("parent-aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  let clearDeadline: (() => void) | undefined;
  if (deadlineAt !== undefined) {
    clearDeadline = scheduleDeadline(deadlineAt, () => stop("deadline"));
  }
  if (signal?.aborted) onAbort();
  else if (deadlineAt !== undefined && Date.now() >= deadlineAt)
    stop("deadline");

  try {
    return await Promise.race([
      acquisition.then((value): AcquisitionOutcome => ({
        status: "acquired",
        value,
      })),
      stopped.then((reason): AcquisitionOutcome => ({
        status: "abandoned",
        reason,
      })),
    ]);
  } finally {
    clearDeadline?.();
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Publish ownership for an acquisition that outlived its task. The safety
 * promise intentionally uses no polling timer: a construction promise that
 * never settles retains the reservation but cannot by itself keep Node alive.
 * A late lifecycle-owned session must finish disposal before safety fulfills. */
function quarantineAbandonedAcquisition(
  task: ResolvedTask,
  acquisition: Promise<AcquireResult>,
): SessionQuarantine {
  const safe = acquisition.then(
    async (late) => {
      if ("error" in late || !late.lifecycleOwnsSession) return;
      try {
        // AgentSession.dispose is currently synchronous, but awaiting its
        // runtime return also handles extension implementations that perform
        // asynchronous teardown or reject.
        await (late.session.dispose as unknown as () => void | Promise<void>)();
      } catch (error) {
        console.error(
          "[delegate] late abandoned subagent disposal failed; retaining quarantine",
          error,
        );
        throw error;
      }
    },
    (error) => {
      // Rejection proves that acquisition produced no session. Handle it here
      // so the abandoned promise can never become an unhandled rejection.
      try {
        console.error(
          "[delegate] abandoned subagent acquisition settled with an error",
          error,
        );
      } catch {
        // Logging replacements must not turn a safely settled acquisition into
        // a rejected safety proof.
      }
    },
  );
  const quarantine = { safe };
  // Publish before returning the terminal task result. This bridges shared
  // admission from the active dispatch reservation to quarantine atomically.
  // task.resumeFrom is the exact identity supplied to acquisition.
  reserveSessionQuarantine(task, quarantine, task.resumeFrom);
  return quarantine;
}

/** Acquire, prompt, and settle one attempt. Mutates `accounting` on success. */
async function runTaskAttempt(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  timing: AttemptTiming,
  accounting: AttemptAccounting,
): Promise<TaskResult> {
  let attemptToolUsesObserved = 0;
  const onProgress = (u: AgentProgressUpdate): void => {
    attemptToolUsesObserved = Math.max(attemptToolUsesObserved, u.toolUses);
    noteAttemptProgress(env, p, u, timing, accounting);
  };

  const acquisition = acquireAgentSessionForTesting(env, task, p);
  const acquisitionOutcome = await awaitSessionAcquisition(
    acquisition,
    env.signal,
    timing.deadlineAt,
  );
  if (acquisitionOutcome.status === "abandoned") {
    // Acquisition itself is not cancellable upstream. Its quarantine remains
    // active until the promise settles and any late session finishes disposal.
    const quarantine = quarantineAbandonedAcquisition(task, acquisition);
    const result = abandonedAcquisitionResult(
      task,
      timing,
      acquisitionOutcome.reason,
    );
    return markSessionQuarantined(result, quarantine);
  }
  const acquired = acquisitionOutcome.value;
  if ("error" in acquired) return acquired.error;

  // A pool hit is already owned by the pool. Fresh/resumed sessions belong
  // to this attempt until commit/recordUse/close logic runs.
  let sessionReleased = !acquired.lifecycleOwnsSession;
  try {
    // Re-check abort after acquisition. The pre-acquire check at the top can
    // miss a signal that fires during getHostDeps/createAgentSession/git
    // baseline. runAgentSession re-checks after attaching its listener, but a
    // cancelled ticket should not even start the subagent (no file writes, no
    // pool insert).
    if (env.signal?.aborted) {
      return failTask(task, "Aborted", undefined, "cancelled");
    }

    // Snapshot git status before the run so touchedFiles can diff after.
    // AgentSession owns retry/compaction internally — runAgentSession just
    // drives the prompt and maps events to the progress model. Git failures
    // degrade to an undefined baseline, which tells the runner to skip
    // git-based attribution entirely; see getGitChangedFiles for the
    // contract.
    const gitBaseline = await getGitChangedFiles(task.cwd);
    let r = await runAgentSessionForTesting(
      acquired.session,
      task.prompt,
      { cwd: task.cwd },
      env.signal,
      onProgress,
      gitBaseline,
      timing.taskStartedAt,
      timing.deadlineAt,
      env.config,
    );

    accounting.cumulativeTokens += r.tokens;
    // The signal can fire after the pre-run check or while the runner is
    // collecting post-prompt evidence. Keep cancellation from looking like
    // success; finally below releases any uncommitted session.
    if (env.signal?.aborted && !r.error) {
      r = { ...r, error: "Aborted", failureKind: "cancelled" };
    }

    const quarantine = sessionQuarantineOf(r);
    // Persisting or advertising a resumable transcript while its session is
    // still mutating would create another owner of unsafe state.
    const sessionFile = quarantine
      ? undefined
      : resolveResumableSessionFile(
          acquired.sessionFile,
          acquired.sessionManager,
          r.error,
        );

    if (quarantine) {
      quarantineAcquiredSession(task, acquired, quarantine);
      // Neither lifecycle nor pool owns it now. The deferred safety callback is
      // the sole owner and finally below must not dispose it early.
      sessionReleased = true;
    } else {
      sessionReleased = await settlePooledAttempt(
        task,
        acquired,
        r,
        sessionReleased,
      );
    }

    accounting.accumulatedUsage = addUsage(
      accounting.accumulatedUsage,
      r.usage,
    );
    accounting.cumulativeToolUses += attemptToolUsesObserved;

    return propagateSessionQuarantine(r, {
      id: task.id,
      agent: task.agentName,
      output: r.output,
      error: r.error,
      // Classify the failure: the runner sets `stalled` for the
      // inactivity watchdog; here we add `model_error` for failures
      // attributable to the resolved model (usage limit, auth, quota) so the
      // parent gets a "switch model" hint instead of a same-model retry
      // hint, and so canRetryWholeTask skips the pointless same-model
      // retry.
      failureKind:
        r.failureKind ??
        (r.error && isModelAttributableError(r.error)
          ? "model_error"
          : undefined),
      incomplete: r.incomplete,
      durationMs: r.durationMs,
      tokens: r.tokens,
      usage: r.usage,
      sessionFile,
      touchedFiles: r.touchedFiles,
      attributedFiles: r.attributedFiles ?? [],
      fileAttributions: r.fileAttributions,
    });
  } finally {
    // This runs for ordinary success, normal provider failure, whole-task
    // retry attempts, abort races, stalls, and unexpected throws. Pool hits
    // remain pool-owned; successful inserts were explicitly released above.
    if (!sessionReleased) disposeOwnedSession(acquired);
  }
}

function unexpectedAttemptFailure(
  task: ResolvedTask,
  err: unknown,
  accounting: AttemptAccounting,
): TaskResult {
  return {
    ...failTask(task, err instanceof Error ? err.message : String(err)),
    tokens: accounting.accumulatedUsage.totalTokens,
    usage: accounting.accumulatedUsage,
  };
}

/** Merge whole-task accounting into a per-attempt result so no counter can
 *  regress. The single reconcile point for attempt-local values (duration,
 *  tokens, usage) against cumulative totals — used at every exit from the
 *  whole-task retry loop. */
function reconcileResultWithAccounting(
  result: TaskResult,
  timing: AttemptTiming,
  accounting: AttemptAccounting,
): TaskResult {
  return {
    ...result,
    durationMs: Math.max(result.durationMs, Date.now() - timing.taskStartedAt),
    tokens: Math.max(
      accounting.cumulativeTokens,
      accounting.accumulatedUsage.totalTokens,
    ),
    usage: accounting.accumulatedUsage,
  };
}

/** First attempt plus same-model retries for clearly transient failures. */
async function runWithWholeTaskRetries(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  timing: AttemptTiming,
): Promise<TaskOutcome> {
  const accounting: AttemptAccounting = {
    hasBashExecution: false,
    cumulativeTokens: 0,
    cumulativeToolUses: 0,
    accumulatedUsage: emptyUsage(),
  };

  let result: TaskResult;
  try {
    result =
      timing.deadlineAt && Date.now() >= timing.deadlineAt
        ? deadlineExceededResult(task, timing)
        : await runTaskAttempt(env, task, p, timing, accounting);
  } catch (err) {
    // First-attempt throw: finish immediately, no retries.
    return {
      result: reconcileResultWithAccounting(
        unexpectedAttemptFailure(task, err, accounting),
        timing,
        accounting,
      ),
      retries: 0,
    };
  }

  // An isolated worker is snapshotted once and reconciled once. Retrying the
  // whole conversation against a mutated proposal tree would make attribution
  // ambiguous, so v1 deliberately runs one attempt.
  const maxRetries =
    task.workspace === "isolated" ? 0 : resolvedWholeTaskMaxRetries(env);
  const baseDelayMs = resolvedWholeTaskBaseDelayMs(env);
  let retries = 0;
  for (
    let retry = 0;
    retry < maxRetries &&
    canRetryWholeTask(task, result, accounting.hasBashExecution);
    retry++
  ) {
    const delayMs = baseDelayMs * 2 ** retry;
    p.durationMs = Math.max(p.durationMs, Date.now() - timing.taskStartedAt);
    await sleepForWholeTaskRetry(env.signal, delayMs, timing.deadlineAt);
    if (env.signal?.aborted) {
      // Preserve any partial output/session path from the last failed attempt
      // while recording that the retry loop was aborted. The task already
      // paid for every completed attempt, including the one before sleep;
      // counters are reconciled by the single return below.
      result = { ...result, error: "Aborted", failureKind: "cancelled" };
      break;
    }

    if (timing.deadlineAt && Date.now() >= timing.deadlineAt) {
      result = deadlineExceededResult(task, timing, result);
      break;
    }

    p.status = "running";
    p.error = undefined;
    p.failureKind = undefined;
    notifyStatusChange(env);
    retries++;
    try {
      result = await runTaskAttempt(env, task, p, timing, accounting);
    } catch (err) {
      result = unexpectedAttemptFailure(task, err, accounting);
      break;
    }
  }

  return {
    result: reconcileResultWithAccounting(result, timing, accounting),
    retries,
  };
}

async function runResolvedTaskCore(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  _taskIndex: number,
  timing?: AttemptTiming,
): Promise<TaskOutcome> {
  try {
    if (env.signal?.aborted) {
      return finishTask(
        env,
        p,
        failTask(task, "Aborted", undefined, "cancelled"),
      );
    }

    // Primary busy validation is in execute() before ticket creation.
    // This catches edge cases where validation missed a conflict.
    const busy = busySessionConflict(env, task);
    if (busy) return finishTask(env, p, busy);

    p.status = "running";
    p.model = task.model?.id;

    const sessionActionResult = await applySessionAction(env, task, p);
    if (sessionActionResult) return sessionActionResult;

    const settled = await runWithWholeTaskRetries(
      env,
      task,
      p,
      resolveAttemptTiming(task, timing),
    );
    return finishTask(env, p, settled.result, settled.retries);
  } catch (err) {
    // Any acquired session is released by runTaskAttempt's finally before an
    // exception reaches this boundary. This outer catch handles unexpected
    // throws before retry accounting is initialized, so report a minimal
    // failure without accumulated usage.
    return finishTask(
      env,
      p,
      failTask(task, err instanceof Error ? err.message : String(err)),
    );
  }
}

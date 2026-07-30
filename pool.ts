import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fmtDuration, fmtTokens, shortenPath } from "./format.ts";

// ── Public value types (cross the seam) ───────────────────────────────────

/** Immutable config captured when a session enters the pool. Write-once: once
 * stored it never changes — only stats mutate, and only via {@link commit}.
 * Reuse always validates cwd/thinking/tools and validates an explicitly
 * requested model or base prompt against this frozen configuration. */
export interface FrozenConfig {
  systemPrompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  tools: string[];
  cwd: string;
}

/** The subset a reuse request supplies for validation. `model` and
 * `systemPrompt` are present only when this call explicitly requested them;
 * omission means continue with the frozen live session configuration. */
export interface ConfigCandidate {
  cwd: string;
  thinking: ThinkingLevel;
  tools: string[];
  model?: Model<Api>;
  systemPrompt?: string;
}

/** One field-level diff from a reuse that conflicts with the frozen config. The
 * pool computes these; the caller formats the error string. */
export interface ConfigMismatch {
  field: "cwd" | "thinking" | "tools" | "model" | "systemPrompt";
  frozen: string;
  requested: string;
}

/** Result of {@link checkout}. Discriminated so the caller handles
 *  hit/miss/mismatch without parsing. checkout is PURE — it does not bump
 *  lastUsed (that is commit's job), so a speculative checkout that bails leaves
 *  no trace. */
export type CheckoutResult =
  | {
      status: "hit";
      session: AgentSession;
      sessionManager: SessionManager;
      sessionFile: string;
      /** Frozen model id — caller uses it for the progress row / display. */
      modelId: string;
    }
  | { status: "miss" }
  | { status: "mismatch"; mismatches: ConfigMismatch[] };

/** Payload for {@link commit}. The caller always assembles the full payload on
 *  a successful run; commit decides insert-vs-recordUse by map presence (sound
 *  because the per-session lock serializes same-sessionId tasks). */
export interface CommitPayload {
  session: AgentSession;
  sessionManager: SessionManager | undefined;
  sessionFile: string | undefined;
  frozen: FrozenConfig;
  tokens: number;
}

// ── Internal state (PRIVATE — callers cross the seam, never the Map) ───────

interface PooledAgent {
  /** The live AgentSession — reused across prompts for this sessionId. */
  session: AgentSession;
  sessionManager: SessionManager;
  sessionFile: string;
  /** Config frozen at creation time — validated against on reuse. */
  config: FrozenConfig;
  lastUsed: number;
  createdAt: number;
  /** Total tokens consumed across all prompts on this session. */
  totalTokens: number;
  /** Number of prompts sent to this session. */
  promptCount: number;
}

/** Module-level pool — lives for the entire Pi session. Not exported: callers
 * use checkout/commit/configFor/closePooledAgent/closeAllPooledAgents/listPooledAgents. */
const agentPool = new Map<string, PooledAgent>();

// AgentSession.abort() normally settles promptly, but a provider or tool can
// ignore cancellation. Cleanup must not make parent-session shutdown hostage to
// that promise, so close operations use a bounded wait before forced disposal.
const DEFAULT_POOL_ABORT_TIMEOUT_MS = 10_000;
let poolAbortTimeoutMs = DEFAULT_POOL_ABORT_TIMEOUT_MS;

/** Per-session lock — serializes access to a pooled agent so concurrent
 *  delegate calls with the same sessionId queue instead of interleaving. */
const sessionLocks = new Map<string, Promise<void>>();

function now(): number {
  return Date.now();
}

// ── Read + validate ───────────────────────────────────────────────────────

/** Look up a pooled session and validate a reuse request against its frozen
 *  config. PURE: no lastUsed bump, no sweep — safe to call speculatively, even
 *  outside the session lock (the frozen config is write-once, so a concurrent
 *  commit cannot tear the read).
 *
 *  - hit      → pooled, and {cwd,thinking,tools} match frozen. Returns the live
 *               handles + the frozen model id.
 *  - miss     → not pooled (never inserted, closed, or parent session ended).
 *               Caller materializes.
 *  - mismatch → pooled but its immutable configuration conflicts with this
 *               request. Caller formats the structured diff into an error.
 *
 *  lastUsed is bumped by commit() on a successful run, not here — so a checkout
 *  that bails (e.g. a resumeFrom conflict at the caller) does not affect stats. */
export function checkout(
  sessionId: string,
  candidate: ConfigCandidate,
): CheckoutResult {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return { status: "miss" };

  const frozen = pooled.config;
  const mismatches: ConfigMismatch[] = [];
  if (frozen.cwd !== candidate.cwd) {
    mismatches.push({
      field: "cwd",
      frozen: frozen.cwd,
      requested: candidate.cwd,
    });
  }
  if (frozen.thinking !== candidate.thinking) {
    mismatches.push({
      field: "thinking",
      frozen: frozen.thinking,
      requested: candidate.thinking,
    });
  }
  // Tools are compared as order-independent sets (sorted join), so a reuse that
  // lists the same tools in a different order is not a false mismatch.
  const frozenTools = [...frozen.tools].sort().join(",");
  const requestedTools = [...candidate.tools].sort().join(",");
  if (frozenTools !== requestedTools) {
    mismatches.push({
      field: "tools",
      frozen: frozenTools,
      requested: requestedTools,
    });
  }
  if (
    candidate.model &&
    (frozen.model.provider !== candidate.model.provider ||
      frozen.model.id !== candidate.model.id)
  ) {
    mismatches.push({
      field: "model",
      frozen: `${frozen.model.provider}/${frozen.model.id}`,
      requested: `${candidate.model.provider}/${candidate.model.id}`,
    });
  }
  if (
    candidate.systemPrompt !== undefined &&
    frozen.systemPrompt !== candidate.systemPrompt
  ) {
    // Prompts can be large and sensitive; callers need the conflicting field,
    // not the instruction text in their tool-result context.
    mismatches.push({
      field: "systemPrompt",
      frozen: "<frozen>",
      requested: "<requested>",
    });
  }
  if (mismatches.length) return { status: "mismatch", mismatches };

  return {
    status: "hit",
    session: pooled.session,
    sessionManager: pooled.sessionManager,
    sessionFile: pooled.sessionFile,
    modelId: frozen.model.id,
  };
}

// ── The sole mutator (besides close) ──────────────────────────────────────

/** Record the outcome of a run against a sessionId. Decides insert-vs-recordUse
 *  internally by map presence:
 *   - present (pool hit)  → bump lastUsed, totalTokens, promptCount.
 *   - absent  (fresh/resume success) → insert with the frozen config.
 *
 *  MUST be called inside withSessionLock(sessionId, …) — the map-presence
 *  decision is sound only because the lock serializes same-sessionId tasks, so
 *  no concurrent commit can race the insert. MUST only be called on run success
 *  (insert-only-on-success is caller-gated). No-op when a fresh session lacks
 *  the sessionManager/sessionFile a pooled entry requires. */
export function commit(sessionId: string, payload: CommitPayload): void {
  const existing = agentPool.get(sessionId);
  if (existing) {
    // Pool hit: session already pooled, just bump stats.
    existing.lastUsed = now();
    existing.totalTokens += payload.tokens;
    existing.promptCount++;
    return;
  }
  // Miss → success: insert. A pooled entry needs a concrete file/manager.
  if (!payload.sessionManager || !payload.sessionFile) return;
  agentPool.set(sessionId, {
    session: payload.session,
    sessionManager: payload.sessionManager,
    sessionFile: payload.sessionFile,
    config: payload.frozen,
    lastUsed: now(),
    createdAt: now(),
    totalTokens: payload.tokens,
    promptCount: 1,
  });
}

// ── Read-only defaults (for task-resolution) ──────────────────────────────

/** Frozen config for a pooled session, or undefined if not pooled. Lock-free —
 *  safe because the frozen config is write-only at insert and never mutated
 *  thereafter (only stats mutate, via commit, and those do not touch the
 *  returned object). Used by resolveTasks to default {systemPrompt, model,
 *  thinking, tools} for a task that supplies only a sessionId. */
export function configFor(
  sessionId: string,
): Readonly<FrozenConfig> | undefined {
  return agentPool.get(sessionId)?.config;
}

// ── Lock primitive (D1) ───────────────────────────────────────────────────

/** Per-session lock — serializes concurrent calls with the same sessionId.
 *  Different ids run in parallel. Exported as a primitive so the caller
 *  (lifecycle) can bracket the ENTIRE acquire/run/commit flow; checkout/commit
 *  do NOT lock internally because their only caller is already inside this
 *  bracket. Close is also invoked under this lock, so it never disposes an
 *  in-flight prompt. */
export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionLocks.get(sessionId);
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  // Install ourselves BEFORE awaiting — so the next waiter queues behind us,
  // not behind the same predecessor we're waiting on.
  sessionLocks.set(sessionId, promise);
  try {
    if (prev) await prev;
    return await fn();
  } finally {
    resolve();
    // Only clean up if no one queued behind us (our promise is still current).
    // If a waiter installed their own promise, leave it — deleting would
    // clobber their map entry and break the chain.
    if (sessionLocks.get(sessionId) === promise) {
      sessionLocks.delete(sessionId);
    }
  }
}

// ── Teardown / display ────────────────────────────────────────────────────

interface AbortOutcome {
  error?: unknown;
  timedOut?: boolean;
}

/** Start cancellation without letting a cleanup failure become unhandled while
 * a holder of the per-session lock is still unwinding. A wedged provider/tool
 * cannot keep disposal or parent shutdown waiting forever. */
function beginAbort(session: AgentSession): Promise<AbortOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: AbortOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };

    timer = setTimeout(() => finish({ timedOut: true }), poolAbortTimeoutMs);
    try {
      void session.abort().then(
        () => finish({}),
        (error: unknown) => finish({ error }),
      );
    } catch (error) {
      finish({ error });
    }
  });
}

/** Close and dispose one pooled session. A caller holds the per-session lock
 * while closing, so abort cannot race a reuse. All cleanup is attempted before
 * an error is surfaced; a removed session is never silently retained. */
async function closePooledAgentAfterAbort(
  sessionId: string,
  abort: Promise<AbortOutcome>,
): Promise<boolean> {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return false;

  const failures: unknown[] = [];
  let abortOutcome: AbortOutcome;
  try {
    abortOutcome = await abort;
  } catch (error) {
    // beginAbort currently normalizes rejection, but keep the teardown seam
    // fail-closed if a future caller supplies a raw abort promise.
    failures.push(error);
    abortOutcome = {};
  }
  if (abortOutcome.error !== undefined) failures.push(abortOutcome.error);
  if (abortOutcome.timedOut) {
    failures.push(
      new Error(
        `Timed out after ${poolAbortTimeoutMs}ms waiting for session '${sessionId}' to abort.`,
      ),
    );
  }
  try {
    pooled.session.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (agentPool.get(sessionId) === pooled) agentPool.delete(sessionId);

  if (failures.length) {
    throw new AggregateError(
      failures,
      `Failed to close pooled session '${sessionId}'.`,
    );
  }
  return true;
}

/** Abort, dispose, and remove one pooled session. Returns false when the id
 * is already absent; cleanup failures are aggregated after removal. */
export async function closePooledAgent(sessionId: string): Promise<boolean> {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return false;
  return closePooledAgentAfterAbort(sessionId, beginAbort(pooled.session));
}

/** Dispose every live pooled session when the parent Pi session ends. First
 * request cancellation immediately, then acquire each session's lock before
 * disposal. The lock prevents an in-flight lifecycle from committing a live
 * session after shutdown has removed it. Attempts all cleanup before reporting
 * any failures. */
export async function closeAllPooledAgents(): Promise<void> {
  const aborts = new Map<string, Promise<AbortOutcome>>(
    [...agentPool].map(([sessionId, pooled]) => [
      sessionId,
      beginAbort(pooled.session),
    ]),
  );
  const results = await Promise.allSettled(
    [...aborts].map(([sessionId, abort]) =>
      withSessionLock(sessionId, () =>
        closePooledAgentAfterAbort(sessionId, abort),
      ),
    ),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length) {
    throw new AggregateError(
      failures,
      "Failed to close one or more pooled sessions.",
    );
  }
}

/** List live pooled agents. Sessions remain available until explicit close or
 * parent-session shutdown; idle/age are observability statistics, not expiry. */
export function listPooledAgents(): string[] {
  const lines: string[] = [];
  if (agentPool.size === 0) return ["_(no active sessions)_"];
  const t = now();
  for (const [id, pooled] of agentPool) {
    const idle = fmtDuration(t - pooled.lastUsed);
    const age = fmtDuration(t - pooled.createdAt);
    lines.push(
      `- **${id}** · ${pooled.promptCount} prompts · ${fmtTokens(pooled.totalTokens)} tokens · idle ${idle} · age ${age} · ${shortenPath(pooled.sessionFile)}`,
    );
  }
  return lines;
}

// ── Test seam (internal — imported directly by tests, not re-exported) ────

/** @internal Override the abort wait in tests without waiting ten seconds. */
export function _setPoolAbortTimeoutForTesting(
  timeoutMs: number | undefined,
): void {
  poolAbortTimeoutMs = timeoutMs ?? DEFAULT_POOL_ABORT_TIMEOUT_MS;
}

/** @internal Clear all pool state for test isolation. Tests use fake sessions,
 * so no live resource teardown is needed here. */
export function _resetPoolForTesting(): void {
  agentPool.clear();
  sessionLocks.clear();
  poolAbortTimeoutMs = DEFAULT_POOL_ABORT_TIMEOUT_MS;
}

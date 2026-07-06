import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type {
  AgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { POOL_TTL_MS } from "./constants.ts";
import { fmtDuration, fmtTokens, shortenPath } from "./format.ts";

// ── Public value types (cross the seam) ───────────────────────────────────

/** Immutable config captured when a session enters the pool. Write-once: once
 *  stored it never changes — only stats mutate, and only via {@link commit}.
 *  Reuse validates {cwd, thinking, tools} against it; model is inherited (never
 *  compared); systemPrompt is frozen for defaulting, not re-validated. */
export interface FrozenConfig {
  systemPrompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  tools: string[];
  cwd: string;
}

/** The subset a reuse request supplies for validation. Built by the caller from
 *  a ResolvedTask's {cwd, thinking, tools}. Model/systemPrompt are deliberately
 *  absent — model is inherited, systemPrompt is not re-validated. */
export interface ConfigCandidate {
  cwd: string;
  thinking: ThinkingLevel;
  tools: string[];
}

/** One field-level diff from a reuse that conflicts with the frozen config. The
 *  pool computes these; the caller formats the error string. */
export interface ConfigMismatch {
  field: "cwd" | "thinking" | "tools";
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

/** Module-level pool — lives for the entire pi session. Not exported: callers
 *  use checkout/commit/configFor/closePooledAgent/sweepPool/listPooledAgents. */
const agentPool = new Map<string, PooledAgent>();

/** Per-session lock — serializes access to a pooled agent so concurrent
 *  delegate calls with the same sessionId queue instead of interleaving. */
const sessionLocks = new Map<string, Promise<void>>();

/** Clock override (test-only). When set, all pool time reads use this instead
 *  of Date.now(), so TTL/eviction tests don't sleep real seconds. Mirrors the
 *  `_setHostRetryBaseMsForTesting` / `_setWholeTaskRetryForTesting` idiom. */
let clockOverride: (() => number) | undefined;

function now(): number {
  return clockOverride ? clockOverride() : Date.now();
}

// ── Read + validate ───────────────────────────────────────────────────────

/** Look up a pooled session and validate a reuse request against its frozen
 *  config. PURE: no lastUsed bump, no sweep — safe to call speculatively, even
 *  outside the session lock (the frozen config is write-once, so a concurrent
 *  commit cannot tear the read).
 *
 *  - hit      → pooled, and {cwd,thinking,tools} match frozen. Returns the live
 *               handles + the frozen model id.
 *  - miss     → not pooled (never inserted, or evicted by TTL). Caller
 *               materializes.
 *  - mismatch → pooled but {cwd,thinking,tools} diverge. Caller formats the
 *               structured diff into an error; model is never the cause.
 *
 *  lastUsed is bumped by commit() on a successful run, not here — so a checkout
 *  that bails (e.g. a resumeFrom conflict at the caller) does not extend the TTL. */
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
 *  bracket. sweepPool skips any session whose lock is held, so eviction never
 *  aborts in-flight work. */
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

// ── Teardown / maintenance / display ──────────────────────────────────────

/** Close and remove a pooled session. Best-effort aborts any in-flight model
 *  call/retry and waits for idle. Returns true if a session was removed, false
 *  if not pooled. */
export function closePooledAgent(sessionId: string): boolean {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return false;
  try {
    // AgentSession.abort() cancels the in-flight model call / retry backoff.
    void pooled.session.abort().catch(() => {
      /* best effort */
    });
  } catch {
    /* best effort */
  }
  agentPool.delete(sessionId);
  return true;
}

/** Evict idle agents that exceeded the TTL. Skips sessions that are actively
 *  locked — closing them would abort the in-flight prompt. The wider session
 *  lock in runResolvedTask covers first-use, resume, and pool-hit runs, so any
 *  locked session has live work. */
export function sweepPool(): void {
  const t = now();
  for (const [id, pooled] of agentPool) {
    if (sessionLocks.has(id)) continue;
    if (t - pooled.lastUsed > POOL_TTL_MS) {
      closePooledAgent(id);
    }
  }
}

/** List active pooled agents for help/status display. Sweeps stale entries
 *  first. Returns formatted lines — the structured-data refactor (pool returns
 *  SessionInfo[], formatting moves to the renderer) is tracked separately under
 *  the formatting-locality candidate; until then the pool keeps its format.ts
 *  dependency for this display path only. */
export function listPooledAgents(): string[] {
  sweepPool();
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

// ── Test seams (internal — imported directly from this module by tests, not
//    re-exported through the delegate.ts barrel; mirrors host.ts's idiom). ──

/** @internal Test-only clock override for deterministic TTL/eviction tests.
 *  Pass undefined to restore real time. */
export function _setClockForTesting(fn: (() => number) | undefined): void {
  clockOverride = fn;
}

/** @internal Clear all pool state (map + locks + clock) for test isolation. */
export function _resetPoolForTesting(): void {
  agentPool.clear();
  sessionLocks.clear();
  clockOverride = undefined;
}

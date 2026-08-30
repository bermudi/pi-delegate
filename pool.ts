import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fmtDuration, fmtTokens, shortenPath } from "./format.ts";

// ── Public value types (cross the seam) ───────────────────────────────────

/** Immutable config captured when a session enters the pool. Write-once: once
 * stored it never changes — only stats mutate, and only via {@link SessionPool.commit}.
 * Reuse always validates cwd/thinking/tools and validates an explicitly
 * requested model or base prompt against this frozen configuration. */
export interface FrozenConfig {
  systemPrompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  tools: string[];
  cwd: string;
  /** Stable signature of the provider-scoped extension allowlist this session
   * was built with. A change in `delegate.json` providerExtensions must force
   * session recreation so the old executable runtime is not silently reused. */
  providerExtensions?: string;
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
  /** Provider-scoped extension allowlist signature for the current dispatch. */
  providerExtensions?: string;
}

/** One field-level diff from a reuse that conflicts with the frozen config. The
 * pool computes these; the caller formats the error string. */
export interface ConfigMismatch {
  field:
    | "cwd"
    | "thinking"
    | "tools"
    | "model"
    | "systemPrompt"
    | "providerExtensions";
  frozen: string;
  requested: string;
}

/** Result of {@link SessionPool.checkout}. Discriminated so the caller handles
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

/** Payload for {@link SessionPool.commit}. The caller always assembles the full payload on
 *  a successful run; commit decides insert-vs-recordUse by map presence (sound
 *  because the per-session lock serializes same-sessionId tasks). */
export interface CommitPayload {
  session: AgentSession;
  sessionManager: SessionManager | undefined;
  sessionFile: string | undefined;
  frozen: FrozenConfig;
  tokens: number;
}

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

type PoolShutdownState = "open" | "closing" | "closed";

interface AbortOutcome {
  error?: unknown;
  timedOut?: boolean;
}

/** Encapsulated pooled-session state and policy. Each instance owns its own
 *  entries, per-session locks, shutdown state/promise, and abort timeout so
 *  injected runtimes are fully isolated from one another and from the default
 *  module-level pool. */
export class SessionPool {
  static readonly DEFAULT_ABORT_TIMEOUT_MS = 10_000;

  private entries = new Map<string, PooledAgent>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private state: PoolShutdownState = "open";
  private closePromise: Promise<void> | null = null;
  private abortTimeoutMs = SessionPool.DEFAULT_ABORT_TIMEOUT_MS;
  private quarantineWithoutDisposalOverride:
    ((sessionId: string, expectedSession: AgentSession) => boolean) | undefined;

  private now(): number {
    return Date.now();
  }

  private assertPoolOpenForNormalWork(): void {
    if (this.state !== "open") {
      throw new Error("Session pool is not accepting new work.");
    }
  }

  private waitForActiveSessionLocks(): Promise<void> {
    const locks = [...this.sessionLocks.values()];
    return Promise.all(locks).then(() => undefined);
  }

  private deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return value;
    }
    seen.add(value);
    const record = value as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(value))
      this.deepFreeze(record[key], seen);
    return Object.freeze(value);
  }

  /** Defensive value copy for the capability configuration crossing the pool seam. */
  private cloneFrozenConfig(config: FrozenConfig): FrozenConfig {
    return this.deepFreeze(structuredClone(config));
  }

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
   *  lastUsed is bumped by recordUse() after a completed pool hit, not here — so
   *  a checkout that bails (e.g. a resumeFrom conflict) does not affect stats. */
  checkout(sessionId: string, candidate: ConfigCandidate): CheckoutResult {
    const pooled = this.entries.get(sessionId);
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
    if (frozen.providerExtensions !== candidate.providerExtensions) {
      // This field is derived from configured package sources, which may contain
      // credentials. Never expose either the sources or their digest through the
      // public checkout result; a digest can still enable dictionary guessing.
      mismatches.push({
        field: "providerExtensions",
        frozen: "<redacted>",
        requested: "<redacted>",
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

  /**
   * Insert the first successful prompt for a fresh/resumed session into the pool.
   *
   *  MUST be called inside withSessionLock(sessionId, …) and only when this run
   *  should transfer ownership from lifecycle to the pool. Returns true when the
   *  session is now pool-owned, false when insertion is blocked (shutdown) or
   *  impossible (missing manager/file).
   */
  commit(sessionId: string, payload: CommitPayload): boolean {
    // Shutdown-aware policy: once shutdown has started, inserting a new pool entry
    // is unsafe. The lifecycle handles the still-owned session (abort/cleanup) and
    // should dispose it instead of inserting it after the barrier begins.
    if (this.state !== "open") {
      return false;
    }

    // Miss → success: insert. A pooled entry needs a concrete file/manager.
    if (!payload.sessionManager || !payload.sessionFile) return false;

    if (this.entries.has(sessionId)) return false;
    this.entries.set(sessionId, {
      session: payload.session,
      sessionManager: payload.sessionManager,
      sessionFile: payload.sessionFile,
      config: this.cloneFrozenConfig(payload.frozen),
      lastUsed: this.now(),
      createdAt: this.now(),
      totalTokens: payload.tokens,
      promptCount: 1,
    });
    return true;
  }

  /** Record a completed run against an existing pooled session. This is separate
   *  from commit() so lifecycle can distinguish ownership transfer from hit
   *  accounting. Returns true only when the sessionId is currently pooled. */
  recordUse(sessionId: string, tokens: number): boolean {
    const existing = this.entries.get(sessionId);
    if (!existing) return false;

    existing.lastUsed = this.now();
    existing.totalTokens += tokens;
    existing.promptCount++;
    return true;
  }

  /** Remove an exact live session from reuse without aborting or disposing it.
   * Lifecycle uses this only after runner reports quiescence abandonment: any
   * ordinary pool close would race provider/extension work that may still be
   * running. The caller retains the detached session until its background safety
   * promise resolves. */
  quarantinePooledAgentWithoutDisposal(
    sessionId: string,
    expectedSession: AgentSession,
  ): boolean {
    if (this.quarantineWithoutDisposalOverride) {
      return this.quarantineWithoutDisposalOverride(sessionId, expectedSession);
    }
    const existing = this.entries.get(sessionId);
    if (!existing || existing.session !== expectedSession) return false;
    this.entries.delete(sessionId);
    return true;
  }

  /** @internal Test-only override for the quarantine-without-disposal path. */
  _setQuarantinePooledAgentWithoutDisposalForTesting(
    override:
      | ((sessionId: string, expectedSession: AgentSession) => boolean)
      | undefined,
  ): void {
    this.quarantineWithoutDisposalOverride = override;
  }

  /** Frozen config for a pooled session, or undefined if not pooled. Lock-free —
   *  safe because the stored config is a deeply frozen defensive copy. Callers
   *  receive another frozen copy so values crossing the pool seam cannot mutate
   *  its capability contract. Used by resolveTasks to default {systemPrompt,
   *  model, thinking, tools} for a task that supplies only a sessionId. */
  configFor(sessionId: string): Readonly<FrozenConfig> | undefined {
    const config = this.entries.get(sessionId)?.config;
    return config ? this.cloneFrozenConfig(config) : undefined;
  }

  /** Per-session lock — serializes concurrent calls with the same sessionId.
   *  Different ids run in parallel. Exported as a primitive so the caller
   *  (lifecycle) can bracket the ENTIRE acquire/run/commit flow; checkout/commit
   *  do NOT lock internally because their only caller is already inside this
   *  bracket. Close is also invoked under this lock, so it never disposes an
   *  in-flight prompt.
   *
   *  External callers must go through this exported path only while the pool is
   *  open. Internal callers that are already synchronized by a higher-level lock
   *  can use `withSessionLockInternal`.
   */
  withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    this.assertPoolOpenForNormalWork();
    return this.withSessionLockInternal(sessionId, fn);
  }

  /** Internal lock variant that does not reject during shutdown. Use only from
   *  lifecycle/control paths that already account for pool shutdown state. */
  private async withSessionLockInternal<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.sessionLocks.get(sessionId);
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    // Install ourselves BEFORE awaiting — so the next waiter queues behind us,
    // not behind the same predecessor we’re waiting on.
    this.sessionLocks.set(sessionId, promise);
    try {
      if (prev) await prev;
      return await fn();
    } finally {
      resolve();
      // Only clean up if no one queued behind us (our promise is still current).
      // If a waiter installed their own promise, leave it — deleting would
      // clobber their map entry and break the chain.
      if (this.sessionLocks.get(sessionId) === promise) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  /** Start cancellation without letting a cleanup failure become unhandled while
   * a holder of the per-session lock is still unwinding. A wedged provider/tool
   * cannot keep disposal or parent shutdown waiting forever. */
  private beginAbort(session: AgentSession): Promise<AbortOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: AbortOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(outcome);
      };

      timer = setTimeout(() => finish({ timedOut: true }), this.abortTimeoutMs);
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
   *  while closing, so abort cannot race a reuse. All cleanup is attempted before
   *  an error is surfaced; a removed session is never silently retained. */
  private async closePooledAgentAfterAbort(
    sessionId: string,
    abort: Promise<AbortOutcome>,
  ): Promise<boolean> {
    const pooled = this.entries.get(sessionId);
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
          `Timed out after ${this.abortTimeoutMs}ms waiting for session '${sessionId}' to abort.`,
        ),
      );
    }
    try {
      pooled.session.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (this.entries.get(sessionId) === pooled) this.entries.delete(sessionId);

    if (failures.length) {
      throw new AggregateError(
        failures,
        `Failed to close pooled session '${sessionId}'.`,
      );
    }
    return true;
  }

  /** Internal close helper for callers that already own (or are obtaining) the
   *  session lock. */
  private closePooledAgentAfterLock(sessionId: string): Promise<boolean> {
    const pooled = this.entries.get(sessionId);
    if (!pooled) return Promise.resolve(false);
    return this.closePooledAgentAfterAbort(
      sessionId,
      this.beginAbort(pooled.session),
    );
  }

  /** @internal Close while the caller already owns the per-session lock. */
  closePooledAgentWithoutLock(sessionId: string): Promise<boolean> {
    return this.closePooledAgentAfterLock(sessionId);
  }

  /** Abort, dispose, and remove one pooled session. Returns false when the id
   * is already absent; cleanup failures are aggregated after removal.
   * During shutdown or after close, this waits for shutdown to finish and
   * returns `false` instead of throwing.
   */
  async closePooledAgent(sessionId: string): Promise<boolean> {
    if (this.state !== "open") {
      const existing = this.closePromise;
      if (existing) {
        try {
          await existing;
        } catch {
          // Keep public close idempotent during and after shutdown.
        }
      }
      return false;
    }

    let awaitShutdown: Promise<void> | undefined;
    let closed = false;

    await this.withSessionLockInternal(sessionId, async () => {
      // A shutdown can begin while this call waits for its lock. Avoid waiting
      // for closePromise inside this lock: do that work after releasing it, so
      // closeAll can acquire the lock and dispose the same session.
      if (this.state !== "open") {
        awaitShutdown = this.closePromise ?? undefined;
        return;
      }
      closed = await this.closePooledAgentAfterLock(sessionId);
    });

    if (awaitShutdown) {
      try {
        await awaitShutdown;
      } catch {
        // Keep public close idempotent during and after shutdown.
      }
    }

    return closed;
  }

  /** Dispose every live pooled session when the parent Pi session ends. First
   * request cancellation immediately, then wait for all in-flight session locks,
   * then acquire each remaining session's lock before disposal. Attempts are
   * executed for all sessions before reporting failures. Idempotent callers share
   * the same completion promise, including failures.
   */
  async closeAllPooledAgents(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this.state === "closed") {
      const completed = Promise.resolve();
      this.closePromise = completed;
      return completed;
    }

    this.state = "closing";

    const completion = (async () => {
      const aborts = new Map<string, Promise<AbortOutcome>>(
        [...this.entries].map(([sessionId, pooled]) => [
          sessionId,
          this.beginAbort(pooled.session),
        ]),
      );

      await this.waitForActiveSessionLocks();

      const results = await Promise.allSettled(
        [...aborts].map(([sessionId, abort]) =>
          this.withSessionLockInternal(sessionId, () =>
            this.closePooledAgentAfterAbort(sessionId, abort),
          ),
        ),
      );
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Failed to close one or more pooled sessions.",
        );
      }
    })();

    this.closePromise = completion.finally(() => {
      this.state = "closed";
    });
    return this.closePromise;
  }

  /** List live pooled agents. Sessions remain available until explicit close or
   * parent-session shutdown; idle/age are observability statistics, not expiry. */
  listPooledAgents(): string[] {
    const lines: string[] = [];
    if (this.entries.size === 0) return ["_(no active sessions)_"];
    const t = this.now();
    for (const [id, pooled] of this.entries) {
      const idle = fmtDuration(t - pooled.lastUsed);
      const age = fmtDuration(t - pooled.createdAt);
      lines.push(
        `- **${id}** · ${pooled.promptCount} prompts · ${fmtTokens(pooled.totalTokens)} tokens · idle ${idle} · age ${age} · ${shortenPath(pooled.sessionFile)}`,
      );
    }
    return lines;
  }

  /** @internal Clear all pool state for test isolation. Tests use fake sessions,
   * so no live resource teardown is needed here. */
  resetForTesting(): void {
    this.entries.clear();
    this.sessionLocks.clear();
    this.state = "open";
    this.closePromise = null;
    this.abortTimeoutMs = SessionPool.DEFAULT_ABORT_TIMEOUT_MS;
    this.quarantineWithoutDisposalOverride = undefined;
  }

  /** @internal Override the abort wait in tests without waiting ten seconds. */
  setAbortTimeoutForTesting(timeoutMs: number | undefined): void {
    this.abortTimeoutMs = timeoutMs ?? SessionPool.DEFAULT_ABORT_TIMEOUT_MS;
  }
}

// ── Default module-level pool and compatibility wrappers ──────────────────

/** Default pool instance used by the module-level wrappers and the default
 *  {@link getDefaultDelegateRuntime}. Exported so callers can build a
 *  {@link DelegateRuntime} that shares the same default pool. */
export const defaultSessionPool = new SessionPool();

export function checkout(
  sessionId: string,
  candidate: ConfigCandidate,
): CheckoutResult {
  return defaultSessionPool.checkout(sessionId, candidate);
}

export function commit(sessionId: string, payload: CommitPayload): boolean {
  return defaultSessionPool.commit(sessionId, payload);
}

export function recordUse(sessionId: string, tokens: number): boolean {
  return defaultSessionPool.recordUse(sessionId, tokens);
}

export function configFor(
  sessionId: string,
): Readonly<FrozenConfig> | undefined {
  return defaultSessionPool.configFor(sessionId);
}

export function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return defaultSessionPool.withSessionLock(sessionId, fn);
}

export async function closePooledAgent(sessionId: string): Promise<boolean> {
  return defaultSessionPool.closePooledAgent(sessionId);
}

export async function closeAllPooledAgents(): Promise<void> {
  return defaultSessionPool.closeAllPooledAgents();
}

export function listPooledAgents(): string[] {
  return defaultSessionPool.listPooledAgents();
}

export function _quarantinePooledAgentWithoutDisposal(
  sessionId: string,
  expectedSession: AgentSession,
): boolean {
  return defaultSessionPool.quarantinePooledAgentWithoutDisposal(
    sessionId,
    expectedSession,
  );
}

export function _closePooledAgentWithoutLock(
  sessionId: string,
): Promise<boolean> {
  return defaultSessionPool.closePooledAgentWithoutLock(sessionId);
}

/** @internal Override the abort wait in tests without waiting ten seconds. */
export function _setPoolAbortTimeoutForTesting(
  timeoutMs: number | undefined,
): void {
  defaultSessionPool.setAbortTimeoutForTesting(timeoutMs);
}

/** @internal Clear all default pool state for test isolation. */
export function _resetPoolForTesting(): void {
  defaultSessionPool.resetForTesting();
}

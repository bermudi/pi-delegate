import type { Model, Api, Usage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type Workspace = "shared" | "scratch" | "isolated";

/**
 * One applied cross-harness field spelling (SPEC v3 "Reflex meeting"):
 * `field` is the compatibility name the caller wrote, `to` the canonical
 * field it normalized to — rendered `field "<field>" → "<to>"` so the
 * receipt teaches the real name.
 */
export interface FieldNormalization {
  readonly field: string;
  readonly to: string;
}

/** A task after semantic validation and agent/model/tool resolution. */
export interface ResolvedTask {
  readonly index: number;
  /** Caller-provided correlation id, or `task-<n>`. */
  readonly id: string;
  readonly prompt: string;
  /** Canonical agent name (alias-expanded — SPEC v3 "Reflex meeting"). */
  readonly agent: string;
  /**
   * The raw agent name the caller wrote when it was an alias (e.g.
   * "general" for "default"); undefined when the name was already
   * canonical or omitted. Rendered as `agent "<raw>" → "<canonical>"` in
   * task sections so the expansion teaches the real name.
   */
  readonly aliasedFrom: string | undefined;
  /**
   * Cross-harness spellings folded into this task's canonical fields at
   * validation (e.g. `subagent_type` → `agent`), rendered as
   * `field "<field>" → "<to>"` beside the alias note. Undefined when the
   * call used canonical spellings only.
   */
  readonly normalizedFrom: readonly FieldNormalization[] | undefined;
  /**
   * The caller's `description` label (cross-harness field): display-only —
   * preferred over the correlation id in call rows and section headers,
   * never an identity or dependency key.
   */
  readonly description: string | undefined;
  /** Absolute, canonicalized working directory for the task. */
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly thinking: ThinkingLevel | undefined;
  /** Expanded built-in tool names for the child session. */
  readonly tools: readonly string[];
  /**
   * Base prompt: authored text (task `systemPrompt` or profile body) or the
   * parent's custom base prompt for composed children; undefined keeps the
   * stock prefix.
   */
  readonly systemPrompt: string | undefined;
  /** Appended prompt text for composed children: parent append, role, framing. */
  readonly appendSystemPrompt: readonly string[];
  readonly sessionId: string | undefined;
  readonly resumeFrom: string | undefined;
  /**
   * Compact display tag for a resumed transcript (derived from the
   * caller-supplied `resumeFrom` path, before any canonicalization, so
   * symlink aliases show the same identity the caller wrote). Rendered
   * as `↻<tag>` in task views; undefined on non-resume tasks.
   */
  readonly resumeTag: string | undefined;
  readonly deadlineMs: number | undefined;
  readonly workspace: Workspace;
  /**
   * Canonical write-scope roots when this task can mutate, else undefined.
   * Usually a single root; an external `core.worktree` keeps the physical
   * cwd reachable beside the Git top-level, so both are listed.
   */
  readonly writeRoots: readonly string[] | undefined;
  /**
   * Prerequisite task indexes within this batch (resolved `dependsOn`,
   * deduplicated). Empty for a phase-0 task.
   */
  readonly dependsOn: readonly number[];
  /**
   * Dependency depth: 0 with no prerequisites, else one deeper than the
   * deepest prerequisite. Phases run in order — a phase starts only after
   * every earlier phase finished, including its isolated reconciliation.
   */
  readonly phase: number;
}

export type TaskStatus =
  | "ok"
  | "failed"
  | "cancelled"
  | "blocked"
  /**
   * SPEC v3 "Interaction grammar — Interrupt": the task's in-flight turn
   * was cooperatively aborted on request (delegate_ticket interrupt).
   * Distinct from `cancelled` — interruption stops the turn but keeps the
   * worker resumable: a pooled session returns to the pool, a fresh task
   * keeps its persisted transcript for `resumeFrom`.
   */
  | "interrupted"
  /**
   * SPEC v3 "Batch token budget": the task never started — settled
   * siblings had already consumed the call's `tokenBudget` when it left
   * the queue. No worker, session, or tokens belong to it.
   */
  | "budget-exhausted";

/** How an isolated task's proposal ended up relative to the source tree. */
export type IntegrationStatus =
  | "applied_unverified"
  | "conflict"
  | "retained"
  | "no_changes"
  | "discarded"
  | "apply_failed";

export interface TaskIntegration {
  readonly status: IntegrationStatus;
  /** Why a proposal was retained or discarded, when not obvious. */
  readonly reason?: string;
  readonly proposedFiles: readonly string[];
  readonly appliedFiles: readonly string[];
  readonly conflicts?: readonly { path: string; reason: string }[];
  /** Recovery pointers for proposals that were not cleanly applied. */
  readonly baselineRef?: string;
  readonly proposalRef?: string;
  readonly patchPath?: string;
  readonly worktreePath?: string;
}

export interface TaskOutcome {
  readonly index: number;
  readonly id: string;
  readonly status: TaskStatus;
  /** Final assistant text, when one was produced. */
  readonly output?: string;
  readonly error?: string;
  readonly retries: number;
  readonly usage?: Usage;
  /** Isolated-workspace reconciliation result, when the task ran isolated. */
  readonly integration?: TaskIntegration;
  /**
   * For a `blocked` outcome: the prerequisite task ids whose terminal
   * states prevented the run. The `error` text carries their reasons.
   */
  readonly blockedBy?: readonly string[];
  /**
   * True when the task's session could not be confirmed quiescent and was
   * left undisposed. Callers must keep its reservations alive — work may
   * still be mutating shared roots.
   */
  readonly quarantined?: boolean;
  /**
   * The worker's session transcript on disk, when one exists — the path a
   * `resumeFrom` retry would open. Set only for outcomes of tasks whose
   * session was file-backed; reported in failure views for recovery.
   */
  readonly sessionFile?: string;
  /**
   * SPEC v3 "Observability — Completion evidence": absolute paths named by
   * the task's write/edit tool calls, resolved against the task cwd,
   * in first-observed order, deduplicated. Evidence, not confinement —
   * only what tool calls claimed; a file never named is never reported.
   */
  readonly attributedFiles?: readonly string[];
  /**
   * True when the task ran a bash/exec tool call: shell effects are
   * unobservable per-path, so `attributedFiles` is then a lower bound.
   */
  readonly uncertainFiles?: boolean;
}

/**
 * SPEC v3 "Batch token budget" — the dispatch's final account of its
 * `tokenBudget` ceiling: the configured limit, the total tokens recorded
 * by settled tasks, and when consumption crossed the limit (absent when
 * the batch finished inside budget).
 */
export interface TokenBudgetReport {
  readonly limit: number;
  readonly consumed: number;
  readonly exhaustedAt?: number;
}

export type TicketStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * How caller-facing output text is bounded: at or under
 * `spillThresholdChars` it stays verbatim; over it, only a
 * `spillTailChars`-long tail stays in-context and the rest spills to an
 * owner-only temp file (or degrades to the full output when the write
 * fails). Snapshotted onto each ticket at creation so a poll of a
 * long-settled ticket renders under the bounds it ran with — a later
 * config change must not retroactively reshape a rendered result.
 */
export interface OutputBounds {
  readonly spillThresholdChars: number;
  readonly spillTailChars: number;
}

/**
 * Caller-visible ticket record: identity, lifecycle status, and per-task
 * results — the persistable-shaped half. The `TicketStore` is its sole
 * writer: every property is readonly, so any out-of-store write is a compile
 * error, and all live machinery (cancellation, pause/settled/finished gates,
 * waiters, executions) lives in a store-private runtime half reached only
 * through store methods. Reads from anywhere are fine. `status` only moves
 * running → terminal, once.
 */
export interface Ticket {
  readonly id: string;
  readonly status: TicketStatus;
  /** Orthogonal to lifecycle: a paused ticket remains `running`. */
  readonly paused: boolean;
  readonly totalTasks: number;
  /** Index-aligned per-task outcomes; entries appear as tasks finish. */
  readonly outcomes: readonly (TaskOutcome | undefined)[];
  /** Labels, correlation ids, resume tags, alias/normalization notes — plus the task cwd, which relativizes attributed-file display (optional: records written before file attribution carry none). */
  readonly tasks: readonly (Pick<ResolvedTask, "id" | "agent" | "resumeTag" | "aliasedFrom" | "normalizedFrom" | "description"> & { readonly cwd?: string })[];
  /** Unanswered worker questions (never persisted across host shutdown). */
  readonly questions: readonly WorkerQuestion[];
  /**
   * The shared batch brief (SPEC v3 "Batch brief") prepended to every
   * task's prompt; persisted so a recovered ticket still renders the
   * header note. Undefined on pre-brief records and briefless dispatches.
   */
  readonly brief?: string;
  /**
   * The batch's token-budget account (SPEC v3 "Batch token budget"),
   * recorded when the dispatch completes — persisted so a recovered
   * ticket still renders the same `{limit, consumed, exhaustedAt}`.
   */
  readonly tokenBudget?: TokenBudgetReport;
  /**
   * Dispatch-scoped output-bounds snapshot captured at creation, so a
   * settled ticket's poll/wait renders under the bounds it ran with even
   * if `delegate.json` has since changed.
   */
  readonly outputBounds: OutputBounds;
  readonly createdAt: number;
  /** Cold-read ticket with no worker or admission reservation in this host. */
  readonly recovered?: boolean;
  /**
   * Advisory notices attached at dispatch (e.g. same-call shared writers
   * serializing); rendered at the top of ticket views.
   */
  readonly notices: readonly string[];
  /**
   * Session-tree origin at dispatch: the leaf id (null for the root) and the
   * navigation epoch. Delivery diagnostics reconstruct same-leaf vs moved
   * from these; recorded by the dispatcher right after creation via the
   * store.
   */
  readonly originLeafId?: string | null;
  readonly originEpoch?: number;
}

export interface WorkerQuestion {
  readonly id: string;
  readonly taskId: string;
  readonly question: string;
}

export interface ExecutionHandle {
  /**
   * Cooperative abort of in-flight model/tool work. The promise resolves
   * only if the worker confirms quiescence — it may never resolve when a
   * provider or tool ignores cancellation, so nothing caller-visible may
   * block on it.
   */
  abort(reason: string): Promise<void>;
  /**
   * Queue a steering message on the live run — Pi merges it into the
   * transcript as a user message at the next turn boundary, before the
   * next model request. Returns false when the execution has no live run
   * (session still being created, already wound down, or disposed); the
   * caller then parks the message for the task's next attempt instead of
   * injecting into a dead or pooled session.
   */
  steer?(message: string): boolean;
  /**
   * The task's file-attribution evidence so far (SPEC v3 "Observability —
   * Completion evidence"): write/edit call targets resolved against the
   * task cwd, plus the bash-uncertainty flag. Live view of the same
   * evidence the recorded outcome carries; attribution never feeds
   * admission, scheduling, or execution decisions.
   */
  attribution?(): { readonly files: readonly string[]; readonly uncertain: boolean };
}

export class Deferred {
  readonly promise: Promise<void>;
  private resolveFn!: () => void;
  private done = false;
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolveFn = resolve;
    });
  }
  get resolved(): boolean {
    return this.done;
  }
  resolve(): void {
    if (!this.done) {
      this.done = true;
      this.resolveFn();
    }
  }
}

/**
 * Minimal counting semaphore with a mutable limit. `active` counts granted
 * permits; grants are issued only while `active < limit`, so raising the
 * limit wakes queued waiters and lowering it simply stops new grants until
 * releases bring usage under the new bound.
 */
export class Semaphore {
  private active = 0;
  private limit: number;
  private readonly queue: (() => void)[] = [];
  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.drain();
  }
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(this.releaser());
      });
    });
  }
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }
  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      this.queue.shift()!();
    }
  }
}

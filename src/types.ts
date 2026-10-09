import type { Model, Api, Usage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type Workspace = "shared" | "scratch" | "isolated";

/** Historical saved-ticket rename metadata; new calls do not produce it. */
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
  /** Exact built-in or authored profile name. */
  readonly agent: string;
  /** Historical ticket-reader field; undefined on newly resolved tasks. */
  readonly aliasedFrom: string | undefined;
  /** Historical ticket-reader field; undefined on newly resolved tasks. */
  readonly normalizedFrom: readonly FieldNormalization[] | undefined;
  /**
   * The caller's `description` display label: display-only —
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
   * The verified provider-extension allowlist for this task's resolved
   * model provider (#59): user-scope package roots to load into the
   * child, the subset tagged best-effort (droppable on load failure), and
   * the signature pooled sessions freeze on. Present whenever the
   * provider has any applicable sources — `paths` may still be empty when
   * every shipped default failed to resolve; such tasks run
   * extension-free while keeping the signature for pool compatibility.
   */
  readonly providerExtensions:
    | {
        readonly paths: ReadonlySet<string>;
        readonly bestEffortPaths: ReadonlySet<string>;
        readonly signature: string;
      }
    | undefined;
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
  readonly workspace: Workspace;
  /**
   * Set by isolated/scratch workspace preparation when the task's cwd was
   * remapped into a copy: the original source root and the worker's copy
   * root. Drives the inline write/edit refusal — a call targeting the
   * source tree outside the copy is blocked — and anchors the workspace
   * note appended to the child prompt (#62). Undefined on shared tasks.
   */
  readonly workspaceGuard:
    | {
        readonly kind: "isolated" | "scratch";
        readonly sourceRoot: string;
        readonly copyRoot: string;
      }
    | undefined;
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
   * Historical only (#129): `budget-exhausted` was produced while the
   * caller-controlled batch tokenBudget existed. Nothing generates it
   * anymore; the literal remains so journal-recovered settled records
   * keep their honest status (axiom 2 — records survive supervisors).
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
  /**
   * Source-relative paths that changed in the original tree while this
   * worker ran a shell (#62) — isolated or scratch. Shell commands are not
   * confined to the worker copy, so drift beside the proposal is reported
   * as evidence — never applied and never silently absorbed into the
   * outcome. Sorted, bounded.
   */
  readonly sourceDrift?: readonly string[];
}

/**
 * The verdict a task run under the built-in `verifier` profile rules on:
 * PASS (the claim held up), FAIL (the evidence contradicts it), or
 * AMBIGUOUS (undecidable). Reporting evidence only (#49) — never
 * admission, scheduling, or gating input.
 */
export type TaskVerdict = "PASS" | "FAIL" | "AMBIGUOUS";

export interface TaskOutcome {
  readonly index: number;
  readonly id: string;
  readonly status: TaskStatus;
  /** Final assistant text, when one was produced. */
  readonly output?: string;
  readonly error?: string;
  readonly retries: number;
  readonly usage?: Usage;
  /** Isolated-workspace reconciliation result, when the task ran isolated;
   * scratch workers carry it only as source-drift evidence (#62). */
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
   * Byte offset into `sessionFile` where this run's entries begin. Fresh,
   * exclusive transcripts carry 0; a pooled or resumed session's file
   * holds earlier conversations, and the offset is where tailing starts
   * so a run's output never includes prior turns (delegate_ticket tail).
   */
  readonly transcriptStart?: number;
  /**
   * SPEC v3 "Observability — Completion evidence": absolute paths the
   * task changed, resolved against the task cwd, ordered, deduplicated —
   * the union of paths observed in its write/edit tool calls and the
   * paths its Git evidence window saw change (user decision 2026-10-02).
   * Evidence, not confinement: it reports what tools touched and claims
   * nothing about paths outside observation.
   */
  readonly attributedFiles?: readonly string[];
  /**
   * The subset of `attributedFiles` named directly by write/edit tool
   * calls — recorded when `concurrentWriters` is non-empty so overlap
   * reporting can fall back to unambiguous observations instead of the
   * Git window's potentially-shared diff.
   */
  readonly observedFiles?: readonly string[];
  /**
   * True when the task ran a bash/exec tool call AND no Git evidence
   * window covered its run (outside a repository, or Git failed): shell
   * effects are then unobservable, so `attributedFiles` is a lower
   * bound. A covered window sees the shell's footprint itself and the
   * flag lifts.
   */
  readonly uncertainFiles?: boolean;
  /**
   * True when the task ran a bash/exec tool call — regardless of Git
   * coverage. Internal evidence: isolated/scratch source-drift pinning
   * keys on "this worker could have escaped its copy", which a covered
   * window says nothing about.
   */
  readonly shellObserved?: boolean;
  /**
   * Writers whose work may appear inside this task's Git evidence
   * window: `parent` when the parent session ran a write/edit/bash/exec
   * call during it, `<ticket>#<task>` for another mutating delegate task
   * whose window overlapped on the same repository root. Advisory only —
   * the window is shared, not exclusive.
   */
  readonly concurrentWriters?: readonly string[];
  /**
   * SPEC v3 "Observability — Completion evidence — verifier verdict":
   * when the task ran under the built-in `verifier` profile, the verdict
   * parsed from the last `VERDICT:` line of its final output. Absent for
   * every non-verifier task and for a verifier run whose output carried
   * no verdict line — reporting only, never gating.
   */
  readonly verdict?: TaskVerdict;
}

export type TicketStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * The dispatching host's identity (#54), journaled at creation so a later
 * startup can tell "my predecessor died" from "a live sibling owns this
 * record". `bootId` is absent where the kernel exposes none (e.g.
 * Windows); `sessionId` names the owning Pi session for diagnostics.
 */
export interface TicketOwner {
  readonly pid: number;
  readonly bootId?: string;
  readonly sessionId?: string;
}

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
  /** Labels, correlation ids, resume tags, alias/normalization notes — plus the task cwd, which relativizes attributed-file display (optional: records written before file attribution carry none). `sessionId` is journaled so a settled pooled task's continuation hint survives a restart (#57). `sessionFile`/`transcriptStart` are journaled at claim time (#123): the transcript a worker claimed before its first turn, so crash recovery can name the durable file in the interrupted outcome. */
  readonly tasks: readonly (Pick<ResolvedTask, "id" | "agent" | "sessionId" | "resumeTag" | "aliasedFrom" | "normalizedFrom" | "description"> & { readonly cwd?: string; readonly sessionFile?: string; readonly transcriptStart?: number })[];
  /** Unanswered worker questions (never persisted across host shutdown). */
  readonly questions: readonly WorkerQuestion[];
  /**
   * The shared batch brief (SPEC v3 "Batch brief") prepended to every
   * task's prompt; persisted so a recovered ticket still renders the
   * header note. Undefined on pre-brief records and briefless dispatches.
   */
  readonly brief?: string;
  /**
   * Dispatch-scoped output-bounds snapshot captured at creation, so a
   * settled ticket's poll/wait renders under the bounds it ran with even
   * if `delegate.json` has since changed.
   */
  readonly outputBounds: OutputBounds;
  readonly createdAt: number;
  /**
   * The dispatching host's process/boot/session identity (#54), journaled
   * at creation. Startup recovery interrupts a `running` record only when
   * this owner is provably dead; records written before owner tracking
   * carry none and are never owner-interrupted.
   */
  readonly owner?: TicketOwner;
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
  /**
   * The run's durable transcript span, when the session is file-backed:
   * `file` is the `.jsonl` path and `start` the byte offset where this
   * run's entries begin (0 for a fresh file; the size at checkout for a
   * pooled or resumed one). Undefined while no session exists yet and
   * for in-memory sessions — the caller falls back to captured activity
   * text there.
   */
  transcript?(): { readonly file: string; readonly start: number } | undefined;
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
  /** Granted permits — the in-flight task count under this bound. */
  get activeCount(): number {
    return this.active;
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

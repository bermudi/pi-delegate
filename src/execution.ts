import { DiagnosticSink } from "./diagnostics.ts";
import { existsSync } from "node:fs";
import type {
  AgentSession,
  AgentSessionEvent,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  createSubagentResourceLoader,
  createSubagentSession,
  loadSubagentResources,
  type HostEnvironment,
} from "./host.ts";
import {
  isClearlyTransientError,
  isModelAttributableError,
  MAX_TASK_ATTEMPTS,
  failureCategory,
  MODEL_SWAP_HINT,
  RETRY_DELAY_MS,
  limitHint,
  sleep,
} from "./retry.ts";
import { persistSessionHeader, transcriptSize, type PooledSession, type SessionPool } from "./sessions.ts";
import { parseVerdict } from "./format.ts";
import { isWorkspaceGuardRefusal, toolPathTarget } from "./workspace-guard.ts";
import {
  Deferred,
  type ExecutionHandle,
  type ResolvedTask,
  type TaskOutcome,
  type TaskVerdict,
} from "./types.ts";

/** Cooperative controls the coordinator hands to each task run. */
export interface RunControls {
  readonly env: HostEnvironment;
  /** The sessionId pool; owns pooled-session custody after each run. */
  readonly sessions: SessionPool;
  /** Block while the owning ticket is paused; resolves early on abort. */
  readonly waitWhilePaused: (signal?: AbortSignal) => Promise<void>;
  /** Only async-ticket workers can ask; callback parks the execution slot. */
  readonly askQuestion?: (question: string, signal: AbortSignal) => Promise<string>;
  /** Whether this run's work has been aborted. */
  readonly isAborted: () => boolean;
  /** Combined cancellation signal (ticket cancel, parent abort, stall). */
  readonly signal: AbortSignal;
  /** Inactivity watchdog budget in ms; 0 disables it. */
  readonly stallTimeoutMs: number;
  /** Idle pooled-session residency bound (#46) — `delegate.json sessions.maxIdle`. */
  readonly maxIdleSessions: number;
  /** Optional per-event sink (visibility/activity); never errors into the run. */
  readonly observe?: (event: AgentSessionEvent) => void;
  /**
   * Claim the child session's transcript file for exclusive ownership
   * (transcript exclusivity); undefined when the run carries no grant
   * context. Called once the concrete file is known — before the first
   * turn writes into it.
   */
  readonly holdTranscript?: (path: string) => void;
  /**
   * Steer messages parked while no run was live (SPEC v3 "Steering").
   * Drained just before prompt(): each message is queued on the child's
   * steering queue, where the agent loop merges it at run start — so a
   * steer parked during queueing or between retry attempts opens the
   * task's next turn. The callback consumes the queue; a late drain
   * after cancellation is dropped with the session, never delivered.
   */
  readonly consumeSteers?: () => readonly string[];
}

export interface AttemptResult {
  /** Internal-only cause for safe retry diagnostics; never copied to outcomes. */
  readonly diagnosticCause?: unknown;
  readonly status: "ok" | "failed" | "cancelled" | "interrupted";
  readonly output?: string;
  readonly error?: string;
  readonly usage?: Usage;
  readonly hadSideEffects: boolean;
  /**
   * The session could not be confirmed quiescent and was left undisposed.
   * Its write reservations must stay held; retrying is unsafe.
   */
  readonly quarantined: boolean;
  /**
   * The session transcript confirmed on disk — the path a `resumeFrom`
   * retry opens. Undefined for in-memory sessions or when no file exists.
   */
  readonly sessionFile?: string;
  /**
   * Byte offset into `sessionFile` where this attempt's entries begin —
   * pairs with `sessionFile` so a tail of a pooled or resumed transcript
   * reads only this run's turns (delegate_ticket tail).
   */
  readonly transcriptStart?: number;
  /**
   * This attempt's file-attribution evidence (SPEC v3 "Observability —
   * Completion evidence"): write/edit call targets resolved against the
   * task cwd. The task-level outcome merges every attempt's evidence.
   */
  readonly attributedFiles?: readonly string[];
  /** True when the attempt ran a bash/exec call — unobservable file effects. */
  readonly uncertainFiles?: boolean;
}

function abortedSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function log(diagnostics: DiagnosticSink, context: string, error: unknown): void {
  diagnostics.log("error", "execution cleanup/control failed", { operation: context }, error);
}

function usageOf(session: AgentSession): Usage {
  const stats = session.getSessionStats();
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: stats.cost,
    },
  };
}

/** Per-run usage: getSessionStats() is cumulative for pooled sessions. */
function diffUsage(after: Usage, before: Usage): Usage {
  return {
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    totalTokens: after.totalTokens - before.totalTokens,
    cost: {
      input: after.cost.input - before.cost.input,
      output: after.cost.output - before.cost.output,
      cacheRead: after.cost.cacheRead - before.cost.cacheRead,
      cacheWrite: after.cost.cacheWrite - before.cost.cacheWrite,
      total: after.cost.total - before.cost.total,
    },
  };
}

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

const SIDE_EFFECT_TOOLS = new Set(["write", "edit", "bash"]);

/** Tools whose calls mutate files at a path named in their arguments. */
const FILE_PATH_TOOLS = new Set(["write", "edit"]);
/**
 * Shell tools: they can mutate any path and name none reliably, so a task
 * that ran one carries unobservable file effects (SPEC v3 "Observability —
 * Completion evidence": bash-sourced changes are marked uncertain; bash
 * output is never parsed for paths).
 */
const SHELL_TOOLS = new Set(["bash", "exec"]);

/**
 * The path a write/edit call targets: `path`, `file_path`, or `filePath`
 * (v1's file-tracking.ts:10-17 accepted the same aliases across tool
 * versions). Narrowed from the event's `any` args — a missing or empty
 * path yields no attribution for that call, never a throw.
 */
function toolCallPath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const bag = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"] as const) {
    const value = bag[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function lastAssistantText(session: AgentSession): {
  text: string;
  stopReason?: string;
  errorMessage?: string;
} {
  const last = session.messages
    .filter((m): m is AssistantMessage => m.role === "assistant")
    .at(-1);
  if (!last || !Array.isArray(last.content)) {
    return { text: "", stopReason: last?.stopReason, errorMessage: last?.errorMessage };
  }
  const text = last.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { text, stopReason: last.stopReason, errorMessage: last.errorMessage };
}

/**
 * Cancellation-cause precedence: a parent/ticket abort outranks a stall. Lower rank wins when causes race.
 */
const ABORT_PRECEDENCE: Record<string, number> = {
  cancelled: 0,
  // Interrupt is an operator abort that keeps the worker resumable — it
  // outranks watchdog causes (an interrupt landing mid-stall still
  // reports interrupted) but loses to ticket/parent cancellation.
  interrupted: 1,
  stall: 2,
};

function preferredReason(
  existing: string | undefined,
  incoming: string,
): string {
  if (existing === undefined) return incoming;
  return (ABORT_PRECEDENCE[incoming] ?? 99) <
    (ABORT_PRECEDENCE[existing] ?? 99)
    ? incoming
    : existing;
}

/**
 * The transcript path to report on an outcome, or undefined when none
 * exists on disk. `flushHeader` asks the session manager to write its
 * buffered entries first: a file-backed SessionManager defers the first
 * write until an assistant message lands, so a first-call failure leaves
 * the planned path uncreated — flushing makes the reported path real.
 * Only a file confirmed on disk is ever reported; the caller must never
 * chase a nonexistent resume target. Flush only once the session has
 * wound down — a still-live worker could interleave appends with the
 * rewrite, so provisional paths report whatever already exists.
 */
function reportableTranscript(
  diagnostics: DiagnosticSink,
  session: AgentSession | undefined,
  flushHeader: boolean,
): string | undefined {
  if (session === undefined) return undefined;
  const file = session.sessionFile;
  if (typeof file !== "string") return undefined;
  if (flushHeader) persistSessionHeader(diagnostics, session.sessionManager);
  return existsSync(file) ? file : undefined;
}

/**
 * One attempt at one task. Owns the child AgentSession for the attempt's
 * duration and exposes cooperative abort. A run ends when prompt() settles;
 * the child is extension-free, so settlement means no background
 * continuations remain. Disposal happens exactly once, in run()'s finally:
 * abort() alone is not proof of quiescence because a prompt in preflight
 * has not registered its run yet, and a run can still start afterward.
 *
 * Two settlements are kept distinct:
 *
 * - result() is the caller-visible settlement. It resolves with the true
 *   outcome when the run winds down, or with a provisional cancelled /
 *   stall outcome as soon as cancellation is requested — a provider or
 *   tool that ignores the abort signal must not hold the caller. A
 *   provisional outcome is quarantined: termination is unconfirmed, so the
 *   worker's reservations stay held.
 * - settled() is the worker truth: it resolves only when the run actually
 *   wound down (prompt() and waitForIdle() settled), confirming quiescence.
 *   Its outcome may then release a retained reservation; it can never be a
 *   success after cancellation.
 */
export class TaskExecution implements ExecutionHandle {
  private session: AgentSession | undefined;
  private abortReason: string | undefined;
  private finished = false;
  private disposed = false;
  private quarantined = false;
  private hadSideEffects = false;
  /**
   * SPEC v3 "Observability — Completion evidence": write/edit call
   * targets observed on this run, resolved against the task cwd, in
   * first-observed order (Set insertion), deduplicated. Attribution
   * records the call's claimed path — a write that later errors or is
   * cancelled still may have mutated, so `tool_execution_start` is the
   * observation point (v1 file-tracking.ts:301-323 attributed on the
   * call for the same reason).
   */
  private readonly attributed = new Set<string>();
  /**
   * Claims per attributed path: a refusal subtracts only its own call's
   * claim. Guard refusal is filesystem-state-dependent (a symlink can
   * retarget a path between calls), so the same spelled path can write
   * once and refuse later — dropping the path outright would erase the
   * earlier write's evidence.
   */
  private readonly attributedClaims = new Map<string, number>();
  /**
   * toolCallId → the resolved path its write/edit call claimed at
   * `tool_execution_start`. Pi emits the start event before extension
   * `tool_call` handlers can block, so a refused call is already
   * attributed; `tool_execution_end` carries the refusal and the entry
   * here lets the subtraction find exactly the path that call added.
   */
  private readonly pendingCallPaths = new Map<string, string>();
  /** True once a bash/exec call ran — shell file effects are unobservable. */
  private uncertainFiles = false;
  /**
   * Steer text this attempt pushed onto its session's steering queue, in
   * injection order — the parked drain first, then live steers. The
   * session dies with its queue, so a whole-task retry re-supplies this
   * list through the next attempt's consumeSteers (SPEC v3 "Steering":
   * a receipted message survives the failed session).
   */
  private readonly injectedSteers: string[] = [];
  /** The pooled session this run checked out, when the task reused one. */
  private poolEntry: PooledSession | undefined;
  /**
   * This run's durable transcript span: the `.jsonl` path plus the byte
   * offset where its entries begin — the file's size at session
   * assignment, before prompt() appends anything. Pooled and resumed
   * sessions carry earlier conversations in the same file; the offset
   * keeps a tail of this run from reading prior turns. Undefined for
   * in-memory sessions.
   */
  private transcriptSpan: { readonly file: string; readonly start: number } | undefined;
  /** True once session.prompt() was attempted this run. */
  private prompted = false;
  /** Inactivity watchdog: while armed, the wall-clock instant of the stall. */
  private stallAt: number | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** True while parked in the pause gate — parked time is not inactivity. */
  private stallSuspended = false;
  /** While suspended, the frozen countdown to re-arm on resume. */
  private stallRemaining: number | undefined;
  private exclusiveQuestionTurn = false;
  /** Resolves the moment cancellation is requested, however it arrives. */
  private readonly abortRequested = new Deferred();
  private readonly done: Promise<AttemptResult>;

  constructor(
    private readonly task: ResolvedTask,
    private readonly controls: RunControls,
    loader: DefaultResourceLoader,
  ) {
    this.done = this.run(loader).then((outcome) => {
      this.settleSession(outcome);
      return this.withAttribution(outcome);
    });
  }

  result(): Promise<AttemptResult> {
    return Promise.race([
      this.done,
      this.abortRequested.promise.then(() =>
        this.withAttribution(this.provisionalOutcome())),
    ]);
  }

  settled(): Promise<AttemptResult> {
    return this.done;
  }

  /**
   * Cooperative abort: record the cause, mark caller settlement due, and ask
   * the session to idle. abortRequested resolves before the session is
   * touched — session.abort() waits for quiescence and may never settle when
   * the provider or a tool ignores the signal. Never disposes — a prompt in
   * preflight registers no run yet, so session.abort() can return while a
   * run is about to start; the agent_start listener in run() kills such
   * late runs and run()'s finally disposes.
   */
  async abort(reason: string): Promise<void> {
    this.abortReason = preferredReason(this.abortReason, reason);
    this.abortRequested.resolve();
    const session = this.session;
    if (!session || this.finished) return;
    try {
      await session.abort();
    } catch (error) {
      // The session may still be mutating; quarantine it — never dispose,
      // never release its write reservations.
      this.quarantined = true;
      log(this.controls.env.diagnostics, `abort of task ${this.task.id} failed; session left undisposed`, error);
    }
  }

  /**
   * SPEC v3 "Interaction grammar — Steering": a steer is a message with a
   * delivery receipt. Queue it on the child agent's steering queue — the
   * loop merges it into the transcript as a user message at the next turn
   * boundary (after the in-flight turn's tool calls, before the next
   * model request; pi-agent-core agent-loop.js drains the queue at turn
   * boundaries). Synchronous so the receipt is exact: the message is on
   * the live run's queue when we claim "steered". Returns false when no
   * run is live — no session yet (creation in flight), wound down, or a
   * non-streaming gap — so the caller parks it for the next attempt
   * rather than writing into a dead or pooled session's queue.
   */
  steer(message: string): boolean {
    const session = this.session;
    if (this.finished || session === undefined || !session.isStreaming) {
      return false;
    }
    try {
      session.agent.steer({
        role: "user",
        content: [{ type: "text", text: message }],
        timestamp: Date.now(),
      });
      // Record only after the queue accepted the message — a thrown push
      // was never delivered, so a retry must not re-supply it.
      this.injectedSteers.push(message);
      return true;
    } catch (error) {
      log(this.controls.env.diagnostics, `steer of task ${this.task.id} failed`, error);
      return false;
    }
  }

  /**
   * Every steer message this attempt injected into its session, in order.
   * runTask reads this at the retry boundary so the next attempt's
   * consumeSteers can re-supply them. Final once the run winds down — a
   * finished execution refuses steer() before it can touch the session.
   */
  retainedSteers(): readonly string[] {
    return [...this.injectedSteers];
  }

  /**
   * Live read of this run's file-attribution evidence (SPEC v3
   * "Observability — Completion evidence") — the same evidence the
   * recorded outcome carries. Pure observation: nothing reads this for
   * admission, scheduling, or execution decisions.
   */
  attribution(): { readonly files: readonly string[]; readonly uncertain: boolean } {
    return { files: [...this.attributed], uncertain: this.uncertainFiles };
  }

  /**
   * This run's durable transcript span for delegate_ticket tail — set at
   * session assignment and stable for the run's life: the file may still
   * be unwritten (first write lands with the first assistant message) and
   * is not required to exist for the span to be correct.
   */
  transcript(): { readonly file: string; readonly start: number } | undefined {
    return this.transcriptSpan;
  }

  /**
   * The `{sessionFile, transcriptStart}` pair for an outcome — the
   * reportable transcript plus the byte offset where this run's entries
   * begin, so a later tail of the file reads only this run's turns.
   */
  private transcriptOutcome(
    flushHeader: boolean,
  ): { sessionFile?: string; transcriptStart?: number } {
    const file = reportableTranscript(this.controls.env.diagnostics, this.session, flushHeader);
    if (file === undefined) return {};
    return {
      sessionFile: file,
      transcriptStart: this.transcriptSpan?.start ?? 0,
    };
  }

  /** Stamps the attempt's observed attribution onto its result. */
  private withAttribution(outcome: AttemptResult): AttemptResult {
    const files = [...this.attributed];
    return {
      ...outcome,
      ...(files.length > 0 ? { attributedFiles: files } : {}),
      ...(this.uncertainFiles ? { uncertainFiles: true } : {}),
    };
  }

  /**
   * One observed tool call's contribution to file attribution. write/edit
   * claim a path in their arguments; bash/exec record no path but mark
   * the evidence uncertain — a shell can mutate anything it can reach.
   */
  private noteToolCall(toolCallId: string, toolName: string, args: unknown): void {
    if (SHELL_TOOLS.has(toolName)) {
      this.uncertainFiles = true;
      return;
    }
    if (!FILE_PATH_TOOLS.has(toolName)) return;
    const raw = toolCallPath(args);
    if (raw !== undefined) {
      // The same spelling normalization the tool applies — `@`/`file://`/
      // unicode-space spellings attribute the file they actually hit.
      const resolved = toolPathTarget(raw, this.task.cwd);
      this.attributed.add(resolved);
      this.attributedClaims.set(
        resolved,
        (this.attributedClaims.get(resolved) ?? 0) + 1,
      );
      this.pendingCallPaths.set(toolCallId, resolved);
    }
  }

  /**
   * A workspace-guard refusal (#62) means the call never ran: its claimed
   * path is not evidence of a write. Subtract only this call's claim —
   * refusal depends on live filesystem state, so an earlier call to the
   * same path may have legitimately written it.
   */
  private noteToolCallEnd(
    toolCallId: string,
    toolName: string,
    isError: boolean,
    result: unknown,
  ): void {
    const pending = this.pendingCallPaths.get(toolCallId);
    this.pendingCallPaths.delete(toolCallId);
    if (pending === undefined || !isError || !FILE_PATH_TOOLS.has(toolName)) {
      return;
    }
    const content = (result as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return;
    const refused = content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string" &&
        isWorkspaceGuardRefusal((part as { text: string }).text),
    );
    if (refused) {
      const remaining = (this.attributedClaims.get(pending) ?? 1) - 1;
      if (remaining <= 0) {
        this.attributedClaims.delete(pending);
        this.attributed.delete(pending);
      } else {
        this.attributedClaims.set(pending, remaining);
      }
    }
  }

  /**
   * Stalls settle as failures with their own wording; operator and parent aborts settle as plain cancellations.
   */
  private watchdogError(): string | undefined {
    if (this.abortReason === "stall") {
      return `stalled: no session activity for ${this.controls.stallTimeoutMs}ms; task aborted`;
    }
    return undefined;
  }

  /**
   * The status an abort settles as (SPEC v3 "Interaction grammar —
   * Interrupt"): a task-level interrupt keeps the worker resumable; every
   * other abort cause is a plain cancellation.
   */
  private abortStatus(): "cancelled" | "interrupted" {
    return this.abortReason === "interrupted" ? "interrupted" : "cancelled";
  }

  /** The interruption explanation on the outcome's error field. */
  private interruptError(): string | undefined {
    return this.abortReason === "interrupted"
      ? "the in-flight turn was aborted on request; the worker stays resumable"
      : undefined;
  }

  /**
   * The outcome the caller sees when cancellation was requested before the
   * worker confirmed it stopped. Honest about uncertainty: quarantined is
   * always set, and partial output reflects what is already on the record.
   */
  private provisionalOutcome(): AttemptResult {
    const session = this.session;
    const partial = session
      ? lastAssistantText(session)
      : { text: "" };
    const watchdog = this.watchdogError();
    if (watchdog !== undefined) {
      return {
        status: "failed",
        output: partial.text || undefined,
        error: watchdog,
        hadSideEffects: this.hadSideEffects,
        quarantined: true,
        ...this.transcriptOutcome(false),
      };
    }
    return {
      status: this.abortStatus(),
      output: partial.text || undefined,
      error: this.interruptError(),
      hadSideEffects: this.hadSideEffects,
      quarantined: true,
      ...this.transcriptOutcome(false),
    };
  }

  /**
   * The inactivity watchdog: every session event is activity and restarts
   * the countdown. While suspended (parked in the pause gate) the countdown
   * freezes — parked time is not inactivity — but an event still proves the
   * worker is alive and restores the full budget for when it resumes.
   */
  private armStall(ms: number): void {
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.stallAt = Date.now() + ms;
    this.stallTimer = setTimeout(() => void this.abort("stall"), ms);
  }

  private noteActivity(): void {
    const budget = this.controls.stallTimeoutMs;
    if (budget <= 0) return;
    if (this.stallSuspended) {
      this.stallRemaining = budget;
      return;
    }
    this.armStall(budget);
  }

  private suspendStall(): void {
    this.stallSuspended = true;
    if (this.stallTimer === undefined || this.stallAt === undefined) return;
    this.stallRemaining = Math.max(0, this.stallAt - Date.now());
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.stallAt = undefined;
  }

  private resumeStall(): void {
    this.stallSuspended = false;
    const remaining = this.stallRemaining;
    this.stallRemaining = undefined;
    // A countdown frozen at zero fires on resume — the silence budget was
    // already spent. A worker suspended before the watchdog was ever armed
    // gets a fresh budget rather than no watchdog.
    if (remaining !== undefined) this.armStall(remaining);
    else if (this.controls.stallTimeoutMs > 0) {
      this.armStall(this.controls.stallTimeoutMs);
    }
  }

  private clearStall(): void {
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.stallAt = undefined;
  }

  private disposeSession(): void {
    if (this.disposed || !this.session) return;
    this.disposed = true;
    try {
      this.session.dispose();
    } catch (error) {
      log(this.controls.env.diagnostics, `dispose of task ${this.task.id} failed`, error);
    }
  }

  /**
   * Session custody at run end. A sessionId task's session belongs to the
   * pool: it decides keep/evict/dispose from the outcome (insert-on-success,
   * evict after a prompted cancel or watchdog abort, keep through ordinary
   * failure and pre-prompt cancellation). Other sessions are disposed here
   * unless quarantined.
   */
  private settleSession(outcome: AttemptResult): void {
    const session = this.session;
    if (this.task.sessionId === undefined || session === undefined) {
      if (!this.quarantined) this.disposeSession();
      return;
    }
    this.controls.sessions.settle({
      entry: this.poolEntry,
      task: this.task,
      session,
      outcome: {
        status: outcome.status,
        prompted: this.prompted,
        watchdog:
          this.abortReason === "stall"
            ? this.abortReason
            : undefined,
        quarantined: this.quarantined,
      },
      maxIdle: this.controls.maxIdleSessions,
    });
  }

  private async run(loader: DefaultResourceLoader): Promise<AttemptResult> {
    let session: AgentSession | undefined;
    let usageBefore: Usage | undefined;
    const onAbort = () => void this.abort("cancelled");
    this.controls.signal.addEventListener("abort", onAbort, { once: true });
    try {
      // An abort already delivered (or landing during session creation)
      // resolves caller settlement even if creation never returns.
      if (this.controls.signal.aborted) void this.abort("cancelled");
      const create = (resumeFile?: string) =>
        createSubagentSession(
          this.task, this.controls.env, loader,
          (question, signal) => this.controls.sessions.askQuestion(session!, question, signal),
          resumeFile,
        );
      // Checkout before creation: a pooled resident session is reused
      // directly; an entry unloaded under the residency policy (#46)
      // reloads transparently from its own transcript file.
      this.poolEntry = await this.controls.sessions.checkout(this.task, create);
      session = this.poolEntry?.session ?? (await create());
      // Transcript exclusivity: claim the concrete file before the first
      // turn writes into it. resumeFrom paths were reserved at admission;
      // this also covers a pooled session's first run, whose file did not
      // exist when the call was admitted. Idempotent per task+path.
      const transcriptFile = session.sessionFile;
      if (typeof transcriptFile === "string") {
        this.controls.holdTranscript?.(transcriptFile);
      }
      this.controls.sessions.bindQuestion(session, this.controls.askQuestion === undefined
        ? undefined
        : async (question, signal) => {
            if (!this.exclusiveQuestionTurn) {
              throw new Error("ask_parent must be the only tool call in its model turn.");
            }
            if (this.abortReason !== undefined || this.controls.isAborted() || signal.aborted) {
              throw new Error("Question cancelled before it could be asked.");
            }
            this.suspendStall();
            try {
              const answer = await this.controls.askQuestion!(question, signal);
              if (this.abortReason !== undefined || this.controls.isAborted() || signal.aborted) {
                throw new Error("Question cancelled while waiting for its answer.");
              }
              return answer;
            } finally {
              this.resumeStall();
            }
          });
      session.setActiveToolsByName([...this.task.tools, ...(this.controls.askQuestion ? ["ask_parent"] : [])]);
      this.session = session;
      // Tail baseline: everything already in the file predates this run —
      // pooled and resumed transcripts carry earlier conversations. A
      // file that does not exist yet starts at 0.
      const spanFile = session.sessionFile;
      this.transcriptSpan =
        typeof spanFile === "string"
          ? { file: spanFile, start: transcriptSize(spanFile) }
          : undefined;
      // A cancellation that landed during session creation found no session
      // to abort; honor it now — the session must never be prompted. A
      // checked-out pooled session is quiescent by definition: it is simply
      // handed back, un-prompted.
      if (this.abortReason !== undefined || this.controls.isAborted()) {
        if (this.poolEntry === undefined) {
          try {
            await session.abort();
          } catch (error) {
            this.quarantined = true;
            log(this.controls.env.diagnostics, `abort during setup of task ${this.task.id} failed`, error);
          }
        }
        const watchdog = this.watchdogError();
        if (watchdog !== undefined) {
          return {
            status: "failed",
            error: watchdog,
            hadSideEffects: false,
            quarantined: this.quarantined,
            ...this.transcriptOutcome(true),
          };
        }
        return {
          status: this.abortStatus(),
          error: this.interruptError(),
          hadSideEffects: false,
          quarantined: this.quarantined,
          ...this.transcriptOutcome(true),
        };
      }

      // Pause gate between model turns: when the ticket is paused, a turn
      // that produced tool calls parks before the next provider request. A
      // naturally final turn (no tool results) never parks. The hook is
      // restored when the run ends so a pooled session is reusable under a
      // later call's controls.
      const child = session;
      const agent = child.agent;
      const previous = agent.prepareNextTurnWithContext;
      agent.prepareNextTurnWithContext = async (turn, signal) => {
        if (turn.toolResults.length > 0) {
          this.suspendStall();
          try {
            await this.controls.waitWhilePaused(signal);
          } finally {
            this.resumeStall();
          }
        }
        return previous?.(turn, signal);
      };

      // Every session event is watchdog activity. Also track tool
      // executions that produced side effects; whole-task retry must never
      // replay them. A run that starts after cancellation (abort landed in
      // prompt preflight, before the run registered) is killed at its
      // first event.
      const unsubscribe = child.subscribe((event: AgentSessionEvent) => {
        this.noteActivity();
        if (event.type === "message_end" && event.message.role === "assistant") {
          const calls = event.message.content.filter((part) => part.type === "toolCall");
          this.exclusiveQuestionTurn = calls.length === 1 && calls[0]?.name === "ask_parent";
        }
        // The activity sink is diagnostics (issue #24): a throwing observer
        // must never break the run it observes.
        try {
          this.controls.observe?.(event);
        } catch (error) {
          this.controls.env.diagnostics.log("error", "activity observer failed", {}, error);
        }
        if (event.type === "agent_start") {
          if (this.abortReason !== undefined || this.controls.isAborted()) {
            child.agent.abort();
          }
          return;
        }
        if (event.type === "tool_execution_end") {
          if (SIDE_EFFECT_TOOLS.has(event.toolName)) {
            this.hadSideEffects = true;
          }
          this.noteToolCallEnd(
            event.toolCallId,
            event.toolName,
            event.isError,
            event.result,
          );
        }
        // File-attribution evidence: the call's claimed path, observed
        // whether or not the tool reports success (it may have mutated).
        if (event.type === "tool_execution_start") {
          this.noteToolCall(event.toolCallId, event.toolName, event.args);
        }
      });
      // Armed until the run ends — including waitForIdle, where a wedged
      // session produces no events and the watchdog is the rescue.
      this.noteActivity();

      usageBefore = usageOf(session);
      // Steers parked while no run was live ride the first turn: the
      // agent loop drains its steering queue before the first model
      // request, so these merge alongside the task prompt. Synchronous
      // queue pushes, before prompt() starts the run.
      for (const steer of this.controls.consumeSteers?.() ?? []) {
        session.agent.steer({
          role: "user",
          content: [{ type: "text", text: steer }],
          timestamp: Date.now(),
        });
        this.injectedSteers.push(steer);
      }
      try {
        this.prompted = true;
        await session.prompt(this.task.prompt, {
          expandPromptTemplates: false,
        });
        await session.waitForIdle();
      } finally {
        unsubscribe();
        this.controls.sessions.bindQuestion(session, undefined);
        agent.prepareNextTurnWithContext = previous;
      }

      const { text, stopReason, errorMessage } = lastAssistantText(session);
      const usage = diffUsage(usageOf(session), usageBefore);
      const watchdog = this.watchdogError();
      if (watchdog !== undefined) {
        return {
          status: "failed",
          output: text || undefined,
          error: watchdog,
          usage,
          hadSideEffects: this.hadSideEffects,
          quarantined: this.quarantined,
          ...this.transcriptOutcome(true),
        };
      }
      if (this.abortReason || this.controls.isAborted() || stopReason === "aborted") {
        return {
          status: this.abortStatus(),
          output: text || undefined,
          error: this.interruptError(),
          usage,
          hadSideEffects: this.hadSideEffects,
          quarantined: this.quarantined,
          ...this.transcriptOutcome(true),
        };
      }
      if (stopReason === "error") {
        const error = errorMessage ?? "the provider returned an error";
        const hint = limitHint(error);
        return {
          status: "failed",
          output: text || undefined,
          error: hint !== undefined
            ? `${error} — ${hint}`
            : isModelAttributableError(error)
              ? `${error} — ${MODEL_SWAP_HINT}`
              : error,
          usage,
          hadSideEffects: this.hadSideEffects,
          quarantined: this.quarantined,
          ...this.transcriptOutcome(true),
        };
      }
      return {
        status: "ok",
        output: text,
        usage,
        hadSideEffects: this.hadSideEffects,
        quarantined: this.quarantined,
        ...this.transcriptOutcome(false),
      };
    } catch (error) {
      // A throw after prompt() consumed tokens still owes the caller the
      // attempt's usage — a kept pooled session must account for it.
      const usage =
        session !== undefined && usageBefore !== undefined
          ? diffUsage(usageOf(session), usageBefore)
          : undefined;
      const watchdog = this.watchdogError();
      if (watchdog !== undefined) {
        return {
          status: "failed",
          error: watchdog,
          usage,
          hadSideEffects: this.hadSideEffects,
          quarantined: this.quarantined,
          ...this.transcriptOutcome(true),
        };
      }
      if (this.abortReason || this.controls.isAborted()) {
        return {
          status: this.abortStatus(),
          error: this.interruptError(),
          usage,
          hadSideEffects: this.hadSideEffects,
          quarantined: this.quarantined,
          ...this.transcriptOutcome(true),
        };
      }
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        diagnosticCause: error,
        usage,
        hadSideEffects: this.hadSideEffects,
        quarantined: this.quarantined,
        ...this.transcriptOutcome(true),
      };
    } finally {
      this.controls.signal.removeEventListener("abort", onAbort);
      if (session) this.controls.sessions.bindQuestion(session, undefined);
      this.clearStall();
      this.finished = true;
    }
  }
}

/**
 * SPEC v3 "Observability — Completion evidence — verifier verdict" (#49):
 * a task run under the built-in `verifier` profile gets its final output's
 * last `VERDICT:` line parsed onto the outcome — evidence riding beside
 * attribution, never an execution decision. Every other agent returns
 * undefined, as does a verifier run whose output carries no verdict line.
 */
function verdictOf(
  task: ResolvedTask,
  output: string | undefined,
): TaskVerdict | undefined {
  if (task.agent !== "verifier" || output === undefined) return undefined;
  return parseVerdict(output);
}

function canRetryWholeTask(
  task: ResolvedTask,
  attempt: AttemptResult,
): boolean {
  return (
    !task.sessionId &&
    !task.resumeFrom &&
    !attempt.hadSideEffects &&
    !attempt.quarantined &&
    isClearlyTransientError(attempt.error)
  );
}

/**
 * Run a task with the whole-task retry policy: a clearly transient failure
 * gets a bounded number of fresh attempts; model-attributable, cancelled,
 * side-effecting, and quarantined failures return immediately.
 */
export async function runTask(
  task: ResolvedTask,
  controls: RunControls,
  loaders: Map<string, Promise<DefaultResourceLoader>>,
  onExecution?: (handle: ExecutionHandle) => void,
  onWorkerSettled?: (
    handle: ExecutionHandle,
    late: TaskOutcome | undefined,
  ) => void,
): Promise<TaskOutcome> {
  let retries = 0;
  let usage: Usage | undefined;
  // Steer text already injected into a failed attempt's session dies
  // with it — each retry re-supplies the retained set through the next
  // attempt's consumeSteers, ahead of anything parked since (SPEC v3
  // "Steering": receipted input is never dropped with the session).
  let carriedSteers: readonly string[] = [];
  // Task-level file attribution unions every attempt's evidence: the task
  // record reports all paths any of its runs claimed (SPEC v3
  // "Observability — Completion evidence").
  const allFiles = new Set<string>();
  let anyUncertain = false;
  const mergeAttribution = (attempt: AttemptResult): void => {
    for (const file of attempt.attributedFiles ?? []) allFiles.add(file);
    if (attempt.uncertainFiles === true) anyUncertain = true;
  };
  let last: AttemptResult = {
    status: "failed",
    error: "no attempt ran",
    hadSideEffects: false,
    quarantined: false,
  };

  for (;;) {
    if (controls.isAborted()) {
      last = { status: "cancelled", hadSideEffects: false, quarantined: last.quarantined };
      break;
    }
    let loaderPromise: Promise<DefaultResourceLoader>;
    if (task.providerExtensions !== undefined || task.workspaceGuard !== undefined) {
      // Extension-bearing children never share a loader: the extension
      // runtime binds mutable per-session state, so every attempt builds
      // and loads its own (v1 host.ts `loadChildResources`). Required
      // roots already proved loadable at resolve time (before admission);
      // this reload stays fail-closed for a root that changed since and
      // for errors the probe skipped. Best-effort roots drop silently.
      // The workspace guard (#62) takes the same path: it is an inline
      // factory whose load failure is fatal — a cached loader would skip
      // the error check and could run the task unguarded.
      loaderPromise = loadSubagentResources(task, controls.env);
    } else {
      const key = JSON.stringify([task.cwd, task.systemPrompt ?? null, task.appendSystemPrompt]);
      loaderPromise = loaders.get(key) ?? (() => {
        const loader = createSubagentResourceLoader(task, controls.env);
        const promise = loader.reload().then(() => loader);
        loaders.set(key, promise);
        return promise;
      })();
    }
    // Loading remains abortable even before a child session exists.
    const loader = await Promise.race([
      loaderPromise,
      abortedSignal(controls.signal).then(() => undefined),
    ]);
    if (loader === undefined) {
      void loaderPromise.catch(() => undefined);
      last = {
        status: "cancelled",
        hadSideEffects: false,
        quarantined: last.quarantined,
      };
      break;
    }
    if (controls.isAborted()) {
      last = { status: "cancelled", hadSideEffects: false, quarantined: last.quarantined };
      break;
    }

    const execution = new TaskExecution(
      task,
      carriedSteers.length === 0
        ? controls
        : {
            ...controls,
            consumeSteers: () => [
              ...carriedSteers,
              ...(controls.consumeSteers?.() ?? []),
            ],
          },
      loader,
    );
    onExecution?.(execution);
    const usageBeforeAttempt = usage;
    const recorded = await execution.result();
    last = recorded;
    usage = addUsage(usage, last.usage);
    mergeAttribution(recorded);

    // Worker truth is independent of caller settlement: every attempt's
    // real settlement drops its live handle, and when result() reported a
    // provisional outcome the true outcome still arrives — for visibility
    // and, once quiescence is confirmed, reservation release.
    void execution
      .settled()
      .then((real) => {
        // Worker truth may carry paths the provisional snapshot had not
        // yet observed — merge before the late outcome replaces it.
        mergeAttribution(real);
        onWorkerSettled?.(
          execution,
          real === recorded
            ? undefined
            : {
                index: task.index,
                id: task.id,
                status:
                  controls.isAborted() && real.status !== "ok"
                    ? "cancelled"
                    : real.status,
                output: real.output,
                error: real.error,
                retries,
                usage: addUsage(usageBeforeAttempt, real.usage),
                quarantined: real.quarantined || undefined,
                sessionFile: real.sessionFile,
                transcriptStart: real.transcriptStart,
                ...(allFiles.size > 0
                  ? { attributedFiles: [...allFiles] }
                  : {}),
                ...(anyUncertain
                  ? { uncertainFiles: true, shellObserved: true }
                  : {}),
                // The late outcome is the verifier's real verdict — the
                // provisional snapshot's may have pre-dated its last line.
                ...(() => {
                  const verdict = verdictOf(task, real.output);
                  return verdict !== undefined ? { verdict } : {};
                })(),
              },
        );
      })
      .catch((error: unknown) => {
        log(controls.env.diagnostics, `late settlement of task ${task.id} failed to propagate`, error);
      });

    if (last.status !== "failed" || controls.isAborted()) break;
    if (retries + 1 >= MAX_TASK_ATTEMPTS || !canRetryWholeTask(task, last)) break;
    retries += 1;
    // The failed attempt's full injected set replaces the carried list —
    // it already contains everything the earlier attempts re-supplied.
    carriedSteers = execution.retainedSteers();
    controls.env.diagnostics.log("info", "retrying task after transient failure", { taskId: task.id, attempt: retries + 1, maxAttempts: MAX_TASK_ATTEMPTS, category: failureCategory(last.error) }, last.diagnosticCause ?? last.error);
    try {
      await sleep(RETRY_DELAY_MS, controls.signal);
    } catch {
      last = {
        status: "cancelled",
        output: last.output,
        usage: last.usage,
        hadSideEffects: last.hadSideEffects,
        quarantined: last.quarantined,
      };
      break;
    }
  }

  return {
    index: task.index,
    id: task.id,
    status:
      controls.isAborted() && last.status !== "ok" ? "cancelled" : last.status,
    output: last.output,
    error: last.error,
    retries,
    usage,
    quarantined: last.quarantined || undefined,
    sessionFile: last.sessionFile,
    transcriptStart: last.transcriptStart,
    ...(allFiles.size > 0 ? { attributedFiles: [...allFiles] } : {}),
    ...(anyUncertain ? { uncertainFiles: true, shellObserved: true } : {}),
    // A verifier task's outcome carries its parsed verdict — reporting
    // evidence beside attribution; it never gates anything (#49).
    ...(() => {
      const verdict = verdictOf(task, last.output);
      return verdict !== undefined ? { verdict } : {};
    })(),
  };
}

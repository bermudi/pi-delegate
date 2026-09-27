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
  type HostEnvironment,
} from "./host.ts";
import {
  isClearlyTransientError,
  isModelAttributableError,
  MAX_TASK_ATTEMPTS,
  MODEL_SWAP_HINT,
  RETRY_DELAY_MS,
  limitHint,
  sleep,
} from "./retry.ts";
import { persistSessionHeader, type PooledSession, type SessionPool } from "./sessions.ts";
import {
  Deferred,
  type ExecutionHandle,
  type ResolvedTask,
  type TaskOutcome,
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
  /** Whether this run's work has been cancelled or its deadline fired. */
  readonly isAborted: () => boolean;
  /** Combined cancellation signal (ticket cancel, parent abort, deadline). */
  readonly signal: AbortSignal;
  /** Inactivity watchdog budget in ms; 0 disables it. */
  readonly stallTimeoutMs: number;
  /** Optional per-event sink (visibility/activity); never errors into the run. */
  readonly observe?: (event: AgentSessionEvent) => void;
  /**
   * Claim the child session's transcript file for exclusive ownership
   * (transcript exclusivity); undefined when the run carries no grant
   * context. Called once the concrete file is known — before the first
   * turn writes into it.
   */
  readonly holdTranscript?: (path: string) => void;
}

export interface AttemptResult {
  readonly status: "ok" | "failed" | "cancelled";
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
}

function abortedSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function log(context: string, error: unknown): void {
  console.error(
    `[delegate] ${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
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
 * Cancellation-cause precedence: a parent/ticket abort outranks a deadline,
 * which outranks a stall. Lower rank wins when causes race.
 */
const ABORT_PRECEDENCE: Record<string, number> = {
  cancelled: 0,
  deadline: 1,
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
  session: AgentSession | undefined,
  flushHeader: boolean,
): string | undefined {
  if (session === undefined) return undefined;
  const file = session.sessionFile;
  if (typeof file !== "string") return undefined;
  if (flushHeader) persistSessionHeader(session.sessionManager);
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
 *   deadline outcome as soon as cancellation is requested — a provider or
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
  /** The pooled session this run checked out, when the task reused one. */
  private poolEntry: PooledSession | undefined;
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
      return outcome;
    });
  }

  result(): Promise<AttemptResult> {
    return Promise.race([
      this.done,
      this.abortRequested.promise.then(() => this.provisionalOutcome()),
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
      log(`abort of task ${this.task.id} failed; session left undisposed`, error);
    }
  }

  /**
   * Watchdog causes (deadline, stall) settle as failures with their own
   * wording; operator and parent aborts settle as plain cancellations.
   */
  private watchdogError(): string | undefined {
    if (this.abortReason === "deadline") {
      return `deadline exceeded after ${this.task.deadlineMs}ms`;
    }
    if (this.abortReason === "stall") {
      return `stalled: no session activity for ${this.controls.stallTimeoutMs}ms; task aborted`;
    }
    return undefined;
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
        sessionFile: reportableTranscript(session, false),
      };
    }
    return {
      status: "cancelled",
      output: partial.text || undefined,
      hadSideEffects: this.hadSideEffects,
      quarantined: true,
      sessionFile: reportableTranscript(session, false),
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
      log(`dispose of task ${this.task.id} failed`, error);
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
          this.abortReason === "deadline" || this.abortReason === "stall"
            ? this.abortReason
            : undefined,
        quarantined: this.quarantined,
      },
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
      this.poolEntry = this.controls.sessions.checkout(this.task);
      session =
        this.poolEntry?.session ??
        (await createSubagentSession(
          this.task, this.controls.env, loader,
          (question, signal) => this.controls.sessions.askQuestion(session!, question, signal),
        ));
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
            log(`abort during setup of task ${this.task.id} failed`, error);
          }
        }
        const watchdog = this.watchdogError();
        if (watchdog !== undefined) {
          return {
            status: "failed",
            error: watchdog,
            hadSideEffects: false,
            quarantined: this.quarantined,
            sessionFile: reportableTranscript(session, true),
          };
        }
        return {
          status: "cancelled",
          hadSideEffects: false,
          quarantined: this.quarantined,
          sessionFile: reportableTranscript(session, true),
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
          console.error(
            `[delegate] activity observer failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (event.type === "agent_start") {
          if (this.abortReason !== undefined || this.controls.isAborted()) {
            child.agent.abort();
          }
          return;
        }
        if (
          event.type === "tool_execution_end" &&
          SIDE_EFFECT_TOOLS.has(event.toolName)
        ) {
          this.hadSideEffects = true;
        }
      });
      // Armed until the run ends — including waitForIdle, where a wedged
      // session produces no events and the watchdog is the rescue.
      this.noteActivity();

      usageBefore = usageOf(session);
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
          sessionFile: reportableTranscript(session, true),
        };
      }
      if (this.abortReason || this.controls.isAborted() || stopReason === "aborted") {
        return {
          status: "cancelled",
          output: text || undefined,
          usage,
          hadSideEffects: this.hadSideEffects,
          quarantined: this.quarantined,
          sessionFile: reportableTranscript(session, true),
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
          sessionFile: reportableTranscript(session, true),
        };
      }
      return {
        status: "ok",
        output: text,
        usage,
        hadSideEffects: this.hadSideEffects,
        quarantined: this.quarantined,
        sessionFile: reportableTranscript(session, false),
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
          sessionFile: reportableTranscript(session, true),
        };
      }
      if (this.abortReason || this.controls.isAborted()) {
        return {
          status: "cancelled",
          usage,
          hadSideEffects: this.hadSideEffects,
          quarantined: this.quarantined,
          sessionFile: reportableTranscript(session, true),
        };
      }
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        usage,
        hadSideEffects: this.hadSideEffects,
        quarantined: this.quarantined,
        sessionFile: reportableTranscript(session, true),
      };
    } finally {
      this.controls.signal.removeEventListener("abort", onAbort);
      if (session) this.controls.sessions.bindQuestion(session, undefined);
      this.clearStall();
      this.finished = true;
    }
  }
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
 * side-effecting, and quarantined failures return immediately. The deadline
 * budget is one wall-clock window measured from when the task leaves the
 * queue — all attempts and the backoff between them share it.
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
  let last: AttemptResult = {
    status: "failed",
    error: "no attempt ran",
    hadSideEffects: false,
    quarantined: false,
  };
  // The wall-clock budget starts when the task leaves the queue (SPEC
  // "deadlineMs ... beginning after queueing"): runTask is entered only
  // after pause gates, dependency gates, predecessor waits, and both
  // concurrency semaphores, so the first Date.now() here is the queue-exit
  // instant. It must be captured synchronously on entry — an await before
  // it (e.g. resource-loader reload) would let slow setup eat the budget
  // and report success past the deadline.
  const enteredAt = Date.now();
  const deadlineAt =
    task.deadlineMs !== undefined ? enteredAt + task.deadlineMs : undefined;
  const deadlineExpired = (): AttemptResult => ({
    status: "failed",
    output: last.output,
    error: `deadline exceeded after ${task.deadlineMs}ms`,
    usage: last.usage,
    hadSideEffects: last.hadSideEffects,
    quarantined: last.quarantined,
    sessionFile: last.sessionFile,
  });

  for (;;) {
    if (controls.isAborted()) {
      last = { status: "cancelled", hadSideEffects: false, quarantined: last.quarantined };
      break;
    }
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      last = deadlineExpired();
      break;
    }
    const key = JSON.stringify([task.cwd, task.systemPrompt ?? null, task.appendSystemPrompt]);
    let loaderPromise = loaders.get(key);
    if (!loaderPromise) {
      const loader = createSubagentResourceLoader(task, controls.env);
      loaderPromise = loader.reload().then(() => loader);
      loaders.set(key, loaderPromise);
    }
    // A stalled resource loader must not hold a task past its explicit
    // deadline. Race the remaining wall budget as well as parent abort;
    // no child session exists yet, so nothing needs quiescence confirmation.
    let loaderDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const loaderDeadline = deadlineAt === undefined
      ? undefined
      : new Promise<"deadline">((resolve) => {
          loaderDeadlineTimer = setTimeout(
            () => resolve("deadline"),
            Math.max(0, deadlineAt - Date.now()),
          );
        });
    let loaded: DefaultResourceLoader | "deadline" | undefined;
    try {
      loaded = await Promise.race([
        loaderPromise,
        abortedSignal(controls.signal).then(() => undefined),
        ...(loaderDeadline ? [loaderDeadline] : []),
      ]);
    } finally {
      if (loaderDeadlineTimer !== undefined) clearTimeout(loaderDeadlineTimer);
    }
    if (loaded === "deadline") {
      // The losing reload may fail later; it no longer has a caller.
      void loaderPromise.catch(() => undefined);
      last = controls.isAborted()
        ? { status: "cancelled", hadSideEffects: false, quarantined: last.quarantined }
        : deadlineExpired();
      break;
    }
    const loader = loaded;
    if (loader === undefined) {
      void loaderPromise.catch(() => undefined);
      last = {
        status: "cancelled",
        hadSideEffects: false,
        quarantined: last.quarantined,
      };
      break;
    }
    // Resource loading is part of the post-queue wall-clock budget. The
    // timer below only protects a live TaskExecution; if loading consumed
    // the whole budget, do not create (much less prompt) a late worker.
    if (controls.isAborted()) {
      last = { status: "cancelled", hadSideEffects: false, quarantined: last.quarantined };
      break;
    }
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      last = deadlineExpired();
      break;
    }

    const execution = new TaskExecution(task, controls, loader);
    onExecution?.(execution);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineAt !== undefined) {
      timer = setTimeout(
        () => void execution.abort("deadline"),
        Math.max(0, deadlineAt - Date.now()),
      );
    }
    const usageBeforeAttempt = usage;
    let recorded: AttemptResult;
    try {
      recorded = await execution.result();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    last = recorded;
    usage = addUsage(usage, last.usage);

    // Worker truth is independent of caller settlement: every attempt's
    // real settlement drops its live handle, and when result() reported a
    // provisional outcome the true outcome still arrives — for visibility
    // and, once quiescence is confirmed, reservation release.
    void execution
      .settled()
      .then((real) => {
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
              },
        );
      })
      .catch((error: unknown) => {
        log(`late settlement of task ${task.id} failed to propagate`, error);
      });

    if (last.status !== "failed" || controls.isAborted()) break;
    if (retries + 1 >= MAX_TASK_ATTEMPTS || !canRetryWholeTask(task, last)) break;
    retries += 1;
    console.error(
      `[delegate] retrying task ${task.id} after transient failure (attempt ${retries + 1} of ${MAX_TASK_ATTEMPTS}): ${last.error ?? "unknown error"}`,
    );
    try {
      // The backoff shares the deadline window: never sleep past it.
      const remaining =
        deadlineAt !== undefined ? deadlineAt - Date.now() : RETRY_DELAY_MS;
      await sleep(Math.min(RETRY_DELAY_MS, Math.max(0, remaining)), controls.signal);
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
  };
}

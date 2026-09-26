import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { integrationLines } from "./format.ts";
import { TicketJournal } from "./ticket-journal.ts";
import { renderOutputForLLM, renderOutputForPoll } from "./spill.ts";
import type {
  ExecutionHandle,
  OutputBounds,
  TaskOutcome,
  Ticket,
  TicketStatus,
  WorkerQuestion,
} from "./types.ts";
import { Deferred } from "./types.ts";
import type { ResolvedTask } from "./types.ts";

/** The store-private, writable form of the caller-visible record. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Live machinery for one ticket: cancellation, settlement gates, waiters,
 * and in-flight executions. Owned by the store and never exposed — callers
 * reach it only through the store's methods, so the caller-visible `Ticket`
 * stays free of it.
 */
interface TicketRuntime {
  questionSeq: number;
  readonly pendingQuestions: Map<string, { taskIndex: number; resolve: (answer: string) => void; reject: (error: Error) => void }>;
  readonly answeredQuestions: Map<string, { taskIndex: number; answer: string }>;
  /** Aborts in-flight executions when force-cancelled. */
  readonly cancellation: AbortController;
  /**
   * When true, recorded outcomes never settle the ticket — an explicit
   * `releaseSettlement` is required after post-run reconciliation lands, so
   * the terminal view includes integration results.
   */
  holdSettlement: boolean;
  pauseGate: Deferred | undefined;
  /** Resolves when the ticket reaches a terminal status. */
  readonly settledGate: Deferred;
  /**
   * Resolves when every task has a caller-visible outcome. Quarantined
   * workers may still be winding down — this is caller settlement, not
   * confirmed quiescence.
   */
  readonly finishedGate: Deferred;
  readonly waiters: Set<() => void>;
  /** Live executions by task index, for cooperative abort. */
  readonly executions: Map<number, ExecutionHandle>;
  /**
   * Memoized terminal view, populated by `view` once the ticket's record
   * can no longer change — every task has a caller-visible outcome and no
   * execution remains live. Settled rendering can write spill files; the
   * freeze keeps repeated polls pointing at one stable path instead of
   * writing a fresh file per render.
   */
  settledView: string | undefined;
  /**
   * Spill-rendered output per recorded outcome — at most one spill file
   * per outcome. A terminal ticket can be re-rendered before `settledView`
   * freezes (executions may stay registered for the session's life under
   * quarantine); this keeps every render pointing at one stable path.
   * A replaced outcome (late worker truth) is a new object and gets its
   * own render.
   */
  readonly renderedOutputs: WeakMap<TaskOutcome, string>;
}

interface TicketEntry {
  readonly record: Writable<Ticket>;
  readonly rt: TicketRuntime;
}

function isTerminal(status: TicketStatus): boolean {
  return status !== "running";
}

function statusWord(ticket: Ticket): string {
  return ticket.status === "running" && ticket.paused ? "paused" : ticket.status;
}

function completedCount(ticket: Ticket): number {
  return ticket.outcomes.filter((outcome) => outcome !== undefined).length;
}

function recoveryWarning(ticket: Ticket): string | undefined {
  if (ticket.status === "interrupted") {
    return "This run stopped without a final record. Unfinished tasks may have changed files or run commands; nothing will resume automatically.";
  }
  if (ticket.recovered && completedCount(ticket) < ticket.totalTasks) {
    return "Some task outcomes are missing from this saved result; their effects are unknown. Workers may have changed files or run commands. Inspect the workspace before new writes.";
  }
  if (ticket.recovered && ticket.status === "cancelled" && ticket.outcomes.some((outcome) => outcome?.quarantined)) {
    return "A cancelled worker's termination was unconfirmed; no live reservation was restored. It may still have changed files or run commands. Inspect the workspace before new writes.";
  }
  return undefined;
}

function taskSection(
  ticket: Ticket,
  outcome: TaskOutcome,
  whole: boolean,
  renderedOutputs?: WeakMap<TaskOutcome, string>,
): string {
  const head = `### Task ${outcome.id} — ${outcome.status === "ok" ? "completed" : outcome.status}`;
  const quarantined = outcome.quarantined
    ? ticket.recovered
      ? "\n(worker termination was unconfirmed; no live reservation was restored — inspect the workspace before new writes)"
      : "\n(worker termination unconfirmed — its write scope stays reserved)"
    : "";
  const integration = outcome.integration
    ? `\n${integrationLines(outcome.integration).join("\n")}`
    : "";
  // The ticket's lifecycle decides the renderer, not the outcome's: while
  // the ticket runs, even a finished task's output is bounded to a tail —
  // a poll never writes a spill file. On a terminal ticket every recorded
  // outcome renders through the spill boundary under the bounds snapshotted
  // at creation, memoized per outcome so re-renders before the view freezes
  // keep one stable spill path. `outcome.output` itself stays complete
  // either way. A `whole` view (the human expanded render) skips bounding
  // entirely.
  const bounds = ticket.outputBounds;
  const label = ticket.tasks[outcome.index]?.agent ?? outcome.id;
  const render = whole
    ? (output: string) => output
    : isTerminal(ticket.status)
      ? (output: string) => {
          const cached = renderedOutputs?.get(outcome);
          if (cached !== undefined) return cached;
          const rendered = renderOutputForLLM(output, label, bounds);
          renderedOutputs?.set(outcome, rendered);
          return rendered;
        }
      : (output: string) => renderOutputForPoll(output, bounds);
  if (outcome.status === "ok") {
    return `${head}\n${render(outcome.output ?? "")}${quarantined}${integration}`;
  }
  const detail = outcome.error ?? "no output";
  const partial = outcome.output ? `\n${render(outcome.output)}` : "";
  return `${head}\n${detail}${partial}${quarantined}${integration}`;
}

/** Poll/wait view of one ticket. Poll is observational — never mutates. */
function ticketView(
  ticket: Ticket,
  whole = false,
  renderedOutputs?: WeakMap<TaskOutcome, string>,
): string {
  const warning = recoveryWarning(ticket);
  const lines = [
    `Ticket "${ticket.id}": ${statusWord(ticket)} — ${completedCount(ticket)}/${ticket.totalTasks} tasks finished.`,
    ...(warning ? [warning] : []),
    ...ticket.notices,
    ...ticket.questions.map((q) =>
      `Waiting for parent answer: task ${q.taskId}, question ${q.id}: ${q.question}\nReply with delegate_ticket({ action: "answer", ticket: "${ticket.id}", taskId: "${q.taskId}", questionId: "${q.id}", answer: "..." }).`),
  ];
  for (const outcome of ticket.outcomes) {
    if (outcome)
      lines.push("", taskSection(ticket, outcome, whole, renderedOutputs));
  }
  return lines.join("\n");
}

function rosterView(tickets: readonly Ticket[]): string {
  if (tickets.length === 0) {
    return "No tickets. Dispatch tasks with delegate({ tasks: [...], async: true }) to create one.";
  }
  const lines = tickets.flatMap((ticket) => {
    const warning = ticket.recovered ? recoveryWarning(ticket) : undefined;
    return [
      `- "${ticket.id}" ${statusWord(ticket)} — ${completedCount(ticket)}/${ticket.totalTasks} tasks finished`,
      ...(warning ? [`  ${warning}`] : []),
      ...ticket.questions.map((q) => `  waiting for answer: ${q.taskId}/${q.id}: ${q.question}`),
    ];
  });
  return `Tickets:\n${lines.join("\n")}`;
}

/**
 * The ticket registry and lifecycle state machine, and the sole writer of
 * both ticket halves: the caller-visible record (returned as `Ticket`) and
 * the store-private runtime half reached through the methods below. Ticket
 * status moves running → terminal exactly once; pause is orthogonal. Worker
 * completion arriving after a terminal transition is recorded for visibility
 * but can never change the status.
 */
export class TicketStore {
  private readonly tickets = new Map<string, TicketEntry>();
  private journal: TicketJournal | undefined;

  /**
   * Optional lifecycle observer (extension-owned): fired after every
   * caller-visible mutation so visibility signals can resync. The store
   * never reads it beyond the call.
   */
  constructor(
    private readonly onChange?: () => void,
    private readonly onQuestion?: (ticket: Ticket, question: WorkerQuestion) => void,
  ) {}

  private changed(): void {
    this.onChange?.();
  }

  /** Load once per extension lifetime. Never adopt another agent directory. */
  connect(agentDir: string): void {
    if (this.journal !== undefined) {
      if (this.journal.dir !== join(agentDir, "delegate-tickets")) {
        throw new Error("Delegate agent directory changed during this session; ticket recovery requires a single agent directory.");
      }
      return;
    }
    const journal = new TicketJournal(agentDir);
    const saved = journal.load();
    for (const item of saved) {
      const recovered: Ticket = {
        id: item.id,
        status: item.status === "running" ? "interrupted" : item.status,
        paused: false,
        tasks: item.tasks,
        totalTasks: item.tasks.length,
        outcomes: item.outcomes.map((outcome) => outcome ?? undefined),
        questions: [],
        outputBounds: item.outputBounds,
        createdAt: item.createdAt,
        recovered: true,
        notices: item.notices,
      };
      this.tickets.set(item.id, { record: recovered, rt: this.runtime(false) });
    }
    this.journal = journal;
    if (saved.length > 0) {
      console.info(`[delegate] recovered ${saved.length} ticket record(s) from ${journal.dir}; unfinished work is interrupted, not restarted`);
      this.changed();
    }
  }

  private runtime(holdSettlement: boolean): TicketRuntime {
    return {
      cancellation: new AbortController(),
      questionSeq: 0,
      pendingQuestions: new Map(),
      answeredQuestions: new Map(),
      holdSettlement,
      pauseGate: undefined,
      settledGate: new Deferred(),
      finishedGate: new Deferred(),
      waiters: new Set(),
      executions: new Map(),
      settledView: undefined,
      renderedOutputs: new WeakMap(),
    };
  }

  private save(record: Ticket): void {
    try {
      this.journal?.save(record);
    } catch (error) {
      console.error(
        `[delegate] ticket ${record.id} recovery save failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const writable = record as Writable<Ticket>;
      const note = "Ticket recovery save failed; after a restart the saved status or results may be stale. Check Delegate logs.";
      if (!writable.notices.includes(note)) writable.notices = [...writable.notices, note];
    }
  }

  private newTicketId(): string {
    return `t-${randomUUID()}`;
  }

  /** Live machinery for `ticket`; entries share the record's lifetime. */
  private entry(ticket: Ticket): TicketEntry {
    const entry = this.tickets.get(ticket.id);
    if (entry === undefined) {
      throw new Error(`internal: unknown ticket '${ticket.id}'`);
    }
    return entry;
  }

  create(
    tasks: readonly ResolvedTask[],
    options: {
      readonly holdSettlement: boolean;
      readonly outputBounds: OutputBounds;
    },
  ): Ticket {
    const record: Writable<Ticket> = {
      id: this.newTicketId(),
      status: "running",
      paused: false,
      totalTasks: tasks.length,
      outcomes: new Array<TaskOutcome | undefined>(tasks.length).fill(undefined),
      tasks,
      questions: [],
      outputBounds: options.outputBounds,
      createdAt: Date.now(),
      notices: [],
    };
    // Isolated batches settle only after reconciliation has annotated the
    // outcomes — a terminal ticket must already show applied/conflict state.
    // The ticket must be registered before the creation write so a
    // storage-initialization or save failure can bind the operationId's
    // duplicate-protection fingerprint to the original failure instead of
    // forgetting it (a retry after fixing storage must return the
    // failure, not start new work). Registration-before-write is safe:
    // runDispatchPipeline removes the ticket when preparation fails, so
    // a failed write never leaves a phantom live ticket behind.
    if (!this.journal) throw new Error("Ticket storage not initialized; async dispatch cannot start.");
    const rt = this.runtime(options.holdSettlement);
    this.tickets.set(record.id, { record, rt });
    try {
      // Creation must be durable before a worker can start.
      this.journal.save(record);
    } catch (error) {
      this.tickets.delete(record.id);
      throw error;
    }
    this.changed();
    return record;
  }

  get(id: string): Ticket | undefined {
    return this.tickets.get(id)?.record;
  }

  /**
   * The poll/wait/delivery view. Running tickets bound every recorded
   * outcome to a tail-only projection — a poll never writes a spill file;
   * terminal tickets render settled output through the spill boundary under
   * the bounds snapshotted at creation, memoized per recorded outcome so a
   * terminal-but-unfrozen ticket (executions still draining, possibly
   * forever under quarantine) re-renders without writing a new file per
   * poll. A terminal view is also memoized whole once it can no longer
   * change — the finished gate has resolved and no execution remains
   * live — so repeated polls of a settled ticket keep pointing at the
   * same spill file rather than writing a new one per render.
   */
  view(ticket: Ticket): string {
    const { record, rt } = this.entry(ticket);
    if (
      isTerminal(record.status) &&
      rt.finishedGate.resolved &&
      rt.executions.size === 0
    ) {
      rt.settledView ??= ticketView(record, false, rt.renderedOutputs);
      return rt.settledView;
    }
    return ticketView(record, false, rt.renderedOutputs);
  }

  /**
   * The expanded human view of the ticket: the `view` document with every
   * recorded output rendered whole — bounding is an LLM-context economy,
   * not a display one. Unlike `view` it is never memoized and never
   * touches the filesystem: no spill files, no frozen terminal render.
   */
  fullView(ticket: Ticket): string {
    return ticketView(this.entry(ticket).record, true);
  }

  /** Drop a ticket that never started (e.g. admission failed after create). */
  remove(id: string): void {
    this.tickets.delete(id);
    try { this.journal?.remove(id); }
    catch (error) { console.error(`[delegate] removing unstarted ticket ${id} failed`, error); }
    this.changed();
  }

  list(): Ticket[] {
    return [...this.tickets.values()].map((entry) => entry.record);
  }

  /** Record a task outcome. Never changes a terminal ticket's status. */
  recordOutcome(ticket: Ticket, outcome: TaskOutcome): void {
    // Sole-writer cast: the exposed type is readonly, but it is the same
    // mutable array instance callers see — the store owns the one legal
    // write path (no freeze, no copy-on-write).
    const outcomes = this.entry(ticket).record
      .outcomes as (TaskOutcome | undefined)[];
    outcomes[outcome.index] = outcome;
    this.save(this.entry(ticket).record);
    this.changed();
    this.maybeSettle(ticket);
  }

  /** An unanswered question owns the worker and its write reservation. */
  ask(ticket: Ticket, taskIndex: number, questionText: string, signal: AbortSignal): Promise<string> {
    const { record, rt } = this.entry(ticket);
    if (record.status !== "running" || signal.aborted) throw new Error("Question cancelled; the worker is no longer running.");
    if (!questionText.trim()) throw new Error("ask_parent requires a nonempty question.");
    if (record.questions.some((q) => q.taskId === record.tasks[taskIndex]?.id)) {
      throw new Error(`Task ${record.tasks[taskIndex]?.id} already has an unanswered question.`);
    }
    const question: WorkerQuestion = {
      id: `q-${++rt.questionSeq}`,
      taskId: record.tasks[taskIndex]!.id,
      question: questionText,
    };
    const answer = new Promise<string>((resolve, reject) => {
      rt.pendingQuestions.set(question.id, { taskIndex, resolve, reject });
    });
    record.questions = [...record.questions, question];
    console.info(`[delegate] ticket ${ticket.id} task ${question.taskId} waiting for answer ${question.id}`);
    this.changed();
    for (const notify of [...rt.waiters]) notify();
    try {
      this.onQuestion?.(ticket, question);
    } catch (error) {
      console.error(`[delegate] notifying parent of question ${ticket.id}/${question.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const abort = () => rt.pendingQuestions.get(question.id)?.reject(new Error(`Question ${question.id} cancelled.`));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || record.status !== "running") abort();
    return answer.finally(() => {
      signal.removeEventListener("abort", abort);
      rt.pendingQuestions.delete(question.id);
      record.questions = record.questions.filter((q) => q.id !== question.id);
      this.changed();
    });
  }

  answer(ticket: Ticket, taskId: string, questionId: string, answer: string): string {
    const { record, rt } = this.entry(ticket);
    if (record.status !== "running") throw new Error(`Ticket '${ticket.id}' is ${record.status}; answer ${questionId} is too late.`);
    if (!answer.trim()) throw new Error("An answer must be nonempty.");
    const index = record.tasks.findIndex((task) => task.id === taskId);
    const pending = rt.pendingQuestions.get(questionId);
    const previous = rt.answeredQuestions.get(questionId);
    if (index < 0 || (pending?.taskIndex ?? previous?.taskIndex) !== index) {
      throw new Error(`No question '${questionId}' for task '${taskId}' on ticket '${ticket.id}'.`);
    }
    if (previous !== undefined) {
      if (previous.answer !== answer) throw new Error(`Question '${questionId}' was already answered differently.`);
      return `Answer ${questionId} already recorded for task ${taskId}.`;
    }
    rt.answeredQuestions.set(questionId, { taskIndex: index, answer });
    console.info(`[delegate] ticket ${ticket.id} task ${taskId} answered question ${questionId}`);
    pending!.resolve(answer);
    return `Answer ${questionId} recorded for task ${taskId}; worker will resume when capacity is available.`;
  }

  /**
   * Replace the dispatch notices (e.g. same-call shared writers
   * serializing). The sole write path for the ticket's notices.
   */
  setNotices(ticket: Ticket, notices: readonly string[]): void {
    const record = this.entry(ticket).record;
    record.notices = [...notices];
    this.save(record);
  }

  /**
   * Record the session-tree origin at dispatch: the leaf id (null for the
   * root) and the navigation epoch, latched in execute's synchronous prefix
   * (before any await) so a mid-preparation navigation cannot restamp it
   * and wake the wrong branch on settlement. Delivery diagnostics can be
   * reconstructed from the ticket alone. The sole write path for the origin
   * fields.
   */
  recordOrigin(
    ticket: Ticket,
    origin: { readonly leafId: string | null; readonly epoch: number },
  ): void {
    const record = this.entry(ticket).record;
    record.originLeafId = origin.leafId;
    record.originEpoch = origin.epoch;
  }

  private maybeSettle(ticket: Ticket): void {
    const { record, rt } = this.entry(ticket);
    if (record.status !== "running" || rt.holdSettlement) return;
    if (!record.outcomes.every((recorded) => recorded !== undefined)) return;
    this.settle(
      ticket,
      record.outcomes.every((o) => o!.status === "ok")
        ? "completed"
        : record.outcomes.every((o) => o!.status === "cancelled")
          ? "cancelled"
          : record.outcomes.some((o) => o!.status === "ok")
            ? "partial"
            : "failed",
    );
  }

  /**
   * Lift the settlement hold after post-run reconciliation: the ticket can
   * now reach its terminal status with the finalized outcomes on record.
   * A ticket already settled by cancellation is unaffected.
   */
  releaseSettlement(ticket: Ticket): void {
    this.entry(ticket).rt.holdSettlement = false;
    this.maybeSettle(ticket);
  }

  /** The single owner of the terminal transition; idempotent. */
  settle(ticket: Ticket, status: TicketStatus): boolean {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status) || status === "running") return false;
    record.status = status;
    record.paused = false;
    this.save(record);
    for (const [id, question] of rt.pendingQuestions) {
      console.info(`[delegate] ticket ${ticket.id} invalidated question ${id}: ${status}`);
      question.reject(new Error(`Question ${id} cancelled: ticket ${status}.`));
    }
    this.changed();
    rt.pauseGate?.resolve();
    rt.settledGate.resolve();
    for (const notify of [...rt.waiters]) notify();
    return true;
  }

  pause(ticket: Ticket): string {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status)) {
      throw new Error(
        `Ticket '${ticket.id}' is already ${record.status}; it cannot be paused.`,
      );
    }
    if (!record.paused) {
      record.paused = true;
      rt.pauseGate = new Deferred();
      this.changed();
    }
    return `Ticket "${ticket.id}" paused. Queued tasks and upcoming model turns are held; in-flight work continues.`;
  }

  resume(ticket: Ticket): string {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status)) {
      throw new Error(
        `Ticket '${ticket.id}' is already ${record.status}; it cannot be resumed.`,
      );
    }
    if (!record.paused) {
      return `Ticket "${ticket.id}" is already running.`;
    }
    record.paused = false;
    rt.pauseGate?.resolve();
    rt.pauseGate = undefined;
    this.changed();
    return `Ticket "${ticket.id}" resumed.`;
  }

  /**
   * `force: false` previews. Forced cancellation is terminal immediately —
   * the ticket is authoritative — while in-flight executions are aborted
   * cooperatively in the background. Their late outcomes stay visible.
   */
  cancel(ticket: Ticket, force: boolean): string {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status)) {
      return `Ticket "${ticket.id}" is already ${record.status}.`;
    }
    if (!force) {
      const inFlight = rt.executions.size;
      return (
        `Ticket "${ticket.id}" is ${statusWord(record)} with ${inFlight} task(s) in flight. ` +
        `Cancellation is cooperative: in-flight work is asked to stop and queued tasks are dropped; ` +
        `completed writes and commands are not rolled back. Re-run with force: true to cancel.`
      );
    }
    rt.cancellation.abort();
    this.settle(ticket, "cancelled");
    for (const handle of [...rt.executions.values()]) {
      void handle.abort("cancelled").catch((error) => {
        console.error(
          `[delegate] aborting task on ticket ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return (
      `Ticket "${ticket.id}" cancelled. In-flight tasks were asked to stop and queued tasks were dropped; ` +
      `work already completed is retained on the ticket.`
    );
  }

  /**
   * Wait for settlement. A timeout or caller abort detaches only this
   * waiter — the ticket and its work are untouched. Timeout and abort are
   * distinct: only a timeout is a timeout.
   */
  async wait(
    ticket: Ticket,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ timedOut: boolean; aborted: boolean; questionPending: boolean }> {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status)) return { timedOut: false, aborted: false, questionPending: false };
    if (record.questions.length > 0) return { timedOut: false, aborted: false, questionPending: true };
    if (signal?.aborted === true) return { timedOut: false, aborted: true, questionPending: false };
    let notify!: () => void;
    const onSettled = new Promise<void>((resolve) => {
      notify = () => {
        rt.waiters.delete(notify);
        resolve();
      };
      rt.waiters.add(notify);
    });
    const races: Promise<unknown>[] = [onSettled];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      races.push(
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      );
    }
    let onAbort: (() => void) | undefined;
    if (signal !== undefined) {
      races.push(
        new Promise((resolve) => {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort);
        }),
      );
    }
    let outcome: unknown;
    try {
      outcome = await Promise.race(races);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
      rt.waiters.delete(notify);
    }
    if (isTerminal(record.status)) return { timedOut: false, aborted: false, questionPending: false };
    if (record.questions.length > 0) return { timedOut: false, aborted: false, questionPending: true };
    if (outcome === "aborted" || signal?.aborted) {
      return { timedOut: false, aborted: true, questionPending: false };
    }
    // A question can be answered by another caller between its notification
    // and this waiter resuming. Do not misreport that wake-up as a timeout.
    return { timedOut: outcome === "timeout", aborted: false, questionPending: false };
  }

  /**
   * The ticket's cancellation signal: aborts when the ticket is
   * force-cancelled (including shutdown). Long-lived — it outlives any one
   * task — so listeners attached to it must be removed by their owner once
   * the task is fully done.
   */
  cancellationSignal(ticket: Ticket): AbortSignal {
    return this.entry(ticket).rt.cancellation.signal;
  }

  /**
   * The active pause gate's promise while the ticket is paused, else
   * undefined. Schedulers park on it and race it against their own abort;
   * only the store resolves or replaces it (pause/resume/settle).
   */
  pauseGatePromise(ticket: Ticket): Promise<void> | undefined {
    return this.entry(ticket).rt.pauseGate?.promise;
  }

  /** Register a live execution for a task, for cooperative abort. */
  registerExecution(
    ticket: Ticket,
    taskIndex: number,
    handle: ExecutionHandle,
  ): void {
    this.entry(ticket).rt.executions.set(taskIndex, handle);
  }

  /**
   * Drop a task's live execution at its true settlement — but only if it is
   * still the registered handle: a replacement (retry attempt) registered in
   * the meantime stays live.
   */
  dropExecution(
    ticket: Ticket,
    taskIndex: number,
    handle: ExecutionHandle,
  ): void {
    const executions = this.entry(ticket).rt.executions;
    if (executions.get(taskIndex) === handle) {
      executions.delete(taskIndex);
    }
  }

  /**
   * Resolve the finished gate: every task has a caller-visible outcome.
   * Quarantined workers may still be winding down — this is caller
   * settlement, not confirmed quiescence. Idempotent.
   */
  finishBatch(ticket: Ticket): void {
    this.entry(ticket).rt.finishedGate.resolve();
  }

  /** Resolves when the ticket reaches a terminal status. */
  settledPromise(ticket: Ticket): Promise<void> {
    return this.entry(ticket).rt.settledGate.promise;
  }

  /** Resolves when every task has a caller-visible outcome. */
  finishedPromise(ticket: Ticket): Promise<void> {
    return this.entry(ticket).rt.finishedGate.promise;
  }
}

export interface TicketRpcResult {
  readonly text: string;
  readonly isError: boolean;
  /**
   * The resolved ticket when the call named a known one — lets the caller
   * attach its complete (unbounded) outcomes to result details.
   */
  readonly ticket?: Ticket;
}

/** delegate_ticket actions against the store. */
export async function handleTicketRpc(
  call: {
    action: "poll" | "wait" | "cancel" | "pause" | "resume" | "answer";
    ticket: string | undefined;
    force: boolean;
    timeoutMs: number | undefined;
    taskId: string | undefined;
    questionId: string | undefined;
    answer: string | undefined;
  },
  store: TicketStore,
  signal: AbortSignal | undefined,
): Promise<TicketRpcResult> {
  if (call.action === "poll" && call.ticket === undefined) {
    return { text: rosterView(store.list()), isError: false };
  }
  const ticket = call.ticket !== undefined ? store.get(call.ticket) : undefined;
  if (!ticket) {
    return {
      text: `Ticket '${call.ticket ?? ""}' not found.`,
      isError: true,
    };
  }
  if (ticket.recovered && call.action !== "poll" && call.action !== "wait") {
    return {
      text: `Ticket '${ticket.id}' is a recovered ${ticket.status} result; ${call.action} cannot restart or change it.`,
      isError: true,
      ticket,
    };
  }
  switch (call.action) {
    case "poll":
      return { text: store.view(ticket), isError: false, ticket };
    case "wait": {
      const { timedOut, aborted, questionPending } = await store.wait(
        ticket,
        call.timeoutMs,
        signal,
      );
      const view = store.view(ticket);
      const text = questionPending
        ? `${view}\n\nWait detached: answer the pending question before waiting for this ticket.`
        : timedOut
        ? `${view}\n\nWait timed out; the ticket is still ${statusWord(ticket)}.`
        : aborted
          ? `${view}\n\nWait detached; the caller aborted the wait. The ticket is still ${statusWord(ticket)}.`
          : view;
      return { text, isError: false, ticket };
    }
    case "cancel":
      return { text: store.cancel(ticket, call.force), isError: false, ticket };
    case "pause":
      return { text: store.pause(ticket), isError: false, ticket };
    case "resume":
      return { text: store.resume(ticket), isError: false, ticket };
    case "answer":
      try {
        return { text: store.answer(ticket, call.taskId!, call.questionId!, call.answer!), isError: false, ticket };
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true, ticket };
      }
  }
}

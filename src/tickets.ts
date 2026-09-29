import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  activityAge,
  aliasNote,
  descriptionLabel,
  displayPath,
  briefNote,
  budgetNote,
  fieldNotes,
  filesLine,
  verdictLine,
  integrationLines,
  overlapLines,
  recoveryLines,
  resumeMarker,
  truncateLine,
} from "./format.ts";
import type { ActivityRow, ActivityStore } from "./activity.ts";
// The receipt details types derive from the TypeBox schemas in
// details.ts — the emitted shape and the pinned contract share one
// definition (SPEC v3 "Observability"; issue #51).
import type {
  InterruptDetails,
  SteerDetails,
  SteerStatus,
} from "./details.ts";
import { TicketJournal } from "./ticket-journal.ts";
import { renderOutputForLLM, renderOutputForPoll } from "./spill.ts";
import type {
  ExecutionHandle,
  OutputBounds,
  TaskOutcome,
  TaskVerdict,
  Ticket,
  TicketStatus,
  TokenBudgetReport,
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
// `SteerStatus`, `SteerDetails`, and `InterruptDetails` — the
// machine-readable halves of the steer and interrupt receipts (SPEC v3
// "Interaction grammar — Steering" / "Interrupt") — are defined by the
// TypeBox schemas in details.ts and re-exported here for the ticket
// store's callers.
export type { InterruptDetails, SteerDetails, SteerStatus };

interface SteerRecord {
  readonly taskIndex: number;
  readonly taskId: string;
  readonly message: string;
  /** Set once the message has been handed to a run's steering queue. */
  delivered: boolean;
  receipt: { status: Exclude<SteerStatus, "duplicate">; text: string };
}

interface PendingSteer {
  readonly steerId: string;
  readonly message: string;
}

interface TicketRuntime {
  questionSeq: number;
  readonly pendingQuestions: Map<string, { taskIndex: number; resolve: (answer: string) => void; reject: (error: Error) => void }>;
  readonly answeredQuestions: Map<string, { taskIndex: number; answer: string }>;
  /**
   * steerId → the recorded attempt, for idempotent replay and conflict
   * detection (operationId discipline). Entries are written only once a
   * target task resolved — malformed calls consume no id.
   */
  readonly steers: Map<string, SteerRecord>;
  /**
   * Steer messages parked while their task has no live run, by task
   * index. Drained by the task's next attempt just before prompt();
   * voided when the task settles (the receipt flips to not-applied, so
   * a duplicate retry reports the truth rather than a stale "activated").
   */
  readonly pendingSteers: Map<number, PendingSteer[]>;
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
  // A live ticket can also settle interrupted (every task interrupted on
  // request) — that record is final and its tasks carry resume hints, so
  // the cold-recovery warning applies only to a recovered one.
  if (ticket.status === "interrupted" && ticket.recovered) {
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
  const record = ticket.tasks[outcome.index];
  const tag = record?.resumeTag;
  const aliased = record !== undefined ? aliasNote(record.aliasedFrom, record.agent) : "";
  // Field-normalization notes precede the alias note — the fold happens
  // first (SPEC v3 "Reflex meeting").
  const notes = [
    ...fieldNotes(record?.normalizedFrom),
    ...(aliased !== "" ? [aliased] : []),
  ];
  const head = `### Task ${descriptionLabel(record?.description) ?? outcome.id}${tag !== undefined ? ` ↻${tag}` : ""} — ${outcome.status === "ok" ? "completed" : outcome.status}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`;
  const quarantined = outcome.quarantined
    ? ticket.recovered
      ? "\n(worker termination was unconfirmed; no live reservation was restored — inspect the workspace before new writes; recorded output and usage are lower bounds)"
      : "\n(worker termination unconfirmed — its write scope stays reserved; recorded output and usage are lower bounds — its accounting is incomplete)"
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
  // Completion evidence rides beside the task's claim, between the status
  // head and its output (SPEC v3 "Observability"). The task's cwd
  // relativizes the display; records written before attribution have no
  // cwd, so their paths render absolute. A verifier task's parsed verdict
  // rides the same evidence block (#49).
  const evidence = [
    filesLine(
      outcome.attributedFiles,
      outcome.uncertainFiles,
      ticket.tasks[outcome.index]?.cwd,
    ),
    verdictLine(outcome),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  const files = evidence !== "" ? `\n${evidence}` : "";
  if (outcome.status === "ok") {
    return `${head}${files}\n${render(outcome.output ?? "")}${quarantined}${integration}`;
  }
  const detail = outcome.error ?? "no output";
  const session =
    outcome.sessionFile !== undefined
      ? `\n${recoveryLines(outcome.sessionFile).join("\n")}`
      : "";
  const partial = outcome.output ? `\n${render(outcome.output)}` : "";
  return `${head}${files}\n${detail}${session}${partial}${quarantined}${integration}`;
}

/**
 * Live state the running-ticket views read: the activity rows the
 * coordinator feeds and the execution registry that proves a task is
 * truly in flight (an activity row alone can lag session creation).
 */
interface LiveState {
  readonly activity: ActivityStore | undefined;
  readonly executions: ReadonlyMap<number, ExecutionHandle>;
}

/** `<agent><↻tag> #<id>` — the identity prefix shared by every task row. */
function taskLabel(ticket: Ticket, index: number): string {
  const task = ticket.tasks[index];
  const agent = task?.agent ?? "inline";
  const marker = resumeMarker(agent, task?.resumeTag);
  return `${agent}${marker} #${task?.id ?? `task-${index + 1}`}`;
}

/**
 * One-line activity label for a running task: the in-flight call when one
 * is executing, else the last completed call, else "thinking" — v1's
 * poll-row contract, fed by the activity store.
 */
function activityLabel(row: ActivityRow): string {
  const open = [...row.toolCalls].reverse().find((call) => call.inFlight);
  const last = row.toolCalls.at(-1);
  const call = open ?? last;
  if (call === undefined) return "thinking";
  const args = call.argPreview !== "" ? ` ${call.argPreview}` : "";
  const line = truncateLine(`${call.tool}${args}`, 120);
  return call.inFlight ? line : `last: ${line}`;
}

/**
 * A running ticket's per-task poll line (v1's formatInFlightTaskLine /
 * formatQueuedTaskLine): the task's current or last tool, its tool count,
 * and seconds since the last observed event. Queued tasks read
 * `waiting…`; a paused ticket's unfinished tasks read `paused`.
 */
function liveTaskLine(
  ticket: Ticket,
  index: number,
  live: LiveState | undefined,
  /** Cancel previews show task state, not claims — no evidence there. */
  withEvidence = true,
): string {
  const task = ticket.tasks[index];
  const label = taskLabel(ticket, index);
  const row =
    live?.activity !== undefined && task !== undefined
      ? live.activity.taskRow(ticket.id, task.id)
      : undefined;
  const inFlight = live?.executions.has(index) === true;
  if (row === undefined || row.status === "queued") {
    if (inFlight) return `⏳ ${label} · running`;
    return ticket.paused ? `Ⅱ ${label} · paused` : `○ ${label} · waiting…`;
  }
  if (row.status === "paused" || (ticket.paused && !inFlight && row.status !== "running")) {
    return `Ⅱ ${label} · paused between turns`;
  }
  const parts = [activityLabel(row)];
  if (row.toolCalls.length > 0) {
    parts.push(`${row.toolCalls.length} tool${row.toolCalls.length === 1 ? "" : "s"}`);
  }
  // Completion evidence so far (SPEC v3 "Observability"): the live
  // execution's observed write/edit targets, bounded to the row — settled
  // sections list every path.
  const evidence = withEvidence
    ? live?.executions.get(index)?.attribution?.()
    : undefined;
  if (evidence !== undefined && (evidence.files.length > 0 || evidence.uncertain)) {
    const shown = evidence.files
      .slice(0, 2)
      .map((file) => displayPath(file, task?.cwd));
    const more =
      evidence.files.length > shown.length ? `, +${evidence.files.length - shown.length} more` : "";
    const uncertain = evidence.uncertain
      ? `${shown.length > 0 ? " · " : ""}uncertain (bash)`
      : "";
    parts.push(`files: ${shown.join(", ")}${more}${uncertain}`);
  }
  const age = activityAge(row.lastEventAt);
  if (age !== "") parts.push(age);
  return `⏳ ${label} · ${parts.join(" · ")}`;
}

/**
 * Live counts for a running ticket's header: in-flight tasks, queued
 * tasks, and observed tool calls — a polling caller's health readout, the
 * v1 header's compact remainder.
 */
function liveCounts(ticket: Ticket, live: LiveState | undefined): string {
  const parts: string[] = [];
  let tools = 0;
  for (const task of ticket.tasks) {
    tools +=
      live?.activity?.taskRow(ticket.id, task.id)?.toolCalls.length ?? 0;
  }
  const active = live?.executions.size ?? 0;
  const unfinished = ticket.totalTasks - completedCount(ticket);
  const queued = Math.max(0, unfinished - active);
  if (active > 0) parts.push(`${active} active`);
  if (queued > 0) parts.push(`${queued} queued`);
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
}

/** Poll/wait view of one ticket. Poll is observational — never mutates. */
function ticketView(
  ticket: Ticket,
  whole = false,
  renderedOutputs?: WeakMap<TaskOutcome, string>,
  live?: LiveState,
): string {
  const warning = recoveryWarning(ticket);
  const brief = briefNote(ticket.brief);
  const budget = budgetNote(ticket.tokenBudget);
  const lines = [
    `Ticket "${ticket.id}": ${statusWord(ticket)} — ${completedCount(ticket)}/${ticket.totalTasks} tasks finished${isTerminal(ticket.status) ? "" : liveCounts(ticket, live)}.`,
    // The shared batch brief is mentioned once, at the head — never
    // inside a task section (SPEC v3 "Batch brief"). The token-budget
    // account rides the same header row (SPEC v3 "Batch token budget").
    ...(brief !== undefined ? [brief] : []),
    ...(budget !== undefined ? [budget] : []),
    ...(warning ? [warning] : []),
    ...ticket.notices,
    ...ticket.questions.map((q) =>
      `Waiting for parent answer: task ${q.taskId}, question ${q.id}: ${q.question}\nReply with delegate_ticket({ action: "answer", ticket: "${ticket.id}", taskId: "${q.taskId}", questionId: "${q.id}", answer: "..." }).`),
  ];
  for (let index = 0; index < ticket.outcomes.length; index++) {
    const outcome = ticket.outcomes[index];
    if (outcome) {
      lines.push("", taskSection(ticket, outcome, whole, renderedOutputs));
    } else if (!isTerminal(ticket.status)) {
      // A running ticket shows each unfinished task's live line — a
      // polling caller can tell a healthy worker from a spinning one.
      lines.push(liveTaskLine(ticket, index, live));
    }
  }
  // Overlap evidence (SPEC v3 "Observability — Completion evidence"):
  // one line per path two settled tasks both attributed.
  const overlaps = overlapLines(
    ticket.outcomes.filter((outcome) => outcome !== undefined),
  );
  if (overlaps.length > 0) lines.push("", ...overlaps);
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
    /** Optional live-activity sink shared with the coordinator; running
     * polls render per-task activity rows from it when present. */
    private readonly activity?: ActivityStore,
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
        tasks: item.tasks.map((task) => ({
          id: task.id,
          agent: task.agent,
          resumeTag: task.resumeTag,
          aliasedFrom: task.aliasedFrom,
          description: task.description,
          normalizedFrom: task.normalizedFrom,
          // Optional in the journal — records written before file
          // attribution have none; their paths render absolute.
          ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
        })),
        totalTasks: item.tasks.length,
        outcomes: item.outcomes.map((outcome) => outcome ?? undefined),
        questions: [],
        outputBounds: item.outputBounds,
        createdAt: item.createdAt,
        recovered: true,
        notices: item.notices,
        // Optional in the journal — pre-brief records have none.
        ...(item.brief !== undefined ? { brief: item.brief } : {}),
        // Optional in the journal — pre-budget records and budgetless
        // dispatches have none.
        ...(item.tokenBudget !== undefined
          ? { tokenBudget: item.tokenBudget }
          : {}),
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
      steers: new Map(),
      pendingSteers: new Map(),
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
      readonly brief?: string;
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
      ...(options.brief !== undefined ? { brief: options.brief } : {}),
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
    const live: LiveState = { activity: this.activity, executions: rt.executions };
    if (
      isTerminal(record.status) &&
      rt.finishedGate.resolved &&
      rt.executions.size === 0
    ) {
      rt.settledView ??= ticketView(record, false, rt.renderedOutputs, live);
      return rt.settledView;
    }
    return ticketView(record, false, rt.renderedOutputs, live);
  }

  /**
   * The expanded human view of the ticket: the `view` document with every
   * recorded output rendered whole — bounding is an LLM-context economy,
   * not a display one. Unlike `view` it is never memoized and never
   * touches the filesystem: no spill files, no frozen terminal render.
   */
  fullView(ticket: Ticket): string {
    const { record, rt } = this.entry(ticket);
    return ticketView(record, true, undefined, {
      activity: this.activity,
      executions: rt.executions,
    });
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

  /**
   * SPEC v3 "Observability — Completion evidence" machine half: per-task
   * attribution for `details.attributedFiles` — a recorded outcome's
   * final evidence, or a still-running task's observed-so-far evidence
   * from its live execution handle. Tasks with no outcome and no live
   * evidence (queued, blocked before running) have no entry.
   */
  attributionDetails(
    ticket: Ticket,
  ): readonly { taskId: string; files: readonly string[]; uncertain: boolean }[] {
    const { record, rt } = this.entry(ticket);
    const rows: { taskId: string; files: readonly string[]; uncertain: boolean }[] = [];
    for (let index = 0; index < record.tasks.length; index++) {
      const outcome = record.outcomes[index];
      if (outcome !== undefined) {
        rows.push({
          taskId: outcome.id,
          files: [...(outcome.attributedFiles ?? [])],
          uncertain: outcome.uncertainFiles === true,
        });
        continue;
      }
      const live = rt.executions.get(index)?.attribution?.();
      if (live !== undefined && (live.files.length > 0 || live.uncertain)) {
        rows.push({
          taskId: record.tasks[index]!.id,
          files: live.files,
          uncertain: live.uncertain,
        });
      }
    }
    return rows;
  }

  /**
   * SPEC v3 "Observability — Completion evidence — verifier verdict"
   * (#49): the machine half of the `verdict:` lines — one `{taskId,
   * verdict}` entry per recorded outcome that carries a parsed verdict.
   * Running or verdict-less tasks have no entry; nothing here is a gate.
   */
  verdictDetails(
    ticket: Ticket,
  ): readonly { taskId: string; verdict: TaskVerdict }[] {
    return this.entry(ticket).record.outcomes.flatMap((outcome) =>
      outcome?.verdict !== undefined
        ? [{ taskId: outcome.id, verdict: outcome.verdict }]
        : [],
    );
  }

  /**
   * The dispatch's final token-budget account (SPEC v3 "Batch token
   * budget"), recorded when its batch completes — the settled ticket's
   * views and the journal both carry it.
   */
  noteTokenBudget(ticket: Ticket, report: TokenBudgetReport): void {
    const writable = this.entry(ticket).record as Writable<Ticket>;
    writable.tokenBudget = report;
    this.save(writable);
    this.changed();
  }

  /** Record a task outcome. Never changes a terminal ticket's status. */
  recordOutcome(ticket: Ticket, outcome: TaskOutcome): void {
    const { record, rt } = this.entry(ticket);
    // Sole-writer cast: the exposed type is readonly, but it is the same
    // mutable array instance callers see — the store owns the one legal
    // write path (no freeze, no copy-on-write).
    const outcomes = record.outcomes as (TaskOutcome | undefined)[];
    const previous = outcomes[outcome.index];
    outcomes[outcome.index] = outcome;
    // A settled task can never drain a parked steer — void them so a
    // retry of that steerId reports not-applied, not a stale activated.
    this.voidPendingSteers(ticket, outcome.index);
    this.save(record);
    this.changed();
    // SPEC v3 "Waiting": a task newly settling interrupted is ticket
    // activity a parked waiter must hear — same wake a worker question
    // gets. An outcome re-recorded already interrupted (late worker
    // truth, reconciliation) is not new activity.
    if (outcome.status === "interrupted" && previous?.status !== "interrupted") {
      for (const notify of [...rt.waiters]) notify();
    }
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
   * SPEC v3 "Interaction grammar — Steering": a steer is a message with a
   * delivery receipt, idempotent on retry. The receipt names what the
   * child will observe: `steered` — queued on a live run, merged at its
   * next turn boundary; `activated` — parked until the task's next run
   * starts, which the message opens. `duplicate` replays the recorded
   * receipt verbatim (a parked steer whose task settled unflipped reports
   * `not-applied` instead — the stored record was corrected when it
   * voided). `steerId` reuse with a different message or target is a
   * conflict error naming both attempts.
   */
  steer(
    ticket: Ticket,
    callTaskId: string | undefined,
    steerId: string,
    message: string,
    derivedId = false,
  ): TicketRpcResult {
    const { record, rt } = this.entry(ticket);
    const derivedNote = derivedId
      ? " (steerId derived from this call's tool-call id)"
      : "";
    const seen = rt.steers.get(steerId);
    if (seen !== undefined) {
      // The id binds message + resolved target; an omitted taskId re-aims
      // at the original task. Anything else under the same id is a
      // different operation — conflict, naming both attempts.
      const resolvedIndex =
        callTaskId === undefined
          ? seen.taskIndex
          : record.tasks.findIndex((task) => task.id === callTaskId);
      if (seen.message !== message || resolvedIndex !== seen.taskIndex) {
        const sameTarget = resolvedIndex === seen.taskIndex;
        const attempted = sameTarget
          ? `task "${seen.taskId}"`
          : resolvedIndex >= 0
            ? `task "${record.tasks[resolvedIndex]!.id}"`
            : `task "${callTaskId ?? ""}" (not on this ticket)`;
        return {
          text:
            `Steer id "${steerId}" conflict on ticket "${ticket.id}": first used for task "${seen.taskId}"; ` +
            `this attempt targets ${attempted}` +
            `${seen.message !== message ? " and carries a different message" : ""}. ` +
            `steerIds are single-use; retry with a new steerId.`,
          isError: true,
          ticket,
        };
      }
      return {
        text: seen.receipt.text,
        isError: false,
        ticket,
        steer: {
          steerId,
          ticket: ticket.id,
          taskId: seen.taskId,
          status: "duplicate",
          replayed: seen.receipt.status,
          ...(derivedId ? { derived: true } : {}),
        },
      };
    }
    const notApplied = (
      text: string,
      taskId?: string,
      taskIndex?: number,
    ): TicketRpcResult => {
      const receiptText = `${text}${derivedNote}`;
      if (taskId !== undefined && taskIndex !== undefined) {
        rt.steers.set(steerId, {
          taskIndex,
          taskId,
          message,
          delivered: false,
          receipt: { status: "not-applied", text: receiptText },
        });
      }
      return {
        text: receiptText,
        isError: false,
        ticket,
        steer: {
          steerId,
          ticket: ticket.id,
          taskId: taskId ?? "",
          status: "not-applied",
          ...(derivedId ? { derived: true } : {}),
        },
      };
    };
    if (record.status !== "running") {
      return notApplied(
        ticket.recovered
          ? `Steer "${steerId}": not-applied — ticket "${ticket.id}" is a recovered ${record.status} result; recovery never resumes it. Poll it for the final outcome.`
          : `Steer "${steerId}": not-applied — ticket "${ticket.id}" is already ${record.status}; nothing is running. Poll it for the final result.`,
      );
    }
    let taskIndex: number;
    if (callTaskId !== undefined) {
      taskIndex = record.tasks.findIndex((task) => task.id === callTaskId);
      if (taskIndex < 0) {
        return notApplied(
          `Steer "${steerId}": not-applied — ticket "${ticket.id}" has no task "${callTaskId}". Its tasks: ${record.tasks.map((t) => `"${t.id}"`).join(", ")}.`,
        );
      }
    } else {
      const unsettled = record.tasks
        .map((_, index) => index)
        .filter((index) => record.outcomes[index] === undefined);
      if (unsettled.length === 0) {
        return notApplied(
          `Steer "${steerId}": not-applied — ticket "${ticket.id}" has no running task left; poll it for the final results.`,
        );
      }
      if (unsettled.length > 1) {
        return {
          text:
            `action "steer" needs taskId on ticket "${ticket.id}" — ${unsettled.length} tasks are still running: ` +
            `${unsettled.map((i) => `"${record.tasks[i]!.id}"`).join(", ")}.`,
          isError: true,
          ticket,
        };
      }
      taskIndex = unsettled[0]!;
    }
    const taskId = record.tasks[taskIndex]!.id;
    const outcome = record.outcomes[taskIndex];
    if (outcome !== undefined) {
      return notApplied(
        `Steer "${steerId}": not-applied — task "${taskId}" on ticket "${ticket.id}" already settled (${outcome.status}); its outcome is final. Poll the ticket for it.`,
        taskId,
        taskIndex,
      );
    }
    const pausedNote = record.paused
      ? " The ticket is paused — the message merges when work resumes."
      : "";
    // Live run → the steering queue merges the message at the next turn
    // boundary. No live run (queued, preparing, between retries) → park
    // it; the task's next prompt drains it into turn one.
    const handle = rt.executions.get(taskIndex);
    const steered = handle?.steer?.(message) === true;
    const receipt = steered
      ? {
          status: "steered" as const,
          text:
            `Steer "${steerId}" for task "${taskId}" on ticket "${ticket.id}": steered — ` +
            `queued on the live run; the child sees it as a user message at its next turn boundary (not a mid-turn interrupt).` +
            pausedNote +
            derivedNote,
        }
      : {
          status: "activated" as const,
          text:
            `Steer "${steerId}" for task "${taskId}" on ticket "${ticket.id}": activated — ` +
            `the task has no live turn right now (queued, preparing, or between attempts); the message opens its next turn.` +
            pausedNote +
            derivedNote,
        };
    if (!steered) {
      const queue = rt.pendingSteers.get(taskIndex);
      if (queue === undefined) rt.pendingSteers.set(taskIndex, [{ steerId, message }]);
      else queue.push({ steerId, message });
    }
    rt.steers.set(steerId, {
      taskIndex,
      taskId,
      message,
      delivered: steered,
      receipt,
    });
    console.info(
      `[delegate] ticket ${ticket.id} task ${taskId} steer ${steerId}: ${receipt.status}`,
    );
    return {
      text: receipt.text,
      isError: false,
      ticket,
      steer: {
        steerId,
        ticket: ticket.id,
        taskId,
        status: receipt.status,
        ...(derivedId ? { derived: true } : {}),
      },
    };
  }

  /**
   * SPEC v3 "Interaction grammar — Interrupt": abort the task's live turn
   * cooperatively — the same abort path as cancellation (quiescence
   * confirmed before reservations release), but the outcome settles
   * `interrupted` and the worker stays resumable: a pooled session
   * returns reusable, a fresh task keeps its persisted transcript and a
   * resume hint. There is no idempotency key — interrupt is naturally
   * idempotent: anything it could no longer reach reports `not-applied`
   * (settled ticket or task, interrupted already, unknown task, or no
   * live turn to abort).
   */
  interrupt(ticket: Ticket, callTaskId: string | undefined): TicketRpcResult {
    const { record, rt } = this.entry(ticket);
    const notApplied = (text: string, taskId = ""): TicketRpcResult => ({
      text,
      isError: false,
      ticket,
      interrupt: { ticket: ticket.id, taskId, status: "not-applied" },
    });
    if (record.status !== "running") {
      return notApplied(
        ticket.recovered
          ? `Interrupt on ticket "${ticket.id}": not-applied — it is a recovered ${record.status} result; recovery never resumes it. Poll it for the final outcome.`
          : `Interrupt on ticket "${ticket.id}": not-applied — the ticket is already ${record.status}; nothing is running. Poll it for the final result.`,
      );
    }
    let taskIndex: number;
    if (callTaskId !== undefined) {
      taskIndex = record.tasks.findIndex((task) => task.id === callTaskId);
      if (taskIndex < 0) {
        return notApplied(
          `Interrupt on ticket "${ticket.id}": not-applied — there is no task "${callTaskId}". Its tasks: ${record.tasks.map((t) => `"${t.id}"`).join(", ")}.`,
        );
      }
    } else {
      const unsettled = record.tasks
        .map((_, index) => index)
        .filter((index) => record.outcomes[index] === undefined);
      if (unsettled.length === 0) {
        return notApplied(
          `Interrupt on ticket "${ticket.id}": not-applied — it has no running task left; poll it for the final results.`,
        );
      }
      if (unsettled.length > 1) {
        return {
          text:
            `action "interrupt" needs taskId on ticket "${ticket.id}" — ${unsettled.length} tasks are still running: ` +
            `${unsettled.map((i) => `"${record.tasks[i]!.id}"`).join(", ")}.`,
          isError: true,
          ticket,
        };
      }
      taskIndex = unsettled[0]!;
    }
    const taskId = record.tasks[taskIndex]!.id;
    const outcome = record.outcomes[taskIndex];
    if (outcome !== undefined) {
      return notApplied(
        `Interrupt on ticket "${ticket.id}" task "${taskId}": not-applied — it already settled (${outcome.status}); its outcome is final. Poll the ticket for it.`,
        taskId,
      );
    }
    const handle = rt.executions.get(taskIndex);
    if (handle === undefined) {
      return notApplied(
        `Interrupt on ticket "${ticket.id}" task "${taskId}": not-applied — it has no live turn right now (queued, preparing, or between attempts); nothing is running to interrupt.`,
        taskId,
      );
    }
    // abort() may never resolve — a provider or tool ignoring the signal
    // leaves the worker quarantined, and nothing caller-visible may block
    // on it. The receipt reports the requested settlement; the outcome
    // records the truth when the run winds down.
    void handle.abort("interrupted").catch((error: unknown) => {
      console.error(
        `[delegate] interrupt abort of task ${taskId} on ticket ${ticket.id} failed`,
        error,
      );
    });
    console.info(`[delegate] ticket ${ticket.id} task ${taskId}: interrupt requested`);
    return {
      text:
        `Interrupt for task "${taskId}" on ticket "${ticket.id}": interrupted — ` +
        `its current turn is aborting and the task settles 'interrupted' once the worker confirms ` +
        `it stopped (the same quiescence gate as cancellation). Its pooled session returns reusable, ` +
        `or its transcript keeps a resume hint; poll the ticket for the outcome.`,
      isError: false,
      ticket,
      interrupt: { ticket: ticket.id, taskId, status: "interrupted" },
    };
  }

  /**
   * Drain the parked steers for one task — the run loop calls this just
   * before prompt() so each message merges at turn one. Records flip to
   * delivered; a task that settles with steers still parked voids them
   * (receipt → not-applied) via recordOutcome/settle.
   */
  takePendingSteers(ticket: Ticket, taskIndex: number): readonly string[] {
    const { rt } = this.entry(ticket);
    const pending = rt.pendingSteers.get(taskIndex);
    if (pending === undefined || pending.length === 0) return [];
    rt.pendingSteers.delete(taskIndex);
    for (const steer of pending) {
      const record = rt.steers.get(steer.steerId);
      if (record !== undefined) record.delivered = true;
    }
    return pending.map((steer) => steer.message);
  }

  /**
   * A settled task can never receive a parked steer — drop the queue and
   * correct the stored receipts to not-applied, so a duplicate retry
   * tells the truth (SPEC "Steering": receipts, never polling).
   */
  private voidPendingSteers(ticket: Ticket, taskIndex: number): void {
    const { rt } = this.entry(ticket);
    const pending = rt.pendingSteers.get(taskIndex);
    if (pending === undefined) return;
    rt.pendingSteers.delete(taskIndex);
    const taskId = ticket.tasks[taskIndex]?.id ?? `#${taskIndex}`;
    for (const steer of pending) {
      const stored = rt.steers.get(steer.steerId);
      if (stored !== undefined && !stored.delivered) {
        stored.receipt = {
          status: "not-applied",
          text:
            `Steer "${steer.steerId}": not-applied — task "${taskId}" on ticket "${ticket.id}" ` +
            `settled before the message could be delivered; its outcome is final. Poll the ticket for it.`,
        };
      }
    }
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
          : // Interrupt is terminal first-class, like cancelled: a batch
            // whose tasks were all interrupted settles interrupted.
            record.outcomes.every((o) => o!.status === "interrupted")
            ? "interrupted"
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
    for (const index of [...rt.pendingSteers.keys()]) {
      this.voidPendingSteers(ticket, index);
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
      const live: LiveState = {
        activity: this.activity,
        executions: rt.executions,
      };
      // The preview names every task's current state (v1's cancel
      // preview): settled tasks keep their icon and error, unfinished
      // ones show the same live line a poll would — minus completion
      // evidence, which belongs to result views, not cancel previews.
      const taskLines = record.tasks.map((task, index) => {
        const outcome = record.outcomes[index];
        if (outcome === undefined) return liveTaskLine(record, index, live, false);
        const icon = outcome.status === "ok" ? "✓" : "✗";
        const what =
          outcome.status === "ok"
            ? "completed"
            : (outcome.error ?? outcome.status);
        return `${icon} ${task.agent}${resumeMarker(task.agent, task.resumeTag)} #${task.id} · ${what}`;
      });
      return (
        `Ticket "${ticket.id}" is ${statusWord(record)} with ${inFlight} task(s) in flight. ` +
        `Cancellation is cooperative: in-flight work is asked to stop and queued tasks are dropped; ` +
        `completed writes and commands are not rolled back. Re-run with force: true to cancel.` +
        (taskLines.length > 0 ? `\n${taskLines.join("\n")}` : "")
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
   * Wait for settlement — or for ticket activity worth waking on: a
   * worker-question arrival (the waiter's result carries the pending
   * question) and a task settling interrupted while this wait is parked
   * (the result names the task). An interruption already on record when
   * the wait begins is stale news, not a wake — it stays visible in the
   * view but does not end a fresh wait early, so re-waiting after one
   * still parks for the next event. A timeout or caller abort detaches
   * only this waiter — the ticket and its work are untouched. Timeout
   * and abort are distinct: only a timeout is a timeout.
   */
  async wait(
    ticket: Ticket,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ timedOut: boolean; aborted: boolean; questionPending: boolean; interrupted: readonly string[] }> {
    const { record, rt } = this.entry(ticket);
    const none = {
      timedOut: false,
      aborted: false,
      questionPending: false,
      interrupted: [] as readonly string[],
    };
    if (isTerminal(record.status)) return none;
    if (record.questions.length > 0) return { ...none, questionPending: true };
    if (signal?.aborted === true) return { ...none, aborted: true };
    // Event-scoped interruption wake: the indexes already recorded
    // interrupted are the baseline — only a NEW interrupted outcome is
    // activity this wait should hear about.
    const knownInterrupted = new Set<number>();
    for (const [index, outcome] of record.outcomes.entries()) {
      if (outcome?.status === "interrupted") knownInterrupted.add(index);
    }
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
    if (isTerminal(record.status)) return none;
    if (record.questions.length > 0) return { ...none, questionPending: true };
    const interrupted = record.tasks.flatMap((task, index) =>
      record.outcomes[index]?.status === "interrupted" && !knownInterrupted.has(index)
        ? [task.id]
        : [],
    );
    if (interrupted.length > 0) return { ...none, interrupted };
    if (outcome === "aborted" || signal?.aborted) {
      return { ...none, aborted: true };
    }
    // A question can be answered by another caller between its notification
    // and this waiter resuming. Do not misreport that wake-up as a timeout.
    return { ...none, timedOut: outcome === "timeout" };
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
  /** The steer receipt's machine-readable half (action "steer" only). */
  readonly steer?: SteerDetails;
  /** The interrupt receipt's machine half (action "interrupt" only). */
  readonly interrupt?: InterruptDetails;
}

/** delegate_ticket actions against the store. */
export async function handleTicketRpc(
  call: {
    action:
      | "poll"
      | "wait"
      | "cancel"
      | "pause"
      | "resume"
      | "answer"
      | "steer"
      | "interrupt";
    ticket: string | undefined;
    force: boolean;
    timeoutMs: number | undefined;
    taskId: string | undefined;
    questionId: string | undefined;
    answer: string | undefined;
    message: string | undefined;
    steerId: string | undefined;
  },
  store: TicketStore,
  signal: AbortSignal | undefined,
  /** The calling tool call's id — seeds the derived steerId (#44). */
  toolCallId = "",
): Promise<TicketRpcResult> {
  if (call.action === "poll" && call.ticket === undefined) {
    return { text: rosterView(store.list()), isError: false };
  }
  const ticket = call.ticket !== undefined ? store.get(call.ticket) : undefined;
  // Steering is receipt-shaped end to end (SPEC v3 "Steering"): an
  // unknown, terminal, or recovered target answers not-applied, not a
  // generic refusal. An omitted steerId derives `steer:<toolCallId>` —
  // a retried tool call replays its stored receipt instead of
  // re-injecting (the minimax task-append:<turnId>:<toolCallId> pattern,
  // scoped to the one durable id this boundary sees).
  const derivedSteer = call.action === "steer" && call.steerId === undefined;
  const steerId = derivedSteer ? `steer:${toolCallId}` : call.steerId;
  if (call.action === "steer") {
    if (ticket === undefined) {
      return {
        text:
          `Steer "${steerId ?? ""}": not-applied — ticket '${call.ticket ?? ""}' ` +
          `is unknown; nothing was sent. Poll with no ticket to list the live ones.` +
          (derivedSteer ? " (steerId derived from this call's tool-call id)" : ""),
        isError: false,
        steer: {
          steerId: steerId ?? "",
          ticket: call.ticket ?? "",
          taskId: call.taskId ?? "",
          status: "not-applied",
          ...(derivedSteer ? { derived: true } : {}),
        },
      };
    }
    return store.steer(ticket, call.taskId, steerId!, call.message!, derivedSteer);
  }
  // Interrupt shares the receipt discipline: an unknown or recovered
  // target answers not-applied, not a generic refusal.
  if (call.action === "interrupt") {
    if (ticket === undefined) {
      return {
        text:
          `Interrupt on ticket '${call.ticket ?? ""}': not-applied — the ticket ` +
          `is unknown; nothing was aborted. Poll with no ticket to list the live ones.`,
        isError: false,
        interrupt: {
          ticket: call.ticket ?? "",
          taskId: call.taskId ?? "",
          status: "not-applied",
        },
      };
    }
    return store.interrupt(ticket, call.taskId);
  }
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
      const { timedOut, aborted, questionPending, interrupted } = await store.wait(
        ticket,
        call.timeoutMs,
        signal,
      );
      const view = store.view(ticket);
      const text = questionPending
        ? `${view}\n\nWait detached: answer the pending question before waiting for this ticket.`
        : interrupted.length > 0
          ? `${view}\n\nWait detached: ${interrupted.length === 1 ? "task" : "tasks"} ${interrupted.map((id) => `"${id}"`).join(", ")} ${interrupted.length === 1 ? "was" : "were"} interrupted — the ticket is still ${statusWord(ticket)}.`
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

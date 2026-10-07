import { DiagnosticSink } from "./diagnostics.ts";
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
  isResumableTranscript,
  overlapLines,
  recoveryLines,
  resumeMarker,
  truncateLine,
} from "./format.ts";
import type { ActivityRow, ActivityStore } from "./activity.ts";
import type { DelegateSurface } from "./config.ts";
// The receipt details types derive from the TypeBox schemas in
// details.ts — the emitted shape and the pinned contract share one
// definition (SPEC v3 "Observability"; issue #51).
import type {
  InterruptDetails,
  SteerDetails,
  SteerStatus,
  TailDetails,
} from "./details.ts";
import { TicketJournal } from "./ticket-journal.ts";
import { DELEGATE_TREES } from "./fsx.ts";
import { currentBootId, ownerIsDead } from "./owner.ts";
import { assistantTextFromTranscript } from "./sessions.ts";
import { renderOutputForLLM, renderOutputForPoll } from "./spill.ts";
import type {
  ExecutionHandle,
  OutputBounds,
  TaskOutcome,
  TaskVerdict,
  Ticket,
  TicketOwner,
  TicketStatus,
  TokenBudgetReport,
  WorkerQuestion,
} from "./types.ts";
import { Deferred } from "./types.ts";
import type { ResolvedTask } from "./types.ts";

/** The store-private, writable form of the caller-visible record. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * #54: the reason startup recovery stamps on an orphaned running record —
 * on every unfinished task's synthesized outcome and once on the ticket
 * notice. Kept verbatim: tests and operators grep for it.
 */
const ORPHANED_OWNER_REASON = "owning session ended before settlement";
const ORPHANED_OWNER_NOTICE =
  `Startup recovery interrupted this ticket: ${ORPHANED_OWNER_REASON}.`;

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

/** How often an armed tail read re-polls its output source (ms). */
const TAIL_POLL_MS = 50;

function statusWord(ticket: Ticket): string {
  return ticket.status === "running" && ticket.paused ? "paused" : ticket.status;
}

function completedCount(ticket: Ticket): number {
  return ticket.outcomes.filter((outcome) => outcome !== undefined).length;
}

/** Exported for the collapsed renderer, which must not hide it (#63). */
export function recoveryWarning(ticket: Ticket): string | undefined {
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
  diagnostics: DiagnosticSink,
  ticket: Ticket,
  outcome: TaskOutcome,
  whole: boolean,
  surface: DelegateSurface,
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
  const head = `### Task ${descriptionLabel(record?.description) ?? outcome.id}${tag !== undefined ? ` ↻${tag}` : ""} — ${outcome.status === "ok" ? "completed" : outcome.status} · ${taskAddress(ticket.id, outcome.id)}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`;
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
          const rendered = renderOutputForLLM(diagnostics, output, label, bounds);
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
      outcome.concurrentWriters,
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
      ? `\n${recoveryLines(outcome.sessionFile, surface).join("\n")}`
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
  if (ticket.paused && row.status === "running") {
    return `⏳ ${label} · pausing — finishing current turn`;
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
  diagnostics: DiagnosticSink,
  ticket: Ticket,
  surface: DelegateSurface,
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
      `Waiting for parent answer: task ${ticket.id}#${q.taskId}, question ${q.id}: ${q.question}\nReply with delegate_ticket({ action: "answer", taskId: "${ticket.id}#${q.taskId}", questionId: "${q.id}", answer: "..." }).`),
  ];
  for (let index = 0; index < ticket.outcomes.length; index++) {
    const outcome = ticket.outcomes[index];
    if (outcome) {
      lines.push("", taskSection(diagnostics, ticket, outcome, whole, surface, renderedOutputs));
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
      ...ticket.questions.map((q) => `  waiting for answer: ${ticket.id}#${q.taskId} (${q.id}): ${q.question}`),
    ];
  });
  return `Tickets:\n${lines.join("\n")}`;
}

/**
 * The roster is this Pi session's work (#64): the store also holds
 * journaled records owned by sibling sessions (live tickets still running
 * elsewhere, settled records kept pollable), and listing those would read
 * as work this session owns. A record with a different — or missing —
 * owner sessionId is another session's; explicit-id poll/wait/tail still
 * reach it (settled results stay pollable).
 */
function ownTickets(
  store: TicketStore,
  sessionId: string | undefined,
): { mine: Ticket[]; hidden: number } {
  const all = store.list();
  const mine = all.filter(
    (ticket) => ticket.owner?.sessionId === sessionId,
  );
  return { mine, hidden: all.length - mine.length };
}

function hiddenTicketNote(hidden: number): string {
  return hidden > 0
    ? `(${hidden} ticket(s) from other sessions not shown; poll one by id to read it.)`
    : "";
}

/**
 * The canonical `<ticket>#<task>` address (#53) — rendered wherever a
 * task is named as an addressee so the parent can copy it verbatim into
 * any taskId field.
 */
function taskAddress(ticketId: string, taskId: string): string {
  return `${ticketId}#${taskId}`;
}

/**
 * Unknown-ticket errors name this session's tickets (#64, same scoping
 * as the roster): other sessions' records stay readable by explicit id
 * but are not suggested as names this session can act on.
 */
function knownTickets(store: TicketStore, sessionId: string | undefined): string {
  const { mine, hidden } = ownTickets(store, sessionId);
  const suffix = hiddenTicketNote(hidden);
  const base =
    mine.length === 0
      ? "There are no tickets right now — dispatch creates them."
      : `Known tickets: ${mine.map((ticket) => `"${ticket.id}"`).join(", ")}.`;
  return suffix === "" ? base : `${base} ${suffix}`;
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
   * The session-fixed delegate surface (#61), restamped by
   * `registerTools` on every (re)load. Views and not-applied receipts
   * render through it so no recovery hint teaches a field the active
   * boundary would reject.
   */
  private surfaceMode: DelegateSurface = "compact";

  /**
   * Optional lifecycle observer (extension-owned): fired after every
   * caller-visible mutation so visibility signals can resync. The store
   * never reads it beyond the call.
   */
  constructor(readonly diagnostics: DiagnosticSink,
    private readonly onChange?: () => void,
    private readonly onQuestion?: (ticket: Ticket, question: WorkerQuestion) => void,
    /** Optional live-activity sink shared with the coordinator; running
     * polls render per-task activity rows from it when present. */
    private readonly activity?: ActivityStore,
    /** Optional pool lookup (#57): a task's sessionId still pooled means
     * its conversation is continuable by re-dispatch — the not-applied
     * receipt teaches that over the generic resumeFrom pointer. */
    private readonly pooledTranscript?: (sessionId: string) => string | undefined,
  ) {}

  /** `registerTools` restamps the session-fixed surface on every (re)load. */
  setSurface(surface: DelegateSurface): void {
    this.surfaceMode = surface;
  }

  /** The active surface — renderers emit surface-valid resume hints through it. */
  get surface(): DelegateSurface {
    return this.surfaceMode;
  }

  /**
   * #57 — the continuation pointer a not-applied steer/interrupt receipt
   * appends: "nothing was applied" is a dead end unless the caller can
   * see how to continue the work. A settled task that ran on a pooled
   * session still holds its conversation — the receipt teaches
   * re-dispatch with `sessionId`; a fresh task with a durable transcript
   * teaches `resumeFrom` (the same pointer failure views render); a task
   * with neither gets today's text unchanged. Under the compact surface
   * the `resumeFrom` pointer names the full-mode requirement first — the
   * bare call would reject. A recovered record's pool never survives the
   * restart, but a journaled transcript does (#123): the resumeFrom
   * branch fires for a recovered outcome that carries a sessionFile.
   */
  private continuationFor(
    record: Ticket,
    callTaskId: string | undefined,
    resolvedIndex?: number,
  ): string {
    const index =
      resolvedIndex ??
      (callTaskId !== undefined
        ? record.tasks.findIndex((task) => task.id === callTaskId)
        : record.tasks.length === 1
          ? 0
          : -1);
    if (index < 0) return "";
    const task = record.tasks[index];
    if (task === undefined) return "";
    if (
      record.recovered !== true &&
      task.sessionId !== undefined &&
      this.pooledTranscript?.(task.sessionId) !== undefined
    ) {
      return (
        ` To continue it, re-dispatch a task with sessionId "${task.sessionId}" ` +
        `and the follow-up prompt — that pooled session still holds the conversation.`
      );
    }
    const sessionFile = record.outcomes[index]?.sessionFile;
    if (sessionFile !== undefined && isResumableTranscript(sessionFile)) {
      return this.surface === "full"
        ? ` To continue it, re-dispatch a task with resumeFrom ` +
          `${JSON.stringify(sessionFile)} — the transcript is durable.`
        : ` To continue it, set "surface": "full" in user-global delegate.json ` +
          `and /reload — resumeFrom is a full-surface field — then re-dispatch ` +
          `a task with resumeFrom ${JSON.stringify(sessionFile)}.`;
    }
    return "";
  }

  private changed(): void {
    this.onChange?.();
  }

  /** Load once per extension lifetime. Never adopt another agent directory. */
  connect(agentDir: string): void {
    if (this.journal !== undefined) {
      if (this.journal.dir !== join(agentDir, DELEGATE_TREES.tickets)) {
        throw new Error("Delegate agent directory changed during this session; ticket recovery requires a single agent directory.");
      }
      return;
    }
    const journal = new TicketJournal(this.diagnostics, agentDir);
    const saved = journal.load();
    // #54 owner liveness: a journaled `running` ticket settles
    // interrupted only when its recorded owner is provably dead — this
    // process restarted, or a reboot happened since dispatch. Records
    // without an owner (written before owner tracking) and records whose
    // owner is still alive (a sibling pane's live ticket) stay untouched;
    // recovery never restarts work either way.
    const bootId = currentBootId();
    let orphaned = 0;
    for (const item of saved) {
      const orphanedRunning =
        item.status === "running" && ownerIsDead(item.owner, bootId);
      const outcomes = item.outcomes.map((outcome, index) => {
        if (outcome !== undefined && outcome !== null) return outcome;
        if (!orphanedRunning) return undefined;
        const claimed = item.tasks[index];
        return {
          index,
          id: item.tasks[index]!.id,
          status: "interrupted" as const,
          retries: 0,
          error: ORPHANED_OWNER_REASON,
          // #123: the transcript claimed before the crash — carried into
          // the outcome so the settled view's recovery lines and the
          // continuation hints name the durable file. Rendering gates on
          // resumability; records written before #123 carry none.
          ...(claimed?.sessionFile !== undefined
            ? { sessionFile: claimed.sessionFile }
            : {}),
          ...(claimed?.transcriptStart !== undefined
            ? { transcriptStart: claimed.transcriptStart }
            : {}),
        };
      });
      const recovered: Ticket = {
        id: item.id,
        status: orphanedRunning ? "interrupted" : item.status,
        paused: false,
        tasks: item.tasks.map((task) => ({
          id: task.id,
          agent: task.agent,
          sessionId: task.sessionId,
          resumeTag: task.resumeTag,
          aliasedFrom: task.aliasedFrom,
          description: task.description,
          normalizedFrom: task.normalizedFrom,
          // Optional in the journal — records written before file
          // attribution have none; their paths render absolute.
          ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
          ...(task.sessionFile !== undefined ? { sessionFile: task.sessionFile } : {}),
          ...(task.transcriptStart !== undefined ? { transcriptStart: task.transcriptStart } : {}),
        })),
        totalTasks: item.tasks.length,
        outcomes,
        questions: [],
        outputBounds: item.outputBounds,
        createdAt: item.createdAt,
        recovered: true,
        ...(item.owner !== undefined ? { owner: item.owner } : {}),
        notices: orphanedRunning
          ? [...item.notices, ORPHANED_OWNER_NOTICE]
          : item.notices,
        // Optional in the journal — pre-brief records have none.
        ...(item.brief !== undefined ? { brief: item.brief } : {}),
        // Optional in the journal — pre-budget records and budgetless
        // dispatches have none.
        ...(item.tokenBudget !== undefined
          ? { tokenBudget: item.tokenBudget }
          : {}),
      };
      // The interruption is journal-durable BEFORE the record becomes
      // visible — the journal state machine is what makes a repeat startup
      // see `interrupted` instead of settling the same ticket twice. A
      // failed save propagates like any corrupt-journal failure: the
      // orphaned record is never registered in a settled-but-unsaved state.
      if (orphanedRunning) {
        journal.save(recovered);
        orphaned++;
      }
      this.tickets.set(item.id, { record: recovered, rt: this.runtime(false) });
    }
    this.journal = journal;
    if (saved.length > 0) {
      this.diagnostics.log("info", "recovered ticket records; unfinished work is never restarted", { count: saved.length, path: journal.dir, orphaned });
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
      this.diagnostics.log("error", "ticket recovery save failed", { ticketId: record.id }, error);
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
      /**
       * The dispatching host's identity (#54), journaled with the record
       * so a later startup's owner-liveness check can tell a dead
       * predecessor from a live sibling.
       */
      readonly owner?: TicketOwner;
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
      ...(options.owner !== undefined ? { owner: options.owner } : {}),
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
      rt.settledView ??= ticketView(this.diagnostics, record, this.surface, false, rt.renderedOutputs, live);
      return rt.settledView;
    }
    return ticketView(this.diagnostics, record, this.surface, false, rt.renderedOutputs, live);
  }

  /**
   * The expanded human view of the ticket: the `view` document with every
   * recorded output rendered whole — bounding is an LLM-context economy,
   * not a display one. Unlike `view` it is never memoized and never
   * touches the filesystem: no spill files, no frozen terminal render.
   */
  fullView(ticket: Ticket): string {
    const { record, rt } = this.entry(ticket);
    return ticketView(this.diagnostics, record, this.surface, true, undefined, {
      activity: this.activity,
      executions: rt.executions,
    });
  }

  /** Drop a ticket that never started (e.g. admission failed after create). */
  remove(id: string): void {
    this.tickets.delete(id);
    try { this.journal?.remove(id); }
    catch (error) { this.diagnostics.log("error", "removing unstarted ticket failed", { ticketId: id }, error); }
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
  ): readonly {
    taskId: string;
    files: readonly string[];
    uncertain: boolean;
    concurrentWriters?: readonly string[];
  }[] {
    const { record, rt } = this.entry(ticket);
    const rows: {
      taskId: string;
      files: readonly string[];
      uncertain: boolean;
      concurrentWriters?: readonly string[];
    }[] = [];
    for (let index = 0; index < record.tasks.length; index++) {
      const outcome = record.outcomes[index];
      if (outcome !== undefined) {
        rows.push({
          taskId: outcome.id,
          files: [...(outcome.attributedFiles ?? [])],
          uncertain: outcome.uncertainFiles === true,
          ...(outcome.concurrentWriters !== undefined
            ? { concurrentWriters: [...outcome.concurrentWriters] }
            : {}),
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

  /**
   * #123: the transcript a worker claimed before its run's first turn —
   * journaled at claim time (not settlement) so an unclean restart's
   * recovery can name the durable file in the interrupted outcome.
   * Sole-writer cast, same discipline as recordOutcome; retries
   * overwrite because the newest claim is the live worker's.
   */
  noteTaskTranscript(
    ticket: Ticket,
    index: number,
    file: string,
    start: number,
  ): void {
    const writable = this.entry(ticket).record as Writable<Ticket>;
    const tasks = writable.tasks as Writable<Ticket["tasks"][number]>[];
    const task = tasks[index];
    if (task === undefined) return;
    task.sessionFile = file;
    task.transcriptStart = start;
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
    this.diagnostics.log("info", "task waiting for answer", { ticketId: ticket.id, taskId: question.taskId, questionId: question.id });
    this.changed();
    for (const notify of [...rt.waiters]) notify();
    try {
      this.onQuestion?.(ticket, question);
    } catch (error) {
      this.diagnostics.log("error", "notifying parent of question failed", { ticketId: ticket.id, questionId: question.id }, error);
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
      throw new Error(`No question '${questionId}' for task '${taskAddress(ticket.id, taskId)}'.`);
    }
    if (previous !== undefined) {
      if (previous.answer !== answer) throw new Error(`Question '${questionId}' was already answered differently.`);
      return `Answer ${questionId} already recorded for task ${taskAddress(ticket.id, taskId)}.`;
    }
    rt.answeredQuestions.set(questionId, { taskIndex: index, answer });
    this.diagnostics.log("info", "task answered question", { ticketId: ticket.id, taskId, questionId });
    pending!.resolve(answer);
    return `Answer ${questionId} recorded for task ${taskAddress(ticket.id, taskId)}; worker will resume when capacity is available.`;
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
          ? `task "${taskAddress(ticket.id, seen.taskId)}"`
          : resolvedIndex >= 0
            ? `task "${taskAddress(ticket.id, record.tasks[resolvedIndex]!.id)}"`
            : `task "${callTaskId ?? ""}" (not on this ticket)`;
        return {
          text:
            `Steer id "${steerId}" conflict on ticket "${ticket.id}": first used for task "${taskAddress(ticket.id, seen.taskId)}"; ` +
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
    if (record.status !== "running" || ticket.recovered === true) {
      return notApplied(
        (ticket.recovered
          ? record.status === "running"
            ? `Steer "${steerId}": not-applied — ticket "${ticket.id}" is a recovered record whose work runs under another live session; steer it there.`
            : `Steer "${steerId}": not-applied — ticket "${ticket.id}" is a recovered ${record.status} result; recovery never resumes it. Poll it for the final outcome.`
          : `Steer "${steerId}": not-applied — ticket "${ticket.id}" is already ${record.status}; nothing is running. Poll it for the final result.`) +
          this.continuationFor(record, callTaskId),
      );
    }
    let taskIndex: number;
    if (callTaskId !== undefined) {
      taskIndex = record.tasks.findIndex((task) => task.id === callTaskId);
      if (taskIndex < 0) {
        return notApplied(
          `Steer "${steerId}": not-applied — ticket "${ticket.id}" has no task "${taskAddress(ticket.id, callTaskId)}". Its tasks: ${record.tasks.map((t) => `"${taskAddress(ticket.id, t.id)}"`).join(", ")}.`,
        );
      }
    } else {
      const unsettled = record.tasks
        .map((_, index) => index)
        .filter((index) => record.outcomes[index] === undefined);
      if (unsettled.length === 0) {
        return notApplied(
          `Steer "${steerId}": not-applied — ticket "${ticket.id}" has no running task left; poll it for the final results.` +
            this.continuationFor(record, callTaskId),
        );
      }
      if (unsettled.length > 1) {
        return {
          text:
            `action "steer" needs taskId on ticket "${ticket.id}" — ${unsettled.length} tasks are still running: ` +
            `${unsettled.map((i) => `"${taskAddress(ticket.id, record.tasks[i]!.id)}"`).join(", ")}.`,
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
        `Steer "${steerId}": not-applied — task "${taskAddress(ticket.id, taskId)}" already settled (${outcome.status}); its outcome is final. Poll the ticket for it.` +
          this.continuationFor(record, callTaskId, taskIndex),
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
            `Steer "${steerId}" for task "${taskAddress(ticket.id, taskId)}": steered — ` +
            `queued on the live run; the child sees it as a user message at its next turn boundary (not a mid-turn interrupt).` +
            pausedNote +
            derivedNote,
        }
      : {
          status: "activated" as const,
          text:
            `Steer "${steerId}" for task "${taskAddress(ticket.id, taskId)}": activated — ` +
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
    this.diagnostics.log("info", "task steer receipt", { ticketId: ticket.id, taskId, steerId, status: receipt.status });
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
    if (record.status !== "running" || ticket.recovered === true) {
      return notApplied(
        (ticket.recovered
          ? record.status === "running"
            ? `Interrupt on ticket "${ticket.id}": not-applied — it is a recovered record whose work runs under another live session; interrupt it there.`
            : `Interrupt on ticket "${ticket.id}": not-applied — it is a recovered ${record.status} result; recovery never resumes it. Poll it for the final outcome.`
          : `Interrupt on ticket "${ticket.id}": not-applied — the ticket is already ${record.status}; nothing is running. Poll it for the final result.`) +
          this.continuationFor(record, callTaskId),
      );
    }
    let taskIndex: number;
    if (callTaskId !== undefined) {
      taskIndex = record.tasks.findIndex((task) => task.id === callTaskId);
      if (taskIndex < 0) {
        return notApplied(
          `Interrupt on ticket "${ticket.id}": not-applied — there is no task "${taskAddress(ticket.id, callTaskId)}". Its tasks: ${record.tasks.map((t) => `"${taskAddress(ticket.id, t.id)}"`).join(", ")}.`,
        );
      }
    } else {
      const unsettled = record.tasks
        .map((_, index) => index)
        .filter((index) => record.outcomes[index] === undefined);
      if (unsettled.length === 0) {
        return notApplied(
          `Interrupt on ticket "${ticket.id}": not-applied — it has no running task left; poll it for the final results.` +
            this.continuationFor(record, callTaskId),
        );
      }
      if (unsettled.length > 1) {
        return {
          text:
            `action "interrupt" needs taskId on ticket "${ticket.id}" — ${unsettled.length} tasks are still running: ` +
            `${unsettled.map((i) => `"${taskAddress(ticket.id, record.tasks[i]!.id)}"`).join(", ")}.`,
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
        `Interrupt on "${taskAddress(ticket.id, taskId)}": not-applied — it already settled (${outcome.status}); its outcome is final. Poll the ticket for it.` +
          this.continuationFor(record, callTaskId, taskIndex),
        taskId,
      );
    }
    const handle = rt.executions.get(taskIndex);
    if (handle === undefined) {
      return notApplied(
        `Interrupt on "${taskAddress(ticket.id, taskId)}": not-applied — it has no live turn right now (queued, preparing, or between attempts); nothing is running to interrupt.`,
        taskId,
      );
    }
    // abort() may never resolve — a provider or tool ignoring the signal
    // leaves the worker quarantined, and nothing caller-visible may block
    // on it. The receipt reports the requested settlement; the outcome
    // records the truth when the run winds down.
    void handle.abort("interrupted").catch((error: unknown) => {
      this.diagnostics.log("error", "interrupt abort failed", { ticketId: ticket.id, taskId }, error);
    });
    this.diagnostics.log("info", "task interrupt requested", { ticketId: ticket.id, taskId });
    return {
      text:
        `Interrupt for task "${taskAddress(ticket.id, taskId)}": interrupted — ` +
        `its current turn is aborting and the task settles 'interrupted' once the worker confirms ` +
        `it stopped (the same quiescence gate as cancellation). Its pooled session returns reusable, ` +
        `or its transcript keeps a resume hint; poll the ticket for the outcome.`,
      isError: false,
      ticket,
      interrupt: { ticket: ticket.id, taskId, status: "interrupted" },
    };
  }

  /**
   * delegate_ticket "tail" (issue #52): a bounded, incremental read of
   * one task's clean assistant output. `offset` is a char cursor into
   * the accumulated text — an out-of-range value clamps; `text` is the
   * chunk from that offset, capped per call at the ticket's spill tail
   * bound, and `nextOffset` is the cursor for the following read.
   *
   * Source of truth: the run's durable transcript when the task is
   * file-backed (fresh, shared, sessionId, resumeFrom) — the caller never
   * parses raw `.jsonl`. The span's byte baseline excludes earlier
   * conversations from pooled/resumed transcripts. In-memory tasks
   * (scratch, isolated) tail from the activity store's captured text;
   * a settled task whose activity row was pruned falls back to its
   * recorded output. `waitMs` omitted or ≤0 is a pure snapshot; a
   * positive bound parks the read until new output lands or the task
   * settles — never longer than requested. Idempotent; no wake semantics
   * (ticket events stay with `wait`).
   */
  async tail(
    ticket: Ticket,
    callTaskId: string | undefined,
    offset: number | undefined,
    waitMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TicketRpcResult> {
    const { record, rt } = this.entry(ticket);
    const fail = (text: string): TicketRpcResult => ({
      text,
      isError: true,
      ticket,
    });
    let taskIndex: number;
    if (callTaskId !== undefined) {
      taskIndex = record.tasks.findIndex((task) => task.id === callTaskId);
      if (taskIndex < 0) {
        return fail(
          `Ticket "${record.id}" has no task "${taskAddress(record.id, callTaskId)}". Its tasks: ${record.tasks.map((task) => `"${taskAddress(record.id, task.id)}"`).join(", ")}.`,
        );
      }
    } else {
      const unsettled = record.tasks
        .map((_, index) => index)
        .filter((index) => record.outcomes[index] === undefined);
      if (unsettled.length === 1) {
        taskIndex = unsettled[0]!;
      } else if (unsettled.length === 0 && record.tasks.length === 1) {
        taskIndex = 0;
      } else {
        const candidates =
          unsettled.length > 0 ? unsettled : record.tasks.map((_, i) => i);
        return fail(
          `action "tail" needs taskId on ticket "${record.id}" — ${candidates.length === 0 ? "it has no tasks" : `${candidates.length} tasks ${unsettled.length > 0 ? "are still running" : "ran"}: ${candidates.map((i) => `"${taskAddress(record.id, record.tasks[i]!.id)}"`).join(", ")}`}.`,
        );
      }
    }
    const taskId = record.tasks[taskIndex]!.id;
    const cap = record.outputBounds.spillTailChars;

    const read = (): {
      source: string;
      done: boolean;
      taskState: TailDetails["taskState"];
    } => {
      const outcome = record.outcomes[taskIndex];
      // File-backed runs read their transcript — the source of truth
      // (spans exclude earlier pooled/resumed conversation). In-memory
      // and pruned-row runs read the activity store's captured tail;
      // a recorded output is the last fallback once both are gone.
      const span =
        rt.executions.get(taskIndex)?.transcript?.() ??
        (outcome?.sessionFile !== undefined
          ? { file: outcome.sessionFile, start: outcome.transcriptStart ?? 0 }
          : undefined);
      const source =
        span !== undefined
          ? assistantTextFromTranscript(span.file, span.start)
          : (this.activity?.taskRow(record.id, taskId)?.assistantTail ??
            outcome?.output ??
            "");
      // taskState is the RAW activity-row status, not the browser's
      // annotated word: "running" here can mean pausing (pause requested,
      // in-flight turn still streaming) — only "paused" is the parked
      // truth. Consumers wanting the annotated form read the poll view.
      const taskState =
        outcome?.status ??
        this.activity?.taskRow(record.id, taskId)?.status ??
        (rt.executions.has(taskIndex) ? "running" : "queued");
      return { source, done: outcome !== undefined, taskState };
    };

    const off = Number.isFinite(offset)
      ? Math.max(0, Math.floor(offset!))
      : 0;
    const deadline =
      waitMs !== undefined && Number.isFinite(waitMs) && waitMs > 0
        ? Date.now() + waitMs
        : undefined;
    for (;;) {
      const snap = read();
      const clamped = Math.min(off, snap.source.length);
      // A snapshot returns at once; an armed wait returns early on new
      // output, on settlement, or on caller abort — never past the bound.
      const grown = snap.source.length > clamped;
      if (
        deadline === undefined ||
        grown ||
        snap.done ||
        signal?.aborted === true ||
        Date.now() >= deadline
      ) {
        const text = snap.source.slice(clamped, clamped + cap);
        const nextOffset = clamped + text.length;
        const head =
          `Tail of task "${taskAddress(record.id, taskId)}" — ` +
          `${snap.done ? `settled (${snap.taskState})` : snap.taskState}: ` +
          `${text.length} chars from offset ${clamped} → nextOffset ${nextOffset}` +
          (snap.source.length > nextOffset
            ? "; more output is already buffered beyond this read's bound"
            : "") +
          (snap.done ? "; complete" : "") +
          ".";
        return {
          text: text === "" ? `${head}\n\n(no output in range)` : `${head}\n\n${text}`,
          isError: false,
          ticket,
          tail: {
            ticket: record.id,
            taskId,
            text,
            offset: clamped,
            nextOffset,
            done: snap.done,
            taskState: snap.taskState,
          },
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, TAIL_POLL_MS));
    }
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
            `Steer "${steer.steerId}": not-applied — task "${taskAddress(ticket.id, taskId)}" ` +
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
    // A recovered record is another host's journal projection — a still
    // `running` one belongs to a live sibling (#54). Settling it here
    // would overwrite that session's journal entry, so the record is
    // read-only: no transition, no save.
    if (record.recovered === true) return false;
    if (isTerminal(record.status) || status === "running") return false;
    record.status = status;
    record.paused = false;
    this.save(record);
    for (const [id, question] of rt.pendingQuestions) {
      this.diagnostics.log("info", "invalidated question", { ticketId: ticket.id, questionId: id, status });
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
    if (record.recovered === true) {
      // Still `running` here means a live sibling owns it (#54): this
      // host holds no executions to abort and no journal write is legal.
      return (
        `Ticket "${ticket.id}" is a recovered record of work running under another live session; ` +
        `only that session can cancel it.`
      );
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
        this.diagnostics.log("error", "aborting task on ticket failed", { ticketId: ticket.id }, error);
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
    // A recovered record can never produce activity in this host — a
    // `running` one is live under a sibling, unreachable from here.
    // Parking would only sit out the timeout, so return at once.
    if (record.recovered === true) return none;
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
   * Wait-any (#58): park across several tickets and resolve on the first
   * one to settle — the watcher's equivalent of `Promise.any`. The same
   * activity wakes apply per watched ticket (a pending question or a
   * newly interrupted task ends the wait on that ticket), the same
   * detach-only timeout applies to the waiter, and the caller's list
   * order decides which settled ticket wins a tie. A wait that can never
   * hear anything — every watched ticket a recovered record — returns
   * `unhearable` at once rather than sitting out the timeout, mirroring
   * the single wait's recovered early-return.
   */
  async waitAny(
    ids: readonly string[],
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<WaitAnyResult> {
    const entries = ids.map((id) => {
      const record = this.get(id);
      if (record === undefined) {
        throw new Error(`internal: unknown ticket '${id}'`);
      }
      return this.entry(record);
    });
    // Same event-scope rule as wait(): interruptions already on record
    // are stale news — only a NEW interrupted outcome wakes this waiter.
    const baseline = entries.map(({ record }) => {
      const known = new Set<number>();
      for (const [index, outcome] of record.outcomes.entries()) {
        if (outcome?.status === "interrupted") known.add(index);
      }
      return known;
    });
    const scan = (): WaitAnyResult | undefined => {
      for (const { record } of entries) {
        if (isTerminal(record.status)) {
          return { cause: "settled", ticket: record };
        }
      }
      for (const { record } of entries) {
        if (record.questions.length > 0) {
          return { cause: "question", ticket: record };
        }
      }
      for (let e = 0; e < entries.length; e++) {
        const { record } = entries[e]!;
        const fresh = record.tasks.flatMap((task, index) =>
          record.outcomes[index]?.status === "interrupted" &&
          !baseline[e]!.has(index)
            ? [task.id]
            : [],
        );
        if (fresh.length > 0) {
          return { cause: "interrupted", ticket: record, interrupted: fresh };
        }
      }
      return undefined;
    };
    // The deadline is one clock for the whole call — a wake loop must not
    // reset it.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise =
      timeoutMs === undefined
        ? undefined
        : new Promise<"timeout">((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), timeoutMs);
          });
    let onAbort: (() => void) | undefined;
    const abortPromise =
      signal === undefined
        ? undefined
        : new Promise<"aborted">((resolve) => {
            onAbort = () => resolve("aborted");
            signal.addEventListener("abort", onAbort);
          });
    let notify: (() => void) | undefined;
    try {
      for (;;) {
        // Register before scanning: any event between the scan and the
        // subscription would otherwise be a missed wake — registered
        // first, the same event either resolves `parked` or is visible
        // to the scan itself.
        let parkedNotify!: () => void;
        const parked = new Promise<void>((resolve) => {
          parkedNotify = () => resolve();
        });
        notify = parkedNotify;
        for (const { record, rt } of entries) {
          if (record.recovered !== true && !isTerminal(record.status)) {
            rt.waiters.add(parkedNotify);
          }
        }
        const hit = scan();
        if (hit !== undefined) return hit;
        if (signal?.aborted === true) return { cause: "aborted" };
        if (
          entries.every(
            ({ record }) =>
              record.recovered === true || isTerminal(record.status),
          )
        ) {
          return { cause: "unhearable" };
        }
        const races: Promise<unknown>[] = [parked];
        if (timeoutPromise !== undefined) races.push(timeoutPromise);
        if (abortPromise !== undefined) races.push(abortPromise);
        const outcome = await Promise.race(races);
        // Detach this iteration's waiter before rescanning — a re-park
        // registers a fresh notify; leaving the resolved one would leak
        // it into every watched ticket's set.
        for (const { rt } of entries) rt.waiters.delete(parkedNotify);
        notify = undefined;
        // A wake resolving to nothing new (e.g. a question answered by
        // another caller mid-flight) parks again — never a misreported
        // timeout.
        const again = scan();
        if (again !== undefined) return again;
        if (outcome === "aborted" || signal?.aborted) {
          return { cause: "aborted" };
        }
        if (outcome === "timeout") return { cause: "timeout" };
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      if (notify !== undefined) {
        for (const { rt } of entries) rt.waiters.delete(notify);
        notify = undefined;
      }
    }
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
  /**
   * The tail a wait result appends after the ticket view — the wait-any
   * roster sentence, a timeout/detached notice, or a pending-question
   * pointer. Carried on details.note so the collapsed view shows it too.
   */
  readonly note?: string;
  /**
   * The terminal view this call returned to the model — the content
   * fingerprint for delivery consumption (SPEC v3 "Wake delivery").
   * Present only when the rendered view was already terminal; the
   * delivery flush compares it against the view the wake would send
   * and suppresses the wake only on an exact match — identical content
   * is already-shown, while a record that changed since the render
   * (late outcomes, budget account, notices) still delivers.
   */
  readonly consumedView?: string;
  /** The steer receipt's machine-readable half (action "steer" only). */
  readonly steer?: SteerDetails;
  /** The interrupt receipt's machine half (action "interrupt" only). */
  readonly interrupt?: InterruptDetails;
  /** The tail read's machine half (action "tail" only). */
  readonly tail?: TailDetails;
}

/** What ended a wait-any call (#58); `ticket` is the watched ticket the cause names. */
export interface WaitAnyResult {
  readonly cause:
    | "settled"
    | "question"
    | "interrupted"
    | "timeout"
    | "aborted"
    | "unhearable";
  readonly ticket?: Ticket;
  /** Newly interrupted task ids on `ticket` (cause "interrupted" only). */
  readonly interrupted?: readonly string[];
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
      | "interrupt"
      | "tail";
    ticket: string | undefined;
    tickets: readonly string[] | undefined;
    force: boolean;
    timeoutMs: number | undefined;
    taskId: string | undefined;
    questionId: string | undefined;
    answer: string | undefined;
    message: string | undefined;
    steerId: string | undefined;
    offset: number | undefined;
    waitMs: number | undefined;
  },
  store: TicketStore,
  signal: AbortSignal | undefined,
  /** The calling tool call's id — seeds the derived steerId (#44). */
  toolCallId = "",
  /** The calling Pi session's id — scopes roster/known-ticket listings (#64). */
  sessionId?: string,
): Promise<TicketRpcResult> {
  if (call.action === "poll" && call.ticket === undefined) {
    const { mine, hidden } = ownTickets(store, sessionId);
    const roster = rosterView(mine);
    const note = hiddenTicketNote(hidden);
    return {
      text: note === "" ? roster : `${roster}\n${note}`,
      isError: false,
    };
  }
  // Canonical task addresses (#53): a taskId of the form
  // "<ticket>#<task>" carries its own ticket — the ticket field is
  // optional with it. "#" can never appear in a dispatched task id (the
  // task schema's id charset excludes it), so a "#" in taskId is always
  // the compound separator; plain ticket/task forms are untouched.
  let ticketName = call.ticket;
  let taskId = call.taskId;
  if (taskId !== undefined && taskId.includes("#")) {
    const hash = taskId.indexOf("#");
    const addressedTicket = taskId.slice(0, hash);
    const addressedTask = taskId.slice(hash + 1);
    if (addressedTicket === "" || addressedTask === "") {
      return {
        text:
          `taskId ${JSON.stringify(call.taskId)} is malformed — a compound ` +
          `address is "<ticket>#<task>" (e.g. "t-1a2b#task-1").`,
        isError: true,
      };
    }
    if (ticketName !== undefined && ticketName !== addressedTicket) {
      return {
        text:
          `taskId ${JSON.stringify(call.taskId)} and ticket ${JSON.stringify(ticketName)} ` +
          `disagree — a "<ticket>#<task>" compound resolves its own ticket; send one.`,
        isError: true,
      };
    }
    ticketName = addressedTicket;
    taskId = addressedTask;
  }
  const ticket = ticketName !== undefined ? store.get(ticketName) : undefined;
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
          `Steer "${steerId ?? ""}": not-applied — ticket '${ticketName ?? ""}' ` +
          `is unknown; nothing was sent. ${knownTickets(store, sessionId)}` +
          (derivedSteer ? " (steerId derived from this call's tool-call id)" : ""),
        isError: false,
        steer: {
          steerId: steerId ?? "",
          ticket: ticketName ?? "",
          taskId: taskId ?? "",
          status: "not-applied",
          ...(derivedSteer ? { derived: true } : {}),
        },
      };
    }
    return store.steer(ticket, taskId, steerId!, call.message!, derivedSteer);
  }
  // Interrupt shares the receipt discipline: an unknown or recovered
  // target answers not-applied, not a generic refusal.
  if (call.action === "interrupt") {
    if (ticket === undefined) {
      return {
        text:
          `Interrupt on ticket '${ticketName ?? ""}': not-applied — the ticket ` +
          `is unknown; nothing was aborted. ${knownTickets(store, sessionId)}`,
        isError: false,
        interrupt: {
          ticket: ticketName ?? "",
          taskId: taskId ?? "",
          status: "not-applied",
        },
      };
    }
    return store.interrupt(ticket, taskId);
  }
  // Wait-any (#58): `tickets` resolves on the first watched ticket to
  // settle — validation already folded a one-id list into `ticket`, so
  // this branch sees only genuine multi-ticket waits. Every id must
  // resolve: an unknown one fails the call like the singular path.
  if (call.action === "wait" && call.tickets !== undefined) {
    const missing = call.tickets.filter((id) => store.get(id) === undefined);
    if (missing.length > 0) {
      return {
        text:
          `Ticket ${missing.map((id) => `'${id}'`).join(", ")} not found. ` +
          knownTickets(store, sessionId),
        isError: true,
      };
    }
    const result = await store.waitAny(call.tickets, call.timeoutMs, signal);
    // The rest of the watch list in one roster line — the settled view
    // leads, the still-running remainder follows.
    const rest = call.tickets
      .filter((id) => id !== result.ticket?.id)
      .map((id) => store.get(id)!)
      .filter((other) => !isTerminal(other.status));
    const roster =
      rest.length === 0
        ? "the other watched tickets settled too"
        : `still running: ${rest
            .map(
              (other) =>
                `"${other.id}" (${statusWord(other)}, ${completedCount(other)}/${other.totalTasks} tasks finished)`,
            )
            .join(", ")}`;
    if (result.ticket !== undefined) {
      const view = store.view(result.ticket);
      // Fingerprint for delivery consumption: the exact terminal view
      // the model just received — the flush suppresses only an
      // identical repeat (see TicketRpcResult.consumedView).
      const consumedView = isTerminal(result.ticket.status)
        ? view
        : undefined;
      const note =
        result.cause === "question"
          ? `Wait detached: ticket "${result.ticket.id}" is waiting on an answer — ${roster}.`
          : result.cause === "interrupted"
            ? `Wait detached: ${result.interrupted!.length === 1 ? "task" : "tasks"} ${result.interrupted!.map((id) => `"${result.ticket!.id}#${id}"`).join(", ")} ${result.interrupted!.length === 1 ? "was" : "were"} interrupted — ${roster}.`
            : `Resolved on the first watched ticket to settle — ${roster}.`;
      return { text: `${view}\n\n${note}`, isError: false, ticket: result.ticket, note, consumedView };
    }
    const all = call.tickets
      .map((id) => store.get(id)!)
      .map(
        (other) =>
          `"${other.id}" (${statusWord(other)}, ${completedCount(other)}/${other.totalTasks} tasks finished)`,
      )
      .join(", ");
    const text =
      result.cause === "timeout"
        ? `Wait timed out — none of the watched tickets settled; the wait detached, they keep running.\n${all}`
        : result.cause === "aborted"
          ? `Wait detached; the caller aborted the wait.\n${all}`
          : `None of the watched tickets can produce activity here — each is a recovered record owned by another session; poll them for their recorded views.\n${all}`;
    return { text, isError: false };
  }
  if (!ticket) {
    return {
      text: `Ticket '${ticketName ?? ""}' not found. ${knownTickets(store, sessionId)}`,
      isError: true,
    };
  }
  // tail shares poll/wait's read-only reach into recovered records — it
  // observes the recorded outcome or a surviving transcript; it never
  // mutates.
  if (
    ticket.recovered &&
    call.action !== "poll" &&
    call.action !== "wait" &&
    call.action !== "tail"
  ) {
    return {
      text: `Ticket '${ticket.id}' is a recovered ${ticket.status} result; ${call.action} cannot restart or change it.`,
      isError: true,
      ticket,
    };
  }
  switch (call.action) {
    case "poll": {
      const view = store.view(ticket);
      return {
        text: view,
        isError: false,
        ticket,
        consumedView: isTerminal(ticket.status) ? view : undefined,
      };
    }
    case "wait": {
      const { timedOut, aborted, questionPending, interrupted } = await store.wait(
        ticket,
        call.timeoutMs,
        signal,
      );
      const view = store.view(ticket);
      // Same fingerprint as poll: only a terminal view can consume the
      // pending wake — a running/timed-out/detached one never does.
      const consumedView = isTerminal(ticket.status) ? view : undefined;
      const note = questionPending
        ? `Wait detached: answer the pending question before waiting for this ticket.`
        : interrupted.length > 0
          ? `Wait detached: ${interrupted.length === 1 ? "task" : "tasks"} ${interrupted.map((id) => `"${ticket.id}#${id}"`).join(", ")} ${interrupted.length === 1 ? "was" : "were"} interrupted — the ticket is still ${statusWord(ticket)}.`
          : timedOut
            ? `Wait timed out; the ticket is still ${statusWord(ticket)}.`
            : aborted
              ? `Wait detached; the caller aborted the wait. The ticket is still ${statusWord(ticket)}.`
              : undefined;
      return {
        text: note !== undefined ? `${view}\n\n${note}` : view,
        isError: false,
        ticket,
        consumedView,
        ...(note !== undefined ? { note } : {}),
      };
    }
    case "cancel":
      return { text: store.cancel(ticket, call.force), isError: false, ticket };
    case "pause":
      try {
        return { text: store.pause(ticket), isError: false, ticket };
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true, ticket };
      }
    case "resume":
      try {
        return { text: store.resume(ticket), isError: false, ticket };
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true, ticket };
      }
    case "answer":
      try {
        return { text: store.answer(ticket, taskId!, call.questionId!, call.answer!), isError: false, ticket };
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true, ticket };
      }
    case "tail":
      return store.tail(ticket, taskId, call.offset, call.waitMs, signal);
  }
}

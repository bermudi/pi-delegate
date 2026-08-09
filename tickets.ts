import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ASYNC_TICKET_TTL_MS } from "./constants.ts";
import {
  fmtDuration,
  fmtTokens,
  formatCompletedTask,
  formatTaskId,
  shortenPath,
  trunc,
  getActivityAge,
  formatActivityLabel,
  taskMetaBase,
  relativeTouchedSummary,
  findTouchedOverlaps,
  formatTouchedOverlapWarning,
} from "./format.ts";
import { renderOutputForPoll } from "./spill.ts";
import { scheduleDeadline } from "./timer.ts";
import { emptyUsage } from "./usage.ts";
import type {
  AsyncTicket,
  DelegateDetails,
  ResolvedTask,
  TaskResult,
  TicketWaiter,
} from "./types.ts";

const PENDING_RESULT_ERROR = "PENDING — result not available";

const busyTicketIdsBySession = new Map<string, Set<string>>();
const busySessionsByTicket = new Map<string, Set<string>>();

function sessionIdsFor(ticket: AsyncTicket): string[] {
  return ticket.resolved
    .map((t) => t.sessionId)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

function removeTicketBusySessions(ticketId: string): void {
  const sessions = busySessionsByTicket.get(ticketId);
  if (!sessions) return;
  for (const sessionId of sessions) {
    const ticketIds = busyTicketIdsBySession.get(sessionId);
    ticketIds?.delete(ticketId);
    if (ticketIds?.size === 0) busyTicketIdsBySession.delete(sessionId);
  }
  busySessionsByTicket.delete(ticketId);
}

/** Add/remove a ticket's session IDs from the O(1) busy index. */
export function syncTicketBusyIndex(ticket: AsyncTicket): void {
  removeTicketBusySessions(ticket.id);
  if (ticket.status !== "running" && ticket.status !== "cancelling") return;
  const sids = new Set<string>();
  for (const sid of sessionIdsFor(ticket)) {
    const ticketIds = busyTicketIdsBySession.get(sid) ?? new Set<string>();
    ticketIds.add(ticket.id);
    busyTicketIdsBySession.set(sid, ticketIds);
    sids.add(sid);
  }
  if (sids.size) busySessionsByTicket.set(ticket.id, sids);
}

class TicketRegistry extends Map<string, AsyncTicket> {
  set(key: string, value: AsyncTicket): this {
    super.set(key, value);
    syncTicketBusyIndex(value);
    return this;
  }

  delete(key: string): boolean {
    const ok = super.delete(key);
    if (ok) removeTicketBusySessions(key);
    return ok;
  }

  clear(): void {
    super.clear();
    busyTicketIdsBySession.clear();
    busySessionsByTicket.clear();
  }
}

export const ticketRegistry = new TicketRegistry();

/** Generate a short human-copyable identifier for an async ticket. */
export function generateTicketId(): string {
  // 8-char alphanumeric, no lookalikes
  return Math.random().toString(36).slice(2, 10);
}

/** Remove completed tickets after their retention TTL. Running tickets have no
 * wall-clock deadline: per-task stall detection owns failed-agent handling. */
export function sweepTickets(): void {
  const now = Date.now();
  for (const [id, ticket] of ticketRegistry) {
    // TTL cleanup for completed/failed/cancelled
    if (
      ticket.status !== "running" &&
      ticket.status !== "cancelling" &&
      ticket.completedAt &&
      now - ticket.completedAt > ASYNC_TICKET_TTL_MS
    ) {
      ticketRegistry.delete(id);
    }
  }
}

/**
 * Finalize an active ticket during host shutdown and resolve any blocking
 * waiters. This intentionally does not send a follow-up: the host is exiting.
 */
export function cancelTicketForShutdown(ticket: AsyncTicket): void {
  if (ticket.status !== "running" && ticket.status !== "cancelling") return;
  ticket.controller.abort();
  ticket.status = "cancelled";
  ticket.completedAt = Date.now();
  syncTicketBusyIndex(ticket);
  settleTicketWaiters(ticket);
}

/** Check if any running async ticket holds a given sessionId.
 *  Backed by an O(1) map updated when tickets start/complete. */
export function isSessionBusy(sessionId: string): string | null {
  return busyTicketIdsBySession.get(sessionId)?.values().next().value ?? null;
}

/**
 * Determine the final status for a ticket whose task batch has settled.
 *
 * A ticket is "done" only when every task settled successfully. A
 * partially-settled ticket (e.g. aborted mid-flight, leaving some progress
 * rows still "running"/"pending") is "failed" — never "done" — so incomplete
 * work is never masked as complete. Any ticket with at least one failed task
 * is also "failed".
 *
 * Callers are expected to have already handled "cancelled" / "cancelling"
 * (set by handleCancel) before invoking this; those paths set `ticket.status`
 * directly and skip this function via the `if (ticket.status === "running")`
 * guard in execute().
 */
export function resolveFinalTicketStatus(
  ticket: AsyncTicket,
): "done" | "failed" {
  const anyFailed = ticket.results.some((r) => r && "error" in r && r.error);
  const allSettled = ticket.progress.every(
    (p) => p.status === "done" || p.status === "failed",
  );
  if (allSettled && !anyFailed) return "done";
  return "failed";
}

/** Format a completed ticket for LLM consumption. Reuses sync result formatting. */
export function formatCompletedTicket(
  ticket: AsyncTicket,
): AgentToolResult<DelegateDetails> {
  const parts: string[] = [];
  const succeeded = ticket.results.filter(
    (r) => r && !("error" in r && r.error),
  ).length;
  const elapsedTotal = ticket.completedAt
    ? ticket.completedAt - ticket.created
    : 0;
  // Surface the overall ticket status so a failed/cancelled batch is not
  // mistaken for success. "done" tickets keep the original header; others
  // get an explicit status tag up front.
  const statusTag =
    ticket.status === "done" ? "" : `${ticket.status.toUpperCase()} · `;
  const completionLabel =
    ticket.status === "cancelled"
      ? "tasks completed before abort"
      : "tasks completed";
  parts.push(
    `${statusTag}${succeeded}/${ticket.results.length} ${completionLabel} · ${fmtDuration(elapsedTotal)} wall time\n`,
  );

  const pendingLabelFor = (index: number): string => {
    if (ticket.status !== "cancelled") {
      return "PENDING — result not available";
    }
    return ticket.progress[index]?.status === "pending"
      ? "CANCELLED — task not started"
      : "CANCELLED — task aborted mid-run, partial effects possible";
  };

  for (let i = 0; i < ticket.results.length; i++) {
    const r = ticket.results[i];
    const t = ticket.resolved[i]!;
    if (!r) {
      parts.push(
        `=== ${t.agentName}${formatTaskId(t.id)}: ${trunc(t.prompt || "", 80)} ===`,
      );
      parts.push(`[${pendingLabelFor(i)}]`);
      continue;
    }
    parts.push(...formatCompletedTask(t, r));
  }

  const completedResults = ticket.results.filter(
    (r): r is TaskResult => r !== undefined && "touchedFiles" in r,
  );
  const overlapWarning = formatTouchedOverlapWarning(
    findTouchedOverlaps(completedResults),
  );
  if (overlapWarning) parts.push("", overlapWarning);

  if (ticket.status === "cancelled") {
    parts.push(
      "",
      "WARNING: Cancellation stopped the remaining work. Files already written or shell commands already executed by the subagents were NOT rolled back. Review the touched files and session files above before deciding whether to retry.",
    );
  }

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    details: {
      tasks: ticket.tasks,
      results: [...ticket.results].map(
        (r, index) =>
          r ?? {
            ...pendingResultPlaceholder(ticket.resolved[index]),
            error: pendingLabelFor(index),
          },
      ),
      progress: [...ticket.progress],
      parentModel: ticket.parentModelId,
      // Thread ticketId so renderResult can show the running-ticket banner and
      // the human sees which ticket they polled, even in the rich tree path.
      ticketId: ticket.id,
      status: ticket.status,
      overlapWarning: overlapWarning || undefined,
    },
  };
}

// ── Waiter helpers ─────────────────────────────────────────────────────────

function pendingResultPlaceholder(task: ResolvedTask | undefined): TaskResult {
  return {
    id: task?.id,
    agent: task?.agentName ?? "unknown",
    output: "",
    durationMs: 0,
    tokens: 0,
    usage: emptyUsage(),
    touchedFiles: [],
    attributedFiles: [],
    // Machine-visible and human-readable marker so structured consumers do not
    // mistake a pending placeholder for a successful result.
    error: PENDING_RESULT_ERROR,
  };
}

function buildWaitDetails(ticket: AsyncTicket): DelegateDetails {
  const completedResults = ticket.results.filter(
    (r): r is TaskResult => r !== undefined && "touchedFiles" in r,
  );
  const overlapWarning = formatTouchedOverlapWarning(
    findTouchedOverlaps(completedResults),
  );
  const results: TaskResult[] = [];
  for (let i = 0; i < ticket.resolved.length; i++) {
    const r = ticket.results[i];
    results.push(r ?? pendingResultPlaceholder(ticket.resolved[i]));
  }
  return {
    tasks: ticket.tasks,
    results,
    progress: [...ticket.progress],
    parentModel: ticket.parentModelId,
    ticketId: ticket.id,
    status: ticket.status,
    overlapWarning: overlapWarning || undefined,
  };
}

function buildWaitRunningUpdate(
  ticket: AsyncTicket,
): AgentToolResult<DelegateDetails> {
  const total = ticket.progress.length;
  const done = ticket.progress.filter((p) => p.status === "done").length;
  const failed = ticket.progress.filter((p) => p.status === "failed").length;
  const running = ticket.progress.filter((p) => p.status === "running").length;
  const pending = ticket.progress.filter((p) => p.status === "pending").length;
  const finalized = done + failed;

  const parts: string[] = [
    `Waiting for ticket ${ticket.id}: ${ticket.status.toUpperCase()}`,
  ];
  parts.push(`${finalized}/${total} finalized`);
  if (running > 0) parts.push(`${running} active`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} queued`);

  const details = buildWaitDetails(ticket);
  const text =
    parts.join(" · ") +
    (details.overlapWarning ? `\n\n${details.overlapWarning}` : "");
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function buildWaitTimeoutResult(
  ticket: AsyncTicket,
  timeoutMs: number,
): AgentToolResult<DelegateDetails> {
  const details = buildWaitDetails(ticket);
  const base = `Ticket ${ticket.id} still ${ticket.status} after ${fmtDuration(timeoutMs)} · wait timed out (ticket continues in background)`;
  const text =
    base + (details.overlapWarning ? `\n\n${details.overlapWarning}` : "");
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function buildWaitAbortResult(
  ticket: AsyncTicket,
): AgentToolResult<DelegateDetails> {
  const details = buildWaitDetails(ticket);
  const base = `Wait for ticket ${ticket.id} aborted · ticket continues ${ticket.status} in the background`;
  const text =
    base + (details.overlapWarning ? `\n\n${details.overlapWarning}` : "");
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function settleWaiter(
  w: TicketWaiter,
  result: AgentToolResult<DelegateDetails>,
): void {
  if (w.settled) return;
  w.settled = true;
  w.clearDeadline?.();
  w.resolve(result);
}

function abortWaiter(w: TicketWaiter, ticket: AsyncTicket): void {
  settleWaiter(w, buildWaitAbortResult(ticket));
}

function timeoutWaiter(
  w: TicketWaiter,
  ticket: AsyncTicket,
  timeoutMs: number,
): void {
  // If the ticket became terminal (e.g. completed or cancelled just before
  // this timer fired), return that snapshot. Workers may still be unwinding, so
  // waiting for deliverTicketResults here could strand the caller indefinitely.
  sweepTickets();
  if (ticket.status !== "running" && ticket.status !== "cancelling") {
    settleWaiter(w, formatCompletedTicket(ticket));
    return;
  }
  settleWaiter(w, buildWaitTimeoutResult(ticket, timeoutMs));
}

/** Schedule a waiter timeout in clamp-safe chunks, so the host timer clamp
 *  cannot turn a multi-week (or longer) wait into an immediate timeout. */
function scheduleWaitTimeout(
  w: TicketWaiter,
  ticket: AsyncTicket,
  timeoutMs: number,
): void {
  const deadline = Date.now() + timeoutMs;
  w.clearDeadline = scheduleDeadline(deadline, () =>
    timeoutWaiter(w, ticket, timeoutMs),
  );
}

function cleanWaiters(ticket: AsyncTicket): void {
  if (!ticket.waiters) return;
  const active = ticket.waiters.filter((w) => !w.settled && !w.signal?.aborted);
  ticket.waiters = active.length ? active : undefined;
}

/** Resolve active waiters for a terminal ticket. Returns whether any waiter was
 * resolved, so callers can avoid also delivering a duplicate follow-up. */
function settleTicketWaiters(ticket: AsyncTicket): boolean {
  if (!ticket.waiters?.length) return false;

  const formatted = formatCompletedTicket(ticket);
  let hadActive = false;
  for (const w of ticket.waiters) {
    if (w.settled || w.signal?.aborted) continue;
    settleWaiter(w, formatted);
    hadActive = true;
  }
  cleanWaiters(ticket);
  return hadActive;
}

/** Forward current progress to all active blocking waiters. Called whenever an
 *  async task reports a progress or status change. */
export function notifyWaiters(ticket: AsyncTicket): void {
  if (!ticket.waiters?.length) return;
  // Progress frames make sense while the ticket is running or cancelling.
  // Terminal tickets (done/failed/cancelled) are resolved by deliverTicketResults.
  if (ticket.status !== "running" && ticket.status !== "cancelling") return;
  const active: TicketWaiter[] = [];
  for (const w of ticket.waiters) {
    if (w.settled) continue;
    if (w.signal?.aborted) {
      abortWaiter(w, ticket);
      continue;
    }
    active.push(w);
    if (w.onUpdate) w.onUpdate(buildWaitRunningUpdate(ticket));
  }
  ticket.waiters = active.length ? active : undefined;
}

/** Push results into parent session via sendMessage when background ticket completes.
 *  If there are active blocking waiters, resolve them directly and suppress the
 *  automatic follow-up so completion is delivered exactly once. */
export function deliverTicketResults(
  pi: ExtensionAPI,
  ticket: AsyncTicket,
): void {
  if (!ticket.completedAt) return;

  // Resolve active blocking waiters directly. Stale/aborted waiters are
  // cleaned but not resolved here (their abort handlers already returned).
  if (settleTicketWaiters(ticket)) return;

  const formatted = formatCompletedTicket(ticket);
  const text = formatted.content
    .filter(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n");

  pi.sendMessage(
    {
      customType: "async_delegate_result",
      content: text,
      display: true,
      details: {
        ...formatted.details,
        ticketId: ticket.id,
        status: ticket.status,
      },
    },
    {
      deliverAs: "steer",
      triggerTurn: true,
    },
  );
}

/** Return a snapshot of one async ticket or the complete ticket roster. */
export function handlePoll(
  params: { ticket?: string },
  ctx: ExtensionContext,
): AgentToolResult<DelegateDetails> {
  sweepTickets();
  const parentModelId = ctx.model?.id;

  // Only use top-level ticket param — per-task prompt is NOT a ticket ID
  const ticketId = params.ticket;

  // No ticket specified — list all
  if (!ticketId) {
    const tickets = [...ticketRegistry.values()];
    if (!tickets.length) {
      return {
        content: [
          {
            type: "text",
            text: [
              "No async tickets.",
              "",
              "To spawn a subagent: delegate({ tasks: [{ agent, prompt }] }).",
              "For the full manual and agent list, call delegate({ tasks: [] }) with no top-level `ticketAction`.",
            ].join("\n"),
          },
        ],
        details: {
          tasks: [],
          results: [],
          progress: [],
          parentModel: parentModelId,
        },
      };
    }
    const lines = tickets.map((t) => {
      const icon =
        t.status === "running" || t.status === "cancelling"
          ? "⏳"
          : t.status === "done"
            ? "✓"
            : "✗";
      const done = t.progress.filter((p) => p.status === "done").length;
      const age = fmtDuration(Date.now() - t.created);
      // Agent roster — compact, deduplicated (a ticket may run the same agent
      // several times). Helps a human tell tickets apart at a glance.
      const agentSet = [
        ...new Set(t.progress.map((p) => p.agent).filter(Boolean)),
      ];
      const agents = agentSet.length
        ? ` · ${agentSet.slice(0, 3).join(", ")}${agentSet.length > 3 ? ` +${agentSet.length - 3}` : ""}`
        : "";
      let line = `${icon} ${t.id}${agents} · ${done}/${t.progress.length} tasks · ${t.status} · ${age}`;
      // Copy-pasteable controls for running/cancelling tickets — a human can grab these
      // straight out of the TUI without retyping the ticket id.
      if (t.status === "running" || t.status === "cancelling") {
        line += `\n     poll:   delegate({ ticketAction: "poll", ticket: "${t.id}" })`;
        if (t.status === "running") {
          line += `\n     cancel: delegate({ ticketAction: "cancel", ticket: "${t.id}", force: true })`;
        }
      }
      return line;
    });
    return {
      content: [{ type: "text", text: `Async tickets:\n${lines.join("\n")}` }],
      details: {
        tasks: [],
        results: [],
        progress: [],
        parentModel: parentModelId,
      },
    };
  }

  // Specific ticket
  const ticket = ticketRegistry.get(ticketId);
  if (!ticket) {
    return {
      content: [
        {
          type: "text",
          text: `Ticket '${ticketId}' not found. It may have expired or never existed.`,
        },
      ],
      details: {
        tasks: [],
        results: [],
        progress: [],
        parentModel: parentModelId,
      },
    };
  }

  if (ticket.status === "running" || ticket.status === "cancelling") {
    const failedCount = ticket.progress.filter(
      (p) => p.status === "failed",
    ).length;
    // Settled = done + failed. Used for the "all finished" guidance check.
    const settledCount = ticket.progress.filter(
      (p) => p.status === "done" || p.status === "failed",
    ).length;
    const totalCount = ticket.progress.length;
    const runningCount = ticket.progress.filter(
      (p) => p.status === "running",
    ).length;
    const pendingCount = ticket.progress.filter(
      (p) => p.status === "pending",
    ).length;
    const totalTools = ticket.progress.reduce((sum, p) => sum + p.toolUses, 0);
    const totalTokens = ticket.progress.reduce((sum, p) => sum + p.tokens, 0);
    const lines: string[] = [];
    // Index-aligned sparse array — same shape as ticket.results, so consumers
    // can correlate results[i] with progress[i] and tasks[i].
    const completedResults: (TaskResult | undefined)[] = new Array(
      ticket.progress.length,
    ).fill(undefined);

    for (let i = 0; i < ticket.progress.length; i++) {
      const p = ticket.progress[i]!;
      const r = ticket.results[i];

      if (p.status === "done" && r) {
        const meta = taskMetaBase(r);
        if (r.touchedFiles.length > 0) {
          const t = ticket.resolved[i]!;
          const touched = relativeTouchedSummary(r.touchedFiles, t.cwd);
          if (touched) meta.push(`touched (best-effort): ${touched}`);
        }
        lines.push(`✓ ${r.agent}${formatTaskId(r.id)} · ${meta.join(" · ")}`);
        if (r.output && r.output !== "(no output)") {
          lines.push(renderOutputForPoll(r.output));
        }
        completedResults[i] = r;
      } else if (p.status === "failed" && r) {
        const meta = taskMetaBase(r);
        if (r.touchedFiles.length > 0) {
          const t = ticket.resolved[i]!;
          const touched = relativeTouchedSummary(r.touchedFiles, t.cwd);
          if (touched) meta.push(`touched (best-effort): ${touched}`);
        }
        const errorText = r.error ?? "unknown error";
        lines.push(
          `✗ ${r.agent}${formatTaskId(r.id)} · ${errorText} · ${meta.join(" · ")}`,
        );
        if (r.sessionFile)
          lines.push(`  session: ${shortenPath(r.sessionFile)}`);
        if (r.output && r.output !== "(no output)")
          lines.push(renderOutputForPoll(r.output));
        completedResults[i] = r;
      } else if (p.status === "running") {
        const parts: string[] = [formatActivityLabel(p)];
        if (p.toolUses > 0)
          parts.push(`${p.toolUses} tool${p.toolUses === 1 ? "" : "s"}`);
        if (p.tokens > 0) parts.push(`${fmtTokens(p.tokens)} tokens`);
        const age = getActivityAge(p.lastActivityAt);
        if (age) parts.push(age);
        lines.push(`⏳ ${p.agent}${formatTaskId(p.id)} · ${parts.join(" · ")}`);
      } else {
        lines.push(`○ ${p.agent}${formatTaskId(p.id)} · waiting…`);
      }
    }

    const completedForOverlap = completedResults.filter(
      (r): r is TaskResult => r !== undefined,
    );
    const overlapWarning = formatTouchedOverlapWarning(
      findTouchedOverlaps(completedForOverlap),
    );

    const headerStatus =
      ticket.status === "cancelling" ? "CANCELLING" : "RUNNING";
    const headerParts: string[] = [
      `Ticket ${ticket.id}: ${headerStatus}`,
      `${settledCount}/${totalCount} finalized`,
    ];
    if (runningCount > 0) headerParts.push(`${runningCount} active`);
    if (pendingCount > 0) headerParts.push(`${pendingCount} queued`);
    if (failedCount > 0) headerParts.push(`${failedCount} failed`);
    headerParts.push(`${totalTools} tool${totalTools === 1 ? "" : "s"}`);
    headerParts.push(`${fmtTokens(totalTokens)} tokens`);
    headerParts.push(`(${fmtDuration(Date.now() - ticket.created)})`);
    const header = headerParts.join(" · ");
    const guidance =
      ticket.status === "cancelling"
        ? "Cancellation requested. Active subagents are aborting and returning partial results; poll again for the final status."
        : settledCount === totalCount
          ? ""
          : settledCount > 0
            ? "Tasks are progressing. Do other work while remaining tasks finish — results will be delivered automatically when all complete."
            : "Tasks are still running. Do other work while you wait — polling again immediately will not speed them up. Results are delivered automatically when all tasks complete.";

    return {
      content: [
        {
          type: "text",
          text: `${header}\n${lines.join("\n")}${guidance ? `\n\n${guidance}` : ""}${overlapWarning ? `\n\n${overlapWarning}` : ""}`,
        },
      ],
      details: {
        tasks: ticket.tasks,
        results: completedResults.map(
          (r, i) => r ?? pendingResultPlaceholder(ticket.resolved[i]),
        ),
        progress: [...ticket.progress],
        parentModel: ticket.parentModelId,
        // Thread ticketId so the rich renderResult path shows the ticket banner
        // (friction #2). The LLM-facing content still names the ticket id too.
        ticketId: ticket.id,
        status: ticket.status,
        overlapWarning: overlapWarning || undefined,
      },
    };
  }

  // Done / Failed / Cancelled — full results
  return formatCompletedTicket(ticket);
}

function buildCancelPreview(ticket: AsyncTicket): string {
  const finalized = ticket.progress.filter(
    (p) => p.status === "done" || p.status === "failed",
  ).length;
  const running = ticket.progress.filter((p) => p.status === "running").length;
  const pending = ticket.progress.filter((p) => p.status === "pending").length;
  const lines: string[] = [
    `Ticket ${ticket.id}: cancellation preview`,
    `${finalized}/${ticket.progress.length} finalized · ${running} active · ${pending} queued`,
  ];

  for (let i = 0; i < ticket.progress.length; i++) {
    const p = ticket.progress[i]!;
    if (p.status === "done") {
      lines.push(`✓ ${p.agent}${formatTaskId(p.id)} · completed`);
    } else if (p.status === "failed") {
      lines.push(`✗ ${p.agent}${formatTaskId(p.id)} · ${p.error ?? "failed"}`);
    } else if (p.status === "running") {
      const parts: string[] = [formatActivityLabel(p)];
      if (p.toolUses > 0)
        parts.push(`${p.toolUses} tool${p.toolUses === 1 ? "" : "s"}`);
      if (p.tokens > 0) parts.push(`${fmtTokens(p.tokens)} tokens`);
      const age = getActivityAge(p.lastActivityAt);
      if (age) parts.push(age);
      lines.push(`⏳ ${p.agent}${formatTaskId(p.id)} · ${parts.join(" · ")}`);
    } else {
      lines.push(`○ ${p.agent}${formatTaskId(p.id)} · waiting…`);
    }
  }

  lines.push(
    "",
    "WARNING: Cancelling now will abort active subagents. Files already written or shell commands already executed are NOT rolled back.",
    `To proceed, call delegate({ ticketAction: "cancel", ticket: "${ticket.id}", force: true }).`,
  );
  return lines.join("\n");
}

/** Preview or request cancellation of a running async ticket. */
export function handleCancel(params: {
  ticket?: string;
  force?: boolean;
}): AgentToolResult<DelegateDetails> {
  sweepTickets();
  const ticketId = params.ticket;

  if (!ticketId) {
    return {
      content: [
        { type: "text", text: "ticketAction='cancel' requires a ticket ID." },
      ],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  const ticket = ticketRegistry.get(ticketId);
  if (!ticket) {
    return {
      content: [{ type: "text", text: `Ticket '${ticketId}' not found.` }],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  if (ticket.status !== "running") {
    return {
      content: [
        {
          type: "text",
          text: `Ticket '${ticketId}' is already ${ticket.status}.`,
        },
      ],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  if (!params.force) {
    const details = buildWaitDetails(ticket);
    const text =
      buildCancelPreview(ticket) +
      (details.overlapWarning ? `\n\n${details.overlapWarning}` : "");
    return {
      content: [{ type: "text", text }],
      details,
    };
  }
  ticket.controller.abort();
  ticket.status = "cancelling";
  syncTicketBusyIndex(ticket);
  const details = buildWaitDetails(ticket);
  const base = `Ticket '${ticketId}' is cancelling; workers are settling. Poll for final status.`;
  const text =
    base + (details.overlapWarning ? `\n\n${details.overlapWarning}` : "");
  return {
    content: [{ type: "text", text }],
    details,
  };
}

/** Block until a ticket reaches a terminal state or `timeoutMs` expires.
 *  Progress is streamed through `onUpdate` without consuming model turns.
 *  Parent-tool abort or timeout detaches the waiter and leaves the ticket
 *  running; cancellation remains explicit (`ticketAction: "cancel"`). */
export function handleWait(
  params: { ticket?: string; timeoutMs?: number },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<DelegateDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<DelegateDetails>> {
  sweepTickets();
  const parentModelId = ctx.model?.id;

  const ticketId = params.ticket;
  if (!ticketId) {
    return Promise.resolve({
      content: [
        { type: "text", text: "ticketAction='wait' requires a ticket ID." },
      ],
      details: {
        tasks: [],
        results: [],
        progress: [],
        parentModel: parentModelId,
      },
    });
  }

  const ticket = ticketRegistry.get(ticketId);
  if (!ticket) {
    return Promise.resolve({
      content: [{ type: "text", text: `Ticket '${ticketId}' not found.` }],
      details: {
        tasks: [],
        results: [],
        progress: [],
        parentModel: parentModelId,
      },
    });
  }

  if (ticket.status !== "running" && ticket.status !== "cancelling") {
    return Promise.resolve(formatCompletedTicket(ticket));
  }

  // Already aborted parent signal → detach immediately.
  if (signal?.aborted) {
    return Promise.resolve(buildWaitAbortResult(ticket));
  }

  return new Promise((resolve, reject) => {
    const waiter: TicketWaiter = {
      signal,
      onUpdate,
      resolve,
      reject,
      settled: false,
    };

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          abortWaiter(waiter, ticket);
        },
        { once: true },
      );
    }

    if (
      params.timeoutMs !== undefined &&
      params.timeoutMs >= 0 &&
      Number.isFinite(params.timeoutMs)
    ) {
      scheduleWaitTimeout(waiter, ticket, params.timeoutMs);
    }

    ticket.waiters = ticket.waiters ?? [];
    ticket.waiters.push(waiter);

    // Immediate progress frame so the TUI shows the current state.
    notifyWaiters(ticket);
  });
}

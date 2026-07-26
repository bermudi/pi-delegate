import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { ASYNC_MAX_RUNTIME_MS, ASYNC_TICKET_TTL_MS } from "./constants.ts";
import {
  fmtDuration,
  fmtTokens,
  formatCompletedTask,
  shortenPath,
  trunc,
  getActivityAge,
  formatActivityLabel,
  taskMetaBase,
  relativeTouchedSummary,
} from "./format.ts";
import { renderOutputForPoll } from "./spill.ts";
import type { AsyncTicket, DelegateDetails, TaskResult } from "./types.ts";

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
  if (ticket.status !== "running") return;
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

export function generateTicketId(): string {
  // 8-char alphanumeric, no lookalikes
  return Math.random().toString(36).slice(2, 10);
}

/** Abort and remove tickets that exceeded runtime or TTL. */
export function sweepTickets(): void {
  const now = Date.now();
  for (const [id, ticket] of ticketRegistry) {
    // Hard runtime timeout
    if (
      ticket.status === "running" &&
      now - ticket.created > ASYNC_MAX_RUNTIME_MS
    ) {
      ticket.controller.abort();
      ticket.status = "failed";
      ticket.error = "Exceeded maximum runtime";
      ticket.completedAt = now;
      syncTicketBusyIndex(ticket);
    }
    // TTL cleanup for completed/failed/cancelled
    if (
      ticket.status !== "running" &&
      ticket.completedAt &&
      now - ticket.completedAt > ASYNC_TICKET_TTL_MS
    ) {
      ticketRegistry.delete(id);
    }
  }
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
 * Callers are expected to have already handled "cancelled" (set by
 * handleCancel) and the runtime timeout (set by sweepTickets) before invoking
 * this; those paths set `ticket.status` directly and skip this function via
 * the `if (ticket.status === "running")` guard in execute().
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
  parts.push(
    `${statusTag}${succeeded}/${ticket.results.length} tasks completed · ${fmtDuration(elapsedTotal)} wall time\n`,
  );

  for (let i = 0; i < ticket.results.length; i++) {
    const r = ticket.results[i];
    const t = ticket.resolved[i]!;
    if (!r) {
      parts.push(`=== ${t.agentName}: ${trunc(t.prompt || "", 80)} ===`);
      parts.push(`[PENDING — result not available]`);
      continue;
    }
    parts.push(...formatCompletedTask(t, r));
  }

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    details: {
      tasks: ticket.tasks,
      results: [...ticket.results].map(
        (r) => r ?? { error: "PENDING — result not available" },
      ),
      progress: [...ticket.progress],
      parentModel: ticket.parentModelId,
      // Thread ticketId so renderResult can show the running-ticket banner and
      // the human sees which ticket they polled, even in the rich tree path.
      ticketId: ticket.id,
    },
  };
}

/** Push results into parent session via sendMessage when background ticket completes. */
export function deliverTicketResults(
  pi: ExtensionAPI,
  ticket: AsyncTicket,
): void {
  if (!ticket.completedAt) return;

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
              "For the full manual and agent list, call delegate({ tasks: [] }) with no top-level `action`.",
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
        t.status === "running" ? "⏳" : t.status === "done" ? "✓" : "✗";
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
      // Copy-pasteable controls for running tickets — a human can grab these
      // straight out of the TUI without retyping the ticket id.
      if (t.status === "running") {
        line += `\n     poll:   delegate({ action: "poll", ticket: "${t.id}" })`;
        line += `\n     cancel: delegate({ action: "cancel", ticket: "${t.id}" })`;
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

  if (ticket.status === "running") {
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
          if (touched) meta.push(`touched: ${touched}`);
        }
        lines.push(`✓ ${r.agent} · ${meta.join(" · ")}`);
        if (r.output && r.output !== "(no output)") {
          lines.push(renderOutputForPoll(r.output));
        }
        completedResults[i] = r;
      } else if (p.status === "failed" && r) {
        lines.push(`✗ ${r.agent} · ${r.error ?? "unknown error"}`);
        if (r.sessionFile)
          lines.push(`  session: ${shortenPath(r.sessionFile)}`);
        if (r.output) lines.push(renderOutputForPoll(r.output));
        completedResults[i] = r;
      } else if (p.status === "running") {
        const parts: string[] = [formatActivityLabel(p)];
        if (p.toolUses > 0)
          parts.push(`${p.toolUses} tool${p.toolUses === 1 ? "" : "s"}`);
        if (p.tokens > 0) parts.push(`${fmtTokens(p.tokens)} tokens`);
        const age = getActivityAge(p.lastActivityAt);
        if (age) parts.push(age);
        lines.push(`⏳ ${p.agent} · ${parts.join(" · ")}`);
      } else {
        lines.push(`○ ${p.agent} · waiting…`);
      }
    }

    const headerParts: string[] = [
      `Ticket ${ticket.id}: RUNNING`,
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
      settledCount === totalCount
        ? ""
        : settledCount > 0
          ? "Tasks are progressing. Do other work while remaining tasks finish — results will be delivered automatically when all complete."
          : "Tasks are still running. Do other work while you wait — polling again immediately will not speed them up. Results are delivered automatically when all tasks complete.";

    return {
      content: [
        {
          type: "text",
          text: `${header}\n${lines.join("\n")}${guidance ? `\n\n${guidance}` : ""}`,
        },
      ],
      details: {
        tasks: ticket.tasks,
        results: completedResults.map(
          (r) => r ?? { error: "PENDING — result not available" },
        ),
        progress: [...ticket.progress],
        parentModel: ticket.parentModelId,
        // Thread ticketId so the rich renderResult path shows the ticket banner
        // (friction #2). The LLM-facing content still names the ticket id too.
        ticketId: ticket.id,
      },
    };
  }

  // Done / Failed / Cancelled — full results
  return formatCompletedTicket(ticket);
}

export function handleCancel(params: {
  ticket?: string;
}): AgentToolResult<DelegateDetails> {
  sweepTickets();
  const ticketId = params.ticket;

  if (!ticketId) {
    return {
      content: [
        { type: "text", text: "action='cancel' requires a ticket ID." },
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
  ticket.controller.abort();
  ticket.status = "cancelled";
  ticket.completedAt = Date.now();
  syncTicketBusyIndex(ticket);
  return {
    content: [{ type: "text", text: `Ticket '${ticketId}' cancelled.` }],
    details: { tasks: [], results: [], progress: [] },
  };
}

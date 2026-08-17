import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  fmtDuration,
  fmtTokens,
  formatTaskId,
  shortenPath,
  getActivityAge,
  formatActivityLabel,
  taskMetaBase,
  relativeTouchedSummary,
  findTouchedOverlaps,
  formatTouchedOverlapWarning,
} from "./format.ts";
import { renderOutputForPoll } from "./spill.ts";
import type {
  AsyncTicket,
  DelegateDetails,
  ResolvedTask,
  TaskProgress,
  TaskResult,
} from "./types.ts";

/** Discovery hint when poll is called with an empty registry. */
export const EMPTY_TICKET_POLL_TEXT = [
  "No async tickets.",
  "",
  "To spawn a subagent: delegate({ tasks: [{ agent, prompt }] }).",
  "For the full manual and agent list, call delegate({ tasks: [] }) with no top-level `ticketAction`.",
].join("\n");

/** Status glyph for a ticket roster line. */
export function ticketStatusIcon(status: AsyncTicket["status"]): string {
  return status === "running" || status === "cancelling"
    ? "⏳"
    : status === "done"
      ? "✓"
      : "✗";
}

/** Compact, deduplicated agent roster so tickets are distinguishable at a glance. */
export function formatTicketAgentRoster(progress: TaskProgress[]): string {
  const agentSet = [...new Set(progress.map((p) => p.agent).filter(Boolean))];
  if (!agentSet.length) return "";
  return ` · ${agentSet.slice(0, 3).join(", ")}${
    agentSet.length > 3 ? ` +${agentSet.length - 3}` : ""
  }`;
}

/**
 * Copy-pasteable poll/cancel controls for a live ticket. Cancelling tickets
 * keep poll (to watch unwind) but drop cancel (already requested).
 */
export function formatTicketControlSnippets(ticket: AsyncTicket): string {
  if (ticket.status !== "running" && ticket.status !== "cancelling") return "";
  let snippets = `\n     poll:   delegate({ ticketAction: "poll", ticket: "${ticket.id}" })`;
  if (ticket.status === "running") {
    snippets += `\n     cancel: delegate({ ticketAction: "cancel", ticket: "${ticket.id}", force: true })`;
  }
  return snippets;
}

/** One roster line for `delegate({ ticketAction: "poll" })` with no ticket id. */
export function formatTicketRosterLine(
  ticket: AsyncTicket,
  now = Date.now(),
): string {
  const icon = ticketStatusIcon(ticket.status);
  const finalized = ticket.progress.filter(
    (p) => p.status === "done" || p.status === "failed",
  ).length;
  const age = fmtDuration(now - ticket.created);
  return `${icon} ${ticket.id}${formatTicketAgentRoster(ticket.progress)} · ${finalized}/${ticket.progress.length} finalized · ${ticket.status} · ${age}${formatTicketControlSnippets(ticket)}`;
}

/** Full roster listing when poll is called without a ticket id. */
export function formatTicketRoster(
  tickets: AsyncTicket[],
  now = Date.now(),
): string {
  return `Async tickets:\n${tickets.map((t) => formatTicketRosterLine(t, now)).join("\n")}`;
}

export function missingTicketPollText(ticketId: string): string {
  return `Ticket '${ticketId}' not found. It may have expired or never existed.`;
}

/** Running-task line shared by poll snapshots and cancel previews. */
export function formatInFlightTaskLine(p: TaskProgress): string {
  const parts: string[] = [formatActivityLabel(p)];
  if (p.toolUses > 0)
    parts.push(`${p.toolUses} tool${p.toolUses === 1 ? "" : "s"}`);
  if (p.tokens > 0) parts.push(`${fmtTokens(p.tokens)} tokens`);
  const age = getActivityAge(p.lastActivityAt);
  if (age) parts.push(age);
  return `⏳ ${p.agent}${formatTaskId(p.id)} · ${parts.join(" · ")}`;
}

/** Queued-task line shared by poll snapshots and cancel previews. */
export function formatQueuedTaskLine(p: TaskProgress): string {
  return `○ ${p.agent}${formatTaskId(p.id)} · waiting…`;
}

function appendTouchedMeta(
  meta: string[],
  result: TaskResult,
  task: ResolvedTask,
): void {
  if (result.touchedFiles.length === 0) return;
  const touched = relativeTouchedSummary(result.touchedFiles, task.cwd);
  if (touched) meta.push(`touched (best-effort): ${touched}`);
}

function formatSettledPollLines(
  result: TaskResult,
  task: ResolvedTask,
  failed: boolean,
): string[] {
  const meta = taskMetaBase(result);
  appendTouchedMeta(meta, result, task);
  if (!failed) {
    const lines = [
      `✓ ${result.agent}${formatTaskId(result.id)} · ${meta.join(" · ")}`,
    ];
    if (result.output && result.output !== "(no output)") {
      lines.push(renderOutputForPoll(result.output));
    }
    return lines;
  }
  const errorText = result.error ?? "unknown error";
  const lines = [
    `✗ ${result.agent}${formatTaskId(result.id)} · ${errorText} · ${meta.join(" · ")}`,
  ];
  if (result.sessionFile)
    lines.push(`  session: ${shortenPath(result.sessionFile)}`);
  if (result.output && result.output !== "(no output)") {
    lines.push(renderOutputForPoll(result.output));
  }
  return lines;
}

function formatPollTaskLines(
  ticket: AsyncTicket,
  index: number,
): { lines: string[]; result?: TaskResult } {
  const p = ticket.progress[index]!;
  const r = ticket.results[index];
  if (p.status === "done" && r) {
    return {
      lines: formatSettledPollLines(r, ticket.resolved[index]!, false),
      result: r,
    };
  }
  if (p.status === "failed" && r) {
    return {
      lines: formatSettledPollLines(r, ticket.resolved[index]!, true),
      result: r,
    };
  }
  if (p.status === "running") {
    return { lines: [formatInFlightTaskLine(p)] };
  }
  return { lines: [formatQueuedTaskLine(p)] };
}

export function formatLiveTicketHeader(
  ticket: AsyncTicket,
  now = Date.now(),
): string {
  const failedCount = ticket.progress.filter(
    (p) => p.status === "failed",
  ).length;
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
  headerParts.push(`(${fmtDuration(now - ticket.created)})`);
  return headerParts.join(" · ");
}

export function liveTicketGuidance(ticket: AsyncTicket): string {
  if (ticket.status === "cancelling") {
    return "Cancellation requested. Active subagents are aborting and returning partial results. Wait without timeoutMs for final status; do not repeatedly poll.";
  }
  const settledCount = ticket.progress.filter(
    (p) => p.status === "done" || p.status === "failed",
  ).length;
  return settledCount === ticket.progress.length
    ? ""
    : "If you need the final result in this turn, call wait once with timeoutMs omitted. Otherwise stop calling ticket controls and let the final result auto-deliver after this turn; repeated polling will not speed it up.";
}

export interface LiveTicketPollSnapshot {
  text: string;
  completedResults: (TaskResult | undefined)[];
  overlapWarning: string | null;
}

/** LLM-facing live (running/cancelling) ticket snapshot. */
export function formatLiveTicketPoll(
  ticket: AsyncTicket,
  now = Date.now(),
): LiveTicketPollSnapshot {
  const lines: string[] = [];
  const completedResults: (TaskResult | undefined)[] = new Array(
    ticket.progress.length,
  ).fill(undefined);

  for (let i = 0; i < ticket.progress.length; i++) {
    const formatted = formatPollTaskLines(ticket, i);
    lines.push(...formatted.lines);
    if (formatted.result) completedResults[i] = formatted.result;
  }

  const completedForOverlap = completedResults.filter(
    (r): r is TaskResult => r !== undefined,
  );
  const overlapWarning = formatTouchedOverlapWarning(
    findTouchedOverlaps(completedForOverlap),
  );
  const guidance = liveTicketGuidance(ticket);
  return {
    text: `${formatLiveTicketHeader(ticket, now)}\n${lines.join("\n")}${
      guidance ? `\n\n${guidance}` : ""
    }${overlapWarning ? `\n\n${overlapWarning}` : ""}`,
    completedResults,
    overlapWarning,
  };
}

/** Cancel-preview body (without the wait-details overlap appendix). */
export function formatCancelPreview(ticket: AsyncTicket): string {
  const finalized = ticket.progress.filter(
    (p) => p.status === "done" || p.status === "failed",
  ).length;
  const running = ticket.progress.filter((p) => p.status === "running").length;
  const pending = ticket.progress.filter((p) => p.status === "pending").length;
  const lines: string[] = [
    `Ticket ${ticket.id}: cancellation preview`,
    `${finalized}/${ticket.progress.length} finalized · ${running} active · ${pending} queued`,
  ];

  for (const p of ticket.progress) {
    if (p.status === "done") {
      lines.push(`✓ ${p.agent}${formatTaskId(p.id)} · completed`);
    } else if (p.status === "failed") {
      lines.push(`✗ ${p.agent}${formatTaskId(p.id)} · ${p.error ?? "failed"}`);
    } else if (p.status === "running") {
      lines.push(formatInFlightTaskLine(p));
    } else {
      lines.push(formatQueuedTaskLine(p));
    }
  }

  lines.push(
    "",
    "WARNING: Cancelling now will abort active subagents. Files already written or shell commands already executed are NOT rolled back.",
    `To proceed, call delegate({ ticketAction: "cancel", ticket: "${ticket.id}", force: true }).`,
  );
  return lines.join("\n");
}

export function emptyTicketPollResult(
  parentModelId: string | undefined,
): AgentToolResult<DelegateDetails> {
  return {
    content: [{ type: "text", text: EMPTY_TICKET_POLL_TEXT }],
    details: {
      tasks: [],
      results: [],
      progress: [],
      parentModel: parentModelId,
    },
  };
}

export function rosterTicketPollResult(
  tickets: AsyncTicket[],
  parentModelId: string | undefined,
): AgentToolResult<DelegateDetails> {
  return {
    content: [{ type: "text", text: formatTicketRoster(tickets) }],
    details: {
      tasks: [],
      results: [],
      progress: [],
      parentModel: parentModelId,
    },
  };
}

export function missingTicketPollResult(
  ticketId: string,
  parentModelId: string | undefined,
): AgentToolResult<DelegateDetails> {
  return {
    content: [{ type: "text", text: missingTicketPollText(ticketId) }],
    details: {
      tasks: [],
      results: [],
      progress: [],
      parentModel: parentModelId,
    },
  };
}

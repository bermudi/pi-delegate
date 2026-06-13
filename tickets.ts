import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { ASYNC_MAX_RUNTIME_MS, ASYNC_TICKET_TTL_MS } from "./constants.ts";
import {
  fmtDuration,
  fmtTokens,
  formatToolCallShort,
  shortenPath,
  trunc,
} from "./format.ts";
import type { AsyncTicket, DelegateDetails, TaskResult } from "./types.ts";

export const ticketRegistry = new Map<string, AsyncTicket>();

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

/** Check if any running async ticket holds a given sessionId. */
export function isSessionBusy(sessionId: string): string | null {
  for (const ticket of ticketRegistry.values()) {
    if (ticket.status !== "running") continue;
    if (ticket.resolved.some((t) => t.sessionId === sessionId)) {
      return ticket.id;
    }
  }
  return null;
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
  parts.push(
    `${succeeded}/${ticket.results.length} tasks completed · ${fmtDuration(elapsedTotal)} wall time\n`,
  );

  for (let i = 0; i < ticket.results.length; i++) {
    const r = ticket.results[i];
    const t = ticket.resolved[i]!;
    if (!r) {
      parts.push(`=== ${t.agentName}: ${trunc(t.prompt || "", 80)} ===`);
      parts.push(`[PENDING — result not available]`);
      continue;
    }
    parts.push(`=== ${r.agent}: ${trunc(t.prompt || "", 80)} ===`);
    if (t.warnings?.length) {
      for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
    }
    if ("error" in r && r.error) {
      const failParts = [r.error];
      if (r.sessionFile)
        failParts.push(`session: ${shortenPath(r.sessionFile)}`);
      parts.push(`[FAILED: ${failParts.join(" · ")}]`);
      if (r.sessionFile && fs.existsSync(r.sessionFile)) {
        const safePath = JSON.stringify(r.sessionFile);
        parts.push(
          `→ To retry: delegate({ tasks: [{ resumeFrom: ${safePath}, prompt: "continue" }] })`,
        );
      }
    } else {
      const meta = [
        `OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens`,
      ];
      if (r.sessionFile) meta.push(shortenPath(r.sessionFile));
      if (r.touchedFiles.length > 0) {
        const rel = r.touchedFiles
          .map((f) => path.relative(t.cwd, f))
          .filter((f) => f && !f.startsWith(".."));
        if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
      }
      parts.push(`[${meta.join(" · ")}]\n\n${r.output}`);
    }
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
        content: [{ type: "text", text: "No async tickets." }],
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
      return `${icon} ${t.id} · ${done}/${t.progress.length} tasks · ${t.status} · ${age}`;
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
    const doneCount = ticket.progress.filter(
      (p) => p.status === "done" || p.status === "failed",
    ).length;
    const totalCount = ticket.progress.length;
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
        const meta = [
          fmtDuration(r.durationMs),
          `${fmtTokens(r.tokens)} tokens`,
        ];
        if (r.touchedFiles.length > 0) {
          const t = ticket.resolved[i]!;
          const rel = r.touchedFiles
            .map((f) => path.relative(t.cwd, f))
            .filter((f) => f && !f.startsWith(".."));
          if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
        }
        lines.push(`✓ ${r.agent} · ${meta.join(" · ")}`);
        if (r.output && r.output !== "(no output)") {
          lines.push(r.output);
        }
        completedResults[i] = r;
      } else if (p.status === "failed" && r) {
        lines.push(`✗ ${r.agent} · ${r.error ?? "unknown error"}`);
        if (r.sessionFile)
          lines.push(`  session: ${shortenPath(r.sessionFile)}`);
        if (r.output) lines.push(r.output);
        completedResults[i] = r;
      } else if (p.status === "running") {
        const activity = p.activities.findLast((a) => !a.result);
        const currentTool = activity
          ? ` · ${formatToolCallShort(activity.name, activity.args)}`
          : "";
        lines.push(
          `⏳ ${p.agent}${currentTool} · ${fmtDuration(Date.now() - ticket.created)}`,
        );
      } else {
        lines.push(`○ ${p.agent} · waiting…`);
      }
    }

    const header = `Ticket ${ticket.id}: RUNNING · ${doneCount}/${totalCount} done (${fmtDuration(Date.now() - ticket.created)})`;
    const guidance =
      doneCount === totalCount
        ? ""
        : doneCount > 0
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
  return {
    content: [{ type: "text", text: `Ticket '${ticketId}' cancelled.` }],
    details: { tasks: [], results: [], progress: [] },
  };
}

import { describe, expect, test } from "bun:test";
import { fmtDuration, fmtTokens } from "./format.ts";
import { emptyUsage } from "./usage.ts";
import {
  EMPTY_TICKET_POLL_TEXT,
  formatCancelPreview,
  formatInFlightTaskLine,
  formatLiveTicketHeader,
  formatLiveTicketPoll,
  formatQueuedTaskLine,
  formatTicketAgentRoster,
  formatTicketControlSnippets,
  formatTicketRoster,
  formatTicketRosterLine,
  liveTicketGuidance,
  ticketStatusIcon,
} from "./ticket-format.ts";
import type { AsyncTicket, TaskProgress } from "./types.ts";

function mkProgress(
  overrides: Partial<TaskProgress> & Pick<TaskProgress, "agent" | "status">,
): TaskProgress {
  return {
    index: 0,
    task: "t",
    durationMs: 0,
    tokens: 0,
    toolUses: 0,
    activities: [],
    ...overrides,
  };
}

function mkTicket(overrides: Partial<AsyncTicket> = {}): AsyncTicket {
  return {
    id: "abc12345",
    created: 1_000,
    tasks: [],
    resolved: [],
    status: "running",
    results: [],
    progress: [mkProgress({ agent: "scout", status: "running" })],
    controller: new AbortController(),
    ...overrides,
  };
}

describe("ticket roster formatting", () => {
  test("ticketStatusIcon maps live/done/failed", () => {
    expect(ticketStatusIcon("running")).toBe("⏳");
    expect(ticketStatusIcon("cancelling")).toBe("⏳");
    expect(ticketStatusIcon("done")).toBe("✓");
    expect(ticketStatusIcon("failed")).toBe("✗");
    expect(ticketStatusIcon("cancelled")).toBe("✗");
  });

  test("formatTicketAgentRoster dedups and caps at three plus remainder", () => {
    expect(formatTicketAgentRoster([])).toBe("");
    expect(
      formatTicketAgentRoster([
        mkProgress({ agent: "scout", status: "running" }),
        mkProgress({ agent: "scout", status: "done" }),
        mkProgress({ agent: "coder", status: "pending" }),
      ]),
    ).toBe(" · scout, coder");
    expect(
      formatTicketAgentRoster([
        mkProgress({ agent: "a", status: "running" }),
        mkProgress({ agent: "b", status: "running" }),
        mkProgress({ agent: "c", status: "running" }),
        mkProgress({ agent: "d", status: "pending" }),
      ]),
    ).toBe(" · a, b, c +1");
  });

  test("formatTicketControlSnippets are copy-pasteable and omit cancel while cancelling", () => {
    const running = mkTicket({ status: "running" });
    expect(formatTicketControlSnippets(running)).toContain(
      'delegate({ ticketAction: "poll", ticket: "abc12345" })',
    );
    expect(formatTicketControlSnippets(running)).toContain(
      'delegate({ ticketAction: "cancel", ticket: "abc12345", force: true })',
    );
    expect(
      formatTicketControlSnippets(mkTicket({ status: "cancelling" })),
    ).not.toContain("cancel:");
    expect(formatTicketControlSnippets(mkTicket({ status: "done" }))).toBe("");
  });

  test("formatTicketRosterLine includes icon, agents, counts, and age", () => {
    const line = formatTicketRosterLine(
      mkTicket({
        created: 0,
        progress: [
          mkProgress({ agent: "scout", status: "done" }),
          mkProgress({ agent: "coder", status: "running" }),
        ],
      }),
      1_500,
    );
    expect(line).toContain("⏳ abc12345 · scout, coder · 1/2 tasks · running");
    expect(line).toContain(fmtDuration(1_500));
    expect(line).toContain('ticketAction: "poll"');
  });

  test("formatTicketRoster prefixes the listing header", () => {
    expect(formatTicketRoster([mkTicket({ status: "done" })])).toStartWith(
      "Async tickets:\n",
    );
  });

  test("empty poll copy points at spawn and help", () => {
    expect(EMPTY_TICKET_POLL_TEXT).toContain("No async tickets.");
    expect(EMPTY_TICKET_POLL_TEXT).toContain("tasks: [{ agent, prompt }]");
    expect(EMPTY_TICKET_POLL_TEXT).toContain("tasks: []");
  });
});

describe("live ticket poll formatting", () => {
  test("formatInFlightTaskLine includes tools, tokens, and activity", () => {
    const line = formatInFlightTaskLine(
      mkProgress({
        agent: "scout",
        status: "running",
        toolUses: 2,
        tokens: 500,
        lastActivityAt: Date.now(),
      }),
    );
    expect(line).toContain("⏳ scout");
    expect(line).toContain("2 tools");
    expect(line).toContain(`${fmtTokens(500)} tokens`);
  });

  test("formatQueuedTaskLine is a waiting marker", () => {
    expect(
      formatQueuedTaskLine(mkProgress({ agent: "worker", status: "pending" })),
    ).toBe("○ worker · waiting…");
  });

  test("formatLiveTicketHeader uses finalized/active/failed counts", () => {
    const header = formatLiveTicketHeader(
      mkTicket({
        created: 0,
        progress: [
          mkProgress({ agent: "a", status: "done" }),
          mkProgress({ agent: "b", status: "done" }),
          mkProgress({ agent: "c", status: "failed" }),
          mkProgress({ agent: "d", status: "failed" }),
          mkProgress({ agent: "e", status: "running" }),
        ],
      }),
      1_000,
    );
    expect(header).toContain("Ticket abc12345: RUNNING");
    expect(header).toContain("4/5 finalized");
    expect(header).toContain("1 active");
    expect(header).toContain("2 failed");
    expect(header).not.toContain("2/5 finalized");
  });

  test("liveTicketGuidance is empty only when every task has settled", () => {
    expect(
      liveTicketGuidance(
        mkTicket({
          status: "running",
          progress: [mkProgress({ agent: "a", status: "done" })],
        }),
      ),
    ).toBe("");
    expect(
      liveTicketGuidance(
        mkTicket({
          status: "running",
          progress: [mkProgress({ agent: "a", status: "running" })],
        }),
      ),
    ).toContain("call wait once");
    expect(liveTicketGuidance(mkTicket({ status: "cancelling" }))).toContain(
      "Cancellation requested",
    );
  });

  test("formatLiveTicketPoll keeps results index-aligned with progress", () => {
    const ticket = mkTicket({
      resolved: [
        {
          prompt: "a",
          model: {} as never,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          id: "task-b",
          prompt: "b",
          model: {} as never,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "worker",
          warnings: [],
        },
      ],
      results: [
        {
          agent: "scout",
          output: "found it",
          durationMs: 1000,
          tokens: 50,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
        },
        undefined,
      ],
      progress: [
        mkProgress({ agent: "scout", status: "done", tokens: 50, toolUses: 1 }),
        mkProgress({
          agent: "worker",
          id: "task-b",
          status: "running",
          tokens: 100,
          toolUses: 3,
        }),
      ],
    });
    const snapshot = formatLiveTicketPoll(ticket, ticket.created + 1_000);
    expect(snapshot.text).toContain("found it");
    expect(snapshot.text).toContain("worker");
    expect(snapshot.completedResults).toHaveLength(2);
    expect(snapshot.completedResults[0]?.agent).toBe("scout");
    expect(snapshot.completedResults[1]).toBeUndefined();
  });

  test("formatCancelPreview warns and requires force", () => {
    const preview = formatCancelPreview(
      mkTicket({
        progress: [
          mkProgress({ agent: "scout", status: "done" }),
          mkProgress({ agent: "coder", status: "running" }),
          mkProgress({ agent: "reviewer", status: "pending" }),
        ],
      }),
    );
    expect(preview).toContain("Ticket abc12345: cancellation preview");
    expect(preview).toContain("1/3 finalized · 1 active · 1 queued");
    expect(preview).toContain("NOT rolled back");
    expect(preview).toContain(
      'delegate({ ticketAction: "cancel", ticket: "abc12345", force: true })',
    );
  });
});

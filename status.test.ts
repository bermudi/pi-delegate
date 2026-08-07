import { describe, expect, test, afterEach, mock } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cancelTicketForShutdown, ticketRegistry } from "./tickets.ts";
import {
  _resetDelegateStatusForTesting,
  activeTicketSummary,
  buildStatusText,
  clearDelegateStatusContext,
  describeActiveTickets,
  guardSessionReplacement,
  notifyActiveTicketsOnSettled,
  syncDelegateStatus,
} from "./status.ts";
import type { AsyncTicket, TaskProgress } from "./types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function mkProgress(
  statuses: ("pending" | "running" | "done" | "failed")[],
): TaskProgress[] {
  return statuses.map((status, i) => ({
    index: i,
    agent: `agent-${i}`,
    task: `task-${i}`,
    status,
    durationMs: 0,
    tokens: 0,
    toolUses: 0,
    activities: [],
  }));
}

function mkTicket(
  id: string,
  overrides: Partial<AsyncTicket> & {
    progressStatuses?: ("pending" | "running" | "done" | "failed")[];
  } = {},
): AsyncTicket {
  const { progressStatuses, ...rest } = overrides;
  return {
    id,
    created: Date.now(),
    tasks: [],
    resolved: [],
    status: "running",
    results: [],
    progress: mkProgress(progressStatuses ?? ["running"]),
    controller: new AbortController(),
    ...rest,
  };
}

function mkCtx(opts: { hasUI?: boolean; confirmResult?: boolean } = {}) {
  const calls = {
    setStatus: [] as (string | undefined)[],
    notify: [] as { message: string; type?: string }[],
    confirm: [] as { title: string; message: string }[],
  };
  const ctx = {
    hasUI: opts.hasUI ?? true,
    ui: {
      setStatus: mock((key: string, text: string | undefined) => {
        calls.setStatus.push(text);
      }),
      notify: mock((message: string, type?: string) => {
        calls.notify.push({ message, type });
      }),
      confirm: mock((title: string, message: string) => {
        calls.confirm.push({ title, message });
        return Promise.resolve(opts.confirmResult ?? true);
      }),
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

afterEach(() => {
  ticketRegistry.clear();
  _resetDelegateStatusForTesting();
});

// ── Summary + status text ───────────────────────────────────────────────────

describe("activeTicketSummary", () => {
  test("counts only running/cancelling tickets and their live rows", () => {
    ticketRegistry.set(
      "a",
      mkTicket("a", { progressStatuses: ["running", "pending", "done"] }),
    );
    ticketRegistry.set(
      "b",
      mkTicket("b", {
        status: "done",
        progressStatuses: ["done"],
        completedAt: Date.now(),
      }),
    );
    ticketRegistry.set(
      "c",
      mkTicket("c", { status: "cancelling", progressStatuses: ["running"] }),
    );
    const summary = activeTicketSummary();
    expect(summary.tickets.map((t) => t.id).sort()).toEqual(["a", "c"]);
    expect(summary.activeSubagents).toBe(3);
  });

  test("empty registry → no tickets", () => {
    const summary = activeTicketSummary();
    expect(summary.tickets).toEqual([]);
    expect(summary.activeSubagents).toBe(0);
  });
});

describe("buildStatusText", () => {
  test("undefined when nothing is active", () => {
    expect(
      buildStatusText({ tickets: [], activeSubagents: 0 }),
    ).toBeUndefined();
  });

  test("single ticket names the ticket id", () => {
    const ticket = mkTicket("t5042v19", {
      progressStatuses: ["running", "running"],
    });
    expect(buildStatusText({ tickets: [ticket], activeSubagents: 2 })).toBe(
      "⏳ 2 subagents · t5042v19",
    );
  });

  test("multiple tickets summarize counts", () => {
    const a = mkTicket("a");
    const b = mkTicket("b", { progressStatuses: ["running", "pending"] });
    expect(buildStatusText({ tickets: [a, b], activeSubagents: 3 })).toBe(
      "⏳ 3 subagents · 2 tickets",
    );
  });

  test("wind-down window shows settling instead of 0 subagents", () => {
    const ticket = mkTicket("a", {
      status: "cancelling",
      progressStatuses: ["done", "failed"],
    });
    expect(buildStatusText({ tickets: [ticket], activeSubagents: 0 })).toBe(
      "⏳ a settling…",
    );
  });
});

// ── Footer sync ─────────────────────────────────────────────────────────────

describe("syncDelegateStatus", () => {
  test("pushes status text while a ticket is active and clears it after", () => {
    const { ctx, calls } = mkCtx();
    const ticket = mkTicket("a", {
      progressStatuses: ["running", "pending"],
    });
    ticketRegistry.set("a", ticket);
    syncDelegateStatus(ctx);
    expect(calls.setStatus).toEqual(["⏳ 2 subagents · a"]);

    ticket.progress[0]!.status = "done";
    ticket.progress[1]!.status = "done";
    ticket.status = "done";
    ticket.completedAt = Date.now();
    ticketRegistry.set("a", ticket);
    syncDelegateStatus();
    expect(calls.setStatus).toEqual(["⏳ 2 subagents · a", undefined]);
  });

  test("dedupes unchanged status text", () => {
    const { ctx, calls } = mkCtx();
    ticketRegistry.set("a", mkTicket("a"));
    syncDelegateStatus(ctx);
    syncDelegateStatus();
    syncDelegateStatus();
    expect(calls.setStatus).toEqual(["⏳ 1 subagent · a"]);
  });

  test("is a no-op without a ctx ever seen", () => {
    _resetDelegateStatusForTesting();
    ticketRegistry.set("a", mkTicket("a"));
    // No ctx cached — must not throw.
    syncDelegateStatus();
  });
});

// ── Settle notification ─────────────────────────────────────────────────────

describe("notifyActiveTicketsOnSettled", () => {
  test("warns once per ticket while active", () => {
    const { ctx, calls } = mkCtx();
    ticketRegistry.set(
      "a",
      mkTicket("a", { progressStatuses: ["running", "running"] }),
    );
    syncDelegateStatus(ctx);

    notifyActiveTicketsOnSettled(ctx);
    expect(calls.notify).toEqual([
      {
        message:
          "⏳ 2 background subagents still running (ticket a) — quitting pi aborts them",
        type: "warning",
      },
    ]);

    // Second settle with the same ticket: quiet — the footer carries it now.
    notifyActiveTicketsOnSettled(ctx);
    expect(calls.notify).toHaveLength(1);
  });

  test("a new ticket warns again at the next settle", () => {
    const { ctx, calls } = mkCtx();
    ticketRegistry.set("a", mkTicket("a"));
    syncDelegateStatus(ctx);
    notifyActiveTicketsOnSettled(ctx);
    expect(calls.notify).toHaveLength(1);

    ticketRegistry.set("b", mkTicket("b"));
    syncDelegateStatus();
    notifyActiveTicketsOnSettled(ctx);
    expect(calls.notify).toHaveLength(2);
    expect(calls.notify[1]!.message).toContain("(ticket b)");
  });

  test("no active tickets → no notification", () => {
    const { ctx, calls } = mkCtx();
    ticketRegistry.set(
      "a",
      mkTicket("a", { status: "done", completedAt: Date.now() }),
    );
    syncDelegateStatus(ctx);
    notifyActiveTicketsOnSettled(ctx);
    expect(calls.notify).toEqual([]);
  });

  test("warned set is pruned once a ticket goes terminal", () => {
    const { ctx, calls } = mkCtx();
    ticketRegistry.set("a", mkTicket("a"));
    syncDelegateStatus(ctx);
    notifyActiveTicketsOnSettled(ctx);
    expect(calls.notify).toHaveLength(1);

    // Ticket completes and is swept; warned id must not linger.
    ticketRegistry.clear();
    syncDelegateStatus();

    ticketRegistry.set("b", mkTicket("b"));
    syncDelegateStatus();
    notifyActiveTicketsOnSettled(ctx);
    expect(calls.notify).toHaveLength(2);
    expect(calls.notify[1]!.message).toContain("(ticket b)");
  });
});

// ── Session-replacement guard ───────────────────────────────────────────────

describe("guardSessionReplacement", () => {
  test("no active tickets → allow without prompting", async () => {
    const { ctx, calls } = mkCtx();
    const result = await guardSessionReplacement(ctx, "switch");
    expect(result).toBeUndefined();
    expect(calls.confirm).toEqual([]);
  });

  test("confirmed → allow; declined → cancel", async () => {
    ticketRegistry.set(
      "a",
      mkTicket("a", { progressStatuses: ["running", "running"] }),
    );

    const yes = mkCtx({ confirmResult: true });
    expect(await guardSessionReplacement(yes.ctx, "switch")).toBeUndefined();
    expect(yes.calls.confirm).toHaveLength(1);
    expect(yes.calls.confirm[0]!.message).toContain("2 subagents (a)");
    expect(yes.calls.confirm[0]!.message).toContain("Switching sessions");

    const no = mkCtx({ confirmResult: false });
    expect(await guardSessionReplacement(no.ctx, "switch")).toEqual({
      cancel: true,
    });
  });

  test("fork uses fork wording", async () => {
    ticketRegistry.set("a", mkTicket("a"));
    const { ctx, calls } = mkCtx({ confirmResult: false });
    const result = await guardSessionReplacement(ctx, "fork");
    expect(result).toEqual({ cancel: true });
    expect(calls.confirm[0]!.message).toContain("Forking this session");
  });

  test("headless context is never blocked", async () => {
    ticketRegistry.set("a", mkTicket("a"));
    const { ctx, calls } = mkCtx({ hasUI: false });
    expect(await guardSessionReplacement(ctx, "switch")).toBeUndefined();
    expect(calls.confirm).toEqual([]);
  });
});

// ── Session-teardown races (regression: stale ctx crashed pi on /new) ──────

describe("session teardown", () => {
  test("syncs after clearDelegateStatusContext are no-ops (aborted ticket unwind)", () => {
    const { ctx, calls } = mkCtx();
    ticketRegistry.set("a", mkTicket("a"));
    syncDelegateStatus(ctx);
    expect(calls.setStatus).toEqual(["⏳ 1 subagent · a"]);

    // What the session_shutdown handler does, in order.
    for (const t of ticketRegistry.values()) cancelTicketForShutdown(t);
    syncDelegateStatus(ctx);
    clearDelegateStatusContext();
    expect(calls.setStatus).toEqual(["⏳ 1 subagent · a", undefined]);

    // The aborted ticket keeps unwinding asynchronously (dispatch .then →
    // syncDelegateStatus). It must find no cached ctx and touch nothing.
    syncDelegateStatus();
    syncDelegateStatus();
    expect(calls.setStatus).toHaveLength(2);
  });

  test("a stale ctx (throwing ui getter) is dropped, not crashed on", () => {
    ticketRegistry.set("a", mkTicket("a"));
    const staleCtx = {
      hasUI: true,
      get ui(): never {
        throw new Error("This extension ctx is stale");
      },
    } as unknown as ExtensionContext;
    // Must not throw — a footer update must never crash the host.
    syncDelegateStatus(staleCtx);
    syncDelegateStatus();

    // A fresh ctx from the next live event recovers the footer.
    const { ctx, calls } = mkCtx();
    syncDelegateStatus(ctx);
    expect(calls.setStatus).toEqual(["⏳ 1 subagent · a"]);
  });

  test("cancelTicketForShutdown flips running → cancelled, never via cancelling", () => {
    // The dispatch completion guard distinguishes shutdown-cancelled tickets
    // (skip delivery — runtime is stale) from user-cancelled ones ("cancelling"
    // → "cancelled" — deliver). This invariant is what makes that safe.
    const ticket = mkTicket("a");
    ticketRegistry.set("a", ticket);
    cancelTicketForShutdown(ticket);
    expect(ticket.status).toBe("cancelled");
  });
});

// ── Shutdown trace ──────────────────────────────────────────────────────────

describe("describeActiveTickets", () => {
  test("names counts, agents, and ticket ids", () => {
    ticketRegistry.set(
      "a",
      mkTicket("a", { progressStatuses: ["running", "pending", "done"] }),
    );
    const text = describeActiveTickets();
    expect(text).toBe("2 background subagents [agent-0, agent-1] (ticket: a)");
  });
});

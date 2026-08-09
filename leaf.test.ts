import { describe, expect, test, afterEach } from "bun:test";
import {
  getCurrentLeafId,
  isCrossLeafTicket,
  recordTreeNavigation,
  resetLeafTracking,
} from "./leaf.ts";
import { deliverTicketResults, ticketRegistry } from "./tickets.ts";
import type { AsyncTicket, TaskProgress } from "./types.ts";

function mkProgress(): TaskProgress[] {
  return [
    {
      index: 0,
      agent: "scout",
      task: "find the bug",
      status: "done",
      durationMs: 5,
      tokens: 42,
      toolUses: 0,
      activities: [],
    },
  ];
}

function mkCompletedTicket(overrides: Partial<AsyncTicket> = {}): AsyncTicket {
  return {
    id: "t1",
    created: Date.now() - 100,
    completedAt: Date.now(),
    tasks: [{ prompt: "find the bug" }],
    resolved: [
      {
        index: 0,
        prompt: "find the bug",
        model: {} as never,
        tools: [],
        thinking: "off",
        systemPrompt: "",
        cwd: "/tmp",
        agentName: "scout",
        warnings: [],
      },
    ],
    status: "done",
    results: [
      {
        agent: "scout",
        output: "found the bug",
        durationMs: 5,
        tokens: 42,
        touchedFiles: [],
      },
    ],
    progress: mkProgress(),
    controller: new AbortController(),
    ...overrides,
  };
}

function mkPi() {
  const sent: { message: any; options: any }[] = [];
  return {
    sent,
    pi: {
      sendMessage: (message: any, options: any) =>
        sent.push({ message, options }),
    } as never,
  };
}

afterEach(() => {
  ticketRegistry.clear();
  resetLeafTracking();
});

describe("leaf tracking", () => {
  test("starts unknown and follows session_tree navigation", () => {
    expect(getCurrentLeafId()).toBeUndefined();
    recordTreeNavigation("leaf-2");
    expect(getCurrentLeafId()).toBe("leaf-2");
    recordTreeNavigation(null);
    expect(getCurrentLeafId()).toBeNull();
    resetLeafTracking();
    expect(getCurrentLeafId()).toBeUndefined();
  });

  test("a ticket spawned on the current leaf is not cross-leaf", () => {
    recordTreeNavigation("leaf-2");
    expect(isCrossLeafTicket(mkCompletedTicket({ spawnLeafId: "leaf-2" }))).toBe(
      false,
    );
  });

  test("a ticket spawned before any navigation becomes cross-leaf once the session moves", () => {
    const ticket = mkCompletedTicket({ spawnLeafId: getCurrentLeafId() });
    expect(isCrossLeafTicket(ticket)).toBe(false);
    recordTreeNavigation("leaf-2");
    expect(isCrossLeafTicket(ticket)).toBe(true);
  });
});

// Issue #30: an async ticket that outlives a /tree navigation must not wake
// the parent agent on the branch the user moved to.
describe("deliverTicketResults leaf affinity", () => {
  test("same leaf → steer + triggerTurn, no provenance noise", () => {
    const { pi, sent } = mkPi();
    recordTreeNavigation("leaf-2");

    const delivery = deliverTicketResults(
      pi,
      mkCompletedTicket({ spawnLeafId: "leaf-2" }),
    );

    expect(delivery).toBe("steer");
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(sent[0]!.message.content).toContain("found the bug");
    expect(sent[0]!.message.content).not.toContain("different branch");
  });

  test("cross leaf → nextTurn, never triggerTurn, with a provenance notice", () => {
    const { pi, sent } = mkPi();
    const ticket = mkCompletedTicket({ spawnLeafId: "leaf-1" });
    recordTreeNavigation("leaf-2");

    const delivery = deliverTicketResults(pi, ticket);

    expect(delivery).toBe("deferred");
    // "nextTurn" is the only mode that neither interrupts nor triggers a turn.
    expect(sent[0]!.options).toEqual({ deliverAs: "nextTurn" });
    expect(sent[0]!.options.triggerTurn).toBeUndefined();
    expect(sent[0]!.message.content).toContain("different branch");
    // The result itself is still delivered in full — only the wake-up is gone.
    expect(sent[0]!.message.content).toContain("found the bug");
    expect(sent[0]!.message.details.ticketId).toBe("t1");
  });

  test("blocking waiters are resolved regardless of leaf and suppress the message", async () => {
    const { pi, sent } = mkPi();
    let resolved: unknown;
    const ticket = mkCompletedTicket({
      spawnLeafId: "leaf-1",
      waiters: [
        {
          settled: false,
          resolve: (r: unknown) => {
            resolved = r;
          },
        } as never,
      ],
    });
    recordTreeNavigation("leaf-2");

    // A waiter is a tool call on the live leaf by construction, so it is
    // answered directly instead of being downgraded.
    expect(deliverTicketResults(pi, ticket)).toBe("waiters");
    expect(sent).toHaveLength(0);
    expect(resolved).toBeDefined();
  });

  test("an unsettled ticket is not delivered at all", () => {
    const { pi, sent } = mkPi();
    expect(
      deliverTicketResults(pi, mkCompletedTicket({ completedAt: undefined })),
    ).toBe("none");
    expect(sent).toHaveLength(0);
  });
});

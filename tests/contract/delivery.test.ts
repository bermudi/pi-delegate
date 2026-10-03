import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type {
  MockUIConfig,
  TestSession,
} from "@marcfargas/pi-test-harness";
import { calls, says, when } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  registeredTool,
  ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";
import { armHold, releaseHold } from "../support/parent-hold.ts";

interface DirectResult {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
  readonly isError?: boolean;
  readonly details?: unknown;
}

interface DirectTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: unknown,
  ): Promise<DirectResult>;
}

/**
 * Fire the registered delegate_ticket tool without a scripted parent
 * turn — a direct execute lands inside the ~100ms delivery flush window
 * where a whole `session.run` might not (same seam as tickets.test.ts).
 */
function directTicket(session: TestSession) {
  const tool = registeredTool(session, "delegate_ticket") as unknown as DirectTool;
  const ctx = (session.session as AgentSession).extensionRunner.createContext();
  const fallback = new AbortController();
  let sequence = 0;
  return (params: Record<string, unknown>): Promise<DirectResult> => {
    sequence += 1;
    return tool.execute(
      `direct-ticket-${sequence}`,
      params,
      fallback.signal,
      () => {},
      ctx,
    );
  };
}

function gate(message = "DELIVERED-OUTPUT") {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage(message);
  };
  return { release, step };
}

async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error("Timed out awaiting delivery observation");
    await Bun.sleep(5);
  }
}

describe("async result delivery", () => {
  let session: TestSession;
  afterEach(() => {
    session?.dispose();
  });

  async function setup(navigateFirst = false, mockUI?: MockUIConfig) {
    session = await openDelegateBoundary({ mockUI });
    const host = session.session as AgentSession;
    if (navigateFirst) {
      await callDelegate(session, { async: false, tasks: [] });
      const target = host.sessionManager
        .getEntries()
        .find((entry) => entry.type === "message");
      if (!target) throw new Error("Missing navigation target");
      await host.navigateTree(target.id);
    }
    let originLeafId: string | null = null;
    const unsubscribe = host.subscribe((event) => {
      if (
        event.type === "tool_execution_start" &&
        event.toolName === "delegate"
      ) {
        originLeafId = host.sessionManager.getLeafId();
      }
    });
    const subagents = await installSubagentModel(session);
    const blocked = gate();
    subagents.respond([blocked.step]);
    // Observe the actual SDK ingress, forwarding to the real implementation:
    // the durable append and waking behavior are checked below, not merely
    // the delivery options.
    const sends = spyOn(host, "sendCustomMessage");
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "background result", tools: [] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    unsubscribe();
    return { host, blocked, sends, ticket, originLeafId };
  }

  test.each([false, true])(
    "same-origin completion wakes once, including after prior navigation (%s)",
    async (navigateFirst) => {
      // Contract: SPEC "Background delivery" same-leaf steering wake.
      // V1 evidence: dispatch.test.ts 'stamps the current leaf and delivers
      // normally when it has not changed'.
      const { host, blocked, sends, ticket, originLeafId } =
        await setup(navigateFirst);
      expect(sends).not.toHaveBeenCalled();
      const before = session.events.messages.length;
      blocked.release();
      await until(() =>
        session.events.messages.slice(before).some((m) => m.role === "custom"),
      );
      await host.agent.waitForIdle();
      expect(sends).toHaveBeenCalledTimes(1);
      const details = objectOf(sends.mock.calls[0]![0].details, "details");
      expect(details.ticket).toBe(ticket);
      expect(details.originLeafId).toBe(originLeafId);
      // Complete outcomes ride the delivered message's details — the
      // bounded text may point at a spill file while the record stays
      // whole for the expanded view (#25).
      const results = details.results as { output?: string }[] | undefined;
      expect(results?.[0]?.output).toBe("DELIVERED-OUTPUT");
      expect(sends.mock.calls[0]![0].content).toContain("DELIVERED-OUTPUT");
      expect(sends.mock.calls[0]![1]).toEqual({
        deliverAs: "steer",
        triggerTurn: true,
      });
      expect(
        session.events.messages
          .slice(before)
          .some((m) => m.role === "assistant"),
      ).toBe(true);
      const poll = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(poll.text).toContain("DELIVERED-OUTPUT");
      await callDelegateTicket(session, {
        action: "cancel",
        ticket,
        force: true,
      });
      expect(sends).toHaveBeenCalledTimes(1);
    },
  );

  test("tree navigation appends durably without waking the new branch", async () => {
    // Contract/regression: SPEC "Background delivery" cross-leaf rule — the
    // result is appended as a custom message at the current leaf without
    // triggering a turn, and a notice announces it. V1 evidence:
    // dispatch.test.ts 'dispatchAsync leaf affinity' cross-leaf scenario
    // (issue #30). On stock Pi the durable difference is that the custom
    // message IS appended immediately (in-memory nextTurn queueing would
    // lose it on shutdown and is not used).
    //
    // The 2-way consent guard (owner decision, 2026-09-22) means a
    // user-consented navigation with live tickets cancels them — the mock
    // UI's default select answer is the first option, i.e. exactly that.
    // There is no consent-to-hold choice anymore, so this contract is
    // driven through the guard's fail-open path: a broken dialog must
    // never trap the user or the work, and headless hosts take the same
    // route. The guard's own outcomes are contract-tested in
    // tests/contract/visibility.test.ts.
    const { host, blocked, sends } = await setup(false, {
      select: () => {
        throw new Error("simulated broken dialog");
      },
    });
    const root = host.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message");
    if (!root) throw new Error("Missing navigation target");
    const navigation = await host.navigateTree(root.id);
    expect(navigation.cancelled).toBe(false);
    const before = session.events.messages.length;
    blocked.release();
    await until(() => sends.mock.calls.length === 1);
    expect(sends.mock.calls[0]![1]).toEqual({ triggerTurn: false });
    const appended = session.events.messages
      .slice(before)
      .filter((m) => m.role === "custom");
    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended)).toContain("DELIVERED-OUTPUT");
    expect(
      session.events.messages
        .slice(before)
        .some((m) => m.role === "assistant"),
    ).toBe(false);
    expect(
      session.events.ui.some((entry) =>
        JSON.stringify(entry).includes("appended"),
      ),
    ).toBe(true);
    await host.agent.waitForIdle();
    expect(sends).toHaveBeenCalledTimes(1);
  });

  test("shutdown cancels immediately, never delivers, and holds until the worker actually stops", async () => {
    // INVARIANTS "Ticket state": shutdown cancellation settles immediately,
    // resolves waiters, performs no delivered wake, and the session
    // boundary MUST NOT complete while any worker's quiescence is
    // unconfirmed. The faux gate ignores abort signals, so the worker stays
    // unquiesced until release — that is what makes the hold observable.
    const { host, blocked, sends, ticket } = await setup();
    const waiting = callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    await Bun.sleep(10);
    let shutdownSettled = false;
    const shutdown = host.extensionRunner
      .emit({ type: "session_shutdown", reason: "quit" })
      .then(() => {
        shutdownSettled = true;
      });
    expect((await waiting).text).toContain("cancelled");
    const poll = await callDelegateTicket(session, { action: "poll", ticket });
    expect(poll.text).toContain("cancelled");
    await Bun.sleep(50);
    expect(shutdownSettled).toBe(false);
    // COMPATIBILITY "Blocking shutdown": the visible waiting status names
    // what is being waited on — here the ticket id, so an uncooperative
    // worker is identifiable from the status alone.
    expect(
      session.events.ui.some(
        (entry) =>
          JSON.stringify(entry).includes("waiting for") &&
          JSON.stringify(entry).includes(ticket),
      ),
    ).toBe(true);
    blocked.release();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(sends).not.toHaveBeenCalled();
  });

  test("shutdown proceeds past the quiescence budget when a worker never stops (#52)", async () => {
    // INVARIANTS "Ticket state" (bounded form, #52): the shutdown hold is
    // bounded — a worker that never confirms quiescence must not wedge host
    // exit. The gate is never released here, so the worker stays unquiesced
    // for the whole test and expiry is the only way out. The budget env var
    // is the test seam; the default is 30s, far beyond test duration.
    const { host, blocked, ticket } = await setup();
    process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS = "150";
    try {
      let shutdownSettled = false;
      const shutdown = host.extensionRunner
        .emit({ type: "session_shutdown", reason: "quit" })
        .then(() => {
          shutdownSettled = true;
        });
      await Bun.sleep(50);
      // Still inside the budget: the hold is genuine, not skipped.
      expect(shutdownSettled).toBe(false);
      await shutdown;
      expect(shutdownSettled).toBe(true);
      // Expiry proceeds loudly and names the still-unconfirmed work.
      expect(
        session.events.ui.some(
          (entry) =>
            JSON.stringify(entry).includes("still stopping") &&
            JSON.stringify(entry).includes(ticket),
        ),
      ).toBe(true);
      const poll = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(poll.text).toContain("cancelled");
      // The wedged worker finishing *after* the boundary already proceeded
      // must not crash or retroactively block — its barrier just resolves.
      blocked.release();
      await Bun.sleep(50);
    } finally {
      delete process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS;
    }
  });

  test("shutdown holds through the batch's finalization, not just worker completion", async () => {
    // Regression: the shutdown barrier used to resolve at per-task quiescence,
    // so shutdown could complete while isolated reconciliation was still
    // applying to or retaining against the source tree and admission
    // reservations were still held — a replacement session (fresh admission
    // controller) could then admit writers into that window. Now, whenever
    // shutdown completes, finalization has finished: the pollable view
    // already carries the integration annotations.
    session = await openDelegateBoundary();
    execSync(
      "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
      { cwd: session.cwd },
    );
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const blocked = gate();
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "proposal.txt", content: "PROPOSAL" }),
      ]),
      blocked.step,
    ]);
    const dispatched = await callDelegate(session, {
      tasks: [
        { prompt: "write proposal", tools: ["write"], workspace: "isolated" },
      ],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await until(() => model.state.callCount === 2);
    blocked.release();
    // Poll until the worker's outcome is caller-visible WITHOUT its
    // integration annotation: that moment sits inside the finalize window
    // (outcome recorded, reconciliation not yet). If reconciliation wins the
    // race against the first poll, the invariant below holds trivially.
    const deadline = Date.now() + 2000;
    let lastPoll = "";
    while (Date.now() < deadline) {
      const poll = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      lastPoll = poll.text;
      if (
        poll.text.includes("INTEGRATION") ||
        poll.text.includes("DELIVERED-OUTPUT")
      ) {
        break;
      }
      // Macrotask yield: a tight microtask poll starves Bun's
      // child-exit delivery for the Git evidence probes.
      await Bun.sleep(5);
    }
    if (!lastPoll.includes("DELIVERED-OUTPUT")) {
      throw new Error(
        `Worker outcome never became pollable before shutdown; last poll:\n${lastPoll}`,
      );
    }
    // Shutdown force-cancels first, so reconciliation retains (or, if it
    // already applied, keeps) the proposal — either way it must have RUN
    // before the session boundary completes.
    const shutdown = host.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    await shutdown;
    const poll = await callDelegateTicket(session, { action: "poll", ticket });
    expect(poll.text).toMatch(/INTEGRATION: (retained|applied_unverified)/);
  });

  test("no dispatch after shutdown begins; ticket RPC still works", async () => {
    // SPEC "Background delivery": shutdown rejects new dispatches while
    // tickets stay pollable for the session's remaining lifetime.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    await host.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    const dispatched = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "late work", tools: [] }],
    });
    expect(dispatched.isError).toBe(true);
    expect(dispatched.text).toContain("shutting down");
    const poll = await callDelegateTicket(session, { action: "poll" });
    expect(poll.isError).toBe(false);
    expect(poll.text).toContain("No tickets");
  });

  test.each(["throw", "reject"] as const)(
    "delivery %s is surfaced and cannot undo settlement or polling",
    async (failure) => {
      // INVARIANTS: delivery failure never makes settled results unpollable.
      // A synchronous throw reaches the extension's own log; an async
      // rejection is consumed by Pi's runtime send wrapper and surfaced
      // through its extension-error channel — both land on console.error.
      const { host, blocked, sends, ticket } = await setup();
      const errors = spyOn(console, "error").mockImplementation(() => {});
      if (failure === "reject")
        sends.mockRejectedValue(new Error("delivery-test-failure"));
      else
        sends.mockImplementation(() => {
          throw new Error("delivery-test-failure");
        });
      try {
        blocked.release();
        await until(() =>
          errors.mock.calls.some((args) =>
            args.join(" ").includes("delivery-test-failure"),
          ),
        );
        const poll = await callDelegateTicket(session, {
          action: "poll",
          ticket,
        });
        expect(poll.text).toContain("completed");
        expect(poll.text).toContain("DELIVERED-OUTPUT");
        expect(sends).toHaveBeenCalledTimes(1);
        await host.agent.waitForIdle();
      } finally {
        errors.mockRestore();
      }
    },
  );

  test("forced cancellation delivers one safe partial batch and never late success", async () => {
    // INVARIANTS: terminal cancellation is idempotent, quarantine is not
    // cleanup; the delivered view is honest about pending worker cleanup.
    const { host, blocked, sends, ticket } = await setup();
    const cancelled = await callDelegateTicket(session, {
      action: "cancel",
      ticket,
      force: true,
    });
    expect(cancelled.text).toContain("cancelled");
    await until(() => sends.mock.calls.length === 1);
    await host.agent.waitForIdle();
    const content = String(sends.mock.calls[0]![0].content);
    expect(content).toContain("cancelled");
    expect(content).toContain("1/1");
    expect(content).toMatch(
      /termination unconfirmed|cleanup may still be pending/,
    );
    expect(content).not.toContain("DELIVERED-OUTPUT");
    blocked.release();
    await Bun.sleep(100);
    const poll = await callDelegateTicket(session, { action: "poll", ticket });
    expect(poll.text).toContain("cancelled");
    expect(sends).toHaveBeenCalledTimes(1);
  });

  test("pause holds delivery until the whole batch has finished", async () => {
    // SPEC/INVARIANTS: pause is orthogonal to lifecycle, not completion.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const blocked = gate();
    model.respond([blocked.step, fauxAssistantMessage("SECOND-RESULT")]);
    const sends = spyOn(host, "sendCustomMessage");
    const dispatch = await callDelegate(session, {
      tasks: [{ prompt: "first" }, { prompt: "second" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatch.text);
    await callDelegateTicket(session, { action: "pause", ticket });
    blocked.release();
    await Bun.sleep(100);
    expect(sends).not.toHaveBeenCalled();
    expect(model.state.callCount).toBe(1);
    await callDelegateTicket(session, { action: "resume", ticket });
    await until(() => sends.mock.calls.length === 1);
    await host.agent.waitForIdle();
    expect(String(sends.mock.calls[0]![0].content)).toContain("SECOND-RESULT");
  });

  test("isolated result is delivered only with finalized integration and applied files", async () => {
    // SPEC isolated apply + auto-delivery; INVARIANTS disallow delivery
    // before the outcome is safe to expose (reconciliation applied, final
    // annotations recorded).
    session = await openDelegateBoundary();
    execSync(
      "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
      { cwd: session.cwd },
    );
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const blocked = gate();
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "proposal.txt", content: "PROPOSAL" }),
      ]),
      blocked.step,
    ]);
    const original = host.sendCustomMessage.bind(host);
    let sourceAtDelivery: string | undefined;
    const sends = spyOn(host, "sendCustomMessage").mockImplementation(
      (message, options) => {
        sourceAtDelivery = readFileSync(
          join(session.cwd, "proposal.txt"),
          "utf8",
        );
        return original(message, options);
      },
    );
    await callDelegate(session, {
      tasks: [
        { prompt: "write proposal", tools: ["write"], workspace: "isolated" },
      ],
      async: true,
    });
    await until(() => model.state.callCount === 2);
    expect(sends).not.toHaveBeenCalled();
    blocked.release();
    await until(() => sends.mock.calls.length === 1);
    await host.agent.waitForIdle();
    expect(sourceAtDelivery).toBe("PROPOSAL");
    expect(String(sends.mock.calls[0]![0].content)).toContain(
      "applied_unverified",
    );
  });

  test("failed batches also auto-deliver their retained error", async () => {
    // SPEC auto-delivers the batch result, not only successful results.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "401 unauthorized delivery-test",
      }),
    ]);
    const sends = spyOn(host, "sendCustomMessage");
    await callDelegate(session, {
      tasks: [{ prompt: "fail", tools: [] }],
      async: true,
    });
    await until(() => sends.mock.calls.length === 1);
    await host.agent.waitForIdle();
    const content = String(sends.mock.calls[0]![0].content);
    expect(content).toContain("failed");
    expect(content).toContain("401 unauthorized delivery-test");
  });

  test("two tickets settling inside the flush window deliver one merged wake", async () => {
    // SPEC v3 "Interaction grammar — Wake delivery": "simultaneous
    // settlements batch into one wake." Two async tickets released
    // together settle within the window and produce ONE delivered
    // message whose content names both tickets and whose details carry
    // both ids and both outcome sets.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const first = gate("COALESCED-A");
    const second = gate("COALESCED-B");
    model.respond([first.step, second.step]);
    const sends = spyOn(host, "sendCustomMessage");

    const dispatchA = await callDelegate(session, {
      tasks: [{ prompt: "batch a", tools: [] }],
      async: true,
    });
    const ticketA = ticketIdOf(dispatchA.text);
    const dispatchB = await callDelegate(session, {
      tasks: [{ prompt: "batch b", tools: [] }],
      async: true,
    });
    const ticketB = ticketIdOf(dispatchB.text);

    first.release();
    second.release();
    await until(() => sends.mock.calls.length === 1);
    // The window already flushed once; prove no second delivery arrives.
    await Bun.sleep(300);
    await host.agent.waitForIdle();

    expect(sends).toHaveBeenCalledTimes(1);
    const [message, options] = sends.mock.calls[0]!;
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(String(message.content)).toContain(ticketA);
    expect(String(message.content)).toContain(ticketB);
    expect(String(message.content)).toContain("COALESCED-A");
    expect(String(message.content)).toContain("COALESCED-B");
    const details = objectOf(message.details, "message.details");
    expect(details.tickets).toEqual([ticketA, ticketB]);
    const results = details.results as { output?: string }[];
    expect(results.map((r) => r.output)).toEqual([
      "COALESCED-A",
      "COALESCED-B",
    ]);
  });

  test("tickets settling beyond the flush window deliver separate wakes", async () => {
    // SPEC v3 "Wake delivery": only simultaneous settlements coalesce —
    // a second batch landing after the flush is its own wake.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const first = gate("EARLY-ONE");
    const second = gate("LATE-TWO");
    model.respond([first.step, second.step]);
    const sends = spyOn(host, "sendCustomMessage");

    const dispatchA = await callDelegate(session, {
      tasks: [{ prompt: "early", tools: [] }],
      async: true,
    });
    const ticketA = ticketIdOf(dispatchA.text);
    first.release();
    await until(() => sends.mock.calls.length === 1);

    const dispatchB = await callDelegate(session, {
      tasks: [{ prompt: "late", tools: [] }],
      async: true,
    });
    const ticketB = ticketIdOf(dispatchB.text);
    second.release();
    await until(() => sends.mock.calls.length === 2);
    await host.agent.waitForIdle();

    expect(sends).toHaveBeenCalledTimes(2);
    const firstDetails = objectOf(
      sends.mock.calls[0]![0].details,
      "first.details",
    );
    const secondDetails = objectOf(
      sends.mock.calls[1]![0].details,
      "second.details",
    );
    expect(firstDetails.ticket).toBe(ticketA);
    expect(secondDetails.ticket).toBe(ticketB);
    expect(String(sends.mock.calls[0]![0].content)).toContain("EARLY-ONE");
    expect(String(sends.mock.calls[1]![0].content)).toContain("LATE-TWO");
  });

  test("mixed routing in one window sends one wake AND one append plus notify", async () => {
    // SPEC v3 "Wake delivery": grouping is by routing decision — a
    // same-leaf ticket wakes, a moved-leaf ticket appends + notifies,
    // and a window containing both emits one of each.
    session = await openDelegateBoundary({
      mockUI: {
        select: () => {
          throw new Error("simulated broken dialog");
        },
      },
    });
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const first = gate("MOVED-RESULT");
    const second = gate("SAME-LEAF-RESULT");
    model.respond([first.step, second.step]);
    const sends = spyOn(host, "sendCustomMessage");

    const dispatchA = await callDelegate(session, {
      tasks: [{ prompt: "before navigation", tools: [] }],
      async: true,
    });
    const ticketA = ticketIdOf(dispatchA.text);

    // Navigate while A is in flight: the consent guard fails open, the
    // epoch bumps, and A's delivery will route as a moved-leaf append.
    const root = host.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message");
    if (!root) throw new Error("Missing navigation target");
    const navigation = await host.navigateTree(root.id);
    expect(navigation.cancelled).toBe(false);

    // B dispatches after the transition and stamps the new leaf/epoch —
    // its delivery stays a same-leaf wake.
    const dispatchB = await callDelegate(session, {
      tasks: [{ prompt: "after navigation", tools: [] }],
      async: true,
    });
    const ticketB = ticketIdOf(dispatchB.text);

    first.release();
    second.release();
    await until(() => sends.mock.calls.length === 2);
    await host.agent.waitForIdle();

    expect(sends).toHaveBeenCalledTimes(2);
    const [wake, append] = sends.mock.calls;
    expect(wake![1]).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
    expect(String(wake![0].content)).toContain(ticketB);
    expect(String(wake![0].content)).toContain("SAME-LEAF-RESULT");
    expect(String(wake![0].content)).not.toContain(ticketA);
    expect(append![1]).toEqual({ triggerTurn: false });
    expect(String(append![0].content)).toContain(ticketA);
    expect(String(append![0].content)).toContain("MOVED-RESULT");
    // One notify names the moved ticket(s).
    expect(
      session.events.ui.some(
        (entry) =>
          JSON.stringify(entry).includes("appended") &&
          JSON.stringify(entry).includes(ticketA),
      ),
    ).toBe(true);
  });

  test("a settled ticket enqueues and delivers at most once", async () => {
    // SPEC "Background delivery" once-ness + v3 "Wake delivery": the
    // enqueue is idempotent for the ticket's lifetime — settle, poll,
    // and wait cycles never produce a second delivered message.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("ONCE-RESULT")]);
    const sends = spyOn(host, "sendCustomMessage");

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "once", tools: [] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await until(() => sends.mock.calls.length === 1);
    await host.agent.waitForIdle();

    await callDelegateTicket(session, { action: "poll", ticket });
    await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 1000,
    });
    // Well past the flush window: a second enqueue would have sent.
    await Bun.sleep(300);
    expect(sends).toHaveBeenCalledTimes(1);
  });

  test("shutdown inside the flush window suppresses delivery and leaves tickets pollable", async () => {
    // SPEC v3 "Wake delivery" + INVARIANTS "Ticket state": a settlement
    // queued but not yet flushed when teardown begins delivers nothing;
    // the suppression is logged and the settled result stays pollable.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const blocked = gate();
    model.respond([blocked.step]);
    const sends = spyOn(host, "sendCustomMessage");
    const errors = spyOn(console, "error").mockImplementation(() => {});

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "suppressed", tools: [] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      blocked.release();
      // Wait for terminal status, then let the settle→enqueue microtasks
      // land while staying inside the 100ms flush window.
      const deadline = Date.now() + 2000;
      let view = "";
      while (Date.now() < deadline) {
        view = (
          await callDelegateTicket(session, { action: "poll", ticket })
        ).text;
        if (/completed|failed|cancelled|partial/.test(view)) break;
        // Macrotask yield: a tight microtask poll starves Bun's
        // child-exit delivery for the Git evidence probes.
        await Bun.sleep(5);
      }
      expect(view).toContain("completed");
      await Bun.sleep(25);
      const shutdown = host.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      await shutdown;
      // Past any timer that could have been armed: nothing may deliver.
      await Bun.sleep(300);
      expect(sends).not.toHaveBeenCalled();
      expect(
        errors.mock.calls.some((args) =>
          args.join(" ").includes(`delivery for ticket ${ticket} suppressed during shutdown`),
        ),
      ).toBe(true);
      const poll = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(poll.text).toContain("DELIVERED-OUTPUT");
    } finally {
      errors.mockRestore();
    }
  });

  test("a busy parent receives the result at the next turn boundary, mid-run", async () => {
    // Contract (user decision 2026-10-02, live session 01a0fdba): a
    // same-leaf wake steers — on a busy parent the result enters context
    // at the next turn boundary (after the in-flight tool calls, before
    // the next model call), not after the whole run ends as a follow-up.
    // Observable proxy: the delegate-result message_end lands before the
    // run's final assistant message and before agent_end.
    session = await openDelegateBoundary({
      leadingExtensions: [
        join(import.meta.dirname, "../support/parent-hold.ts"),
      ],
    });
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const blocked = gate();
    model.respond([blocked.step]);
    const sends = spyOn(host, "sendCustomMessage");
    armHold();
    const run = session.run(
      when("busy parent", [
        calls("delegate", {
          tasks: [{ prompt: "bg", tools: [] }],
          async: true,
        }),
        calls("delegate_hold", {}),
        says("PARENT-FINAL"),
      ]),
    );
    // Park the parent inside the hold tool, then let the ticket settle
    // while the run is still in flight.
    await until(() =>
      session.events.all.some(
        (event) =>
          event.type === "tool_execution_start" &&
          event.toolName === "delegate_hold",
      ),
    );
    blocked.release();
    await until(() => sends.mock.calls.length === 1);
    expect(sends.mock.calls[0]![1]).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
    releaseHold();
    await run;

    // The steered message entered context mid-run: before the run's
    // final assistant message and before agent_end.
    const messages = session.events.messages;
    const deliveredAt = messages.findIndex((m) => m.role === "custom");
    const finalAt = messages.findLastIndex((m) => m.role === "assistant");
    expect(deliveredAt).toBeGreaterThan(-1);
    expect(finalAt).toBeGreaterThan(deliveredAt);
    const deliveredEnd = session.events.all.findIndex(
      (event) =>
        event.type === "message_end" &&
        (event.message as { role?: string }).role === "custom",
    );
    const agentEndAt = session.events.all.findIndex(
      (event) => event.type === "agent_end",
    );
    expect(deliveredEnd).toBeGreaterThan(-1);
    expect(agentEndAt).toBeGreaterThan(deliveredEnd);
  });

  test("a wait that returns the settled result consumes the pending delivery", async () => {
    // Contract (user decision 2026-10-02, live session 01a0fdba; closes
    // the TEST-MIGRATION "delivered-result suppression" gap): a wait
    // that returned the ticket's terminal view already gave the model
    // everything the wake would send — the flush drops an identical
    // repeat.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const blocked = gate();
    model.respond([blocked.step]);
    const sends = spyOn(host, "sendCustomMessage");
    const errors = spyOn(console, "error").mockImplementation(() => {});

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg", tools: [] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      // The common race: the ticket settles while a wait on it is in
      // flight — the wait's result marks consumed before the flush fires.
      const waiting = callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      await until(() =>
        session.events.all.some(
          (event) =>
            event.type === "tool_execution_start" &&
            event.toolName === "delegate_ticket",
        ),
      );
      blocked.release();
      const waited = await waiting;
      expect(waited.text).toContain("DELIVERED-OUTPUT");
      // Past the flush window and any turn a delivery would have run.
      await Bun.sleep(300);
      await host.agent.waitForIdle();
      expect(sends).not.toHaveBeenCalled();
      expect(
        errors.mock.calls.some((args) =>
          args
            .join(" ")
            .includes(
              `delivery for ticket ${ticket} skipped: result already returned by wait`,
            ),
        ),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("a terminal poll inside the flush window consumes the pending delivery", async () => {
    // Same consumption contract through poll: the returned terminal
    // view's content — not merely the terminal status — is what
    // consumes the wake.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const blocked = gate();
    model.respond([blocked.step]);
    const sends = spyOn(host, "sendCustomMessage");
    const errors = spyOn(console, "error").mockImplementation(() => {});

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg", tools: [] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const ticketRpc = directTicket(session);
    try {
      blocked.release();
      // Direct executes keep the poll inside the flush window; running
      // polls on the way must not consume.
      const deadline = Date.now() + 5000;
      let view = "";
      while (Date.now() < deadline) {
        const polled = await ticketRpc({ action: "poll", ticket });
        view = polled.content.map((c) => c.text ?? "").join("\n");
        if (/completed|failed|cancelled|partial/.test(view)) break;
        await Bun.sleep(2);
      }
      expect(view).toContain("DELIVERED-OUTPUT");
      // One more poll past the settle→finishBatch hop: the batch's
      // finalization lands within microtasks of settlement, so this
      // read's fingerprint is the final view either way.
      await Bun.sleep(5);
      await ticketRpc({ action: "poll", ticket });
      await Bun.sleep(300);
      await host.agent.waitForIdle();
      expect(sends).not.toHaveBeenCalled();
      expect(
        errors.mock.calls.some((args) =>
          args
            .join(" ")
            .includes(
              `delivery for ticket ${ticket} skipped: result already returned by poll`,
            ),
        ),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("a wait that detaches while still running does not consume the delivery", async () => {
    // A timed-out wait returns a running view — never a terminal one —
    // so the settled result still wakes on its own.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const blocked = gate();
    model.respond([blocked.step]);
    const sends = spyOn(host, "sendCustomMessage");

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg", tools: [] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const waited = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 150,
    });
    expect(waited.text).toContain("timed out");
    blocked.release();
    await until(() => sends.mock.calls.length === 1);
    await host.agent.waitForIdle();
    expect(String(sends.mock.calls[0]![0].content)).toContain(
      "DELIVERED-OUTPUT",
    );
  });

  test("a wait consuming one ticket still delivers an unconsumed sibling", async () => {
    // Consumption is per ticket: a group holding one consumed and one
    // unconsumed ticket delivers only the unconsumed one.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const model = await installSubagentModel(session);
    const first = gate("CONSUMED-RESULT");
    const second = gate("DELIVERED-RESULT");
    model.respond([first.step, second.step]);
    const sends = spyOn(host, "sendCustomMessage");

    const dispatchA = await callDelegate(session, {
      tasks: [{ prompt: "consumed", tools: [] }],
      async: true,
    });
    const ticketA = ticketIdOf(dispatchA.text);
    const dispatchB = await callDelegate(session, {
      tasks: [{ prompt: "delivered", tools: [] }],
      async: true,
    });
    const ticketB = ticketIdOf(dispatchB.text);

    const waiting = callDelegateTicket(session, {
      action: "wait",
      ticket: ticketA,
      timeoutMs: 5000,
    });
    await until(() =>
      session.events.all.some(
        (event) =>
          event.type === "tool_execution_start" &&
          event.toolName === "delegate_ticket",
      ),
    );
    first.release();
    second.release();
    const waited = await waiting;
    expect(waited.text).toContain("CONSUMED-RESULT");
    await until(() => sends.mock.calls.length === 1);
    // Past every window both tickets could have flushed in.
    await Bun.sleep(300);
    await host.agent.waitForIdle();
    expect(sends).toHaveBeenCalledTimes(1);
    const content = String(sends.mock.calls[0]![0].content);
    expect(content).toContain(ticketB);
    expect(content).toContain("DELIVERED-RESULT");
    expect(content).not.toContain(ticketA);
    expect(content).not.toContain("CONSUMED-RESULT");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

/**
 * Operator-visibility signals (issue #24): footer status, the settle
 * warning, and the tree-navigation consent guard (driven through the
 * host's own navigateTree) via the recorded mock-UI stream. v1 evidence:
 * status.ts footer formats, settle-warning wording and once-per-ticket
 * dedupe, pause/settle footer transitions, guardTreeNavigation — with
 * one deliberate divergence: v1's third "hold" option was dropped by
 * owner decision (2026-09-22); navigating with live tickets offers
 * cancel-or-stay only. The replacement guards fire on host events
 * (session_before_switch/fork) the harness cannot emit — verified by
 * typecheck and review; the browser's TUI surface is likewise not
 * boundary-testable (see TEST-MIGRATION.md "Operator-visibility signals").
 */

/** A scripted subagent stream that blocks until `release` is invoked. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage("OUTPUT-RELEASED");
  };
  return { release, step };
}

interface UiCall {
  readonly method?: string;
  readonly args?: readonly unknown[];
}

function statusTexts(session: TestSession): (string | undefined)[] {
  return session.events.ui
    .map((entry) => entry as UiCall)
    .filter(
      (entry) => entry.method === "setStatus" && entry.args?.[0] === "delegate",
    )
    .map((entry) => entry.args?.[1] as string | undefined);
}

function notifies(session: TestSession): { message: string; type?: string }[] {
  return session.events.ui
    .map((entry) => entry as UiCall)
    .filter((entry) => entry.method === "notify")
    .map((entry) => ({
      message: entry.args?.[0] as string,
      type: entry.args?.[1] as string | undefined,
    }));
}

describe("delegate visibility signals", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("sync dispatches never touch the footer", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("DONE")]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "quick" }],
    });
    expect(result.isError).toBe(false);
    expect(statusTexts(session).filter((t) => t !== undefined)).toHaveLength(0);
  });

  test("settle warning fires once per ticket activation", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    // Each turn settling with the ticket live must warn exactly once total.
    await callDelegateTicket(session, { action: "poll", ticket });
    const warnings = notifies(session).filter((n) =>
      /still running/.test(n.message),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(ticket);
    expect(warnings[0]!.type).toBe("warning");

    release();
    await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
    expect(
      notifies(session).filter((n) => /still running/.test(n.message)),
    ).toHaveLength(1);
  });

  test("footer merges multiple tickets and survives partial settlement", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const g1 = gate();
    const g2 = gate();
    // Route each stream call by its own task prompt rather than queue
    // position: which worker reaches its first stream first is scheduling
    // (a writer opens its Git evidence window first), so FIFO order must
    // not decide which ticket a gate belongs to.
    const routed: FauxResponseFactory = (context, options, state, model) => {
      const text = JSON.stringify(context.messages);
      const g = text.includes("FIRST-TASK") ? g1 : g2;
      return g.step(context, options, state, model);
    };
    subagents.respond([routed, routed]);

    const first = await callDelegate(session, {
      tasks: [{ prompt: "FIRST-TASK" }],
      async: true,
    });
    const t1 = ticketIdOf(first.text);
    const second = await callDelegate(session, {
      // Read-only: an inline writer in the same cwd would correctly be
      // rejected by shared-write admission against ticket one.
      tasks: [{ prompt: "SECOND-TASK", tools: "ro" }],
      async: true,
    });
    const t2 = ticketIdOf(second.text);

    const texts = statusTexts(session);
    expect(texts.some((t) => t === `⏳ 2 subagent(s) · 2 tickets · /subagents`)).toBe(
      true,
    );

    g1.release();
    await callDelegateTicket(session, { action: "wait", ticket: t1, timeoutMs: 5000 });
    expect(
      statusTexts(session).some((t) => t === `⏳ 1 subagent(s) · ${t2} · /subagents`),
    ).toBe(true);

    g2.release();
    await callDelegateTicket(session, { action: "wait", ticket: t2, timeoutMs: 5000 });
    expect(statusTexts(session).at(-1)).toBeUndefined();
  });

  test("footer shows the running ticket and clears when it settles", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const texts = statusTexts(session);
    const running = texts.find((t) => t?.includes(ticket));
    expect(running).toBeDefined();
    expect(running).toMatch(/⏳ 1 subagent\(s\) · /);
    expect(running).toContain("/subagents");

    release();
    const waited = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(waited.isError).toBe(false);

    const after = statusTexts(session);
    expect(after[after.length - 1]).toBeUndefined();
  });

  test("footer reflects pause and resume of a live ticket", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const paused = await callDelegateTicket(session, {
      action: "pause",
      ticket,
    });
    expect(paused.isError).toBe(false);
    const texts = statusTexts(session);
    expect(
      texts.some((t) => t?.includes("Ⅱ") && t.includes(ticket) && t.includes("paused")),
    ).toBe(true);

    const resumed = await callDelegateTicket(session, {
      action: "resume",
      ticket,
    });
    expect(resumed.isError).toBe(false);
    expect(
      statusTexts(session).some((t) => t === `⏳ 1 subagent(s) · ${ticket} · /subagents`),
    ).toBe(true);

    release();
    await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
  });

  test("tree guard: dismissal stays on the branch and keeps work running", async () => {
    // Contract: v1 guardTreeNavigation's dismissal semantics — an
    // unanswered dialog is the conservative stay — with the owner's 2-way
    // menu (2026-09-22): exactly cancel-or-stay, no hold option.
    session = await openDelegateBoundary({
      mockUI: { select: () => undefined },
    });
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);
    const host = session.session as AgentSession;

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const target = host.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message");
    if (!target) throw new Error("Missing navigation target");
    const navigation = await host.navigateTree(target.id);

    expect(navigation.cancelled).toBe(true);
    // Exactly the two choices, in order — v1's hold option must not return.
    const selects = session.events.ui
      .map((entry) => entry as UiCall)
      .filter((entry) => entry.method === "select");
    expect(selects).toHaveLength(1);
    expect(selects[0]!.args?.[1]).toEqual([
      "Navigate — cancel the background subagents",
      "Stay on this branch",
    ]);
    // Staying left the work untouched: the ticket runs on and the footer
    // still names it.
    const held = await callDelegateTicket(session, {
      action: "poll",
      ticket,
    });
    expect(held.text).toContain("running");
    const footer = statusTexts(session)
      .filter((text) => text !== undefined)
      .at(-1);
    expect(footer).toContain(ticket);

    release();
    await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
  });

  test("tree guard: the cancel choice kills the work and navigates", async () => {
    // Contract: "Navigate — cancel the background subagents" proceeds with
    // the navigation after force-cancelling every live ticket; the footer
    // clears with the settlement. The harness mock's default (unconfigured)
    // select answer is the FIRST option — i.e. this very choice.
    session = await openDelegateBoundary({
      mockUI: { select: () => "Navigate — cancel the background subagents" },
    });
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);
    const host = session.session as AgentSession;

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const target = host.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message");
    if (!target) throw new Error("Missing navigation target");
    const navigation = await host.navigateTree(target.id);

    expect(navigation.cancelled).toBe(false);
    const poll = await callDelegateTicket(session, {
      action: "poll",
      ticket,
    });
    expect(poll.text).toContain("cancelled");
    expect(statusTexts(session).at(-1)).toBeUndefined();

    release();
    await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
  });
});

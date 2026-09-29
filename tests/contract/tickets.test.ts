import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  registeredTool,
  ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

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

/**
 * Fire the registered delegate_ticket tool without a scripted parent turn.
 * The harness serializes `session.run` turns, so a `wait` parked inside one
 * turn can never see a second turn's `interrupt` land; executing the tool
 * directly exercises the same registered entry point while the parked
 * wait's own turn stays in flight.
 */
function directTicket(session: TestSession) {
  const tool = registeredTool(session, "delegate_ticket") as unknown as DirectTool;
  const ctx = (session.session as AgentSession).extensionRunner.createContext();
  const fallback = new AbortController();
  let sequence = 0;
  return (
    params: Record<string, unknown>,
  ): Promise<DirectResult> => {
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

/** Poll until true, bounded — keeps in-flight ordering assertions stable. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250 && !probe(); i++) await Bun.sleep(20);
  expect(probe(), `${what} (timed out waiting)`).toBeTrue();
}

describe("delegate ticket contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("poll with no tickets reports an empty roster", async () => {
    // v1 evidence: delegate.test.ts "poll with no tickets returns empty
    // message" and "includes a discovery hint".
    session = await openDelegateBoundary();
    const result = await callDelegateTicket(session, { action: "poll" });
    expect(result.isError).toBe(false);
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.text).toMatch(/no|none|empty/i);
  });

  test(
    "poll, wait, cancel, pause, and resume return errors for unknown tickets",
    async () => {
      // v1 evidence: delegate.test.ts "poll with unknown ticket returns not
      // found", "wait on unknown ticket returns not found"; tickets.ts
      // `Ticket '<id>' not found.`
      session = await openDelegateBoundary();
      for (const arguments_ of [
        { action: "poll", ticket: "nope-1" },
        { action: "wait", ticket: "nope-1", timeoutMs: 50 },
        { action: "cancel", ticket: "nope-1", force: true },
        { action: "pause", ticket: "nope-1" },
        { action: "resume", ticket: "nope-1" },
      ]) {
        const result = await callDelegateTicket(session, arguments_);
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/nope-1/);
        expect(result.text).toMatch(/not found/i);
      }
    },
  );

  test(
    "wait returns the settled result and the ticket stays pollable",
    async () => {
      // v1 evidence: delegate.test.ts "wait resolves when ticket completes",
      // "wait resolves with terminal result"; SPEC: tickets remain pollable
      // after settlement.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const waiting = callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      release();
      const waited = await waiting;
      expect(waited.isError).toBe(false);
      expect(waited.text).toContain("OUTPUT-RELEASED");
      expect(waited.text).toMatch(/done|complet/i);

      const polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(polled.isError).toBe(false);
      expect(polled.text).toContain("OUTPUT-RELEASED");
    },
  );

  test(
    "a wait timeout detaches the waiter without cancelling background work",
    async () => {
      // v1 evidence: delegate.test.ts "wait timeout returns running status and
      // does not cancel ticket"; INVARIANTS: wait timeout or caller abort
      // detaches only that waiter.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const timedOut = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 30,
      });
      expect(timedOut.isError).toBe(false);
      expect(timedOut.text).toMatch(/running|timeout|pending/i);

      // The ticket is still alive and finishes once the work unblocks.
      release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("OUTPUT-RELEASED");
    },
  );

  test(
    "cancel without force previews and leaves the ticket running",
    async () => {
      // v1 evidence: delegate.test.ts "cancel without force returns a
      // non-destructive preview". SPEC: cancel previews unless force:true.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const preview = await callDelegateTicket(session, {
        action: "cancel",
        ticket,
      });
      expect(preview.isError).toBe(false);
      expect(preview.text).toMatch(/cancel|force/i);

      const polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(polled.text).toMatch(/running|cancelling/i);

      release();
    },
  );

  test(
    "forced cancellation settles the ticket and retains completed results",
    async () => {
      // v1 evidence: delegate.test.ts "cancel with force aborts a running
      // ticket and transitions to cancelling", "formatCompletedTicket
      // preserves index alignment for cancelled ticket with partial results";
      // INVARIANTS: after forced cancellation begins, later worker completion
      // must not turn the ticket into a success.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([fauxAssistantMessage("OUTPUT-DONE-EARLY"), step]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { prompt: "quick" },
          { prompt: "slow" },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const cancelled = await callDelegateTicket(session, {
        action: "cancel",
        ticket,
        force: true,
      });
      expect(cancelled.isError).toBe(false);
      expect(cancelled.text).toMatch(/cancel/i);

      // A late worker finishing must not resurrect the ticket into "done".
      release();
      const polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(polled.text).toMatch(/cancelled/i);
      expect(polled.text).toContain("OUTPUT-DONE-EARLY");
    },
  );

  test(
    "pause holds queued work, resume continues the same ticket",
    async () => {
      // v1 evidence: pause.test.ts "queued work parks without becoming active
      // and cancel unblocks it"; SPEC: pause cooperatively stops queued tasks
      // and future model turns. INVARIANTS: a paused ticket remains running.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step, fauxAssistantMessage("OUTPUT-QUEUED")]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { prompt: "first" },
          { prompt: "second" },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const paused = await callDelegateTicket(session, {
        action: "pause",
        ticket,
      });
      expect(paused.isError).toBe(false);
      expect(paused.text).toMatch(/paus/i);

      // While paused the ticket is still live, not terminal.
      const polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(polled.text).toMatch(/running|paused/i);
      expect(polled.text).not.toMatch(/done|cancelled|failed/i);

      const resumed = await callDelegateTicket(session, {
        action: "resume",
        ticket,
      });
      expect(resumed.isError).toBe(false);
      release();

      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toMatch(/done|complet/i);
    },
  );

  test(
    "a mixed success and failure async batch settles partial with both outcomes visible",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const forPrompt: FauxResponseFactory = async (context) => {
        if (JSON.stringify(context.messages).includes("succeed-task")) {
          return fauxAssistantMessage("WINNER-OUTPUT");
        }
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "provider blew up",
        });
      };
      subagents.respond([forPrompt, forPrompt]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "succeed-task" }, { prompt: "fail-task" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.isError).toBe(false);
      expect(waited.text).toContain(`Ticket "${ticket}": partial`);
      expect(waited.text).not.toContain(`Ticket "${ticket}": completed`);
      expect(waited.text).toContain("WINNER-OUTPUT");
      expect(waited.text).toContain("provider blew up");
    },
  );

  test("an all-failure async batch settles failed", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider blew up",
      }),
    ]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "fail-task" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const waited = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(waited.isError).toBe(false);
    expect(waited.text).toContain(`Ticket "${ticket}": failed`);
    expect(waited.text).toContain("provider blew up");
  });

  test(
    "a running poll shows each task's live tool line and the ticket's counts",
    async () => {
      // v1 evidence: ticket-format.ts formatInFlightTaskLine /
      // formatQueuedTaskLine — a running task showed its current or last
      // tool, tool count, and activity age; a queued task read waiting;
      // the header carried active/queued/tool totals.
      session = await openDelegateBoundary();
      // One slot so task-2 provably stays queued behind task-1.
      configureDelegate(session, { maxConcurrent: 1 });
      const subagents = await installSubagentModel(session);
      const probeFile = join(session.cwd, "probe-target.txt");
      writeFileSync(probeFile, "probe\n");

      const { release, step } = gate();
      subagents.respond([
        // task-1 completes one real read call, then parks in the provider.
        fauxAssistantMessage([fauxToolCall("read", { path: probeFile })]),
        step,
        fauxAssistantMessage("QUEUED-OUTPUT"),
      ]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { prompt: "read then wait", tools: ["read"] },
          { prompt: "queued behind the gate", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      // callCount >= 2 proves task-1's read call already completed: the
      // child's loop only re-enters the provider after its tools return.
      await waitFor(
        () => subagents.state.callCount >= 2,
        "task-1 parked in its second provider call",
      );

      const polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      // The running task names its last completed tool, its call count,
      // and how long since it was last heard from.
      expect(polled.text).toMatch(/⏳ .*#task-1 · last: read\b/);
      expect(polled.text).toMatch(/#task-1 .*· 1 tool · active/);
      // The queued task waits behind the slot, and the header totals it.
      expect(polled.text).toMatch(/○ .*#task-2 · waiting…/);
      expect(polled.text).toContain("1 active");
      expect(polled.text).toContain("1 queued");
      expect(polled.text).toMatch(/· 1 tool\b/);

      release();
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
    },
  );

  test(
    "wait wakes on a worker question and carries the question notice (#48)",
    async () => {
      // Issue #48: a parked waiter hears mailbox activity — the wait
      // result carries the question (ticket id, task id, question text,
      // and the answer invocation) inline, without duplicating the
      // separate question-wake turn.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const ask: FauxResponseFactory = async () => {
        await blocked;
        return fauxAssistantMessage([
          fauxToolCall("ask_parent", { question: "Which branch?" }),
        ]);
      };
      subagents.respond([ask, fauxAssistantMessage("ANSWERED-DONE")]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "asker", prompt: "think then ask" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const waiting = callDelegateTicket(session, { action: "wait", ticket });
      release();
      const waited = await waiting;
      expect(waited.isError).toBe(false);
      // The question notice rides the wait result inline: the task's
      // canonical address, the question text, and how to answer.
      expect(waited.text).toContain(ticket);
      expect(waited.text).toContain(`task ${ticket}#asker`);
      expect(waited.text).toContain("Which branch?");
      expect(waited.text).toContain('delegate_ticket({ action: "answer"');
      expect(waited.text).toContain("Wait detached");
      const questionId = /question (q-\d+):/.exec(waited.text)?.[1] ?? "";
      expect(questionId).not.toBe("");

      const answered = await callDelegateTicket(session, {
        action: "answer",
        ticket,
        taskId: "asker",
        questionId,
        answer: "the left one",
      });
      expect(answered.isError).toBe(false);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("ANSWERED-DONE");
    },
  );

  test(
    "wait wakes on a task interruption naming it while the ticket keeps running (#48)",
    async () => {
      // Issue #48: interruption is mailbox activity. A parked waiter on a
      // multi-task ticket resolves when one task settles interrupted —
      // the result carries the interrupted notice and the ticket is still
      // live behind it.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const first = gate();
      const second = gate();
      subagents.respond([first.step, second.step]);
      const dispatched = await callDelegate(session, {
        // Read-only tasks hold no write claims — both run in parallel.
        tasks: [
          { prompt: "first", tools: ["read"] },
          { prompt: "second", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 2,
        "both tasks parked inside their provider calls",
      );

      const waiting = callDelegateTicket(session, { action: "wait", ticket });
      // The harness serializes parent turns, so the interrupt fires through
      // the registered tool directly while the wait's turn stays parked.
      // Wait for the call to be emitted, then give its execute() a beat to
      // register the waiter — an interrupt that lands before the park is
      // baseline news, not a wake.
      await waitFor(
        () => session!.events.toolCallsFor("delegate_ticket").length >= 1,
        "the parked wait's tool call",
      );
      await Bun.sleep(50);
      const receipt = await directTicket(session)({
        action: "interrupt",
        ticket,
        taskId: "task-1",
      });
      expect(receipt.isError).not.toBe(true);

      const waited = await waiting;
      expect(waited.isError).toBe(false);
      // The interrupted notice names the task; the ticket is still running.
      expect(waited.text).toContain("### Task task-1 — interrupted");
      expect(waited.text).toContain(`task "${ticket}#task-1" was interrupted`);
      expect(waited.text).toContain("Wait detached");
      expect(waited.text).toContain("still running");

      first.release();
      second.release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("OUTPUT-RELEASED");
      expect(settled.text).toContain("### Task task-2 — completed");
    },
  );

  test(
    "a wait entered after an interruption parks for the next event — timeout still detaches (#48)",
    async () => {
      // Issue #48: the interruption wake is event-scoped, like the
      // question wake but without an actionable pending state — an
      // interruption already on record is stale news the view carries, so
      // a fresh wait keeps waiting and a timeout detaches the waiter only.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const first = gate();
      const second = gate();
      subagents.respond([first.step, second.step]);
      const dispatched = await callDelegate(session, {
        // Read-only tasks hold no write claims — both run in parallel.
        tasks: [
          { prompt: "first", tools: ["read"] },
          { prompt: "second", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 2,
        "both tasks parked inside their provider calls",
      );
      await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
        taskId: "task-1",
      });

      const timedOut = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 60,
      });
      expect(timedOut.isError).toBe(false);
      expect(timedOut.text).toContain("Wait timed out");
      expect(timedOut.text).toContain("### Task task-1 — interrupted");
      expect(timedOut.text).toContain("still running");

      first.release();
      second.release();
      await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
    },
  );

  test(
    "a running poll names the in-flight tool a worker is parked inside",
    async () => {
      // v1 evidence: ticket-format.ts — the in-flight (current) tool
      // rendered without the "last:" prefix. A worker parked inside
      // ask_parent is deterministically in that state: its tool call has
      // started and cannot end until the parent answers.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage([
          fauxToolCall("ask_parent", { question: "Which path?" }),
        ]),
        fauxAssistantMessage("ANSWERED-CONTINUE"),
      ]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "ask then finish", tools: ["read"] }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      // Poll until the worker is parked inside its question — the live
      // row and the question id surface together.
      let polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      for (let i = 0; i < 100 && !polled.text.includes("ask_parent"); i++) {
        await Bun.sleep(20);
        polled = await callDelegateTicket(session, {
          action: "poll",
          ticket,
        });
      }
      expect(polled.text).toMatch(/⏳ .*#task-1 · ask_parent\b/);
      expect(polled.text).toMatch(/#task-1 .*· 1 tool · active/);
      expect(polled.text).not.toContain("last: ask_parent");
      const questionId = /question (q-\d+)/.exec(polled.text)?.[1] ?? "";
      expect(questionId).not.toBe("");

      const answered = await callDelegateTicket(session, {
        action: "answer",
        ticket,
        taskId: "task-1",
        questionId,
        answer: "the left one",
      });
      expect(answered.isError).toBe(false);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("ANSWERED-CONTINUE");
    },
  );

  test(
    "wait-any resolves on the first ticket to settle with its view and a running roster (#58)",
    async () => {
      // Issue #58 (third codex comparison): `tickets` watches several
      // ids — the wait resolves on the first to settle, leading with
      // that ticket's view and a one-line roster of the rest still
      // running.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const early = gate();
      const late = gate();
      subagents.respond([early.step, late.step]);

      const a = ticketIdOf(
        (
          await callDelegate(session, {
            tasks: [{ prompt: "first", tools: ["read"] }],
            async: true,
          })
        ).text,
      );
      const b = ticketIdOf(
        (
          await callDelegate(session, {
            tasks: [{ prompt: "second", tools: ["read"] }],
            async: true,
          })
        ).text,
      );
      await waitFor(
        () => subagents.state.callCount === 2,
        "both tickets parked in provider calls",
      );

      // Watch order is [b, a] but a settles first — the resolved ticket
      // is the settler, not the list head.
      const waiting = callDelegateTicket(session, {
        action: "wait",
        tickets: [b, a],
      });
      early.release();
      const waited = await waiting;
      expect(waited.isError).toBe(false);
      expect(waited.text).toContain("OUTPUT-RELEASED");
      expect(waited.text).toContain(`Ticket "${a}"`);
      expect(waited.text).toContain("first watched ticket to settle");
      expect(waited.text).toContain(`"${b}"`);
      expect(waited.text).toMatch(/still running: "t-[0-9a-f-]+" \(running/);
      const details = objectOf(waited.details, "waited.details");
      expect(details.ticket).toBe(a);

      late.release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket: b,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("OUTPUT-RELEASED");
    },
  );

  test(
    "a wait-any timeout detaches only the waiter — every watched ticket keeps running (#58)",
    async () => {
      // Issue #58: timeout semantics are the single wait's, detached —
      // nothing is cancelled and each ticket settles on its own clock.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const a = gate();
      const b = gate();
      subagents.respond([a.step, b.step]);

      const ta = ticketIdOf(
        (
          await callDelegate(session, { tasks: [{ prompt: "one", tools: ["read"] }], async: true })
        ).text,
      );
      const tb = ticketIdOf(
        (
          await callDelegate(session, { tasks: [{ prompt: "two", tools: ["read"] }], async: true })
        ).text,
      );
      await waitFor(
        () => subagents.state.callCount === 2,
        "both tickets parked in provider calls",
      );

      const timedOut = await callDelegateTicket(session, {
        action: "wait",
        tickets: [ta, tb],
        timeoutMs: 40,
      });
      expect(timedOut.isError).toBe(false);
      expect(timedOut.text).toMatch(/timed out/i);
      expect(timedOut.text).toContain(ta);
      expect(timedOut.text).toContain(tb);
      expect(timedOut.text).toMatch(/running/);

      // Both are still alive and settle normally once released.
      a.release();
      b.release();
      for (const ticket of [ta, tb]) {
        const settled = await callDelegateTicket(session, {
          action: "wait",
          ticket,
          timeoutMs: 5000,
        });
        expect(settled.text).toContain("OUTPUT-RELEASED");
      }
    },
  );

  test(
    "wait-any validation: disagreement names both spellings, agreement folds, unknown ids error, tickets stays wait-only (#58)",
    async () => {
      // Issue #58: `ticket` and `tickets` name the same wait target —
      // agreeing forms take the single-ticket path untouched; a
      // divergence is a validation error naming both.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const a = gate();
      const b = gate();
      subagents.respond([a.step, b.step]);

      const ta = ticketIdOf(
        (
          await callDelegate(session, { tasks: [{ prompt: "one", tools: ["read"] }], async: true })
        ).text,
      );
      const tb = ticketIdOf(
        (
          await callDelegate(session, { tasks: [{ prompt: "two", tools: ["read"] }], async: true })
        ).text,
      );

      // `ticket` + a `tickets` list naming a different set: error naming
      // both fields and both values.
      const disagree = await callDelegateTicket(session, {
        action: "wait",
        ticket: ta,
        tickets: [ta, tb],
      });
      expect(disagree.isError).toBe(true);
      expect(disagree.text).toContain("'ticket'");
      expect(disagree.text).toContain("'tickets'");
      expect(disagree.text).toContain(ta);
      expect(disagree.text).toContain(tb);

      // An unknown id in the list fails like the singular unknown.
      const unknown = await callDelegateTicket(session, {
        action: "wait",
        tickets: [ta, "t-00000000-0000-4000-8000-000000000000"],
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("t-00000000-0000-4000-8000-000000000000");
      expect(unknown.text).toMatch(/not found/i);

      // `tickets` belongs to wait alone.
      const misplaced = await callDelegateTicket(session, {
        action: "poll",
        tickets: [ta, tb],
      });
      expect(misplaced.isError).toBe(true);
      expect(misplaced.text).toMatch(/tickets is valid only with action "wait"/);

      // A bare wait teaches both spellings.
      const bare = await callDelegateTicket(session, {
        action: "wait",
        timeoutMs: 10,
      });
      expect(bare.isError).toBe(true);
      expect(bare.text).toMatch(/requires a ticket id/);
      expect(bare.text).toContain("'tickets'");

      // Agreement — `ticket` plus a one-id `tickets` naming it — folds
      // to the single-ticket path: the settled view rides bare, with
      // no wait-any resolution line.
      a.release();
      const agreed = await callDelegateTicket(session, {
        action: "wait",
        ticket: ta,
        tickets: [ta],
        timeoutMs: 5000,
      });
      expect(agreed.isError).toBe(false);
      expect(agreed.text).toContain("OUTPUT-RELEASED");
      expect(agreed.text).not.toContain("watched ticket");

      b.release();
      const solo = await callDelegateTicket(session, {
        action: "wait",
        tickets: [tb],
        timeoutMs: 5000,
      });
      expect(solo.isError).toBe(false);
      expect(solo.text).toContain("OUTPUT-RELEASED");
      expect(solo.text).not.toContain("watched ticket");
    },
  );
});

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
  openDelegateBoundary,
  ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

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
});

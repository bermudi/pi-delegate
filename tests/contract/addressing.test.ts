import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  InterruptDetails,
  SteerDetails,
} from "../../src/details.ts";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

// Canonical task addressing (issue #53, new contract — no v1 analog): the
// compound "<ticketId>#<taskId>" is accepted in the taskId field of
// steer/answer/interrupt/tail; when compound, the separate ticket field
// is optional — the address resolves it. The same compound is rendered
// in receipts, wakes, and delivered result views so the parent can copy
// it verbatim. Plain ticket/task forms are untouched, and a task id that
// literally contains "#" still resolves when the ticket field is sent.

/** Poll until true, bounded — keeps in-flight ordering assertions stable. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250 && !probe(); i++) await Bun.sleep(20);
  expect(probe(), `${what} (timed out waiting)`).toBeTrue();
}

/** A parked worker's question id, scraped from the ticket's poll view. */
async function untilQuestion(session: TestSession, ticket: string): Promise<string> {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const view = await callDelegateTicket(session, { action: "poll", ticket });
    const match = view.text.match(/Waiting for parent answer: task \S+, question (q-\d+):/);
    if (match) return match[1]!;
    await Bun.sleep(10);
  }
  throw new Error(`Worker did not ask a question on ticket ${ticket}`);
}

describe("canonical ticket#task addressing (#53)", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "steer and interrupt resolve a compound taskId with the ticket field omitted",
    async () => {
      // #53: the compound carries its own ticket. Steer a parked worker
      // and interrupt it — all addressed as
      // "<ticket>#<task>" with no separate ticket field.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      // Responses are a global FIFO across parallel workers — dispatch on
      // the task's own prompt so alpha parks on its question.
      const byPrompt = async (context: { messages: unknown }) => {
        const sent = JSON.stringify(context.messages);
        return sent.includes('"one"')
          ? fauxAssistantMessage([
              fauxText("ALPHA-LIVE"),
              fauxToolCall("ask_parent", { question: "q?" }),
            ])
          : fauxAssistantMessage(
              sent.includes('"two"') ? "BETA-OUT" : "GAMMA-OUT",
            );
      };
      subagents.respond([byPrompt, byPrompt, byPrompt]);
      const dispatched = await callDelegate(session, {
        tasks: [
          { id: "alpha", prompt: "one", agent: "explore" },
          { id: "beta", prompt: "two", agent: "explore" },
          { id: "gamma", prompt: "three", agent: "explore" },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      // alpha parks on ask_parent; beta/gamma settle. A wait ends at once
      // on alpha's pending question, so poll until beta's completed
      // outcome is on record before the assertions below.
      await untilQuestion(session, ticket);
      const deadline = Date.now() + 4000;
      for (;;) {
        const view = await callDelegateTicket(session, { action: "poll", ticket });
        if (view.text.includes(`### Task beta — completed`)) break;
        if (Date.now() >= deadline) {
          throw new Error("beta's completed outcome was never recorded");
        }
        await Bun.sleep(10);
      }

      // steer: compound target, no ticket field — parked on a question, the
      // task has no live turn, so the receipt reports "activated".
      const steered = await callDelegateTicket(session, {
        action: "steer",
        taskId: `${ticket}#alpha`,
        message: "keep it brief",
      });
      expect(steered.isError).toBe(false);
      expect(steered.text).toContain(`"${ticket}#alpha"`);
      const steerDetails = objectOf(
        objectOf(steered.details).steer,
        "details.steer",
      ) as SteerDetails;
      expect(steerDetails.ticket).toBe(ticket);
      expect(steerDetails.taskId).toBe("alpha");
      expect(["steered", "activated"]).toContain(steerDetails.status);

      // interrupt on the still-running task via compound — the receipt and
      // its text both carry the compound address.
      const interrupted = await callDelegateTicket(session, {
        action: "interrupt",
        taskId: `${ticket}#alpha`,
      });
      expect(interrupted.isError).toBe(false);
      expect(interrupted.text).toContain(`"${ticket}#alpha"`);
      const interruptDetails = objectOf(
        objectOf(interrupted.details).interrupt,
        "details.interrupt",
      ) as InterruptDetails;
      expect(interruptDetails.ticket).toBe(ticket);
      expect(interruptDetails.taskId).toBe("alpha");
      await callDelegateTicket(session, { action: "wait", ticket });
    },
  );

  test(
    "answer resolves a compound taskId; the wake and notice render it",
    async () => {
      // #53: the question wake names the compound address and its reply
      // example carries it verbatim in taskId — copying it into an answer
      // resolves without a separate ticket field.
      session = await openDelegateBoundary();
      const host = session.session as AgentSession;
      const sends = spyOn(host, "sendCustomMessage");
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage([
          fauxToolCall("ask_parent", { question: "Continue?" }),
        ]),
        fauxAssistantMessage("ANSWER-USED"),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "asker", prompt: "ask", agent: "explore" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () =>
          sends.mock.calls.some(
            (call) =>
              (call[0] as { customType?: string }).customType === "delegate-question",
          ),
        "the delegate-question wake",
      );
      const notice = sends.mock.calls.find(
        (call) =>
          (call[0] as { customType?: string }).customType === "delegate-question",
      )![0] as { content?: unknown };
      const wakeText = String(notice.content);
      expect(wakeText).toContain(`"${ticket}#asker"`);
      expect(wakeText).toContain(`taskId: "${ticket}#asker"`);

      // The poll view's notice renders the same compound + reply example.
      const questionId = await untilQuestion(session, ticket);
      const polled = await callDelegateTicket(session, { action: "poll", ticket });
      expect(polled.text).toContain(`task ${ticket}#asker`);
      expect(polled.text).toContain(`taskId: "${ticket}#asker"`);

      // Answer by compound alone — no ticket field.
      const answered = await callDelegateTicket(session, {
        action: "answer",
        taskId: `${ticket}#asker`,
        questionId,
        answer: "yes, continue",
      });
      expect(answered.isError).toBe(false);
      expect(answered.text).toContain(`${ticket}#asker`);

      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
      });
      expect(settled.text).toContain("ANSWER-USED");
    },
  );

  test(
    "delivered result views render the compound beside each task",
    async () => {
      // #53: the delivered wake's content IS the ticket view verbatim
      // (deliveredMessage joins tickets.view), so its task sections must
      // carry the copyable compound address.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("DONE-ONE"),
        fauxAssistantMessage("DONE-TWO"),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [
          { id: "one", prompt: "a", agent: "explore" },
          { id: "two", prompt: "b", agent: "explore" },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
      });
      // The settled view is the delivered result's content.
      expect(settled.text).toContain(`### Task one — completed · ${ticket}#one`);
      expect(settled.text).toContain(`### Task two — completed · ${ticket}#two`);
    },
  );

  test(
    "unknown compound components reject naming the available ones",
    async () => {
      // #53: an unknown ticket in a compound names the live tickets; an
      // unknown task on a known ticket names that ticket's tasks as
      // compound addresses.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage([
          fauxToolCall("ask_parent", { question: "hold?" }),
        ]),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "holder", prompt: "wait", agent: "explore" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await untilQuestion(session, ticket);

      // #130: steer is the vehicle (tail was removed); an unknown ticket
      // or task lands in a not-applied receipt that names the known set.
      const ghostTicket = await callDelegateTicket(session, {
        action: "steer",
        taskId: "t-00000000-0000-0000-0000-000000000000#holder",
        message: "x",
      });
      expect(ghostTicket.text).toContain("t-00000000-0000-0000-0000-000000000000");

      const ghostTask = await callDelegateTicket(session, {
        action: "steer",
        taskId: `${ticket}#ghost`,
        message: "x",
      });
      expect(ghostTask.isError).toBe(false);
      expect(ghostTask.text).toContain("not-applied");
      expect(ghostTask.text).toContain(`"${ticket}#ghost"`);
      expect(ghostTask.text).toContain(`"${ticket}#holder"`);

      // Same discipline through steer/interrupt's not-applied receipts.
      const steered = await callDelegateTicket(session, {
        action: "steer",
        taskId: `${ticket}#ghost`,
        message: "x",
      });
      expect(steered.isError).toBe(false);
      expect(steered.text).toContain("not-applied");
      expect(steered.text).toContain(`"${ticket}#holder"`);

      await callDelegateTicket(session, { action: "cancel", ticket, force: true });
    },
  );

  test(
    "a compound disagreeing with the ticket field rejects naming both; malformed halves reject too",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage([
          fauxToolCall("ask_parent", { question: "hold?" }),
        ]),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "holder", prompt: "wait", agent: "explore" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await untilQuestion(session, ticket);

      const conflict = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "t-other#holder",
        message: "x",
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.text).toContain("t-other#holder");
      expect(conflict.text).toContain(ticket);
      expect(conflict.text).toContain("disagree");

      for (const malformed of ["#holder", `${ticket}#`]) {
        const bad = await callDelegateTicket(session, {
          action: "steer",
          taskId: malformed,
          message: "x",
        });
        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("malformed");
      }

      await callDelegateTicket(session, { action: "cancel", ticket, force: true });
    },
  );

  test(
    "plain ticket/task forms are unchanged, and a compound agreeing with the ticket field resolves",
    async () => {
      // #53: {ticket, taskId} keeps working exactly as before; sending a
      // compound that AGREES with the ticket field is fine (the address
      // carries the same ticket); '#' is schema-impossible in task ids.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage([
          fauxText("PARKED"),
          fauxToolCall("ask_parent", { question: "hold?" }),
        ]),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "holder", prompt: "wait", agent: "explore" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await untilQuestion(session, ticket);

      // Plain two-field form (steer is the vehicle — #130 removed tail;
      // it exercises the same address resolution on a running task).
      const plain = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "holder",
        message: "plain form",
      });
      expect(plain.isError).toBe(false);
      expect(plain.text).toContain(`"${ticket}#holder"`);

      // Compound + agreeing ticket field resolves to the same task.
      const agreeing = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: `${ticket}#holder`,
        message: "agreeing form",
      });
      expect(agreeing.isError).toBe(false);
      expect(agreeing.text).toContain(`"${ticket}#holder"`);

      await callDelegateTicket(session, { action: "cancel", ticket, force: true });
    },
  );
});

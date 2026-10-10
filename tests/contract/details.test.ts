import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
// The schemas ARE the contract artifact here (issue #51, Phase A): Pi's
// ToolDefinition has no result/details schema slot — only `parameters` —
// so the emitted shapes are pinned by importing the exported schemas and
// `Check`ing what real dispatches through the registered tools emit.
// Tests still reach the extension only through its public tools.
import {
  asyncDispatchDetailsSchema,
  delegateDetailsSchema,
  deliveredDetailsSchema,
  helpDetailsSchema,
  interruptDetailsSchema,
  questionNoticeDetailsSchema,
  sessionDetailsSchema,
  steerDetailsSchema,
  syncDispatchDetailsSchema,
  ticketDetailsSchema,
} from "../../src/details.ts";
import {
  callDelegate,
  configureDelegate,
  callDelegateSession,
  callDelegateTicket,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/** A scripted subagent stream that blocks until `release` is invoked. */
function gate(output = "OUTPUT-RELEASED") {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage(output);
  };
  return { release, step };
}

/** Poll until true, bounded. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 4000;
  while (!probe()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("details schemas (SPEC v3 Observability, issue #51)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("the manual call's details satisfy helpDetailsSchema", async () => {
    // Issue #51: the manual result carries a stable machine-readable
    // half like every other call — a bare {mode: "help"}.
    session = await openDelegateBoundary();
    const result = await callDelegate(session, { tasks: [] });
    expect(result.isError).toBe(false);
    expect(Check(helpDetailsSchema, result.details)).toBe(true);
    expect(Check(delegateDetailsSchema, result.details)).toBe(true);
  });

  test(
    "a sync dispatch's details satisfy syncDispatchDetailsSchema — brief, notices, results, attributedFiles, verdict",
    async () => {
      // Issue #51: the whole sync result envelope is pinned — including
      // the completion-evidence fields: per-task outcomes (usage,
      // attribution, verdict), details.attributedFiles, details.verdict,
      // details.brief and details.notices (the
      // same-call shared-write serialization exercises that slot).
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([
        // task-1: a write call → attributedFiles; then its final text.
        fauxAssistantMessage([
          fauxToolCall("write", { path: "out.txt", content: "ONE" }),
        ]),
        fauxAssistantMessage("WROTE-IT"),
        // task-2 (verifier): a bash call → uncertain attribution; then a
        // verdict line its profile parses.
        fauxAssistantMessage([fauxToolCall("bash", { command: "true" })]),
        fauxAssistantMessage("Checked the claim.\nVERDICT: PASS"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { id: "task-1", prompt: "write a file" },
          { id: "check", agent: "verifier", prompt: "verify claim X", dependsOn: ["task-1"] },
        ],
        // Explicit inline mode; the dependsOn edge orders the two writers
        // (#126: unordered same-root overlap rejects) so they serialize.
        async: false,
        brief: "SHARED-BRIEF",
      });
      expect(result.isError).toBe(false);
      expect(Check(syncDispatchDetailsSchema, result.details)).toBe(true);
      expect(Check(delegateDetailsSchema, result.details)).toBe(true);

      const details = objectOf(result.details, "details");
      expect(details.brief).toBe("SHARED-BRIEF");
      expect(Array.isArray(details.notices)).toBe(true);
      expect((details.notices as string[]).join(" ")).toMatch(/serializ/i);
      const verdict = details.verdict as { verdict: string; taskId: string }[];
      expect(verdict).toEqual([{ verdict: "PASS", taskId: "check" }]);
      const attributed = details.attributedFiles as {
        taskId: string;
        files: string[];
        uncertain: boolean;
      }[];
      expect(
        attributed.find((entry) => entry.taskId === "task-1")!.files,
      ).toEqual([join(session.cwd, "out.txt")]);
      expect(
        attributed.find((entry) => entry.taskId === "check")!.uncertain,
      ).toBe(true);
    },
  );

  test(
    "an async dispatch receipt, its ticket views, and the delivered wake satisfy their schemas",
    async () => {
      // Issue #51: the async receipt envelope, the poll/wait ticket
      // envelope (results/attributedFiles/verdict/questions/tokenBudget),
      // and the delivered delegate-result message are all pinned.
      session = await openDelegateBoundary();
      const host = session.session as AgentSession;
      const sends = spyOn(host, "sendCustomMessage");
      const model = await installSubagentModel(session);
      model.respond([
        fauxAssistantMessage([
          fauxToolCall("write", { path: "deliverable.md", content: "D" }),
        ]),
        fauxAssistantMessage("ASYNC-DONE"),
      ]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "write a deliverable" }],
        async: true,
        brief: "ASYNC-BRIEF",
      });
      expect(dispatched.isError).toBe(false);
      expect(Check(asyncDispatchDetailsSchema, dispatched.details)).toBe(true);
      expect(Check(delegateDetailsSchema, dispatched.details)).toBe(true);
      const details = objectOf(dispatched.details, "details");
      expect(details.brief).toBe("ASYNC-BRIEF");
      const ticket = details.ticket as string;

      // The delivered wake's details are the same record — pinned by
      // deliveredDetailsSchema (single-ticket shape). Asserted before
      // poll/wait: returning the terminal view to the model consumes
      // the wake (SPEC "Wake delivery").
      await waitFor(
        () =>
          sends.mock.calls.some(
            (call) =>
              (call[0] as { customType?: string }).customType ===
              "delegate-result",
          ),
        "the delivered delegate-result message",
      );
      const delivered = sends.mock.calls.find(
        (call) =>
          (call[0] as { customType?: string }).customType ===
          "delegate-result",
      )!;
      expect(Check(deliveredDetailsSchema, delivered[0].details)).toBe(true);

      const polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(Check(ticketDetailsSchema, polled.details)).toBe(true);
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
      });
      expect(waited.text).toContain("ASYNC-DONE");
      expect(Check(ticketDetailsSchema, waited.details)).toBe(true);
      const waitedDetails = objectOf(waited.details, "details");
      const outcomes = waitedDetails.results as { output?: string }[];
      expect(outcomes[0]!.output).toBe("ASYNC-DONE");
    },
  );

  test(
    "a steer receipt's details satisfy steerDetailsSchema inside the ticket envelope",
    async () => {
      // Issue #51: details.steer is pinned — steerId, ticket, taskId,
      // status, and `replayed` on a duplicate receipt.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const held = gate();
      subagents.respond([held.step, fauxAssistantMessage("AFTER-STEER")]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "work" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "child parked inside its first provider call",
      );

      const receipt = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        message: "STEER-NOTE",
        steerId: "s-51",
      });
      expect(receipt.isError).toBe(false);
      expect(Check(ticketDetailsSchema, receipt.details)).toBe(true);
      const steer = objectOf(receipt.details, "details").steer;
      expect(Check(steerDetailsSchema, steer)).toBe(true);
      expect(objectOf(steer, "details.steer").status).toBe("steered");

      const replay = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        message: "STEER-NOTE",
        steerId: "s-51",
      });
      const replayed = objectOf(replay.details, "details").steer;
      expect(Check(steerDetailsSchema, replayed)).toBe(true);
      expect(objectOf(replayed, "details.steer").replayed).toBe("steered");

      held.release();
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
      });
    },
  );

  test(
    "an interrupt receipt's details satisfy interruptDetailsSchema inside the ticket envelope",
    async () => {
      // Issue #51: details.interrupt is pinned — ticket, taskId, status.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const held = gate("NEVER-SEEN");
      subagents.respond([held.step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "work" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "child parked inside its first provider call",
      );

      const receipt = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
      });
      expect(receipt.isError).toBe(false);
      expect(Check(ticketDetailsSchema, receipt.details)).toBe(true);
      const interrupt = objectOf(receipt.details, "details").interrupt;
      expect(Check(interruptDetailsSchema, interrupt)).toBe(true);
      expect(objectOf(interrupt, "details.interrupt").status).toBe(
        "interrupted",
      );

      held.release();
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
      });
    },
  );

  test(
    "a worker-question notification's details satisfy questionNoticeDetailsSchema",
    async () => {
      // Issue #51: the delegate-question message's details are pinned —
      // ticket, taskId, questionId — the fields an answer call needs.
      session = await openDelegateBoundary();
      const host = session.session as AgentSession;
      const sends = spyOn(host, "sendCustomMessage");
      const model = await installSubagentModel(session);
      model.respond([
        fauxAssistantMessage([
          fauxToolCall("ask_parent", { question: "Which path?" }),
        ]),
        fauxAssistantMessage("USED-ANSWER"),
      ]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "ask" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () =>
          sends.mock.calls.some(
            (call) =>
              (call[0] as { customType?: string }).customType ===
              "delegate-question",
          ),
        "the delegate-question notification",
      );
      const notice = sends.mock.calls.find(
        (call) =>
          (call[0] as { customType?: string }).customType ===
          "delegate-question",
      )![0] as { details?: unknown };
      expect(Check(questionNoticeDetailsSchema, notice.details)).toBe(true);
      const questionId = objectOf(notice.details, "notice.details")
        .questionId as string;

      const answered = await callDelegateTicket(session, {
        action: "answer",
        ticket,
        taskId: "task-1",
        questionId,
        answer: "the first one",
      });
      expect(answered.isError).toBe(false);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
      });
      expect(settled.text).toContain("USED-ANSWER");
    },
  );

  test(
    "a session listing's details satisfy sessionDetailsSchema",
    async () => {
      // Issue #51: the delegate_session envelope is pinned too.
      session = await openDelegateBoundary();
      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.isError).toBe(false);
      expect(Check(sessionDetailsSchema, listed.details)).toBe(true);
    },
  );

  test(
    "a quarantined outcome sets usageLowerBound: true under syncDispatchDetailsSchema",
    async () => {
      // Issue #51: details.usageLowerBound is literally `true` (not a
      // count, not a string) — set when a task's accounting is
      // incomplete. A stall that fires while the provider call is
      // gated records a quarantined failure.
      session = await openDelegateBoundary();
      configureDelegate(session, { stallTimeoutMs: 500 });
      const subagents = await installSubagentModel(session);
      const held = gate("TOO-LATE");
      subagents.respond([held.step]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "hang" }],
      });
      const details = objectOf(result.details, "details");
      expect(details.usageLowerBound).toBe(true);
      expect(Check(syncDispatchDetailsSchema, result.details)).toBe(true);

      held.release();
    },
  );
});

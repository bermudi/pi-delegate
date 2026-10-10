import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
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

/** Poll until true, bounded — keeps in-flight ordering assertions stable. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250 && !probe(); i++) await Bun.sleep(20);
  expect(probe(), `${what} (timed out waiting)`).toBeTrue();
}

/** Count user messages in the child's provider-visible transcript carrying `text`. */
function steerCopies(context: TranscriptContext, text: string): number {
  return context.messages.filter((message) => {
    if (message.role !== "user") return false;
    const content = message.content;
    if (typeof content === "string") return content.includes(text);
    return content.some(
      (part) => part.type === "text" && part.text.includes(text),
    );
  }).length;
}

function steerDetails(result: { details?: unknown }): Record<string, unknown> {
  return objectOf(objectOf(result.details, "result.details").steer, "details.steer");
}

/** #61 removes cross-harness spellings; #44 steering identities survive. */
describe("canonical reflex boundary (SPEC v3, #61 / #44)", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  for (const [field, canonical, value] of [
    ["agent_type", "agent", "explore"],
    ["task_name", "id", "named-task"],
    ["message", "prompt", "work"],
  ] as const) {
    for (const shape of ["task", "flat", "stringified"] as const) {
      test(`${field} rejects ${shape} dispatch, including agreement and null`, async () => {
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        for (const aliasValue of [value, null]) {
          const task = { prompt: "work", [canonical]: value, [field]: aliasValue };
          const result = await callDelegate(session, shape === "flat"
            ? task
            : { tasks: shape === "stringified" ? JSON.stringify([task]) : [{ prompt: "valid sibling" }, task] });
          expect(result.isError, `${shape} ${field}=${JSON.stringify(aliasValue)} must reject`).toBe(true);
          expect(result.text).toContain(field);
          expect(result.text).toContain(canonical);
          expect(subagents.state.callCount).toBe(0);
        }
      });
    }
  }

  test("spawn_agent-shaped task_name + message rejects instead of dispatching", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const result = await callDelegate(session, {
      task_name: "spawned-one", message: "summarize the tree",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/task_name|message/);
    expect(result.text).toMatch(/id|prompt/);
    expect(subagents.state.callCount).toBe(0);
  });

  test("bare message on delegate retains steer migration guidance", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const result = await callDelegate(session, { message: "keep going" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("delegate_ticket");
    expect(result.text).toContain("steer");
    expect(subagents.state.callCount).toBe(0);
  });

  for (const action of ["wait", "poll"] as const) {
    test(`timeout_ms rejects on ${action}, even agreeing with timeoutMs or null`, async () => {
      session = await openDelegateBoundary();
      for (const value of [1000, 2000, null]) {
        const result = await callDelegateTicket(session, {
          action, ticket: "ticket-none", timeout_ms: value,
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("timeout_ms");
        expect(result.text).toContain("timeoutMs");
        expect(result.text).not.toContain('field "timeout_ms" →');
      }
    });
  }

  test("`reasoning_effort` rejects with the effort wall everywhere (#44.4)", async () => {
    // Same teaching as `thinking`, in its own spelling — inside a task,
    // flat-folded, stranded at the top level, and on the sibling tools.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    for (const arguments_ of [
      { tasks: [{ prompt: "x", reasoning_effort: "high" }] },
      { prompt: "x", reasoning_effort: "high" },
      { tasks: [{ prompt: "x" }], reasoning_effort: "high" },
    ]) {
      const result = await callDelegate(session, arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("reasoning_effort field is not accepted");
      expect(result.text).toContain("do not select subagent effort");
    }
    const ticket = await callDelegateTicket(session, {
      action: "poll",
      reasoning_effort: "high",
    });
    expect(ticket.isError).toBe(true);
    expect(ticket.text).toContain("reasoning_effort field is not accepted");
    const sessionResult = await callDelegateSession(session, {
      action: "list",
      reasoning_effort: "high",
    });
    expect(sessionResult.isError).toBe(true);
    expect(sessionResult.text).toContain(
      "reasoning_effort field is not accepted",
    );
    expect(subagents.state.callCount).toBe(0);
  });

  test("every steer keys on `steer:<toolCallId>` and the receipt names it", async () => {
    // #44.6: the tool-call id is the idempotency seed (minimax's
    // task-append:<turnId>:<toolCallId> pattern scoped to the id this
    // boundary sees). #130: caller keys are gone — the derived key is
    // the only key, and receipts no longer mark derivation.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const first = gate("TURN-ONE");
    let copies = -1;
    const second: FauxResponseFactory = (context) => {
      copies = steerCopies(context, "DERIVED-STEER");
      return fauxAssistantMessage("TURN-TWO-SAW-IT");
    };
    subagents.respond([first.step, second]);

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
      message: "DERIVED-STEER",
    });
    expect(receipt.isError).toBe(false);
    const derivedKey = `steer:${receipt.toolCallId}`;
    const steer = steerDetails(receipt);
    expect(steer.steerId).toBe(derivedKey);
    expect(steer.derived).toBeUndefined();
    expect(steer.status).toBe("steered");
    expect(receipt.text).toContain(derivedKey);
    // Duplicate replay and key conflict need a caller key to trigger
    // (#130 removed it): a transport retry replays the same tool call,
    // which the playbook boundary cannot express (unique ids per call).
    // Store-level dedup stays — asserted via the steering receipts test.

    first.release();
    const waited = await callDelegateTicket(session, {
      action: "wait",
      ticket,
    });
    expect(waited.text).toContain("TURN-TWO-SAW-IT");
    // The child observed the steer exactly once.
    expect(copies).toBe(1);
  });

  test("an explicit `steerId` rejects with removal teaching", async () => {
    // #130: the caller key is gone — dedup is automatic, so the field
    // has no work left. Presence rejects on any action, both spellings.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("DONE")]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "work" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegateTicket(session, { action: "wait", ticket });

    for (const arguments_ of [
      { action: "steer", ticket, message: "m", steerId: "caller-key-1" },
      { action: "steer", ticket, message: "m", steer_id: "caller-key-2" },
      { action: "poll", ticket, steerId: "caller-key-3" },
    ] as const) {
      const result = await callDelegateTicket(session, arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("steerId field has been removed");
      expect(result.text).toContain("dedupe automatically");
    }
  });
});

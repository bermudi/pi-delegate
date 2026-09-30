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
          action, ticket: "ticket-none", timeoutMs: 1000, timeout_ms: value,
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

  test("steer without `steerId` derives `steer:<toolCallId>` and the receipt names it", async () => {
    // #44.6: the tool-call id is the idempotency seed (minimax's
    // task-append:<turnId>:<toolCallId> pattern scoped to the id this
    // boundary sees). The receipt carries the derived key, marked derived.
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
    expect(steer.derived).toBe(true);
    expect(steer.status).toBe("steered");
    expect(receipt.text).toContain(derivedKey);
    expect(receipt.text).toMatch(/derived from this call/);

    // Same key + same message replays the stored receipt — the derived
    // key can be echoed back verbatim (':' is admitted for exactly this).
    const replay = await callDelegateTicket(session, {
      action: "steer",
      ticket,
      message: "DERIVED-STEER",
      steerId: derivedKey,
    });
    expect(replay.isError).toBe(false);
    const replayed = steerDetails(replay);
    expect(replayed.status).toBe("duplicate");
    expect(replayed.replayed).toBe("steered");
    expect(replay.text).toBe(receipt.text);

    // Same key + different content stays a conflict.
    const conflict = await callDelegateTicket(session, {
      action: "steer",
      ticket,
      message: "DIFFERENT-STEER",
      steerId: derivedKey,
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("conflict");

    first.release();
    const waited = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(waited.text).toContain("TURN-TWO-SAW-IT");
    // The child observed the steer exactly once — the replay never
    // re-injected.
    expect(copies).toBe(1);
  });

  test("an explicit `steerId` is unmarked — no derived note on the receipt", async () => {
    // #44.6: explicit keys keep the power path — same dedup semantics,
    // no derivation note.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const first = gate("GATED");
    subagents.respond([first.step, fauxAssistantMessage("DONE")]);

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
      message: "EXPLICIT-STEER",
      steerId: "caller-key-1",
    });
    expect(receipt.isError).toBe(false);
    const steer = steerDetails(receipt);
    expect(steer.steerId).toBe("caller-key-1");
    expect(steer.derived).toBeUndefined();
    expect(receipt.text).not.toContain("derived");

    first.release();
    await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
  });
});

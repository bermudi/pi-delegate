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

/**
 * Issue #44 — the trained-reflex long tail: `agent_type`/`task_name`/
 * `message`/`timeout_ms` spellings, the `explorer` alias, the
 * `reasoning_effort` wall, the `message` misroute fix, and the derived
 * `steerId` fallback. Each acceptance item gets a boundary test.
 */
describe("trained-reflex long tail (SPEC v3 'Reflex meeting', issue #44)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("`agent_type` folds to `agent` before resolution — aliases still apply", async () => {
    // #44.1: same machinery as `subagent_type` — the value folds pre-
    // resolution so the alias table sees it; each rename notes on the result.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("VIA-EXPLORER")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "work", agent_type: "explorer", tools: ["read"] }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("VIA-EXPLORER");
    expect(result.text).toContain('field "agent_type" → "agent"');
    expect(result.text).toContain('agent "explorer" → "explore"');
  });

  test("`agent_type` conflicting with `agent` rejects naming both spellings", async () => {
    // #44.1: conflict rules identical to `subagent_type` — the same field
    // under two spellings must agree.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", agent: "coder", agent_type: "explore" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("'agent'");
    expect(result.text).toContain("'agent_type'");
    expect(result.text).toMatch(/same field under (two|different) spellings/);
    expect(subagents.state.callCount).toBe(0);
  });

  test("a spawn_agent-shaped call (`task_name` + `message`) dispatches as a task, not steer guidance", async () => {
    // #44.5 misroute fix: `message` is steer-owned only when the call is
    // not task-shaped. `task_name`/`message` fold to `id`/`prompt` with
    // rename notes; nothing routes to delegate_ticket.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SPAWN-SHAPE-OK")]);

    const result = await callDelegate(session, {
      task_name: "spawned-one",
      message: "summarize the tree",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("SPAWN-SHAPE-OK");
    expect(result.text).toContain('field "task_name" → "id"');
    expect(result.text).toContain('field "message" → "prompt"');
    expect(result.text).toContain("spawned-one");
    expect(result.text).not.toContain("delegate_ticket");
  });

  test("`message` inside an explicit task object folds to `prompt`", async () => {
    // #44.5: the task-level spelling folds in the tasks array too.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("TASK-MESSAGE-OK")]);

    const result = await callDelegate(session, {
      tasks: [{ task_name: "msg-task", message: "describe the repo" }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("TASK-MESSAGE-OK");
    expect(result.text).toContain('field "message" → "prompt"');
  });

  test("`message` alone on delegate still routes to steer guidance", async () => {
    // #44.5: only task-shaped calls fold — a bare `message` is the
    // pre-split steer reflex and keeps its delegate_ticket teaching.
    session = await openDelegateBoundary();

    const result = await callDelegate(session, {
      message: "keep going on the fix",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("delegate_ticket");
    expect(result.text).toContain("steer");
  });

  test("`message` conflicting with `prompt` in one task rejects", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "alpha", message: "beta" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("'prompt'");
    expect(result.text).toContain("'message'");
    expect(subagents.state.callCount).toBe(0);
  });

  test("`timeout_ms` folds to `timeoutMs` on wait with a rename note", async () => {
    // #44.3: the cross-harness spelling is accepted and the receipt
    // teaches the canonical name — the same fold convention as dispatch.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("WAITED-OUT")]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "work" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeout_ms: 5000,
    });

    expect(settled.isError).toBe(false);
    expect(settled.text).toContain('field "timeout_ms" → "timeoutMs"');
    expect(settled.text).toContain("WAITED-OUT");
  });

  test("`timeout_ms` on a non-wait action rejects naming the sent spelling", async () => {
    session = await openDelegateBoundary();

    const result = await callDelegateTicket(session, {
      action: "poll",
      timeout_ms: 1000,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("timeout_ms");
    expect(result.text).toContain("wait");
  });

  test("`timeoutMs` and `timeout_ms` disagreeing rejects; agreeing folds", async () => {
    session = await openDelegateBoundary();

    const clash = await callDelegateTicket(session, {
      action: "wait",
      ticket: "ticket-none",
      timeoutMs: 1000,
      timeout_ms: 2000,
    });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain("timeoutMs");
    expect(clash.text).toContain("timeout_ms");
    expect(clash.text).toContain("same field");

    // Same value under both spellings is not a conflict — the rename
    // note still teaches the canonical field.
    const ok = await callDelegateTicket(session, {
      action: "wait",
      ticket: "ticket-none",
      timeoutMs: 1000,
      timeout_ms: 1000,
    });
    expect(ok.text).toContain('field "timeout_ms" → "timeoutMs"');
    expect(ok.isError).toBe(true); // no such ticket — validation passed
    expect(ok.text).not.toContain("same field");
  });

  test("`reasoning_effort` rejects with the effort wall everywhere (#44.4)", async () => {
    // Same teaching as `thinking`, in its own spelling — inside a task,
    // flat-folded, stranded at the top level, and on the sibling tools.
    session = await openDelegateBoundary();
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

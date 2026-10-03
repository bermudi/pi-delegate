import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  callDelegate, configureDelegate, installSubagentModel, openDelegateBoundary, ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

// New #17 contract, not migrated from a v1 helper: exercise the registered
// parent tool and a real (provider-free) child ask_parent tool together.
async function untilQuestion(session: TestSession, ticket: string): Promise<string> {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const view = await callDelegateTicket(session, { action: "poll", ticket });
    const match = view.text.match(/Waiting for parent answer: task \S+, question (q-\d+):/);
    if (match) return match[1]!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Worker did not ask a question on ticket ${ticket}`);
}

describe("async worker questions (#17)", () => {
  let session: TestSession | undefined;
  afterEach(() => { session?.dispose(); session = undefined; });

  test("worker waits visibly, another ticket uses its freed capacity, and the correlated answer resumes it", async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, { maxConcurrent: 1, stallTimeoutMs: 80 });
    const model = await installSubagentModel(session);
    const respond: FauxResponseFactory = (context) => {
      const transcript = JSON.stringify(context.messages);
      if (transcript.includes("SECOND-TASK")) return fauxAssistantMessage("SECOND-DONE");
      if (transcript.includes("PARENT-ANSWER")) return fauxAssistantMessage("USED-PARENT-ANSWER");
      return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Which path?" })]);
    };
    model.respond([respond, respond, respond]);
    const first = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "first", prompt: "FIRST-TASK", tools: ["read"] }], async: true,
    })).text);
    const questionId = await untilQuestion(session, first);
    const roster = await callDelegateTicket(session, { action: "poll" });
    expect(roster.text).toContain("Which path?");
    // The idle capacity is released; the first worker's question must not
    // monopolize the global or per-model slot.
    const second = ticketIdOf((await callDelegate(session, {
      tasks: [{ prompt: "SECOND-TASK", tools: ["read"] }], async: true,
    })).text);
    const finished = await callDelegateTicket(session, { action: "wait", ticket: second, timeoutMs: 2000 });
    expect(finished.text).toContain("SECOND-DONE");
    const wrongTask = await callDelegateTicket(session, {
      action: "answer", ticket: first, taskId: "wrong", questionId, answer: "PARENT-ANSWER",
    });
    expect(wrongTask.isError).toBe(true);
    const answered = await callDelegateTicket(session, {
      action: "answer", ticket: first, taskId: "first", questionId, answer: "PARENT-ANSWER",
    });
    expect(answered.isError).toBe(false);
    expect((await callDelegateTicket(session, {
      action: "answer", ticket: first, taskId: "first", questionId, answer: "DIFFERENT",
    })).isError).toBe(true);
    const result = await callDelegateTicket(session, { action: "wait", ticket: first, timeoutMs: 2000 });
    expect(result.text).toContain("USED-PARENT-ANSWER");
    expect(result.text).not.toContain("Waiting for parent answer");
    expect((await callDelegateTicket(session, {
      action: "answer", ticket: first, taskId: "first", questionId, answer: "PARENT-ANSWER",
    })).isError).toBe(true);
  });

  test("forced cancellation invalidates the pending question and does not unblock a worker", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Proceed?" })])]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "cancel", prompt: "ASK" }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    await callDelegateTicket(session, { action: "cancel", ticket, force: true });
    expect((await callDelegateTicket(session, {
      action: "answer", ticket, taskId: "cancel", questionId, answer: "yes",
    })).isError).toBe(true);
    const result = await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 2000 });
    expect(result.text).toContain("cancelled");
  });

  test("question wait retains the shared-write reservation even though capacity is free", async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, { maxConcurrent: 1 });
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Should I edit?" })]),
      fauxAssistantMessage("FINISHED"),
    ]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "writer", prompt: "ask", tools: ["write"] }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    const conflicting = await callDelegate(session, {
      tasks: [{ prompt: "same tree", tools: ["write"] }], async: true,
    });
    expect(conflicting.isError).toBe(true);
    expect(conflicting.text).toMatch(/overlap|conflict|reserved|active/i);
    expect(model.state.callCount).toBe(1);
    await callDelegateTicket(session, { action: "answer", ticket, taskId: "writer", questionId, answer: "do it" });
    expect((await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 2000 })).text).toContain("FINISHED");
  });

  test("an answer while paused is recorded once; another answer cannot replace it", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Choice?" })]),
      fauxAssistantMessage("ANSWERED"),
    ]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "paused", prompt: "ask" }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    await callDelegateTicket(session, { action: "pause", ticket });
    const reply = { action: "answer", ticket, taskId: "paused", questionId, answer: "original" };
    expect((await callDelegateTicket(session, reply)).isError).toBe(false);
    expect((await callDelegateTicket(session, reply)).isError).toBe(false);
    expect((await callDelegateTicket(session, { ...reply, answer: "changed" })).isError).toBe(true);
    expect(model.state.callCount).toBe(1);
    await callDelegateTicket(session, { action: "resume", ticket });
    expect((await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 2000 })).text).toContain("ANSWERED");
  });

  test("answer RPC fields are ticket-only and validated before any worker starts", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    for (const args of [
      { action: "answer", ticket: "missing", taskId: "t", questionId: "q" },
      { action: "poll", ticket: "missing", answer: "oops" },
      { action: "answer", ticket: "missing", taskId: "t", questionId: "q", answer: "" },
    ]) {
      expect((await callDelegateTicket(session, args)).isError).toBe(true);
    }
    // A dispatch carrying a ticket-only field gets cross-tool guidance, not
    // a worker start.
    expect((await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "no start" }], answer: "oops",
    })).isError).toBe(true);
    // Whitespace is a string the schema accepts, so only validation can
    // stop it — and the bogus ticket id proves it does: validation runs
    // before lookup, and the error names the answer field, not the ticket.
    const blank = await callDelegateTicket(session, {
      action: "answer", ticket: "missing", taskId: "t", questionId: "q", answer: "   ",
    });
    expect(blank.isError).toBe(true);
    expect(blank.text).toContain('action "answer" requires a nonempty answer');
    expect(model.state.callCount).toBe(0);
  });

  test("a parent already waiting on a ticket is released when its worker asks", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ask: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Unblock parent?" })]);
    };
    model.respond([ask, fauxAssistantMessage("done")]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "block", prompt: "ask" }], async: true,
    })).text);
    const waiting = callDelegateTicket(session, { action: "wait", ticket });
    release();
    const result = await Promise.race([
      waiting,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("parent wait deadlocked")), 1500)),
    ]);
    expect(result.text).toContain("Unblock parent?");
    expect(result.text).toContain("Wait detached");
    const match = result.text.match(/question (q-\d+):/);
    expect(match).not.toBeNull();
    await callDelegateTicket(session, {
      action: "answer", ticket, taskId: "block", questionId: match![1], answer: "yes",
    });
    expect((await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 2000 })).text).toContain("done");
  });

  test("a worker-question notice rides steering delivery like a result wake", async () => {
    // Contract (user decision 2026-10-02, live session 01a0fdba):
    // same-leaf question notices steer — they merge at a busy parent's
    // next turn boundary and wake an idle one, rather than parking on
    // the follow-up queue until the whole run ends.
    session = await openDelegateBoundary();
    const host = session.session as AgentSession;
    const sends = spyOn(host, "sendCustomMessage");
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Steer me?" })]),
      fauxAssistantMessage("ANSWERED"),
    ]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ prompt: "ask" }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    const notice = sends.mock.calls.find(
      (call) =>
        (call[0] as { customType?: string }).customType ===
        "delegate-question",
    );
    expect(notice).toBeDefined();
    expect(notice![1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    await callDelegateTicket(session, {
      action: "answer", ticket, taskId: "task-1", questionId, answer: "yes",
    });
    expect(
      (await callDelegateTicket(session, {
        action: "wait", ticket, timeoutMs: 2000,
      })).text,
    ).toContain("ANSWERED");
  });

  test("a question beside another tool call is rejected rather than parking a still-active worker", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("ask_parent", { question: "Unsafe to park?" }),
        fauxToolCall("read", { path: "AGENTS.md" }),
      ]),
      fauxAssistantMessage("TURN-COMPLETED"),
    ]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ prompt: "ask and read", tools: ["read"] }], async: true,
    })).text);
    const settled = await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 2000 });
    expect(settled.text).toContain("TURN-COMPLETED");
    expect((await callDelegateTicket(session, { action: "poll", ticket })).text).not.toContain("Waiting for parent answer");
  });

  test("a pooled worker can ask on a later async run after a synchronous run", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage("FIRST-DONE"),
      fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Next step?" })]),
      fauxAssistantMessage("SECOND-DONE"),
    ]);
    const first = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "first", sessionId: "reuse", tools: ["read"] }],
    });
    expect(first.text).toContain("FIRST-DONE");
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "again", prompt: "second", sessionId: "reuse", tools: ["read"] }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    await callDelegateTicket(session, {
      action: "answer", ticket, taskId: "again", questionId, answer: "continue",
    });
    expect((await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 2000 })).text).toContain("SECOND-DONE");
  });

  test("cancelling an answered worker queued to reacquire capacity cannot restart it", async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, { maxConcurrent: 1 });
    const model = await installSubagentModel(session);
    let releaseOccupier!: () => void;
    const occupierGate = new Promise<void>((resolve) => { releaseOccupier = resolve; });
    let startedOccupier!: () => void;
    const occupierStarted = new Promise<void>((resolve) => { startedOccupier = resolve; });
    const respond: FauxResponseFactory = async (context) => {
      if (JSON.stringify(context.messages).includes("OCCUPY")) {
        startedOccupier();
        await occupierGate;
        return fauxAssistantMessage("OCCUPIER-FINISHED");
      }
      if (context.messages.some((message) => message.role === "toolResult")) {
        return fauxAssistantMessage("MUST-NOT-CONTINUE");
      }
      return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Can I resume?" })]);
    };
    model.respond([respond, respond, respond]);
    const first = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "waiting", prompt: "ASK FIRST", tools: ["read"] }], async: true,
    })).text);
    const questionId = await untilQuestion(session, first);
    const second = ticketIdOf((await callDelegate(session, {
      tasks: [{ prompt: "OCCUPY", tools: ["read"] }], async: true,
    })).text);
    let startTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        occupierStarted,
        new Promise<never>((_, reject) => {
          startTimeout = setTimeout(() => {
            releaseOccupier();
            reject(new Error("occupying worker did not start"));
          }, 2000);
        }),
      ]);
    } finally {
      if (startTimeout !== undefined) clearTimeout(startTimeout);
    }
    await callDelegateTicket(session, {
      action: "answer", ticket: first, taskId: "waiting", questionId, answer: "yes",
    });
    await callDelegateTicket(session, { action: "cancel", ticket: first, force: true });
    releaseOccupier();
    expect((await callDelegateTicket(session, { action: "wait", ticket: second, timeoutMs: 2000 })).text).toContain("OCCUPIER-FINISHED");
    const cancelled = await callDelegateTicket(session, { action: "poll", ticket: first });
    expect(cancelled.text).toContain("cancelled");
    expect(cancelled.text).not.toContain("MUST-NOT-CONTINUE");
    expect(model.state.callCount).toBe(2);
  });

  test("session shutdown cancels a worker's pending question; late answers fail", async () => {
    // SPEC "Worker questions": cancellation AND shutdown
    // interrupt unanswered questions without resurrecting terminal work.
    // Shutdown force-cancels every ticket, which must invalidate the
    // question, release the worker, and leave a late answer impossible.
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Still there?" })]),
      fauxAssistantMessage("MUST-NOT-CONTINUE"),
    ]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "asker", prompt: "ASK" }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);

    const shutdown = (session.session as AgentSession).extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    await Promise.race([
      shutdown,
      Bun.sleep(15_000).then(() => {
        throw new Error("shutdown never settled after the question was cancelled");
      }),
    ]);

    const view = await callDelegateTicket(session, { action: "poll", ticket });
    expect(view.text).toContain("cancelled");
    expect(view.text).not.toContain("Waiting for parent answer");
    expect(view.text).not.toContain("MUST-NOT-CONTINUE");
    const late = await callDelegateTicket(session, {
      action: "answer", ticket, taskId: "asker", questionId, answer: "too late",
    });
    expect(late.isError).toBe(true);
  }, 20_000);
});

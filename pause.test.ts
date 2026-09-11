import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { PauseController } from "./pause.ts";
import { runAgentSession } from "./runner.ts";
import { emptyUsage } from "./usage.ts";
import { _setStallTimeoutForTesting } from "./config.ts";
import { findTouchedOverlaps } from "./format.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for test checkpoint");
}

describe("ticket pause checkpoints", () => {
  test("active work drains; all active participants must park or finish", async () => {
    const pause = new PauseController();
    pause.enter(0);
    pause.enter(1);
    pause.pause();
    expect(pause.state).toBe("pausing");
    const first = pause.checkpoint(0);
    expect(pause.state).toBe("pausing");
    pause.leave(1);
    expect(pause.state).toBe("paused");
    pause.resume();
    await first;
    expect(pause.state).toBe("running");
    expect(pause.isParked(0)).toBe(false);
    pause.leave(0);
  });

  test("queued work parks without becoming active and cancel unblocks it", async () => {
    const pause = new PauseController();
    const abort = new AbortController();
    pause.pause();
    let advanced = false;
    const queued = pause.checkpoint(0, abort.signal).then(() => {
      advanced = true;
    });
    expect(pause.state).toBe("paused");
    await Promise.resolve();
    expect(advanced).toBe(false);
    abort.abort();
    await queued;
    expect(advanced).toBe(true);
    expect(pause.isParked(0)).toBe(false);
  });

  test("resume then immediate re-pause cannot leak a waiting operation", async () => {
    const pause = new PauseController();
    pause.enter(0);
    pause.pause();
    let advanced = false;
    const parked = pause.checkpoint(0).then(() => {
      advanced = true;
    });
    pause.resume();
    pause.pause();
    await Promise.resolve();
    await Promise.resolve();
    expect(advanced).toBe(false);
    expect(pause.state).toBe("paused");
    pause.resume();
    await parked;
    pause.leave(0);
  });
});

// Real Pi Agent loop, with a local canned stream (no credentials or network).
// AgentSession's notification subscribers cannot provide this barrier; these
// tests deliberately exercise the core Agent's awaited event subscribers.
function loopFixture(pause: PauseController, toolDone = deferred()) {
  const toolStarted = deferred();
  const model: Model<"openai-completions"> = {
    id: "pause-test",
    name: "Pause test",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://invalid.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  let requests = 0;
  let toolFinished = false;
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        {
          name: "work",
          label: "work",
          description: "test operation",
          parameters: Type.Object({}),
          execute: async () => {
            toolStarted.resolve();
            await toolDone.promise;
            toolFinished = true;
            return { content: [{ type: "text", text: "done" }], details: {} };
          },
        },
      ],
    },
    streamFn: () => {
      requests++;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        timestamp: Date.now(),
        stopReason: requests === 1 ? "toolUse" : "stop",
        content:
          requests === 1
            ? [{ type: "toolCall", id: "work-1", name: "work", arguments: {} }]
            : [{ type: "text", text: "finished" }],
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: requests === 1 ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    },
  });
  const subscribe = agent.subscribe.bind(agent);
  const subscriptions = new Set<symbol>();
  agent.subscribe = (listener) => {
    const key = Symbol();
    subscriptions.add(key);
    const unsubscribe = subscribe(listener);
    return () => {
      subscriptions.delete(key);
      unsubscribe();
    };
  };
  const session = {
    agent,
    subscribe: (listener: (event: AgentEvent) => void) =>
      agent.subscribe(listener),
    prompt: (text: string) => agent.prompt(text),
    abort: async () => {
      agent.abort();
      await agent.waitForIdle();
    },
    abortCompaction: () => {},
    abortBranchSummary: () => {},
    get isIdle() {
      return !agent.state.isStreaming;
    },
    get isCompacting() {
      return false;
    },
    get messages() {
      return agent.state.messages;
    },
    get state() {
      return agent.state;
    },
    getSessionStats: () => ({ tokens: emptyUsage(), cost: 0 }),
  } as unknown as AgentSession;
  const run = (signal?: AbortSignal, deadlineAt?: number) => {
    pause.enter(0);
    return runAgentSession(
      session,
      "test",
      { cwd: "/tmp" },
      signal,
      undefined,
      undefined,
      Date.now(),
      deadlineAt,
      undefined,
      { controller: pause, index: 0 },
    ).finally(() => pause.leave(0));
  };
  return {
    run,
    toolStarted,
    toolDone,
    agent,
    requests: () => requests,
    toolFinished: () => toolFinished,
    subscriberCount: () => subscriptions.size,
  };
}

describe("real Pi loop pause", () => {
  test.each(["abort", "deadline"] as const)(
    "cleans up pause listeners on pre-prompt %s",
    async (reason) => {
      const pause = new PauseController();
      const fixture = loopFixture(pause);
      const abort = new AbortController();
      if (reason === "abort") abort.abort();
      const result = await fixture.run(
        abort.signal,
        reason === "deadline" ? Date.now() - 1 : undefined,
      );
      expect(result.failureKind).toBe(
        reason === "abort" ? "cancelled" : "deadline_exceeded",
      );
      expect(result.prompted).toBe(false);
      expect(fixture.requests()).toBe(0);
      expect(fixture.subscriberCount()).toBe(0);
    },
  );

  test("a naturally final turn completes instead of parking forever", async () => {
    const pause = new PauseController();
    const fixture = loopFixture(pause);
    const abort = new AbortController();
    const unsubscribe = fixture.agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "stop"
      ) {
        pause.pause();
      }
    });
    const run = fixture.run(abort.signal);
    try {
      await fixture.toolStarted.promise;
      fixture.toolDone.resolve();
      const result = await run;
      expect(result.error).toBeUndefined();
      expect(result.output).toContain("finished");
      expect(pause.isParked(0)).toBe(false);
      // Only this test's own final-message observer remains.
      expect(fixture.subscriberCount()).toBe(1);
    } finally {
      unsubscribe();
      fixture.toolDone.resolve();
      abort.abort();
      pause.resume();
      await run;
    }
  });

  test("finishes current tools, parks before next request, resumes same conversation", async () => {
    const pause = new PauseController();
    const fixture = loopFixture(pause);
    const abort = new AbortController();
    const run = fixture.run(abort.signal);
    try {
      await fixture.toolStarted.promise;
      pause.pause();
      expect(pause.state).toBe("pausing");
      expect(fixture.toolFinished()).toBe(false);
      fixture.toolDone.resolve();
      await until(() => pause.state === "paused");
      expect(fixture.toolFinished()).toBe(true);
      expect(fixture.requests()).toBe(1);
      expect(
        fixture.agent.state.messages.some((m) => m.role === "toolResult"),
      ).toBe(true);
      pause.resume();
      const result = await run;
      expect(result.error).toBeUndefined();
      expect(result.output).toContain("finished");
      expect(fixture.requests()).toBe(2);
      expect(fixture.subscriberCount()).toBe(0);
    } finally {
      fixture.toolDone.resolve();
      abort.abort();
      pause.resume();
      await run;
    }
  });

  test("cancel releases a parked turn without another successful model response", async () => {
    const pause = new PauseController();
    const fixture = loopFixture(pause);
    const abort = new AbortController();
    const run = fixture.run(abort.signal);
    await fixture.toolStarted.promise;
    pause.pause();
    fixture.toolDone.resolve();
    await until(() => pause.state === "paused");
    abort.abort();
    const result = await run;
    expect(result.failureKind).toBe("cancelled");
    expect(fixture.requests()).toBe(1);
    expect(pause.isParked(0)).toBe(false);
    expect(fixture.subscriberCount()).toBe(0);
  });

  test("parked time does not trigger the inactivity watchdog", async () => {
    _setStallTimeoutForTesting(40);
    const pause = new PauseController();
    const fixture = loopFixture(pause);
    const abort = new AbortController();
    const run = fixture.run(abort.signal);
    try {
      await fixture.toolStarted.promise;
      pause.pause();
      fixture.toolDone.resolve();
      await until(() => pause.state === "paused");
      await Bun.sleep(90);
      expect(pause.isParked(0)).toBe(true);
      expect(fixture.requests()).toBe(1);
      pause.resume();
      expect((await run).error).toBeUndefined();
    } finally {
      fixture.toolDone.resolve();
      abort.abort();
      pause.resume();
      await run;
      _setStallTimeoutForTesting(undefined);
    }
  });

  test("wall-clock deadline still cancels a parked turn", async () => {
    const pause = new PauseController();
    const fixture = loopFixture(pause);
    const run = fixture.run(undefined, Date.now() + 120);
    await fixture.toolStarted.promise;
    pause.pause();
    fixture.toolDone.resolve();
    await until(() => pause.state === "paused");
    const result = await run;
    expect(result.failureKind).toBe("deadline_exceeded");
    expect(pause.isParked(0)).toBe(false);
    expect(fixture.subscriberCount()).toBe(0);
  });
});

describe("ordered file attribution", () => {
  test("same chain is not an unordered overlap; unrelated owners still warn", () => {
    const ordered = [
      { attributedFiles: ["/shared"], serializedGroup: 0 },
      { attributedFiles: ["/shared"], serializedGroup: 0 },
    ];
    expect(findTouchedOverlaps(ordered)).toEqual([]);
    expect(
      findTouchedOverlaps([
        ...ordered,
        { attributedFiles: ["/shared"], serializedGroup: 1 },
      ]),
    ).toEqual(["/shared"]);
    expect(
      findTouchedOverlaps([...ordered, { attributedFiles: ["/shared"] }]),
    ).toEqual(["/shared"]);
  });

  test("incomplete tasks cannot establish safe ordering", () => {
    expect(
      findTouchedOverlaps([
        {
          attributedFiles: ["/shared"],
          serializedGroup: 0,
          incomplete: "quiescence_abandoned",
        },
        { attributedFiles: ["/shared"], serializedGroup: 0 },
      ]),
    ).toEqual(["/shared"]);
  });

  test("duplicate evidence from one task is not an overlap", () => {
    expect(
      findTouchedOverlaps([{ attributedFiles: ["/shared", "/shared"] }]),
    ).toEqual([]);
  });
});

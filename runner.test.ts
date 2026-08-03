/**
 * Unit tests for runAgentSession's abort handling.
 *
 * The runner attaches the parent AbortSignal to `session.abort()` *after*
 * lifecycle has acquired/built the session. addEventListener("abort", …, { once })
 * does NOT fire for an already-aborted signal, so the runner re-checks
 * `signal.aborted` after registering the listener and returns "Aborted" before
 * ever calling `session.prompt()`. These tests pin that seam with a fake
 * AgentSession so we don't need a real model/stream.
 */
import { describe, expect, test } from "bun:test";
import { runAgentSession } from "./runner.ts";
import { _setStallTimeoutForTesting } from "./config.ts";

/** Minimal fake AgentSession — records whether prompt() was invoked and allows
 *  emitting tool events / mutating messages and stats. */
function fakeSession(opts: {
  prompt?: (emit: (e: unknown) => void) => Promise<void>;
  messages?: unknown[];
  getMessages?: () => unknown[];
  state?: unknown;
  abort?: () => Promise<void> | void;
  abortCompaction?: () => void;
  abortBranchSummary?: () => void;
  isIdle?: () => boolean;
  isCompacting?: () => boolean;
  getStats?: () => {
    sessionFile?: string;
    sessionId?: string;
    userMessages?: number;
    assistantMessages?: number;
    toolCalls?: number;
    toolResults?: number;
    totalMessages?: number;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
    cost: number;
  };
}) {
  let prompted = false;
  const subscribers = new Set<(e: unknown) => void>();
  const emit = (e: unknown) => {
    for (const fn of subscribers) fn(e);
  };
  return {
    prompted: () => prompted,
    emit,
    session: {
      subscribe(fn: (e: unknown) => void) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
      async prompt(_p: string) {
        prompted = true;
        await opts.prompt?.(emit);
      },
      async abort() {
        await opts.abort?.();
      },
      abortCompaction() {
        opts.abortCompaction?.();
      },
      abortBranchSummary() {
        opts.abortBranchSummary?.();
      },
      get isIdle() {
        return opts.isIdle?.() ?? true;
      },
      get isCompacting() {
        return opts.isCompacting?.() ?? false;
      },
      get messages() {
        return opts.getMessages?.() ?? opts.messages ?? [];
      },
      get state() {
        return opts.state ?? {};
      },
      getSessionStats() {
        return (
          opts.getStats?.() ?? {
            sessionFile: undefined,
            sessionId: "test",
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 0,
            tokens: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
            cost: 0,
          }
        );
      },
    },
  };
}

describe("runAgentSession abort re-check", () => {
  test("already-aborted signal returns 'Aborted' without calling prompt()", async () => {
    const controller = new AbortController();
    controller.abort();

    const { session, prompted } = fakeSession({ messages: [] });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      controller.signal,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.error).toBe("Aborted");
    expect(prompted()).toBe(false);
  });

  test("no signal still prompts normally", async () => {
    let resolved = false;
    const { session, prompted } = fakeSession({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { totalTokens: 5 },
        },
      ],
      prompt: () => {
        resolved = true;
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(prompted()).toBe(true);
    expect(resolved).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("waits for post-settle compaction and its continuation before returning", async () => {
    let compacting = false;
    let agentActive = false;
    let callbackFinished = false;
    const firstAnswer = {
      role: "assistant",
      content: [{ type: "text", text: "answer before compaction" }],
    };
    const continuedAnswer = {
      role: "assistant",
      content: [{ type: "text", text: "answer after continuation" }],
    };

    const { session } = fakeSession({
      messages: [],
      isIdle: () => !agentActive,
      isCompacting: () => compacting,
      prompt: async (emit) => {
        emit({ type: "message_end", message: firstAnswer });
        emit({
          type: "agent_end",
          messages: [firstAnswer],
          willRetry: false,
        });
        emit({ type: "agent_settled" });

        // pi-codex-compaction starts ctx.compact() from agent_settled without
        // returning its promise. AgentSession.prompt() therefore returns while
        // this work is live.
        compacting = true;
        emit({ type: "compaction_start", reason: "manual" });
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          emit({
            type: "compaction_end",
            reason: "manual",
            result: {},
            aborted: false,
            willRetry: false,
          });
          compacting = false;

          // ctx.compact invokes onComplete after compaction_end. The callback
          // immediately sends the continuation turn.
          await Promise.resolve();
          agentActive = true;
          emit({ type: "agent_start" });
          emit({ type: "message_end", message: continuedAnswer });
          emit({
            type: "agent_end",
            messages: [continuedAnswer],
            willRetry: false,
          });
          agentActive = false;
          emit({ type: "agent_settled" });
          callbackFinished = true;
        })();
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(callbackFinished).toBe(true);
    expect(result.output).toContain("answer before compaction");
    expect(result.output).toContain("answer after continuation");
  });

  test("waits for a post-compaction error callback before returning ownership", async () => {
    let compacting = false;
    let errorCallbackFinished = false;
    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "answer before failed compaction" }],
    };
    const { session } = fakeSession({
      messages: [],
      isCompacting: () => compacting,
      prompt: async (emit) => {
        emit({ type: "message_end", message: answer });
        emit({ type: "agent_end", messages: [answer], willRetry: false });
        emit({ type: "agent_settled" });
        compacting = true;
        emit({ type: "compaction_start", reason: "manual" });
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          emit({
            type: "compaction_end",
            reason: "manual",
            result: undefined,
            aborted: false,
            willRetry: false,
            errorMessage: "Compaction failed",
          });
          compacting = false;
          // Pi calls ctx.compact({ onError }) only after compact() rejects.
          // Lifecycle may invalidate ctx immediately after the runner returns,
          // so this callback must be finished first.
          await Promise.resolve();
          errorCallbackFinished = true;
        })();
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(errorCallbackFinished).toBe(true);
    expect(result.output).toBe("answer before failed compaction");
  });

  test("parent abort cancels post-settle compaction before returning", async () => {
    const controller = new AbortController();
    let compacting = false;
    let compactionAborts = 0;
    let branchSummaryAborts = 0;
    let emitSessionEvent: ((event: unknown) => void) | undefined;
    const fake = fakeSession({
      messages: [],
      isCompacting: () => compacting,
      abortCompaction: () => {
        compactionAborts++;
        if (!compacting) return;
        compacting = false;
        emitSessionEvent?.({
          type: "compaction_end",
          reason: "manual",
          result: undefined,
          aborted: true,
          willRetry: false,
        });
      },
      abortBranchSummary: () => {
        branchSummaryAborts++;
      },
      prompt: async (emit) => {
        compacting = true;
        emit({ type: "compaction_start", reason: "manual" });
        setImmediate(() => controller.abort());
      },
    });
    emitSessionEvent = fake.emit;

    const result = await runAgentSession(
      fake.session as never,
      "do work",
      { cwd: process.cwd() },
      controller.signal,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.error).toBe("Aborted");
    expect(compactionAborts).toBe(1);
    expect(branchSummaryAborts).toBe(1);
    expect(compacting).toBe(false);
  });

  test("preserves output and tokens when compaction replaces the transcript", async () => {
    const messages: unknown[] = [];
    let statsCall = 0;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "survived compaction" }],
      usage: { totalTokens: 42 },
    };
    const { session } = fakeSession({
      messages,
      getStats: () => {
        const total = statsCall++ === 0 ? 0 : 42;
        return {
          tokens: {
            input: total,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total,
          },
          cost: 0,
        } as never;
      },
      prompt: async (emit) => {
        messages.push(assistant);
        emit({ type: "message_end", message: assistant });
        emit({
          type: "agent_end",
          messages: [assistant],
          willRetry: false,
        });
        // Pi replaces the live transcript after a compaction boundary.
        messages.splice(0);
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("survived compaction");
    expect(result.tokens).toBe(42);
    expect(result.usage.totalTokens).toBe(42);
  });

  test("discards retrying attempt text while retaining the settled attempt", async () => {
    const retryMessages: unknown[] = [];
    let statsCall = 0;
    const retryAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "transient failure" }],
      stopReason: "error",
    };
    const finalAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
    };
    const { session } = fakeSession({
      messages: retryMessages,
      getStats: () => {
        const total = statsCall++ === 0 ? 0 : 10;
        return {
          tokens: {
            input: total,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total,
          },
          cost: 0,
        } as never;
      },
      prompt: async (emit) => {
        emit({ type: "message_end", message: retryAssistant });
        emit({
          type: "agent_end",
          messages: [retryAssistant],
          willRetry: true,
        });
        emit({ type: "message_end", message: finalAssistant });
        emit({
          type: "agent_end",
          messages: [finalAssistant],
          willRetry: false,
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("final answer");
    expect(result.output).not.toContain("transient failure");
  });

  test("filters a cloned retry response positionally", async () => {
    const retryAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "cloned transient failure" }],
      stopReason: "error",
    };
    const retryAssistantCopy = {
      ...retryAssistant,
      content: [...retryAssistant.content],
    };
    const finalAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "final after cloned retry" }],
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        emit({ type: "message_end", message: retryAssistant });
        // The host/extension may copy the message before putting it in
        // agent_end. Filtering by object identity would leak the original.
        emit({
          type: "agent_end",
          messages: [retryAssistantCopy],
          willRetry: true,
        });
        emit({ type: "message_end", message: finalAssistant });
        emit({
          type: "agent_end",
          messages: [finalAssistant],
          willRetry: false,
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("final after cloned retry");
    expect(result.output).not.toContain("cloned transient failure");
  });

  test("retains earlier successful turns when the final turn is internally retried", async () => {
    const firstAssistant = {
      role: "assistant",
      content: [
        { type: "text", text: "completed the first turn" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ],
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
    };
    const retryAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "retrying response" }],
      stopReason: "error",
    };
    const finalAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        // This is the shape of the upstream agent loop: one agent_end carries
        // all messages produced in the run, while willRetry is about only the
        // final retryable assistant response.
        emit({ type: "message_end", message: firstAssistant });
        emit({ type: "message_end", message: toolResult });
        emit({ type: "message_end", message: retryAssistant });
        emit({
          type: "agent_end",
          messages: [firstAssistant, toolResult, retryAssistant],
          willRetry: true,
        });
        emit({ type: "message_end", message: finalAssistant });
        emit({
          type: "agent_end",
          messages: [finalAssistant],
          willRetry: false,
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toContain("completed the first turn");
    expect(result.output).toContain("final answer");
    expect(result.output).not.toContain("retrying response");
  });

  test("drops an overflow response when compaction retries it", async () => {
    const overflowAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "context overflow error" }],
      stopReason: "error",
    };
    const finalAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "successful answer after compaction" }],
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        emit({ type: "message_end", message: overflowAssistant });
        emit({
          type: "agent_end",
          messages: [overflowAssistant],
          // Pi marks this false because compaction, not auto-retry, decides
          // whether the overflow turn will continue.
          willRetry: false,
        });
        emit({ type: "compaction_start", reason: "overflow" });
        emit({
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: false,
          willRetry: true,
        });
        emit({ type: "message_end", message: finalAssistant });
        emit({
          type: "agent_end",
          messages: [finalAssistant],
          willRetry: false,
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("successful answer after compaction");
    expect(result.output).not.toContain("context overflow error");
  });

  test("overflow retry removes only the failed final turn", async () => {
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "successful earlier turn" }],
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
    };
    const overflowAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "overflowing final turn" }],
      stopReason: "error",
    };
    const finalAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        emit({ type: "message_end", message: firstAssistant });
        emit({ type: "message_end", message: toolResult });
        emit({ type: "message_end", message: overflowAssistant });
        emit({
          type: "agent_end",
          messages: [firstAssistant, toolResult, overflowAssistant],
          willRetry: false,
        });
        emit({ type: "compaction_start", reason: "overflow" });
        emit({
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: false,
          willRetry: true,
        });
        emit({ type: "message_end", message: finalAssistant });
        emit({
          type: "agent_end",
          messages: [finalAssistant],
          willRetry: false,
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toContain("successful earlier turn");
    expect(result.output).toContain("final answer");
    expect(result.output).not.toContain("overflowing final turn");
  });

  test("retains overflow evidence when compaction does not retry", async () => {
    const overflowAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "overflow could not be recovered" }],
      stopReason: "error",
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        emit({ type: "message_end", message: overflowAssistant });
        emit({
          type: "agent_end",
          messages: [overflowAssistant],
          willRetry: false,
        });
        emit({ type: "compaction_start", reason: "overflow" });
        emit({
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage: "Context overflow recovery failed",
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("overflow could not be recovered");
  });

  test("threshold compaction does not discard a successful answer", async () => {
    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "answer before threshold compaction" }],
      stopReason: "stop",
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        emit({ type: "message_end", message: answer });
        emit({ type: "agent_end", messages: [answer], willRetry: false });
        emit({ type: "compaction_start", reason: "threshold" });
        emit({
          type: "compaction_end",
          reason: "threshold",
          result: undefined,
          aborted: false,
          willRetry: false,
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("answer before threshold compaction");
  });

  test("keeps partial output after an earlier successful turn", async () => {
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "completed earlier turn" }],
    };
    const partialAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "newer partial response" }],
    };
    const syntheticFailure = {
      role: "assistant",
      content: [],
      stopReason: "error",
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        emit({ type: "message_end", message: firstAssistant });
        emit({
          type: "message_start",
          message: { role: "assistant", content: [] },
        });
        emit({ type: "message_update", message: partialAssistant });
        // Pi can append an empty synthetic failure message after a provider
        // throws, leaving the useful stream text without message_end.
        emit({ type: "message_end", message: syntheticFailure });
        emit({
          type: "agent_end",
          messages: [firstAssistant, syntheticFailure],
          willRetry: false,
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toContain("completed earlier turn");
    expect(result.output).toContain("newer partial response");
  });

  test("does not duplicate partial text already present in agent_end", async () => {
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "first response" }],
    };
    const partialAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial response" }],
    };
    const laterAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "later response" }],
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        emit({ type: "message_end", message: firstAssistant });
        emit({ type: "message_update", message: partialAssistant });
        // A host may copy the in-progress message into agent_end before the
        // stream settles. It is already represented in eventText here.
        emit({
          type: "agent_end",
          messages: [firstAssistant, partialAssistant, laterAssistant],
          willRetry: false,
        });
        emit({ type: "agent_settled" });
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output.match(/partial response/g)).toHaveLength(1);
    expect(result.output).toContain("later response");
  });

  test("keeps newly appended fallback output before message_end", async () => {
    const historical = {
      role: "assistant",
      content: [{ type: "text", text: "historical answer" }],
    };
    const messages: unknown[] = [historical];
    const { session } = fakeSession({
      messages,
      prompt: async () => {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "partial appended output" }],
        });
        throw new Error("provider failed before message_end");
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("partial appended output");
    expect(result.output).not.toContain("historical answer");
  });

  test("does not fall back to historical output after transcript replacement", async () => {
    const historical = {
      role: "assistant",
      content: [{ type: "text", text: "historical answer" }],
    };
    let messages: unknown[] = [historical];
    const { session } = fakeSession({
      getMessages: () => messages,
      prompt: async (emit) => {
        emit({ type: "compaction_start", reason: "threshold" });
        // Compaction reconstructs historical messages as new objects and then
        // the provider fails before a new message_end is available.
        messages = [
          {
            role: "assistant",
            content: [{ type: "text", text: "historical answer" }],
          },
        ];
        emit({
          type: "compaction_end",
          reason: "threshold",
          aborted: false,
          willRetry: false,
        });
        throw new Error("provider failed before message_end");
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("(no output)");
    expect(result.output).not.toContain("historical answer");
  });

  test("preserves useful output from a failed stream before message_end", async () => {
    const partialAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial before provider failure" }],
    };
    const { session } = fakeSession({
      messages: [],
      prompt: async (emit) => {
        emit({
          type: "message_start",
          message: { role: "assistant", content: [] },
        });
        emit({ type: "message_update", message: partialAssistant });
        throw new Error("provider failed mid-stream");
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toBe("partial before provider failure");
  });

  test("aborts a silent prompt and reports a structured stalled failure", async () => {
    _setStallTimeoutForTesting(15);
    let resolvePrompt!: () => void;
    let emitDuringAbort!: (event: unknown) => void;
    let aborts = 0;
    const progress: Array<{ failureKind?: string }> = [];
    const { session } = fakeSession({
      prompt: (emit) => {
        emitDuringAbort = emit;
        return new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      },
      abort: () => {
        aborts++;
        // Upstream may emit a final event while cooperative cancellation
        // unwinds. The error should still name the phase that stalled.
        emitDuringAbort({ type: "message_update" });
        resolvePrompt();
      },
    });

    try {
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        (update) => progress.push(update),
        new Set<string>(),
        Date.now(),
      );

      expect(aborts).toBe(1);
      expect(progress.some((update) => update.failureKind === "stalled")).toBe(
        true,
      );
      expect(result.failureKind).toBe("stalled");
      expect(result.error).toContain("Stalled: no AgentSession activity");
      expect(result.error).toContain("starting agent");
      expect(result.error).not.toContain("streaming model output");
    } finally {
      _setStallTimeoutForTesting(undefined);
    }
  });

  test("Pi 0.83 summarization retry delay extends the inactivity window", async () => {
    _setStallTimeoutForTesting(15);
    let aborts = 0;
    const { session } = fakeSession({
      prompt: async (emit) => {
        emit({ type: "summarization_retry_scheduled", delayMs: 30 });
        await new Promise((resolve) => setTimeout(resolve, 25));
        emit({
          type: "summarization_retry_attempt_start",
          source: "compaction",
        });
      },
      abort: () => {
        aborts++;
      },
    });

    try {
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        undefined,
        new Set<string>(),
        Date.now(),
      );

      expect(aborts).toBe(0);
      expect(result.failureKind).toBeUndefined();
      expect(result.error).toBeUndefined();
    } finally {
      _setStallTimeoutForTesting(undefined);
    }
  });

  test("streaming model updates reset the inactivity watchdog", async () => {
    _setStallTimeoutForTesting(20);
    let aborts = 0;
    const { session } = fakeSession({
      prompt: async (emit) => {
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          emit({ type: "message_update" });
        }
      },
      abort: () => {
        aborts++;
      },
    });

    try {
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        undefined,
        new Set<string>(),
        Date.now(),
      );

      expect(aborts).toBe(0);
      expect(result.failureKind).toBeUndefined();
      expect(result.error).toBeUndefined();
    } finally {
      _setStallTimeoutForTesting(undefined);
    }
  });

  test("prompt failure preserves partial output, usage, and touched files", async () => {
    const tmpDir = `/tmp/delegate-runner-partial-${Date.now()}`;
    const messages: {
      role: string;
      content: { type: string; text?: string }[];
      usage?: { totalTokens: number };
    }[] = [];
    let statsCall = 0;
    const { session } = fakeSession({
      messages,
      getStats: () => {
        statsCall++;
        return {
          tokens: {
            input: statsCall === 1 ? 0 : 10,
            output: statsCall === 1 ? 0 : 32,
            cacheRead: 0,
            cacheWrite: 0,
            total: statsCall === 1 ? 0 : 42,
          },
          cost: statsCall === 1 ? 0 : 0.001,
        } as never;
      },
      prompt: async (emit) => {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "partial output before abort" }],
          usage: { totalTokens: 42 },
        });
        emit({
          type: "tool_execution_start",
          toolCallId: "tc1",
          toolName: "write",
          args: { path: "file.txt", content: "hello" },
        });
        emit({
          type: "tool_execution_end",
          toolCallId: "tc1",
          toolName: "write",
          result: { content: [] },
          isError: false,
        });
        throw new Error("Aborted");
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: tmpDir },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    expect(result.error).toBe("Aborted");
    expect(result.output).toContain("partial output before abort");
    expect(result.tokens).toBe(42);
    expect(result.usage.totalTokens).toBe(42);
    expect(result.touchedFiles.length).toBeGreaterThan(0);
    expect(result.touchedFiles[0]).toContain("file.txt");
  });
});

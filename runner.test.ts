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
import { describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGitChangedFiles } from "./file-tracking.ts";
import * as fileTracking from "./file-tracking.ts";
import * as timer from "./timer.ts";
import {
  _setRunnerQuiescenceTimingsForTesting,
  runAgentSession,
} from "./runner.ts";
import { _setStallTimeoutForTesting } from "./config.ts";
import { sessionQuarantineOf } from "./session-quarantine.ts";

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

  test("freezes terminal progress/output after abandonment and resolves safety only after recovery", async () => {
    let idle = false;
    let progressUpdates = 0;
    let resolvePrompt!: () => void;
    const promptDone = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    const { session, emit } = fakeSession({
      prompt: () => promptDone,
      isIdle: () => idle,
    });
    _setRunnerQuiescenceTimingsForTesting({
      cancelledUnwindBudgetMs: 15,
      cancelledGraceMs: 1,
      eventProbeMs: 1,
    });

    try {
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        () => {
          progressUpdates++;
        },
        new Set<string>(),
        Date.now(),
        Date.now() + 5,
      );
      const quarantine = sessionQuarantineOf(result);
      expect(quarantine).toBeDefined();
      expect(result.incomplete).toBe("quiescence_abandoned");
      const terminalProgressUpdates = progressUpdates;
      emit({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "late unsafe output" }],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(progressUpdates).toBe(terminalProgressUpdates);
      expect(result.output).not.toContain("late unsafe output");
      let safe = false;
      void quarantine!.safe.then(() => {
        safe = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(safe).toBe(false);

      idle = true;
      resolvePrompt();
      emit({ type: "agent_settled" });
      await quarantine!.safe;
      expect(safe).toBe(true);
    } finally {
      _setRunnerQuiescenceTimingsForTesting(undefined);
      idle = true;
      resolvePrompt();
    }
  });

  test("cancellation queued before prompt start never invokes prompt", async () => {
    const controller = new AbortController();
    const { session, prompted } = fakeSession({ messages: [] });

    const running = runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      controller.signal,
      undefined,
      new Set<string>(),
      Date.now(),
    );
    // runAgentSession has queued its prompt callback but has not entered it yet.
    controller.abort();
    const result = await running;

    expect(result.error).toBe("Aborted");
    expect(result.prompted).toBe(false);
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

  test("restores a failed retrying attempt when auto-retry is cancelled", async () => {
    const cancelledRetryAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "transient failure should be restored" }],
      stopReason: "error",
    };
    let statsCall = 0;
    const { session } = fakeSession({
      messages: [],
      getStats: () => {
        const total = statsCall++ === 0 ? 0 : 6;
        return {
          tokens: {
            input: 0,
            output: total,
            cacheRead: 0,
            cacheWrite: 0,
            total,
          },
          cost: 0,
        } as never;
      },
      prompt: async (emit) => {
        emit({ type: "message_end", message: cancelledRetryAssistant });
        emit({
          type: "agent_end",
          messages: [cancelledRetryAssistant],
          willRetry: true,
        });
        emit({ type: "auto_retry_end", success: false });
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

    expect(result.output).toBe("transient failure should be restored");
    expect(result.output).not.toContain("(no output)");
    expect(result.tokens).toBe(6);
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

  test("allows fallback after aborted compaction when transcript remains append-only", async () => {
    const historical = {
      role: "assistant",
      content: [{ type: "text", text: "historical answer" }],
    };
    const messages: unknown[] = [historical];
    const { session } = fakeSession({
      messages,
      getMessages: () => messages,
      prompt: async (emit) => {
        emit({ type: "compaction_start", reason: "manual" });
        // Host appends a new assistant message after a failed compaction attempt
        // and keeps the existing array/preceding object identities.
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "compaction fallback output" }],
        });
        emit({
          type: "compaction_end",
          reason: "manual",
          aborted: true,
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

    expect(result.output).toBe("compaction fallback output");
    expect(result.output).not.toContain("(no output)");
    expect(result.output).not.toContain("historical answer");
  });

  test("keeps fallback disabled after a completed compaction", async () => {
    const historical = {
      role: "assistant",
      content: [{ type: "text", text: "historical answer" }],
    };
    const messages: unknown[] = [historical];
    const { session } = fakeSession({
      messages,
      getMessages: () => messages,
      prompt: async (emit) => {
        emit({ type: "compaction_start", reason: "manual" });
        emit({
          type: "compaction_end",
          reason: "manual",
          aborted: false,
          willRetry: false,
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "unsafe post-compaction fallback" }],
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

    expect(result.output).not.toContain("unsafe post-compaction fallback");
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

  test("stall cancellation does not await a prompt promise that never settles", async () => {
    _setStallTimeoutForTesting(15);
    let idle = false;
    let aborts = 0;
    const { session } = fakeSession({
      prompt: (emit) => {
        emit({
          type: "tool_execution_start",
          toolCallId: "interrupted-write",
          toolName: "write",
          args: { path: "possibly-written.txt", content: "data" },
        });
        return new Promise<void>(() => {});
      },
      isIdle: () => idle,
      abort: () => {
        aborts++;
        idle = true;
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

      expect(aborts).toBe(1);
      expect(result.failureKind).toBe("stalled");
      expect(result.error).toContain("Stalled:");
      expect(result.touchedFiles).toContain(
        path.join(process.cwd(), "possibly-written.txt"),
      );
      expect(result.attributedFiles).toContain(
        path.join(process.cwd(), "possibly-written.txt"),
      );
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

  // ── Already-aborted cleanup (item 1) ──────────────────────────────────────

  test("already-aborted signal cleans up subscription and abort listener", async () => {
    const controller = new AbortController();
    controller.abort();

    let unsubscribed = false;
    const { session } = fakeSession({ messages: [] });
    // Wrap subscribe to detect whether the runner unsubscribes.
    const origSubscribe = session.subscribe.bind(session);
    (session as unknown as { subscribe: unknown }).subscribe = (
      fn: (e: unknown) => void,
    ) => {
      const unsub = origSubscribe(fn);
      return () => {
        unsubscribed = true;
        unsub();
      };
    };

    // Track whether the abort listener is removed. addEventListener with
    // { once: true } auto-removes on fire, but for an already-aborted signal
    // the listener never fires — so removeEventListener must be called
    // explicitly.
    let listenerRemoved = false;
    const origAddEventListener = controller.signal.addEventListener.bind(
      controller.signal,
    );
    const origRemoveEventListener = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    (
      controller.signal as unknown as {
        addEventListener: unknown;
      }
    ).addEventListener = (
      type: string,
      listener: EventListener,
      opts?: unknown,
    ) => {
      if (type === "abort") {
        // Don't actually register — the signal is already aborted and we want
        // to track removal independently.
        (
          controller.signal as unknown as { _abortListener?: unknown }
        )._abortListener = listener;
        return;
      }
      origAddEventListener(type, listener, opts as never);
    };
    (
      controller.signal as unknown as {
        removeEventListener: unknown;
      }
    ).removeEventListener = (type: string, listener: EventListener) => {
      if (type === "abort") {
        const stored = (
          controller.signal as unknown as { _abortListener?: unknown }
        )._abortListener;
        if (stored === listener) {
          listenerRemoved = true;
          delete (controller.signal as unknown as { _abortListener?: unknown })
            ._abortListener;
        }
        return;
      }
      origRemoveEventListener(type, listener);
    };

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
    expect(unsubscribed).toBe(true);
    expect(listenerRemoved).toBe(true);
  });

  // ── Abort racing with a delayed continuation (item 2) ─────────────────────

  test("re-aborts a continuation that starts after cancellation", async () => {
    const controller = new AbortController();
    let compacting = false;
    let agentActive = false;
    let aborts = 0;
    let continuationStarted = false;
    let continuationAborted = false;
    let emitSessionEvent: ((event: unknown) => void) | undefined;

    const fake = fakeSession({
      messages: [],
      isIdle: () => !agentActive && !compacting,
      isCompacting: () => compacting,
      abortCompaction: () => {
        // Don't change state here — the async callback controls compaction.
      },
      abort: async () => {
        aborts++;
        if (agentActive) {
          // The continuation is active — abort it.
          continuationAborted = true;
          agentActive = false;
          emitSessionEvent?.({
            type: "agent_end",
            messages: [],
            willRetry: false,
          });
          emitSessionEvent?.({ type: "agent_settled" });
        }
      },
      prompt: async (emit) => {
        const answer = {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
        };
        emit({ type: "message_end", message: answer });
        emit({ type: "agent_end", messages: [answer], willRetry: false });
        emit({ type: "agent_settled" });

        // Start compaction (fire-and-forget, like pi-codex-compaction).
        compacting = true;
        emit({ type: "compaction_start", reason: "manual" });
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          // compaction_end
          emit({
            type: "compaction_end",
            reason: "manual",
            result: {},
            aborted: false,
            willRetry: false,
          });
          compacting = false;

          // Parent aborts right after compaction_end.
          controller.abort();

          // onComplete starts a continuation AFTER the abort, delayed by
          // asynchronous authentication (the realistic gap that defeats the
          // "two stable event-loop turns" heuristic).
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          continuationStarted = true;
          agentActive = true;
          emit({ type: "agent_start" });

          // Safety: if not aborted within 200ms, finish anyway so the test
          // doesn't hang. The assertion below will catch the missing abort.
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          if (agentActive) {
            agentActive = false;
            emit({
              type: "agent_end",
              messages: [],
              willRetry: false,
            });
            emit({ type: "agent_settled" });
          }
        })();
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
    expect(continuationStarted).toBe(true);
    expect(continuationAborted).toBe(true);
    // Initial abort (from abort handler) + re-abort (from quiescence barrier
    // detecting the continuation).
    expect(aborts).toBeGreaterThanOrEqual(2);
  });

  test("detects and extends quiescence for a fast continuation that completes between samples", async () => {
    // A continuation could emit agent_start, do work, and emit agent_settled
    // all within one microtask — between two quiescence loop samples. The
    // session is idle again by the time the loop checks, but the generation
    // changed. Re-abort must fire on the generation change alone, not only
    // when !idle.
    //
    // This test detects activity after it completed — it cannot prevent
    // mutations that already occurred. The second abort is a no-op because
    // the continuation is finished. The value is that the quiescence barrier
    // extends its wait (resets quiet turns) rather than returning immediately,
    // which gives the runner a chance to observe any further continuations.
    // Deterministic prevention of fast work still requires host-visible
    // pending extension work.
    const controller = new AbortController();
    let compacting = false;
    let agentActive = false;
    let aborts = 0;
    let continuationStarted = false;
    let emitSessionEvent: ((event: unknown) => void) | undefined;

    const fake = fakeSession({
      messages: [],
      isIdle: () => !agentActive && !compacting,
      isCompacting: () => compacting,
      prompt: async (emit) => {
        const answer = {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
        };
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
            result: {},
            aborted: false,
            willRetry: false,
          });
          compacting = false;

          // Parent aborts right after compaction_end.
          controller.abort();

          // onComplete starts a continuation that completes in ONE microtask —
          // faster than the quiescence loop can sample. By the time the loop
          // checks, agentActive is already false again, but the generation
          // has changed.
          await Promise.resolve();
          continuationStarted = true;
          agentActive = true;
          emit({ type: "agent_start" });
          emit({ type: "agent_end", messages: [], willRetry: false });
          emit({ type: "agent_settled" });
          agentActive = false;
        })();
      },
    });
    emitSessionEvent = fake.emit;

    // Override abort to count calls (no-op since the continuation is already
    // done by the time re-abort fires).
    const origAbort = fake.session.abort.bind(fake.session);
    (fake.session as unknown as { abort: unknown }).abort = async () => {
      aborts++;
      await origAbort();
    };

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
    expect(continuationStarted).toBe(true);
    // Re-abort must fire even though the continuation already completed —
    // the generation change alone is sufficient signal to extend quiescence.
    expect(aborts).toBeGreaterThanOrEqual(2);
  });

  test("stall cancellation re-aborts a continuation that starts afterward", async () => {
    // The re-abort logic must cover stall cancellation, not just parent abort.
    // A continuation starting after a stall-triggered cancellation should also
    // be re-aborted.
    _setStallTimeoutForTesting(15);
    let compacting = false;
    let agentActive = false;
    let aborts = 0;
    let continuationStarted = false;
    let continuationAborted = false;
    let emitSessionEvent: ((event: unknown) => void) | undefined;

    const fake = fakeSession({
      messages: [],
      isIdle: () => !agentActive && !compacting,
      isCompacting: () => compacting,
      abortCompaction: () => {
        if (compacting) {
          compacting = false;
          emitSessionEvent?.({
            type: "compaction_end",
            reason: "manual",
            result: undefined,
            aborted: true,
            willRetry: false,
          });
        }
      },
      abort: async () => {
        aborts++;
        if (agentActive) {
          continuationAborted = true;
          agentActive = false;
          emitSessionEvent?.({
            type: "agent_end",
            messages: [],
            willRetry: false,
          });
          emitSessionEvent?.({ type: "agent_settled" });
        }
      },
      prompt: async (emit) => {
        const answer = {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
        };
        emit({ type: "message_end", message: answer });
        emit({ type: "agent_end", messages: [answer], willRetry: false });
        emit({ type: "agent_settled" });

        // Start a compaction that lasts beyond the stall timeout (15ms).
        compacting = true;
        emit({ type: "compaction_start", reason: "manual" });
        void (async () => {
          // Wait for the stall watchdog to fire and abort compaction.
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          // After compaction is aborted, a continuation starts — simulating
          // an onComplete callback that runs despite the stall cancellation.
          await Promise.resolve();
          continuationStarted = true;
          agentActive = true;
          emit({ type: "agent_start" });

          // Safety: if not aborted within 200ms, finish anyway so the test
          // doesn't hang. The assertion below will catch the missing abort.
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          if (agentActive) {
            agentActive = false;
            emit({ type: "agent_end", messages: [], willRetry: false });
            emit({ type: "agent_settled" });
          }
        })();
      },
    });
    emitSessionEvent = fake.emit;

    try {
      const result = await runAgentSession(
        fake.session as never,
        "do work",
        { cwd: process.cwd() },
        undefined, // No parent abort signal — stall is the cancellation source.
        undefined,
        new Set<string>(),
        Date.now(),
      );

      expect(result.failureKind).toBe("stalled");
      expect(continuationStarted).toBe(true);
      expect(continuationAborted).toBe(true);
      // Initial stall abort + re-abort from the quiescence barrier.
      expect(aborts).toBeGreaterThanOrEqual(2);
    } finally {
      _setStallTimeoutForTesting(undefined);
    }
  });

  test("async abort-caused settlement events converge without an abort loop", async () => {
    // session.abort() may emit settlement events asynchronously after returning
    // — e.g. a delayed agent_end/agent_settled as the stream unwinds. Recording
    // abortRequestedGeneration after calling abort() only accounts for
    // synchronous events; later abort-caused events increment the generation
    // and can trigger another re-abort. This test verifies that the loop
    // converges: each re-abort resets the tracker, the async events settle,
    // and the abort count stays bounded rather than looping forever.
    //
    // Real abort() is idempotent — it only produces settlement events on the
    // first call. Subsequent calls are no-ops. The test models this: the first
    // abort schedules async agent_end/agent_settled, later calls do nothing.
    const controller = new AbortController();
    let compacting = false;
    let agentActive = false;
    let aborts = 0;
    let firstAbort = true;
    let emitSessionEvent: ((event: unknown) => void) | undefined;

    const fake = fakeSession({
      messages: [],
      isIdle: () => !agentActive && !compacting,
      isCompacting: () => compacting,
      prompt: async (emit) => {
        const answer = {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
        };
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
            result: {},
            aborted: false,
            willRetry: false,
          });
          compacting = false;
          // Parent aborts right after compaction_end.
          controller.abort();
        })();
      },
    });
    emitSessionEvent = fake.emit;

    // abort() emits settlement events asynchronously, but only on the first
    // call — subsequent calls are no-ops (matching real AgentSession behavior).
    (fake.session as unknown as { abort: unknown }).abort = async () => {
      aborts++;
      if (!firstAbort) return;
      firstAbort = false;
      agentActive = true;
      // Asynchronous settlement: the events fire after abort() returns,
      // so abortRequestedGeneration (set after the call) won't include them.
      void (async () => {
        await Promise.resolve();
        emitSessionEvent?.({
          type: "agent_end",
          messages: [],
          willRetry: false,
        });
        emitSessionEvent?.({ type: "agent_settled" });
        agentActive = false;
      })();
    };

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
    // The loop must converge — initial abort + at most one re-abort from the
    // async settlement events. A loop bug would hang the test or produce an
    // unbounded count.
    expect(aborts).toBeLessThanOrEqual(3);
    expect(aborts).toBeGreaterThanOrEqual(1);
  });

  // ── Longer quiescence sequences (item 4) ──────────────────────────────────

  test("handles compaction → continuation → second compaction → second continuation", async () => {
    let compacting = false;
    let agentActive = false;
    let callbackFinished = false;
    const firstAnswer = {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
    };
    const secondAnswer = {
      role: "assistant",
      content: [
        { type: "text", text: "second answer after second compaction" },
      ],
    };

    const { session } = fakeSession({
      messages: [],
      isIdle: () => !agentActive && !compacting,
      isCompacting: () => compacting,
      prompt: async (emit) => {
        emit({ type: "message_end", message: firstAnswer });
        emit({ type: "agent_end", messages: [firstAnswer], willRetry: false });
        emit({ type: "agent_settled" });

        // First compaction → first continuation (which triggers a second
        // compaction → second continuation).
        compacting = true;
        emit({ type: "compaction_start", reason: "manual" });
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          emit({
            type: "compaction_end",
            reason: "manual",
            result: {},
            aborted: false,
            willRetry: false,
          });
          compacting = false;

          // First continuation starts.
          await Promise.resolve();
          agentActive = true;
          emit({ type: "agent_start" });
          const continuedAnswer = {
            role: "assistant",
            content: [{ type: "text", text: "continuation answer" }],
          };
          emit({ type: "message_end", message: continuedAnswer });
          emit({
            type: "agent_end",
            messages: [continuedAnswer],
            willRetry: false,
          });
          agentActive = false;
          emit({ type: "agent_settled" });

          // Second compaction → second continuation.
          compacting = true;
          emit({ type: "compaction_start", reason: "manual" });
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          emit({
            type: "compaction_end",
            reason: "manual",
            result: {},
            aborted: false,
            willRetry: false,
          });
          compacting = false;

          await Promise.resolve();
          agentActive = true;
          emit({ type: "agent_start" });
          emit({ type: "message_end", message: secondAnswer });
          emit({
            type: "agent_end",
            messages: [secondAnswer],
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
    expect(result.output).toContain("first answer");
    expect(result.output).toContain("continuation answer");
    expect(result.output).toContain("second answer after second compaction");
  });

  test("captures usage, tool activity, and touched files from a continuation", async () => {
    let compacting = false;
    let agentActive = false;
    let statsCall = 0;
    const firstAnswer = {
      role: "assistant",
      content: [{ type: "text", text: "initial answer" }],
    };
    const continuedAnswer = {
      role: "assistant",
      content: [{ type: "text", text: "continuation wrote a file" }],
    };

    const progress: Array<{
      toolUses?: number;
      activities?: Array<{ name: string }>;
    }> = [];
    const tmpDir = `/tmp/delegate-runner-cont-${Date.now()}`;
    const { session } = fakeSession({
      messages: [],
      isIdle: () => !agentActive && !compacting,
      isCompacting: () => compacting,
      getStats: () => {
        // First snapshot (before prompt): 0. Subsequent calls reflect
        // cumulative tokens including the continuation.
        const total = statsCall++ === 0 ? 0 : 100;
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
        emit({ type: "message_end", message: firstAnswer });
        emit({ type: "agent_end", messages: [firstAnswer], willRetry: false });
        emit({ type: "agent_settled" });

        compacting = true;
        emit({ type: "compaction_start", reason: "manual" });
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          emit({
            type: "compaction_end",
            reason: "manual",
            result: {},
            aborted: false,
            willRetry: false,
          });
          compacting = false;

          await Promise.resolve();
          agentActive = true;
          emit({ type: "agent_start" });

          // The continuation uses the write tool.
          emit({
            type: "tool_execution_start",
            toolCallId: "cont-write",
            toolName: "write",
            args: { path: "continuation-file.txt", content: "data" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "cont-write",
            toolName: "write",
            result: { content: [] },
            isError: false,
          });

          emit({ type: "message_end", message: continuedAnswer });
          emit({
            type: "agent_end",
            messages: [continuedAnswer],
            willRetry: false,
          });
          agentActive = false;
          emit({ type: "agent_settled" });
        })();
      },
    });

    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: tmpDir },
      undefined,
      (update) => progress.push(update),
      new Set<string>(),
      Date.now(),
    );

    expect(result.output).toContain("initial answer");
    expect(result.output).toContain("continuation wrote a file");
    expect(result.tokens).toBe(100);
    expect(result.usage.totalTokens).toBe(100);
    expect(result.touchedFiles.length).toBeGreaterThan(0);
    expect(result.touchedFiles[0]).toContain("continuation-file.txt");
    // The continuation's tool call must be reflected in progress updates.
    expect(progress.some((p) => p.toolUses === 1)).toBe(true);
    expect(
      progress.some(
        (p) => p.activities?.some((a) => a.name === "write") === true,
      ),
    ).toBe(true);
  });

  test("stall watchdog fires during post-prompt compaction", async () => {
    _setStallTimeoutForTesting(15);
    let compacting = false;
    let aborts = 0;
    let compactionAborts = 0;
    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "answer before stalled compaction" }],
    };
    const { session } = fakeSession({
      messages: [],
      isIdle: () => !compacting,
      isCompacting: () => compacting,
      abortCompaction: () => {
        compactionAborts++;
        compacting = false;
      },
      abort: () => {
        aborts++;
      },
      prompt: async (emit) => {
        emit({ type: "message_end", message: answer });
        emit({ type: "agent_end", messages: [answer], willRetry: false });
        emit({ type: "agent_settled" });

        // Start a compaction that never ends on its own — the stall watchdog
        // must fire and cancel it.
        compacting = true;
        emit({ type: "compaction_start", reason: "manual" });
        // Don't emit compaction_end; let the stall watchdog handle it.
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

      expect(result.failureKind).toBe("stalled");
      expect(result.error).toContain("Stalled");
      expect(compactionAborts).toBeGreaterThanOrEqual(1);
      expect(aborts).toBeGreaterThanOrEqual(1);
      expect(compacting).toBe(false);
    } finally {
      _setStallTimeoutForTesting(undefined);
    }
  });

  test("250ms compatibility probe handles isCompacting clearing without an event", async () => {
    let compacting = true;
    let probeFired = false;
    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "answer before silent compaction" }],
    };
    const { session } = fakeSession({
      messages: [],
      isIdle: () => !compacting,
      isCompacting: () => compacting,
      prompt: async (emit) => {
        emit({ type: "message_end", message: answer });
        emit({ type: "agent_end", messages: [answer], willRetry: false });
        emit({ type: "agent_settled" });

        // Start compaction but never emit compaction_end. Instead, silently
        // clear isCompacting after a short delay — simulating a host version
        // that clears an internal busy flag without a corresponding event.
        emit({ type: "compaction_start", reason: "manual" });
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          compacting = false;
          probeFired = true;
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

    // The probe must have detected the silent state change.
    expect(probeFired).toBe(true);
    expect(result.output).toBe("answer before silent compaction");
    expect(result.error).toBeUndefined();
  });

  // ── Runner-contract: quiescence barrier prevents post-return callback crash ─
  //
  // The original crash: prompt() returns → an async compaction callback
  // (started by an extension's agent_settled handler via ctx.compact) fires
  // after lifecycle has already disposed the session → the callback accesses
  // ctx.hasUI on a disposed session → crash.
  //
  // This is a runner-contract test, NOT a lifecycle integration test. It
  // verifies that runAgentSession does not return until the async compaction
  // callback has finished — the precondition lifecycle relies on. It does not
  // call session.dispose() or execute lifecycle.ts. A full cross-module
  // integration test would need the test harness with a real
  // compaction-triggering extension; the runner contract above is the seam
  // that prevents the crash.

  test("runner contract: quiescence barrier outlasts async compaction callback (ctx.hasUI access)", async () => {
    let disposed = false;
    let callbackFinished = false;
    let callbackCrashed = false;
    let compacting = false;

    // Simulate ctx.hasUI: after dispose, accessing it throws (matching the
    // real extension crash when the session's extension runtime is torn down).
    const fakeCtx = {
      get hasUI(): boolean {
        if (disposed) {
          callbackCrashed = true;
          throw new Error(
            "Cannot read properties of undefined (reading 'hasUI')",
          );
        }
        return false;
      },
    };

    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "answer before async compaction" }],
    };

    const { session } = fakeSession({
      messages: [],
      isIdle: () => !compacting,
      isCompacting: () => compacting,
      prompt: async (emit) => {
        emit({ type: "message_end", message: answer });
        emit({ type: "agent_end", messages: [answer], willRetry: false });
        emit({ type: "agent_settled" });

        // An extension's agent_settled handler starts ctx.compact() — fire
        // and forget, just like pi-codex-compaction does.
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

          // ctx.compact's onComplete callback runs after compaction_end.
          // It accesses ctx.hasUI — the exact access that crashed when
          // disposal raced ahead of the callback.
          await Promise.resolve();
          // This is the critical access. If the runner returned before this
          // line and lifecycle disposed the session, this would throw.
          void fakeCtx.hasUI;
          callbackFinished = true;
        })();
      },
    });

    // Simulate lifecycle's pattern: run the runner, then dispose.
    // The runner must not return until the callback is complete.
    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      Date.now(),
    );

    // Simulate disposal immediately after the runner returns — exactly what
    // lifecycle does in disposeOwnedSession().
    disposed = true;

    expect(callbackFinished).toBe(true);
    expect(callbackCrashed).toBe(false);
    expect(result.output).toBe("answer before async compaction");
    expect(result.error).toBeUndefined();
  });

  // ── Progress-callback exceptions must not leak watchdogs or subscriptions ──
  //
  // fireProgress() is now guarded by a try/catch around the user callback, and
  // the arming/fireProgress calls live inside the main try/finally so any
  // unexpected throw still triggers cleanup.

  test("progress callback exceptions are caught and do not leak subscription or listener", async () => {
    const controller = new AbortController();
    let unsubscribed = false;
    const { session, prompted } = fakeSession({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { totalTokens: 5 },
        },
      ],
      prompt: () => {},
    });

    const origSubscribe = session.subscribe.bind(session);
    (session as unknown as { subscribe: unknown }).subscribe = (
      fn: (e: unknown) => void,
    ) => {
      const unsub = origSubscribe(fn);
      return () => {
        unsubscribed = true;
        unsub();
      };
    };

    let listenerRemoved = false;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    (
      controller.signal as unknown as {
        addEventListener: unknown;
      }
    ).addEventListener = (
      type: string,
      listener: EventListener,
      opts?: unknown,
    ) => {
      if (type === "abort") {
        (
          controller.signal as unknown as { _abortListener?: unknown }
        )._abortListener = listener;
      }
      origAdd(type, listener, opts as never);
    };
    (
      controller.signal as unknown as {
        removeEventListener: unknown;
      }
    ).removeEventListener = (type: string, listener: EventListener) => {
      if (type === "abort") {
        const stored = (
          controller.signal as unknown as { _abortListener?: unknown }
        )._abortListener;
        if (stored === listener) {
          listenerRemoved = true;
          delete (controller.signal as unknown as { _abortListener?: unknown })
            ._abortListener;
        }
      }
      origRemove(type, listener);
    };

    let progressCalls = 0;
    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      controller.signal,
      () => {
        progressCalls++;
        throw new Error("progress exploded");
      },
      new Set<string>(),
      Date.now(),
    );

    expect(prompted()).toBe(true);
    expect(progressCalls).toBeGreaterThanOrEqual(1);
    expect(result.error).toBeUndefined();
    expect(unsubscribed).toBe(true);
    expect(listenerRemoved).toBe(true);
  });

  test("prompt rejection awaits session quiescence before returning", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-reject-quiesce-"),
    );
    let compacting = false;
    let compactionDone = false;
    const { session, emit } = fakeSession({
      prompt: async () => {
        compacting = true;
        emit({
          type: "compaction_start",
          reason: "manual",
        });
        setTimeout(() => {
          compacting = false;
          compactionDone = true;
          emit({
            type: "compaction_end",
            reason: "manual",
            result: {},
            aborted: false,
            willRetry: false,
          });
        }, 20);
        throw new Error("simulated prompt failure");
      },
      isIdle: () => !compacting,
      isCompacting: () => compacting,
    });

    try {
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: tmpDir },
        undefined,
        undefined,
        new Set<string>(),
        Date.now(),
      );

      expect(compactionDone).toBe(true);
      expect(result.error).toBe("simulated prompt failure");
      expect(result.prompted).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── touched-file tracking (issue #33) ─────────────────────────────────────

describe("touched-file tracking", () => {
  test("write and edit activity is captured in a non-git directory", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-touched-non-git-"),
    );
    try {
      const { session } = fakeSession({
        messages: [],
        prompt: async (emit) => {
          const answer = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          };
          emit({
            type: "tool_execution_start",
            toolCallId: "tc-write",
            toolName: "write",
            args: { path: "written.txt", content: "hello" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "tc-write",
            toolName: "write",
            result: { content: [] },
            isError: false,
          });
          emit({
            type: "tool_execution_start",
            toolCallId: "tc-edit",
            toolName: "edit",
            args: { path: "edit.txt", old: "x", new: "y" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "tc-edit",
            toolName: "edit",
            result: { content: [] },
            isError: false,
          });
          emit({ type: "message_end", message: answer });
          emit({ type: "agent_end", messages: [answer], willRetry: false });
          emit({ type: "agent_settled" });
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

      expect(result.error).toBeUndefined();
      expect(result.touchedFiles).toContain(path.join(tmpDir, "written.txt"));
      expect(result.touchedFiles).toContain(path.join(tmpDir, "edit.txt"));
      expect(result.attributedFiles).toEqual(
        expect.arrayContaining([
          path.join(tmpDir, "written.txt"),
          path.join(tmpDir, "edit.txt"),
        ]),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("bash mutation in a git repo is captured via git diff", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-touched-git-"),
    );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
      const bashFile = path.join(tmpDir, "bash-created.txt");
      const { session } = fakeSession({
        messages: [],
        prompt: async (emit) => {
          execFileSync("bash", ["-c", "echo data > bash-created.txt"], {
            cwd: tmpDir,
          });
          const answer = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          };
          emit({
            type: "tool_execution_start",
            toolCallId: "tc-bash",
            toolName: "bash",
            args: { command: "echo data > bash-created.txt" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "tc-bash",
            toolName: "bash",
            result: { content: [] },
            isError: false,
          });
          emit({ type: "message_end", message: answer });
          emit({ type: "agent_end", messages: [answer], willRetry: false });
          emit({ type: "agent_settled" });
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

      expect(result.error).toBeUndefined();
      expect(result.touchedFiles).toContain(bashFile);
      expect(result.attributedFiles).not.toContain(bashFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("bash mutation in a non-git directory is not captured", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-touched-no-git-"),
    );
    try {
      const bashFile = path.join(tmpDir, "bash-created.txt");
      const { session } = fakeSession({
        messages: [],
        prompt: async () => {
          execFileSync("bash", ["-c", "echo data > bash-created.txt"], {
            cwd: tmpDir,
          });
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

      expect(result.touchedFiles).not.toContain(bashFile);
      expect(result.attributedFiles).not.toContain(bashFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("failure path preserves touched files observed before the throw", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-touched-fail-"),
    );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
      const bashFile = path.join(tmpDir, "bash-created.txt");
      const { session } = fakeSession({
        messages: [],
        prompt: async (emit) => {
          execFileSync("bash", ["-c", "echo data > bash-created.txt"], {
            cwd: tmpDir,
          });
          emit({
            type: "tool_execution_start",
            toolCallId: "tc-write",
            toolName: "write",
            args: { path: "written.txt", content: "hello" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "tc-write",
            toolName: "write",
            result: { content: [] },
            isError: false,
          });
          throw new Error("boom");
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

      expect(result.error).toBe("boom");
      expect(result.touchedFiles).toContain(path.join(tmpDir, "written.txt"));
      expect(result.touchedFiles).toContain(bashFile);
      expect(result.attributedFiles).toContain(
        path.join(tmpDir, "written.txt"),
      );
      expect(result.attributedFiles).not.toContain(bashFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("attributedFiles only includes this run's edit/write activity, not other concurrent git changes", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-attributed-concurrent-"),
    );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
      const otherFile = path.join(tmpDir, "other.txt");
      const writtenFile = path.join(tmpDir, "written.txt");
      const { session } = fakeSession({
        messages: [],
        prompt: async (emit) => {
          // Simulate another concurrent task writing a file after this task's
          // git baseline was taken (so the baseline does not include it) but
          // before this task's post-run git snapshot.
          writeFileSync(otherFile, "concurrent");
          const answer = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          };
          emit({
            type: "tool_execution_start",
            toolCallId: "tc-write",
            toolName: "write",
            args: { path: "written.txt", content: "hello" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "tc-write",
            toolName: "write",
            result: { content: [] },
            isError: false,
          });
          emit({ type: "message_end", message: answer });
          emit({ type: "agent_end", messages: [answer], willRetry: false });
          emit({ type: "agent_settled" });
        },
      });

      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: tmpDir },
        undefined,
        undefined,
        new Set<string>(), // empty baseline, as in a concurrent start
        Date.now(),
      );

      expect(result.error).toBeUndefined();
      // touchedFiles is the best-effort union (for display), so it sees both.
      expect(result.touchedFiles).toContain(writtenFile);
      expect(result.touchedFiles).toContain(otherFile);
      // attributedFiles is only what this run's own activity wrote.
      expect(result.attributedFiles).toContain(writtenFile);
      expect(result.attributedFiles).not.toContain(otherFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("baseline success + post-run success diffs only new git changes", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-baseline-success-"),
    );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
      const preexistingFile = path.join(tmpDir, "preexisting.txt");
      const newFile = path.join(tmpDir, "new.txt");
      writeFileSync(preexistingFile, "preexisting");
      const gitBaseline = await getGitChangedFiles(tmpDir);

      const { session } = fakeSession({
        messages: [],
        prompt: async (emit) => {
          execFileSync("bash", ["-c", "echo new > new.txt"], { cwd: tmpDir });
          const answer = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          };
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [answer],
            willRetry: false,
          });
          emit({ type: "agent_settled" });
        },
      });

      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: tmpDir },
        undefined,
        undefined,
        gitBaseline,
        Date.now(),
      );

      expect(result.error).toBeUndefined();
      expect(result.touchedFiles).toContain(newFile);
      expect(result.touchedFiles).not.toContain(preexistingFile);
      expect(result.attributedFiles).not.toContain(newFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("baseline failure + post-run success does not attribute git-based files", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-baseline-failed-"),
    );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
      const preexistingFile = path.join(tmpDir, "preexisting.txt");
      const bashFile = path.join(tmpDir, "bash-created.txt");
      const writtenFile = path.join(tmpDir, "written.txt");
      writeFileSync(preexistingFile, "preexisting");

      const { session } = fakeSession({
        messages: [],
        prompt: async (emit) => {
          execFileSync("bash", ["-c", "echo data > bash-created.txt"], {
            cwd: tmpDir,
          });
          emit({
            type: "tool_execution_start",
            toolCallId: "tc-write",
            toolName: "write",
            args: { path: "written.txt", content: "hello" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "tc-write",
            toolName: "write",
            result: { content: [] },
            isError: false,
          });
          const answer = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          };
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [answer],
            willRetry: false,
          });
          emit({ type: "agent_settled" });
        },
      });

      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: tmpDir },
        undefined,
        undefined,
        undefined, // baseline failed
        Date.now(),
      );

      expect(result.error).toBeUndefined();
      // Activity-based file is still reported and attributed.
      expect(result.touchedFiles).toContain(writtenFile);
      expect(result.attributedFiles).toContain(writtenFile);
      // Git-based files (pre-existing and bash-created) must not be attributed.
      expect(result.touchedFiles).not.toContain(bashFile);
      expect(result.touchedFiles).not.toContain(preexistingFile);
      expect(result.attributedFiles).not.toContain(bashFile);
      expect(result.attributedFiles).not.toContain(preexistingFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("clean successful baseline attributes all post-run git changes", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "delegate-runner-baseline-clean-"),
    );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
      const bashFile = path.join(tmpDir, "bash-created.txt");

      const { session } = fakeSession({
        messages: [],
        prompt: async (emit) => {
          execFileSync("bash", ["-c", "echo data > bash-created.txt"], {
            cwd: tmpDir,
          });
          const answer = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          };
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [answer],
            willRetry: false,
          });
          emit({ type: "agent_settled" });
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

      expect(result.error).toBeUndefined();
      expect(result.touchedFiles).toContain(bashFile);
      expect(result.attributedFiles).not.toContain(bashFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runAgentSession deadline", () => {
  test("cooperatively aborts a prompt that exceeds its deadline and preserves partial output", async () => {
    let cancelled = false;
    const { session, emit } = fakeSession({
      prompt: async () => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial before deadline" }],
          },
        });
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (cancelled) {
              clearInterval(interval);
              resolve();
            }
          }, 5);
        });
      },
      abort: () => {
        cancelled = true;
      },
    });

    const start = Date.now();
    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      start,
      start + 15,
    );

    expect(cancelled).toBe(true);
    expect(result.failureKind).toBe("deadline_exceeded");
    expect(result.error).toContain("Deadline exceeded");
    expect(result.error).toContain("cooperatively aborted");
    expect(result.output).toBe("partial before deadline");
    expect(result.prompted).toBe(true);
  });

  test("deadline does not await a prompt promise that ignores abort", async () => {
    let idle = false;
    let aborts = 0;
    const { session } = fakeSession({
      prompt: () => new Promise<void>(() => {}),
      isIdle: () => idle,
      abort: () => {
        aborts++;
        idle = true;
      },
    });

    const start = Date.now();
    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      start,
      start + 15,
    );

    expect(aborts).toBe(1);
    expect(result.failureKind).toBe("deadline_exceeded");
    expect(result.error).toContain("Deadline exceeded");
  });

  test("parent abort wins when the signal fires after the deadline", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const { session, emit } = fakeSession({
      prompt: async () => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
          },
        });
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (cancelled) {
              clearInterval(interval);
              resolve();
            }
          }, 5);
        });
      },
      abort: () => {
        cancelled = true;
      },
    });

    const start = Date.now();
    const running = runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      controller.signal,
      undefined,
      new Set<string>(),
      start,
      start + 20,
    );

    setTimeout(() => controller.abort(), 40);
    const result = await running;

    expect(result.error).toBe("Aborted");
    expect(result.failureKind).toBeUndefined();
    expect(result.prompted).toBe(true);
  });

  test("omitting deadlineAt lets a prompt complete normally", async () => {
    const { session, emit } = fakeSession({
      prompt: async () => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "completed" }],
          },
        });
      },
    });

    const start = Date.now();
    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      start,
    );

    expect(result.error).toBeUndefined();
    expect(result.failureKind).toBeUndefined();
    expect(result.output).toBe("completed");
    expect(result.prompted).toBe(true);
  });

  test("pre-expired deadline returns deadline_exceeded without calling prompt", async () => {
    let promptCalls = 0;
    const { session } = fakeSession({
      prompt: async () => {
        promptCalls++;
      },
    });

    const start = Date.now();
    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      start,
      start - 1,
    );

    expect(promptCalls).toBe(0);
    expect(result.failureKind).toBe("deadline_exceeded");
    expect(result.error).toContain("Deadline exceeded");
    expect(result.output).toBe("(no output)");
    expect(result.prompted).toBe(false);
  });

  test("pre-expired deadline awaits session quiescence before returning", async () => {
    let promptCalls = 0;
    let compacting = true;
    let compactionDone = false;
    const { session, emit } = fakeSession({
      prompt: async () => {
        promptCalls++;
      },
      isIdle: () => true,
      isCompacting: () => compacting,
      abortCompaction: () => {
        if (!compacting || compactionDone) return;
        setTimeout(() => {
          compacting = false;
          compactionDone = true;
          emit({
            type: "compaction_end",
            reason: "manual",
            result: {},
            aborted: true,
            willRetry: false,
          });
        }, 10);
      },
    });

    const start = Date.now();
    const result = await runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      undefined,
      undefined,
      new Set<string>(),
      start,
      start - 1,
    );

    expect(promptCalls).toBe(0);
    expect(compactionDone).toBe(true);
    expect(result.failureKind).toBe("deadline_exceeded");
    expect(result.error).toContain("Deadline exceeded");
    expect(result.output).toBe("(no output)");
    expect(result.prompted).toBe(false);
  });

  test("pre-expired deadline parent abort during quiescence is reported as Aborted", async () => {
    const controller = new AbortController();
    let promptCalls = 0;
    let compacting = true;
    let compactionDone = false;
    const { session, emit } = fakeSession({
      prompt: async () => {
        promptCalls++;
      },
      isIdle: () => true,
      isCompacting: () => compacting,
      abortCompaction: () => {
        if (!compacting || compactionDone) return;
        setTimeout(() => {
          compacting = false;
          compactionDone = true;
          emit({
            type: "compaction_end",
            reason: "manual",
            result: {},
            aborted: true,
            willRetry: false,
          });
        }, 30);
      },
    });

    const start = Date.now();
    const running = runAgentSession(
      session as never,
      "do work",
      { cwd: process.cwd() },
      controller.signal,
      undefined,
      new Set<string>(),
      start,
      start - 1,
    );
    setTimeout(() => controller.abort(), 10);
    const result = await running;

    expect(promptCalls).toBe(0);
    expect(compactionDone).toBe(true);
    expect(result.error).toBe("Aborted");
    expect(result.failureKind).toBeUndefined();
    expect(result.output).toBe("");
    expect(result.prompted).toBe(false);
  });

  test("deadline watchdog stays armed during git evidence collection on success", async () => {
    let gitCalls = 0;
    const slowGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return new Set<string>();
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: slowGit,
    }));
    try {
      const answer = {
        role: "assistant",
        content: [{ type: "text", text: "done before git" }],
      };
      const { session } = fakeSession({
        prompt: async (emit) => {
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [answer],
            willRetry: false,
          });
          emit({ type: "agent_settled" });
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        undefined,
        new Set<string>(),
        start,
        start + 50,
      );

      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(result.output).toBe("done before git");
      expect(gitCalls).toBe(2);
      expect(result.prompted).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("deadline watchdog stays armed during git evidence collection on failure", async () => {
    let gitCalls = 0;
    const slowGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return new Set<string>();
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: slowGit,
    }));
    try {
      const { session } = fakeSession({
        prompt: async () => {
          throw new Error("simulated prompt failure");
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        undefined,
        new Set<string>(),
        start,
        start + 50,
      );

      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(gitCalls).toBe(2);
      expect(result.prompted).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("deadline during git evidence collection awaits a second quiescence", async () => {
    let gitCalls = 0;
    let gitDone = false;
    let idle = true;
    let postGitSettled = false;
    let abortCalled = false;
    const slowGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      await sleep(150);
      gitDone = true;
      return new Set<string>();
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: slowGit,
    }));
    try {
      const answer = {
        role: "assistant",
        content: [{ type: "text", text: "done before git" }],
      };
      const { session, emit } = fakeSession({
        prompt: async (emit) => {
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [answer],
            willRetry: false,
          });
          emit({ type: "agent_settled" });
        },
        isIdle: () => idle,
        abort: async () => {
          if (abortCalled) return;
          abortCalled = true;
          idle = false;
          setTimeout(() => {
            idle = true;
            postGitSettled = true;
            emit({ type: "agent_settled" });
          }, 120);
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        undefined,
        new Set<string>(),
        start,
        start + 100,
      );

      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(result.output).toBe("done before git");
      expect(gitCalls).toBe(2);
      expect(gitDone).toBe(true);
      expect(postGitSettled).toBe(true);
      expect(result.prompted).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("recomputes output, usage, activities, and Git evidence after final cancellation quiescence", async () => {
    let gitCalls = 0;
    let gitDone = false;
    let idle = true;
    const postQuiescenceGitFile = path.join(
      process.cwd(),
      "post-quiescence-git.txt",
    );
    let postGitSettled = false;
    let abortCalled = false;
    let tokensTotal = 0;
    const slowGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      await sleep(150);
      gitDone = true;
      return gitCalls === 1
        ? new Set<string>()
        : new Set([postQuiescenceGitFile]);
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: slowGit,
    }));
    try {
      const answer = {
        role: "assistant",
        content: [{ type: "text", text: "done before git" }],
      };
      const postAnswer = {
        role: "assistant",
        content: [{ type: "text", text: "post-deadline output" }],
      };
      const { session, emit } = fakeSession({
        messages: [],
        isIdle: () => idle,
        getStats: () =>
          ({
            tokens: {
              input: tokensTotal,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: tokensTotal,
            },
            cost: 0,
          }) as never,
        abort: async () => {
          if (abortCalled) return;
          abortCalled = true;
          idle = false;
          setTimeout(() => {
            tokensTotal = 100;
            emit({
              type: "tool_execution_start",
              toolCallId: "tc-post",
              toolName: "write",
              args: { path: "post-deadline.txt", content: "data" },
            });
            emit({
              type: "tool_execution_end",
              toolCallId: "tc-post",
              toolName: "write",
              result: { content: [] },
              isError: false,
            });
            emit({ type: "message_end", message: postAnswer });
            emit({
              type: "agent_end",
              messages: [postAnswer],
              willRetry: false,
            });
            emit({ type: "agent_settled" });
            idle = true;
            postGitSettled = true;
          }, 120);
        },
        prompt: async (emit) => {
          tokensTotal = 10;
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [answer],
            willRetry: false,
          });
          emit({ type: "agent_settled" });
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        undefined,
        new Set<string>(),
        start,
        start + 100,
      );

      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(result.output).toContain("done before git");
      expect(result.output).toContain("post-deadline output");
      expect(result.tokens).toBe(100);
      expect(result.usage.totalTokens).toBe(100);
      expect(
        result.touchedFiles.some((f) => f.includes("post-deadline.txt")),
      ).toBe(true);
      expect(
        (result.attributedFiles ?? []).some((f) =>
          f.includes("post-deadline.txt"),
        ),
      ).toBe(true);
      expect(result.touchedFiles).toContain(postQuiescenceGitFile);
      expect(result.attributedFiles).not.toContain(postQuiescenceGitFile);
      expect(gitCalls).toBe(2);
      expect(gitDone).toBe(true);
      expect(postGitSettled).toBe(true);
      expect(result.prompted).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("missed deadline after Git collection is reported as deadline_exceeded", async () => {
    let gitCalls = 0;
    const lateGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      await sleep(120);
      return new Set<string>();
    };
    const noOpSchedule =
      (_deadline: number, _onDeadline: () => void) => () => {};
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: lateGit,
    }));
    mock.module("./timer.ts", () => ({
      ...timer,
      scheduleDeadline: noOpSchedule,
    }));
    try {
      const answer = {
        role: "assistant",
        content: [{ type: "text", text: "done before git" }],
      };
      const { session } = fakeSession({
        prompt: async (emit) => {
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [answer],
            willRetry: false,
          });
          emit({ type: "agent_settled" });
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        undefined,
        new Set<string>(),
        start,
        start + 50,
      );

      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(result.output).toBe("done before git");
      expect(gitCalls).toBe(2);
      expect(result.prompted).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("missed deadline after Git collection in the error path is reported as deadline_exceeded", async () => {
    let gitCalls = 0;
    const lateGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      await sleep(120);
      return new Set<string>();
    };
    const noOpSchedule =
      (_deadline: number, _onDeadline: () => void) => () => {};
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: lateGit,
    }));
    mock.module("./timer.ts", () => ({
      ...timer,
      scheduleDeadline: noOpSchedule,
    }));
    try {
      const { session } = fakeSession({
        prompt: async () => {
          throw new Error("simulated prompt failure");
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        undefined,
        undefined,
        new Set<string>(),
        start,
        start + 50,
      );

      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(gitCalls).toBe(2);
      expect(result.prompted).toBe(true);
    } finally {
      mock.restore();
    }
  });
});

describe("runAgentSession parent abort during git evidence", () => {
  test("unions Git evidence from before and after cancellation quiescence on success", async () => {
    const controller = new AbortController();
    const beforeUnwind = path.join(process.cwd(), "before-unwind.txt");
    const afterUnwind = path.join(process.cwd(), "after-unwind.txt");
    let gitCalls = 0;
    const gitSnapshots = async (): Promise<Set<string>> => {
      gitCalls++;
      if (gitCalls === 1) {
        controller.abort();
        return new Set([beforeUnwind]);
      }
      return new Set([afterUnwind]);
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: gitSnapshots,
    }));
    try {
      const answer = {
        role: "assistant",
        content: [{ type: "text", text: "done before git" }],
      };
      const { session } = fakeSession({
        prompt: async (emit) => {
          emit({ type: "message_end", message: answer });
          emit({ type: "agent_end", messages: [answer], willRetry: false });
          emit({ type: "agent_settled" });
        },
      });

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
      expect(result.touchedFiles).toContain(beforeUnwind);
      expect(result.touchedFiles).toContain(afterUnwind);
      expect(gitCalls).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("preserves initial Git evidence when success-path resnapshot fails", async () => {
    const controller = new AbortController();
    const beforeUnwind = path.join(process.cwd(), "success-before-unwind.txt");
    let gitCalls = 0;
    const gitSnapshots = async (): Promise<Set<string> | undefined> => {
      gitCalls++;
      if (gitCalls === 1) {
        controller.abort();
        return new Set([beforeUnwind]);
      }
      return undefined;
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: gitSnapshots,
    }));
    try {
      const { session } = fakeSession({
        prompt: async (emit) => {
          emit({ type: "agent_end", messages: [], willRetry: false });
          emit({ type: "agent_settled" });
        },
      });

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
      expect(result.touchedFiles).toContain(beforeUnwind);
      expect(gitCalls).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("preserves initial Git evidence when error-path resnapshot fails", async () => {
    const controller = new AbortController();
    const beforeUnwind = path.join(process.cwd(), "error-before-unwind.txt");
    let gitCalls = 0;
    const gitSnapshots = async (): Promise<Set<string> | undefined> => {
      gitCalls++;
      if (gitCalls === 1) {
        controller.abort();
        return new Set([beforeUnwind]);
      }
      return undefined;
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: gitSnapshots,
    }));
    try {
      const { session } = fakeSession({
        prompt: async () => {
          throw new Error("simulated prompt failure");
        },
      });

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
      expect(result.touchedFiles).toContain(beforeUnwind);
      expect(gitCalls).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("parent abort during git evidence collection awaits a second quiescence", async () => {
    const controller = new AbortController();
    let gitCalls = 0;
    let gitDone = false;
    let idle = true;
    let postGitSettled = false;
    let abortCalled = false;
    const slowGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      // The runner is in the Git evidence window; fire the parent abort here.
      controller.abort();
      await sleep(100);
      gitDone = true;
      return new Set<string>();
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: slowGit,
    }));
    try {
      const answer = {
        role: "assistant",
        content: [{ type: "text", text: "done before git" }],
      };
      const { session, emit } = fakeSession({
        prompt: async (emit) => {
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [answer],
            willRetry: false,
          });
          emit({ type: "agent_settled" });
        },
        isIdle: () => idle,
        abort: () => {
          if (abortCalled) return;
          abortCalled = true;
          // Simulate the session still unwinding from the fire-and-forget
          // cancellation. Git resolves before this finishes, so a runner that
          // does not wait for a second quiescence would return while active.
          idle = false;
          setTimeout(() => {
            idle = true;
            postGitSettled = true;
            emit({ type: "agent_settled" });
          }, 200);
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        controller.signal,
        undefined,
        new Set<string>(),
        start,
      );

      expect(result.error).toBe("Aborted");
      expect(result.prompted).toBe(true);
      expect(gitCalls).toBe(2);
      expect(gitDone).toBe(true);
      expect(postGitSettled).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("parent abort during git evidence collection in the error path awaits a second quiescence", async () => {
    const controller = new AbortController();
    let gitCalls = 0;
    let gitDone = false;
    let idle = true;
    let postGitSettled = false;
    let abortCalled = false;
    const slowGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      controller.abort();
      await sleep(100);
      gitDone = true;
      return new Set<string>();
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: slowGit,
    }));
    try {
      const { session, emit } = fakeSession({
        prompt: async () => {
          throw new Error("simulated prompt failure");
        },
        isIdle: () => idle,
        abort: () => {
          if (abortCalled) return;
          abortCalled = true;
          idle = false;
          setTimeout(() => {
            idle = true;
            postGitSettled = true;
            emit({ type: "agent_settled" });
          }, 200);
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        controller.signal,
        undefined,
        new Set<string>(),
        start,
      );

      expect(result.error).toBe("Aborted");
      expect(result.prompted).toBe(true);
      expect(gitCalls).toBe(2);
      expect(gitDone).toBe(true);
      expect(postGitSettled).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("recomputes evidence after the second quiescence wait in the error path", async () => {
    const controller = new AbortController();
    let gitCalls = 0;
    let gitDone = false;
    let idle = true;
    let postGitSettled = false;
    let abortCalled = false;
    let tokensTotal = 0;
    const slowGit = async (_cwd: string): Promise<Set<string>> => {
      gitCalls++;
      controller.abort();
      await sleep(100);
      gitDone = true;
      return new Set<string>();
    };
    mock.module("./file-tracking.ts", () => ({
      ...fileTracking,
      getGitChangedFiles: slowGit,
    }));
    try {
      const postAnswer = {
        role: "assistant",
        content: [{ type: "text", text: "post-abort output" }],
      };
      const { session, emit } = fakeSession({
        messages: [],
        isIdle: () => idle,
        getStats: () =>
          ({
            tokens: {
              input: tokensTotal,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: tokensTotal,
            },
            cost: 0,
          }) as never,
        abort: () => {
          if (abortCalled) return;
          abortCalled = true;
          idle = false;
          setTimeout(() => {
            tokensTotal = 100;
            emit({
              type: "tool_execution_start",
              toolCallId: "tc-post",
              toolName: "write",
              args: { path: "post-abort.txt", content: "data" },
            });
            emit({
              type: "tool_execution_end",
              toolCallId: "tc-post",
              toolName: "write",
              result: { content: [] },
              isError: false,
            });
            emit({ type: "message_end", message: postAnswer });
            emit({
              type: "agent_end",
              messages: [postAnswer],
              willRetry: false,
            });
            emit({ type: "agent_settled" });
            idle = true;
            postGitSettled = true;
          }, 150);
        },
        prompt: async () => {
          tokensTotal = 10;
          throw new Error("simulated prompt failure");
        },
      });

      const start = Date.now();
      const result = await runAgentSession(
        session as never,
        "do work",
        { cwd: process.cwd() },
        controller.signal,
        undefined,
        new Set<string>(),
        start,
      );

      expect(result.error).toBe("Aborted");
      expect(result.output).toContain("post-abort output");
      expect(result.tokens).toBe(100);
      expect(result.usage.totalTokens).toBe(100);
      expect(
        result.touchedFiles.some((f) => f.includes("post-abort.txt")),
      ).toBe(true);
      expect(
        (result.attributedFiles ?? []).some((f) =>
          f.includes("post-abort.txt"),
        ),
      ).toBe(true);
      expect(gitCalls).toBe(2);
      expect(gitDone).toBe(true);
      expect(postGitSettled).toBe(true);
      expect(result.prompted).toBe(true);
    } finally {
      mock.restore();
    }
  });
});

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

/** Minimal fake AgentSession — records whether prompt() was invoked and allows
 *  emitting tool events / mutating messages and stats. */
function fakeSession(opts: {
  prompt?: (emit: (e: unknown) => void) => Promise<void>;
  messages?: unknown[];
  state?: unknown;
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
        /* no-op */
      },
      get messages() {
        return opts.messages ?? [];
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

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

/** Minimal fake AgentSession — records whether prompt() was invoked. */
function fakeSession(opts: {
  prompt?: () => Promise<void>;
  messages?: unknown[];
  state?: unknown;
}) {
  let prompted = false;
  const subscribers = new Set<(e: unknown) => void>();
  return {
    prompted: () => prompted,
    session: {
      subscribe(fn: (e: unknown) => void) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
      async prompt(_p: string) {
        prompted = true;
        await opts.prompt?.();
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
        // Cumulative stats for usage-delta accounting. Zeroed so the delta
        // is emptyUsage — these tests assert abort/error paths, not usage.
        return {
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
        };
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
});

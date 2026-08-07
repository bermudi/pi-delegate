import { describe, expect, test, mock } from "bun:test";

/**
 * Verifies that markdown rendering gracefully degrades to plain text when the host
 * no longer exposes `getMarkdownTheme`. This prevents a single missing export from
 * crashing delegated output rendering.
 *
 * Note: This is a targeted unit test for a single rendering fallback. It uses
 * `mock.module` to simulate a missing host export without booting a full Pi
 * session. The Pi test harness (`@marcfargas/pi-test-harness`) is used for
 * integration tests that need a real `AgentSession` and extension lifecycle
 * (see `delegate.test.ts`, `lifecycle.test.ts`). For this pure rendering check,
 * a lightweight module mock is more direct and avoids the ~1s session boot cost.
 * See harness docs: `createTestSession` is for in-process session testing with
 * playbook-driven model mocking, not for isolated host-export compatibility.
 */
describe("render-branches compatibility fallback", () => {
  test("falls back to plain text when getMarkdownTheme is unavailable", async () => {
    mock.module("@earendil-works/pi-coding-agent", (original) => {
      const ns = original as Record<string, unknown>;
      return {
        ...ns,
        getMarkdownTheme: undefined,
      } as never;
    });

    try {
      const { renderFinalBranch } = await import("./render-branches.ts");

      const ctx = {
        progress: [
          {
            index: 0,
            agent: "agent",
            task: "do work",
            status: "done",
            durationMs: 10,
            tokens: 3,
            toolUses: 0,
            activities: [],
            error: undefined,
          },
        ],
        taskResults: [
          {
            agent: "agent",
            output: "**markdown output**",
            durationMs: 10,
            tokens: 3,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            touchedFiles: [],
          },
        ],
        total: 1,
        w: 80,
        expanded: true,
        state: {},
        // Minimal theme-compatible surface used by render branches.
        theme: {
          fg: (_: string, text: string) => text,
          bold: (text: string) => text,
        } as never,
        lines: [],
      };

      renderFinalBranch(ctx, {
        statJoin: () => "",
        modelLabel: () => "",
        compactActivity: () => "thinking…",
        pushWarnings: () => undefined,
      });

      expect(
        ctx.lines.some((line) => line.includes("**markdown output**")),
      ).toBe(true);
    } finally {
      mock.restore();
    }
  });
});

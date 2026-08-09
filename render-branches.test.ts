import { describe, expect, test, mock } from "bun:test";
import { renderDelegateResult } from "./render-result.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  DelegateDetails,
  TaskDef,
  TaskProgress,
  TaskResult,
} from "./types.ts";

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

  test("shows #<id> in the partial (live) branch and omits it when absent", async () => {
    const { renderPartialBranch } = await import("./render-branches.ts");

    const progressWithId = {
      index: 0,
      id: "live-1",
      agent: "agent",
      task: "do work",
      status: "running" as const,
      durationMs: 10,
      tokens: 3,
      toolUses: 0,
      activities: [],
    };
    const progressWithoutId = { ...progressWithId, id: undefined };

    const theme = {
      fg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never;

    const makeCtx = (progress: typeof progressWithId) => ({
      progress: [progress],
      total: 1,
      w: 80,
      expanded: false,
      state: { startedAt: Date.now() },
      theme,
      lines: [],
    });

    const ctxWith = makeCtx(progressWithId);
    renderPartialBranch(ctxWith, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });
    expect(ctxWith.lines.some((line) => line.includes("agent #live-1"))).toBe(
      true,
    );

    const ctxWithout = makeCtx(progressWithoutId);
    ctxWithout.lines = [];
    renderPartialBranch(ctxWithout, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });
    expect(
      ctxWithout.lines.some((line) => line.includes("agent #live-1")),
    ).toBe(false);
  });

  test("shows #<id> when a task has an id and omits it when absent", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");

    const progressWithId = {
      index: 0,
      id: "task-1",
      agent: "agent",
      task: "do work",
      status: "done" as const,
      durationMs: 10,
      tokens: 3,
      toolUses: 0,
      activities: [],
      error: undefined,
    };
    const progressWithoutId = { ...progressWithId, id: undefined };

    const result = {
      agent: "agent",
      output: "done",
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
    };

    const theme = {
      fg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never;

    const ctxWith = {
      progress: [progressWithId],
      taskResults: [result],
      total: 1,
      w: 80,
      expanded: false,
      state: {},
      theme,
      lines: [],
    };
    renderFinalBranch(ctxWith, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });
    expect(ctxWith.lines.some((line) => line.includes("agent #task-1"))).toBe(
      true,
    );

    const ctxWithout = { ...ctxWith, progress: [progressWithoutId], lines: [] };
    renderFinalBranch(ctxWithout, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });
    expect(
      ctxWithout.lines.some((line) => line.includes("agent #task-1")),
    ).toBe(false);
    expect(ctxWithout.lines.some((line) => line.includes("agent"))).toBe(true);
  });

  test("clamps the task preview width for very long ids", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");

    const progress = {
      index: 0,
      id: "x".repeat(100),
      agent: "agent",
      task: "do work",
      status: "done" as const,
      durationMs: 10,
      tokens: 3,
      toolUses: 0,
      activities: [],
      error: undefined,
    };
    const result = {
      agent: "agent",
      output: "done",
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
    };

    const theme = {
      fg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never;

    const ctx = {
      progress: [progress],
      taskResults: [result],
      total: 1,
      w: 40,
      expanded: false,
      state: {},
      theme,
      lines: [],
    };

    expect(() =>
      renderFinalBranch(ctx, {
        statJoin: () => "",
        modelLabel: () => "",
        compactActivity: () => "thinking…",
        pushWarnings: () => undefined,
      }),
    ).not.toThrow();
    expect(ctx.lines.length).toBeGreaterThan(0);
    expect(ctx.lines.some((line) => line.includes("agent"))).toBe(true);
  });
});

describe("render-result overlap warning", () => {
  test("survives collapsed line budget when many tasks overflow the view", () => {
    const originalRows = process.stdout.rows;
    const originalColumns = process.stdout.columns;

    try {
      // Force a small, deterministic budget so 15 collapsed tasks exceed it.
      process.stdout.rows = 30;
      process.stdout.columns = 200;

      const overlapWarning =
        "WARNING: These tasks reported touching the same file(s): a.ts. Delegate does not isolate or serialize file access and does not roll back completed writes.";

      const tasks: TaskDef[] = [];
      const pairs = Array.from({ length: 15 }, (_, i) => makeTask(i));
      const progress = pairs.map((p) => p.progress);
      const results = pairs.map((p) => p.result);

      const details: DelegateDetails = {
        tasks,
        results,
        progress,
        overlapWarning,
      };

      const result = { details } as never;
      const options = { isPartial: false, expanded: false };
      const theme = {
        fg: (_: string, text: string) => text,
        bold: (text: string) => text,
      } as never;

      const fakeText = {
        text: "",
        setText(t: string) {
          this.text = t;
        },
      };
      const ctx = {
        state: {},
        lastComponent: fakeText as never,
        invalidate: () => {},
        executionStarted: false,
        isPartial: false,
      };

      renderDelegateResult(
        result as never,
        options as never,
        theme as never,
        ctx as never,
      );

      // The collapsed view should have been truncated.
      expect(fakeText.text).toContain("lines hidden");
      // The overlap warning must still be visible, not cut off by the budget.
      expect(fakeText.text).toContain(overlapWarning);
    } finally {
      process.stdout.rows = originalRows;
      process.stdout.columns = originalColumns;
    }
  });
});

function makeUsage(tokens: number): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function makeTask(index: number): {
  progress: TaskProgress;
  result: TaskResult;
} {
  const agent = `agent-${index}`;
  const task = `do work ${index}`;
  const progress: TaskProgress = {
    index,
    agent,
    task,
    status: "done",
    durationMs: 10,
    tokens: 1,
    toolUses: 0,
    activities: [],
  };
  const result: TaskResult = {
    agent,
    output: "(no output)",
    durationMs: 10,
    tokens: 1,
    usage: makeUsage(1),
    touchedFiles: [],
    attributedFiles: [],
  };
  return { progress, result };
}

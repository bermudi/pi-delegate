import { describe, expect, test, mock } from "bun:test";
import { renderDelegateResult } from "./render-result.ts";
import { toolExpandHint } from "./key-hints.ts";
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

  test("a resumed task renders as a revival, not a fresh ad-hoc spawn", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");

    const theme = {
      fg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never;
    const helpers = {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    };
    const makeResult = (agent: string) => ({
      agent,
      output: "",
      error: "Provided authentication token is expired.",
      durationMs: 10,
      tokens: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      touchedFiles: [],
    });

    // Omitted-agent resume: identity is `resume:<tag>` — no "ad-hoc", and no
    // duplicate ↻ marker on top of the resume identity.
    const resumed = {
      progress: [
        {
          index: 0,
          agent: "resume:01a01df4",
          resumedFrom: "01a01df4",
          task: "continue the fixes",
          status: "failed" as const,
          durationMs: 10,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      taskResults: [makeResult("resume:01a01df4")],
      total: 1,
      w: 120,
      expanded: false,
      state: {},
      theme,
      lines: [] as string[],
    };
    renderFinalBranch(resumed, helpers);
    expect(resumed.lines.some((line) => line.includes("resume:01a01df4"))).toBe(
      true,
    );
    expect(resumed.lines.some((line) => line.includes("ad-hoc"))).toBe(false);
    expect(resumed.lines.some((line) => line.includes("↻"))).toBe(false);

    // Named-agent resume: keeps the name and gains the ↻ revival marker.
    const named = {
      ...resumed,
      progress: [{ ...resumed.progress[0]!, agent: "coder" }],
      taskResults: [makeResult("coder")],
      lines: [] as string[],
    };
    renderFinalBranch(named, helpers);
    expect(named.lines.some((line) => line.includes("coder ↻01a01df4"))).toBe(
      true,
    );
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

  test("does not render stale unfinished rows as live for terminal tickets", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");

    const theme = {
      fg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never;
    const helpers = {
      statJoin: () => " · FINAL_STATS",
      modelLabel: () => "",
      compactActivity: () => "LIVE_ACTIVITY",
      pushWarnings: () => undefined,
    };

    const makeProgress = (status: "running" | "pending"): TaskProgress => ({
      index: 0,
      agent: "agent",
      task: "do work",
      status,
      durationMs: 10,
      tokens: 3,
      toolUses: 0,
      activities: [],
    });

    for (const ticketStatus of ["failed", "cancelled"] as const) {
      for (const rowStatus of ["running", "pending"] as const) {
        const ctx = {
          progress: [makeProgress(rowStatus)],
          taskResults: [{ error: "PENDING" }],
          total: 1,
          w: 100,
          expanded: true,
          state: {},
          theme,
          lines: [],
          ticketId: "ticket-1",
          ticketStatus,
        };

        renderFinalBranch(ctx, helpers);

        expect(ctx.lines.join("\n")).not.toContain("LIVE_ACTIVITY");
        expect(ctx.lines.join("\n")).not.toContain("waiting");
        expect(ctx.lines.join("\n")).not.toContain("running in background");
        expect(ctx.lines[0]).toContain("1/1 finished");
        if (ticketStatus === "cancelled") {
          expect(ctx.lines[0]).toContain("1 cancelled");
          expect(ctx.lines[0]).not.toContain("failed");
          expect(ctx.lines.join("\n")).toContain("CANCELLED");
          expect(ctx.lines.join("\n")).not.toContain("PENDING");
        } else {
          expect(ctx.lines[0]).toContain("1 failed");
          expect(ctx.lines[0]).not.toContain("cancelled");
          expect(ctx.lines.join("\n")).toContain("FINAL_STATS");
        }
      }
    }
  });

  test("separates failed and cancelled rows in a cancelled terminal summary", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");
    const progress: TaskProgress[] = [
      { ...makeTask(0).progress, status: "done" },
      { ...makeTask(1).progress, status: "failed", error: "boom" },
      { ...makeTask(2).progress, status: "running" },
    ];
    const ctx = {
      progress,
      taskResults: [makeTask(0).result, { error: "boom" }, { error: "abort" }],
      total: progress.length,
      w: 120,
      expanded: false,
      state: {},
      theme: {
        fg: (_: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      lines: [] as string[],
      ticketId: "ticket-1",
      ticketStatus: "cancelled" as const,
    };

    renderFinalBranch(ctx, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });

    expect(ctx.lines[0]).toContain("3/3 finished · 1 failed · 1 cancelled");
    expect(ctx.lines[0]).toContain("ticket cancelled");
  });

  test("renders a settled user-aborted task as cancelled, not failed", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");
    const progress: TaskProgress[] = [
      { ...makeTask(0).progress, status: "done" },
      {
        ...makeTask(1).progress,
        status: "failed",
        error: "Aborted",
        failureKind: "cancelled",
      },
    ];
    const ctx = {
      progress,
      taskResults: [makeTask(0).result, { error: "Aborted" }],
      total: progress.length,
      w: 120,
      expanded: false,
      state: {},
      theme: {
        fg: (_: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      lines: [] as string[],
      ticketId: "ticket-1",
      ticketStatus: "cancelled" as const,
    };

    renderFinalBranch(ctx, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });

    expect(ctx.lines[0]).toContain(
      "2/2 finished · 1 cancelled · ticket cancelled",
    );
    expect(ctx.lines[0]).not.toContain("failed");
    expect(ctx.lines.join("\n")).toContain("CANCELLED");
    expect(ctx.lines.join("\n")).not.toContain("Aborted");

    const syncCtx = {
      ...ctx,
      ticketId: undefined,
      ticketStatus: undefined,
      lines: [] as string[],
    };
    renderFinalBranch(syncCtx, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });
    expect(syncCtx.lines[0]).toContain("2/2 finished · 1 cancelled");
    expect(syncCtx.lines[0]).not.toContain("failed");
    expect(syncCtx.lines.join("\n")).toContain("CANCELLED");
  });

  test("keeps provider 'Aborted' errors failed and visible", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");
    const progress: TaskProgress[] = [
      { ...makeTask(0).progress, status: "failed", error: "Aborted" },
    ];
    const ctx = {
      progress,
      taskResults: [{ error: "Aborted" }],
      total: 1,
      w: 120,
      expanded: false,
      state: {},
      theme: {
        fg: (_: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      lines: [] as string[],
      ticketId: "ticket-1",
      ticketStatus: "failed" as const,
    };

    renderFinalBranch(ctx, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });

    expect(ctx.lines[0]).toContain("1 failed");
    expect(ctx.lines[0]).not.toContain("cancelled");
    expect(ctx.lines.join("\n")).toContain("Aborted");
    expect(ctx.lines.join("\n")).not.toContain("CANCELLED");
  });

  test("keeps fully finalized tickets live until their ticket status settles", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");
    const theme = {
      fg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never;
    const progress: TaskProgress = {
      ...makeTask(0).progress,
      status: "done",
    };
    const helpers = {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    };

    for (const ticketStatus of ["running", "cancelling"] as const) {
      const ctx = {
        progress: [progress],
        taskResults: [makeTask(0).result],
        total: 1,
        w: 100,
        expanded: false,
        state: {},
        theme,
        lines: [],
        ticketId: "ticket-1",
        ticketStatus,
        elapsedMs: 10,
      };

      renderFinalBranch(ctx, helpers);

      expect(ctx.lines[0]).toContain("ticket ticket-1");
      expect(ctx.lines[0]).toContain("1/1 finished");
      expect(ctx.lines[0]).not.toStartWith("✓");
      if (ticketStatus === "cancelling") {
        expect(ctx.lines[0]).toContain("cancelling");
      }
    }
  });

  test("omits batch duration when no wall-clock source exists", async () => {
    const { renderFinalBranch } = await import("./render-branches.ts");
    const pair = makeTask(0);
    const ctx = {
      progress: [pair.progress],
      taskResults: [pair.result],
      total: 1,
      w: 100,
      expanded: false,
      state: {},
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

    expect(ctx.lines[0]).toBe(
      `✓ 1/1 finished · 1 tokens${toolExpandHint() ? ` · ${toolExpandHint()}` : ""}`,
    );
  });

  test("keeps live summary fields stable and counts failures as finished", async () => {
    const { renderPartialBranch } = await import("./render-branches.ts");
    const progress: TaskProgress[] = [
      {
        ...makeTask(0).progress,
        status: "done",
        tokens: 10,
      },
      {
        ...makeTask(1).progress,
        status: "failed",
        tokens: 20,
        error: "boom",
      },
      {
        ...makeTask(2).progress,
        status: "running",
        tokens: 30,
      },
    ];
    const ctx = {
      progress,
      taskResults: [],
      total: progress.length,
      w: 120,
      expanded: false,
      state: {},
      theme: {
        fg: (_: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      lines: [],
    };

    renderPartialBranch(ctx, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "thinking…",
      pushWarnings: () => undefined,
    });

    expect(ctx.lines[0]).toBe(
      `1 running · 2/3 finished · 1 failed · 60 tokens${toolExpandHint() ? ` · ${toolExpandHint()}` : ""}`,
    );
  });

  test("sanitizes expanded live output before rendering", async () => {
    const { renderPartialBranch } = await import("./render-branches.ts");
    const progress: TaskProgress = {
      ...makeTask(0).progress,
      status: "running",
      activities: [
        {
          id: "live",
          name: "bash",
          args: { command: "run" },
          startTime: Date.now() - 10,
          liveOutput:
            "safe\x9d0;terminal title\x07 text\nback\bspace\x07\x00\n\x90hidden\x9cvisible",
        },
      ],
    };
    const ctx = {
      progress: [progress],
      taskResults: [],
      total: 1,
      w: 120,
      expanded: true,
      state: {},
      theme: {
        fg: (_: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      lines: [] as string[],
    };

    renderPartialBranch(ctx, {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "bash run",
      pushWarnings: () => undefined,
    });

    const rendered = ctx.lines.join("\n");
    expect(rendered).toContain("safe text");
    expect(rendered).toContain("back space");
    expect(rendered).toContain("visible");
    expect(rendered).not.toContain("terminal title");
    expect(rendered).not.toContain("hidden");
    expect(
      ctx.lines.some((line) => /[\u0000-\u001f\u007f-\u009f]/.test(line)),
    ).toBe(false);
  });

  test("sanitizes tool arguments, errors, warnings, and caller labels before rendering", () => {
    const control = (label: string) => `\x1b]0;${label}\x07`;
    const progress: TaskProgress[] = [
      {
        ...makeTask(0).progress,
        agent: `runner${control("AGENT_ATTACK")} safe`,
        id: `id${control("ID_ATTACK")} safe`,
        task: `task${control("TASK_ATTACK")} safe`,
        model: `provider/model${control("MODEL_ATTACK")} safe`,
        status: "running",
        warnings: [`warn${control("WARNING_ATTACK")} ok\nsecond`],
        activities: [
          {
            id: "live",
            name: "bash",
            args: {
              command: `echo safe${control("TOOL_ATTACK")}\nnext`,
            },
            startTime: Date.now() - 10,
          },
        ],
      },
      {
        ...makeTask(1).progress,
        status: "failed",
        error: `progress error${control("PROGRESS_ERROR_ATTACK")} safe\nnext`,
        warnings: [],
        activities: [
          {
            id: "failed-tool",
            name: `provider_tool${control("TOOL_NAME_ATTACK")} safe`,
            args: {
              query: `query safe${control("TOOL_QUERY_ATTACK")}\nnext`,
            },
            startTime: Date.now() - 20,
            endTime: Date.now() - 10,
            result: { content: [], isError: true },
          },
        ],
      },
    ];
    const results = [
      makeTask(0).result,
      {
        ...makeTask(1).result,
        error: `result error${control("RESULT_ERROR_ATTACK")} safe\nnext`,
        output: `output${control("OUTPUT_ATTACK")} safe\nnext\x00`,
      },
    ];
    const theme = {
      fg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never;
    const render = (isPartial: boolean, expanded: boolean): string => {
      const text = {
        value: "",
        setText(value: string) {
          this.value = value;
        },
      };
      renderDelegateResult(
        {
          details: {
            tasks: [],
            results,
            progress,
            dispatchWarning: `dispatch${control("DISPATCH_WARNING_ATTACK")} safe`,
            overlapWarning: `overlap${control("OVERLAP_WARNING_ATTACK")} safe`,
          },
        } as never,
        { isPartial, expanded },
        theme,
        {
          state: {},
          lastComponent: text as never,
          invalidate: () => {},
          executionStarted: isPartial,
          isPartial,
        },
      );
      return text.value;
    };

    const compact = render(true, false);
    const partial = render(true, true);
    const final = render(false, true);
    const rendered = `${compact}\n${partial}\n${final}`;
    expect(compact).toContain("$ echo safe next");
    expect(partial).toContain("$ echo safe next");
    expect(partial).toContain("⚠ warn ok second");
    expect(partial).toContain("⚠ dispatch safe");
    expect(partial).toContain("⚠ overlap safe");
    expect(partial).toContain("progress error safe next");
    expect(partial).toContain("provider_tool safe query safe next");
    expect(final).toContain("result error safe next");
    expect(final).toContain("output safe");
    expect(final).toContain("provider/model safe");
    for (const marker of [
      "AGENT_ATTACK",
      "ID_ATTACK",
      "TASK_ATTACK",
      "MODEL_ATTACK",
      "WARNING_ATTACK",
      "DISPATCH_WARNING_ATTACK",
      "OVERLAP_WARNING_ATTACK",
      "TOOL_ATTACK",
      "TOOL_NAME_ATTACK",
      "TOOL_QUERY_ATTACK",
      "PROGRESS_ERROR_ATTACK",
      "RESULT_ERROR_ATTACK",
      "OUTPUT_ATTACK",
    ]) {
      expect(rendered).not.toContain(marker);
    }
    expect(rendered).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });

  test("uses distinct markers for current work, history, and results", async () => {
    const { renderPartialBranch } = await import("./render-branches.ts");
    const fgCalls: Array<[string, string]> = [];
    const progress: TaskProgress = {
      ...makeTask(0).progress,
      status: "running",
      activities: [
        {
          id: "done",
          name: "read",
          args: { path: "a.ts" },
          startTime: Date.now() - 20,
          endTime: Date.now() - 10,
          result: { content: [], isError: false },
        },
        {
          id: "live",
          name: "bash",
          args: { command: "bun test" },
          startTime: Date.now() - 10,
        },
      ],
    };
    const baseCtx = {
      progress: [progress],
      taskResults: [],
      total: 1,
      w: 120,
      state: {},
      theme: {
        fg: (token: string, text: string) => {
          fgCalls.push([token, text]);
          return text;
        },
        bold: (text: string) => text,
      } as never,
    };
    const helpers = {
      statJoin: () => "",
      modelLabel: () => "",
      compactActivity: () => "bash bun test",
      pushWarnings: () => undefined,
    };
    const collapsed = { ...baseCtx, expanded: false, lines: [] as string[] };
    renderPartialBranch(collapsed, helpers);
    expect(collapsed.lines.join("\n")).toContain("› bash bun test");
    expect(collapsed.lines.join("\n")).not.toContain("⎿");

    const expanded = { ...baseCtx, expanded: true, lines: [] as string[] };
    renderPartialBranch(expanded, helpers);
    expect(expanded.lines.join("\n")).toContain("→ read");
    expect(expanded.lines.join("\n")).toContain("› $ bun test");
    expect(fgCalls).toContainEqual(["dim", "→ read a.ts"]);
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

describe("render-result visual hierarchy", () => {
  test("dims task stats and uses the same final summary shape as live progress", () => {
    const pair = makeTask(0);
    const details: DelegateDetails = {
      tasks: [],
      results: [pair.result],
      progress: [pair.progress],
      elapsedMs: 10,
    };
    const fgCalls: Array<[string, string]> = [];
    const theme = {
      fg: (token: string, text: string) => {
        fgCalls.push([token, text]);
        return text;
      },
      bold: (text: string) => text,
    } as never;
    const fakeText = {
      text: "",
      setText(text: string) {
        this.text = text;
      },
    };

    renderDelegateResult(
      { details } as never,
      { isPartial: false, expanded: true },
      theme,
      {
        state: {},
        lastComponent: fakeText as never,
        invalidate: () => {},
        executionStarted: false,
        isPartial: false,
      },
    );

    expect(fakeText.text).toContain("1/1 finished · 1 tokens · 10ms");
    expect(fgCalls).toContainEqual(["dim", " · 10ms · 1 tokens"]);
  });

  test("renders abandoned token accounting and evidence as incomplete", () => {
    const pair = makeTask(0);
    pair.progress.status = "failed";
    pair.progress.error = "Stalled";
    pair.progress.incomplete = "quiescence_abandoned";
    pair.result.error = "Stalled";
    pair.result.incomplete = "quiescence_abandoned";
    const fakeText = {
      text: "",
      setText(text: string) {
        this.text = text;
      },
    };

    renderDelegateResult(
      {
        details: {
          tasks: [],
          results: [pair.result],
          progress: [pair.progress],
          elapsedMs: 10,
        },
      } as never,
      { isPartial: false, expanded: true },
      {
        fg: (_token: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      {
        state: {},
        lastComponent: fakeText as never,
        invalidate: () => {},
        executionStarted: false,
        isPartial: false,
      },
    );

    expect(fakeText.text).toContain(
      "≥1 tokens · incomplete accounting/evidence",
    );
    expect(fakeText.text).toContain("≥1 tokens (incomplete)");
    expect(fakeText.text).toContain(
      "INCOMPLETE: accounting and output/file evidence are lower bounds",
    );
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

import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { Check } from "typebox/value";
import { liveDispatchDetailsSchema } from "../../src/details.ts";
import {
  delegateTool,
  objectOf,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/**
 * The inline batch's live board has three layouts (#119 follow-up):
 *
 * - normal: one aligned row per task, queued tasks included.
 * - expanded (the expand key): normal rows, each followed by its recent
 *   tool calls.
 * - clean-tui (when bermudis-pi-goodies' clean-tui is on): a bordered
 *   panel; queued tasks fold into one `○ N queued` line.
 *
 * Layouts render from fixed partial frames through the registered
 * `delegate` tool's renderResult. A live run would need real subagent
 * timing, so these pin the text, not the timing.
 */

const CLEAN_TUI_KEY = Symbol.for("bermudis-pi-goodies.clean-tui.active.v1");

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

interface Frame {
  readonly mode: "dispatch";
  readonly async: false;
  readonly live: {
    readonly startedAt: number;
    readonly tasks: readonly Record<string, unknown>[];
  };
}

interface Renderable {
  render(width: number): string[];
}

interface ResultTool {
  renderResult(
    result: { content: unknown[]; details: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: { lastComponent?: unknown },
  ): Renderable;
}

function setCleanTui(active: boolean): void {
  const globals = globalThis as Record<symbol, unknown>;
  if (active) globals[CLEAN_TUI_KEY] = true;
  else delete globals[CLEAN_TUI_KEY];
}

/** Fixed frame: 4 tasks (2 done, 2 running) plus 2 queued. */
function fixedFrame(): Frame {
  const now = Date.now();
  const task = (
    id: string,
    status: string,
    recent: { tool: string; preview: string; inFlight: boolean }[],
    elapsedMs: number,
  ): Record<string, unknown> => ({
    id,
    label: id,
    status,
    startedAt: now - 600_000,
    lastEventAt: now - 600_000 + elapsedMs,
    tool: recent.at(-1)?.tool,
    preview: recent.at(-1)?.preview,
    recent,
  });
  return {
    mode: "dispatch",
    async: false,
    live: {
      startedAt: now - 632_000,
      tasks: [
        task("logging", "ok", [
          { tool: "grep", preview: "app-channel", inFlight: false },
          { tool: "read", preview: "memory-queue.ts", inFlight: false },
        ], 9_440),
        task("tests", "running", [
          { tool: "grep", preview: "src/hindsight.ts", inFlight: true },
        ], 0),
        task("docs", "ok", [
          { tool: "read", preview: "memory-queue.ts", inFlight: false },
        ], 7_530),
        task("code-health", "running", [
          { tool: "read", preview: ".gitignore", inFlight: true },
        ], 0),
        task("hindsight", "queued", [], 0),
        task("setup", "queued", [], 0),
      ],
    },
  };
}

function render(
  session: TestSession,
  frame: Frame,
  expanded: boolean,
): string[] {
  const tool = delegateTool(session) as unknown as ResultTool;
  return tool
    .renderResult(
      { content: [], details: frame },
      { expanded, isPartial: true },
      plainTheme,
      { lastComponent: undefined },
    )
    .render(8192)
    .map((line) => line.replace(/\s+$/, ""));
}

describe("inline live board layouts", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    setCleanTui(false);
    session?.dispose();
    session = undefined;
  });

  test("normal: one aligned row per task, queued tasks shown with a dash", async () => {
    session = await openDelegateBoundary();
    setCleanTui(false);
    const lines = render(session, fixedFrame(), false);
    expect(lines[0]).toMatch(/^delegate · 6 tasks · running \S+ · 2 done$/);
    expect(lines).toHaveLength(7);
    // The row shows the task's latest call (fixture: docs read memory-queue.ts last).
    expect(lines[1]).toMatch(/^ {2}✓ ok {15}logging {15} +9\.4s {2}read memory-queue\.ts$/);
    expect(lines[5]).toMatch(/^ {2}○ queued +hindsight +— *$/);
    // Labels pad to one width, so the tool-name column lines up on every row.
    const toolColumns = lines.slice(1, 5).map((line) => line.search(/(read|grep) /));
    expect(new Set(toolColumns).size).toBe(1);
  });

  test("long legal statuses and tool names preserve the columns; paused is named", async () => {
    session = await openDelegateBoundary();
    setCleanTui(false);
    const frame = fixedFrame();
    const statuses = [
      "budget-exhausted",
      "paused",
      "interrupted",
      "cancelled",
    ];
    const toolNames = ["vision", "mcp__lookup", "web_search", "read"];
    const tasks = frame.live.tasks.slice(0, statuses.length).map((task, index) => ({
      ...task,
      status: statuses[index]!,
      tool: toolNames[index]!,
      preview: `preview-${index}`,
    }));
    const lines = render(
      session,
      { ...frame, live: { ...frame.live, tasks } },
      false,
    ).slice(1);

    expect(lines[0]).toContain("budget-exhausted");
    expect(lines[1]).toContain("paused");
    expect(lines[1]).not.toContain("running");
    expect(lines[2]).toContain("interrupted");
    expect(lines[3]).toContain("cancelled");

    const labelColumns = lines.map((line) => line.search(/logging|tests|docs|code-health/));
    const toolColumns = lines.map((line, index) =>
      line.indexOf(toolNames[index]!),
    );
    expect(new Set(labelColumns).size).toBe(1);
    expect(new Set(toolColumns).size).toBe(1);
    expect(lines[1]).toContain("mcp__lookup preview-1");
  });

  test("every schema-accepted status renders in full with aligned columns", async () => {
    session = await openDelegateBoundary();
    let statuses: unknown = liveDispatchDetailsSchema.properties.live.properties.tasks;
    for (const key of ["items", "properties", "status", "enum"]) {
      statuses = objectOf(statuses, `live status schema parent of ${key}`)[key];
    }
    if (!Array.isArray(statuses)) throw new Error("live statuses must be an enum");
    const frame = fixedFrame();
    const tasks = statuses.map((status: unknown, index) => {
      if (typeof status !== "string") throw new Error("live status must be a string");
      return {
        ...frame.live.tasks[0],
        id: `task-${index}`,
        label: `task-${index}`,
        status,
      };
    });
    const liveFrame = { ...frame, live: { ...frame.live, tasks } };
    expect(Check(liveDispatchDetailsSchema, liveFrame)).toBe(true);
    const rows = render(session, liveFrame, true).filter((line) => /task-\d+/.test(line));
    expect(rows).toHaveLength(tasks.length);
    rows.forEach((row, index) => expect(row).toContain(` ${tasks[index]!.status} `));
    expect(new Set(rows.map((row) => row.indexOf("task-"))).size).toBe(1);
  });

  test("invalid optional recent data keeps task rows and reports invalid expanded details", async () => {
    session = await openDelegateBoundary();
    const validBefore = { tool: "before_recent", preview: "before", inFlight: false };
    const validAfter = { tool: "after_recent", preview: "after", inFlight: true };
    const invalidCalls: readonly unknown[] = [
      null,
      "invalid",
      { tool: "broken_recent", preview: 1, inFlight: false },
      { tool: "broken_recent", preview: "bad" },
      { preview: "bad", inFlight: false },
    ];
    const invalidRecent: readonly unknown[] = [
      null,
      {},
      "not-an-array",
      ...invalidCalls.map((call) => [validBefore, call, validAfter]),
    ];
    for (const recent of invalidRecent) {
      const frame = fixedFrame();
      const tasks = frame.live.tasks.map((task, index) =>
        index === 0 ? { ...task, recent } : task,
      );
      const liveFrame = { ...frame, live: { ...frame.live, tasks } };
      // Recovery belongs only to the display boundary, not emitted details.
      expect(Check(liveDispatchDetailsSchema, liveFrame)).toBe(false);
      for (const mode of ["normal", "expanded", "clean"] as const) {
        setCleanTui(mode === "clean");
        const lines = render(session, liveFrame, mode === "expanded");
        expect(lines[0]).toContain("6 tasks");
        expect(lines[0]).toContain("2 done");
        expect(lines.find((line) => line.includes("logging"))).toMatch(
          /✓ ok +logging +9\.4s {2}read memory-queue\.ts$/,
        );
        if (mode === "expanded") {
          expect(lines.join("\n")).toContain("[invalid recent tool call data]");
          expect(lines.join("\n")).not.toContain("broken_recent");
          if (Array.isArray(recent)) {
            const before = lines.findIndex((line) => line.includes("before_recent"));
            const warning = lines.findIndex((line) => line.includes("[invalid recent"));
            const after = lines.findIndex((line) => line.includes("after_recent"));
            expect(before).toBeGreaterThan(0);
            expect(warning).toBeGreaterThan(before);
            expect(after).toBeGreaterThan(warning);
          }
        }
      }
    }
  });

  test("older frames without recent calls retain their task row without a warning", async () => {
    session = await openDelegateBoundary();
    const frame = fixedFrame();
    const tasks = frame.live.tasks.map(({ recent: _recent, ...task }) => task);
    const liveFrame = { ...frame, live: { ...frame.live, tasks } };
    expect(Check(liveDispatchDetailsSchema, liveFrame)).toBe(true);
    const lines = render(session, liveFrame, true);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("6 tasks");
    expect(lines.join("\n")).not.toContain("[invalid recent");
  });

  test("a long tool name budgets the preview so rows stay one line at 80 columns", async () => {
    session = await openDelegateBoundary();
    setCleanTui(false);
    const frame = fixedFrame();
    const tasks = [
      {
        ...frame.live.tasks[1]!, // the running "tests" task
        tool: "mcp__github__search",
        preview: "x".repeat(200),
      },
    ];
    const lines = render(
      session,
      { ...frame, live: { ...frame.live, tasks } },
      false,
    );
    const row = lines[1]!;
    // The tool name stays intact (identification beats context); the
    // preview absorbs the remaining tail budget so the row never wraps.
    expect(row).toContain("mcp__github__search");
    expect(row).toMatch(/x{5}…$/);
    expect(row.length).toBeLessThanOrEqual(80);
  });

  test("expanded: each task carries its recent calls, newest last", async () => {
    session = await openDelegateBoundary();
    setCleanTui(false);
    const lines = render(session, fixedFrame(), true);
    const logging = lines.indexOf(lines.find((line) => line.includes("logging"))!);
    expect(lines[logging + 1]).toMatch(/^ {8}· grep app-channel$/);
    expect(lines[logging + 2]).toMatch(/^ {8}· read memory-queue\.ts$/);
    const tests = lines.indexOf(lines.find((line) => line.includes("tests"))!);
    expect(lines[tests + 1]).toMatch(/^ {8}▸ grep src\/hindsight\.ts$/);
  });

  test("clean-tui: bordered panel, queued tasks fold into a count", async () => {
    session = await openDelegateBoundary();
    setCleanTui(true);
    const lines = render(session, fixedFrame(), false);
    expect(lines[0]).toMatch(/^╭ delegate · 6 tasks/);
    expect(lines.at(-1)).toBe("╰");
    expect(lines.slice(1, -1).every((line) => line.startsWith("│ "))).toBe(true);
    expect(lines.at(-2)).toBe("│ ○ 2 queued");
    // Queued tasks have no row: their labels never appear as a row start.
    expect(lines.some((line) => /^│ ○ hindsight/.test(line))).toBe(false);
    expect(lines.some((line) => /^│ ○ setup/.test(line))).toBe(false);
  });

  test("expand key overrides clean-tui: expanded never draws the panel", async () => {
    session = await openDelegateBoundary();
    setCleanTui(true);
    const lines = render(session, fixedFrame(), true);
    expect(lines[0]).toMatch(/^delegate · 6 tasks/);
    expect(lines.some((line) => /^ {2}○ queued +hindsight/.test(line))).toBe(true);
  });

  test("clean-tui with no queued tasks shows no queued line", async () => {
    session = await openDelegateBoundary();
    setCleanTui(true);
    const frame = fixedFrame();
    const tasks = frame.live.tasks.filter((task) => task.status !== "queued");
    const lines = render(session, { ...frame, live: { ...frame.live, tasks } }, false);
    expect(lines.join("\n")).not.toContain("queued");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  delegateTool,
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
    expect(lines[1]).toMatch(/^ {2}✓ ok {6}logging +9\.4s {2}read {2}memory-queue\.ts$/);
    expect(lines[5]).toMatch(/^ {2}○ queued {2}hindsight +— *$/);
    // Labels pad to one width, so the tool-name column lines up on every row.
    const toolColumns = lines.slice(1, 5).map((line) => line.search(/(read|grep) /));
    expect(new Set(toolColumns).size).toBe(1);
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
    expect(lines.some((line) => /^ {2}○ queued {2}hindsight/.test(line))).toBe(true);
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

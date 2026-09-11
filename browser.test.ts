import { describe, expect, mock, spyOn, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  TuiMainScreen,
  TuiAltScreen,
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { AssistantPreview } from "./assistant-preview.ts";
import {
  BrowserHistory,
  browserRows,
  browserRowStatus,
  type BrowserRow,
} from "./browser-state.ts";
import {
  browserDetailText,
  registerSubagentBrowser,
  SubagentBrowser,
} from "./browser.ts";
import { createDelegateRuntime } from "./runtime.ts";
import { PauseController } from "./pause.ts";
import type { AsyncTicket, DelegateDetails, TaskProgress } from "./types.ts";
import { updateProgressFromRun } from "./lifecycle.ts";

function progress(index = 0): TaskProgress {
  return {
    index,
    id: `task-${index}`,
    agent: "coder",
    task: "Work on the browser",
    status: "running",
    durationMs: 1200,
    tokens: 40,
    toolUses: 0,
    activities: [],
  };
}

function ticket(id = "ticket-a"): AsyncTicket {
  return {
    id,
    created: 100,
    tasks: [{ prompt: "Build browser" }],
    resolved: [],
    progress: [progress()],
    results: [],
    status: "running",
    controller: new AbortController(),
    pause: new PauseController(),
  };
}

function row(): BrowserRow {
  const t = ticket();
  return {
    key: "a:0",
    batch: "a",
    created: 100,
    progress: t.progress[0]!,
    siblings: t.progress,
    prompt: "Build browser",
    finished: false,
    ticket: t,
  };
}

function details(p = progress()): DelegateDetails {
  return { tasks: [{ prompt: "Sync work" }], progress: [p], results: [] };
}

const theme = { fg: (_color: string, text: string): string => text };

describe("bounded assistant preview", () => {
  test("replaces streaming snapshots and retains previous turns", () => {
    const preview = new AssistantPreview();
    preview.update("hel");
    preview.update("hello");
    expect(preview.text).toBe("hello");
    preview.finish("hello");
    preview.update("second");
    expect(preview.text).toBe("hello\n\nsecond");
    preview.finish("second");
    expect(preview.text).toBe("hello\n\nsecond");
  });

  test("empty synthetic failures preserve partial output and bound retained text", () => {
    const preview = new AssistantPreview();
    preview.update("useful partial");
    preview.finish("");
    expect(preview.text).toBe("useful partial");
    preview.update("x".repeat(AssistantPreview.limit * 2));
    expect(preview.text).toHaveLength(AssistantPreview.limit);
    preview.finish("");
    expect(preview.text).toHaveLength(AssistantPreview.limit);
  });

  test("lifecycle carries preview and phase into live task progress", () => {
    const p = progress();
    updateProgressFromRun(p, {
      tokens: 50,
      toolUses: 1,
      durationMs: 200,
      activities: [],
      assistantPreview: "working",
      activity: "streaming model output",
    });
    expect(p.assistantPreview).toBe("working");
    expect(p.activity).toBe("streaming model output");
  });
});

describe("browser state", () => {
  test("combines live sync/async runs, retaining completed results without mutating tickets", () => {
    const runtime = createDelegateRuntime();
    const history = new BrowserHistory();
    const t = ticket();
    runtime.tickets.set(t.id, t);
    history.update("sync-1", details(), false);
    expect(browserRows(runtime, history)).toHaveLength(2);
    t.progress[0]!.status = "done";
    t.status = "done";
    const rows = browserRows(runtime, history);
    expect(rows[0]!.batch).toBe("sync sync-1");
    expect(rows[1]!.ticket).toBe(t);
    expect(rows[1]!.finished).toBe(true);
    expect(runtime.tickets.size).toBe(1);
  });

  test("retains twenty completed sync calls plus all active calls", () => {
    const history = new BrowserHistory();
    history.update("active", details(), false);
    for (let n = 0; n < 25; n++) history.update(String(n), details(), true);
    expect(history.runs.size).toBe(21);
    expect(history.runs.has("active")).toBe(true);
    expect(history.runs.has("0")).toBe(false);
    history.fail("active", new Error("setup broke"));
    expect(history.runs.size).toBe(20);
    expect(history.runs.get("active")?.error).toBe("setup broke");
  });

  test("empty final progress cannot leave a phantom active sync call", () => {
    const history = new BrowserHistory();
    history.update("setup", details(), false);
    history.update("setup", { tasks: [], progress: [], results: [] }, true);
    expect(history.runs.get("setup")?.finished).toBe(true);
    expect(history.runs.get("setup")?.error).toContain(
      "before tasks could start",
    );
  });

  test("late dispatch callbacks cannot repopulate history after shutdown", () => {
    const history = new BrowserHistory();
    const generation = history.generation;
    history.update("old", details(), false, generation);
    history.reset();
    history.update("old", details(), true, generation);
    history.fail("old", new Error("late"), generation);
    expect(history.runs.size).toBe(0);
    history.update("new", details(), false);
    expect(history.runs.size).toBe(1);
  });

  test("completed sync history releases full tool payloads and preserves bounded display data", () => {
    const history = new BrowserHistory();
    const p = progress();
    p.activities = Array.from({ length: 200 }, (_, index) => ({
      id: String(index),
      name: "write",
      startTime: index,
      args: {
        path: `/tmp/file-${index}`,
        content: "large".repeat(10000),
        nested: { ignored: true },
      },
      result: {
        isError: false,
        content: [{ type: "text", text: "output".repeat(10000) }],
      },
    }));
    history.update("completed", details(p), true);
    const retained = history.runs.get("completed")!.details.progress[0]!;
    expect(retained.activities.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(retained).length).toBeLessThan(100_000);
    expect(retained.activities.at(-1)!.args.path).toBe("/tmp/file-199");
    expect(retained.activities.at(-1)!.args).not.toHaveProperty("content");
    expect(retained.activities.at(-1)!.args).not.toHaveProperty("nested");
    p.activities.length = 0;
    expect(retained.activities.length).toBeGreaterThan(0);
    expect(retained.warnings?.join(" ")).toContain(
      "Earlier tool activity omitted",
    );
  });

  test("reports predecessor, cooperative pause, cancellation and incomplete work honestly", () => {
    const r = row();
    const second = progress(1);
    second.status = "pending";
    second.waitingFor = 0;
    r.siblings.push(second);
    r.progress = second;
    expect(browserRowStatus(r)).toContain("waiting for task-0");
    r.siblings[0]!.status = "done";
    expect(browserRowStatus(r)).toContain("preparation or capacity");
    r.ticket!.pause!.pause();
    expect(browserRowStatus(r)).toBe("queued — ticket paused");
    second.status = "running";
    second.paused = true;
    expect(browserRowStatus(r)).toBe("paused");
    r.ticket!.status = "cancelling";
    expect(browserRowStatus(r)).toBe("cancelling");
    second.incomplete = "quiescence_abandoned";
    expect(browserRowStatus(r)).toContain("worker may still be active");
  });
});

describe("browser component", () => {
  test("shows live tools, failures, notices and final response instead of partial", () => {
    const r = row();
    r.notice = "Serialized writers";
    r.progress.assistantPreview = "partial";
    r.progress.activities.push({
      id: "tool-1",
      name: "bash",
      args: { command: "bun test" },
      startTime: 1,
      liveOutput: "test running",
    });
    expect(browserDetailText(r, false)).toContain("RUNNING $ bun test");
    expect(browserDetailText(r, false)).toContain("test running");
    expect(browserDetailText(r, false)).toContain("Serialized writers");
    r.progress.activities[0]!.result = {
      isError: true,
      content: [{ type: "text", text: "failed assertion" }],
    };
    r.progress.activities[0]!.endTime = 2;
    expect(browserDetailText(r, false)).toContain("FAILED");
    expect(browserDetailText(r, false)).toContain("failed assertion");
    expect(browserDetailText(r, true)).toBe("partial");
    r.output = "final answer";
    expect(browserDetailText(r, true)).toBe("final answer");
  });

  test("strips hostile terminal controls and stays bounded at narrow widths", () => {
    const r = row();
    r.prompt = "\x1b]52;c;bad\x07prompt\x1b[2J";
    r.progress.id = "\x1b[2Jagent";
    r.output = "\x1b]52;c;bad\x07" + "你好".repeat(30_000) + "\x1b[2J";
    const panel = new SubagentBrowser(
      () => [r],
      theme,
      () => 20,
      () => {},
      () => {},
      () => "",
    );
    panel.handleInput("\t");
    expect(browserDetailText(r, true)).not.toContain("\x1b");
    expect(browserDetailText(r, true).length).toBeLessThanOrEqual(
      AssistantPreview.limit + 30,
    );
    for (const width of [1, 10, 40, 120]) {
      const lines = panel.render(width);
      expect(lines.length).toBeLessThanOrEqual(20);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(line).not.toContain("\x1b]52");
        expect(line).not.toContain("\x1b[2J");
      }
    }
    expect(panel.render(0)).toEqual([]);
  });

  test("keeps selection stable as new tasks arrive, and falls back when a ticket expires", () => {
    const a = row();
    const b = { ...row(), key: "b:0", prompt: "Second task" };
    let rows = [a, b];
    const close = mock(() => {});
    const pause = mock((_r: BrowserRow) => "");
    const panel = new SubagentBrowser(
      () => rows,
      theme,
      () => 20,
      () => {},
      close,
      pause,
    );
    panel.render(100);
    panel.handleInput("\x1b[B");
    expect(panel.render(100).join("\n")).toContain("Task: Second task");
    rows = [{ ...row(), key: "new:0", prompt: "Newest" }, a, b];
    expect(panel.render(100).join("\n")).toContain("Task: Second task");
    panel.handleInput("p");
    expect(pause.mock.calls[0]![0]).toBe(b);
    rows = [a];
    expect(panel.render(100).join("\n")).toContain("Task: Build browser");
    panel.handleInput("\x1b");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("scrollback stays put while text arrives; End resumes following live", () => {
    const r = row();
    r.progress.assistantPreview = Array.from(
      { length: 100 },
      (_, n) => `response-${n}`,
    ).join("\n");
    const panel = new SubagentBrowser(
      () => [r],
      theme,
      () => 20,
      () => {},
      () => {},
      () => "",
    );
    panel.handleInput("\t");
    expect(panel.render(100).join("\n")).toContain("response-99");
    panel.handleInput("\x1b[H");
    expect(panel.render(100).join("\n")).toContain("response-0\n");
    r.progress.assistantPreview += "\nresponse-100";
    expect(panel.render(100).join("\n")).not.toContain("response-100");
    panel.handleInput("\x1b[F");
    expect(panel.render(100).join("\n")).toContain("response-100");
    panel.handleInput("\x1b[5~");
    expect(panel.render(100).join("\n")).not.toContain("response-100");
    panel.handleInput("\x1b[6~");
    expect(panel.render(100).join("\n")).toContain("response-100");
  });
});

describe("browser registration and lifetime", () => {
  test.each([TuiMainScreen, TuiAltScreen])(
    "real TUI %p overlay routes navigation and restores the untouched input",
    (Renderer) => {
      let input!: (data: string) => void;
      const writes: string[] = [];
      const terminal: Terminal = {
        columns: 100,
        rows: 30,
        kittyProtocolActive: false,
        start: (onInput) => {
          input = onInput;
        },
        stop: () => {},
        drainInput: async () => {},
        write: (text) => {
          writes.push(text);
        },
        moveBy: () => {},
        hideCursor: () => {},
        showCursor: () => {},
        clearLine: () => {},
        clearFromCursor: () => {},
        clearScreen: () => {},
        setTitle: () => {},
        setProgress: () => {},
      };
      const tui = new Renderer(terminal);
      const editor = new Input();
      editor.setValue("draft remains");
      tui.addChild(editor);
      tui.setFocus(editor);
      const rows = [row(), { ...row(), key: "second", prompt: "Second task" }];
      const panel = new SubagentBrowser(
        () => rows,
        theme,
        () => 23,
        () => tui.requestRender(),
        () => tui.hideOverlay(),
        () => "",
      );
      try {
        tui.start();
        tui.showOverlay(panel, { width: "95%", maxHeight: "85%" });
        tui.renderNow();
        input("\x1b[B");
        tui.renderNow();
        expect(writes.join("")).toContain("Second task");
        expect(editor.getValue()).toBe("draft remains");
        expect(tui.getFocusedComponent()).toBe(panel);
        input("\x1b");
        expect(tui.getFocusedComponent()).toBe(editor);
        expect(tui.hasOverlay()).toBe(false);
        input("!");
        // Input.setValue leaves its cursor at the start. Both draft and cursor
        // position must survive the overlay.
        expect(editor.getValue()).toBe("!draft remains");
      } finally {
        tui.stop();
      }
    },
  );

  test("shortcut preserves draft, controls the whole ticket, and disposes timer on close/shutdown", async () => {
    const runtime = createDelegateRuntime();
    const t = ticket();
    t.progress.push(progress(1));
    runtime.tickets.set(t.id, t);
    let shortcut: ((ctx: ExtensionContext) => Promise<void> | void) | undefined;
    let shutdown: (() => void) | undefined;
    const registerCommand = mock(() => {});
    const pi = {
      registerCommand,
      registerShortcut: (
        key: string,
        options: { handler: typeof shortcut },
      ) => {
        expect(key).toBe("ctrl+shift+b");
        shortcut = options.handler;
      },
      on: (event: string, handler: () => void) => {
        if (event === "session_shutdown") shutdown = handler;
      },
    } as unknown as ExtensionAPI;
    const history = registerSubagentBrowser(pi, runtime);
    expect(registerCommand).toHaveBeenCalledTimes(1);
    let component: Component | undefined;
    const setEditorText = mock(() => {});
    const requestRender = mock(() => {});
    const custom = mock(
      (
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: () => void,
        ) => Component,
      ) =>
        new Promise<void>((resolve) => {
          component = factory(
            { terminal: { rows: 30 }, requestRender },
            theme,
            {},
            resolve,
          );
        }),
    );
    const notify = mock(() => {});
    const ctx = {
      mode: "tui",
      ui: {
        custom,
        setEditorText,
        getEditorText: () => "untouched draft",
        notify,
      },
    } as unknown as ExtensionContext;
    const clear = spyOn(globalThis, "clearInterval");
    try {
      const opened = shortcut!(ctx);
      component!.render(100);
      component!.handleInput!("p");
      expect(t.pause!.state).toBe("paused");
      expect(component!.render(100).join("\n")).toContain(
        "resume WHOLE ticket",
      );
      component!.handleInput!("p");
      expect(t.pause!.state).toBe("running");
      await shortcut!(ctx);
      expect(custom).toHaveBeenCalledTimes(1);
      component!.handleInput!("\x1b");
      await opened;
      expect(clear).toHaveBeenCalledTimes(1);
      expect(setEditorText).not.toHaveBeenCalled();
      history.update("sync", details(), false);
      const reopened = shortcut!(ctx);
      shutdown!();
      await reopened;
      expect(history.runs.size).toBe(0);
      expect(clear).toHaveBeenCalledTimes(2);
      await shortcut!({ ...ctx, mode: "rpc" });
      expect(custom).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      shutdown?.();
      clear.mockRestore();
    }
  });
});

import { afterEach, expect, test } from "bun:test";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  compositeTuiLine,
  ProcessTerminal,
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
// Pi exports this class as a type only at the package root. This is host
// fixture plumbing, not a Delegate internal or a production testing export.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

// Regression: bermudi's 2026-10-04 screenshot showed unframed activity
// interleaved visually with the conversation; 2026-10-08's verdict ("barely
// any space for a list of 50+… just spams tool calls") drove the #128
// two-pane redesign. Drive real dispatches and the registered /subagents
// command; capture its public custom-component output, not browser
// internals. The terminal fixture tests layout only; real-host checks are
// separate.

class BrowserTerminal extends ProcessTerminal {
  columnsValue = 100;
  rowsValue = 36;
  override get columns(): number { return this.columnsValue; }
  override get rows(): number { return this.rowsValue; }
  override write(_data: string): void {}
}

let session: TestSession | undefined;
let closeBrowser: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeBrowser?.();
  closeBrowser = undefined;
  session?.dispose();
  session = undefined;
});

async function openBrowser(): Promise<{
  component: Component;
  terminal: BrowserTerminal;
  render: () => string[];
  key: (data: string) => void;
  requests: () => number;
  close: () => Promise<void>;
}> {
  if (!session) throw new Error("Open a Delegate boundary first");
  const runner = (session.session as AgentSession).extensionRunner;
  const ui = runner.getUIContext();
  const terminal = new BrowserTerminal();
  const tui = new TuiMainScreen(terminal);
  let renderRequests = 0;
  tui.requestRender = () => { renderRequests++; };
  let component: Component | undefined;
  const custom: ExtensionUIContext["custom"] = async (factory, options) =>
    new Promise((resolve, reject) => {
      expect(options?.overlay).toBe(true);
      const layout = typeof options?.overlayOptions === "function"
        ? options.overlayOptions() : options?.overlayOptions;
      expect(layout?.width).toBe("100%");
      Promise.resolve(factory(tui, ui.theme, new KeybindingsManager(), resolve))
        .then((created) => { component = created; }, reject);
    });
  runner.setUIContext({ ...ui, custom }, "tui");
  const command = runner.getCommand("subagents");
  if (!command) throw new Error("/subagents was not registered");
  const pending = command.handler("", runner.createCommandContext());
  // The host's custom factory can be asynchronous.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!component) throw new Error("/subagents did not open a custom component");
  const browser = component;
  const close = async (): Promise<void> => {
    browser.handleInput?.("\x1b");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Esc did not close /subagents")), 1000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
  closeBrowser = close;
  return {
    component: browser,
    terminal,
    render: () => browser.render(terminal.columns),
    key: (data) => browser.handleInput?.(data),
    requests: () => renderRequests,
    close,
  };
}

function plain(lines: string[]): string[] {
  return lines.map(stripTerminalSequences);
}

function expectPanel(lines: string[], width: number, height: number): void {
  expect(lines).toHaveLength(height);
  expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  expect(lines.every((line) => !/[\r\n\t]/.test(line))).toBe(true);
  const text = plain(lines);
  expect(text[0]).toStartWith("╭");
  expect(text.at(-1)).toStartWith("╰");
  for (const line of text.slice(1, -1)) {
    expect(line).toStartWith("│ ");
    expect(line).toEndWith(" │");
  }
}

test("empty and resized panels have a complete opaque frame and preserve the editor draft", async () => {
  session = await openDelegateBoundary();
  const runner = (session.session as AgentSession).extensionRunner;
  // The harness's stock editor mock is stateless. Own a draft here so any
  // attempted replacement by the browser is an observable boundary write.
  let draft = "unfinished parent draft";
  let editorWrites = 0;
  runner.setUIContext({
    ...runner.getUIContext(),
    setEditorText: (text) => { draft = text; editorWrites++; },
    getEditorText: () => draft,
  }, "tui");
  const browser = await openBrowser();
  const lines = browser.render();
  expectPanel(lines, 100, 33);
  expect(plain(lines).join("\n")).toContain("No subagents yet");
  for (const line of lines) {
    // Real host compositor: no scraps of base conversation beside the frame.
    const base = "UNDERLYING".repeat(11);
    const composed = stripTerminalSequences(compositeTuiLine(base, line, 0, 100, 100));
    expect(composed).not.toContain("UNDERLYING");
  }
  browser.terminal.columnsValue = 32;
  browser.terminal.rowsValue = 12;
  const small = browser.render();
  expectPanel(small, 32, 11);
  expect(plain(small).join("\n")).toContain("Enlarge terminal");
  browser.key("p");
  browser.terminal.columnsValue = 100;
  browser.terminal.rowsValue = 36;
  expectPanel(browser.render(), 100, 33);
  browser.terminal.columnsValue = 40;
  browser.terminal.rowsValue = 20;
  const minimum = browser.render();
  expectPanel(minimum, 40, 18);
  expect(plain(minimum).join("\n")).toContain("Esc");
  browser.terminal.columnsValue = 2;
  browser.terminal.rowsValue = 1;
  expect(browser.render().every((line) => visibleWidth(line) <= 2)).toBe(true);
  await browser.close();
  expect(runner.getUIContext().getEditorText()).toBe("unfinished parent draft");
  expect(editorWrites).toBe(0);
});

test("the roster groups tickets, settles collapse by default, and expanding dives into the first task", async () => {
  session = await openDelegateBoundary();
  const subagents = await installSubagentModel(session);
  subagents.respond([fauxAssistantMessage("SEAM-ONE-RESULT")]);
  const dispatched = await callDelegate(session, {
    tasks: [{ prompt: "collapse probe prompt body" }],
    async: true,
  });
  const ticket = ticketIdOf(dispatched.text);
  await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
  const browser = await openBrowser();
  browser.render();
  // Settled ticket: one roster row (short id), no task rows, and the full
  // ticket id only ever appears in the detail column.
  let text = plain(browser.render());
  const shortId = ticket.slice(0, 10);
  expect(text.filter((line) => line.includes(shortId))).toHaveLength(1);
  expect(text.join("\n")).not.toContain("collapse probe prompt body");
  expect(text.join("\n")).toContain(`Ticket ${ticket}`);
  // Enter expands the group and lands on its first task.
  browser.key("\r");
  text = plain(browser.render());
  expect(text.filter((line) => line.includes(shortId)).length).toBeGreaterThanOrEqual(2);
  expect(text.join("\n")).toContain("collapse probe prompt body");
  expect(text.join("\n")).toContain("SEAM-ONE-RESULT");
  // Left collapses the group again and returns selection to the header.
  browser.key("\x1b[D");
  text = plain(browser.render());
  expect(text.filter((line) => line.includes(shortId))).toHaveLength(1);
});

test("the transcript interleaves narrative with tools, condenses paths, and folds repeats", async () => {
  session = await openDelegateBoundary();
  const subagents = await installSubagentModel(session);
  subagents.respond([
    fauxAssistantMessage([
      { type: "text", text: "Reading the stream module first." },
      fauxToolCall("read", { file_path: "/home/daniel/build/little-goblin/src/turn/stream.ts" }),
    ]),
    fauxAssistantMessage([
      { type: "text", text: "Now the repeated greps." },
      fauxToolCall("bash", { command: "grep -n LiveWire /home/daniel/build/little-goblin/src/turn/stream.ts" }),
      fauxToolCall("bash", { command: "grep -n LiveWire /home/daniel/build/little-goblin/src/turn/stream.ts" }),
    ]),
  ]);
  const dispatched = await callDelegate(session, {
    tasks: [{ prompt: "interleave probe" }],
    async: true,
  });
  const ticket = ticketIdOf(dispatched.text);
  await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
  const browser = await openBrowser();
  browser.render();
  browser.key("\r"); // expand + select the task
  const text = plain(browser.render()).join("\n");
  // Chronology, not two disconnected logs: text → tool → text → tool.
  const reading = text.indexOf("Reading the stream module first.");
  const readTool = text.indexOf("read  turn/stream.ts");
  const second = text.indexOf("Now the repeated greps.");
  const bashTool = text.indexOf("bash");
  expect(reading).toBeGreaterThanOrEqual(0);
  expect(readTool).toBeGreaterThan(reading);
  expect(second).toBeGreaterThan(readTool);
  expect(bashTool).toBeGreaterThan(second);
  // Absolute paths condense to their last two segments; identical
  // consecutive calls fold with a multiplier.
  expect(text).not.toContain("/home/daniel/build/little-goblin");
  expect(text).toContain("grep -n LiveWire turn/stream.ts ×2");
});

test("long tools occupy one scan row; Enter expands retained previews and Tab shows text", async () => {
  session = await openDelegateBoundary();
  const subagents = await installSubagentModel(session);
  const command = `printf '${"界".repeat(80)} PREVIEW-END'`;
  subagents.respond([
    fauxAssistantMessage([fauxToolCall("bash", { command })]),
    fauxAssistantMessage("RESPONSE-TEXT"),
  ]);
  const dispatched = await callDelegate(session, {
    tasks: [{ prompt: "Long command · 界界\nsecond prompt line\taligned\rend", tools: ["bash"] }],
    async: true,
  });
  const ticket = ticketIdOf(dispatched.text);
  await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
  const browser = await openBrowser();
  browser.render();
  browser.key("\r"); // expand the settled ticket and select the task
  const compact = browser.render();
  expectPanel(compact, 100, 33);
  const text = plain(compact);
  expect(text.filter((line) => line.includes("· bash"))).toHaveLength(1);
  expect(text.filter((line) => line.includes("界"))).toHaveLength(2); // prompt + one tool line
  expect(text.join("\n")).toContain("second prompt line aligned end");
  expect(text.join("\n")).not.toContain("PREVIEW-END");
  // The full ticket id lives in the detail column, never the roster.
  const rosterLines = text.slice(1, 4).map((line) => line.slice(0, 40));
  expect(rosterLines.join("\n")).not.toContain(ticket);
  expect(text.join("\n")).toContain(`Ticket ${ticket}`);

  browser.key("\r");
  browser.key("\x1b[H"); // oldest detail
  const expanded = browser.render();
  expectPanel(expanded, 100, 33);
  expect(plain(expanded).join("\n")).toContain("512-char previews");
  expect(plain(expanded).join("\n")).toContain("PREVIEW-END");
  browser.key("\t");
  const responses = plain(browser.render()).join("\n");
  expect(responses).toContain("RESPONSE-TEXT");
  expect(responses).not.toContain("· bash");
  expect(plain(browser.render()).at(-2)).toContain("Tab tools");
  expect(plain(browser.render()).at(-2)).not.toContain("Enter");
});

test("the roster shows the whole fleet, not a fixed-height window", async () => {
  session = await openDelegateBoundary();
  const subagents = await installSubagentModel(session);
  subagents.respond(Array.from({ length: 12 }, () => fauxAssistantMessage("done")));
  for (let index = 0; index < 12; index++) {
    await callDelegate(session, { async: false, tasks: [{ prompt: `fleet run ${index}` }] });
  }
  const browser = await openBrowser();
  browser.render();
  browser.key("\r"); // expand the retained inline group, land on a task
  const text = plain(browser.render());
  // Every retained run stays visible in one frame — the roster pane owns
  // the panel height instead of a capped window (#128's core complaint).
  const fleetRows = text.filter((line) => line.includes("✓ inline task-"));
  expect(fleetRows.length).toBeGreaterThanOrEqual(12);
  expect(text.join("\n")).not.toMatch(/↓ \d+ more/);
});

test("retained agents remain selectable; response scrollback and live-follow survive resize", async () => {
  session = await openDelegateBoundary();
  const subagents = await installSubagentModel(session);
  const response = Array.from({ length: 60 }, (_, i) => `LINE-${String(i).padStart(2, "0")}`).join("\n");
  subagents.respond([fauxAssistantMessage(response), fauxAssistantMessage("SECOND-RESULT")]);
  await callDelegate(session, { async: false, tasks: [{ prompt: "first retained task" }] });
  await callDelegate(session, { async: false, tasks: [{ prompt: "second retained task" }] });
  const browser = await openBrowser();
  browser.render();
  browser.key("\r"); // expand the inline group; selection lands on the newest run
  // Retained sync rows are newest first.
  browser.key("\x1b[B");
  browser.key("\t");
  let text = plain(browser.render()).join("\n");
  expect(text).toContain("first retained task");
  expect(text).toContain("LINE-59");
  browser.key("\x1b[H");
  text = plain(browser.render()).join("\n");
  expect(text).toContain("SCROLL");
  expect(text).toContain("LINE-00");
  expect(text).not.toContain("LINE-59");
  browser.key("\x1b[6~");
  expect(plain(browser.render()).join("\n")).not.toContain("LINE-00");
  browser.terminal.columnsValue = 64;
  browser.terminal.rowsValue = 24;
  expectPanel(browser.render(), 64, 22);
  browser.key("\x1b[F");
  expect(plain(browser.render()).join("\n")).toContain("LINE-59");
  browser.key("\x1b[A");
  expect(plain(browser.render()).join("\n")).toContain("SECOND-RESULT");
});

test("pause remains a whole-ticket action, and closing stops refresh callbacks", async () => {
  session = await openDelegateBoundary();
  const subagents = await installSubagentModel(session);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  subagents.respond([async () => {
    await gate;
    return fauxAssistantMessage("FINISHED");
  }]);
  const dispatched = await callDelegate(session, {
    tasks: [{ prompt: "live ticket" }],
    async: true,
  });
  const ticket = ticketIdOf(dispatched.text);
  try {
    const browser = await openBrowser();
    browser.render();
    browser.key("p");
    const paused = plain(browser.render()).join("\n");
    expect(paused).toMatch(/pausing|paused/);
    expect(paused).toContain("resume whole ticket (all its tasks)");
    browser.key("p");
    expect(plain(browser.render()).join("\n")).toContain("pause whole ticket (all its tasks)");
    const polled = await callDelegateTicket(session, { action: "poll", ticket });
    expect(polled.isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(browser.requests()).toBeGreaterThan(0);
    await browser.close();
    const count = browser.requests();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(browser.requests()).toBe(count);
  } finally {
    release();
    await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
  }
});

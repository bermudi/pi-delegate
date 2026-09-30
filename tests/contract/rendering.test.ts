import { afterEach, expect, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type {
  TestSession,
  ToolResultRecord,
} from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  configureDelegate,
  delegateTool,
  installSubagentModel,
  openDelegateBoundary,
  registeredTool,
  ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

/**
 * Expanded-view contract (SPEC "Output bounding" → "Recovery"): the
 * LLM-facing result text is spill-bounded, but a human expanding the
 * result sees the complete recorded output. Pi's stock renderers only
 * display `content`, so delegate registers a tool `renderResult` and a
 * `delegate-result` message renderer that re-render from
 * `details.results`. These tests drive the registered renderers through
 * the public boundary with a pass-through theme — the contract is which
 * text renders, not its color.
 */

interface RenderedComponent {
  render(width: number): string[];
}

interface ResultRenderingTool {
  renderResult(
    result: {
      content: { type: string; text?: string }[];
      details?: unknown;
    },
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: { lastComponent?: unknown },
  ): RenderedComponent;
}

interface CallRenderingTool {
  renderCall(
    args: unknown,
    theme: unknown,
    context: { lastComponent?: unknown },
  ): RenderedComponent;
}

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function renderToolResult(
  session: TestSession,
  result: ToolResultRecord,
  expanded: boolean,
): string {
  const tool = delegateTool(session) as unknown as ResultRenderingTool;
  return tool
    .renderResult(
      { content: result.content, details: result.details },
      { expanded, isPartial: false },
      plainTheme,
      { lastComponent: undefined },
    )
    // Wide enough that Text's word-wrap never splits a rendered output.
    .render(8192)
    .join("\n");
}

function renderToolCall(
  session: TestSession,
  toolName: string,
  args: unknown,
): string {
  const tool = registeredTool(session, toolName) as unknown as CallRenderingTool;
  return tool
    .renderCall(args, plainTheme, { lastComponent: undefined })
    .render(8192)
    // Text pads each rendered line to the requested width; the contract is
    // the content, not the trailing fill.
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

function gate(output: string) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage(output);
  };
  return { release, step };
}

let session: TestSession | undefined;

afterEach(() => {
  session?.dispose();
  session = undefined;
});

test(
  "an expanded sync result renders the complete output its content spilled",
  async () => {
    // SPEC "Recovery": the bounded text keeps a tail plus a file pointer;
    // the expanded view renders the whole recorded output from
    // details.results — no tail, no pointer, no spill file access.
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 100, spillTailChars: 30 },
    });
    const subagents = await installSubagentModel(session);
    const output = "H".repeat(300) + "T".repeat(40) + "TAILMARKER";
    subagents.respond([fauxAssistantMessage(output)]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "big" }],
    });
    expect(result.text).toContain("spilled to");

    // Collapsed is its own compact document (#63): one status-glyph line
    // per task plus an expand hint — the bounded content preview only
    // remains for results without recorded outcomes.
    const collapsed = renderToolResult(session, result, false);
    expect(collapsed).toContain("✓");
    expect(collapsed).toContain("… more");
    expect(collapsed.split("\n").length).toBeLessThanOrEqual(3);

    const expanded = renderToolResult(session, result, true);
    expect(expanded).toContain("### Task task-1");
    expect(expanded).toContain(output);
    expect(expanded).not.toContain("spilled to");
  },
);

test(
  "an expanded settled-ticket poll renders the whole recorded output",
  async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 100, spillTailChars: 30 },
    });
    const subagents = await installSubagentModel(session);
    const output = "Q".repeat(300) + "POLL-TAIL";
    subagents.respond([fauxAssistantMessage(output)]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "big" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.text).toContain("spilled to");

    const expanded = renderToolResult(session, settled, true);
    expect(expanded).toContain(`Ticket "${ticket}"`);
    expect(expanded).toContain(output);
    expect(expanded).not.toContain("spilled to");
  },
);

test(
  "an expanded poll on a running ticket shows recorded output whole",
  async () => {
    // A running ticket's poll bounds every recorded outcome to a tail for
    // the LLM; the human's expanded view still sees what is recorded whole.
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 100, spillTailChars: 30 },
    });
    const subagents = await installSubagentModel(session);
    const output = "R".repeat(300) + "RUNNING-TAIL";
    const blocked = gate("SECOND-TASK");
    subagents.respond([fauxAssistantMessage(output), blocked.step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "done-fast" }, { prompt: "blocked" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const deadline = Date.now() + 5000;
    let running: ToolResultRecord | undefined;
    for (;;) {
      running = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      if (running.text.includes("1/2")) break;
      if (Date.now() > deadline) {
        throw new Error("poll never reached 1/2 tasks finished");
      }
    }
    expect(running.text).toContain("truncated in this poll");
    expect(running.text).not.toContain("R".repeat(50));

    const expanded = renderToolResult(session, running, true);
    expect(expanded).toContain(output);

    blocked.release();
    await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
  },
);

test(
  "an expanded delivered message renders the complete outcome",
  async () => {
    // The delivered custom message carries the same details.results
    // recovery surface; its registered renderer shows it whole on expand.
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 100, spillTailChars: 30 },
    });
    const host = session.session as AgentSession;
    const subagents = await installSubagentModel(session);
    const output = "M".repeat(300) + "DELIVERY-TAIL";
    const blocked = gate(output);
    subagents.respond([blocked.step]);
    const sends = spyOn(host, "sendCustomMessage");

    await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    blocked.release();
    const deadline = Date.now() + 5000;
    while (sends.mock.calls.length === 0 && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(sends).toHaveBeenCalledTimes(1);
    const message = sends.mock.calls[0]![0] as never;
    expect(String((message as { content: unknown }).content)).toContain(
      "spilled to",
    );

    const renderer = host.extensionRunner.getMessageRenderer(
      "delegate-result",
    );
    expect(renderer).toBeDefined();
    // Collapsed renders the compact per-task view (#63): the
    // [delegate-result] label, the ticket header, and one status-glyph
    // line per task — never the model-facing content.
    const collapsed = renderer!(
      message,
      { expanded: false, outputPad: 0 },
      plainTheme as never,
    );
    expect(collapsed).toBeDefined();
    const collapsedText = collapsed!
      .render(8192)
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n");
    expect(collapsedText).toContain("[delegate-result]");
    expect(collapsedText).toMatch(/ticket t-[0-9a-f]{8} · completed 1\/1/);
    expect(collapsedText).toContain("✓");
    expect(collapsedText).not.toContain(output);

    const component = renderer!(
      message,
      { expanded: true, outputPad: 0 },
      plainTheme as never,
    );
    expect(component).toBeDefined();
    const text = component!.render(8192).join("\n");
    expect(text).toContain("delegate-result");
    expect(text).toContain(output);
    expect(text).not.toContain("spilled to");
  },
);

test(
  "results without recorded outcomes fall back to their content when expanded",
  async () => {
    // Help/session/async-created results carry no details.results; the
    // expanded view renders their content whole rather than nothing.
    session = await openDelegateBoundary();

    const help = await callDelegate(session, { async: false, tasks: [] });
    const expanded = renderToolResult(session, help, true);
    expect(expanded).toContain("Delegate Manual");
  },
);

test(
  "the delegate call row is a static count plus up to four prompt previews",
  async () => {
    // Work-order §3d.8 + #63: `delegate N tasks`, one line per task
    // showing its label — description, then caller id, then agent, then
    // `inline` (compact callers cannot set ids, so a positional task-N is
    // noise) — and the first ~60 chars of its prompt, `… and K more`
    // past four, `delegate manual` for an empty list — and deliberately
    // static: no spinner, timers, or live state.
    session = await openDelegateBoundary();
    const render = (args: unknown) => renderToolCall(session!, "delegate", args);

    expect(render({ tasks: [] })).toBe("delegate manual");
    expect(render({ tasks: [{ prompt: "hello world" }] })).toBe(
      "delegate 1 task\n  inline  hello world",
    );
    // A caller-provided id replaces the fallback label; agent labels
    // compact tasks; description wins over both.
    expect(render({ tasks: [{ id: "alpha", prompt: "x" }] })).toBe(
      "delegate 1 task\n  alpha  x",
    );
    expect(render({ tasks: [{ agent: "scout", prompt: "x" }] })).toBe(
      "delegate 1 task\n  scout  x",
    );
    expect(
      render({
        tasks: [{ id: "alpha", agent: "scout", description: "scan the tree", prompt: "x" }],
      }),
    ).toBe("delegate 1 task\n  scan the tree  x");
    const four = render({
      tasks: [1, 2, 3, 4].map((n) => ({ prompt: `prompt ${n}` })),
    });
    expect(four).toContain("delegate 4 tasks");
    expect(four).toContain("  inline  prompt 4");
    expect(four).not.toContain("… and");
    // Labels pad to a common width so prompt previews align.
    const padded = render({
      tasks: [
        { id: "a", prompt: "first" },
        { id: "longer-label", prompt: "second" },
      ],
    });
    const paddedLines = padded.split("\n");
    expect(paddedLines[1]).toMatch(/^  a\s+  first$/);
    expect(paddedLines[2]).toMatch(/^  longer-label  second$/);
    const six = render({
      tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ prompt: `prompt ${n}` })),
    });
    expect(six).toContain("  … and 2 more");
    expect(six).not.toContain("prompt 5");
    // A ~60-char preview with an ellipsis; long prompts stay one line.
    const long = render({ tasks: [{ prompt: "p".repeat(200) }] });
    const previewLine = long.split("\n")[1]!;
    expect(previewLine.length).toBeLessThanOrEqual(2 + 16 + 2 + 60);
    expect(previewLine).toContain("…");
    // A resume-only task shows its revival tag instead of a prompt.
    const resumed = render({
      tasks: [{ resumeFrom: "/tmp/x/sess_ab12cd34ef.jsonl" }],
    });
    expect(resumed).toContain("↻ab12cd34");
  },
);

test(
  "delegate_ticket and delegate_session call rows are static one-liners",
  async () => {
    // Same issue as the delegate call row: the slot names the operation
    // and its target without spinners or live state. Ticket ids shorten
    // in display only (#63): `t-<uuid>` renders as `t-<first 8 hex>`,
    // compound <ticket>#<task> targets shorten the ticket part, and
    // non-ticket-shaped ids pass through.
    session = await openDelegateBoundary();
    expect(
      renderToolCall(session, "delegate_ticket", {
        action: "poll",
        ticket: "t-abc123",
      }),
    ).toBe("delegate_ticket poll #t-abc123");
    expect(
      renderToolCall(session, "delegate_ticket", {
        action: "wait",
        ticket: "t-81a83dbe-1234-5678-9abc-def012345678",
      }),
    ).toBe("delegate_ticket wait #t-81a83dbe");
    expect(
      renderToolCall(session, "delegate_ticket", {
        action: "steer",
        ticket: "t-81a83dbe-1234-5678-9abc-def012345678",
        taskId: "task-1",
      }),
    ).toBe("delegate_ticket steer #t-81a83dbe#task-1");
    // A compound taskId carries its own ticket (#53).
    expect(
      renderToolCall(session, "delegate_ticket", {
        action: "interrupt",
        taskId: "t-ffffffff-0000-1111-2222-333344445555#task-2",
      }),
    ).toBe("delegate_ticket interrupt #t-ffffffff#task-2");
    expect(
      renderToolCall(session, "delegate_session", {
        action: "close",
        sessionId: "s-9",
      }),
    ).toBe("delegate_session close #s-9");
    expect(renderToolCall(session, "delegate_session", { action: "list" })).toBe(
      "delegate_session list",
    );
  },
);

function renderSyntheticResult(
  session: TestSession,
  details: unknown,
  content = "",
): string {
  const tool = delegateTool(session) as unknown as ResultRenderingTool;
  return tool
    .renderResult(
      { content: [{ type: "text", text: content }], details },
      { expanded: false, isPartial: false },
      plainTheme,
      { lastComponent: undefined },
    )
    .render(8192)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

test(
  "a collapsed sync dispatch renders one status-glyph line per task",
  async () => {
    // #63: the collapsed view is its own document — icon, label, first
    // output line (markdown markers stripped), file/integration meta —
    // not a preview of the model-facing text. Labels come from the sync
    // details' tasks entries: description, then agent, then id.
    session = await openDelegateBoundary();
    const collapsed = renderSyntheticResult(session, {
      mode: "dispatch",
      async: false,
      tasks: [
        { id: "a", status: "ok", agent: "scout", description: "scan docs" },
        { id: "b", status: "failed", agent: "coder" },
        { id: "c", status: "cancelled" },
        { id: "d", status: "blocked" },
      ],
      results: [
        { index: 0, id: "a", status: "ok", retries: 0, output: "# Summary\nEverything green" },
        { index: 1, id: "b", status: "failed", retries: 0, error: "boom" },
        { index: 2, id: "c", status: "cancelled", retries: 0 },
        { index: 3, id: "d", status: "blocked", retries: 0, blockedBy: ["a"] },
      ],
    });
    const lines = collapsed.split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("✓ scan docs  Summary");
    expect(lines[1]).toBe("✗ coder  boom");
    expect(lines[2]).toBe("⊘ c  cancelled");
    expect(lines[3]).toBe("⊘ d  blocked");
    expect(collapsed).toContain("… more");
  },
);

test(
  "a collapsed ticket poll renders the ticket header and running slots",
  async () => {
    // #63: a live ticket's poll collapses to its header —
    // `ticket t-<8> · <status> <done>/<total>` — plus one line per task;
    // unsettled slots render ○ running. Labels come from the ticket's
    // task records.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const blocked = gate("LATE");
    subagents.respond([fauxAssistantMessage("FIRST-DONE"), blocked.step]);

    const dispatched = await callDelegate(session, {
      tasks: [
        { prompt: "fast", agent: "explore" },
        { prompt: "slow", agent: "coder" },
      ],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const deadline = Date.now() + 5000;
    let running: ToolResultRecord | undefined;
    for (;;) {
      running = await callDelegateTicket(session, { action: "poll", ticket });
      if (running.text.includes("1/2")) break;
      if (Date.now() > deadline) {
        throw new Error("poll never reached 1/2 tasks finished");
      }
    }
    const collapsed = renderToolResult(session, running, false);
    expect(collapsed).toContain(
      `ticket ${ticket.slice(0, 10)} · running 1/2`,
    );
    expect(collapsed).toContain("✓ explore  FIRST-DONE");
    expect(collapsed).toContain("○ coder  running");
    // Display-only shortening: the model-facing text keeps the full id.
    expect(running.text).toContain(ticket);

    blocked.release();
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    const settledCollapsed = renderToolResult(session, settled, false);
    expect(settledCollapsed).toContain("· completed 2/2");
    expect(settledCollapsed).toContain("✓ coder  LATE");
  },
);

test(
  "an async dispatch receipt collapses to one line",
  async () => {
    // #63: the ticket-creation result is a single receipt line —
    // background ticket id (short), task count, auto-delivery — with the
    // expand hint keeping notices reachable.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const blocked = gate("BG");
    subagents.respond([blocked.step]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "bg" }, { prompt: "bg2" }],
      async: true,
    });
    const collapsed = renderToolResult(session, result, false);
    const lines = collapsed.split("\n").filter((line) => line !== "");
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toMatch(
      /^↳ background ticket t-[0-9a-f]{8} · 2 tasks · results arrive automatically/,
    );
    expect(lines[0]).toContain("… more");

    blocked.release();
  },
);

test(
  "receipts and rosters collapse to their first line plus an expand hint",
  async () => {
    // #63: results without task outcomes (session list, cancel receipts)
    // show a bounded first line — the model-facing text is expanded only.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const blocked = gate("PENDING");
    subagents.respond([blocked.step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const preview = await callDelegateTicket(session, {
      action: "cancel",
      ticket,
    });
    const collapsed = renderToolResult(session, preview, false);
    const lines = collapsed.split("\n").filter((line) => line !== "");
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toContain(`Ticket "${ticket}" is running`);

    blocked.release();
    await callDelegateTicket(session, {
      action: "cancel",
      ticket,
      force: true,
    });
  },
);

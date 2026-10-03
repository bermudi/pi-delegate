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
    context: { lastComponent?: unknown; isError?: boolean },
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
    // noise) — and the first ~86 chars of its prompt (cut at a word
    // boundary), `… and K more` past four, `delegate manual` for an empty
    // list — and deliberately static: no spinner, timers, or live state.
    session = await openDelegateBoundary();
    const render = (args: unknown) => renderToolCall(session!, "delegate", args);

    expect(render({ tasks: [] })).toBe("delegate manual");
    expect(render({ tasks: [{ prompt: "hello world" }] })).toBe(
      "delegate 1 task\n  ▸ inline  hello world",
    );
    // A caller-provided id replaces the fallback label; agent labels
    // compact tasks; description wins over both.
    expect(render({ tasks: [{ id: "alpha", prompt: "x" }] })).toBe(
      "delegate 1 task\n  ▸ alpha  x",
    );
    expect(render({ tasks: [{ agent: "scout", prompt: "x" }] })).toBe(
      "delegate 1 task\n  ▸ scout  x",
    );
    expect(
      render({
        tasks: [{ id: "alpha", agent: "scout", description: "scan the tree", prompt: "x" }],
      }),
    ).toBe("delegate 1 task\n  ▸ scan the tree  x");
    const four = render({
      tasks: [1, 2, 3, 4].map((n) => ({ prompt: `prompt ${n}` })),
    });
    expect(four).toContain("delegate 4 tasks");
    expect(four).toContain("  ▸ inline  prompt 4");
    expect(four).not.toContain("… and");
    // Labels pad to a common width so prompt previews align.
    const padded = render({
      tasks: [
        { id: "a", prompt: "first" },
        { id: "longer-label", prompt: "second" },
      ],
    });
    const paddedLines = padded.split("\n");
    expect(paddedLines[1]).toMatch(/^  ▸ a\s+  first$/);
    expect(paddedLines[2]).toMatch(/^  ▸ longer-label  second$/);
    const six = render({
      tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ prompt: `prompt ${n}` })),
    });
    expect(six).toContain("  … and 2 more");
    expect(six).not.toContain("prompt 5");
    // A ~86-char preview with an ellipsis; long prompts stay one line.
    const long = render({ tasks: [{ prompt: "p".repeat(200) }] });
    const previewLine = long.split("\n")[1]!;
    expect(previewLine.length).toBeLessThanOrEqual(2 + 16 + 2 + 86);
    expect(previewLine).toContain("…");
    // The cut lands between words when the prompt has them.
    const words = render({ tasks: [{ prompt: "alpha ".repeat(30) }] });
    expect(words.split("\n")[1]).toMatch(/alpha…$/);
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
    // #63: the ticket-creation result is a single pointer line — short
    // ticket id, dispatched to background (the call row already carries
    // the task count; expansion reveals delivery detail) — with the
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
      /^↳ ticket t-[0-9a-f]{8} · dispatched to background/,
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
    // Display-only shortening (#63): the receipt's ticket id renders as
    // `t-<first 8 hex>`; the model-facing text keeps the full id.
    expect(lines[0]).toContain(`Ticket "${ticket.slice(0, 10)}" is running`);
    expect(preview.text).toContain(ticket);

    blocked.release();
    await callDelegateTicket(session, {
      action: "cancel",
      ticket,
      force: true,
    });
  },
);

test(
  "a collapsed task line skips colon lead-ins and strips emphasis",
  async () => {
    // #63 rework: filler openers ("Here's my report:") are skipped for the
    // first non-lead-in line among the first five, and `**`/`__` emphasis
    // markers never leak into the summary.
    session = await openDelegateBoundary();
    const collapsed = renderSyntheticResult(session, {
      mode: "dispatch",
      async: false,
      results: [
        {
          index: 0,
          id: "a",
          status: "ok",
          retries: 0,
          output:
            "All checks are complete. Here's my report:\n" +
            "Findings below:\n" +
            "**Result:** the __fix__ landed cleanly",
        },
      ],
    });
    expect(collapsed).toContain("✓ a  Result: the fix landed cleanly");
    expect(collapsed).not.toContain("Here's my report");
    expect(collapsed).not.toContain("**");
    expect(collapsed).not.toContain("__");

    // Five-plus lead-ins exhaust the window: the first line is the fallback.
    const fallback = renderSyntheticResult(session, {
      mode: "dispatch",
      async: false,
      results: [
        {
          index: 0,
          id: "a",
          status: "ok",
          retries: 0,
          output:
            "one:\ntwo:\nthree:\nfour:\nfive:\nsix: the actual content",
        },
      ],
    });
    expect(fallback).toContain("one:");
  },
);

test(
  "a collapsed task line appends the verifier verdict to its meta",
  async () => {
    // #63 rework: outcome.verdict renders as ` · VERDICT <value>` — PASS
    // success-green, FAIL error-red, AMBIGUOUS warning — beside the file
    // count and integration spans.
    session = await openDelegateBoundary();
    const collapsed = renderSyntheticResult(session, {
      mode: "dispatch",
      async: false,
      results: [
        { index: 0, id: "a", status: "ok", retries: 0, output: "done", verdict: "PASS", attributedFiles: ["x.ts"] },
        { index: 1, id: "b", status: "ok", retries: 0, output: "done", verdict: "FAIL" },
        { index: 2, id: "c", status: "ok", retries: 0, output: "done", verdict: "AMBIGUOUS" },
      ],
    });
    expect(collapsed).toContain("✓ a  done · 1 file · VERDICT PASS");
    expect(collapsed).toContain("✓ b  done · VERDICT FAIL");
    expect(collapsed).toContain("✓ c  done · VERDICT AMBIGUOUS");

    // The color mapping is contract: tag the theme to observe it. An
    // unevidenced PASS is not a clean green — the expanded `verdict:`
    // line calls it unverifiable, and the collapsed tag must not drop
    // that qualification (#49/#63 honesty).
    const tagTheme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const tool = delegateTool(session) as unknown as ResultRenderingTool;
    const tagged = tool
      .renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: {
            mode: "dispatch",
            async: false,
            results: [
              { index: 0, id: "a", status: "ok", retries: 0, output: "x", verdict: "PASS", attributedFiles: ["x.ts"] },
              { index: 1, id: "b", status: "ok", retries: 0, output: "x", verdict: "FAIL" },
              { index: 2, id: "c", status: "ok", retries: 0, output: "x", verdict: "AMBIGUOUS" },
              { index: 3, id: "d", status: "ok", retries: 0, output: "x", verdict: "PASS" },
            ],
          },
        },
        { expanded: false, isPartial: false },
        tagTheme,
        { lastComponent: undefined },
      )
      .render(8192)
      .join("\n");
    expect(tagged).toContain("<success> · VERDICT PASS</success>");
    expect(tagged).toContain("<error> · VERDICT FAIL — not corroborated</error>");
    expect(tagged).toContain("<warning> · VERDICT AMBIGUOUS</warning>");
    expect(tagged).toContain("<warning> · VERDICT PASS — unverifiable</warning>");
  },
);

test(
  "an unsettled slot without labels falls back to its positional task id",
  async () => {
    // #63 rework: a running ticket slot whose task record carries neither
    // description nor agent rendered as the bare `task`; it now names its
    // position — `task-2` for the second slot.
    session = await openDelegateBoundary();
    const collapsed = renderSyntheticResult(session, {
      mode: "dispatch",
      async: false,
      results: [
        { index: 0, id: "a", status: "ok", retries: 0, output: "done" },
        null,
      ],
    });
    const lines = collapsed.split("\n").filter((line) => line !== "");
    expect(lines[0]).toContain("✓ a  done");
    expect(lines[1]).toContain("○ task-2  running");
    expect(lines[1]).not.toContain("○ task  ");
  },
);

test(
  "a collapsed roster poll lists entry lines with shortened ids",
  async () => {
    // #63 rework: the roster shows up to five `- "<id>" …` entries with
    // display-shortened ticket ids, `… and N more` past that, and the
    // session-scope note a #64 roster appends — not the bare "Tickets:".
    session = await openDelegateBoundary();
    const entry = (hex: string, status: string) =>
      `- "t-${hex}-36ca-422d-a98f-1ee3906ee83e" ${status} — 2/2 tasks finished`;
    const collapsed = renderSyntheticResult(
      session,
      { mode: "ticket" },
      [
        "Tickets:",
        ...["81a83dbe", "22222222", "33333333", "44444444", "55555555", "66666666"].map(
          (hex) => entry(hex, "completed"),
        ),
        "(1 ticket(s) from other sessions not shown; poll one by id to read it.)",
      ].join("\n"),
    );
    const lines = collapsed.split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe('- "t-81a83dbe" completed — 2/2 tasks finished');
    expect(lines[4]).toContain('"t-55555555"');
    expect(lines[5]).toContain("… and 1 more");
    expect(lines[6]).toContain("(1 ticket(s) from other sessions not shown");
    expect(collapsed).not.toContain("Tickets:");
    expect(collapsed).not.toContain("36ca-422d");
  },
);

test(
  "a collapsed help result renders only the expand hint",
  async () => {
    // #63 rework: the call row already says "delegate manual" — the
    // collapsed result is the hint alone, not a second "manual" label.
    session = await openDelegateBoundary();
    const collapsed = renderSyntheticResult(session, { mode: "help" }, "text");
    expect(collapsed.trim()).toMatch(/^\(.*to read\)$/);
    expect(collapsed).not.toContain("manual");
  },
);

test(
  "terminal-control sequences in worker text never reach the display",
  async () => {
    // pi-tui writes rendered text to the terminal verbatim — a clear-screen
    // (ESC[2J) or clipboard write (OSC 52) inside a task output, error,
    // question, or call argument would execute against the user's
    // terminal. Every surface strips C0/C1 controls before display.
    session = await openDelegateBoundary();
    const hostile =
      "report\x1b[2J\x1b[H done\x1b]52;c;aGVsbG8=\x07 and \x9b31m red";
    const collapsed = renderSyntheticResult(session, {
      mode: "dispatch",
      async: false,
      results: [
        { index: 0, id: "a", status: "ok", retries: 0, output: hostile },
        { index: 1, id: "b", status: "failed", retries: 0, error: `${hostile} broke` },
      ],
      notices: [`notice ${hostile}`],
      questions: [{ taskId: "b", id: "q-1", question: hostile }],
      note: `note ${hostile}`,
    });
    expect(collapsed).toContain("report");
    expect(collapsed).not.toContain("\x1b");
    expect(collapsed).not.toContain("\x9b");

    const tool = delegateTool(session) as unknown as ResultRenderingTool;
    const expanded = tool
      .renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: {
            mode: "dispatch",
            async: false,
            results: [
              { index: 0, id: "a", status: "ok", retries: 0, output: hostile },
            ],
          },
        },
        { expanded: true, isPartial: false },
        plainTheme,
        { lastComponent: undefined },
      )
      .render(8192)
      .join("\n");
    expect(expanded).toContain("report");
    expect(expanded).not.toContain("\x1b");

    // Call rows sanitize too — the model's own arguments are untrusted.
    const call = renderToolCall(session, "delegate", {
      tasks: [{ prompt: `p ${hostile}`, id: `id\x1b[2J` }],
    });
    expect(call).not.toContain("\x1b");
  },
);

test(
  "an error result still renders the collapsed per-task view",
  async () => {
    // A failed multi-task dispatch carries details.results — gating the
    // collapsed view on isError fell back to a 10-line truncation that hid
    // every task past the first few. Replay renders through the same path.
    session = await openDelegateBoundary();
    const tool = delegateTool(session) as unknown as ResultRenderingTool;
    const collapsed = tool
      .renderResult(
        {
          content: [{ type: "text", text: "Ticket spilled a long view" }],
          details: {
            mode: "dispatch",
            async: false,
            results: [
              { index: 0, id: "a", status: "ok", retries: 0, output: "first done" },
              { index: 1, id: "b", status: "failed", retries: 0, error: "second blew up" },
              { index: 2, id: "c", status: "failed", retries: 0, error: "third blew up too" },
            ],
          },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        { lastComponent: undefined, isError: true },
      )
      .render(8192)
      .join("\n");
    expect(collapsed).toContain("✓ a  first done");
    expect(collapsed).toContain("✗ b  second blew up");
    expect(collapsed).toContain("✗ c  third blew up too");
  },
);

test(
  "a collapsed wait carries its tail note, pending questions, and notices",
  async () => {
    // The wait view's suffix — timeout, detached roster, pending question —
    // lived only in the model-facing text. The collapsed ticket view must
    // show it too, from the details half.
    session = await openDelegateBoundary();
    const collapsed = renderSyntheticResult(session, {
      mode: "ticket",
      action: "wait",
      ticket: "t-81a83dbe-1234-5678-9abc-def012345678",
      results: [
        { index: 0, id: "a", status: "ok", retries: 0, output: "done" },
      ],
      notices: ["two writers serialized"],
      questions: [
        { taskId: "task-2", id: "q-1", question: "which environment?" },
      ],
      note: 'Resolved on the first watched ticket to settle — still running: "t-22222222-0000-1111-2222-333344445555" (running, 0/1 tasks finished).',
    });
    expect(collapsed).toContain("✓ a  done");
    expect(collapsed).toContain("two writers serialized");
    expect(collapsed).toContain("waiting on answer");
    expect(collapsed).toContain("t-81a83dbe#task-2");
    expect(collapsed).toContain("which environment?");
    expect(collapsed).toContain("still running:");
    expect(collapsed).toContain("t-22222222");
    expect(collapsed).not.toContain("t-22222222-0000");
  },
);

test(
  "a cancelled ticket's missing outcome reads cancelled, not running",
  async () => {
    // A terminal ticket's unrecorded slot is not "running" — the ticket's
    // own status words it.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const blocked = gate("NEVER-DELIVERED");
    subagents.respond([blocked.step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "hold", agent: "coder" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegateTicket(session, { action: "cancel", ticket, force: true });
    blocked.release();

    const settled = await callDelegateTicket(session, { action: "poll", ticket });
    const collapsed = renderToolResult(session, settled, false);
    expect(collapsed).toContain("· cancelled");
    expect(collapsed).toContain("⊘");
    expect(collapsed).not.toContain("running");
  },
);

test(
  "a coalesced delivery with a store-missed ticket falls back to merged outcomes",
  async () => {
    // details.tickets renders per-ticket only when EVERY id resolves —
    // a partial miss used to render the resolved tickets and silently drop
    // the missing one's tasks (including failures). The recorded merged
    // results are the fallback, like the expanded view's rule.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const blocked = gate("DONE");
    subagents.respond([blocked.step]);
    const host = session.session as AgentSession;

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "one" }],
      async: true,
    });
    const live = ticketIdOf(dispatched.text);
    blocked.release();
    await callDelegateTicket(session, { action: "wait", ticket: live, timeoutMs: 5000 });

    const renderer = host.extensionRunner.getMessageRenderer("delegate-result")!;
    const message = {
      customType: "delegate-result",
      content: "coalesced",
      details: {
        tickets: [live, "t-00000000-0000-0000-0000-000000000000"],
        originLeafIds: [null, null],
        results: [
          { index: 0, id: "one", status: "ok", retries: 0, output: "DONE" },
          { index: 0, id: "lost-task", status: "failed", retries: 0, error: "lost failure" },
        ],
      },
    };
    const collapsed = renderer(message as never, { expanded: false, outputPad: 0 }, plainTheme as never)!;
    const text = collapsed.render(8192).map((line) => line.replace(/\s+$/, "")).join("\n");
    expect(text).toContain("lost-task");
    expect(text).toContain("lost failure");
    // All-or-nothing: no per-ticket header when one id missed the store.
    expect(text).not.toContain("· completed 1/1");
  },
);

test(
  "a collapsed file count keeps the unknown-shell mark",
  async () => {
    // `· N files` beside a task that ran an uncovered shell understates
    // the evidence surface — the expanded `files:` line says
    // `unknown (shell used outside git)`; the collapsed meta must not
    // drop it.
    session = await openDelegateBoundary();
    const collapsed = renderSyntheticResult(session, {
      mode: "dispatch",
      async: false,
      results: [
        { index: 0, id: "a", status: "ok", retries: 0, output: "done", attributedFiles: ["x.ts"], uncertainFiles: true },
        { index: 1, id: "b", status: "ok", retries: 0, output: "done", uncertainFiles: true },
      ],
    });
    expect(collapsed).toContain("✓ a  done · 1 file · unknown shell");
    expect(collapsed).toContain("✓ b  done · unknown shell");
  },
);

test(
  "a collapsed roster keeps each entry's warning and question sub-lines",
  async () => {
    // Roster entries can carry indented warning/question lines — dropping
    // them hides exactly the signals a poll exists to surface.
    session = await openDelegateBoundary();
    const collapsed = renderSyntheticResult(
      session,
      { mode: "ticket" },
      [
        "Tickets:",
        '- "t-81a83dbe-36ca-422d-a98f-1ee3906ee83e" running — 1/2 tasks finished',
        "  waiting for answer: t-81a83dbe-36ca-422d-a98f-1ee3906ee83e#task-2 (q-1): pick an env",
        '- "t-22222222-36ca-422d-a98f-1ee3906ee83e" interrupted — 0/1 tasks finished',
        "  This run stopped without a final record.",
      ].join("\n"),
    );
    expect(collapsed).toContain('- "t-81a83dbe" running');
    expect(collapsed).toContain("waiting for answer: t-81a83dbe#task-2");
    expect(collapsed).toContain("stopped without a final record");
  },
);

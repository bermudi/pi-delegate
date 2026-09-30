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

    const collapsed = renderToolResult(session, result, false);
    expect(collapsed).toContain("spilled to");
    expect(collapsed).not.toContain("H".repeat(50));

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
    // Collapsed defers to the host's default custom-message chrome.
    expect(
      renderer!(
        message,
        { expanded: false, outputPad: 0 },
        plainTheme as never,
      ),
    ).toBeUndefined();

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
    // Work-order §3d.8: `delegate N tasks`, one line per task showing its
    // id-or-index and the first ~60 chars of its prompt, `… and K more`
    // past four, `delegate manual` for an empty list — and deliberately
    // static: no spinner, timers, or live state.
    session = await openDelegateBoundary();
    const render = (args: unknown) => renderToolCall(session!, "delegate", args);

    expect(render({ tasks: [] })).toBe("delegate manual");
    expect(render({ tasks: [{ prompt: "hello world" }] })).toBe(
      "delegate 1 task\n  task-1  hello world",
    );
    // A caller-provided id replaces the positional label.
    expect(render({ tasks: [{ id: "alpha", prompt: "x" }] })).toBe(
      "delegate 1 task\n  alpha  x",
    );
    const four = render({
      tasks: [1, 2, 3, 4].map((n) => ({ prompt: `prompt ${n}` })),
    });
    expect(four).toContain("delegate 4 tasks");
    expect(four).toContain("  task-4  prompt 4");
    expect(four).not.toContain("… and");
    const six = render({
      tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ prompt: `prompt ${n}` })),
    });
    expect(six).toContain("  … and 2 more");
    expect(six).not.toContain("prompt 5");
    // A ~60-char preview with an ellipsis; long prompts stay one line.
    const long = render({ tasks: [{ prompt: "p".repeat(200) }] });
    const previewLine = long.split("\n")[1]!;
    expect(previewLine.length).toBeLessThanOrEqual(2 + 6 + 2 + 60);
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
    // and its target without spinners or live state.
    session = await openDelegateBoundary();
    expect(
      renderToolCall(session, "delegate_ticket", {
        action: "poll",
        ticket: "t-abc123",
      }),
    ).toBe("delegate_ticket poll #t-abc123");
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

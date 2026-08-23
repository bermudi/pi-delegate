import { Box, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  fmtDuration,
  spinnerFrame,
  getTermWidth,
  truncLine,
  applyLineBudget,
  compactActivity,
} from "./format.ts";
import {
  renderPartialBranch,
  renderFinalBranch,
  type RenderState,
  type RenderHelpers,
} from "./render-branches.ts";
import type { DelegateDetails, TaskProgress } from "./types.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./utils.ts";

/** Build the shared helpers bound to a theme, width, and the lines sink.
 *  Both render branches consume one bound set so warning/activity formatting
 *  stays consistent across the partial and final views. */
function makeRenderHelpers(
  theme: Theme,
  w: number,
  lines: string[],
): RenderHelpers {
  const statJoin = (parts: string[]) =>
    parts.length ? theme.fg("dim", ` · ${parts.join(" · ")}`) : "";
  const modelLabel = (p: TaskProgress) => {
    const model = p.model ? sanitizeTerminalLine(p.model) : "";
    return model ? theme.fg("dim", ` · ${model}`) : "";
  };

  // Push muted warning lines for a task under its status row. Rendered in
  // both partial and final views so a human watching the TUI sees that tools
  // were silently dropped — the LLM already gets this in `content`.
  const pushWarnings = (p: TaskProgress, ind: string) => {
    if (!p.warnings?.length) return;
    for (const wn of p.warnings) {
      const warning = sanitizeTerminalLine(wn);
      if (warning) {
        lines.push(
          truncLine(`${ind}${theme.fg("warning", `⚠ ${warning}`)}`, w),
        );
      }
    }
  };

  return {
    statJoin,
    modelLabel,
    compactActivity: (p) => sanitizeTerminalLine(compactActivity(p)),
    pushWarnings,
  };
}

/** Minimal structural view of Pi's `ToolRenderContext` used by the delegate
 *  renderers. The real context is wider; we only depend on these fields. */
interface RenderCtx {
  state: RenderState;
  lastComponent: unknown;
  invalidate: () => void;
  executionStarted: boolean;
  isPartial: boolean;
  /** Message renderers own their horizontal padding; tool renderers do not. */
  outputPad?: number;
  /** Width already consumed by an outer shell such as the async result box. */
  widthInset?: number;
  /** Standalone custom messages do not need the tool-result leading spacer. */
  standalone?: boolean;
}

interface RenderResultOptions {
  isPartial: boolean;
  expanded: boolean;
}

/** Minimal structural view of `AgentToolResult<DelegateDetails>` for rendering.
 *  `content` items are loosely typed — Pi may include image parts that lack
 *  `text`, which we simply filter out. */
interface RenderResult {
  content?: Array<{ type: string; text?: string }>;
  details?: DelegateDetails;
}

interface AsyncDelegateMessage {
  content: string | Array<{ type: string; text?: string }>;
  details?: DelegateDetails;
}

interface AsyncMessageRenderOptions {
  expanded: boolean;
}

/** Custom rendering for the tool *call* display — minimal by design; the result
 *  renderer shows all detail. Only animates a spinner while still running. */
export function renderDelegateCall(
  args: { tasks?: unknown },
  theme: Theme,
  ctx: RenderCtx,
): Text {
  const state = ctx.state;
  const rawTasks = args.tasks;
  const tasks = Array.isArray(rawTasks) ? rawTasks : [];
  const text =
    (ctx.lastComponent as Text | undefined) ??
    new Text("", ctx.outputPad ?? 0, 0);
  if (typeof rawTasks === "string") {
    text.setText(theme.fg("toolTitle", theme.bold("delegate invalid tasks")));
    return text;
  }
  if (!tasks.length) {
    text.setText(theme.fg("toolTitle", theme.bold("delegate")));
    return text;
  }
  // Minimal call rendering — renderResult handles all detail.
  // ToolExecutionComponent stacks call + result, so duplication
  // happens if both show task trees.
  // Only show spinner while still running (ctx.isPartial).
  if (ctx.executionStarted && ctx.isPartial) {
    if (state.startedAt === undefined) state.startedAt = Date.now();
    const elapsed = fmtDuration(Date.now() - state.startedAt);
    text.setText(
      theme.fg(
        "toolTitle",
        theme.bold(
          `${spinnerFrame()} delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""} · ${elapsed}`,
        ),
      ),
    );
    return text;
  }
  text.setText(
    theme.fg(
      "toolTitle",
      theme.bold(`delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""}`),
    ),
  );
  return text;
}

/** Custom rendering for the tool *result* display — delegates the heavy
 *  lifting (progress trees, activity lines, output previews, markdown) to the
 *  partial/final branch renderers. Owns only the spinner-interval lifecycle,
 *  the no-progress fallback, and the line-budget pass. */
export function renderDelegateResult(
  result: RenderResult,
  options: RenderResultOptions,
  theme: Theme,
  ctx: RenderCtx,
): Text {
  const state = ctx.state;
  // Use a faster animation cadence for spinner (80ms) vs the old 1s
  const tickMs = 80;
  if (options.isPartial && !state.interval)
    state.interval = setInterval(() => ctx.invalidate(), tickMs);
  if (!options.isPartial && state.interval) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  const text =
    (ctx.lastComponent as Text | undefined) ??
    new Text("", ctx.outputPad ?? 0, 0);

  const details = result.details;
  if (!details?.progress?.length) {
    const content =
      result.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "";
    const safeContent = sanitizeTerminalText(content);
    text.setText(
      safeContent ? `${ctx.standalone ? "" : "\n"}${safeContent}` : "",
    );
    return text;
  }

  const {
    progress,
    results: taskResults,
    ticketId,
    status: ticketStatus,
  } = details;
  const total = progress.length;
  const widthInset =
    ctx.widthInset ??
    (ctx.outputPad === undefined ? 4 : Math.max(0, ctx.outputPad * 2));
  const w = getTermWidth() - widthInset;
  const lines: string[] = ctx.standalone ? [] : [""];
  const helpers = makeRenderHelpers(theme, w, lines);

  const branchCtx = {
    progress,
    taskResults,
    total,
    w,
    expanded: options.expanded,
    state,
    theme,
    lines,
    ticketId,
    ticketStatus,
    elapsedMs: details.elapsedMs,
  };

  // Surface batch-level warnings at the top of the TUI. The same text already
  // lives in textual content, but the progress renderer ignores content.
  if (details?.dispatchWarning) {
    const warning = sanitizeTerminalLine(details.dispatchWarning);
    if (warning) {
      lines.push(truncLine(theme.fg("warning", `⚠ ${warning}`), w), "");
    }
  }
  if (details?.overlapWarning) {
    const warning = sanitizeTerminalLine(details.overlapWarning);
    if (warning) {
      lines.push(truncLine(theme.fg("warning", `⚠ ${warning}`), w), "");
    }
  }
  if (details?.crossLeafDelivery) {
    lines.push(
      truncLine(
        theme.fg(
          "warning",
          "↳ Result delivered from another session-tree branch",
        ),
        w,
      ),
      "",
    );
  }

  if (options.isPartial) {
    renderPartialBranch(branchCtx, helpers);
  } else {
    renderFinalBranch(branchCtx, helpers);
  }

  // The partial branch historically filtered empty lines before budgeting so
  // blank separators didn't count against the row budget; the final branch
  // preserves blanks for visual spacing. Keep that asymmetry intact.
  const toBudget = options.isPartial ? lines.filter(Boolean) : lines;
  const budgeted = applyLineBudget(toBudget, options.expanded ?? false);
  text.setText(budgeted.join("\n"));
  return text;
}

/**
 * Render an automatically delivered async result with the same compact /
 * expanded presentation as a synchronous tool result. The full message
 * content remains untouched in model context; only its TUI presentation is
 * replaced.
 */
export function renderAsyncDelegateMessage(
  message: AsyncDelegateMessage,
  options: AsyncMessageRenderOptions,
  theme: Theme,
): Box {
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const result = renderDelegateResult(
    { content, details: message.details },
    { isPartial: false, expanded: options.expanded },
    theme,
    {
      state: {},
      lastComponent: undefined,
      invalidate: () => undefined,
      executionStarted: false,
      isPartial: false,
      // The Box below owns the same one-column padding as Pi's tool shell.
      outputPad: 0,
      widthInset: 2,
      standalone: true,
    },
  );
  const status = message.details?.status;
  const failed =
    status === "failed" ||
    status === "cancelled" ||
    message.details?.progress.some((task) => task.status === "failed");
  const pending = status === "running" || status === "cancelling";
  let background: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg" =
    "toolSuccessBg";
  if (pending) {
    background = "toolPendingBg";
  } else if (failed) {
    background = "toolErrorBg";
  }
  const box = new Box(1, 1, (text) => theme.bg(background, text));
  box.addChild(result);
  return box;
}

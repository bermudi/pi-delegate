import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  BrowserHistory,
  browserRows,
  browserRowStatus,
  type BrowserRow,
} from "./browser-state.ts";
import type { DelegateRuntime } from "./runtime.ts";
import { fmtDuration, fmtTokens, formatToolCallShort } from "./format.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./utils.ts";

function displayTail(text: string, limit: number): string {
  return text.length > limit
    ? `[Earlier text omitted]\n${text.slice(-limit)}`
    : text;
}

/** Bounded display, not a second transcript store. Full final output and tool
 * evidence continue to belong to the task/ticket. Never render terminal escapes
 * from model output, command output, prompts, IDs or errors. */
export function browserDetailText(row: BrowserRow, responses: boolean): string {
  if (responses) {
    const text = row.output || row.progress.assistantPreview;
    return sanitizeTerminalText(
      displayTail(
        text || "No assistant text yet. Tool-only turns may have no text.",
        32_768,
      ),
    );
  }
  const context = [
    row.error || row.progress.error
      ? `ERROR: ${row.error ?? row.progress.error}`
      : "",
    row.notice ?? "",
    ...(row.progress.warnings ?? []),
    row.ticket?.pause?.state !== undefined &&
    row.ticket.pause.state !== "running"
      ? "Pause is cooperative: current turns finish; subprocesses are not frozen. Deadlines still count."
      : "",
  ]
    .filter(Boolean)
    .map((line) => line.slice(0, 4096))
    .join("\n")
    .slice(0, 8192);
  const lines: string[] = [];
  const activities = row.progress.activities.slice(-100);
  if (row.progress.activities.length > activities.length)
    lines.push("[Earlier tool calls omitted]");
  for (const tool of activities) {
    const call =
      tool.name === "bash" && typeof tool.args.command === "string"
        ? `$ ${tool.args.command.slice(0, 4096)}`
        : formatToolCallShort(tool.name, tool.args);
    lines.push(
      `\n${tool.endTime !== undefined ? (tool.result?.isError ? "FAILED" : "DONE") : "RUNNING"} ${call.slice(0, 4096)}`,
    );
    const output = tool.result
      ? tool.result.content
          .filter((part) => part.type === "text")
          .slice(-20)
          .map((part) => displayTail(part.text ?? "", 4096))
          .join("\n")
      : tool.liveOutput;
    if (output) lines.push(displayTail(output, 4096));
  }
  if (!activities.length) lines.push("No tool calls yet.");
  return sanitizeTerminalText(
    [context, displayTail(lines.join("\n"), 57_344)].filter(Boolean).join("\n"),
  );
}

export class SubagentBrowser implements Component {
  private selectedKey?: string;
  private rows: BrowserRow[] = [];
  private list?: SelectList;
  private responses = false;
  private scroll: number | undefined;
  private pageSize = 8;
  private maxScroll = 0;
  private message = "";
  private controlsVisible = false;

  constructor(
    private readonly getRows: () => BrowserRow[],
    private readonly theme: Pick<Theme, "fg">,
    private readonly height: () => number,
    private readonly requestRender: () => void,
    private readonly close: () => void,
    private readonly pause: (row: BrowserRow) => string,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    if (
      matchesKey(data, "tab") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    ) {
      this.responses = !this.responses;
      this.scroll = undefined;
    } else if (matchesKey(data, "pageUp")) {
      this.scroll = Math.max(
        0,
        (this.scroll ?? this.maxScroll) - this.pageSize,
      );
    } else if (matchesKey(data, "pageDown")) {
      const next = (this.scroll ?? this.maxScroll) + this.pageSize;
      this.scroll = next >= this.maxScroll ? undefined : next;
    } else if (matchesKey(data, "home")) {
      this.scroll = 0;
    } else if (matchesKey(data, "end")) {
      this.scroll = undefined;
    } else if (data === "p") {
      if (!this.controlsVisible) return;
      const row = this.getRows().find((r) => r.key === this.selectedKey);
      if (row) this.message = this.pause(row);
    } else {
      this.list?.handleInput(data);
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(1, this.height());
    this.controlsVisible = height >= 14 && width >= 25;
    if (width <= 0) return [];
    const w = Math.max(1, width);
    if (!this.controlsVisible)
      return [truncateToWidth("Subagents · enlarge terminal · Esc closes", w)];
    this.rows = this.getRows();
    if (!this.rows.some((row) => row.key === this.selectedKey)) {
      this.selectedKey = this.rows[0]?.key;
      this.scroll = undefined;
    }
    const rosterHeight = Math.min(
      this.rows.length,
      5,
      Math.max(1, Math.floor(height / 4)),
    );
    this.list = new SelectList(
      this.rows.map((row) => ({
        value: row.key,
        label: sanitizeTerminalLine(
          `${row.progress.id ?? `task ${row.progress.index + 1}`} · ${row.progress.agent} · ${row.batch}`,
        ),
        description: sanitizeTerminalLine(browserRowStatus(row)),
      })),
      rosterHeight,
      {
        selectedPrefix: (s) => this.theme.fg("accent", s),
        selectedText: (s) => this.theme.fg("accent", s),
        description: (s) => this.theme.fg("muted", s),
        scrollInfo: (s) => this.theme.fg("dim", s),
        noMatch: (s) => this.theme.fg("muted", s),
      },
    );
    this.list.setSelectedIndex(
      Math.max(
        0,
        this.rows.findIndex((r) => r.key === this.selectedKey),
      ),
    );
    this.list.onSelectionChange = (item) => {
      this.selectedKey = item.value;
      this.scroll = undefined;
      this.message = "";
    };
    const row = this.rows.find((r) => r.key === this.selectedKey);
    const lines = [
      this.theme.fg("accent", "Subagents · live browser"),
      ...this.list.render(w),
    ];
    if (row) {
      const p = row.progress;
      lines.push(
        sanitizeTerminalLine(
          `${browserRowStatus(row)} · ${fmtDuration(p.durationMs)} · ${fmtTokens(p.tokens)} tokens · ${p.toolUses} tools · ${p.model ?? ""}`,
        ),
        ...(!row.finished && p.lastActivityAt
          ? [
              sanitizeTerminalLine(
                `Last event ${fmtDuration(Math.max(0, Date.now() - p.lastActivityAt))} ago`,
              ),
            ]
          : []),
        sanitizeTerminalLine(`Task: ${row.prompt.slice(0, 4096)}`),
        this.theme.fg(
          "accent",
          `${this.responses ? "Responses (32K character tail)" : "Tool activity"} · ${this.scroll === undefined ? "following live" : "scrollback"} · Tab switches view`,
        ),
      );
      this.pageSize = Math.max(1, height - lines.length - 3);
      const detail = browserDetailText(row, this.responses)
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line, w));
      this.maxScroll = Math.max(0, detail.length - this.pageSize);
      const start =
        this.scroll === undefined
          ? this.maxScroll
          : Math.min(this.scroll, this.maxScroll);
      lines.push(...detail.slice(start, start + this.pageSize));
      while (lines.length < height - 3) lines.push("");
      const pauseLabel =
        row.ticket?.status === "running" && row.ticket.pause
          ? `p ${row.ticket.pause.state === "running" ? "pause" : "resume"} WHOLE ticket ${row.ticket.id} (${row.siblings.length} tasks)`
          : "Pause/resume available only for live async tickets";
      lines.push(
        this.theme.fg(
          "muted",
          sanitizeTerminalLine(this.message || pauseLabel),
        ),
      );
    } else {
      lines.push(
        "No subagents yet. This view includes live and retained completed tasks.",
      );
    }
    lines.push(
      this.theme.fg(
        "dim",
        "↑↓ agent · PgUp/PgDn scroll · Home oldest · End live",
      ),
      this.theme.fg("dim", "Tab activity/responses · Esc back to draft"),
    );
    return lines.slice(0, height).map((line) => truncateToWidth(line, w));
  }
}

/** One UI per extension lifetime. Refresh only while visible: closed browsers
 * own no timer, no terminal listener, and no extra ticket waiter. */
export function registerSubagentBrowser(
  pi: ExtensionAPI,
  runtime: DelegateRuntime,
): BrowserHistory {
  const history = new BrowserHistory();
  let closeCurrent: (() => void) | undefined;
  let opening = false;
  const open = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        "The subagent browser requires Pi's terminal UI.",
        "warning",
      );
      return;
    }
    if (opening) return;
    opening = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keys, done) => {
          closeCurrent = () => done();
          timer = setInterval(() => tui.requestRender(), 200);
          timer.unref?.();
          return new SubagentBrowser(
            () => browserRows(runtime, history),
            theme,
            () => Math.max(1, Math.floor(tui.terminal.rows * 0.85)),
            () => tui.requestRender(),
            () => done(),
            (row) => {
              try {
                const ticket = row.ticket;
                if (!ticket?.pause || ticket.status !== "running")
                  return "This task has no live async ticket to pause.";
                const action =
                  ticket.pause.state === "running" ? "pause" : "resume";
                const result = runtime.tickets.handlePause({
                  ticket: ticket.id,
                  ticketAction: action,
                });
                return result.details.ticketId !== ticket.id
                  ? result.content
                      .filter((c) => c.type === "text")
                      .map((c) => c.text)
                      .join(" ")
                  : "";
              } catch (error) {
                console.error("[delegate] browser pause/resume failed", error);
                return `Pause/resume failed: ${error instanceof Error ? error.message : String(error)}`;
              }
            },
          );
        },
        {
          overlay: true,
          overlayOptions: { width: "95%", maxHeight: "85%", anchor: "center" },
        },
      );
    } catch (error) {
      console.error("[delegate] subagent browser failed", error);
      ctx.ui.notify(
        sanitizeTerminalLine(
          `Subagent browser failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        "error",
      );
    } finally {
      if (timer !== undefined) clearInterval(timer);
      closeCurrent = undefined;
      opening = false;
    }
  };
  pi.registerCommand("subagents", {
    description: "Browse live subagents and retained results",
    handler: async (_args, ctx) => open(ctx),
  });
  pi.registerShortcut("ctrl+shift+b", {
    description: "Open live subagent browser",
    handler: open,
  });
  pi.on("session_shutdown", () => {
    closeCurrent?.();
    history.reset();
  });
  return history;
}

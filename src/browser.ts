/**
 * Live subagent browser: the `/subagents` command and ctrl+shift+b shortcut
 * open a TUI overlay over the {@link ActivityStore} snapshot — a SelectList
 * roster, a per-row status line, the selected task's prompt, and a detail
 * pane toggled between tool activity and the assistant-text tail. `p`
 * pauses/resumes the selected row's whole ticket through the parent-provided
 * controls; a 200ms render tick runs only while the overlay is open and is
 * cleared on close.
 *
 * Rendering follows the v1 browser's approach (SelectList roster + wrapped
 * scrollable detail) — for TUI layout it is the sensible expression of the
 * same behavior. All store data is ANSI-sanitized at write time (see
 * activity.ts); runtime-origin strings composed here (pause errors, failure
 * notices) go through pi-tui's stripTerminalSequences.
 *
 * No deviation from the assigned API shape: it typechecks as specified
 * against the pinned 0.87.0 declarations.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { ActivityRow, ActivityStore } from "./activity.ts";

export interface BrowserControls {
  pauseTicket(ticketId: string): void;
  resumeTicket(ticketId: string): void;
  ticketPaused(ticketId: string): boolean;
}

const ASSISTANT_TAIL_LIMIT = 32_768;

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m${secs}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Live pause state wins over the store's possibly-lagging status. */
function statusWord(row: ActivityRow, paused: boolean): string {
  if (paused && (row.status === "queued" || row.status === "running")) {
    return "paused";
  }
  return row.status;
}

function ageOrDuration(row: ActivityRow, now: number): string {
  return fmtDuration(Math.max(0, (row.endedAt ?? now) - row.startedAt));
}

function rosterLabel(row: ActivityRow, now: number, paused: boolean): string {
  const ticket = row.ticketId !== undefined ? ` · ${row.ticketId}` : "";
  return `${statusWord(row, paused)} · ${ageOrDuration(row, now)} · ${row.label} · ${row.taskId}${ticket}`;
}

function statusLine(row: ActivityRow, paused: boolean, now: number): string {
  return `${statusWord(row, paused)} · ${ageOrDuration(row, now)} · ${row.toolCalls.length} tools · Last event ${fmtDuration(Math.max(0, now - row.lastEventAt))} ago`;
}

function detailText(row: ActivityRow, responses: boolean): string {
  if (responses) {
    // The store embeds "[Earlier text omitted]" when the tail was cut.
    return row.assistantTail.length > 0
      ? row.assistantTail
      : "No assistant text yet. Tool-only turns may have no text.";
  }
  if (row.toolCalls.length === 0) return "No tool calls yet.";
  const lines: string[] = [];
  for (const call of row.toolCalls) {
    // In-flight calls appear with their argument preview; only failures are
    // flagged (isError is set only when the call completes).
    lines.push(
      `${call.isError ? "FAILED " : ""}${call.tool}${call.preview ? ` ${call.preview}` : ""}`,
    );
  }
  return lines.join("\n");
}

type PauseToggle = (row: ActivityRow) => string;

class SubagentBrowser implements Component {
  private selectedKey: string | undefined;
  private list: SelectList | undefined;
  private responses = false;
  private scroll: number | undefined;
  private pageSize = 8;
  private maxScroll = 0;
  private message = "";
  private controlsVisible = false;

  constructor(
    private readonly getRows: () => readonly ActivityRow[],
    private readonly theme: Pick<Theme, "fg">,
    private readonly isPaused: (ticketId: string) => boolean,
    private readonly height: () => number,
    private readonly requestRender: () => void,
    private readonly close: () => void,
    private readonly togglePause: PauseToggle,
  ) {}

  private pausedOf(row: ActivityRow): boolean {
    if (row.kind !== "ticket" || row.ticketId === undefined) return false;
    try {
      return this.isPaused(row.ticketId);
    } catch {
      return false;
    }
  }

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
    } else if (data === "p" && this.controlsVisible) {
      const row = this.getRows().find(
        (candidate) => candidate.key === this.selectedKey,
      );
      if (row) this.message = this.togglePause(row);
    } else {
      this.list?.handleInput(data);
    }
    this.requestRender();
  }

  render(width: number): string[] {
    try {
      return this.renderInto(width);
    } catch {
      // Fail soft: a broken render must never take down the host TUI.
      return [""];
    }
  }

  private renderInto(width: number): string[] {
    const height = Math.max(1, this.height());
    this.controlsVisible = height >= 14 && width >= 25;
    if (width <= 0) return [""];
    const w = Math.max(1, width);
    if (!this.controlsVisible) {
      return [truncateToWidth("Subagents · enlarge terminal · Esc closes", w)];
    }
    const rows = this.getRows();
    if (!rows.some((row) => row.key === this.selectedKey)) {
      this.selectedKey = rows[0]?.key;
      this.scroll = undefined;
    }
    const now = Date.now();
    const rosterHeight = Math.min(
      rows.length,
      5,
      Math.max(1, Math.floor(height / 4)),
    );
    this.list = new SelectList(
      rows.map((row) => ({
        value: row.key,
        label: rosterLabel(row, now, this.pausedOf(row)),
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
        rows.findIndex((row) => row.key === this.selectedKey),
      ),
    );
    this.list.onSelectionChange = (item) => {
      this.selectedKey = item.value;
      this.scroll = undefined;
      this.message = "";
    };
    const row = rows.find((candidate) => candidate.key === this.selectedKey);
    const lines: string[] = [
      this.theme.fg("accent", "Subagents · live browser"),
      ...this.list.render(w),
    ];
    if (row) {
      const paused = this.pausedOf(row);
      lines.push(
        truncateToWidth(statusLine(row, paused, now), w),
        truncateToWidth(`Task: ${row.prompt}`, w),
        this.theme.fg(
          "accent",
          `${this.responses ? `Responses (${ASSISTANT_TAIL_LIMIT / 1024}K character tail)` : "Tool activity"} · ${this.scroll === undefined ? "following live" : "scrollback"} · Tab switches view`,
        ),
      );
      this.pageSize = Math.max(1, height - lines.length - 3);
      const detail = detailText(row, this.responses)
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line, w));
      this.maxScroll = Math.max(0, detail.length - this.pageSize);
      const start =
        this.scroll === undefined
          ? this.maxScroll
          : Math.min(this.scroll, this.maxScroll);
      lines.push(...detail.slice(start, start + this.pageSize));
      while (lines.length < height - 3) lines.push("");
      const settled = row.status === "ok" || row.status === "failed" || row.status === "cancelled" || row.status === "interrupted" || row.status === "budget-exhausted";
      const pauseHint =
        row.kind === "ticket" && row.ticketId !== undefined && !settled
          ? `p ${paused ? "resume" : "pause"} WHOLE ticket ${row.ticketId}`
          : "Pause/resume available only for live ticket rows";
      lines.push(this.theme.fg("muted", this.message || pauseHint));
    } else {
      lines.push(
        "No subagents yet. This view includes live and retained completed tasks.",
      );
    }
    lines.push(
      this.theme.fg(
        "dim",
        "↑↓ select · PgUp/PgDn scroll · Home oldest · End live",
      ),
      this.theme.fg(
        "dim",
        "Tab activity/responses · p pause/resume ticket · Esc close",
      ),
    );
    return lines.slice(0, height).map((line) => truncateToWidth(line, w));
  }
}

/** One UI per extension lifetime. The refresh timer lives only while the
 * browser is open, and a generation counter invalidates callbacks that
 * outlive their overlay. */
export function registerSubagentBrowser(
  api: ExtensionAPI,
  deps: { store: ActivityStore; controls: BrowserControls },
): void {
  let generation = 0;
  let open = false;
  // Set while an overlay is up; shutdown calls it so the custom-view
  // promise resolves, the finally below clears the timer, and no callback
  // outlives the extension (v1 closed on session_shutdown too).
  let closeCurrent: (() => void) | undefined;
  api.on("session_shutdown", () => {
    try {
      closeCurrent?.();
    } catch {
      // Teardown must never throw into the host.
    }
  });
  const openBrowser = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The subagent browser requires Pi's terminal UI.", "warning");
      return;
    }
    if (open) return;
    open = true;
    const gen = ++generation;
    const stale = (): boolean => gen !== generation;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          timer = setInterval(() => {
            if (!stale()) tui.requestRender();
          }, 200);
          timer.unref?.();
          closeCurrent = () => {
            if (!stale()) done();
          };
          return new SubagentBrowser(
            () => {
              try {
                return deps.store.snapshot();
              } catch {
                return [];
              }
            },
            theme,
            (ticketId) => {
              try {
                return deps.controls.ticketPaused(ticketId);
              } catch {
                return false;
              }
            },
            () => Math.max(1, Math.floor(tui.terminal.rows * 0.85)),
            () => {
              if (!stale()) tui.requestRender();
            },
            () => {
              if (!stale()) done();
            },
            (row) => {
              try {
                if (row.kind !== "ticket" || row.ticketId === undefined) {
                  return "Pause/resume available only for ticket rows";
                }
                if (deps.controls.ticketPaused(row.ticketId)) {
                  deps.controls.resumeTicket(row.ticketId);
                } else {
                  deps.controls.pauseTicket(row.ticketId);
                }
                return "";
              } catch (error) {
                console.error("[delegate] browser pause/resume failed", error);
                return stripTerminalSequences(
                  `Pause/resume failed: ${error instanceof Error ? error.message : String(error)}`,
                );
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
        stripTerminalSequences(
          `Subagent browser failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        "error",
      );
    } finally {
      closeCurrent = undefined;
      generation++; // stale every callback from this open
      if (timer !== undefined) clearInterval(timer);
      open = false;
    }
  };
  api.registerCommand("subagents", {
    description: "Browse live subagents and retained results",
    handler: async (_args, ctx) => {
      await openBrowser(ctx);
    },
  });
  api.registerShortcut("ctrl+shift+b", {
    description: "Open live subagent browser",
    handler: openBrowser,
  });
}

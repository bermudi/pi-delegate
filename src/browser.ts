import { DiagnosticSink } from "./diagnostics.ts";
/**
 * Live subagent browser (#128): the `/subagents` command and
 * ctrl+shift+b shortcut open a two-pane fleet dashboard over the
 * {@link ActivityStore} snapshot — a ticket-grouped roster owning the full
 * panel height on the left, and the selected agent's interleaved transcript
 * (assistant text and condensed tool one-liners in stream order,
 * tail-following) on the right. Retained 512-char tool previews expand
 * under Enter; Tab switches to a text-only view; PgUp/PgDn/Home/End scroll
 * the detail while `p` pauses/resumes the selected row's whole ticket
 * through the parent-provided controls. Narrow terminals stack the panes;
 * under 40×16 the browser asks for more room. A 200ms render tick runs only
 * while the overlay is open and is cleared on close.
 *
 * All store data is ANSI-sanitized at write time (see activity.ts);
 * runtime-origin strings composed here (pause errors, failure notices) go
 * through pi-tui's stripTerminalSequences.
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
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type {
  ActivityRow,
  ActivityStore,
  ActivityToolEvent,
} from "./activity.ts";
import { formatDuration as fmtDuration } from "./format.ts";

export interface BrowserControls {
  pauseTicket(ticketId: string): void;
  resumeTicket(ticketId: string): void;
  ticketPaused(ticketId: string): boolean;
}

const ASSISTANT_TAIL_LIMIT = 32_768;
/** Below this width the panes stack vertically. */
const SPLIT_MIN_WIDTH = 96;
/** Detail scroll stays pinned to the newest content while `scroll` is unset. */
const LIVE = undefined;
/** A live row whose last event is older than this reads `!` in the roster. */
const STALE_AFTER_MS = 120_000;

type FgColor = Parameters<Theme["fg"]>[0];

/** Live pause state wins over the store's possibly-lagging status. */
function statusWord(row: ActivityRow, paused: boolean): string {
  // "pausing": pause requested, the in-flight turn is still streaming to
  // its checkpoint; "paused": parked between turns (or held while queued).
  if (paused && row.status === "running") return "pausing";
  if (paused && row.status === "queued") return "paused";
  return row.status;
}

function ageOrDuration(row: ActivityRow, now: number): string {
  return fmtDuration(Math.max(0, (row.endedAt ?? now) - row.startedAt));
}

function isSettled(status: string): boolean {
  return (
    status === "ok" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "blocked" ||
    status === "interrupted" ||
    status === "budget-exhausted"
  );
}

/** `t-484e03ab-4bba-…` → `t-484e03ab`; other ids pass through. */
function shortId(id: string): string {
  const match = /^(t-[0-9a-f]{8})-[0-9a-f-]+$/.exec(id);
  return match?.[1] ?? id;
}

interface StatusGlyph {
  glyph: string;
  color: FgColor;
}

function statusGlyph(word: string): StatusGlyph {
  switch (word) {
    case "running":
      return { glyph: "⏳", color: "accent" };
    case "pausing":
      return { glyph: "⏳", color: "warning" };
    case "paused":
      return { glyph: "Ⅱ", color: "warning" };
    case "queued":
      return { glyph: "○", color: "muted" };
    case "ok":
      return { glyph: "✓", color: "success" };
    case "failed":
      return { glyph: "✗", color: "error" };
    case "blocked":
      return { glyph: "⚠", color: "warning" };
    default:
      return { glyph: "⊘", color: "muted" }; // cancelled/interrupted/budget-exhausted
  }
}

/** Shorten absolute paths to their last two segments so a scan line stays a
 * scan line (`read /a/b/c/x.ts` → `read c/x.ts`); drop a bash `cd <dir>`
 * prefix. Display-only: the store keeps the full preview. */
function condenseArgs(raw: string): string {
  let text = raw.replace(/^\$ cd \S+(?:\s*&&\s*)?/, "$ ");
  text = text.replace(/(?:~|\/)[\w.@+-]+(?:\/[\w.@+-]+)*/g, (match) => {
    const segments = match.split("/");
    return segments.slice(-2).join("/");
  });
  return text.replace(/\s{2,}/g, " ").trim();
}

/** One roster group: a ticket's tasks, or the retained inline runs. */
interface Group {
  key: string;
  kind: "ticket" | "inline";
  ticketId: string | undefined;
  rows: ActivityRow[];
  live: boolean;
  expanded: boolean;
}

type Item =
  | { kind: "group"; group: Group }
  | { kind: "task"; row: ActivityRow };

type PauseToggle = (row: ActivityRow) => string;

class SubagentBrowser implements Component {
  private selectedKey: string | undefined;
  private windowStart = 0;
  private textOnly = false;
  private expandedPreviews = false;
  private scroll: number | undefined = LIVE;
  private pageSize = 8;
  private maxScroll = 0;
  private message = "";
  private controlsVisible = false;
  private renderErrorReported = false;
  private readonly userExpanded = new Set<string>();
  private readonly userCollapsed = new Set<string>();

  constructor(
    private readonly diagnostics: DiagnosticSink,
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

  // --- input ---------------------------------------------------------------

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    const items = this.buildItems();
    const index = this.selectedIndex(items);
    const item: Item | undefined = items[index];
    if (matchesKey(data, "tab")) {
      this.textOnly = !this.textOnly;
      this.scroll = LIVE;
    } else if (matchesKey(data, "enter")) {
      if (item?.kind === "group") {
        this.toggleGroup(item.group);
        // Diving into a group lands on its first task; collapsing a group
        // whose task was selected returns to the header.
        if (!item.group.expanded && item.group.rows[0] !== undefined) {
          this.selectedKey = item.group.rows[0].key;
          this.scroll = LIVE;
          this.expandedPreviews = false;
          this.message = "";
        }
      } else {
        this.expandedPreviews = !this.expandedPreviews;
        this.scroll = LIVE;
      }
    } else if (item?.kind === "group" && (matchesKey(data, "right") || matchesKey(data, "left"))) {
      const expand = matchesKey(data, "right");
      this.userCollapsed.delete(item.group.key);
      this.userExpanded.delete(item.group.key);
      (expand ? this.userExpanded : this.userCollapsed).add(item.group.key);
      // Diving into a group lands on its first task.
      if (expand && !item.group.expanded && item.group.rows[0] !== undefined) {
        this.selectedKey = item.group.rows[0].key;
        this.scroll = LIVE;
      }
    } else if (item?.kind === "task" && matchesKey(data, "left")) {
      // Left from a task collapses its group and returns to the header.
      const key = groupKeyOfRow(item.row);
      this.userExpanded.delete(key);
      this.userCollapsed.add(key);
      this.selectedKey = key;
      this.scroll = LIVE;
    } else if (matchesKey(data, "up")) {
      this.moveSelection(items, index, -1);
    } else if (matchesKey(data, "down")) {
      this.moveSelection(items, index, 1);
    } else if (matchesKey(data, "pageUp")) {
      this.scroll = Math.max(0, (this.scroll ?? this.maxScroll) - this.pageSize);
    } else if (matchesKey(data, "pageDown")) {
      const next = (this.scroll ?? this.maxScroll) + this.pageSize;
      this.scroll = next >= this.maxScroll ? LIVE : next;
    } else if (matchesKey(data, "home")) {
      this.scroll = 0;
    } else if (matchesKey(data, "end")) {
      this.scroll = LIVE;
    } else if (data === "p" && this.controlsVisible) {
      const target = this.pauseTarget(item);
      if (target !== undefined) this.message = this.togglePause(target);
    }
    this.requestRender();
  }

  private toggleGroup(group: Group): void {
    if (group.expanded) {
      this.userExpanded.delete(group.key);
      this.userCollapsed.add(group.key);
    } else {
      this.userCollapsed.delete(group.key);
      this.userExpanded.add(group.key);
    }
  }

  private moveSelection(items: Item[], index: number, delta: number): void {
    if (items.length === 0) return;
    const next = Math.min(items.length - 1, Math.max(0, index + delta));
    const item = items[next];
    if (item === undefined) return;
    const key = itemKey(item);
    if (key !== this.selectedKey) {
      this.selectedKey = key;
      this.scroll = LIVE;
      this.expandedPreviews = false;
      this.message = "";
    }
  }

  private selectedIndex(items: Item[]): number {
    const index = items.findIndex((item) => itemKey(item) === this.selectedKey);
    if (index !== -1) return index;
    // Same default as render: the first visible task, else the first item.
    const firstTask = items.findIndex((item) => item.kind === "task");
    return firstTask === -1 ? 0 : firstTask;
  }

  /** The row whose ticket `p` would pause — a live ticket's task row, from
   * either a task or its group header. Undefined when nothing is pausable. */
  private pauseTarget(item: Item | undefined): ActivityRow | undefined {
    if (item === undefined) return undefined;
    if (item.kind === "task") {
      return item.row.kind === "ticket" && item.row.ticketId !== undefined && !isSettled(item.row.status)
        ? item.row
        : undefined;
    }
    return item.group.kind === "ticket"
      ? item.group.rows.find((row) => row.kind === "ticket" && !isSettled(row.status))
      : undefined;
  }

  // --- outer frame -----------------------------------------------------------

  render(width: number): string[] {
    try {
      const lines = this.renderInto(width);
      this.renderErrorReported = false;
      return lines;
    } catch (error) {
      // Fail soft: a broken render must never take down the host TUI.
      if (!this.renderErrorReported) {
        this.diagnostics.log("error", "subagent browser render failed", {}, error);
        this.renderErrorReported = true;
      }
      return [truncateToWidth("Subagents unavailable · Esc closes", Math.max(1, width))];
    }
  }

  /** Paint every cell in the panel, including empty rows. The host still
   * owns everything outside the frame; no editor or conversation mutation. */
  private frame(body: string[], width: number, height: number, title: string): string[] {
    if (width < 4 || height < 3) {
      return [truncateToWidth("Subagents · Esc closes", width)];
    }
    const inner = width - 4;
    const border = (text: string, left: string, right: string): string => {
      const label = truncateToWidth(text ? `─ ${text} ` : "", width - 2);
      return this.theme.fg("border", left + label + "─".repeat(width - 2 - visibleWidth(label)) + right);
    };
    const lines = [border(title, "╭", "╮")];
    for (let index = 0; index < height - 2; index++) {
      // Prompts may retain layout whitespace. One component line must be
      // one physical terminal row; detail wrapping has already happened.
      const text = truncateToWidth((body[index] ?? "").replace(/[\r\n\t]+/g, " "), inner);
      lines.push(
        this.theme.fg("border", "│") + " " + text +
        " ".repeat(inner - visibleWidth(text)) + " " + this.theme.fg("border", "│"),
      );
    }
    lines.push(border("", "╰", "╯"));
    return lines;
  }

  private rule(width: number, label = ""): string {
    const text = truncateToWidth(label ? `─ ${label} ` : "", width);
    return this.theme.fg("border", text + "─".repeat(width - visibleWidth(text)));
  }

  // --- roster model -------------------------------------------------------

  private buildGroups(rows: readonly ActivityRow[]): Group[] {
    const tickets = new Map<string, ActivityRow[]>();
    const inline: ActivityRow[] = [];
    for (const row of rows) {
      if (row.kind === "ticket" && row.ticketId !== undefined) {
        const bucket = tickets.get(row.ticketId);
        if (bucket) bucket.push(row);
        else tickets.set(row.ticketId, [row]);
      } else {
        inline.push(row);
      }
    }
    const groups: Group[] = [];
    for (const [ticketId, ticketRows] of tickets) {
      ticketRows.sort((a, b) => a.startedAt - b.startedAt);
      const live = ticketRows.some((row) => !isSettled(row.status));
      const key = `ticket:${ticketId}`;
      groups.push({
        key,
        kind: "ticket",
        ticketId,
        rows: ticketRows,
        live,
        expanded: this.userCollapsed.has(key)
          ? false
          : live || this.userExpanded.has(key),
      });
    }
    // Live tickets first (oldest start first — longest-waiting work reads
    // topmost), then settled tickets newest-settled first.
    groups.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      if (a.live) return firstStart(a) - firstStart(b);
      return lastEnd(b) - lastEnd(a);
    });
    if (inline.length > 0) {
      inline.sort((a, b) => b.startedAt - a.startedAt);
      const key = "inline";
      const live = inline.some((row) => !isSettled(row.status));
      groups.push({
        key,
        kind: "inline",
        ticketId: undefined,
        rows: inline,
        live,
        expanded: this.userCollapsed.has(key)
          ? false
          : live || this.userExpanded.has(key),
      });
    }
    return groups;
  }

  private buildItems(): Item[] {
    const groups = this.buildGroups(this.getRows());
    const items: Item[] = [];
    for (const group of groups) {
      items.push({ kind: "group", group });
      if (group.expanded) {
        for (const row of group.rows) items.push({ kind: "task", row });
      }
    }
    return items;
  }

  // --- roster rendering -----------------------------------------------------

  /** Concatenate colored segments into at most `width` columns. */
  private joinSegments(segments: readonly [string, FgColor][], width: number): string {
    let out = "";
    let remaining = Math.max(0, width);
    for (const [text, color] of segments) {
      if (remaining <= 0) break;
      const part = truncateToWidth(text, remaining);
      out += this.theme.fg(color, part);
      remaining -= visibleWidth(part);
      if (visibleWidth(part) < visibleWidth(text)) break;
    }
    return out;
  }

  /** Per-status counts as compact `2✓ 1⏳` clusters. */
  private countSegments(rows: readonly ActivityRow[], pausedOf: (row: ActivityRow) => boolean): string[] {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const word = statusWord(row, pausedOf(row));
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const order = ["running", "pausing", "paused", "queued", "ok", "failed", "blocked", "cancelled", "interrupted", "budget-exhausted"];
    const segments: string[] = [];
    for (const word of order) {
      const count = counts.get(word);
      if (count === undefined) continue;
      segments.push(`${count}${statusGlyph(word).glyph}`);
    }
    return segments;
  }

  private rosterLine(item: Item, now: number, width: number, selected: boolean): string {
    // `left` segments (colored), `right` column (dim), right-aligned gap.
    let left: [string, FgColor][];
    let right: string;
    if (item.kind === "group") {
      const group = item.group;
      const counts = this.countSegments(group.rows, (row) => this.pausedOf(row));
      const id = group.kind === "ticket" ? shortId(group.ticketId ?? "") : "inline";
      const elapsed = group.live
        ? fmtDuration(Math.max(0, now - Math.min(...group.rows.map((row) => row.startedAt))))
        : fmtDuration(Math.max(0, now - Math.max(...group.rows.map((row) => row.endedAt ?? row.startedAt))));
      left = [
        [group.expanded ? "▾ " : "▸ ", "dim"],
        [`${id} `, "text"],
        [counts.join(" "), "muted"],
      ];
      right = elapsed;
    } else {
      const row = item.row;
      const paused = this.pausedOf(row);
      const glyph = statusGlyph(statusWord(row, paused));
      const settled = isSettled(row.status) && !paused;
      if (settled) {
        right = ageOrDuration(row, now);
      } else if (row.status === "queued") {
        right = "waiting";
      } else {
        const age = Math.max(0, now - row.lastEventAt);
        right = `${ageOrDuration(row, now)} · ${fmtDuration(age)}${age > STALE_AFTER_MS ? " !" : ""}`;
      }
      left = [
        ["  ", "dim"],
        [`${glyph.glyph} `, glyph.color],
        [`${row.label} ${row.taskId}`, "text"],
      ];
    }
    const rightWidth = visibleWidth(right);
    const leftBudget = rightWidth >= width ? width : width - rightWidth - 1;
    const plainLeft = truncateToWidth(left.map(([text]) => text).join(""), leftBudget);
    const gap = " ".repeat(Math.max(0, leftBudget - visibleWidth(plainLeft)) + (rightWidth < width ? 1 : 0));
    if (selected) return this.theme.fg("accent", truncateToWidth(plainLeft + gap + right, width));
    return (
      this.joinSegments(left, leftBudget) +
      gap +
      (rightWidth < width ? this.theme.fg("dim", right) : "")
    );
  }

  private rosterColumn(items: Item[], selectedIndex: number, height: number, width: number, now: number): string[] {
    if (items.length === 0 || height <= 0) return [];
    // Keep the selected item inside the window; reserve rows for the
    // `↑/↓ more` indicators so they never evict the selection.
    const maxStart = Math.max(0, items.length - height);
    let start = Math.min(Math.max(0, this.windowStart), maxStart);
    if (selectedIndex < start) start = selectedIndex;
    if (selectedIndex >= start + height) start = selectedIndex - height + 1;
    start = Math.min(Math.max(0, start), maxStart);
    let fit = height;
    if (start > 0) fit -= 1;
    if (items.length - (start + fit) > 0) fit -= 1;
    for (let pass = 0; pass < 2; pass++) {
      if (selectedIndex >= start + Math.max(1, fit)) {
        start = Math.min(maxStart, selectedIndex - Math.max(1, fit) + 1);
        fit = height;
        if (start > 0) fit -= 1;
        if (items.length - (start + fit) > 0) fit -= 1;
      }
    }
    fit = Math.max(1, fit);
    this.windowStart = start;
    const lines: string[] = [];
    if (start > 0) lines.push(this.theme.fg("dim", `↑ ${start} more`));
    for (let offset = 0; offset < fit && start + offset < items.length; offset++) {
      const index = start + offset;
      lines.push(this.rosterLine(items[index]!, now, width, index === selectedIndex));
    }
    const below = items.length - (start + fit);
    if (below > 0) lines.push(this.theme.fg("dim", `↓ ${below} more`));
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  // --- detail rendering ---------------------------------------------------

  private toolLine(event: ActivityToolEvent, count: number, width: number): string[] {
    const marker = event.inFlight
      ? this.theme.fg("accent", "⏳")
      : event.isError
        ? this.theme.fg("error", "✗")
        : this.theme.fg("dim", "·");
    const args = condenseArgs(event.argPreview);
    const folded = count > 1 ? this.theme.fg("dim", ` ×${count}`) : "";
    const head =
      `${marker} ` +
      this.theme.fg(event.isError ? "error" : "toolTitle", event.tool) +
      (args ? this.theme.fg("muted", `  ${args}`) : "") +
      folded;
    const lines = [truncateToWidth(head, width)];
    if (this.expandedPreviews && !event.inFlight) {
      lines.push(
        ...wrapTextWithAnsi(event.preview || "(no preview)", Math.max(1, width - 2))
          .map((line) => this.theme.fg("dim", `  ${line}`)),
        "",
      );
    }
    return lines;
  }

  private transcriptLines(row: ActivityRow, width: number): string[] {
    if (this.textOnly) {
      // The store embeds "[Earlier text omitted]" when the tail was cut.
      const text = row.assistantTail || "No assistant text yet. Tool-only turns may have no text.";
      return text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
    }
    if (row.events.length === 0) {
      // Retained sync runs journal only the summary tail.
      const text = row.assistantTail;
      if (text) return text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
      return ["No activity recorded yet."];
    }
    const lines: string[] = [];
    let fold: { event: ActivityToolEvent; count: number } | undefined;
    const flush = (): void => {
      if (fold) lines.push(...this.toolLine(fold.event, fold.count, width));
      fold = undefined;
    };
    for (const event of row.events) {
      if (event.kind === "text") {
        flush();
        if (lines.length > 0) lines.push("");
        lines.push(
          ...wrapTextWithAnsi(event.text, width).map((line) => this.theme.fg("text", line)),
        );
        continue;
      }
      if (event.inFlight || this.expandedPreviews || event.isError) {
        flush();
        lines.push(...this.toolLine(event, 1, width));
        continue;
      }
      if (
        fold &&
        fold.event.tool === event.tool &&
        condenseArgs(fold.event.argPreview) === condenseArgs(event.argPreview)
      ) {
        fold.count += 1;
        continue;
      }
      flush();
      fold = { event, count: 1 };
    }
    flush();
    return lines;
  }

  private taskHeader(row: ActivityRow, width: number, now: number): string[] {
    const paused = this.pausedOf(row);
    const word = statusWord(row, paused);
    const glyph = statusGlyph(word);
    const parts = [
      `${this.theme.fg(glyph.color, glyph.glyph)} ${this.theme.fg("text", `${row.label} · ${row.taskId}`)}`,
      this.theme.fg("muted", word),
      this.theme.fg("muted", ageOrDuration(row, now)),
    ];
    if (row.toolCalls.length > 0) {
      const count = row.toolCalls.length;
      parts.push(this.theme.fg("muted", `${count} ${count === 1 ? "tool" : "tools"}`));
    }
    if (!isSettled(row.status)) {
      parts.push(this.theme.fg("muted", `last event ${fmtDuration(Math.max(0, now - row.lastEventAt))} ago`));
    }
    const lines = [truncateToWidth(parts.join(this.theme.fg("dim", " · ")), width)];
    lines.push(
      this.theme.fg(
        "dim",
        truncateToWidth(
          row.kind === "ticket" && row.ticketId !== undefined
            ? `Ticket ${row.ticketId}`
            : "Inline run · retained result",
          width,
        ),
      ),
    );
    if (row.prompt) {
      // The store preserves prompt line breaks; the header is a bounded
      // two-line digest, so flatten to one paragraph before wrapping.
      const flat = `Task: ${row.prompt}`.replace(/\n+/g, " ");
      const wrapped = wrapTextWithAnsi(flat, width);
      const shown = wrapped.slice(0, 2);
      if (wrapped.length > 2) {
        shown[shown.length - 1] = truncateToWidth(`${shown[shown.length - 1]}…`, width);
      }
      lines.push(...shown.map((line) => this.theme.fg("dim", line)));
    }
    return lines;
  }

  private groupDetail(group: Group, width: number, now: number): string[] {
    const lines: string[] = [];
    if (group.kind === "ticket" && group.ticketId !== undefined) {
      lines.push(this.theme.fg("text", `Ticket ${group.ticketId}`));
    } else {
      lines.push(this.theme.fg("text", "Retained inline runs · newest first"));
    }
    const counts = this.countSegments(group.rows, (row) => this.pausedOf(row)).join(" ");
    const elapsed = group.live
      ? `running ${fmtDuration(Math.max(0, now - Math.min(...group.rows.map((row) => row.startedAt))))}`
      : `settled ${fmtDuration(Math.max(0, now - Math.max(...group.rows.map((row) => row.endedAt ?? row.startedAt))))} ago`;
    lines.push(this.theme.fg("muted", `${counts}  ·  ${elapsed}`));
    lines.push("");
    for (const row of group.rows.slice(0, 12)) {
      const glyph = statusGlyph(statusWord(row, this.pausedOf(row)));
      const last = row.toolCalls.at(-1);
      const tail = last ? condenseArgs(last.argPreview || last.preview).slice(0, 60) : "";
      lines.push(
        truncateToWidth(
          `${this.theme.fg(glyph.color, glyph.glyph)} ${this.theme.fg("text", `${row.label} ${row.taskId}`)} ${this.theme.fg("muted", ageOrDuration(row, now))} ${this.theme.fg("dim", tail)}`,
          width,
        ),
      );
    }
    if (group.rows.length > 12) {
      lines.push(this.theme.fg("dim", `… ${group.rows.length - 12} more tasks`));
    }
    return lines;
  }

  private detailColumn(
    item: Item | undefined,
    width: number,
    height: number,
    now: number,
  ): string[] {
    if (item === undefined) {
      return ["No subagents yet. This view includes live and retained completed tasks."];
    }
    if (item.kind === "group") {
      this.maxScroll = 0;
      const lines = this.groupDetail(item.group, width, now);
      while (lines.length < height) lines.push("");
      return lines.slice(0, height);
    }
    const lines = this.taskHeader(item.row, width, now);
    const body = this.transcriptLines(item.row, width);
    this.pageSize = Math.max(1, height - lines.length - 1);
    this.maxScroll = Math.max(0, body.length - this.pageSize);
    const start =
      this.scroll === LIVE ? this.maxScroll : Math.min(this.scroll, this.maxScroll);
    const view = this.textOnly
      ? `text · ${ASSISTANT_TAIL_LIMIT / 1024}K tail`
      : this.expandedPreviews
        ? "tools · 512-char previews"
        : "transcript";
    const position = body.length === 0
      ? "0"
      : `${start + 1}–${Math.min(body.length, start + this.pageSize)}/${body.length}`;
    lines.push(
      this.rule(width, `${view} · ${this.scroll === LIVE ? "LIVE" : "SCROLL"} · ${position}`),
    );
    lines.push(...body.slice(start, start + this.pageSize));
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  // --- composition ---------------------------------------------------------

  private renderInto(width: number): string[] {
    const height = Math.max(1, this.height());
    this.controlsVisible = height >= 16 && width >= 40;
    if (width <= 0) return [""];
    if (!this.controlsVisible) {
      return this.frame(["Enlarge terminal · Esc closes"], width, height, "Subagents");
    }
    const rows = this.getRows();
    const inner = width - 4;
    if (rows.length === 0) {
      const empty = ["", "No subagents yet.", "", "This view includes live and retained completed tasks."];
      const footer = this.footer(inner, undefined, rows);
      while (empty.length < height - 2 - footer.length) empty.push("");
      return this.frame([...empty, ...footer], width, height, "Subagents");
    }
    const items = this.buildItems();
    if (!items.some((item) => itemKey(item) === this.selectedKey)) {
      // Land on the first live task rather than a group header.
      const chosen = items[this.selectedIndex(items)];
      this.selectedKey = chosen === undefined ? undefined : itemKey(chosen);
      this.windowStart = 0;
    }
    const now = Date.now();
    const selectedIndex = this.selectedIndex(items);
    const selected = items[selectedIndex];
    const footer = this.footer(inner, selected, rows);
    const bodyHeight = Math.max(1, height - 2 - footer.length);
    let body: string[];
    if (width >= SPLIT_MIN_WIDTH) {
      const rosterWidth = Math.min(56, Math.max(34, Math.floor(inner * 0.34)));
      const detailWidth = inner - rosterWidth - 3;
      const roster = this.rosterColumn(items, selectedIndex, bodyHeight, rosterWidth, now);
      const detail = this.detailColumn(selected, detailWidth, bodyHeight, now);
      const gutter = this.theme.fg("border", "│");
      body = roster.map((line, index) => {
        const pad = " ".repeat(Math.max(0, rosterWidth - visibleWidth(line)));
        const text = (detail[index] ?? "").replace(/[\r\n\t]+/g, " ");
        const right = truncateToWidth(text, detailWidth);
        return (
          line + pad + " " + gutter + " " +
          right + " ".repeat(Math.max(0, detailWidth - visibleWidth(right)))
        );
      });
    } else {
      const rosterHeight = Math.min(8, Math.max(3, Math.floor(bodyHeight * 0.3)));
      const roster = this.rosterColumn(items, selectedIndex, rosterHeight, inner, now);
      const detailHeight = Math.max(1, bodyHeight - rosterHeight - 1);
      const detail = this.detailColumn(selected, inner, detailHeight, now);
      body = [
        ...roster,
        this.rule(inner),
        ...detail,
      ];
    }
    return this.frame([...body, ...footer], width, height, this.title(rows, width));
  }

  private title(rows: readonly ActivityRow[], width: number): string {
    const running = rows.filter((row) => !isSettled(row.status)).length;
    const tickets = new Set(
      rows.filter((row) => row.kind === "ticket" && row.ticketId !== undefined).map((row) => row.ticketId),
    ).size;
    const tasks = `${rows.length} ${rows.length === 1 ? "task" : "tasks"}`;
    if (width < 70) return `Subagents · ${tasks}`;
    const middle = tickets > 0 ? `${tickets} ${tickets === 1 ? "ticket" : "tickets"} · ` : "";
    return `Subagents · ${middle}${tasks}${running > 0 ? ` · ${running} live` : ""}`;
  }

  private footer(width: number, selected: Item | undefined, rows: readonly ActivityRow[]): string[] {
    let hint = "";
    if (selected !== undefined && rows.length > 0) {
      const target = this.pauseTarget(selected);
      if (selected.kind === "group" && selected.group.kind === "inline") {
        hint = "Enter expands the retained inline runs";
      } else if (target !== undefined) {
        hint = `p ${this.pausedOf(target) ? "resume" : "pause"} whole ticket (all its tasks)`;
      } else {
        hint = "Completed result · pause unavailable";
      }
    }
    const narrow = width < 65;
    const keys = this.textOnly
      ? narrow
        ? "↑↓ · Tab tools · Esc"
        : "↑↓ select · Tab tools · PgUp/Dn scroll · Esc close"
      : narrow
        ? "↑↓ · Tab · p · Esc"
        : "↑↓ select · → ticket · Enter previews · Tab text · PgUp/Dn scroll · p pause · Esc close";
    return [
      this.theme.fg("muted", truncateToWidth(this.message || hint, width)),
      this.theme.fg("muted", keys),
    ];
  }
}

function itemKey(item: Item): string {
  return item.kind === "task" ? item.row.key : item.group.key;
}

/** The roster group a row belongs to — tickets by id, everything else inline. */
function groupKeyOfRow(row: ActivityRow): string {
  return row.kind === "ticket" && row.ticketId !== undefined
    ? `ticket:${row.ticketId}`
    : "inline";
}

function firstStart(group: Group): number {
  return Math.min(...group.rows.map((row) => row.startedAt));
}

function lastEnd(group: Group): number {
  return Math.max(...group.rows.map((row) => row.endedAt ?? row.startedAt));
}

/** One UI per extension lifetime. The refresh timer lives only while the
 * browser is open, and a generation counter invalidates callbacks that
 * outlive their overlay. */
export function registerSubagentBrowser(
  api: ExtensionAPI,
  deps: { diagnostics: DiagnosticSink; store: ActivityStore; controls: BrowserControls },
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
            deps.diagnostics,
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
            () => Math.max(1, Math.floor(tui.terminal.rows * 0.92)),
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
                deps.diagnostics.log("error", "browser pause/resume failed", {}, error);
                return stripTerminalSequences(
                  `Pause/resume failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
          );
        },
        {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "92%", anchor: "center" },
        },
      );
    } catch (error) {
      deps.diagnostics.log("error", "subagent browser failed", {}, error);
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

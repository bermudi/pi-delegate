/**
 * Live subagent activity: a bounded, display-only store feeding the
 * `/subagents` browser. The parent session owns the wiring — it tracks
 * ticket tasks, feeds session events via `observe`, and retains finished
 * sync runs. Full transcripts never live here: tool previews are capped at
 * 512 chars, assistant text at a 32K tail, tool calls at 100, retained sync
 * runs at 20, settled ticket rows at 100.
 *
 * Deviation from the assigned signature: `AgentSessionEvent` is not exported
 * by `@earendil-works/pi-agent-core` at the pinned 0.87.0 declarations — the
 * type lives on `@earendil-works/pi-coding-agent` (see `src/execution.ts`),
 * so the type-only import below resolves there instead.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type ActivityStatus =
  | "queued"
  | "running"
  | "paused"
  | "ok"
  | "failed"
  | "cancelled"
  | "blocked"
  | "interrupted";

export interface ActivityToolCall {
  /** Start of the call (ms epoch); the preview is rewritten when it ends. */
  at: number;
  tool: string;
  /** Short one-line arg/result preview, ANSI-sanitized, capped at 512 chars. */
  preview: string;
  /** The call's own argument one-liner, kept after the merged arg→result
   * preview lands, so a poll row can show `last: <tool> <args>`. */
  argPreview: string;
  /** True while the call has started but not ended (the current tool). */
  inFlight: boolean;
  isError: boolean;
}

export interface ActivityRow {
  /**
   * Store-assigned unique key: `${ticketId}:${taskId}` for ticket rows,
   * `sync:${taskId}#<seq>` for retained sync runs (task ids repeat across
   * dispatches, so the sequence keeps distinct runs distinct).
   */
  key: string;
  kind: "ticket" | "sync";
  ticketId: string | undefined;
  taskId: string;
  /** Agent name or "inline". */
  label: string;
  status: ActivityStatus;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | undefined;
  /** First ~200 chars of the task prompt. */
  prompt: string;
  /** Newest last, capped at 100. */
  toolCalls: readonly ActivityToolCall[];
  /** Last 32_768 chars of assistant text (no thinking blocks). */
  assistantTail: string;
}

export interface ActivityStore {
  trackTicketTask(info: {
    ticketId: string;
    taskId: string;
    label: string;
    prompt: string;
    /** Accepted for wiring symmetry; activity rows carry no model field. */
    model?: string;
  }): void;
  setTicketTaskStatus(
    ticketId: string,
    taskId: string,
    status: ActivityStatus,
  ): void;
  observe(ticketId: string, taskId: string, event: AgentSessionEvent): void;
  retainSyncRun(info: {
    taskId: string;
    label: string;
    prompt: string;
    status: ActivityStatus;
    startedAt: number;
    endedAt: number;
    summary: string;
  }): void;
  /** One task's live row, for running-ticket poll lines. */
  taskRow(ticketId: string, taskId: string): ActivityRow | undefined;
  snapshot(): readonly ActivityRow[];
}

const ASSISTANT_TAIL_LIMIT = 32_768;
const TOOL_CALL_LIMIT = 100;
const PREVIEW_LIMIT = 512;
const PROMPT_LIMIT = 200;
const RETAINED_SYNC_LIMIT = 20;
const RETAINED_TICKET_LIMIT = 100;
const OMITTED_MARKER = "[Earlier text omitted]";

/** Terminal statuses: they end a row's clock. */
function isSettled(status: ActivityStatus): boolean {
  return (
    status === "ok" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "blocked" ||
    status === "interrupted"
  );
}

// --- ANSI sanitization -----------------------------------------------------
//
// Store-side, because tool results and model text can carry terminal escapes.
// A linear scanner, not a regex: patterns with lazy "anything until
// terminator" branches go quadratic on inputs full of unterminated
// OSC/DCS introducers, and this store ingests unbounded model/tool text.

function skipCsi(text: string, index: number): number {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    // A malformed CSI must not swallow layout while searching for a final
    // byte; leave common layout controls for the outer sanitizer.
    if (code === 0x09 || code === 0x0a || code === 0x0d) return index;
    index++;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function skipControlString(text: string, index: number): number {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2;
    index++;
  }
  return index;
}

function skipEscape(text: string, index: number): number {
  const next = text.charCodeAt(index);
  if (next === 0x5b) return skipCsi(text, index + 1); // ESC [
  if (
    next === 0x5d || // OSC
    next === 0x50 || // DCS
    next === 0x58 || // SOS
    next === 0x5e || // PM
    next === 0x5f // APC
  ) {
    return skipControlString(text, index + 1);
  }
  if (next === 0x5c) return index + 1; // standalone ST: leave a word boundary
  // Generic ESC sequence: optional intermediates, then one final byte.
  while (index < text.length) {
    const value = text.charCodeAt(index);
    if (value < 0x20 || value > 0x2f) break;
    index++;
  }
  if (index < text.length) {
    const final = text.charCodeAt(index);
    if (final >= 0x30 && final <= 0x7e) return index + 1;
  }
  return index;
}

function stripAnsi(text: string): string {
  let clean = "";
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      index = skipEscape(text, index + 1);
      continue;
    }
    if (code === 0x9b) {
      index = skipCsi(text, index + 1);
      continue;
    }
    if (
      code === 0x9d ||
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9e ||
      code === 0x9f
    ) {
      index = skipControlString(text, index + 1);
      continue;
    }
    if (code === 0x9c) {
      // Stray terminator: keep a boundary so removal cannot join words.
      clean += " ";
      index++;
      continue;
    }
    clean += text[index]!;
    index++;
  }
  return clean;
}

/** Multiline sanitizer: preserves line structure, drops controls/bidi marks. */
function sanitizeText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** One-line sanitizer for previews and labels. */
function sanitizeLine(text: string): string {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}

// --- bounded text helpers --------------------------------------------------

function truncateHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function truncateTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `…${text.slice(-(limit - 1))}`;
}

function appendAssistantTail(existing: string, addition: string): string {
  const combined = existing ? `${existing}\n\n${addition}` : addition;
  if (combined.length <= ASSISTANT_TAIL_LIMIT) return combined;
  const body = combined.startsWith(`${OMITTED_MARKER}\n`)
    ? combined.slice(OMITTED_MARKER.length + 1)
    : combined;
  return `${OMITTED_MARKER}\n${body.slice(-ASSISTANT_TAIL_LIMIT)}`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

const ARG_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "prompt",
] as const;

/** One-line preview of a tool call's arguments. */
function argPreview(args: unknown): string {
  if (args === null || args === undefined) return "";
  // Slice BEFORE sanitizing: the sanitizer is linear in its input, and tool
  // arguments can be arbitrarily large — a preview must never cost O(payload)
  // parent-thread work (v1 truncated first for the same reason).
  if (typeof args !== "object")
    return sanitizeLine(String(args).slice(0, 1024));
  const record = args as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      const line = sanitizeLine(value.slice(0, 1024));
      return key === "command" ? `$ ${line}` : line;
    }
  }
  return sanitizeLine(stringifyUnknown(args).slice(0, 1024));
}

/** One-line preview of a tool result's text content. */
function resultPreview(result: unknown): string {
  if (result === null || result === undefined) return "";
  // Tail-slice before sanitize (same O(payload) rule as argPreview).
  if (typeof result !== "object")
    return sanitizeLine(String(result).slice(0, 1024));
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content))
    return sanitizeLine(stringifyUnknown(result).slice(0, 1024));
  const parts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text.slice(-1024));
    }
  }
  return sanitizeLine(parts.join(" "));
}

/** Combined end-of-call preview: arg head → result tail, ≤512 chars. */
function callPreview(argText: string, result: unknown): string {
  const tail = truncateTail(resultPreview(result), 250);
  const joined = tail
    ? `${truncateHead(argText, 200)} → ${tail}`
    : truncateHead(argText, PREVIEW_LIMIT);
  return truncateHead(joined, PREVIEW_LIMIT);
}

// --- store internals -------------------------------------------------------

/** Open tool executions, by toolCallId. */
interface OpenTool {
  index: number;
  argPreview: string;
}

/** Store-private mutable entry; snapshots are copied out on read. */
interface MutableEntry {
  /** The entry's own map key — rowOf and pruning must not re-derive it. */
  key: string;
  kind: "ticket" | "sync";
  ticketId: string | undefined;
  taskId: string;
  label: string;
  status: ActivityStatus;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | undefined;
  prompt: string;
  toolCalls: ActivityToolCall[];
  assistantTail: string;
  openTools: Map<string, OpenTool>;
}

/** Splice front-evicted calls; returns how many were removed. */
function trimToolCalls(calls: ActivityToolCall[]): number {
  const excess = calls.length - TOOL_CALL_LIMIT;
  if (excess > 0) calls.splice(0, excess);
  return Math.max(0, excess);
}

/** Open indices shift when front entries are evicted; drop evicted ones. */
function shiftOpenTools(openTools: Map<string, OpenTool>, removed: number): void {
  if (removed <= 0) return;
  for (const [id, open] of openTools) {
    const shifted = open.index - removed;
    if (shifted < 0) openTools.delete(id);
    else open.index = shifted;
  }
}

function rowOf(entry: MutableEntry): ActivityRow {
  return {
    key: entry.key,
    kind: entry.kind,
    ticketId: entry.ticketId,
    taskId: entry.taskId,
    label: entry.label,
    status: entry.status,
    startedAt: entry.startedAt,
    lastEventAt: entry.lastEventAt,
    endedAt: entry.endedAt,
    prompt: entry.prompt,
    toolCalls: entry.toolCalls.map((call) => ({ ...call })),
    assistantTail: entry.assistantTail,
  };
}

/** Ticket rows first (running before settled, newest-started last within
 * groups), then sync runs newest first. */
function compareRows(a: ActivityRow, b: ActivityRow): number {
  if (a.kind !== b.kind) return a.kind === "ticket" ? -1 : 1;
  if (a.kind === "ticket") {
    const settledA = isSettled(a.status) ? 1 : 0;
    const settledB = isSettled(b.status) ? 1 : 0;
    if (settledA !== settledB) return settledA - settledB;
    return a.startedAt - b.startedAt;
  }
  return b.startedAt - a.startedAt;
}

export function createActivityStore(): ActivityStore {
  const entries = new Map<string, MutableEntry>();
  let syncSeq = 0;
  /**
   * taskId → the key of that task's latest retained sync run. Task ids are
   * per-dispatch, so a fresh dispatch reuses the same ids; startedAt
   * distinguishes a repeated record for one run from a new run.
   */
  const latestSyncRun = new Map<string, { startedAt: number; key: string }>();

  /** An empty ticket id stands in for an inline (sync) run. */
  const normalizeTicketId = (ticketId: string): string | undefined =>
    ticketId.length > 0 ? ticketId : undefined;

  const lazyEntry = (ticketId: string, taskId: string): MutableEntry => {
    const id = normalizeTicketId(ticketId);
    const key = `${id ?? "sync"}:${taskId}`;
    const existing = entries.get(key);
    if (existing) return existing;
    const now = Date.now();
    const created: MutableEntry = {
      key,
      kind: id === undefined ? "sync" : "ticket",
      ticketId: id,
      taskId,
      label: "inline",
      status: "running",
      startedAt: now,
      lastEventAt: now,
      endedAt: undefined,
      prompt: "",
      toolCalls: [],
      assistantTail: "",
      openTools: new Map(),
    };
    entries.set(key, created);
    return created;
  };

  const appendCall = (
    entry: MutableEntry,
    at: number,
    tool: string,
    preview: string,
    argPreview: string,
    inFlight: boolean,
    isError: boolean,
  ): void => {
    entry.toolCalls.push({ at, tool, preview, argPreview, inFlight, isError });
    shiftOpenTools(entry.openTools, trimToolCalls(entry.toolCalls));
  };

  /** Evict oldest-settled entries of one kind past the retained limit. */
  const pruneSettled = (kind: "ticket" | "sync", limit: number): void => {
    const finished: MutableEntry[] = [];
    for (const entry of entries.values()) {
      if (entry.kind === kind && isSettled(entry.status)) {
        finished.push(entry);
      }
    }
    finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const entry of finished.slice(0, -limit)) {
      entries.delete(entry.key);
      if (latestSyncRun.get(entry.taskId)?.key === entry.key) {
        latestSyncRun.delete(entry.taskId);
      }
    }
  };

  return {
    trackTicketTask(info): void {
      const key = `${info.ticketId}:${info.taskId}`;
      const now = Date.now();
      const existing = entries.get(key);
      if (existing) {
        existing.label = sanitizeLine(info.label) || "inline";
        existing.prompt = truncateHead(sanitizeText(info.prompt), PROMPT_LIMIT);
        return;
      }
      entries.set(key, {
        key,
        kind: "ticket",
        ticketId: info.ticketId,
        taskId: info.taskId,
        label: sanitizeLine(info.label) || "inline",
        status: "queued",
        startedAt: now,
        lastEventAt: now,
        endedAt: undefined,
        prompt: truncateHead(sanitizeText(info.prompt), PROMPT_LIMIT),
        toolCalls: [],
        assistantTail: "",
        openTools: new Map(),
      });
    },

    setTicketTaskStatus(ticketId, taskId, status): void {
      const entry = lazyEntry(ticketId, taskId);
      entry.status = status;
      entry.lastEventAt = Date.now();
      entry.endedAt = isSettled(status) ? (entry.endedAt ?? Date.now()) : undefined;
      if (isSettled(status)) {
        entry.openTools.clear();
        if (entry.kind === "ticket") {
          pruneSettled("ticket", RETAINED_TICKET_LIMIT);
        }
      }
    },

    observe(ticketId, taskId, event): void {
      const entry = lazyEntry(ticketId, taskId);
      const now = Date.now();
      entry.lastEventAt = now;

      if (event.type === "tool_execution_start") {
        const preview = truncateHead(argPreview(event.args), PREVIEW_LIMIT);
        appendCall(entry, now, sanitizeLine(event.toolName) || "tool", preview, preview, true, false);
        entry.openTools.set(event.toolCallId, {
          index: entry.toolCalls.length - 1,
          argPreview: preview,
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const open = entry.openTools.get(event.toolCallId);
        entry.openTools.delete(event.toolCallId);
        const preview = callPreview(open?.argPreview ?? "", event.result);
        if (open !== undefined && open.index < entry.toolCalls.length) {
          const call = entry.toolCalls[open.index];
          if (call) {
            call.preview = preview;
            call.inFlight = false;
            call.isError = event.isError;
          }
        } else {
          // End without a surviving start (evicted or never seen): still
          // record the completion.
          appendCall(
            entry,
            now,
            sanitizeLine(event.toolName) || "tool",
            preview,
            "",
            false,
            event.isError,
          );
        }
        return;
      }
      if (event.type === "message_end") {
        const message = event.message;
        if (message.role !== "assistant") return;
        const parts: string[] = [];
        for (const block of message.content) {
          if (block.type === "text" && block.text) {
            parts.push(sanitizeText(block.text));
          }
        }
        if (parts.length > 0) {
          entry.assistantTail = appendAssistantTail(
            entry.assistantTail,
            parts.join("\n\n"),
          );
        }
      }
      // Every other event type only bumps lastEventAt, already done above.
    },

    retainSyncRun(info): void {
      const prior = latestSyncRun.get(info.taskId);
      const key =
        prior !== undefined && prior.startedAt === info.startedAt
          ? prior.key
          : `sync:${info.taskId}#${++syncSeq}`;
      latestSyncRun.set(info.taskId, { startedAt: info.startedAt, key });
      const label = sanitizeLine(info.label) || "inline";
      const prompt = truncateHead(sanitizeText(info.prompt), PROMPT_LIMIT);
      const summary = truncateTail(
        sanitizeText(info.summary),
        ASSISTANT_TAIL_LIMIT,
      );
      const existing = entries.get(key);
      if (existing) {
        existing.kind = "sync";
        existing.ticketId = undefined;
        existing.label = label;
        existing.prompt = prompt;
        existing.status = info.status;
        existing.startedAt = info.startedAt;
        existing.lastEventAt = info.endedAt;
        existing.endedAt = info.endedAt;
        existing.assistantTail = summary;
        existing.openTools.clear();
      } else {
        entries.set(key, {
          key,
          kind: "sync",
          ticketId: undefined,
          taskId: info.taskId,
          label,
          status: info.status,
          startedAt: info.startedAt,
          lastEventAt: info.endedAt,
          endedAt: info.endedAt,
          prompt,
          toolCalls: [],
          assistantTail: summary,
          openTools: new Map(),
        });
      }
      pruneSettled("sync", RETAINED_SYNC_LIMIT);
    },

    taskRow(ticketId, taskId): ActivityRow | undefined {
      const entry = entries.get(`${normalizeTicketId(ticketId) ?? "sync"}:${taskId}`);
      return entry === undefined ? undefined : rowOf(entry);
    },

    snapshot(): readonly ActivityRow[] {
      const rows: ActivityRow[] = [];
      for (const entry of entries.values()) rows.push(rowOf(entry));
      return rows.sort(compareRows);
    },
  };
}

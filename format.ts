import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderOutputForLLM } from "./spill.ts";
import { getOutputSpillThreshold, getOutputSpillTail } from "./config.ts";
import { toolExpandHint } from "./key-hints.ts";
import { sanitizeTerminalLine } from "./utils.ts";
import type {
  ResolvedTask,
  TaskProgress,
  TaskResult,
  ToolActivity,
  WorkspaceMode,
} from "./types.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Return the current spinner glyph for live progress rendering. */
export function spinnerFrame(): string {
  return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}

/** Get terminal width, clamped to a reasonable range. */
export function getTermWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns || 120, 200));
}

// Re-used segmenter for grapheme-aware truncation
const _segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const _wideCharRe = /[\u{1100}-\u{10FFFF}]/u;
// Combining marks (NFD decomposition) — force slow path since length != display width
const _combiningRe =
  /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/u;

/** Return the display width of a single grapheme cluster. */
function charWidth(seg: string): number {
  const cp = seg.codePointAt(0)!;
  if (cp < 0x20) return 0; // control chars
  if (cp === 0x7f) return 0; // DEL
  if (cp >= 0x1100 && cp <= 0x115f) return 2; // Hangul Jamo
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2; // CJK, Yi, etc.
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // Hangul Syllables
  if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK Compatibility Ideographs
  if (cp >= 0xfe10 && cp <= 0xfe19) return 2; // Vertical forms
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2; // CJK Compatibility Forms
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // Fullwidth ASCII variants
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2; // Fullwidth symbol variants
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2; // CJK Extensions B-I
  if (cp >= 0x1f000 && cp <= 0x1fffd) return 2; // Symbols, emoticons, transport, etc.
  if (cp >= 0xe0000 && cp <= 0xe007f) return 0; // Tags (invisible formatting)
  // Note: ZWJ sequences (👨‍👩‍👧‍👦) and skin-tone modifiers (👍🏻) are handled
  // by Intl.Segmenter as single graphemes. The base emoji code point
  // determines width (typically 2), which is correct for display.
  return 1;
}

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 * Uses Intl.Segmenter for proper Unicode/emoji handling.
 */
export function truncLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  // Fast path: plain ASCII (no ANSI, no wide chars, no combining marks)
  if (
    !/\x1b\[[0-9;]*m/.test(text) &&
    !_wideCharRe.test(text) &&
    !_combiningRe.test(text)
  ) {
    if (text.length <= maxWidth) return text;
    return text.slice(0, maxWidth - 1) + "…";
  }

  // Split on ANSI sequences so they remain atomic
  const parts = text.split(/(\x1b\[[0-9;]*m)/);

  // Pre-check: does the text fit without truncation?
  let totalVis = 0;
  for (const part of parts) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) continue;
    for (const segment of _segmenter.segment(part)) {
      totalVis += charWidth(segment.segment);
      if (totalVis > maxWidth) break;
    }
    if (totalVis > maxWidth) break;
  }
  if (totalVis <= maxWidth) return text;

  const target = maxWidth - 1; // reserve space for "…"
  let result = "";
  let vis = 0;
  let activeStyles: string[] = [];

  for (const part of parts) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) {
      result += part;
      if (part === "\x1b[0m" || part === "\x1b[m") activeStyles = [];
      else activeStyles.push(part);
      continue;
    }

    // Fast path: ASCII-only part that fits entirely (no combining marks)
    if (
      !_wideCharRe.test(part) &&
      !_combiningRe.test(part) &&
      vis + part.length <= target
    ) {
      result += part;
      vis += part.length;
      continue;
    }

    for (const segment of _segmenter.segment(part)) {
      const seg = segment.segment;
      const w = charWidth(seg);
      if (vis + w > target)
        return (
          result +
          activeStyles.join("") +
          "…" +
          (activeStyles.length ? "\x1b[0m" : "")
        );
      result += seg;
      vis += w;
    }
  }

  return result;
}

/**
 * Apply a line budget so the TUI doesn't overflow the terminal.
 * Returns lines trimmed to fit within `budget` visible rows.
 */
export function applyLineBudget(lines: string[], expanded: boolean): string[] {
  if (expanded) return [...lines]; // expanded shows everything
  const rows = process.stdout.rows || 30;
  const budget = Math.max(10, Math.min(18, Math.floor(rows * 0.4)));
  if (lines.length <= budget) return [...lines];
  const hidden = lines.length - budget + 1;
  const expandHint = toolExpandHint("expands");
  return [
    ...lines.slice(0, budget - 1),
    truncLine(
      `… ${hidden} lines hidden${expandHint ? ` · ${expandHint}` : ""}`,
      getTermWidth(),
    ),
  ];
}

/** Replace the current home-directory prefix with `~` for display. */
export function shortenPath(p: string): string {
  const home = process.env.HOME;
  if (!home || home === "/") return p;
  // Exact home match
  if (p === home) return "~";
  // Prefix check with separator to avoid /home/alice matching /home/alice2
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (p.startsWith(prefix)) return "~" + path.sep + p.slice(prefix.length);
  return p;
}

/** Human-readable activity age ("active now", "active 5s ago", etc.) */
export function getActivityAge(lastActivityAt: number | undefined): string {
  if (lastActivityAt === undefined) return "";
  const ago = Math.max(0, Date.now() - lastActivityAt);
  if (ago < 1000) return "active now";
  if (ago < 60000) return `active ${Math.floor(ago / 1000)}s ago`;
  return `active ${Math.floor(ago / 60000)}m ago`;
}

/** Format milliseconds as a compact human-readable duration. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}m${secs}s`;
}

/** Format a token count using compact k notation above 1,000. */
export function fmtTokens(n: number): string {
  return n < 1000
    ? `${n}`
    : n < 10000
      ? `${(n / 1000).toFixed(1)}k`
      : `${Math.round(n / 1000)}k`;
}

/** Truncate a string to at most `n` characters with an ellipsis. */
export function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Render an optional task `id` in a compact, visually distinct form. */
export function formatTaskId(id: string | undefined): string {
  if (!id) return "";
  const safeId = sanitizeTerminalLine(id);
  return safeId ? ` #${safeId}` : "";
}

/**
 * Short identity tag for a resumed transcript, derived from its session file
 * path (pi names sessions `<timestamp>_<uuid>.jsonl`, so the UUID prefix is
 * the stable part). Best-effort display identity only — never parsed back.
 */
export function formatResumeTag(resumeFrom: string): string {
  const stem = sanitizeTerminalLine(resumeFrom).replace(/\.jsonl$/i, "");
  const base = stem.split("/").pop() ?? stem;
  const unique = base.includes("_") ? (base.split("_").pop() ?? base) : base;
  return (unique.slice(0, 8) || "resumed").trim();
}

/**
 * Plain-text revival marker for a progress row that continued an earlier
 * transcript. Empty when the row is not a resume, or when the agent name
 * already carries the resume identity (`resume:<tag>`, set at task resolution
 * for omitted-agent resumes) — the marker must not duplicate it.
 */
export function resumeMarker(p: {
  agent: string;
  resumedFrom?: string;
}): string {
  return p.resumedFrom && p.agent !== `resume:${p.resumedFrom}`
    ? ` ↻${p.resumedFrom}`
    : "";
}

/**
 * Extract a single-line preview of agent output for collapsed final display.
 *
 * Collapsed mode can't afford the full markdown render (and the render cache is
 * keyed to expanded width), so we pull a cheap plain-text first line instead.
 * Skips leading blanks and strips common markdown markers (headings, bullets,
 * code fences) so the preview is the first *meaningful* line of content.
 * Returns "" for empty / "(no output)" — callers should omit the line entirely.
 */
export function previewOutputLine(output: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const clean = output.trim();
  if (!clean || clean === "(no output)") return "";
  for (const raw of clean.split("\n")) {
    const line = sanitizeTerminalLine(raw);
    if (!line) continue;
    // Strip leading markdown noise so the preview reads as content, not markup.
    const stripped = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/^```+.*$/, "")
      .trim();
    if (stripped) return truncLine(stripped, maxWidth);
  }
  return "";
}

/** Return the tree branch glyph for item `i` of `n`. */
export const tree = (i: number, n: number) => (i === n - 1 ? "└─" : "├─");
/** Return the continuation indentation for item `i` of `n`. */
export const indent = (i: number, n: number) => (i === n - 1 ? "   " : "│  ");

// ── Tool Activity Formatting ─────────────────────────────────────────────

/** Pick the first non-empty arg value for display, preferring the named key then common fallbacks. */
function firstArg(
  args: Record<string, unknown>,
  primary: string,
  fallbacks: string[] = [],
): string | undefined {
  for (const key of [primary, ...fallbacks]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val;
  }
  return undefined;
}

/** Render a compact, terminal-safe, single-line summary of a tool call. */
export function formatToolCallShort(
  name: string,
  args: Record<string, unknown>,
): string {
  const safeName = sanitizeTerminalLine(name);
  if (!args || typeof args !== "object") return safeName;
  switch (name) {
    case "bash": {
      const cmd = sanitizeTerminalLine(firstArg(args, "command") ?? "...");
      const maxLen = 80;
      return `$ ${cmd.length > maxLen ? cmd.slice(0, maxLen) + "…" : cmd}`;
    }
    case "read": {
      const p = shortenPath(
        sanitizeTerminalLine(firstArg(args, "path", ["file_path"]) ?? "..."),
      );
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let line = `read ${p}`;
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "";
        line += `:${start}${end ? `-${end}` : ""}`;
      }
      return line;
    }
    case "write": {
      const p = shortenPath(
        sanitizeTerminalLine(firstArg(args, "path", ["file_path"]) ?? "..."),
      );
      const lines = String(args.content ?? "").split("\n").length;
      return `write ${p}${lines > 1 ? ` (${lines} lines)` : ""}`;
    }
    case "edit": {
      const p = shortenPath(
        sanitizeTerminalLine(firstArg(args, "path", ["file_path"]) ?? "..."),
      );
      return `edit ${p}`;
    }
    default: {
      // Try to pick a meaningful first arg before falling back to JSON.
      for (const key of [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "task",
        "prompt",
      ]) {
        const val = args[key];
        if (typeof val === "string" && val.trim()) {
          const safeValue = sanitizeTerminalLine(val);
          const preview =
            safeValue.length > 50 ? safeValue.slice(0, 50) + "…" : safeValue;
          return `${safeName} ${preview}`;
        }
      }
      try {
        const json = JSON.stringify(args);
        if (json === undefined) return safeName;
        const serialized = sanitizeTerminalLine(json);
        const preview = serialized.slice(0, 50);
        return `${safeName} ${preview}${serialized.length > 50 ? "…" : ""}`;
      } catch {
        return safeName;
      }
    }
  }
}

/**
 * A session file is *resumable* iff `resumeFrom` would accept it: the file
 * exists **and** contains at least one restorable message/custom_message entry
 * on the leaf path (i.e. `buildSessionContext().messages.length > 0`). A
 * header-only `.jsonl` — produced when a subagent's first model call dies
 * before emitting any assistant message and the failure path force-flushed the
 * header — is real on disk but rejected by `resumeFrom` with "empty session".
 * Advertising those as resumable sends the parent to a dead path.
 *
 * This reads the file but short-circuits at the first restorable entry; on the
 * failure path these files are typically tiny (header-only or near-empty).
 */
function isResumableSessionFile(sessionFile: string): boolean {
  if (!fs.existsSync(sessionFile)) return false;
  try {
    // Read line-by-line; a header-only file is one line. We only need to know
    // whether any message-bearing entry exists — matches the gate resumeFrom
    // applies (buildSessionContext().messages.length > 0) for the common case.
    const content = fs.readFileSync(sessionFile, "utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { type?: string };
        if (entry.type === "message" || entry.type === "custom_message") {
          return true;
        }
      } catch {
        /* skip malformed/trailing line */
      }
    }
  } catch {
    /* unreadable — treat as not resumable */
  }
  return false;
}

/** Shared LLM-facing warning for results returned before proven quiescence. */
export const INCOMPLETE_QUIESCENCE_WARNING =
  "[INCOMPLETE: quiescence was abandoned; output, file evidence, token usage, and cost are lower bounds while the quarantined session settles.]";

/**
 * Render a failed or aborted task's result lines for LLM consumption.
 *
 * Single source of truth used by both the sync (execute) and async
 * (formatCompletedTicket) render paths — previously this logic was duplicated
 * and the two copies had drifted into the same bug: reporting a sessionFile
 * path that didn't exist on disk.
 *
 * Emits:
 *   [FAILED|ABORTED: <error> · session: <shortpath> · touched (best-effort): <files>]
 *   <partial output, when available>
 *   → To retry: delegate({ tasks: [{ resumeFrom: "<path>", prompt: "continue" }] })
 *
 * When a sessionFile is present but not actually resumable (file absent, or a
 * header-only file that `resumeFrom` would reject as empty), emit an explicit
 * notice instead of a retry hint — so the parent model is told to re-dispatch
 * fresh rather than left to fabricate a path or chase a dead resume.
 */
export function formatFailedTask(
  r: TaskResult,
  cwd?: string,
  /** Dispatch-scoped snapshot for output-spill bounds; falls back to live
   *  config when unset (direct callers, legacy tests). */
  config?: import("./config.ts").DelegateConfig,
): string[] {
  const parts: string[] = [];
  if (r.incomplete === "quiescence_abandoned") {
    parts.push(INCOMPLETE_QUIESCENCE_WARNING);
  }
  const isAbort = r.failureKind === "cancelled";
  // Empty string is falsy but not nullish — `||` covers both undefined and "".
  const failParts = [r.error || "unknown error"];
  if (r.sessionFile) failParts.push(`session: ${shortenPath(r.sessionFile)}`);
  const touched = cwd ? relativeTouchedSummary(r.touchedFiles, cwd) : null;
  if (touched) failParts.push(`touched (best-effort): ${touched}`);
  parts.push(`[${isAbort ? "ABORTED" : "FAILED"}: ${failParts.join(" · ")}]`);

  // Surface partial assistant output even when the task did not complete.
  // Pass the dispatch-scoped spill bounds so a mid-task config change cannot
  // widen (or narrow) the partial output the parent sees — the bounds captured
  // when the task started are the ones the caller committed to.
  if (r.output && r.output !== "(no output)") {
    parts.push(
      renderOutputForLLM(r.output, r.agent, {
        thresholdChars: getOutputSpillThreshold(config),
        tailChars: getOutputSpillTail(config),
      }),
    );
  }

  if (r.sessionFile && isResumableSessionFile(r.sessionFile)) {
    const safePath = JSON.stringify(r.sessionFile);
    // A model-attributable failure (usage limit, auth, quota) is not transient
    // for the resolved model — point the parent at the `model` field so it
    // resumes the same conversation on a different model instead of retrying
    // the same wall or re-dispatching fresh (which loses the accumulated
    // context). createAgentSession honors an explicit `model` over the
    // session's stored model, so this works without any extra plumbing.
    if (r.failureKind === "model_error") {
      parts.push(
        `→ To retry with a different model: delegate({ tasks: [{ resumeFrom: ${safePath}, model: "<alt-model>", prompt: "continue" }] })`,
      );
    } else {
      parts.push(
        `→ To retry: delegate({ tasks: [{ resumeFrom: ${safePath}, prompt: "continue" }] })`,
      );
    }
  } else if (r.sessionFile) {
    parts.push(`[no resumable session — re-dispatch as a fresh task]`);
  }
  return parts;
}

/**
 * Render a single completed task's result lines for LLM consumption.
 *
 * Single source of truth for the per-task text block used by both the sync
 * (execute) and async (formatCompletedTicket) render paths. Encapsulates the
 * header line, task warnings, and the success/failure body — delegating
 * failure rendering to {@link formatFailedTask}.
 *
 * Emits:
 *   === <agent>: <truncated prompt> ===
 *   [WARNING: <w>]  (per warning, if any)
 *   [FAILED: ...] / [OK | <duration> | <tokens> tokens · <sessionFile> · touched (best-effort): <files>]
 *
 *   <output>  (success body only)
 *
 * The caller owns the ticket-level header ("X/Y tasks completed...") and any
 * PENDING handling — those differ between the sync and async paths.
 */
export function formatCompletedTask(
  task: ResolvedTask,
  result: TaskResult,
  /** Dispatch-scoped snapshot for output-spill bounds. */
  config?: import("./config.ts").DelegateConfig,
): string[] {
  const parts: string[] = [];
  // `|| task.sessionAction` covers action-only tasks (close/list/...) where prompt is
  // empty. Async prompt tasks always set prompt, so this is a no-op there.
  parts.push(
    `=== ${result.agent}${resumeMarker(result)}${formatTaskId(result.id ?? task.id)}: ${trunc(task.prompt || task.sessionAction || "", 80)} ===`,
  );
  if (task.warnings?.length) {
    for (const w of task.warnings) parts.push(`[WARNING: ${w}]`);
  }
  if (result.error) {
    parts.push(...formatFailedTask(result, task.cwd, config));
  } else {
    if (result.incomplete === "quiescence_abandoned") {
      parts.push(INCOMPLETE_QUIESCENCE_WARNING);
    }
    const meta = [
      `OK | ${fmtDuration(result.durationMs)} | ${taskTokenLabel(result)}`,
    ];
    if (result.sessionFile) meta.push(shortenPath(result.sessionFile));
    const touched = relativeTouchedSummary(result.touchedFiles, task.cwd);
    if (touched) meta.push(`touched (best-effort): ${touched}`);
    parts.push(
      `[${meta.join(" · ")}]\n\n${renderOutputForLLM(
        result.output,
        result.agent,
        {
          thresholdChars: getOutputSpillThreshold(config),
          tailChars: getOutputSpillTail(config),
        },
      )}`,
    );
  }
  if (result.integration) {
    const integration = result.integration;
    parts.push(
      `[INTEGRATION: ${integration.status} · proposed ${integration.proposedFiles.length} file(s) · applied ${integration.appliedFiles.length} file(s)]`,
    );
    if (integration.baselineRef)
      parts.push(`baseline ref: ${integration.baselineRef}`);
    if (integration.proposalRef)
      parts.push(`proposal ref: ${integration.proposalRef}`);
    if (integration.patchPath)
      parts.push(`full patch: ${integration.patchPath}`);
    if (integration.worktreePath)
      parts.push(`recovery worktree: ${integration.worktreePath}`);
    if (integration.status === "retained") {
      parts.push(`not applied: ${integration.reason}`);
    }
    for (const conflict of integration.conflicts ?? []) {
      parts.push(`conflict: ${conflict.path}: ${conflict.reason}`);
    }
    for (const issue of "classificationIssues" in integration
      ? (integration.classificationIssues ?? [])
      : []) {
      parts.push(
        `attribution classification issue: ${issue.path}: ${issue.reason}`,
      );
    }
    if (integration.cleanupIssue) {
      parts.push(
        `cleanup ${integration.cleanupIssue.status}: ${integration.cleanupIssue.reason}`,
      );
      if (integration.cleanupIssue.recoveryPath) {
        parts.push(
          `cleanup recovery path: ${integration.cleanupIssue.recoveryPath}`,
        );
      }
    }
    if (integration.status === "applied_unverified") {
      parts.push(
        'Changes were applied but not verified. Suggested next call: delegate({ tasks: [{ agent: "reviewer", workspace: "scratch", prompt: "Review the applied isolated changes and run the relevant tests." }] })',
      );
    }
  }
  return parts;
}

// ── Shared live-progress row helpers ───────────────────────────────────────
// These dedupe the per-task computations the LLM-facing poll view
// (ticket-format.ts) and the TUI branches (render-branches) both need. Each is
// pure over TaskProgress/TaskResult, so it tests without a renderer.

/** The in-flight tool activity (no result yet), or null — the "current thing
 *  this task is doing". Shared by the poll view's running line and the TUI's
 *  compact activity line. */
export function inFlightActivity(p: TaskProgress): ToolActivity | null {
  return p.activities.findLast((a) => !a.result) ?? null;
}

/** The latest activity for a task, whether in-flight or completed. */
export function latestActivity(p: TaskProgress): ToolActivity | null {
  return p.activities.at(-1) ?? null;
}

/** Human-readable label for the current or latest activity.
 *  - "write src/foo.ts" when a tool is in-flight (even if a later-started tool
 *    already finished under parallel execution)
 *  - "last: read src/bar.ts" after a tool completes and the model is thinking
 *  - "thinking" when no activity has been recorded yet */
export function formatActivityLabel(p: TaskProgress): string {
  const activity = inFlightActivity(p) ?? latestActivity(p);
  if (!activity) return "thinking";
  const call = sanitizeTerminalLine(
    formatToolCallShort(activity.name, activity.args),
  );
  if (!activity.result) return call;
  return `last: ${call}`;
}

/** Compact TUI activity label. Uses the same current/latest-activity selection
 *  as {@link formatActivityLabel} but adds elapsed time for in-flight tools and
 *  a completion/error icon for finished ones. */
export function compactActivity(p: TaskProgress): string {
  const activity = inFlightActivity(p) ?? latestActivity(p);
  if (!activity) return "thinking…";
  const call = sanitizeTerminalLine(
    formatToolCallShort(activity.name, activity.args),
  );
  if (!activity.result) {
    const toolAge = fmtDuration(Date.now() - activity.startTime);
    return `${call} | ${toolAge}`;
  }
  const icon = activity.result.isError ? "✗" : "✓";
  return `${call} ${icon}`;
}

/** Per-task stats core: [duration, tokens]. Callers append medium-specific
 *  extras (touched files; themed join). */
export function taskTokenLabel(
  result: Pick<TaskResult, "tokens" | "incomplete">,
): string {
  return result.incomplete === "quiescence_abandoned"
    ? `≥${fmtTokens(result.tokens)} tokens (incomplete)`
    : `${fmtTokens(result.tokens)} tokens`;
}

export function taskMetaBase(r: TaskResult): string[] {
  return [fmtDuration(r.durationMs), taskTokenLabel(r)];
}

/** Pending-task waiting label: "queued (N running)" at the concurrency cap,
 *  else "waiting…". Shared by the two TUI branches. */
export function waitingLabel(runningCount: number, cap: number): string {
  return runningCount >= cap ? `queued (${runningCount} running)` : "waiting…";
}

/** Touched-files summary relative to cwd ("src/a.ts, src/b.ts"), or null when
 *  none resolve under cwd. Was byte-for-byte duplicated in formatCompletedTask
 *  and ticket-format.ts. */
export function relativeTouchedSummary(
  files: string[],
  cwd: string,
): string | null {
  if (!files.length) return null;
  const rel = files
    .map((f) => path.relative(cwd, f))
    .filter((f) => f && !f.startsWith(".."));
  return rel.length ? rel.join(", ") : null;
}

/** Find absolute paths directly attributed to more than one task result.
 *
 *  Overlap is computed from {@link TaskResult.attributedFiles} (edit/write
 *  tool calls), not from {@link TaskResult.touchedFiles}, so concurrent tasks
 *  in the same repository do not fabricate false conflicts from shared
 *  repository-wide git snapshots. */
export function findTouchedOverlaps(
  results: readonly {
    attributedFiles?: string[];
    workspace?: WorkspaceMode;
  }[],
): string[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    for (const f of r.attributedFiles ?? []) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([file]) => file)
    .sort();
}

/**
 * Format a post-dispatch overlap warning, or null when there is no overlap.
 *
 * The warning is deliberately conservative: it only reports paths that two or
 * more tasks claimed to touch. It does NOT claim that disjoint touchedFiles
 * mean there was no conflict, and it does NOT claim filesystem isolation or
 * rollback.
 */
export function formatTouchedOverlapWarning(overlaps: string[]): string | null {
  if (!overlaps.length) return null;
  return `WARNING: These tasks reported touching the same file(s): ${overlaps.join(", ")}. Delegate does not isolate or serialize file access and does not roll back completed writes.`;
}

import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  fmtDuration,
  fmtTokens,
  formatTaskId,
  getActivityAge,
  indent,
  tree,
  trunc,
  truncLine,
  spinnerFrame,
  formatToolCallShort,
  previewOutputLine,
  waitingLabel,
} from "./format.ts";
import { stripAnsi, resolveCarriageReturn } from "./utils.ts";
import { getMaxConcurrent } from "./config.ts";
import type { TaskProgress, TaskResult } from "./types.ts";

/**
 * Render markdown output when a compatible host theme hook exists. If the host
 * does not expose `getMarkdownTheme`, return plain text lines as a safe fallback
 * so a single missing host hook cannot crash the renderer.
 */
function renderOutputLines(raw: string, width: number): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    if (typeof getMarkdownTheme !== "function") return trimmed.split("\n");
    const theme = getMarkdownTheme();
    if (typeof theme !== "object" || !theme) return trimmed.split("\n");
    const md = new Markdown(trimmed, 0, 0, theme as MarkdownTheme);
    return md.render(width);
  } catch (_error) {
    return trimmed.split("\n");
  }
}

/** Renderer state — the live subset of Pi's `ToolRenderContext.state`. */
export interface RenderState {
  startedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  [key: string]: unknown;
}

/** Shared inputs for the partial and final render branches. */
export interface BranchCtx {
  progress: TaskProgress[];
  taskResults: (TaskResult | { error: string })[];
  total: number;
  w: number;
  expanded: boolean;
  state: RenderState;
  theme: Theme;
  /** Mutated by the branch — caller seeds it and applies the line budget. */
  lines: string[];
  /** Async ticket id (only present for background-ticket results). */
  ticketId?: string;
  /** Async ticket status, when known, so the renderer can show cancelling/cancelled. */
  ticketStatus?: "running" | "cancelling" | "done" | "failed" | "cancelled";
  /** Actual batch wall time when no live render state is available. */
  elapsedMs?: number;
}

/** Helpers shared across both branches. `pushWarnings` mutates `lines`.
 *  Built by the caller via `makeRenderHelpers` (in render-result.ts) and
 *  passed in so both branches share one bound set. */
export interface RenderHelpers {
  statJoin: (parts: string[]) => string;
  modelLabel: (p: TaskProgress) => string;
  compactActivity: (p: TaskProgress) => string;
  pushWarnings: (p: TaskProgress, ind: string) => void;
}

/** Live (partial) progress tree — animated spinner, in-flight activity, live
 *  output previews, and a header with running/done counts. */
export function renderPartialBranch(ctx: BranchCtx, h: RenderHelpers): void {
  const { progress, total, w, expanded, state, theme, lines } = ctx;
  const { statJoin, modelLabel, compactActivity, pushWarnings } = h;

  const finished = progress.filter(
    (p) => p.status === "done" || p.status === "failed",
  ).length;
  const failed = progress.filter((p) => p.status === "failed").length;
  const running = progress.filter((p) => p.status === "running").length;
  const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);

  // Keep the live and final summaries in the same order so the header remains
  // easy to scan as a partial result resolves into its final form.
  const headerParts: string[] = [];
  if (running > 0) headerParts.push(`${running} running`);
  headerParts.push(`${finished}/${total} finished`);
  if (failed > 0) headerParts.push(`${failed} failed`);
  headerParts.push(`${fmtTokens(totalTokens)} tokens`);
  if (state.startedAt)
    headerParts.push(fmtDuration(Date.now() - state.startedAt));
  const stateLabel =
    ctx.ticketStatus === "cancelling"
      ? `${theme.fg("error", "■ cancelling")} · `
      : "";
  const detailHint =
    !expanded && running > 0
      ? ` · ${theme.fg("accent", "Ctrl+O expand")}`
      : "";
  lines.push(
    `${stateLabel}${theme.fg("muted", headerParts.join(" · "))}${detailHint}`,
    "",
  );

  for (let i = 0; i < total; i++) {
    const p = progress[i]!;
    const ind = indent(i, total);
    const runParts: string[] = [];
    if (p.toolUses > 0)
      runParts.push(`${p.toolUses} tool${p.toolUses > 1 ? "s" : ""}`);
    if (p.tokens > 0) runParts.push(`${fmtTokens(p.tokens)} tokens`);

    switch (p.status) {
      case "done":
        lines.push(
          truncLine(
            `${tree(i, total)} ${theme.fg("success", "✓")} ${theme.bold(p.agent)}${p.id ? theme.fg("accent", formatTaskId(p.id)) : ""}${theme.fg("muted", ` — ${p.task}`)}${expanded ? `${modelLabel(p)}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}` : ""}`,
            w,
          ),
        );
        if (expanded) {
          for (const activity of p.activities.slice(-3)) {
            const call = formatToolCallShort(activity.name, activity.args);
            const icon = activity.result?.isError
              ? theme.fg("error", "✗")
              : theme.fg("success", "✓");
            lines.push(
              truncLine(`${ind}${theme.fg("dim", `→ ${call}`)} ${icon}`, w),
            );
          }
        }
        break;
      case "failed":
        lines.push(
          truncLine(
            `${tree(i, total)} ${theme.fg("error", "✗")} ${theme.bold(p.agent)}${p.id ? theme.fg("accent", formatTaskId(p.id)) : ""}${theme.fg("muted", ` — ${p.task}`)}${expanded ? modelLabel(p) : ""}${p.error ? theme.fg("error", ` · ${p.error}`) : ""}`,
            w,
          ),
        );
        if (expanded) {
          for (const activity of p.activities.slice(-3)) {
            const call = formatToolCallShort(activity.name, activity.args);
            const icon = activity.result?.isError
              ? theme.fg("error", "✗")
              : theme.fg("success", "✓");
            lines.push(
              truncLine(`${ind}${theme.fg("dim", `→ ${call}`)} ${icon}`, w),
            );
          }
        }
        break;
      case "running":
        {
          const activityAge = getActivityAge(p.lastActivityAt);
          const ageTag = activityAge ? ` · ${activityAge}` : "";
          const issueTag =
            p.failureKind === "deadline_exceeded"
              ? theme.fg("error", " · deadline exceeded · cancellation pending")
              : p.failureKind === "stalled"
                ? theme.fg(
                    "warning",
                    " · stall detected · cancellation pending",
                  )
                : "";
          const glyph = theme.fg("warning", spinnerFrame());
          lines.push(
            truncLine(
              `${tree(i, total)} ${glyph} ${theme.bold(p.agent)}${p.id ? theme.fg("accent", formatTaskId(p.id)) : ""}${theme.fg("muted", ` — ${p.task}`)}${expanded ? `${modelLabel(p)}${statJoin(runParts)}` : ""}${issueTag}${theme.fg("dim", ageTag)}`,
              w,
            ),
          );

          if (expanded) {
            // ── Expanded: recent activity history (like done/failed) ──
            if (p.activities.length > 0) {
              for (const activity of p.activities.slice(-5)) {
                const call = formatToolCallShort(activity.name, activity.args);
                if (!activity.result) {
                  // In-flight
                  const elapsed = ` | ${fmtDuration(Date.now() - activity.startTime)}`;
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("warning", "›")} ${call}${theme.fg("dim", elapsed)}`,
                      w,
                    ),
                  );
                  // Show live stdout/stderr preview for streaming tools
                  if (activity.liveOutput) {
                    const clean = stripAnsi(
                      resolveCarriageReturn(activity.liveOutput),
                    );
                    const preview = clean
                      .split("\n")
                      .filter((l) => l.trim())
                      .slice(-3);
                    for (const outLine of preview) {
                      lines.push(
                        truncLine(
                          `${ind}  ${theme.fg("toolOutput", outLine)}`,
                          w,
                        ),
                      );
                    }
                  }
                } else {
                  const icon = activity.result.isError
                    ? theme.fg("error", "✗")
                    : theme.fg("success", "✓");
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("dim", `→ ${call}`)} ${icon}`,
                      w,
                    ),
                  );
                }
              }
            } else {
              lines.push(
                truncLine(`${ind}${theme.fg("dim", "  thinking…")}`, w),
              );
            }
          } else {
            // ── Collapsed: compact tool line with duration ─────
            // The Ctrl+O affordance lives once in the header now — emitting
            // it per task just repeats the same hint for every running agent.
            lines.push(
              truncLine(
                `${ind}${theme.fg("warning", "›")} ${compactActivity(p)}`,
                w,
              ),
            );
          }
        }
        break;
      default: {
        // how many slots are occupied so a human sees throttling, not a stall.
        // Pending / waiting. When the concurrency cap is the reason, show
        const queuedTag = theme.fg(
          "muted",
          ` ${waitingLabel(running, getMaxConcurrent())}`,
        );
        lines.push(
          truncLine(
            `${tree(i, total)} ${theme.fg("muted", "○")} ${theme.bold(p.agent)}${p.id ? theme.fg("accent", formatTaskId(p.id)) : ""}${theme.fg("muted", ` — ${p.task}`)}${expanded ? modelLabel(p) : ""}${queuedTag}`,
            w,
          ),
        );
      }
    }
    pushWarnings(p, ind);
  }
}

/** Final (or async-ticket poll) view — static status glyphs, output previews,
 *  markdown rendering in expanded mode, and the ticket banner for live
 *  background tickets. */
export function renderFinalBranch(ctx: BranchCtx, h: RenderHelpers): void {
  const { progress, taskResults, total, w, expanded, state, theme, lines } =
    ctx;
  const { statJoin, modelLabel, compactActivity, pushWarnings } = h;

  // Also covers async dispatch + poll of a *running* ticket: those return
  // details.progress with non-terminal (pending/running) statuses. The
  // partial branch isn't used for them (execute has already returned), so
  // this branch must render every status. A ticket banner is shown when
  // details.ticketId is present so the human sees this is background work.
  const succeeded = progress.filter((p) => p.status === "done").length;
  const failed = progress.filter((p) => p.status === "failed").length;
  const finalized = succeeded + failed;
  const running = progress.filter((p) => p.status === "running").length;
  const pending = progress.filter((p) => p.status === "pending").length;
  const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);
  const ticketId = ctx.ticketId;
  const ticketStatus = ctx.ticketStatus;
  // A terminal ticket can retain a stale running/pending row while its workers
  // unwind. Keep the row presentation terminal in that case; an absent status
  // is the synchronous-render path, where task status remains authoritative.
  const ticketIsLive =
    ticketStatus === undefined ||
    ticketStatus === "running" ||
    ticketStatus === "cancelling";
  const elapsed =
    ctx.elapsedMs !== undefined
      ? fmtDuration(ctx.elapsedMs)
      : state.startedAt
        ? fmtDuration(Date.now() - state.startedAt)
        : fmtDuration(progress.reduce((sum, p) => sum + p.durationMs, 0));

  const ticketLabel = ticketId ? `ticket ${ticketId} · ` : "";
  const detailHint = !expanded
    ? ` · ${theme.fg("accent", "Ctrl+O expand")}`
    : "";
  if (ticketId && ticketIsLive && finalized < total) {
    // Background ticket — frame it as in-progress, not a finished result.
    const ticketParts = [`${finalized}/${total} finished`];
    if (running > 0) ticketParts.push(`${running} active`);
    if (pending > 0) ticketParts.push(`${pending} queued`);
    if (failed > 0) ticketParts.push(`${failed} failed`);
    const glyph =
      ticketStatus === "cancelling"
        ? theme.fg("error", "■")
        : theme.fg("warning", "◐");
    const stateLabel =
      ticketStatus === "cancelling"
        ? ` ${theme.fg("error", "cancelling")}`
        : "";
    lines.push(
      `${glyph}${stateLabel} ${theme.fg("muted", `${ticketLabel}${ticketParts.join(" · ")}`)}${detailHint}`,
      "",
    );
  } else {
    const headerParts = [`${finalized}/${total} finished`];
    if (failed > 0) headerParts.push(`${failed} failed`);
    headerParts.push(`${fmtTokens(totalTokens)} tokens`, elapsed);
    const glyph =
      ticketStatus === "cancelled" || ticketStatus === "failed" || failed > 0
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
    lines.push(
      `${glyph} ${theme.fg("muted", `${ticketLabel}${headerParts.join(" · ")}`)}${detailHint}`,
      "",
    );
  }

  for (let i = 0; i < total; i++) {
    const p = progress[i]!;
    const r = taskResults[i];
    const ind = indent(i, total);
    const isCancelledPending =
      ticketStatus === "cancelled" && p.status === "pending";
    const isTerminalUnfinished =
      !ticketIsLive && (p.status === "running" || p.status === "pending");

    // Unified status glyphs: ✓ done, ✗ failed, ◐ running, ○ pending.
    // Unfinished rows on terminal tickets show as failed so stale progress is
    // never mistaken for work that is still running or queued.
    const icon = isCancelledPending || isTerminalUnfinished
      ? theme.fg("error", "✗")
      : p.status === "done"
        ? theme.fg("success", "✓")
        : p.status === "failed"
          ? theme.fg("error", "✗")
          : p.status === "running"
            ? theme.fg("warning", "◐")
            : theme.fg("muted", "○");
    const taskId = p.id ? formatTaskId(p.id) : "";
    const taskIdTag = p.id ? theme.fg("accent", taskId) : "";
    const taskIdWidth = p.id ? taskId.length : 0;
    const previewBudget = Math.max(1, w - 30 - taskIdWidth);
    const taskPreview = theme.fg("muted", ` — ${trunc(p.task, previewBudget)}`);
    const isLive =
      ticketIsLive &&
      (p.status === "running" ||
        (p.status === "pending" && !isCancelledPending));
    // Live tasks show an activity/waiting hint instead of final stats.
    const liveTail =
      p.status === "pending" && !isCancelledPending
          ? theme.fg("muted", ` ${waitingLabel(running, getMaxConcurrent())}`)
          : "";
    const cancelledTail = isCancelledPending
      ? theme.fg("error", " · CANCELLED")
      : "";
    lines.push(
      truncLine(
        `${tree(i, total)} ${icon} ${theme.bold(p.agent)}${taskIdTag}${taskPreview}${expanded ? modelLabel(p) : ""}${isLive ? liveTail : cancelledTail || (expanded ? statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`]) : "")}`,
        w,
      ),
    );

    if (isLive && p.status === "running") {
      lines.push(
        truncLine(
          `${ind}${theme.fg("warning", "›")} ${compactActivity(p)}`,
          w,
        ),
      );
    }

    // Warnings (e.g. unknown tools ignored) — muted line under the task.
    pushWarnings(p, ind);

    // Tool activities: compact summary only in expanded mode, terminal tasks only.
    if (p.activities.length > 0 && expanded && !isLive) {
      const names = p.activities
        .map((a) => a.name)
        .filter((n, i, arr) => arr.indexOf(n) === i);
      const nameList =
        names.slice(0, 4).join(", ") +
        (names.length > 4 ? ` +${names.length - 4}` : "");
      const okCount = p.activities.filter(
        (a) => a.result && !a.result.isError,
      ).length;
      const errCount = p.activities.filter((a) => a.result?.isError).length;
      const statusParts: string[] = [];
      if (okCount > 0) statusParts.push(`${okCount} ✓`);
      if (errCount > 0) statusParts.push(`${errCount} ✗`);
      const status = statusParts.length ? ` · ${statusParts.join(", ")}` : "";
      lines.push(
        truncLine(
          `${ind}${theme.fg("dim", `${p.activities.length} tool${p.activities.length > 1 ? "s" : ""}: ${nameList}${status}`)}`,
          w,
        ),
      );
    }

    // Surface errors even when output exists (agent may have emitted text before failing).
    // Live tasks and cancelled-but-not-started tasks already show their status
    // on the row, so don't duplicate it as an error line.
    if (!isLive && !isCancelledPending && r && "error" in r && r.error) {
      lines.push(truncLine(`${ind}${theme.fg("error", r.error)}`, w));
    }
    if (r && "integration" in r && r.integration) {
      const integration = r.integration;
      const tone =
        integration.status === "applied_unverified" ||
        integration.status === "no_changes"
          ? "warning"
          : "error";
      lines.push(
        truncLine(
          `${ind}${theme.fg(tone, `integration: ${integration.status} · ${integration.appliedFiles.length}/${integration.proposedFiles.length} files applied`)}`,
          w,
        ),
      );
      if (expanded) {
        if (integration.patchPath)
          lines.push(
            truncLine(
              `${ind}${theme.fg("dim", `patch: ${integration.patchPath}`)}`,
              w,
            ),
          );
        if (integration.worktreePath)
          lines.push(
            truncLine(
              `${ind}${theme.fg("dim", `worktree: ${integration.worktreePath}`)}`,
              w,
            ),
          );
      }
    }
    // Collapsed: one-line output preview so a human scanning the TUI sees
    // the payoff without expanding every task. Expanded mode renders the
    // full markdown below instead.
    if (!expanded && p.status === "done") {
      const preview =
        r && "output" in r
          ? previewOutputLine(r.output ?? "", w - ind.length - 3)
          : "";
      if (preview) {
        lines.push(
          truncLine(`${ind}${theme.fg("success", "⎿")} ${preview}`, w),
        );
      }
    }
    // Output: render markdown only in expanded mode.
    if (
      r &&
      "output" in r &&
      r.output?.trim() &&
      r.output !== "(no output)" &&
      expanded
    ) {
      const cacheKey = `md_${i}_${expanded ? "exp" : "col"}_${w - ind.length}`;
      let mdLines: string[] | undefined = state[cacheKey] as
        string[] | undefined;
      if (!mdLines || state[`${cacheKey}_src`] !== r.output) {
        mdLines = renderOutputLines(r.output, Math.max(20, w - ind.length));
        state[`${cacheKey}_src`] = r.output;
        state[cacheKey] = mdLines;
      }
      for (const line of mdLines) {
        lines.push(truncLine(ind + line, w));
      }
    }
    // Visual separator between tasks — only in expanded mode.
    if (expanded) lines.push("");
  }
}

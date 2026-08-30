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
  taskTokenLabel,
  waitingLabel,
  resumeMarker,
} from "./format.ts";
import {
  resolveCarriageReturn,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  stripAnsi,
} from "./utils.ts";
import { getMaxConcurrent } from "./config.ts";
import { toolExpandHint } from "./key-hints.ts";
import type { TaskProgress, TaskResult } from "./types.ts";

/**
 * Render markdown output when a compatible host theme hook exists. If the host
 * does not expose `getMarkdownTheme`, return plain text lines as a safe fallback
 * so a single missing host hook cannot crash the renderer.
 */
function renderOutputLines(raw: string, width: number): string[] {
  const trimmed = sanitizeTerminalText(raw).trim();
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
  const hasIncomplete = progress.some((p) => p.incomplete !== undefined);

  // Keep the live and final summaries in the same order so the header remains
  // easy to scan as a partial result resolves into its final form.
  const headerParts: string[] = [];
  if (running > 0) headerParts.push(`${running} running`);
  headerParts.push(`${finished}/${total} finished`);
  if (failed > 0) headerParts.push(`${failed} failed`);
  headerParts.push(
    hasIncomplete
      ? `≥${fmtTokens(totalTokens)} tokens · incomplete accounting/evidence`
      : `${fmtTokens(totalTokens)} tokens`,
  );
  if (state.startedAt)
    headerParts.push(fmtDuration(Date.now() - state.startedAt));
  const stateLabel =
    ctx.ticketStatus === "cancelling"
      ? `${theme.fg("error", "■ cancelling")} · `
      : "";
  const expandHint = toolExpandHint();
  const detailHint =
    !expanded && running > 0 && expandHint
      ? ` · ${theme.fg("accent", expandHint)}`
      : "";
  lines.push(
    `${stateLabel}${theme.fg("muted", headerParts.join(" · "))}${detailHint}`,
    "",
  );

  for (let i = 0; i < total; i++) {
    const p = progress[i]!;
    const ind = indent(i, total);
    const agent = sanitizeTerminalLine(p.agent);
    const task = sanitizeTerminalLine(p.task);
    const taskId = formatTaskId(p.id);
    const taskIdTag = taskId ? theme.fg("accent", taskId) : "";
    // Revival marker: a resumed row must never read as a fresh spawn. Empty
    // when the identity already carries the resume label (omitted-agent
    // resumes resolve to `resume:<tag>` at task resolution).
    const resumeMarkRaw = resumeMarker(p);
    const resumeMark = resumeMarkRaw ? theme.fg("warning", resumeMarkRaw) : "";
    const runParts: string[] = [];
    if (p.toolUses > 0)
      runParts.push(`${p.toolUses} tool${p.toolUses > 1 ? "s" : ""}`);
    if (p.tokens > 0) runParts.push(`${fmtTokens(p.tokens)} tokens`);

    switch (p.status) {
      case "done":
        lines.push(
          truncLine(
            `${tree(i, total)} ${theme.fg("success", "✓")} ${theme.bold(agent)}${resumeMark}${taskIdTag}${theme.fg("muted", ` — ${task}`)}${expanded ? `${modelLabel(p)}${statJoin([fmtDuration(p.durationMs), taskTokenLabel(p)])}` : ""}`,
            w,
          ),
        );
        if (expanded) {
          for (const activity of p.activities.slice(-3)) {
            const call = sanitizeTerminalLine(
              formatToolCallShort(activity.name, activity.args),
            );
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
            `${tree(i, total)} ${theme.fg("error", "✗")} ${theme.bold(agent)}${resumeMark}${taskIdTag}${theme.fg("muted", ` — ${task}`)}${expanded ? modelLabel(p) : ""}${p.error ? theme.fg("error", ` · ${sanitizeTerminalLine(p.error)}`) : ""}`,
            w,
          ),
        );
        if (expanded) {
          for (const activity of p.activities.slice(-3)) {
            const call = sanitizeTerminalLine(
              formatToolCallShort(activity.name, activity.args),
            );
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
              `${tree(i, total)} ${glyph} ${theme.bold(agent)}${resumeMark}${taskIdTag}${theme.fg("muted", ` — ${task}`)}${expanded ? `${modelLabel(p)}${statJoin(runParts)}` : ""}${issueTag}${theme.fg("dim", ageTag)}`,
              w,
            ),
          );

          if (expanded) {
            // ── Expanded: recent activity history (like done/failed) ──
            if (p.activities.length > 0) {
              for (const activity of p.activities.slice(-5)) {
                const call = sanitizeTerminalLine(
                  formatToolCallShort(activity.name, activity.args),
                );
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
                    const clean = resolveCarriageReturn(
                      stripAnsi(activity.liveOutput),
                    );
                    const preview = clean
                      .split("\n")
                      .map(sanitizeTerminalLine)
                      .filter(Boolean)
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
            // The host-configured expand affordance lives once in the header;
            // emitting it per task repeats the hint for every running agent.
            lines.push(
              truncLine(
                `${ind}${theme.fg("warning", "›")} ${sanitizeTerminalLine(compactActivity(p))}`,
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
            `${tree(i, total)} ${theme.fg("muted", "○")} ${theme.bold(agent)}${resumeMark}${taskIdTag}${theme.fg("muted", ` — ${task}`)}${expanded ? modelLabel(p) : ""}${queuedTag}`,
            w,
          ),
        );
      }
    }
    pushWarnings(p, ind);
  }
}

function hasUserCancellationMarker(
  progress: TaskProgress,
  result: TaskResult | { error: string } | undefined,
): boolean {
  if (progress.failureKind === "cancelled") return true;
  return (
    result !== undefined &&
    "failureKind" in result &&
    result.failureKind === "cancelled"
  );
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
  const cancelled = progress.filter(
    (p, index) =>
      p.status === "failed" && hasUserCancellationMarker(p, taskResults[index]),
  ).length;
  const failed = progress.filter(
    (p, index) =>
      p.status === "failed" &&
      !hasUserCancellationMarker(p, taskResults[index]),
  ).length;
  const finalized = succeeded + failed + cancelled;
  const running = progress.filter((p) => p.status === "running").length;
  const pending = progress.filter((p) => p.status === "pending").length;
  const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);
  const hasIncomplete = progress.some((p) => p.incomplete !== undefined);
  const ticketId = ctx.ticketId;
  const ticketStatus = ctx.ticketStatus;
  // A terminal ticket can retain a stale running/pending row while its workers
  // unwind. Keep the row presentation terminal in that case; an absent status
  // is the synchronous-render path, where task status remains authoritative.
  const ticketIsLive =
    ticketStatus === undefined ||
    ticketStatus === "running" ||
    ticketStatus === "cancelling";
  // Terminal tickets render stale running/pending rows with a terminal glyph.
  // A caller-aborted task retains a structured cancellation marker after
  // settling; count it as cancelled rather than as a generic failure. Provider
  // failures whose human-facing text happens to be "Aborted" remain failures.
  const terminalUnfinished = ticketIsLive ? 0 : running + pending;
  const terminalFinalized = finalized + terminalUnfinished;
  const terminalCancelled =
    cancelled + (ticketStatus === "cancelled" ? terminalUnfinished : 0);
  const terminalFailed =
    failed + (ticketStatus === "cancelled" ? 0 : terminalUnfinished);
  const ticketWasCancelled = ticketStatus === "cancelled";
  let elapsed: string | undefined;
  if (ctx.elapsedMs !== undefined) {
    elapsed = fmtDuration(ctx.elapsedMs);
  } else if (state.startedAt !== undefined) {
    elapsed = fmtDuration(Date.now() - state.startedAt);
  }

  const safeTicketId = ticketId ? sanitizeTerminalLine(ticketId) : "";
  const ticketLabel = safeTicketId ? `ticket ${safeTicketId} · ` : "";
  const expandHint = toolExpandHint();
  const detailHint =
    !expanded && expandHint ? ` · ${theme.fg("accent", expandHint)}` : "";
  if (ticketId && ticketIsLive) {
    // Background ticket — frame it as in-progress, not a finished result.
    const ticketParts = [`${finalized}/${total} finished`];
    if (running > 0) ticketParts.push(`${running} active`);
    if (pending > 0) ticketParts.push(`${pending} queued`);
    if (failed > 0) ticketParts.push(`${failed} failed`);
    if (cancelled > 0) ticketParts.push(`${cancelled} cancelled`);
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
    const headerParts = [`${terminalFinalized}/${total} finished`];
    if (terminalFailed > 0) headerParts.push(`${terminalFailed} failed`);
    if (terminalCancelled > 0)
      headerParts.push(`${terminalCancelled} cancelled`);
    // Cancellation is a ticket-level outcome even when every worker returned a
    // normal terminal row. Keep it distinct from actual failed-row counts.
    if (ticketWasCancelled) headerParts.push("ticket cancelled");
    headerParts.push(
      hasIncomplete
        ? `≥${fmtTokens(totalTokens)} tokens · incomplete accounting/evidence`
        : `${fmtTokens(totalTokens)} tokens`,
    );
    if (elapsed) headerParts.push(elapsed);
    const glyph =
      ticketStatus === "cancelled" ||
      ticketStatus === "failed" ||
      terminalFailed > 0 ||
      terminalCancelled > 0
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
    const agent = sanitizeTerminalLine(p.agent);
    const task = sanitizeTerminalLine(p.task);
    const isTerminalUnfinished =
      !ticketIsLive && (p.status === "running" || p.status === "pending");
    const isCancelledUnfinished =
      ticketStatus === "cancelled" && isTerminalUnfinished;
    const isCancelledResult =
      p.status === "failed" && hasUserCancellationMarker(p, r);
    const isCancelledTask = isCancelledUnfinished || isCancelledResult;

    // Unified status glyphs: ✓ done, ✗ failed/cancelled, ◐ running, ○ pending.
    // Terminal unfinished rows never retain a live glyph; their tail identifies
    // cancellation separately from failure.
    let icon: string;
    if (isTerminalUnfinished) {
      icon = theme.fg("error", "✗");
    } else if (p.status === "done") {
      icon = theme.fg("success", "✓");
    } else if (p.status === "failed") {
      icon = theme.fg("error", "✗");
    } else if (p.status === "running") {
      icon = theme.fg("warning", "◐");
    } else {
      icon = theme.fg("muted", "○");
    }
    const taskId = formatTaskId(p.id);
    const taskIdTag = taskId ? theme.fg("accent", taskId) : "";
    const taskIdWidth = taskId.length;
    // Revival marker: a resumed row must never read as a fresh spawn. Empty
    // when the identity already carries the resume label (omitted-agent
    // resumes resolve to `resume:<tag>` at task resolution).
    const resumeMarkRaw = resumeMarker(p);
    const resumeMark = resumeMarkRaw ? theme.fg("warning", resumeMarkRaw) : "";
    const previewBudget = Math.max(1, w - 30 - taskIdWidth);
    const taskPreview = theme.fg("muted", ` — ${trunc(task, previewBudget)}`);
    const isLive =
      ticketIsLive && (p.status === "running" || p.status === "pending");
    // Live tasks show an activity/waiting hint instead of final stats.
    const liveTail =
      p.status === "pending"
        ? theme.fg("muted", ` ${waitingLabel(running, getMaxConcurrent())}`)
        : "";
    const cancelledTail = isCancelledTask
      ? theme.fg("error", " · CANCELLED")
      : "";
    lines.push(
      truncLine(
        `${tree(i, total)} ${icon} ${theme.bold(agent)}${resumeMark}${taskIdTag}${taskPreview}${expanded ? modelLabel(p) : ""}${isLive ? liveTail : cancelledTail || (expanded ? statJoin([fmtDuration(p.durationMs), taskTokenLabel(p)]) : "")}`,
        w,
      ),
    );

    if (isLive && p.status === "running") {
      lines.push(
        truncLine(
          `${ind}${theme.fg("warning", "›")} ${sanitizeTerminalLine(compactActivity(p))}`,
          w,
        ),
      );
    }

    // Warnings (e.g. scratch-workspace notices, ignored model suffix) — muted
    // line under the task.
    pushWarnings(p, ind);

    // Tool activities: compact summary only in expanded mode, terminal tasks only.
    if (p.activities.length > 0 && expanded && !isLive) {
      const names = p.activities
        .map((a) => sanitizeTerminalLine(a.name))
        .filter(Boolean)
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

    if (
      !isLive &&
      ((r && "incomplete" in r && r.incomplete === "quiescence_abandoned") ||
        p.incomplete === "quiescence_abandoned")
    ) {
      lines.push(
        truncLine(
          `${ind}${theme.fg("warning", "INCOMPLETE: accounting and output/file evidence are lower bounds; session quarantined")}`,
          w,
        ),
      );
    }

    // Surface errors even when output exists (agent may have emitted text before failing).
    // Live and cancelled tasks already show their status on the row, so don't
    // duplicate it as an error line.
    if (!isLive && !isCancelledTask && r && "error" in r && r.error) {
      const error = sanitizeTerminalLine(r.error);
      if (error) lines.push(truncLine(`${ind}${theme.fg("error", error)}`, w));
    }
    if (r && "integration" in r && r.integration) {
      const integration = r.integration;
      const tone =
        integration.status === "applied_unverified" ||
        integration.status === "no_changes" ||
        integration.status === "retained"
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
              `${ind}${theme.fg("dim", `patch: ${sanitizeTerminalLine(integration.patchPath)}`)}`,
              w,
            ),
          );
        if (integration.worktreePath)
          lines.push(
            truncLine(
              `${ind}${theme.fg("dim", `worktree: ${sanitizeTerminalLine(integration.worktreePath)}`)}`,
              w,
            ),
          );
        if (integration.cleanupIssue) {
          lines.push(
            truncLine(
              `${ind}${theme.fg("error", `cleanup ${integration.cleanupIssue.status}: ${sanitizeTerminalLine(integration.cleanupIssue.reason)}`)}`,
              w,
            ),
          );
          if (integration.cleanupIssue.recoveryPath) {
            lines.push(
              truncLine(
                `${ind}${theme.fg("dim", `cleanup recovery: ${sanitizeTerminalLine(integration.cleanupIssue.recoveryPath)}`)}`,
                w,
              ),
            );
          }
        }
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

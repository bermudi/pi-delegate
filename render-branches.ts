import { Markdown } from "@mariozechner/pi-tui";
import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import {
  fmtDuration,
  fmtTokens,
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

  const done = progress.filter(
    (p) => p.status === "done" || p.status === "failed",
  ).length;
  const running = progress.filter((p) => p.status === "running").length;
  const elapsed = state.startedAt
    ? ` · ${fmtDuration(Date.now() - state.startedAt)}`
    : "";

  // Richer header: agent counts + wall time. The Ctrl+O affordance is
  // tool-scoped in Pi, so a single header hint suffices — one per running
  // task just repeats the same line N times.
  const headerParts: string[] = [];
  if (running > 0) headerParts.push(`${running} running`);
  headerParts.push(`${done}/${total} done`);
  if (!expanded && running > 0)
    headerParts.push(theme.fg("accent", "Ctrl+O for detail"));
  lines.push(theme.fg("muted", `${headerParts.join(" · ")}${elapsed}`), "");

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
            `${tree(i, total)} ${theme.fg("success", "✓")} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`,
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
              truncLine(`${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`, w),
            );
          }
        }
        break;
      case "failed":
        lines.push(
          truncLine(
            `${tree(i, total)} ${theme.fg("error", "✗")} ${theme.bold(p.agent)}${modelLabel(p)}${p.error ? theme.fg("error", ` ${p.error}`) : ""}`,
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
              truncLine(`${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`, w),
            );
          }
        }
        break;
      case "running":
        {
          const activityAge = getActivityAge(p.lastActivityAt);
          const ageTag = activityAge ? ` · ${activityAge}` : "";
          const glyph = theme.fg("warning", spinnerFrame());
          lines.push(
            truncLine(
              `${tree(i, total)} ${glyph} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin(runParts)}${theme.fg("muted", ageTag)}`,
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
                      `${ind}${theme.fg("warning", `> ${call}${elapsed}`)}`,
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
                      `${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`,
                      w,
                    ),
                  );
                }
              }
            } else {
              lines.push(
                truncLine(`${ind}${theme.fg("muted", "  thinking…")}`, w),
              );
            }
          } else {
            // ── Collapsed: compact tool line with duration ─────
            // The Ctrl+O affordance lives once in the header now — emitting
            // it per task just repeats the same hint for every running agent.
            lines.push(
              truncLine(
                `${ind}${theme.fg("muted", `⎿  ${compactActivity(p)}`)}`,
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
            `${tree(i, total)} ${theme.fg("muted", "○")} ${theme.bold(p.agent)}${modelLabel(p)} ${queuedTag}`,
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
  const hasLiveTasks = progress.some(
    (p) => p.status === "running" || p.status === "pending",
  );
  const ticketId = ctx.ticketId;
  const elapsed = state.startedAt
    ? fmtDuration(Date.now() - state.startedAt)
    : fmtDuration(progress.reduce((sum, p) => sum + p.durationMs, 0));

  if (ticketId && hasLiveTasks) {
    // Background ticket — frame it as in-progress, not a finished result.
    const ticketParts = [
      `ticket ${ticketId}`,
      `${finalized}/${total} finalized`,
    ];
    if (running > 0) ticketParts.push(`${running} active`);
    if (pending > 0) ticketParts.push(`${pending} queued`);
    if (failed > 0) ticketParts.push(`${failed} failed`);
    ticketParts.push("running in background");
    lines.push(theme.fg("warning", `⏳ ${ticketParts.join(" · ")}`), "");
  } else {
    lines.push(
      theme.fg(
        "muted",
        `${succeeded}/${total} completed · ${elapsed} wall · ${fmtTokens(totalTokens)} tokens`,
      ),
      "",
    );
  }

  for (let i = 0; i < total; i++) {
    const p = progress[i]!;
    const r = taskResults[i];
    const ind = indent(i, total);
    // Unified status glyphs: ✓ done, ✗ failed, ◐ running, ○ pending.
    // (The live partial branch uses an animated spinner for running; this
    // static final/ticket view can't animate, so a fixed glyph is right.)
    const icon =
      p.status === "done"
        ? theme.fg("success", "✓")
        : p.status === "failed"
          ? theme.fg("error", "✗")
          : p.status === "running"
            ? theme.fg("warning", "◐")
            : theme.fg("muted", "○");
    const taskPreview = theme.fg("muted", trunc(p.task, w - 30));
    const isLive = p.status === "running" || p.status === "pending";
    // Live tasks show an activity/waiting hint instead of final stats.
    const liveTail =
      p.status === "running"
        ? theme.fg("muted", ` · ${compactActivity(p)}`)
        : p.status === "pending"
          ? theme.fg("muted", ` ${waitingLabel(running, getMaxConcurrent())}`)
          : "";
    lines.push(
      truncLine(
        `${tree(i, total)} ${icon} ${theme.bold(p.agent)}${modelLabel(p)} ${taskPreview}${isLive ? liveTail : statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`,
        w,
      ),
    );

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
          `${ind}${theme.fg("muted", `${p.activities.length} tool${p.activities.length > 1 ? "s" : ""}: ${nameList}${status}`)}`,
          w,
        ),
      );
    }

    // Surface errors even when output exists (agent may have emitted text before failing).
    // Live tasks carry placeholder { error: "PENDING..." } results; do not render those as errors.
    if (!isLive && r && "error" in r && r.error) {
      lines.push(truncLine(`${ind}${theme.fg("error", r.error)}`, w));
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
        lines.push(truncLine(`${ind}${theme.fg("muted", `⎿ ${preview}`)}`, w));
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
        const md = new Markdown(r.output.trim(), 0, 0, getMarkdownTheme());
        mdLines = md.render(Math.max(20, w - ind.length));
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

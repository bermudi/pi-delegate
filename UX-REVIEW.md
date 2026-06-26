# UX Review — Delegate Tool

**Status:** Filed — task breakdown below
**Date:** 2026-06-26
**Scope:** TUI rendering (`extension.ts`), async/poll path, tool discovery

---

## Review

This extension has two audiences: the **human in the Pi TUI** and the **parent agent** reading tool results. The design is strongest on the TUI side — progressive disclosure, live progress, and terminal safety are all thoughtful. The main gaps are discoverability, consistency between sync/async/poll paths, and a few places where the human sees less than the model does.

### What works well

**Progressive disclosure in the TUI.** The collapsed/expanded split is the standout pattern: collapsed running mode shows the agent tree + current tool + a `Ctrl+O` hint; expanded mode shows activity history, live bash output (last 3 lines), and in-flight durations. `renderCall` stays minimal (`delegate 3 tasks · 12.4s`) so long prompts don't bloat the transcript — detail lives in `renderResult`, avoiding duplicate trees when Pi stacks call + result.

**Live progress feels alive.** 80ms spinner cadence (vs 1s before), per-task tree (`├─` / `└─`) for parallel work, `formatToolCallShort` for readable activity (`read src/foo.ts`, `$ cargo build`), live stdout preview with carriage-return normalization, and activity-staleness tags (`active 5s ago`) that surface stuck agents.

**Terminal safety.** `truncLine` handles ANSI, wide chars, and emoji. `applyLineBudget` caps at ~40% of terminal height with a clear overflow message (`… N lines hidden · Ctrl+O expands`) — the right tradeoff for a tool that can spawn many parallel agents.

**Error and retry UX (LLM-facing).** `formatFailedTask` is a good pattern: one source of truth, resumable-session detection, and explicit "re-dispatch fresh" when resume isn't viable. Reduces parent-model hallucination of bad `resumeFrom` paths.

**Help mode.** Empty `tasks: []` returns a thorough manual — agent list, field reference, session pooling, async mode, gotchas. Unknown-agent errors point back to it. Solid for agent discoverability.

### Friction points

1. **Collapsed completion hides the payoff (High — human).** After a sync delegate finishes, collapsed mode shows status lines but no subagent output, touched files, or session path. `extension.ts:1113` renders markdown only when `options.expanded`. Errors surface collapsed; success content does not. The parent model gets full output in `content`, but a human scanning the TUI sees only `✓ scout investigate auth…` and misses the actual findings unless they expand every task. Suggestion: a 1–2 line truncated preview (first non-empty paragraph) in collapsed final mode, or a `⎿ N lines · Ctrl+O` affordance like the running state.

2. **Async mode has no rich TUI (High — human).** `async: true` returns immediately with ticket ID and poll/cancel instructions as plain text. No `progress` in `details`, so `renderResult` falls through to raw content (`extension.ts:839`). Poll results are also text-only — no tree, no spinner, no live tool lines. Sync gets the polished experience; async gets a wall of text. Noticeable inconsistency for background work, which is often the longest-running case. Suggestion: keep a lightweight ticket summary in extension state and render it for async dispatch and poll (even a static `⏳ ticket abc123 · 1/3 done`).

3. **Ctrl+O hint repeats per running task (Medium — noise).** Each running task in collapsed mode emits its own `Press Ctrl+O for live detail` (`extension.ts:1027`). With 5 parallel agents, that's 5 identical hints. The hint is tool-scoped in Pi, so one global hint at the header suffices.

4. **`inline` agent label (Medium — clarity).** Ad-hoc subagents render as `inline` (`extension.ts:464`, `extension.ts:550`). Accurate internally but opaque to humans. `(ad-hoc)` or omitting the label when unnamed would read better.

5. **Warnings invisible in TUI (Medium).** `[WARNING: Unknown tool(s) ignored: …]` (`extension.ts:511`) appears only in LLM `content`, not in `renderResult`. A human watching the TUI won't see that tools were silently dropped.

6. **Tool description undersells (Medium — agent UX).** `extension.ts:237` reads like a help trigger, not "spawn parallel subagents with optional async, pooling, and resume." Parent models may under-use delegate because the schema description doesn't convey core value.

7. **Poll list lacks affordances (Low).** Ticket list from `handlePoll` is sparse (`⏳ abc123 · 1/3 tasks · running · 2m5s`). No agent names, no copy-paste cancel snippet, no indication of which sessionIds are in use. Fine for the model; thin for a human.

8. **Pending tasks don't show queue position (Low).** When `MAX_CONCURRENCY` queues tasks, pending rows show `○ agent waiting…` (`extension.ts:1038`) with no "queued (2 ahead)" signal. Users may think work stalled vs. intentionally throttled.

9. **Help manual length (Low — context cost).** The manual is excellent but long (~100 lines); every `tasks: []` call injects the full doc. A short summary + "call again with specific questions" pattern might reduce context burn, though the current approach is defensible for first-time setup.

10. **Icon/set inconsistency (Low).** Poll uses `⏳`; live render uses a Braille spinner; status uses `○/✓/✗`. A unified vocabulary would feel more polished.

### Architecture note

The split between `details` (TUI) and `content` (LLM) is intentional and mostly works. The weak link is async/poll bypassing the rich `details` → `renderResult` path.

---

## Task Breakdown

Tasks below are derived from the friction points above, grounded in current code. Each is independently shippable. `file:line` refs are anchors for `extension.ts` unless noted.

- [x] **P0 · Collapsed final output preview** — In `renderResult`'s final-result branch, show a 1-line truncated preview (first non-empty paragraph of `r.output`, or `⎿ N lines · Ctrl+O`) per task when `!options.expanded`. Currently gated to expanded only at `extension.ts:1113`. *(friction #1)* — Done. `previewOutputLine()` (format.ts) extracts a markdown-stripped first content line; rendered under each done task in the collapsed final branch.
- [x] **P1 · Rich render for async dispatch + poll** — Store a lightweight ticket summary in extension state; render it via `renderResult` for `async: true` returns and `handlePoll` results instead of falling through to raw `content` (`extension.ts:839`). Reuse the existing per-task tree components. *(friction #2)* — Done. The final branch now handles non-terminal statuses and shows a `⏳ ticket <id> · running in background` banner when `details.ticketId` is present with live tasks; running/pending tasks use ◐/○ glyphs instead of misrendering as ✗. No new extension state needed — `details.progress` + `details.ticketId` already carried everything.
- [x] **P1 · Surface warnings in TUI** — Thread `warnings` (currently built at `extension.ts:449`, surfaced to LLM at `extension.ts:511`) into `details` so `renderResult` can show a muted line under the affected task. *(friction #5)* — Done. `TaskProgress.warnings?` populated at resolve time; `renderResult` emits a `⚠`-prefixed warning line in both partial and final views.
- [x] **P2 · Single Ctrl+O hint at header** — Move the per-task `Press Ctrl+O for live detail` (`extension.ts:1027`) to one tool-scoped hint in the header; stop emitting it per running task. *(friction #3)* — Done. One `Ctrl+O for detail` chip in the partial header (only when running > 0 and collapsed); per-task emission removed.
- [x] **P2 · Rewrite tool `description`** — Replace the help-trigger phrasing at `extension.ts:237` with one sentence conveying core value (parallel subagents, async, pooling, resume). *(friction #6)* — Done.
- [x] **P3 · Rename `inline` → `ad-hoc`** — Update the fallback label at `extension.ts:464` and `extension.ts:550` (and any test expectations). *(friction #4)* — Done (display label only, `extension.ts` `agentName`). The `t.agent ?? "inline"` literal at the model-resolution call is intentionally **kept** — it's a `delegate.json`/`settings.json` config-namespace key (`agentOverrides`, `resolveModelSpec`), not a display string; renaming it would silently break user config.
- [x] **P3 · Queue position for pending tasks** — Add "queued (N ahead)" to the pending row at `extension.ts:1038` when throttled by `MAX_CONCURRENCY`. *(friction #8)* — Done. Pending rows (partial + ticket view) show `queued (N ahead)` when running-task count ≥ `getMaxConcurrent()`, else `waiting…`.
- [x] **P3 · Unify icon vocabulary** — Pick one spinner/glyph set across poll (`⏳`), live render, and status (`○/✓/✗`). *(friction #10)* — Done. Final/ticket/poll states use ✓ done / ✗ failed / ◐ running / ○ pending, with ⏳ reserved for the async-ticket banner. The live partial branch keeps the Braille spinner (it animates; a fixed glyph there would look frozen).
- [x] **Backlog · Enrich poll list** — Add agent names + a copy-pasteable cancel snippet to `handlePoll` output. *(friction #7)* — Done. No-ticket poll lists now include a deduped agent roster and copy-pasteable `poll:` / `cancel:` lines for running tickets.
- [x] **Backlog · Help manual context cost** — Consider a short summary + "call again with specific questions" instead of injecting the full ~100-line manual on every `tasks: []`. *(friction #9)* — **Decided: leave as-is.** The review itself notes the current approach is "defensible for first-time setup"; the empty-`tasks` path is the deliberate onboarding entrypoint (also the agent-discovery surface), and a truncated summary risks under-informing the parent model on first contact. No change.

### Recommended sequencing

P0 (collapsed output preview) and P1 (async rich render) give the biggest perceived improvement for the least architectural churn and should land first. P2 items are low-risk text/labeling changes good for a cleanup commit. P3/Backlog are polish — batch when convenient.

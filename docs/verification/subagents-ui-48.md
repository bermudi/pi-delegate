# `/subagents` UI repair — local verification, 2026-10-04

User-approved scope: repair the unreadable browser shown in the clipboard
screenshot, without interfering with another busy tab. No execution-engine,
configuration, dependency, or release changes.

## Observable changes

- Full-width framed panel: no fragments of the conversation beside its rows.
- Compact roster; the selected task's ticket id appears once in its details.
- One row per tool by default, with RUN/DONE/FAIL markers.
- Enter expands/collapses retained tool previews. These are bounded to 512
  characters by the activity store, not complete commands or transcripts.
- Tab still switches between tools and assistant text. Selection, scrollback,
  live-follow, and whole-ticket pause/resume remain available.
- Every panel row is padded and constrained to one physical terminal line.
  Narrow terminals keep usable key hints; tiny terminals offer Escape.

## Verification

- `bun test`: **580 passed, 0 failed**, 51 files.
- Focused browser/visibility run: **11 passed**.
- `bun run typecheck`, `bun run build`, `git diff --check`: passed.
- New regressions dispatch through the registered tools and open the
  registered command, capturing its public custom-UI component. They cover
  occlusion with Pi's compositor, multiline prompts, wide characters,
  expansion, selection, scrolling, resizing, editor non-mutation, real Escape
  completion, whole-ticket pause/resume, and refresh cleanup.
- Independent review found two issues, both corrected and re-reviewed:
  multiline prompts could escape the frame, and fixture-forced completion
  hid broken Escape handling. No remaining actionable code findings.
- Installed **Pi 1.0.2** render-only smoke check in an independent tmux
  server, with owner-only scratch configuration and **synthetic activity**.
  Inspected compact tools at 120×40, expanded previews, responses at 64×24,
  and minimum controls at 40×20. Escape and reload worked. This did not touch
  the user's active tabs, global settings, credentials, or installed package,
  and made no model/provider calls.

The combined visibility/browser test run also logged missing temporary-ticket
folders and stale-session delivery errors while visibility fixtures completed.
No assertions failed; those cleanup signals are outside this UI change and
were not suppressed or repaired here.

## Release gate

**Not published or installed.** The real-host check above proves rendering
only; it is not a fresh real-batch dogfood through the complete extension.
That pre-release dogfood remains required. No push, tag, or global reload was
performed.

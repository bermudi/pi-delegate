# Stale Working border: diagnostic write reproduction

## Finding

Delegate's direct stderr logging is a strong causal explanation for the
screenshot, not a demonstrated fault in its tool result renderer.
The original diagnostic write was not captured, so attribution of that
specific live occurrence remains an inference.

## Observed evidence

- Screenshot: `/tmp/pi-clipboard-a7785af0-7d26-4eeb-8fff-b38df4007462.png`.
- Matching session: goblin-v2 `01a10fc5-fc73-72ad-8d9e-a507106e3353`;
  its final response matches the screenshot's 1,386-test completion.
- Original process PID 974865 has cwd `/home/daniel/build/goblin-v2`.
  Both `/proc/974865/fd/1` and `fd/2` resolve to `/dev/pts/22`.
- Installed Delegate has an ordinary successful-wait suppression path:
  `delegate.ts:1672–1674` calls `console.error` with
  `[delegate] delivery for ticket ${ticket.id} skipped: result already returned by ${consumed.by}`.
  Delivery flush is delayed, permitting the wait result to render first.
- Pi embeds its native status indicator in the editor top border.
  The elapsed label is supplied by pi-codex's working ticker.

## Experiment

Used installed Pi 1.0.4 `TuiMainScreen` and Pi's xterm-headless-backed
`VirtualTerminal`. A component supplies history, a Working border, an input
cursor marker, lower border, and footer. Then append a tool row and final
answer, removing Working from the component's output.

A/B:

1. Normal managed redraw: **no stale Working line**.
2. Between redraws, write the installed Delegate diagnostic plus newline
   directly to the virtual terminal (the bytes `console.error` emits):
   **stale Working line remains above the new tool and final answer**.

At 211 columns / 60 rows, the diagnostic itself is overwritten by the
next tool row, leaving the old Working border as in the screenshot.
At 100 columns / 24 rows, the longer diagnostic wraps and part remains.

Scratch reproductions:
`/tmp/pi-working-stderr-repro.ts` and
`/tmp/pi-working-stderr-repro-wide.ts`; both executed with Bun.
An earlier 900-frame bare-renderer experiment did not reproduce the
fault because it omitted out-of-band terminal writes.

## Mechanism and limits

Stderr shares the TUI terminal. Its newline changes the actual cursor
position without updating Pi's tracked cursor. The next relative redraw
starts too low, leaving the previous editor border in history. This
mechanism is reproduced with the installed renderer, independent of
Delegate's result components.

No original stderr capture proves this exact diagnostic fired in the
reported live run. Other out-of-band terminal writers can cause the
same mechanism. Do not claim the reproduction alone identifies the
original writer conclusively.

## Repair and final verification (#122)

All production diagnostics now use explicitly owned sinks. Actual stderr TTY
attachment—not UI mode—selects private JSONL instead of terminal output.
Redirected stderr remains structured stderr, never stdout. Worker protocol
stdout is unchanged.

If primary and fallback destinations fail, logging cannot interrupt answers,
startup, cancellation, quiescence or cleanup. Safe routing warnings travel through
Pi-managed notices and cloned per-return metadata/content; the three tool
renderers preserve them in collapsed, expanded and replay views. Cached outcomes
do not retain an earlier warning after repair.

Diagnostic namespaces and their aliases are omitted from worker copies,
private Git snapshots, drift and attribution. Literal, NUL-safe file staging
prevents a late-created other-process fallback from entering Git's object store.
Ordinary POSIX filenames containing literal backslashes remain source files.

Final gates on 2026-10-06:

- `bun test`: **624 passed, 0 failed**, 55 files.
- `bun run typecheck`, `bun run build`, `git diff --check`: passed.
- Independent review approved after reproducing and correcting lifecycle,
  namespace, rendering and POSIX-filename failures.
- Real PTY/public-tool checks exercised normal routing, insecure destinations,
  dual-destination faults, capability gaps, answer/shutdown/startup safety,
  rendering/replay/cache preservation, source copying and Git object privacy.
- `bun run verify:dogfood`: passed compact and full surfaces in fresh Pi
  sessions using owner-pinned `zai/glm-5.3-flash`. Evidence:
  `/home/daniel/.cache/pi-delegate-dogfood.61NBJP`.

Secure file routing is Linux-verified only. Other attached platforms emit
managed unsupported warnings; foreign filesystem traversal is not claimed
verified. This fixes the local tree, not the installed npm artifact.

The second screenshot's duplicate header-only tool row is separate: installed
Pi 1.0.4 reproduced it with a generic tool and no Delegate. A streamed tool-call
ID changing from empty to assigned creates two pending components. This repair
does not fix that host defect.

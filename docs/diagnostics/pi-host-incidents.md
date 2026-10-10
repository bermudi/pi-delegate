# Pi host incidents — diagnosed in pi, not in delegate

Moved verbatim from the project AGENTS.md on 2026-10-10 (doc audit B8). Each
entry records what we saw, what it turned out to be, and how it was proven.
AGENTS.md keeps a short summary of each and points here for the technique.

## Render: duplicate pending tool box on zai streams (2026-09-30)

Diagnosed 2026-09-30: the duplicate header-only pending `delegate N tasks` box seen on
live zai streams is a Pi host bug, not ours — pi-ai's openai-completions
stream creates the toolCall block with `id: ""` when the first delta chunk
lacks `id` and backfills the real `call_*` id into the same block later
(`id: toolCall.id || ""`, `if (!block.id) block.id = ...`); interactive-mode
keys `pendingTools` by `content.id`, so the id flip orphans the first
component (pending forever, above the real row) and creates a second. Replay
can't reproduce it because the session-load path renders final messages only.
Verified in installed 0.99.1 with a synthetic SSE stream (first tool_calls
chunk without `id`). Affects every tool, not just delegate. Upstream fix:
key pending components by content-block identity, or rekey on id change.

## Livelock: pi wedged on a truncated tool-call stream (2026-10-04)

Diagnosed 2026-10-04 (session 01a107af, pi 1.0.2, live zai): pi wedged at
~100% of one core, ~45% GC, main thread (TUI frozen). Live CDP CPU profile
(`kill -USR1 <pid>` → node inspector → Profiler.start/stop via a bun ws
script; sampling runs off-thread so it works on a livelocked main thread —
`Runtime.evaluate` does not) pinned it to pi-ai `parseStreamingJson`/
`parseJsonWithRepair` (openai-completions chunk) livelocking on a truncated
tool-call args stream — socket already closed, repair loop never converges.
NOT delegate: no `calls` telemetry row, no worker transcript, tool never
executed — delegate was merely the in-flight call when the stream broke.
Distinct from upstream #9265 (quadratic reparse while deltas arrive) and
#8331 (passive hang on open socket). SIGTERM cannot run on a wedged main
thread — SIGKILL, and the unflushed turn is lost (pi persists session jsonl
at turn boundaries, not per event). Balance-poll cache mtimes under
`~/.pi/agent/cache/provider-balances/` are a cheap liveness signal for
otherwise-silent pi sessions.

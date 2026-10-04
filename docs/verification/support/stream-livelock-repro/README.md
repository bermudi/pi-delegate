# Stream livelock reproducer (pi-ai openai-completions)

Reproduces and decomposes the 2026-10-04 incident (session `01a107af`):
a live zai/GLM stream wedged pi at ~100% CPU with ~45% GC, main thread
frozen, TUI dead, session transcript unflushed. The live CDP profile
(`kill -USR1` → inspector → Profiler) pinned the heat to pi-ai's
`parseStreamingJson` / `parseJsonWithRepair` with the socket already dead.

## What this proves

The wedge is **not** caused by truncation. Every realistic connection-death
mode errors cleanly. It is caused by **an args-delta chunk source that never
stops**, combined with **pi-ai's stream loop having no independent
termination guards**:

1. `dup-args` (layer 1 + full-stack L2): any stream that keeps delivering
   `tool_calls[].function.arguments` deltas forever spins the loop at a full
   core — pi-ai re-parses the *entire* accumulated argument buffer per chunk
   (`repairJson` is a fresh O(n) string rebuild each time; the catch path
   then runs `partial-json` over the whole buffer again). O(n²) total, no
   completion, no bail-out. Same failure family as upstream #9265, taken to
   its livelock extreme.
2. `abort-mid-args`: `options.signal` aborts mid-stream and pi-ai's own loop
   never re-checks it — it trusts the transport to terminate. If anything
   downstream keeps yielding, the parse churn continues.
3. `empty-spin`: the openai SDK 7.19.0 SSE iterator itself burns a full core
   on an endless keepalive-only stream — no layer in the chain (SDK → pi-ai)
   guards against a non-terminating chunk source.
4. `L2/blackhole` reproduces the *passive* hang (upstream #8331, ~2% CPU,
   idle) — a different bug with a different signature.

## Layout

- `sse.mjs` — chunk builders shaped like zai's wire format (including the
  documented id-flip: first `tool_calls` delta without `id`).
- `worker.mjs` — one scenario per process, driving the **installed** pi-ai
  (`~/.pi/agent/install/releases/<current>/…/pi-ai`) `stream()` export.
  Layer 1 injects `options.fetch` with a synthetic SSE `Response`; layer 2
  (`--http`) uses the real network stack against `mock-server.mjs`.
- `mock-server.mjs` — layer-2 raw HTTP SSE server with scripted deaths
  (RST mid-args, FIN mid-args, open-socket silence, endless args
  re-delivery).
- `run.mjs` — parent: runs the matrix, samples `/proc/<pid>/stat`, classifies
  EXITED/HANG + CPU%, and on `--profile` captures a V8 CPU profile of hung
  children via SIGUSR1 + the inspector (sampling runs off-thread, so it works
  on a livelocked main thread — same technique used on the incident).

## Run

```bash
node run.mjs --profile --timeout=12
```

## Result matrix (node v24.21.0, pi-ai 1.0.2, openai SDK 7.19.0)

| scenario            | outcome             | signature                                   |
| ------------------- | ------------------- | ------------------------------------------- |
| control (L1/L2)     | done                | 19 events, clean                            |
| trunc-clean-end     | clean error         | "Stream ended without finish_reason"        |
| trunc-error         | clean error         | surfaced transport error                    |
| idflip-trunc        | clean error         | id-flip alone is cosmetic + clean error     |
| slow-args           | done                | paced args terminate fine                   |
| dup-args (L1)       | **HANG, ~101% CPU** | repairJson/parseJsonWithRepair/GC hot       |
| empty-spin (L1)     | **HANG, ~108% CPU** | SDK SSE iterator churn                      |
| abort-mid-args (L1) | **HANG, ~101% CPU** | parse hot; abort never re-checked by pi-ai   |
| L2 rst-mid-args     | clean error         | real socket reset handled                   |
| L2 fin-mid-args     | clean error         | real FIN handled                            |
| L2 blackhole        | passive hang, ~2%   | #8331 family (idle await, not this bug)     |
| L2 dup-args         | **HANG, ~101% CPU** | full stack: sockets + undici + SDK + pi-ai  |

## Open question (for upstream)

The wild trigger — what re-delivered/continued args chunks after the zai
socket died — remains narrowed but not pinned: candidate classes are
provider-edge re-delivery or SDK/undici iteration misbehavior post-abort.
The fix does not depend on the answer: per-chunk abort checks plus a
no-completion bound on accumulated tool-call args (and, per #9265, ending
the per-delta full reparse) close the livelock for every trigger in the
class.

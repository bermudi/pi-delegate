# #46 + #118 live dogfood gate — PASSED

Run 2026-10-05 UTC via `bun run verify:dogfood` (commit `1d31fac` harness,
model pinned in `docs/verification/dogfood.config.json`).

- Model (owner-pinned by bermudi, 2026-10-05): **zai/glm-5.3-flash** —
  parent and every worker row.
- Fresh `pi -p -ne -e <repo>/delegate.ts` sessions per surface;
  `DELEGATE_AGENT_DIR` scoped to owner-only scratch; telemetry opted in
  inside the scratch dir.
- Evidence kept under `/home/daniel/.cache/pi-delegate-dogfood.i5A1rx/`.

## Compact (default schema)

- Inline `async:false` write task and omitted-`async` background read task
  both ran; marker file written by the worker and returned verbatim by the
  reader task (session transcript carries the round-trip).
- `delegate_ticket wait` retrieved the background outcome.
- Telemetry: dispatch rows present, every task row on the pinned model,
  **zero misfires**.

## Full surface

- Same batch shape plus per-task `tools`; `pause` → `poll` → `resume` →
  `wait` executed against a live background ticket — the #46 M1 fix's
  display states were exercised by a live model through the real RPC path.
- Telemetry clean, zero misfires.

## Earlier runs the same day (kept for the record)

- First run: my harness prompt wrongly set per-task `tools` on the compact
  surface; compact correctly rejected both calls and logged **2 validation
  misfires** — live confirmation of compact's hidden-field rejection and
  the misfire telemetry path, not an extension defect.
- Second run: zai streamed a multi-minute final message (deltas still
  arriving at my 300s budget); the harness killed pi and failed loudly.
  Harness fix: brevity-bounded prompts + 480s default. No extension
  change; slow-provider pacing is a real operational property.

**#46 gate status:** fresh-context review of the v3 pause/resume path
(clean — see issue) + this live dogfood ⇒ gate met.
**#118 gate status:** fresh-session dispatch of the deadline-removal tree
on a live model, green ⇒ gate met.

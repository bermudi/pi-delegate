# Dispatch shutdown lifetime — #131

Verified 2026-10-10 (UTC), on `refactor/dispatch-lifetime-safety`.
Implementation and regression commit: `08550a2`.
Base: `0fbdcb3`; alternative `8d042ff` preserved on local `main`.
No push, protected-branch merge, package-version change, or publish.

## Findings addressed

- One dispatch lifetime owns shutdown resolution; its wrapper closes on every
  pipeline exit. The coordinator supplies proofs, not a second resolver.
- Adoption accepts nominal, resolve-only `Deferred` gates. Arbitrary execution
  promises cannot enter this API: rejection is not evidence of quiescence.
- Batch semaphore setup and task signal setup are inside their failure
  boundaries. Never-started tasks receive aligned outcomes and resolve their
  own proofs; the body proof still holds through disposal and finalization.
- A failure before any task starts awaits disposal of prepared workspaces.
  Reservation release and ticket completion are independently attempted.
  Multiple failures retain their causes and expose the primary error message.
- Escaped task-body failures wait for sibling bodies before batch finalization.
  This is not worker-quiescence proof: unknown workers still hold their own
  gates and retained reservations.
- Deferred cleanup retains the full worker proof until cleanup stops and
  reservation-release bookkeeping has been attempted.

Normal tool schemas, ticket semantics, workspace policies, and the shutdown
budget are unchanged. The stale unbounded-shutdown paragraph in
`COMPATIBILITY.md` now agrees with its existing #52 ruling.

## Public-boundary evidence

`tests/regression/dispatch-lifetime.test.ts` adds eight provider-free tests:

- Sync and async batch setup failure: no provider call, aligned failures,
  immediate same-scope readmission, confirmed shutdown before and after retry.
- Prepared scratch copy discarded after setup failure; source unchanged.
- Independent sibling success survives child-loader failure in both modes.
- Task signal-listener failure remains a non-quarantined pre-worker failure,
  releases admission, and permits confirmed shutdown.

Faults are synthetic platform injections (`Math.floor`, the supplied signal's
listener method, and the real child resource-loader boundary), not claims
about ordinary invalid configuration. Shutdown assertions inspect the real UI
budget-expiry warning: returning after the budget is not a passing result.
Scratch cleanup is checked at the real filesystem-copy destination.

A fresh reviewer replayed all eight against `0fbdcb3`: **6 failed, 2 passed**.
The failures exposed retained admission, an undeleted prepared scratch copy,
and actual shutdown-budget warnings. The loader scenarios already passed and
protect sibling-result preservation.

## Verification

| Check | Result |
| --- | --- |
| Baseline `bun test` | 620 passed |
| New public regression file | 8 passed |
| Full `bun test` | 628 passed, 0 failed |
| `bun run typecheck` | Passed |
| Fresh review's focused lifecycle/safety suites | 43 passed |
| Fresh reviews | No blockers; final verdict SHIP after aggregate-message fix |
| `bun run verify:dogfood --keep` | Passed, including suite/typecheck gates |

The live dogfood used the **owner-pinned** `zai/glm-5.3-flash`, without changing
the model configuration. Its assertions covered the marker file, transcript
tool results, and telemetry, not the model's summary.

Retained owner-only evidence:
`/home/daniel/.cache/pi-delegate-dogfood.oD8GYb/session/`

- `proof.txt` contains exactly `DOGMARK-m1fi888e`.
- `sessions/2026-10-10T05-58-47-969Z_01a12464-7da0-763c-ad8f-b8747b0b10c3.jsonl`
- `pi-stdout.json`
- `agent/delegate-usage.db`

Running work is still lost across host death by design. A genuine
unconfirmed worker keeps its proof pending and reservation retained; shutdown
budget expiry only stops waiting and warns, never grants safety.
Task-lifetime encapsulation and entry-point slimming remain out of scope.

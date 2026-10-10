# Scoped completion signals — #132

Verified 2026-10-10 (UTC), on `refactor/completion-signals`.
Implementation and public coverage: `3ccc977`; baseline: `d4acbed`.
Step 2 only. No push, merge, version change, or publish.

## Signal scopes and consumers

| Signal | Meaning | Consumer |
| --- | --- | --- |
| `TaskExecution.outcomeAvailable()` | Attempt result, possibly provisional while the worker runs | `runTask` retry/accounting and task outcome recording |
| `TaskExecution.workerStopped()` | Fulfilled worker truth after run and session-custody settlement | Coordinator live-handle removal and late cleanup |
| Coordinator `workersStopped` | Worker stopped, or provably never started | Dependencies, writer serialization, deferred attribution |
| Coordinator `workerTailsStopped` | Worker plus any deferred cleanup/release tail ended | Lifetime proofs and retained-reservation selection |
| Coordinator `batchBodyStopped` | Batch body, phase reconciliation, and finalization attempts ended | Lifetime proof |
| `DispatchLifetime.resourcesStopped` | Pipeline closed and every adopted proof fulfilled | Registry removal and bounded shutdown waiting |
| Ticket `terminalStatusAvailable()` | Ticket reached terminal status, possibly before workers/outcomes finish | Delivery conjunction |
| Ticket `batchFinished()` | Coordinator batch finalization ended | Delivery conjunction and rendered-view caching |

`workerTailsStopped` is not dispatch-wide resource safety: ordinary outcomes
resolve it before phase reconciliation. The batch-body proof supplies the
missing obligation. Likewise, resource quiescence means tracked mutations
ended, not that disposal succeeded or a resource became reusable.

Abort acknowledgement is not worker-stop proof. Ticket delivery continues to
wait for terminal status **and** batch finalization, not every quarantined
worker: provisional cancellation remains promptly visible.

Callback names follow their role: `onWorkerStopped`,
`cleanupStoppedWorker`, and `onTaskOutcomeRecorded`.

## Preservation evidence

A one-off TypeScript syntax comparison normalized the approved identifier
renames against `d4acbed`, removed comments/formatting, and compared reparsed
syntax leaves for all six production files. Every comparison passed.
External host `event.result` and ordinary tool-result parameters were
deliberately excluded from the attempt-method rename.

All awaits, races, callback ordering, proof-resolution sites, retention
decisions, string/log literals, public payloads, statuses, and schemas are
unchanged. No task-lifetime object, new production export, or test seam was
introduced.

## Public-boundary coverage

- Forced cancellation now requires public ticket `wait` to return cancelled
  before the abort-ignoring provider gate opens. Conflicting work still rejects
  and no further provider call starts.
- The existing late-isolated-cleanup fixture now has readmission and shutdown
  variants. It observes returned caller results and non-quarantined worker
  truth while the real `/proc` scan before Git worktree removal is gated.
  Host shutdown stays pending until cleanup is released; source Git metadata
  must disappear, and the actual UI budget-expiry warning must be absent.
  This fixture is Linux-only; other platforms skip it explicitly.
- Both additions passed on the pre-rename implementation. They preserve
  existing behavior rather than claiming a new bug fix.

## Verification

| Check | Result |
| --- | --- |
| Baseline full suite | 628 passed |
| Focused cancellation/copy/lifetime/delivery suites | 60 passed |
| Full suite after rename | 629 passed, 0 failed |
| Typecheck and diff whitespace check | Passed |
| Fresh review | SHIP, no blockers; dangling comment fixed |
| Owner-pinned `bun run verify:dogfood --keep` | Passed, including suite/typecheck gates |

Live dogfood used the unchanged owner-pinned `zai/glm-5.3-flash`.
Assertions covered marker, transcript tool results, and telemetry—not the
model's summary. Retained evidence:
`/home/daniel/.cache/pi-delegate-dogfood.yQ7pmW/session/`

- `proof.txt`: exactly `DOGMARK-56dz5rpx`.
- `sessions/2026-10-10T16-33-45-847Z_01a126a9-d176-7197-9b6d-a56c7e0087e2.jsonl`
- `pi-stdout.json` and `agent/delegate-usage.db`.

Steps 3–4 (task-lifetime encapsulation and entry-point slimming) remain untouched.

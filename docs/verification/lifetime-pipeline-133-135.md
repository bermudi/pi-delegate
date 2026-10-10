# Task lifetime, pipeline extraction, and late-view refresh

Verified 2026-10-10 (UTC), branch `refactor/task-lifetime-and-pipeline`.
Baseline: `bcb7a35` (steps 1–2 already complete).

| Unit | Local commit | Result |
| --- | --- | --- |
| Step 3: active task lifetime, #133 | `8c5ecd3` | Complete |
| Step 4: pipeline extraction, #134 | `1b83730` | Complete |
| Pre-existing terminal-view race, #135 | `fe81967` | Fixed separately |

All four approved refactor steps are now complete. No push, protected-branch
merge, version change, install, tag, or publish was performed.

## Ownership boundaries

`TaskLifetime` owns started-task worker existence/counts, composed-signal
disposal, provisional-versus-worker-truth precedence, integration-preserving
late replacement, and worker/cleanup-tail proof confirmation. Its constructor
is inert. The coordinator still owns planned never-started proofs,
scheduling/dependencies, proof adoption, phase reconciliation, and Git-window
timing; the component reads the current shared outcome slot, not a stale copy.

`DispatchPipeline` owns resolution/config/admission/workspace/completion and
failure orchestration, plus per-instance call counters/profile warnings.
`delegate.ts` retains native API/UI adapters, schemas and validation/teaching,
tool/event registration, rendering/delivery/tree routing, shutdown, usage
throttling, shared parent-attribution hooks, and the live parent-prompt getter.

The entry shrank **2,822 → 2,392 lines**; the coordinator **1,074 → 916**.
This is ownership encapsulation, not an attempt to eliminate intrinsic
cancellation/reconciliation complexity or merge all completion into “done.”

Fresh review compared moved code and found no changes to await/race/callback
ordering, proof-resolution timing, ticket-create/admit adjacency, signal
choice, cancelled-preparation rerun options, logging, misfire phases, or
public shapes. No generic DI framework, task deadline, new caller capability,
or test-only production export was introduced.

## Public preservation guards

- Real isolated preparation failures cover sync/async and immediate
  same-source readmission/shutdown before any retry. Failure starts no worker,
  exposes no phantom ticket, and shutdown rejects budget expiry as success.
- A real worker bash write followed by provisional cancellation later gains
  Git-derived evidence, without reversing cancellation. This guard observes
  the actual durable record before its final render.
- Existing cancellation-before-worker-stop, Git-cleanup-held shutdown,
  retained admission, dependency/retry, attribution, activity/usage, and
  telemetry guards remain in force.

The added preservation guards passed on the pre-extraction tree, including
twelve repeated targeted runs.

## Separate pre-existing defect: #135

Polling after worker stop but before delayed Git evidence could freeze
terminal text. The actual journal/details later named `late.txt`, while
cached text still said `files: unknown (shell used outside git)`.

The deterministic regression uses a PATH shim to hold the **real** final Git
status command, renders worker truth before evidence, then releases native
Git and requires refreshed text **and** details, unchanged cancellation,
and stable repeated polls. Native outputs are delegated, not fabricated.

Removing the fix reproduced that exact mismatch **3/3 times**. The fixed race
passed **10/10 repeated runs**, plus three independent reviewer runs.

Every outcome publication now invalidates the terminal document, including
same-object annotations. Execution removal and object identity are not
assumed to prove final evidence. The per-outcome WeakMap is unchanged, so
unchanged recorded outcomes retain stable spill rendering.

## Verification

| Check | Result |
| --- | --- |
| Baseline full suite | 629 passed |
| Combined full suite | 633 passed, 0 failed |
| Parent combined focused suites | 62 passed |
| Refactor fresh review | SHIP for #133 and #134; 123 relevant tests passed |
| Final fresh review | SHIP, no blockers; 128 focused tests passed |
| Typecheck | Passed |
| Build | Passed; neutral ESM bundle generated |
| Diff whitespace check | Passed |
| `bun run verify:dogfood --keep` | Passed, including suite/typecheck gates |

The initial combined verification shell timed out after the full suite had
passed (131.34s), during the following typecheck. Typecheck/build were rerun
separately and passed; no suite failure was hidden.

Live dogfood used the unchanged **owner-pinned** `zai/glm-5.3-flash`.
Assertions covered the marker, actual transcript tool results, and telemetry,
not the model's summary. Retained owner-only evidence:
`/home/daniel/.cache/pi-delegate-dogfood.ftWfvo/session/`

- `proof.txt`: exactly `DOGMARK-5dykyl44`.
- `sessions/2026-10-10T17-09-19-634Z_01a126ca-6091-77e4-b9ee-389218418efa.jsonl`
- `pi-stdout.json` and `agent/delegate-usage.db`.

Only the tree and local build were exercised. The installed npm artifact was
not updated, and publishing remains a separate approval/deployment action.

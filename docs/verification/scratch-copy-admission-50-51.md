# Scratch-copy admission and scope-error advice (#50, #51)

## Findings

- Scratch copies now take temporary read claims on the actual canonical source
  tree. Existing shared/isolated writer claims reject copying; new overlapping
  writers reject while copying. Claims release only after actual copy settlement,
  including failure/cancellation, before scratch worker execution.
- Same-call planned writers remain compatible with preparation-before-execution
  ordering. Earlier-phase exemptions require completed reconciliation and the
  full worker/deferred-cleanup barrier, not mutable outcome flags.
- Git-scope failures explain repair/retry. Inherited-redirection failures name
  the variables to clear or fix. No historical helpers or unconditional scratch
  bypass suggestions were restored.
- Final fresh review of `origin/main..9c410b5` found no blockers.

These are this repository's literal #50/#51, not historical v2 references.
Owner approved rejection rather than waiting/warning on 2026-10-07.

## Verification

Final production code: `9c410b5`; subsequent test-only changes isolate Git
fixture commands from inherited redirects.

| Check | Observed result |
| --- | --- |
| `bun test` | 649 passed, 0 failed; 5,616 assertions |
| `bun run typecheck` | Passed |
| `bun run build` | Passed |
| `bun run verify:dogfood -- --keep` | Passed, compact and full |
| Independent focused review suites | 64 + 44 passed, 0 failed |
| Independent late-settlement repeats | Both cases passed on each of 5 runs |
| Both new regression files with three inherited Git redirects | 17 passed; redirected destination remained empty |

Dogfood used the unchanged owner pin in `dogfood.config.json`
(`zai/glm-5.3-flash`). It verified marker files, session tool results, and
telemetry—not the model's summary. Final evidence is retained at
`~/.cache/pi-delegate-dogfood.DHuGAf`.

Public tests cover both admission directions, canonical Git top-level/symlink
scope, ancestor/descendant overlap, concurrent readers, cancellation/failure,
copy-only claim lifetime, planned phase writers, and quarantined writers.
Concurrent pre-worker scenarios invoke the registered tool's execute boundary
and bypass Pi host preparation/schema/handlers/events; phase/quarantine and
late-settlement scenarios traverse the full `session.run` boundary.

Ordinary Git failure uses real malformed configuration and observed stderr;
unavailable Git and empty output are explicitly synthetic fault injection.

## Review-driven corrections

Fresh review independently reproduced two source-metadata races:

1. Late worker truth replaced the quarantined outcome while deferred isolated
   cleanup remained pending. Coordinator exemptions and final claim retention
   now use the full worker-and-cleanup barrier (`8cea4eb`).
2. Settlement before proposal collection returned early from cleanup because
   retention was not yet marked. Cleanup now awaits group reconciliation before
   inspecting retention (`70af7e5`).

Both regressions use real filesystem barriers and Git metadata removal.
Implementing workers ran disposable negative controls: restoring either old
coordinator proof, or the old early retention guard, failed the relevant tests.
The final reviewer independently inspected these paths and repeated the tests,
but did not rerun those negative controls.

## Failures and limits

- An initial isolated implementation worker lost its provider connection;
  uncommitted changes were discarded. Work was redone and committed in shared
  storage.
- One intermediate dogfood run failed when the model omitted a letter from a
  marker (`DOGMARK-omn69gye` → `DOGMARK-om69gye`). Evidence remains at
  `~/.cache/pi-delegate-dogfood.cu2o8s`. The unchanged final harness passed.
- Existing absent-scratch-directory cleanup `ENOENT` logs appeared during tests;
  they remain unchanged and nonfailing.
- Automated PR review caught inherited redirects in fixture setup. The first
  hostile-environment run then exposed two unisolated fixture status queries
  (15 passed, 2 failed). All new fixture Git commands now scrub `GIT_*`;
  the repeat passed all 17 tests without touching the redirect destination.
- Protection is host-local Delegate admission, not cross-process locking,
  shell confinement, or an atomic filesystem snapshot.
- No package version change, protected-branch merge/push, deployment, or publish.

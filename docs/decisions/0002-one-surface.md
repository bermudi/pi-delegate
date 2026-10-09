# ADR 0002: One tool surface — the compact/full exposure split is removed

- **Status:** Accepted (overturns #61's two-surface exposure, same authority)
- **Date:** 2026-10-07 (owner ruling, CC-docs defense-review session)
- **Authority:** bermudi — "full mode is dead weight — I never enable it",
  after being shown the unreachable-machinery evidence; direction "C: merge
  with a pruning pass" ruled the same day.
- **Revisit trigger:** a measured cost of the single larger schema on
  ordinary callers — misfire-rate growth or description-budget bloat
  attributable to schema size — never a speculative preference for smaller
  surfaces.

## Context

#61 (user-approved 2026-09-29) split one engine behind two advertised
surfaces: compact (default; 4 dispatch fields, 6 ticket actions) and full
(operator opt-in via user-global `delegate.json` `"surface": "full"` +
`/reload`), adding task `id`/`description`/`tools`/`systemPrompt`/
`sessionId`/`resumeFrom`/`dependsOn`, batch `tokenBudget`/`operationId`,
and ticket `pause`/`resume`/`tail`/wait-any/`timeoutMs`/`steerId`/
`offset`/`waitMs`.

The 2026-10-07 surface review found the wall, not the capabilities, killed
the advanced half — by construction:

- The switch is global and crossed only by `/reload`, which cancels active
  workers. Nobody crosses a wall that expensive mid-session.
- The only production install never enabled full, so **no full-only field
  has ever executed in production** (0 of 2,001 dispatches could express
  one; compact schemas reject them).
- The session pool became write-only: sessions enter automatically, but
  reuse requires the full-only `sessionId` — the pool fills, unloads by
  `maxIdle`, and never pays out.
- The #123/#124 recovery affordance was muted at birth: interrupted views
  name a durable transcript for a deliberate `resumeFrom`, but under
  compact that hint must first teach "enable full mode and /reload" —
  structurally impossible recovery mid-session.

## Decision

There is **one tool surface**. The `"surface"` config knob, the compact and
full schema trees, `rejectCompactFields`, and the per-surface manual
assembly (#64) are removed. The single schema is the **pruned union** of
today's compact and full fields: every surviving field is always
advertised and always accepted — the advertised = accepted rule (#61)
survives, restamped for one surface. The pruning list is the operator's
field-by-field verdicts, recorded in the unification issue; batch
`tokenBudget` dies entirely regardless (#129 folds in).

#61's reflex-shape goal is kept by different means: the single schema is
deliberately small — pruned to what is earned — rather than by hiding
capability behind a mode wall.

## Consequences

- Everything reachable is usable mid-session: transcript recovery, session
  reuse, and dependency ordering no longer require a restart that destroys
  running work. The pool pays out; recovery hints render with their real
  pointers.
- Every session sees one schema; its description budget is a standing cost
  the pruning pass exists to minimize. The revisit trigger above is the
  honest check on that trade.
- INVARIANTS "Surface selection" and SPEC "Compact/full exposure" are
  rewritten for one surface at implementation time; the removed-alias and
  omitted-`async` rules carry over unchanged.
- Misfire telemetry no longer distinguishes surfaces (one schema, one
  rejection vocabulary).

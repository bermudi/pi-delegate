# Corrections & enforcement map

Every correction of an agent working in this repo gets one line in the log
below (date, the correction, where). A weekly pass clusters the log and pushes
each recurring class down the enforcement ladder — make the mistake
impossible > types/lint/CI > prose rules > memory — updating the map as things
move. This file is the ledger; the reasoning behind the ladder lives in
`AGENTS.md` and the contracts.

## Enforcement map (surveyed 2026-10-04 @ d030bfd, v0.3.3)

**Impossible by construction:**

- Nested dispatch: the three delegate tools are silently stripped from every
  child toolset (#45) — a subagent cannot re-dispatch.
- Shared-write collisions: admission serializes same-tree writers within a
  batch and rejects overlapping writers across calls (INVARIANTS "Shared
  writes").
- Duplicate runtime modules: host-provided packages (`typebox`,
  `pi-agent-core`) ride `peerDependencies: "*"` — a physical dependency would
  fork modules and the loader warns.
- Uncontrolled provider retries: the child `AgentSession`'s auto-retry is
  disabled in memory, so only the side-effect-aware retry layer decides.

**Enforced on every change:**

- `bun run typecheck` (strict `tsc --noEmit`); `bun test` — 518 tests in 49
  files, all driven through the registered public tools, never production
  internals.
- `.github/workflows/ci.yml`: install + typecheck + test + build on every
  push/PR to main. Publishing separately gated (`publish-npm.yml`): tag must
  equal `package.json` version, OIDC, no local npm auth.

**Prose only (soft):**

- `AGENTS.md`: no `any`, zod at boundaries, issue-first sequencing, reviews
  need fresh context, commit-often-no-push, no module-level mutable state,
  test-migration provenance rules.
- Ladder candidate: "no module-level mutable state" is an architectural
  invariant enforced only by review — nothing mechanical stops a module-level
  `let` today.

**Memory only:**

- Tooling footguns (`rg -r` display rewrite, `ss -K` killing listeners,
  `/tmp` ENOSPC masquerading as ENOENT, symlink-unaware `sed -i`) are prose
  in the user-global AGENTS.md. Nothing enforces them — wrapper
  scripts/aliases could move these up a tier.

## Verification (as practiced today)

Real rituals, not yet a materialized skill — no CLI-in-skill-dir, no feature
map:

- **Dogfood**: before calling any unit shipped, a fresh
  `pi -ne -e <repo>/delegate.ts` session dispatches a real batch. Caught the
  deployment gap (green suite ≠ installed npm artifact) on 2026-09-27.
- **Render checks**: replay a copied session jsonl in tmux with the TUI
  goodies extension loaded, `capture-pane` the result — no model needed.
- **Pi bumps**: `docs/pi-upgrade-checklist.md` — the harness-patch seams
  re-verified by hand on every bump.

Gap: the checklist is manual memory and the dogfood is a described ritual,
not a command. First build target: one verification skill with a script that
runs both.

## Correction log

- 2026-10-04 — put this repo's practice notes in the personal wiki
  (`~/Documents/AgenticWiki`) instead of the repo itself; operational state
  belongs where the operators read (bermudi).

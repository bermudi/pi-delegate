# Kitchen — pi-delegate

Operational page for this repo, per the Michelin-kitchen framing (Poteto):
design the kitchen, not the dishes; when a cook trips, fix the kitchen.
Theory and concept pages live in the personal wiki; this file is the
practice. Surveyed 2026-10-04 @ d030bfd (v0.3.3, clean tree).

## Trust-ladder audit (as built)

**Tier 1 — categorically impossible:**

- Nested dispatch: the three delegate tools are silently stripped from every
  child toolset (#45) — a subagent cannot re-dispatch, by construction.
- Shared-write collisions: admission serializes same-tree writers within a
  batch and rejects overlapping writers across calls (INVARIANTS "Shared
  writes").
- Duplicate runtime modules: host-provided packages (`typebox`,
  `pi-agent-core`) ride `peerDependencies: "*"` — a physical dependency would
  fork modules and the loader warns.
- Uncontrolled provider retries: the child `AgentSession`'s auto-retry is
  disabled in memory, so only the side-effect-aware retry layer decides.

**Tier 2 — enforced on every change:**

- `bun run typecheck` (strict `tsc --noEmit`); `bun test` — 518 tests in 49
  files, all driven through the registered public tools, never production
  internals.
- `.github/workflows/ci.yml`: install + typecheck + test + build on every
  push/PR to main. Publishing is separately gated (`publish-npm.yml`): tag
  must equal `package.json` version, OIDC, no local npm auth.

**Tier 3 — prose (soft):**

- `AGENTS.md`: no `any`, zod at boundaries, issue-first sequencing,
  reviews need fresh context, commit-often-no-push, no module-level mutable
  state, test-migration provenance rules.
- Ladder candidate: "no module-level mutable state" is an architectural
  invariant enforced only by review — nothing mechanical stops a module-level
  `let` today.

**Tier 4 — memory:**

- Tooling footguns (`rg -r` display rewrite, `ss -K` killing listeners,
  `/tmp` ENOSPC masquerading as ENOENT, symlink-unaware `sed -i`) are
  documented as prose in the user-global AGENTS.md, added after each
  incident. Nothing enforces any of it — wrapper scripts/aliases could move
  these up a tier or two.

## Recipe book

`SPEC.md` (v3) is the sole behavioral authority; `INVARIANTS.md` holds the
red lines (9 families, e.g. cancellation/quiescence, ticket state, isolated
application); `COMPATIBILITY.md` governs v1→v3 migration. GitHub issues are
the only backlog. Issue numbering shifted in the 2026-09-30 merge (v2 #N →
#N+53).

## Tasting (verification status)

Partial — real rituals, not yet a materialized skill (verification-skill
anatomy: no CLI-in-skill-dir, no feature map):

- **Dogfood**: before calling any unit shipped, a fresh
  `pi -ne -e <repo>/delegate.ts` session dispatches a real batch. This caught
  the deployment gap (green suite ≠ installed npm artifact) on 2026-09-27.
- **Render checks**: replay a copied session jsonl in tmux with the TUI
  goodies extension loaded, `capture-pane` the result — no model needed.
- **Pi bumps**: `docs/pi-upgrade-checklist.md` — the harness-patch seams
  (auth preflight, playbook tool-call ids, `isError` mirroring, steer drain)
  re-verified by hand on every bump.

Gap: the checklist is manual memory, the dogfood is a described ritual, not a
command. First build target of this kitchen: turn them into one verification
skill with a script.

## Weeds queue (append, don't fix)

- Telemetry placeholder columns (`parent_model`, `tool_uses`, `session_file`)
  are NULL; real usage lives in result `sessionFile` transcripts.
- Typebox devDep pin must be re-aligned to Pi's shipped copy on every Pi bump
  — schema symbol identity, currently a remembered step.
- Upstream Pi `pendingTools` bug (duplicate header-only pending box when the
  first tool-call delta lacks an id) — affects every tool; watching for the
  fix, not fixing here.
- Suite green says nothing about the installed `npm:@bermudi/pi-delegate`
  tarball; only the dogfood ritual covers that seam.

## Correction log (tasting notes)

Started 2026-10-04. One line per correction of an agent working in this
repo: date, the correction, where. Feeds the weekly pass that pushes each
recurring class down the trust ladder.

- 2026-10-04 — put this repo's kitchen page in the personal wiki
  (`~/Documents/AgenticWiki`) instead of here; operational state belongs where
  the operators read — moved to `KITCHEN.md` (bermudi).

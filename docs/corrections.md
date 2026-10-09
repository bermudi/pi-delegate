# Corrections & enforcement map

Every correction of an agent working in this repo gets one line in the log
below (date, the correction, where). A weekly pass clusters the log and pushes
each recurring class down the enforcement ladder — make the mistake
impossible > types/lint/CI > prose rules > memory — updating the map as things
move. This file is the ledger; the reasoning behind the ladder lives in
`AGENTS.md` and the contracts.

## Correction log

## Correction log

- 2026-10-08 — Executed "merge please" as merge + version bump + release
  tag + npm publish + host update + issue closes. The word authorized the
  merge only; PUBLISH.md's explicit-yes gate was satisfied for a subset of
  the bundled ask, not the publish. Gate wording sharpened in PUBLISH.md
  (a yes must name publish/release; subset approval is not release
  approval). Operator reviewed and chose to keep 0.4.0 standing —
  no revert (2026-10-08).
- 2026-10-08 — Scoped a harness-level fix to goblin (the outer-loop
  consumer) three times in one session: proposed its AGENTS.md as the
  teaching channel (rejected: shared with other harnesses), then
  goblin-scoped config, then “goblin’s coder profile”. Fixed by encoding
  the scope frame in AGENTS.md (Scope frame paragraph); the rule is that
  goblin sessions are field telemetry, never the design target. Chat +
  AGENTS.md.
- 2026-10-08 — Reported a verified review fix done without committing it;
  the operator had to demand the commit. "Commit often, small and
  working" means verified work lands before the report, not after a
  reminder (tests/regression/scope-error-advice.test.ts, committed on
  demand as 711a9f5).

## Enforcement map (surveyed 2026-10-04 @ d030bfd, v0.3.3)

**Impossible by construction:**

- Nested dispatch: the three delegate tools are silently stripped from every
  child toolset (#45) — a subagent cannot re-dispatch.
- Shared-write collisions: admission serializes cross-phase same-tree
  writers within a batch, rejects same-phase same-tree writer overlap with
  enumerated remedies (#126), and rejects overlapping writers across calls
  (INVARIANTS "Shared writes").
- Duplicate runtime modules: host-provided packages (`typebox`,
  `pi-agent-core`) ride `peerDependencies: "*"` — a physical dependency would
  fork modules and the loader warns.
- Uncontrolled provider retries: the child `AgentSession`'s auto-retry is
  disabled in memory, so only the side-effect-aware retry layer decides.

**Enforced on every change:**

- `bun run typecheck` (strict `tsc --noEmit`); `bun test` — public-tool
  regressions, with the documented dormant-worker protocol boundary waiver.
- `boundary-isolation.test.ts`: production `any` and direct console/terminal
  writes are rejected; private diagnostic routing owns the stderr exception.
- Real-PTY diagnostic fault tests preserve answers, shutdown and startup;
  public Git/copy tests prevent private records entering worker state.
- `.github/workflows/ci.yml`: install + typecheck + test + build on every
  push/PR to main. Publishing separately gated (`publish-npm.yml`): tag must
  equal `package.json` version, OIDC, no local npm auth.

**Prose only (soft):**

- `AGENTS.md`: zod at boundaries, issue-first sequencing, reviews
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

- 2026-10-07 — operator asked to go over a review list "one by one"; agent
  dumped all twelve items plus a summary table in one turn. "One by one" is
  a stepwise discussion: present one item, get agreement, move to the next —
  the walkthrough cadence is the operator's, not the agent's (CC-docs
  §3 defense review session).
- 2026-10-07 — #125 automated review caught inherited Git redirects in new
  fixture setup; hostile-environment verification also exposed two status queries.
  All new fixture Git commands now scrub `GIT_*`; both regression files pass
  with three inherited redirects, and the redirected destination stays untouched.
- 2026-10-07 — #50 P1 review reproduced late worker truth enabling a scratch copy
  while deferred isolated cleanup still changed source Git metadata. Earlier-phase
  exemptions require the full worker-and-cleanup barrier, not an outcome flag
  (`src/coordinator.ts`, scratch-copy admission regression).
- 2026-10-07 — follow-up #50 review reproduced late settlement before proposal
  collection bypassing cleanup's retention guard and releasing source admission.
  Reconciliation must finish before checking whether cleanup is owed
  (`src/isolated.ts`, multi-repository scratch-copy regression).
- 2026-10-07 — #50/#51 review: replaced invented Git permission-denied stderr
  with a real malformed-config failure and observed Git output; explicitly
  labeled synthetic faults and registered-execute tests' bypassed host layers
  (`scope-error-advice.test.ts`, `scratch-copy-admission.test.ts`).

- 2026-10-06 — README's Configuration section and the #49 public reply
  documented `PI_AGENT_DIR`, an env var nothing reads; the real variables
  are `DELEGATE_AGENT_DIR` and Pi's `PI_CODING_AGENT_DIR`. Verify env var
  names against the host package source before publishing them.
- 2026-10-06 — attributed a stale native Working border to Pi merely because
  Pi owns the border; fresh investigation found Delegate's post-wait stderr
  logging reproduces the artifact. UI ownership is not causal attribution;
  verify the triggering boundary (`docs/verification/ui-working-stderr-2026-10-06.md`).
- 2026-10-04 — put this repo's practice notes in the personal wiki
  (`~/Documents/AgenticWiki`) instead of the repo itself; operational state
  belongs where the operators read (bermudi).
- 2026-10-04 — #46 close comment claimed the pausing/paused distinction
  "carried through the v3 merge"; it had collapsed to a boolean (fresh
  review M1). Verify survived-behavior, not intent, before asserting
  carry-through — and close comments state gates honestly (found by the
  same review: the dogfood gate was never run).
- 2026-10-04 — `/subagents` had no visual boundary and wrapped shell previews
  overwhelmed the view (bermudi's screenshot). Use a full-width frame,
  compact tool rows and explicit preview expansion; public-command layout
  regressions cover occlusion, physical rows, resize and navigation.
- 2026-10-04 — fresh UI review found multiline prompts could break the frame
  and a test's forced completion hid broken Escape handling. Normalize row
  whitespace at the frame boundary and require the real close callback
  (`tests/regression/browser-layout.test.ts`).
- 2026-10-06 — #122 final review: diagnostic roots are not engine agentDir, and content-only warnings vanish in metadata renderers. Reserve runtime namespaces across copying/snapshots/evidence; clone per-return warning details and render them in live/replay views (public Git/PTY and registered-renderer regressions).
- 2026-10-06 — #122 first review reproduced diagnostic throws stranding answered workers and bypassing shutdown. Logging is an owned, nonthrowing observation; real-PTY dual-destination failures enforce lifecycle independence.
- 2026-10-06 — #122 namespace review reproduced ordinary POSIX backslash filenames being omitted. Use platform path separators; public copy and attribution regressions retain the exact filename.
- 2026-10-06 — delegated edit scripts used bare `python3` despite the standing uv rule. Corrected the worker: Python edits also require `uv run`; Bun remains preferred here.
- 2026-10-07 — #50/#51 implementation repeated bare `python3` edit scripts despite the uv rule; corrected to Bun edits in the shared implementation session.
- 2026-10-08 — #128 review: the shipped roster windowing pinned `maxStart` against the raw pane height while rendering `height - 2` items under both `↑/↓ more` indicators — the list tail was permanently unreachable, reintroducing the fleet-scale failure the redesign targeted, and no test drove a roster longer than its pane. Compute the window against the indicator-adjusted fit and pin the windowed regime (last item reachable, no residual `↓ more` at the tail) with an over-pane test.

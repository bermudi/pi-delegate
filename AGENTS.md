# pi-delegate v2

A [Pi](https://github.com/earendil-works/pi) extension providing the
`delegate`, `delegate_ticket`, and `delegate_session` tools: subagent
dispatch, async tickets, pooled sessions, and workspace isolation.
This is a specification-first project. `SPEC.md` (v3) is the sole
behavioral authority; `SPEC-V2.md` is the engine-as-built contract v3
inherits. The v1 repository at `../pi-delegate` is **retired as an
oracle** — consulted only as historical evidence for restorations —
and v1→v2 migration guidance lives in `COMPATIBILITY.md`. v3 is owned
by the project agent (stewardship delegated 2026-09-27; decisions per
SPEC.md's ratification record).

Before implementing or changing behavior, read `SPEC.md`, `INVARIANTS.md`,
and `COMPATIBILITY.md` — they are authoritative and describe outcomes, not
mechanisms. Before migrating or writing tests, read `TEST-MIGRATION.md`.

## Guiding principle: the weights are the platform

The models calling this extension were RL-trained on the incumbent
professional harnesses (Claude Code's Task tool, codex's spawn agents,
letta's general-purpose, background-default fan-outs). Their reflexes —
agent names, fan-out shapes, expected semantics — arrive pre-baked in the
weights, and we have no RL flywheel to retrain them. Every design decision
on the model-facing surface answers to this first:

- Meet trained reflexes: accept pro-shaped attempts (alias common agent
  names like `general`/`general-purpose` → `default`, `scout` → `explore`)
  rather than erroring on them.
- Converge where the idiom is arbitrary (names, argument shapes, defaults);
  differentiate only where the difference IS the product (admission,
  workspaces, tickets). Unjustified divergence is a permanent error-rate
  tax on every caller.
- Teach the delta at the boundary: every contract that differs from the
  incumbent default must be legible in the tool description — it is the
  only channel that reaches trained weights.
- Watch for collisions: where a trained reflex hits our walls, prefer
  bending the surface over blaming the model.

Origin: 2026-09-27, the `general` first-call error in a v1 dispatch — a
trained Claude-Code reflex colliding with our registry — and the
17-repo comparison in `~/build/testing/subagents` (no other surface pays
this tax; the pros ARE the training distribution). Candidate applications
on record: agent-name aliases, batch-in-one-call description teaching
(landed), misfire telemetry for rejected calls (landed — `misfires`
table, schema v5+).

## Deployment reality (learned 2026-09-27, the hard way)

Pi loads `npm:@bermudi/pi-delegate` (v1) from `~/.pi/agent/npm/` — **not
this tree**. A green suite says nothing about the installed artifact.
Run the tree per-session with `pi -ne -e <repo>/delegate.ts`; do NOT add
a `.pi/extensions/` shim here — pi hard-errors on duplicate tool names
between project and user extensions, which bricks every normal session
in the repo. v3 has no publish pipeline yet; until it ships, sessions
outside this repo (and panes without `-e`) run v1. The user-global
`~/.pi/agent/delegate.json` also carries v1-era keys
(`agentOverridesByParentModel`) that v3 silently ignores.

Before calling any unit shipped, dogfood it: a fresh `pi -ne -e` session
dispatching a real batch. The 2026-09-27 dogfood caught the deployment
gap, a missing receipt note (#39), and confirmed the wake loop live in
one run.

## Stack

TypeScript (strict), Bun, TypeBox. Our `typebox` pin must mirror Pi's
exact pin (pi-coding-agent's dependency) — schema symbol identity across
instances is why; re-align on every Pi bump. Tests run in-process via
`@marcfargas/pi-test-harness`, which carries a local compatibility patch
(`patches/`) required until upstream supports the pinned Pi version. The
patch covers three seams (verify each on every bump):

- `getModel` from `pi-ai/compat` + `_modelRuntime.setRuntimeApiKey` +
  `agent.streamFunction` — Pi 0.84 auth preflight and renames (pre-0.86).
- Globally unique playbook tool-call ids (`playbook.js`) — Pi >= 0.87
  executes extension tools outside the `agent.setTools()` wrappers, so the
  harness records them only via session events, which dedupe on toolCallId;
  per-run id restarts made later runs' results vanish.
- The event mirror honors `result.isError` (`session.js`) — Pi sets
  `tool_execution_end.isError` only for THROWN errors in every version, and
  delegate reports errors as returned results, not throws.

Pi >= 0.87 also reads the parent transcript itself after each run
(`_checkCompaction`), so "getEntries was never called" is no longer a
valid delegate-only test signal; assert history non-injection by content.

## Workflow

```bash
bun install
bun test                        # pending contract tests list as (todo)
bun run typecheck
DELEGATE_RUN_PENDING=1 bun test # run pending tests for real — they should
                                # fail meaningfully on unimplemented ops
```

### Workflow

Substantial work is planned in GitHub issues: reconcile existing issues before
creating more, plan a bounded unit, build it with meaningful verification, then
review. Small fixes need no issue. GitHub issues are the only backlog; if
`gh` is unavailable, report the blocker rather than creating a local queue.

`SPEC.md`, `INVARIANTS.md`, and `COMPATIBILITY.md` remain the sole behavioral
authorities; issue proposals and plans do not override them. Behavioral
changes require explicit reconciliation in the root contracts.

Approved sequencing (not a second backlog): reconcile existing issues →
background delivery/reliability → worker questions → automatic handoffs →
restart recovery/live browser → later steering/team messages. This is planning
order, not a claim of implemented or newly promised behavior.

## Consulting v1

V1 is evidence for behavior, never a design source. When consulting it:

- extract externally observable behavior, invariants, and regression
  scenarios;
- do not copy its module boundaries, internal APIs, abstractions, globals,
  state machines, test seams, algorithms, or fixtures without independently
  justifying them for v2;
- migrated tests exercise v2 through its public boundary whenever possible.

## Tests

- Classify v1 evidence as contract, regression, or internal per
  `TEST-MIGRATION.md`; discard tests that only pin helpers, private state,
  or decomposition.
- Tests go through the registered `delegate`, `delegate_ticket`, and
  `delegate_session` tools — never import production
  internals, and never add a production export solely for tests.
- Keep provenance: each migrated test cites its v1 source scenario.
- The harness must remain provider-free. Subagent models use pi-ai's `faux`
  provider via `installSubagentModel`, which assumes v2 resolves and streams
  subagent models through the parent session's model runtime.
- Contract tests whose subsystem isn't implemented use `pendingTest` and
  cite what they assert. Promote them to `test` when the behavior lands —
  or sooner if the assertions already hold.
- In tests, the session's `agentDir` is its temporary cwd, so
  `<cwd>/delegate.json` stands in for the user-global config.
- Update `TEST-MIGRATION.md`'s coverage map when migrating or promoting
  tests.

## Constraints

- No module-level mutable application state. Runtime state must have an
  explicit owner and lifetime (e.g. `TicketStore`, `AdmissionController`,
  the extension closure). Immutable constants and stateless helpers are
  fine.
- Subagents inherit the parent's model — inline/default tasks always, with
  no config escape hatch. Only named agents may be overridden via the
  `delegate.json` `"models"` map (scoped per-parent by `"modelsByParent"`,
  entries may carry `:effort`), and callers never pick models or effort: the
  task `model`, `thinking`, and `reasoning_effort` fields are rejected
  (#32, #44). Registry
  resolvability is not authorization; see SPEC.md and COMPATIBILITY.md.
- Markdown profiles (#7): `<project>/.pi/agents` then `<agentDir>/agents`,
  first definition wins, built-ins win name collisions, `.claude/agents`
  never imported. Frontmatter `model:`/`thinking`/`tools` are profile
  defaults below delegate.json pins. `models`/`modelsByParent` keys may name
  built-ins and globally defined profiles only — project profiles pin via
  frontmatter `model:`. Discovered profiles outrank the alias table (#45):
  an authored `general.md` claims `general` and the alias never fires.
- Subagents never nest dispatch (#45): `delegate`/`delegate_ticket`/
  `delegate_session` are stripped — silently — from every child toolset
  (explicit `tools`, profile frontmatter, mirrored parent inventory).
- Until a subsystem is implemented it fails loudly. Scaffold errors and
  scaffold output are not the contract — `SPEC.md` is.
- Do not extend the scaffold to force a migrated test green; let it fail
  meaningfully or keep it pending.
- `INVARIANTS.md` properties are red lines: cancellation/quiescence, session
  reuse, ticket state, shared-write admission, and isolated application must
  not be weakened to make implementation easier.
- Async tickets now save owner-only full outcomes under the agent directory;
  cold polling recovers results, but running snapshots become `interrupted`
  (never resumed or delivered). `operationId` stays host-lifetime; do not
  mistake ticket recovery for exactly-once dispatch.
- Pi's child `AgentSession` auto-retries retryable provider errors by default
  before Delegate sees them. Child session settings disable that in memory;
  Delegate's own side-effect-aware retry decides whether a short retry is
  safe. Recheck this seam on Pi upgrades.

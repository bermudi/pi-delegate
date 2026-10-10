# TEST-MIGRATION — moved tranches and Done list

Moved verbatim from `TEST-MIGRATION.md` on 2026-10-10 (doc audit B7). Contents:
the per-test v1→v2 disposition tables for tranches three through eleven, and the
"Done" run-on list that opened "Next contract slices".

This is process history. The live record stays in `TEST-MIGRATION.md`
(classification, conventions, coverage map, issue records, remaining slices).
Semantic decisions from these tranches live in `SPEC.md` and `COMPATIBILITY.md`.
Test file names and issue numbers inside these sections describe the tree and
tracker as of their date; issue numbers written before the 2026-09-30 tracker
transfer are v2 numbers (add 53).

## Third tranche (foundational execution/lifecycle implementation)

The scaffold boundary was replaced by a real implementation under `src/`:
`validation.ts` (mode/semantic checks), `host.ts` (task resolution +
subagent `AgentSession` construction through the parent's `ModelRuntime`),
`admission.ts` (workspace/session reservations), `coordinator.ts`
(scheduling, bounded concurrency, index-aligned outcomes), `execution.ts`
(one `AgentSession` per attempt, cooperative abort), `tickets.ts` (guarded
ticket lifecycle + RPCs), `retry.ts` (retry classification), `config.ts`
(`delegate.json`), `profiles.ts` (built-in agent profiles).

Semantic decisions recorded during implementation:

- Ticket terminal status: all-ok → `completed`; all-failed → `failed`;
  mixed → `completed` with per-task statuses retained. A forced
  `cancelled` is authoritative immediately; late worker outcomes are
  recorded for visibility but can never change the status.
- Whole-task retry is bounded (max 2 attempts), applies only to clearly
  transient errors, and never replays a task that produced side effects or
  owns a `sessionId`/`resumeFrom`.
- Pause parks queued tasks before slot acquisition and parks in-flight
  tasks between model turns via `prepareNextTurnWithContext`; a paused
  ticket keeps its reservations.
- `wait` timeout or caller abort detaches only that waiter.
- Stall is an inactivity watchdog fed by session events (`delegate.json`
  `stallTimeoutMs`, default 15min, 0 disables). It settles a task as failed
  with stall wording — distinct from operator cancellation —
  freezes while a worker is parked between turns, and evicts a pooled
  session after a prompted run.
- Subagent sessions are extension-free, in-memory-transcript, and stream
  through the parent `ModelRuntime` (reached via `modelRegistry.runtime`,
  a private-field seam that fails loudly if upstream changes it).
- Known harness quirk: a schema-level rejection never calls
  `tool.execute`, so the synthesized `tool_execution_end` record is the
  only result evidence — and the harness dedupes it by a playbook
  `toolCallId` that repeats across `session.run` calls on one session.
  Tests asserting a schema rejection therefore need a fresh session per
  malformed call.

Promoted to live tests: all of `dispatch.test.ts` (6), `tickets.test.ts`
(7), `validation.test.ts` semantic tests (8), `failure-propagation.test.ts`
(3 pending), the first three `workspaces.test.ts` admission cases, and the
`resumeFrom` + busy-ticket cases in `sessions.test.ts`.

## Fourth tranche (adversarial correctness review)

Public-boundary regression tests added for defects found in review:

- `tests/regression/cancellation.test.ts` — queued-behind-bound cancellation
  never reaches the provider; paused-between-turns cancellation starts no
  further call; mid-stream abort is a cancellation, not an error.
- `tests/contract/dispatch.test.ts` — the configured bound now actually
  limits (read-only tools keep writers out of serialization); the bound is
  re-read per call in both directions; a `concurrency.models` per-model
  bound serializes below the global limit. The former parent-transcript
  injection test is superseded by the deliberate #14 removal below.
- `tests/contract/workspaces.test.ts` — `GIT_DIR` redirect +
  bash-capable multi-writer batch fails closed; the Git scope probe
  scrubs inherited `GIT_*`.
- `tests/regression/failure-propagation.test.ts` — safe retries and backoff
  carry no task wall-clock budget (#118).
- `tests/contract/sessions.test.ts` — `resumeFrom` without a prompt sends
  the default continuation instruction over the rehydrated transcript.

## Fifth tranche (caller settlement vs worker quiescence)

The investigation confirmed a real indefinite-settlement defect: Pi's
`session.abort()` waits for `waitForIdle()`, and the agent loop's
provider-stream and tool awaits do not race the abort signal — so a
non-cooperative provider/tool left `prompt()` pending forever and a
synchronous dispatch never returned (proven by a test that timed out at 5s
on the pre-fix implementation; now exercised with the stall watchdog after #118).

The lifecycle now separates three concepts in `TaskExecution`:

- **caller settlement** (`result()`): resolves with the true outcome when
  the run winds down, or a provisional cancelled/stall outcome the
  moment cancellation is requested — never blocked on cleanup;
- **worker truth** (`settled()`): resolves only when `prompt()` +
  `waitForIdle()` actually settle — confirmed quiescence;
- **resource eligibility**: provisional outcomes are `quarantined`, so the
  grant retains their reservations at call end; when `settled()` later
  confirms quiescence (`quarantined: false`), `grant.releaseRetained`
  frees them. A worker that never settles keeps them for process life.

New regression tests in `tests/regression/cancellation.test.ts`:

- forced cancel settles while a gated provider blocks cleanup, conflicting
  work rejects during quarantine, the reservation releases only after the
  worker demonstrably winds down, and the ticket stays cancelled;
- a sync call returns a structured stall outcome while the worker is
  still gated, holds the reservation during quarantine, and admits the
  same scope once quiescence is confirmed.

## Sixth tranche (isolated workspaces)

`src/isolated.ts` implements `workspace: "isolated"` end to end. Each call
captures one synthetic baseline commit per Git source root — tracked,
deleted, and untracked content snapshot via a temporary index, so the
user's real index and branch never move — then runs each task in a
detached worktree created from that baseline. After execution, successful
workers' trees are snapshotted to private refs and full `--binary` patch
files under `<agentDir>/delegate-isolated/<batch>/`, and reconciliation
applies each accepted proposal to the source in task order via
`git apply --check` + `git apply --binary`. Per-proposal application means
a drifted/conflicting proposal is retained with its ref/patch/worktree
while later independent proposals still apply; an aborted or failed apply
restores expected pre-apply content from the pre-image and preserves
recovery artifacts. Cancellation before source apply retains proposals
instead of applying them; quarantined workers are discarded (never
snapshotted) and their worktrees/refs are retained until quiescence is
confirmed, with deferred cleanup through `releaseRetained`.

Lifecycle wiring: `delegate.ts` admits reservations, prepares workspaces,
then runs the coordinator with a `finalize` hook so reconciliation
completes inside the reservation window; tickets hold caller-visible
settlement (`holdSettlement`) until reconcile finishes while forced
cancellation still settles immediately — its proposals are then retained,
never applied. `TaskOutcome.integration` records per-task
`applied_unverified` / `conflict` / `retained` / `discarded` /
`no_changes` / `apply_failed` detail rendered in both the sync result
block and ticket views.

Promoted to live tests: ordered reconciliation and conflict retention in
`tests/contract/workspaces.test.ts`. The conflict test gates the first
worker's provider response so the source drift lands deterministically
between baseline capture and reconciliation; `gitInit` now creates an
initial commit since isolated baselines require `HEAD`. The
unimplemented-modes test now covers only `scratch`.

Steering additions in the same tranche (observed failure: a five-task
same-repo shared batch serialized into an hour-plus pipeline when the
tasks were independent and `isolated` was the right call):

- A batch-level `workspace` field defaults every task that does not name
  its own — `delegate({ workspace: "isolated", tasks: [...] })` is the
  one-field spelling of parallel same-repo edits. It is rejected when
  orphaned on ticket/session operations.
- Schema descriptions and the help manual now carry the decision rule:
  `shared` wants `dependsOn` ordering between same-root writers and rejects
  same-phase unordered overlap with enumerated remedies (#126);
  cross-phase writers serialize in task order; `isolated` runs independent
  edits in parallel and merges in order.
- Admission exposes `serialized` groups on the grant (cross-phase only
  since #126); results prepend a notice naming the serialized tasks and
  scope with the isolated remedy (sync: live `onUpdate` frame plus the final
  result; async: ticket creation text and poll/wait views).

New live tests: the serialization test asserts the notice and remedy; a
batch-default test proves parallel isolated execution and source
reconciliation; an override test proves a task-level `shared` still wins
and therefore rejects against isolated siblings.

A fresh-context review pass then hardened the lifecycle edges:

- `runOne` can no longer reject: a `runTask` throw is converted to a failed
  outcome — quarantined only when a worker session may exist (a loader
  rejection is provably pre-worker). `Promise.all` cannot reject while
  siblings still run, `finalize` always executes, and reservations are
  never released mid-write by a sibling fault.
- Serialized successors now gate on the predecessor's *confirmed*
  quiescence, not its caller-visible record — a provisional quarantined
  predecessor may still be mutating the shared root.
- `markGroupFailure` no longer rewrites already-terminal integrations
  (`applied_unverified`, `discarded`) as `apply_failed`.
- Aborted `--check`/snapshot operations report `retained`, not a
  source-drift `conflict` or `apply_failed`.
- An empty chain delta (identical earlier proposal) is `applied_unverified`
  — `git apply` rejects empty input.
- Apply rollback restores only the delta's touched paths, not the
  proposal's whole file list.
- Isolated regression coverage in `tests/contract/workspaces.test.ts` now
  faults the source `git apply` after a partial write (restoring actual
  pre-apply bytes and mode while leaving an intervening human edit in place),
  verifies empty and partially duplicate proposals against the live source
  before reporting success (including dependent blocking), and exercises
  symlink link-text blob comparisons. These are public-tool faux-provider
  regressions of the v1 isolated-workspace ordered apply/conflict/duplicate
  scenarios, not tests of private reconciliation helpers.
- The artifact root is excluded from baseline snapshots when it lives
  inside the source tree, so retained artifacts and live worktrees cannot
  leak into a baseline or a later proposal.
- Top-level `sessionId` combined with `tasks` is rejected instead of
  silently ignored; cleanup no longer issues `update-ref -d` for
  never-created proposal refs.

## Seventh tranche (pooled sessions)

`src/sessions.ts` implements `sessionId` pooling, `delegate_session` RPCs, and
shutdown. The pool is owned by the extension closure; admission's
busy-session marks already serialize same-ID calls across acquisition,
execution, and state update, so no second locking layer exists.

- **Checkout/reuse:** `TaskExecution` checks the pool before creating a
  session. A hit means no creation and no pre-prompt abort — the session is
  quiescent by definition. The between-turn pause hook
  (`prepareNextTurnWithContext`) is restored at run end so a reused session
  carries no stale controls, and per-run usage is diffed against the
  session's cumulative stats.
- **Durable transcripts:** `sessionId` tasks create a file-backed
  `SessionManager` under `<agentDir>/delegate-sessions/`; `resumeFrom`
  transcripts are already durable. Insert-on-success requires the file to
  exist.
- **Frozen config:** cwd, tools (order-independent), thinking, model, and
  base prompt are compared against the resolved task. `validateReuse` runs
  before admission so a mismatch fails the whole call; `checkout`
  re-verifies so a close-and-recreate race degrades to a task failure.
  `resumeFrom` on an already-live sessionId rejects.
- **Settle policy:** ok+prompted keeps/inserts; prompted cancel or stall
  evicts; pre-prompt cancel leaves the session intact; ordinary
  failure keeps a pooled session reusable; quarantined sessions are evicted
  but never disposed.
- **RPC:** `list` shows live entries (running marked); `close` rejects
  busy/missing sessions, otherwise removes, aborts, and disposes.
- **Shutdown:** `session_shutdown` closes the pool to new reuse, requests
  termination of checked-out sessions (their runs own disposal through
  settle), disposes idle ones, and logs every cleanup failure.

Promoted to live tests: pool + list + continuation, close-then-fresh, and
frozen-config rejection in `tests/contract/sessions.test.ts`; the
tool-boundary scaffold assertion now expects the real `list` roster.

## Eighth tranche (scratch workspaces)

`src/scratch.ts` implements `workspace: "scratch"` end to end. Each scratch
task gets its own copy of its source tree — the Git top-level when the cwd
sits in an ordinary repository (the copied `.git` keeps Git commands
contained), otherwise the cwd itself — created with `cp -a --reflink=auto`
and a `fs.cp` verbatim-symlink fallback for non-GNU cp. Task cwds are
remapped into the copy before dispatch; copies live under
`<agentDir>/delegate-scratch/pid-<pid>/<batch>/`, never beside the source.

Semantic decisions recorded during implementation:

- **Read-only tasks reject.** A task whose resolved tools are all
  read-only cannot use scratch: the copy buys nothing and the failure
  teaches the caller. `explore + bash` stays legal — bash can dirty the
  tree, which is exactly what scratch contains.
- **Linked worktrees and submodules reject before copying.** A `.git`
  file at the source root redirects Git into another repository, so
  commands inside the copy would mutate the real repository's metadata —
  the one escape an ordinary relative write cannot take. The error names
  the `shared`/`isolated` remedies. This check is a stat, not a paid
  copy — the v1 failure mode of discovering this after copying is gone.
- **Symlink escapes are preserved, not rejected.** V1 refused links
  pointing outside the copy, which made scratch deterministically useless
  on pnpm/bun-style layouts. Scratch is not a security boundary
  (`SPEC.md`); reading through a link is not an ordinary relative write.
- **No fallback to shared.** Scratch's whole value is containment; an
  actionable error is the fallback path, and the preflight makes it cheap.
- **No source reservation.** Scratch tasks never write the source via
  relative paths, so they hold no admission reservation — a scratch task
  runs alongside an overlapping shared writer.
- **Cleanup is quiescence-gated.** `finalize` discards copies of
  confirmed-quiescent workers; a quarantined worker's copy is retained
  until `cleanupWorker` sees confirmed quiescence. Copies from dead
  processes are swept on the next scratch preparation in any session.
- `finalize`/`dispose` never throw — cleanup failure is litter, not an
  outcome change; it is logged.

Promoted to live tests: the scratch-discard contract test. New live tests:
read-only rejection, linked-worktree rejection with remedy, no
shared/scratch reservation conflict, dead-process sweep, and a non-Git
cwd copy.

## Ninth tranche (no caller model selection)

Tasks no longer select models at all. The task `model` field is rejected
whole-call with guidance toward the config. Model assignment is
user-only and inheritance-first: inline tasks and the `default` profile
mirror the parent's model unconditionally — there is no `default` config
entry, and `models.default` is rejected at load. Only a named agent may be
overridden, via its entry under `"models"` in the user-global `delegate.json`
(object: agent name → reference). Recorded as a deliberate breaking change
in `COMPATIBILITY.md` with migration guidance. This supersedes the interim
allowlist design from earlier in the same tranche (which briefly had a
configurable `default` — the wrong knob: inheritance is the invariant).

- `src/config.ts` parses and validates the `models` map — keys must name a
  known non-default agent (typos fail at load, and `default` is rejected
  with an explanation), values non-empty trimmed references — and resolves
  per task: agent entry → parent model, with inline/default never consulting
  config at all.
- `src/validation.ts` rejects any task `model` field before tasks start;
  the schema keeps the key so the rejection is a targeted, teachable error
  instead of a generic unknown-property failure.
- `src/host.ts` resolves the configured reference through the registry; a
  configured-but-unresolvable entry fails the whole call naming the entry
  and config path.
- The model-failure recovery hint addresses the operator (reconfigure
  delegate.json), not the caller (which has no model recourse).
- Test support: `installSubagentModel` sets the parent session's model to
  the faux provider (inline tasks inherit it for real) and installs a
  second faux provider (`alt`) for override proofs; every task input across
  the suites dropped its `model` field.
- New live tests: task `model` field rejection (nothing starts); a named
  agent's entry overrides the parent model while inline tasks provably
  inherit it (two providers show which served each task);
  configured-but-unresolvable entry rejection; a pooled session whose
  agent's configured model changed between calls rejects as a frozen-config
  mismatch (`tests/contract/sessions.test.ts`).

## Tenth tranche (effort is user-configured; modelsByParent)

Issue #32 extends the no-caller-selection stance to effort: the task
`thinking` field is rejected exactly like `model` (inside a task,
flat-folded, top-level, and on the sibling tools), and `models` entries
gain an optional `:effort` suffix plus a `modelsByParent` map scoped to the
parent's exact `provider/model-id` (case-insensitive; scoped wins over
unscoped). Effective effort: configured `:effort` → profile default →
parent's live level when the child runs the parent model → the model's
default. Recorded in SPEC.md "Dispatch" and COMPATIBILITY.md.

- `src/config.ts` parses `provider/model[:effort]` entries and the
  `modelsByParent` map (keys normalized lowercase; a key that is not a
  `provider/model-id` fails). Review tightening: a `modelsByParent` key
  that could never match — extra slashes, internal whitespace — is
  rejected at load with the dead-shape message; covered in
  `tests/contract/dispatch.test.ts` along with the case-insensitive
  parent-mirror (a pinned model equal to the parent's modulo case still
  inherits the parent's live effort level). (2026-09-25 reversal of part
  of that tightening: model ids legitimately carry colons —
  `ollama/qwen2.5:32b` — so only a trailing *known* level strips as
  `:effort`; any other `:segment` stays in the reference and fails at
  resolution, and colon-bearing `modelsByParent` keys are valid. The
  dispatch suite covers a verbatim colon pin plus a colon-keyed scoped
  match against a colon-id parent. A later review reversal: slash-bearing
  model ids are valid too — OpenRouter keys are provider + "/" + the
  full id (`openrouter/anthropic/claude-sonnet-4`), split on the first
  slash — while empty halves, doubled slashes, and internal whitespace
  still fail at load; covered by a key-load test plus the extended dead-
  shape cases in `tests/contract/dispatch.test.ts`.)
- `src/validation.ts` and the boundary layer reject `thinking` wherever it
  appears with guidance toward the config — the field left the task schema
  entirely.
- `src/host.ts` resolves the scoped pin first, then unscoped, then the
  parent mirror; effort resolves per the chain above.
- New live tests: `thinking` rejected in all positions
  (`tests/contract/validation.test.ts`); a matching `modelsByParent` key —
  deliberately upper-cased — wins over `models`; a non-matching key falls
  back; and a `:effort` pin reaches the provider as `reasoning` while a
  bare pin does not inherit the parent's level and an unpinned task
  mirrors it (`tests/contract/dispatch.test.ts`).

## Eleventh tranche (named Markdown agent profiles)

Issue #7 lands user-defined profiles. `src/profiles.ts` gains
`discoverProfiles(cwd, agentDir)`: `<project>/.pi/agents` (nearest ancestor
of the parent cwd) then `<agentDir>/agents`, first definition wins, built-ins
always win name collisions, `.chain.md` skipped, malformed files skipped
with a logged warning. Frontmatter: `name` + `description` required;
`tools` (`*`/`ro`/comma list), `thinking` (level), `model`
(`provider/model[:effort]`) optional; the body is the system prompt.
Claude Code directories and `disallowedTools` are not imported.

The catalog is an explicit per-dispatch value threaded through the pipeline
(no module state): `delegate.ts` discovers → `loadDelegateConfig` accepts
`catalog.globalNames` as additional `models`/`modelsByParent` keys (only
globally defined names — a user-global config cannot name a project-local
profile) → `resolveTasks` looks agents up in the catalog. The model chain
becomes parent-scoped pin → unscoped pin → profile `model:` → parent; the
effort chain keeps profile `thinking` below a delegate.json `:effort`.
Agent-name existence left `validateTasks` for `resolveTasks` — validating
against built-ins alone would reject legitimate custom names — so the
unknown-agent error now lists every discovered name.

New live tests in `tests/contract/profiles.test.ts` (v1 evidence:
`agents.test.ts` native-loader scenarios): a global profile runs with its
own tools/prompt/thinking; a frontmatter `model[:effort]` pin routes the
child; project wins over global; built-ins win over same-named files; a
`models` pin beats frontmatter `model` (and proves a custom name is a valid
config key); a malformed profile is skipped with a warning and stays
unknown. Discovery assertions observe the provider-facing transcript
(system message prompt/sections, `toolsAdded`, stream `reasoning`) rather
than internals.

Post-landing review additions (still in `profiles.test.ts`): an unreadable
file (chmod 000, skipped as root) warns like any other bad profile instead
of looking missing; a broken file warns once per session, not once per
dispatch; same-named files in one directory resolve in filename order
(files created in reverse order so creation order cannot masquerade);
the manual's profile listing is silent and does not spend the session's
warn-once budget (the first dispatch after help still warns).

Post-landing review fix (still in `profiles.test.ts`): a global profile
name shadowed by a same-named project profile stays a valid `models` key
— first-definition-wins decides execution, but the shadowed global
definition still counts as globally defined — so a `models` pin for it
validates and the dispatch runs the project's prompt.

Review fix in `src/isolated.ts` (covered by the existing
"partially duplicate proposal" regression in
`tests/contract/workspaces.test.ts`): a successful forward `--check`
proves only the chain edge, so files the merge dropped from the edge
(identical to an earlier, since-conflicted proposal) are verified against
the live source before the verify-before-write/write — a partial
duplicate becomes a conflict instead of claiming `applied_unverified`
with `appliedFiles` for files that never landed.

## Done list (moved from "Next contract slices")

Done: mode exclusivity and validation failures; batch-before-start
validation and input-ordered results; ticket lifecycle, wait, cancellation,
and pause; persistent session reuse, frozen configuration, close, and
shutdown; shared-write admission and same-call serialization; isolated
all-or-nothing application; cancellation safety and quarantine; background
delivery on the stock Pi extension API (issue #3; `SPEC.md` "Background
delivery", `tests/contract/delivery.test.ts`) — no Pi patch was added to
`patches/`; opt-in content-free local telemetry with privacy exclusions and
v1 migration preservation (issue #8; `SPEC.md` "Telemetry",
`tests/contract/telemetry.test.ts`); bounded duplicate-safe dispatch
identity via `operationId` (issue #16; `SPEC.md` "Explicit operation
identity", `tests/contract/operations.test.ts`); LLM-facing output
bounding with owner-only spill files, running-poll tail-only views, and
lossless fallback (issue #25; `SPEC.md` "Output bounding",
`tests/contract/output-bounds.test.ts`); user-configured model/effort with
parent-scoped pins and removal of the task `thinking` field (issue #32;
`tests/contract/dispatch.test.ts`, `tests/contract/validation.test.ts`);
named Markdown agent profiles with project/global discovery, built-in
collision precedence, and frontmatter model/thinking/tools (issue #7;
`tests/contract/profiles.test.ts`); v3 interaction grammar — cardinality
defaults (now always background), exact agent names, and misfire telemetry (issue #35;
`SPEC.md` "Interaction grammar"/"Canonical surface"/"Observability",
`tests/contract/grammar.test.ts`, `tests/contract/telemetry.test.ts`);
wake coalescing — simultaneous settlements batch into one steering wake
grouped by leaf routing (issue #36; `SPEC.md` "Wake delivery",
`tests/contract/delivery.test.ts`); task steering with delivery
receipts — turn-boundary `steered`, parked `activated`, idempotent
`duplicate`, and `not-applied` on settled/unknown/recovered targets
(issue #37; `SPEC.md` "Steering", `tests/contract/steering.test.ts`,
`tests/contract/recovery.test.ts`); ticket interrupt — a cooperative
per-task abort settling `interrupted` with resumable workers (issue
#42; `SPEC.md` "Interrupt", `tests/contract/interrupt.test.ts`); the
shared batch `brief` — with `context` covered as a rejected spelling,
not a fold (issue #43; `SPEC.md`
"Batch brief", `tests/contract/brief.test.ts`).

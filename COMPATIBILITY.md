# Delegate v2 compatibility contract

## Task deadlines removed (#118, user-approved)

BREAKING: `deadlineMs` is removed in both compact and full mode. Its presence
rejects before execution, including null and flat/stringified recovery shapes.
Remove it from calls: tasks have no wall-clock deadline. Use cooperative ticket
cancel/interrupt to stop work; wait/tail timeouts only detach the waiter.
Historical saved deadline failures remain readable. This explicitly overrides
SPEC-V2's deadline field and its loading, retry, pause, question, and session
rules. Stall detection, abort/quiescence, reservations, worker-question/paused
safety, ticket wait/tail bounds, shutdown bounds, and token budgets are unchanged.

## Simplified v3 surface (#61, user-approved 2026-09-29)

This section supersedes the older alias and cardinality entries below.

- BREAKING: omitted `async` now means background execution for one task as
  well as many. Add `async: false` where inline results are required.
- BREAKING: cross-harness field synonyms and built-in name translations are
  removed. Use `agent`, `prompt`, `id`, `async`, `brief`, and
  `timeoutMs`, plus exact built-in or authored profile names. Removed
  fields reject the entire call, including null values. Existing saved
  ticket metadata remains readable; it does not authorize new alias calls.
- BREAKING: the default advertised and accepted surface is compact.
  Set `"surface": "full"` in user-global `delegate.json` and reload to
  retain all canonical advanced call controls. `"surface": "compact"`
  is the default. Invalid surface values fail visibly; no per-model choice.
- Malformed supplied non-array `tasks` reject instead of being discarded by
  flat recovery. Schema diagnostics exclude request-body dumps; pre-schema
  rejection telemetry stores those safe messages verbatim, never prompts or
  base instructions. Non-object calls also record empty-shape misfires.
  Recovery guards omit malformed values; correction examples retain relevant
  addresses but use placeholders for task/message/answer bodies.
- Reusable tools/base-instruction choices belong in Markdown profiles;
  explicit per-task overrides remain available in full mode. Dependencies,
  budgets, resume, pooled sessions, output tailing and pause/resume
  are not deleted. Compact ticket waits have no caller timeout; explicit
  polling is immediate and full mode retains detach-only `timeoutMs`.
- No changes to cancellation, workspace admission/application, session
  freezing, model authorization, usage, durable results, or delivery.

## v2 → v3 changes (SPEC v3, ratified 2026-09-27)

v3 is a contract layer on the same engine. Caller-visible changes:

- **BREAKING — multi-task batches default to async.** A `delegate` call
  with two or more tasks now returns a ticket immediately and
  auto-delivers the settled result, instead of blocking. Callers that
  relied on the v2 blanket sync default must pass `async: false`.
  Single-task calls still block inline by default; `async: true`
  overrides either way.
- **Additive — agent-name aliases.** `general`, `general-purpose`,
  `worker` resolve to `default`; `explorer`, `plan`, `scout` to
  `explore`; `implement` to `coder`. Exact case-sensitive match;
  expansion is
  visible in results; unknown names still error with the available
  list. Config model pins key on the canonical name.
- **Renamed — the read-only built-in is `explore`, not `scout` (#40).**
  The trained read-only name is canonical; `agent: "scout"` still works
  through the reverse alias with the usual visible expansion note.
  **Breaking for config:** `models.scout` and `modelsByParent` `scout`
  keys are rejected at load with a migration message — rename them to
  `models.explore`. Built-in semantics (toolset, role, read-only
  concurrency) are unchanged.
- **Additive — misfire telemetry.** Dispatches rejected before
  execution record a telemetry row. No behavior change.
- **Additive — cross-harness task-field spellings (#41).** Task objects
  accept `subagent_type` (normalizes to `agent` before alias
  resolution), `description` (≤200-char display label preferred over
  the id in call rows and section headers — not a correlation key),
  and `run_in_background` at top level or per task (normalizes to
  `async`). Conflicting spellings (`agent` vs `subagent_type` naming
  different agents, `async` vs `run_in_background` disagreeing) are
  validation errors naming both; each applied rename is reported as
  `field "<field>" → "<to>"`. `additionalProperties: false` stays.
- **Additive — shared batch `brief` (#43).** Top-level `brief` prepends
  a `--- batch brief ---` preamble to every task's prompt; the result
  and ticket headers name it once. `context` is its cross-harness
  spelling — it normalizes to `brief` with the same rename note, and
  `brief`+`context` with different text errors naming both. The
  removed task-level `context` (v1's `fresh`/`with-parent-transcript`)
  still rejects with migration guidance — at top level those trained
  enum values keep the removal error rather than folding.
- **Changed — default `maxConcurrent` is 8, not 3 (#41).** Field
  survey: letta/grok/oh-my-pi default 32; minimax/deepseek/MiMo/fx
  uncapped. The `concurrency` maps remain the rate-limit guard.
- **Additive — trained-reflex long tail (#44).** `agent_type` folds
  to `agent` with `subagent_type`'s conflict rules; `task_name` →
  `id` and a task-shaped `message` → `prompt` on `delegate` (the
  spawn_agent call dispatches; a bare `message` still routes to
  `delegate_ticket` steer guidance, and `message` stays steer-owned
  there); `timeout_ms` → `timeoutMs` on `delegate_ticket wait`;
  `explorer` → `explore`; `reasoning_effort` rejects with the
  `thinking` teaching at every level; `steerId` is optional — a
  steer without one receipts under a derived `steer:<tool-call-id>`
  key so a transport retry dedupes instead of re-injecting.
- **Changed — alias precedence and no nested dispatch (#45).**
  Discovered user/project profiles claim their exact names ahead of
  the alias table — an authored `general.md` resolves to that profile,
  not `default` (built-ins still win collisions). And the delegate
  family is stripped silently from every child toolset — explicit
  `tools`, profile frontmatter, and the mirrored parent set alike —
  so subagents never nest.
- **Changed — pooled-session idle residency is bounded (#46).** Idle
  sessions beyond `sessions.maxIdle` (default 4) unload to their
  transcript and transparently reload on the next reuse — callers see
  no difference; memory footprint drops. Checked-out sessions are
  never evicted, `maxIdle: 0` unloads everything settled, and
  `delegate_session` `list`/`close` cover unloaded records.
- **Additive — batch `tokenBudget` (#47).** Optional positive-integer
  ceiling on a dispatch's recorded token usage: once settled tasks
  charge the account past the limit, queued tasks settle
  `budget-exhausted` (running tasks always finish), dependents block
  naming the budget, and `details.tokenBudget` plus the telemetry row
  carry `{limit, consumed, exhaustedAt}`. Absent by default — nothing
  changes for budgetless calls.
- Landed since: steering receipts (#37), `delegate_ticket interrupt`
  (#42 — abort one task's in-flight turn; it settles `interrupted`,
  resumable, distinct from `cancel`'s ticket teardown).
- **Changed — shutdown quiescence is bounded (#52, 0.3.2).** Session
  shutdown waits for live dispatches' confirmed quiescence up to ~30s
  (`DELEGATE_SHUTDOWN_QUIESCENCE_MS`), then proceeds, logging the
  still-unconfirmed dispatch names. Previously the wait was unbounded: a
  worker whose provider/tool ignored abort wedged host exit forever.
  No reservation is ever released by the expiry — confirmed quiescence
  remains the only release, so the bound costs protection only against
  workers that would outlive any bound anyway.

## Status and rule

This is the v2 rewrite boundary extracted from v1's README, schemas, ADR,
context glossary, and tests. “Preserve” means callers and operators can rely on
the semantic outcome.

V1 implementation details are explicitly non-binding. Its module boundaries,
algorithms, event-loop heuristics, timeout constants, lock structure, ticket
state machinery, temporary-index strategy, worktree/ref/patch representation,
database layout, and test seams do not become v2 requirements merely because
they were necessary in v1.

Any departure from the preserve list is a deliberate breaking change and needs
release notes and migration guidance; it must not arrive as rewrite drift.

## v2 preserves

### Calls and configuration

- The three sibling tools — `delegate` (dispatch and manual),
  `delegate_ticket`, and `delegate_session` — with their canonical fields,
  dispatch-wide `async`, canonical task fields, closed enum values, and
  batch-before-start validation described in `SPEC.md`.
- Defensive normalization of stringified tasks, flat task calls, string tools,
  empty agent names, `null` fields, and blank optional identifiers.
- Top-level-only session RPC on `delegate_session`. Task-level `async` and
  `sessionAction`, an `action` field on `delegate` itself, and unsafe-write
  bypasses remain rejected (all of them — see the breaking-change entry
  below).
- `default`, `explore`, `coder`, and `reviewer` semantics; task-over-profile
  precedence; Markdown discovery order and first-definition wins — subject to
  the model-selection, parent-history, and composed-child-base-prompt
  departures below.
- User-global `delegate.json` configuration. Project files do not become
  delegate configuration.
- Parent model inheritance and project instructions and extension isolation, with children
  resolved through the parent's shared model runtime (extension-free; no
  provider-extension allowlist — verified live 2026-09-26, issue #5) and the
  meanings of `*` and `ro`, subject to the model-selection and parent-history
  departures below.

### Execution and state

- Async worker questions (#17) are additive: a child-only `ask_parent` tool
  parks the worker, and a ticket-scoped `answer` RPC resumes it. Sync workers
  do not expose the tool. A ticket wait now returns early when a worker asks,
  so a parent already waiting on that ticket can answer instead of deadlocking.
  This does not add general messaging or steering.

- Input-ordered sync results, bounded global/per-model concurrency, cooperative
  cancellation, retry accounting, and compaction-inclusive usage accounting.
- Live host-lifetime sessions keyed by `sessionId`; durable recovery through
  explicit `.jsonl` `resumeFrom`, not automatic pool recovery after restart.
- Frozen session configuration, same-ID serialization, insert-on-success,
  explicit close, and parent-shutdown cleanup.
- Async fire-and-forget tickets, poll/wait/cancel/pause/resume behavior,
  idempotent settlement, retained results, and session-tree leaf-aware delivery
  as specified in `SPEC.md` "Background delivery".
- Saved async ticket results are pollable on a cold extension instance; an
  unfinished snapshot is `interrupted`, not resumed or automatically delivered.
  Recovered cancelled tickets warn in the roster when a recorded worker's
  termination was unconfirmed, even if all task outcomes were saved.
  Subagent Pi auto-retry is disabled in favor of Delegate's bounded,
  side-effect-aware retry, including provider reset-window handling. Explicit
  credential failures outrank incidental rate-limit metadata; explicit
  unhinted 403 rate limits may retry before side effects, but bare 403 does not.
- Operation on a stock, unmodified Pi installation through its public
  extension API. Requiring a patched, forked, or unreleased Pi host is a
  breaking change, not an implementation detail.
- Pause as a cooperative boundary between tasks/model turns—not OS process
  suspension; tasks now have no wall-clock deadlines (#118).

### Workspaces and safety

- `shared` edits the source tree; `scratch` discards a reflink copy;
  `isolated` reconciles Git proposals. Scratch and isolated remain one-shot and
  are not advertised as security boundaries.
- Fail-closed shared-write admission, canonical overlap rules, unknown tools as
  writers, same-call serialization, and cross-call rejection.
- Isolated preservation of dirty/untracked baseline state and the user's
  branch/index; task-order, all-or-nothing application; retained conflict and
  cancellation artifacts; `applied_unverified` wording.
- The safe-reuse, safe-cleanup, and quarantine outcomes in `INVARIANTS.md`;
  v1's quiescence-barrier algorithm is not preserved.

### Signals and data

- Actionable errors that preserve the relevant correction, even if wording
  changes.
- Host-compatibility probes at session start log, they never throw
  (issue #9, additive): the reaches into Pi internals a dispatch depends
  on — the parent model-runtime handle and agent-directory resolution —
  are probed on `session_start`, and a failure there is logged with its
  cause and a note that dispatch will fail on it. A throw (an extension
  error) would reach every session — including chatters who never
  dispatch — and the model wiring is not guaranteed final that early, so
  the definitive failure stays at first dispatch with the same actionable
  message as before the probe existed.
- Aggregate usage on synchronous tool results where supported. Async delivered
  messages still cannot add usage to the parent total.
- Optional duplicate-safe dispatch identity (`operationId`, issue #16): an
  additive contract — a keyed call with the same normalized request reuses
  the original in-flight or settled result, and a keyed call with a changed
  request conflicts. This is not content deduplication — unkeyed dispatches
  always execute — and not an exactly-once crash/restart guarantee —
  identity is host-lifetime only with bounded retention.
- Explicit task dependencies with output and workspace handoffs (issue #18):
  an additive contract — a task `dependsOn` field names same-batch
  prerequisites by id; the graph is fully validated before spawn; the batch
  runs in dependency phases so a later phase's tree always contains earlier
  phases' applied isolated work; each prerequisite's bounded output is
  appended to the dependent's prompt; a failed, cancelled, or unapplied
  prerequisite blocks its dependents as `blocked` with visible reasons while
  unrelated branches run. Same-call shared/isolated write-scope overlap is
  newly admitted when the graph orders every overlapping cross-kind pair —
  a relaxation of a former whole-call rejection, in the permissive direction.
- Opt-in, fail-open local telemetry that never stores prompt/output content,
  with stable call/task outcome meaning and explicit migration or versioning
  for existing databases. Telemetry stays disabled unless the user sets
  `telemetry.enabled: true` in `delegate.json`; v2 records only dispatch and
  outcome metadata for batches that reach a completed outcome — the batch
  start timestamp and wall duration, sync/async mode, task count, terminal call
  status, caller-visible task status, agent/model/thinking/tools/workspace
  selections, integration status, retry count, and numeric token/cost usage —
  plus caller-visible task outcomes with unconfirmed-quiescence rows marked
  provisional — and never prompt, system-prompt, output or error text, cwd or
  session paths, caller task IDs, operation IDs, or parent transcript content.
  Existing databases migrate in place and existing rows are preserved; legacy
  sensitive fields are not continued on new v2 rows, and v2 leaves the legacy
  per-task duration column NULL.

## v2 deliberate breaking changes

- **Touched-file attribution reporting removed (user decision 2026-09-27;
  restored under v3 the same day).** V1 reported which physical files each
  task touched — resolved through symlinks with conservative `uncertain`
  flags, external writes through worker links reported at their physical
  paths — in results and poll/cancel/wait views, warned when tasks touched
  the same files (`details.overlapWarning`), and preserved touched-file
  lists on partial failure. V2 outcomes carried no touched-file data at
  all. **Restored under v3 the same day (SPEC v3 "Observability —
  Completion evidence", #38) — see the restoration note below.**
  Same-call writers still serialize (completion notices name the
  serialized tasks) and cross-call conflicts still
  reject. Decided during
  the 2026-09-27 gap audit (V1-V2-MAP §3d item 1).

  **Restored in lighter form by SPEC v3 "Observability — Completion
  evidence" (#38).** V2 now records the paths observed in each task's
  write/edit tool calls — resolved against the task cwd, ordered,
  deduplicated — plus an uncertainty marker when the task ran bash/exec.
  This is evidence, not v1's physical tracking: no inode signatures,
  no symlink canonicalization, no git-diff inference, and no claim about
  paths a tool call never named. Display, overlap reporting, and
  `details.attributedFiles` are the restored surfaces; v1's
  `details.overlapWarning` shape and physical-identity semantics are not.

- **Child base prompt is composed, not precedence-chosen (#33, user decision
  2026-09-26).** V1 picked one prompt by precedence — task, then agent, then a
  string-sanitized copy of the parent's assembled prompt, then stock — so the
  built-in role prompts beat the parent persona, and sanitization was string
  surgery on the merged prompt. V2 composes: children without an authored
  prompt (inline tasks and all built-in profiles) inherit the parent's
  user-authored prompt inputs — custom base prompt and user-appended text,
  taken from Pi's structured prompt options, never the assembled string —
  followed by the built-in role line and a fixed subagent framing appendix
  that carries no model identity. Extension-contributed sections, guidelines,
  and tool documentation are never inherited, and an extension-forced parent
  prompt disables inheritance with a logged skip. Authored prompts (explicit
  task `systemPrompt`, Markdown profile bodies) are used verbatim with nothing
  appended. Migration: none for callers — `default` now genuinely mirrors the
  parent persona, and built-in children keep their role while also honoring
  parent conventions; users who relied on built-in role prompts *overriding*
  parent persona must switch to a named Markdown profile.

- **Parent conversation sharing removed (#14, user decision).** No parent
  transcript extraction or injection remains. The task `context` field is no
  longer advertised or accepted: all supplied values, including `fresh`, reject
  the entire batch before any task starts. This deliberately replaces the old
  `with-parent-transcript` capability, not just its failure fallback.
  Migration: omit `context` and provide a self-contained task brief. Existing
  `context: "fresh"` callers must also omit the field; their intended freshness
  is now unconditional relative to the parent. Project instructions, model
  inheritance, child-owned pooled sessions and explicit `resumeFrom` remain.

- **Mixed-outcome async batches settle as `partial` (#6, user decision).**
  A naturally settled batch where at least one task succeeded and at least
  one did not now reports terminal `partial` instead of v1's implicit
  `completed` — a partially failed batch must never look like a clean
  success. `completed` means every task succeeded, `failed` means no task
  succeeded and at least one failed, and `cancelled` means every task was
  cancelled or the ticket was force-cancelled, which stays authoritative over
  late outcomes.
  Migration: treat `partial` as terminal like `completed`, and inspect the
  per-task outcomes for the failures instead of trusting the headline.

- **Unknown singular ticket RPCs are errors (#6, user decision).** Poll
  with a ticket id, wait, cancel, pause, and resume on a missing id now
  return a tool error naming the ticket instead of a successful "not
  found" response — a lookup miss must never read as success. Roster
  polling without a ticket id is unchanged and still succeeds with an
  empty or populated list.
  Migration: handle singular misses as tool errors; do not rely on
  scanning response text for "not found".

Departures from the preserve list above. Each must carry its own motivation
and migration guidance; none may arrive as silent rewrite drift.

- **Unavailable parent tools fail closed for default-profile inheritance.**
  A throwing active-tool probe no longer silently falls back to writer tools.
  If any `default` task omits `tools`, the whole sync or async call rejects
  before children start, with a logged, actionable error preserving the cause.
  Migration: restore the parent's tool inventory or supply an intentional
  explicit `tools` list (including `[]`) on every affected task. Explicit-tool,
  explore/coder/reviewer, and inline dispatches do not probe the inventory;
  their existing capabilities are unchanged.

- **Markdown profile discovery is narrower and cannot reshape built-ins
  (#7).** V1 searched more locations — including `.claude/agents` under both
  scopes and the legacy `~/.agents` — and let a Markdown file override or
  merge into a same-named built-in. V2 reads only `<project>/.pi/agents`
  (nearest ancestor of the parent cwd) then `<agentDir>/agents`
  (`~/.pi/agent/agents` in a normal install), first definition wins; Claude
  Code agent directories are never imported, and a Markdown file that names
  a built-in is ignored with a warning. V1's Claude-only frontmatter
  (`disallowedTools`, capitalized tool names) has no v2 meaning. A profile's
  frontmatter `model:` is honored — below `models`/`modelsByParent`, above
  parent inheritance — but only globally defined names are valid config keys
  (see SPEC).
  Migration: move custom agents to one of the two supported directories,
  rename profiles that collide with `default`/`explore`/`coder`/`reviewer`,
  and translate `disallowedTools` into the positive `tools` list.

- **Task `model` and `thinking` fields removed; model and effort are
  user-configured only (#32).** V1 resolved any registry-resolvable model
  reference (including `:thinking`-suffixed ones) the caller cared to type,
  letting a subagent spend on any model in the registry — and callers are
  reliably bad at picking models (stale training-data names, wrong cost
  tier). V2 tasks carry no model or effort selection at all: both fields
  are rejected before tasks start, with guidance toward the config. Inline
  tasks and the `default` profile mirror the parent's exact
  `provider/model:effort` unconditionally — inheritance is the invariant,
  not a configurable, and `models.default` is rejected at config load. A
  *named agent* runs on the model the user assigned it under `"models"` in
  the user-global `delegate.json` (object: agent name →
  `provider/model[:effort]`), else the parent's model; a `"modelsByParent"`
  map scopes pins to the parent's exact `provider/model-id` and wins over
  the unscoped entry. A configured reference's `:effort` suffix pins the
  child's thinking level; a bare pinned model runs at that model's default;
  a configured reference that does not resolve in the session's registry
  fails the same way, naming the entry. A `modelsByParent` key names the
  parent's exact `provider/model-id` (provider before the first slash plus
  the full model id, which may itself contain slashes, e.g.
  `openrouter/anthropic/claude-sonnet-4`); a key that could
  never match (empty, missing the slash, an empty provider or model id,
  doubled slashes, internal
  whitespace) is rejected at config load — dead entries fail loudly, they
  do not sit silently. Colons are legal in model ids
  (`ollama/qwen2.5:32b`): only a trailing known level strips as `:effort`,
  any other `:segment` stays in the reference, and an unresolvable pin
  fails at dispatch naming the entry. "Running the parent's model" for effort inheritance is
  case-insensitive, like config matching, so a host-set parent model whose
  casing differs from the registry's keeps the parent's live level.
  Migration: move any per-task model choice into `delegate.json`
  `"models"` — e.g. `{"explore": "<provider/model-id>:high"}` with references
  taken from your actual configured models; callers stop sending `model`
  and `thinking`. The model-failure recovery hint now addresses the
  operator, not the caller.

- **Operator unsafe-write bypass not carried (user decision, 2026-09-21).**
  V1's `"allowUnsafeSharedWrites"` escape hatch is gone: no operator or
  caller setting can skip admission, and `INVARIANTS.md` now forbids one
  outright. Unguarded shared-tree running remains reachable only through
  deliberate workspace choices — sequential shared batches or parallel
  `isolated` edits. Reintroduction would be a new contract change, not a
  restoration of this one.
  Migration: delete `"allowUnsafeSharedWrites"` from `delegate.json`. V2
  silently ignores unknown top-level config keys, so leaving it changes
  nothing — but the warn-while-active unguarded mode it enabled is no
  longer possible at all.

- **V1 per-agent override maps and housekeeping config keys are not read
  (2026-09-21 reconciliation).**
  `agentOverrides`, `agentOverridesByParentModel`, and `maxAsyncTickets`
  have no v2 meaning; stale entries are silently ignored.
  (`output.spillThresholdChars`/`output.spillTailChars` regained their v1
  meaning when output bounding shipped — see the shipped-capabilities
  list below.) Model choice for named agents lives only under
  user-global `"models"`; the parent-scoped half of
  `agentOverridesByParentModel` regained its meaning as `"modelsByParent"`
  when #32 landed — model pins only, scoped by the parent's exact
  `provider/model-id`. Per-agent `thinking` is configured by the `:effort`
  suffix on those entries (#32: callers no longer set it at all);
  per-agent `tools` preferences are task fields or Markdown profile
  frontmatter now that named profiles have landed (#7). Async tickets
  are uncapped in count and live for the host lifetime: `concurrency`
  bounds execution, not ticket creation, and settled tickets stay pollable
  until the host exits.
  Migration: express per-agent effort as `:effort` on `models`/
  `modelsByParent` entries and per-agent tools as task fields or Markdown
  profile frontmatter; drop the stale keys; rely on concurrency bounds and
  polling rather than a ticket cap or TTL sweep.

- **Malformed numeric configuration fails loudly instead of keeping the
  last good snapshot (§3d item 4, recorded 2026-09-27).** V1 re-read
  `delegate.json` at the start of every tool call and, on a parse or
  validation error — a non-integer `maxConcurrent`, a negative
  `stallTimeoutMs`, a malformed `concurrency` entry — kept the previously
  loaded snapshot and warned (`could not reload … keeping current
  config`); on a bad first read it ran on the compiled defaults. A broken
  edit could therefore run on stale bounds indefinitely, surfaced only in
  the console. V2 has no retained snapshot: every dispatch reloads the
  file, and a malformed value fails the whole call before any task
  starts, naming the offending key — the same rule `output`, `models`,
  `modelsByParent`, and `telemetry` already follow. A silently weakened
  limit is worse than a visible error.
  Migration: fix the reported key; dispatch does not proceed on a
  partially valid `delegate.json`.

- **Pooled-session thinking freeze now applies to every profile
  (§3d item 10, recorded 2026-09-27).** V1 carried a `default`-profile
  exception in its reuse validation: a pooled `default` session demanded
  the parent's *live* thinking level on reuse — the frozen level was only
  a fallback for a parent with no level — so a changed parent level
  surfaced as an explicit reuse mismatch rather than silently continuing
  at the stale one. Every other profile demanded its own frozen level,
  so a named-agent session could keep running at its old thinking level
  no matter how the parent moved. V2 drops the split: reuse resolves the
  task's thinking from the current dispatch (pin → profile → parent) and
  requires equality with the frozen level for every profile — a changed
  effective level rejects reuse with the same actionable mismatch for
  `default` (parity with v1) and for named agents (stricter than v1,
  which silently continued). This is the same freeze
  `INVARIANTS.md` "Session reuse" mandates for every other frozen field.
  Migration: none — reuse that now fails was already configuration drift;
  close the pooled session (`delegate_session({ action: "close", … })`)
  or return to the matching level and retry.

- **One `delegate` tool split into three (#27).** V1's kitchen-sink schema
  advertised dispatch, ticket, and session fields together, and the largest
  observed caller failure was combining them. V2 registers three tools —
  `delegate` (dispatch; `tasks` is required, `[]` returns the manual),
  `delegate_ticket` (required `action`: poll/wait/cancel/pause/resume/answer),
  and `delegate_session` (required `action`: list/close) — sharing the same
  stores and runtime. A call that still mixes concerns does not partially
  execute: foreign fields fail the call with guidance naming the right tool
  and an example built from the values the caller sent. The within-operation
  rules are unchanged (`ticket` required except roster poll, `force` only
  with cancel, `timeoutMs` only with wait, `taskId`/`questionId`/`answer`
  only with answer; `sessionId` required for close and rejected for list).
  Migration:

  | Old call | New call |
  | --- | --- |
  | `delegate({ ticketAction: "poll", ticket? })` | `delegate_ticket({ action: "poll", ticket? })` |
  | `delegate({ ticketAction: "wait", ticket, timeoutMs? })` | `delegate_ticket({ action: "wait", ticket, timeoutMs? })` |
  | `delegate({ ticketAction: "pause"\|"resume", ticket })` | `delegate_ticket({ action: "pause"\|"resume", ticket })` |
  | `delegate({ ticketAction: "cancel", ticket, force? })` | `delegate_ticket({ action: "cancel", ticket, force? })` |
  | `delegate({ ticketAction: "answer", ticket, taskId, questionId, answer })` | `delegate_ticket({ action: "answer", ticket, taskId, questionId, answer })` |
  | `delegate({ sessionAction: "list" })` | `delegate_session({ action: "list" })` |
  | `delegate({ sessionAction: "close", sessionId })` | `delegate_session({ action: "close", sessionId })` |

  Dispatch calls are unchanged except that `tasks` is now schema-required
  (callers get `[]` behavior — the manual — when it is omitted anyway) and
  task `model` is gone from the schema (still rejected explicitly when sent).

## v2 deferred capabilities — all since shipped

These v1 capabilities were deferred past the initial v2 cut — sequenced
with the approved roadmap, not cancelled — and have now shipped. Each
entry records what shipped, its issue, and any deliberate divergences
from v1.

- **Operator-visibility layer (#24)** — shipped 2026-09-22: the footer
  status line, the once-per-ticket settle warning, the switch/fork consent
  guards, the tree-navigation consent prompt (2-way: cancel force-cancels
  live tickets and proceeds, stay blocks the transition, dismissal stays;
  a deliberate divergence from v1's third "hold" option, dropped by
  owner decision 2026-09-22 — its safety half is leaf-aware delivery,
  the non-waking append at the current leaf), the quit/reload abort
  traces, and the live subagent browser (`/subagents`, Ctrl+Shift+B).
  Deliberate divergences recorded here, not planned work: live rows for
  in-flight sync dispatches (finished sync calls are retained), per-call
  RUNNING/DONE tool markers, and agent names in the shutdown summary
  (ids only today).
- **Large-output bounding (#25)** — shipped 2026-09-23 with v1's
  semantics: settled and synchronous results spill output past
  `output.spillThresholdChars` (default 8 000) to an owner-only temp
  file and render a `output.spillTailChars`-long (default 2 000)
  surrogate-safe tail with a pointer; running-ticket views bound to the
  tail only and never write a file; a failed write degrades to the full
  output in-context; complete output stays in result `details` and on the
  ticket record. Bounds snapshot per ticket at creation; a settled
  ticket's frozen view keeps one stable spill path across polls.

## Known host limitations (accepted 2026-09-19, issue #3)

These follow from Pi's public extension API and are documented rather than
worked around with a host modification.

- **Ordered lifecycle handlers.** Pi awaits `session_shutdown` and
  `session_before_tree` handlers one extension at a time. If an extension
  loaded before Delegate awaits in its handler, a ticket settling in that
  window is delivered before Delegate learns of the transition and may trigger
  one turn on the outgoing session; Pi aborts it at teardown. Cost: one wasted
  model call and an aborted turn in the old transcript. Workspace safety is
  unaffected because shutdown still waits for worker quiescence.
- **Blocking shutdown.** Quit and session replacement wait for cancelled
  workers to actually stop. Cancellation is cooperative, so a worker whose
  provider or tool ignores the abort delays shutdown for as long as it runs.
  A visible status names the tickets being waited on.
- **Saved tickets, not resumed work.** Ticket identities and saved results
  survive `/reload` and session replacement under the same agent directory;
  orderly shutdown cancels active tickets. An unclean exit leaves a running
  ticket `interrupted` with any saved outcomes, never a resumed worker.
  Undelivered results are not automatically delivered on restart. OperationId
  records, worker sessions, write reservations, and unfinished side effects
  are not restored; this is not an exactly-once or replay guarantee.
- **Current-leaf append.** A result that cannot wake its origin leaf is
  appended at whatever leaf is current when it settles, and enters model
  context there on the next turn.

## v2 intentionally may change

The rewrite may change without compatibility ceremony:

- module boundaries, internal interfaces, types, data structures, dependency
  injection, locking, scheduling, and concurrency implementation;
- cancellation detection, completion proofs, cleanup strategy, retry machinery,
  and all internal timeout values, provided the documented outcomes hold;
- ticket state representation, transition ownership, busy tracking, retention
  implementation, and delivery plumbing;
- session materialization and pooling architecture, including the v1
  policy/materialization module seam, provided reuse behavior remains compatible;
- isolated-workspace mechanics, including whether v2 uses temporary indexes,
  detached worktrees, refs, patches, or another recoverable transactional design;
- generated bundle layout and build plumbing;
- Pi-version adapters and host-compatibility checks;
- TUI component structure, refresh strategy, and non-semantic visual details;
- ticket identifier format, temporary directory names, and recovery artifact
  paths, provided identifiers remain opaque and artifacts remain discoverable;
- exact error/help/status prose, provided it stays actionable and does not lose
  a semantic distinction;
- telemetry tables and storage internals, provided existing data is migrated or
  explicitly versioned rather than silently lost;
- tests and test seams. V1 tests are evidence for behavior, not an API that v2
  must reproduce.

This contract does **not** pre-authorize changed defaults, removed normalization,
weaker cancellation or workspace guarantees, different ticket delivery,
different session persistence, or a broader extension trust boundary. Those
would be intentional public API changes, not implementation freedom.

## Test migration policy

Do **not** port the v1 test suite wholesale. Its regression knowledge is useful;
its decomposition is not a v2 contract. Before reimplementation, classify each
v1 test by purpose:

1. **Contract tests** cover behavior promised by `SPEC.md`: accepted calls,
   validation, results, sessions, tickets, workspaces, usage, and other
   caller-visible effects. Reimplement these against v2's public tool boundary.
2. **Regression tests** reproduce a real failure that could violate the public
   contract or an invariant. Preserve the scenario and expected outcome, but
   reimplement it through the public boundary rather than carrying over v1
   fixtures, mocks, call sequences, or helper assumptions.
3. **Internal tests** exist only to validate a v1 helper, module boundary,
   intermediate representation, private state transition, or decomposition.
   Delete them. Add new internal tests only when v2's own design warrants them.

Tests should assert observable results and effects: returned tool content,
ticket/session behavior, filesystem state, preserved user Git state, resource
availability, emitted usage, and actionable failure. They should not assert
which v1 helper was called, the shape of private state, exact internal event
ordering, or a particular cleanup/reconciliation mechanism.

The old suite is a source catalogue for discovering cases, not code to copy and
not a coverage target. Similar test counts, file names, fixtures, and line
coverage are explicitly not compatibility goals.

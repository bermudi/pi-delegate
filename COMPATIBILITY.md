# Delegate compatibility contract — current v3 overrides and v1/v2 history

Current amendments below govern the inherited migration lists. Historical
signatures and examples preserve the migration record; they do not
authorize removed fields or override SPEC.md, the sole behavioral
authority.

## Unknown top-level configuration keys (#136, owner-approved 2026-10-10)

Unknown keys now warn once per changed file content through
`DiagnosticSink` instead of disappearing silently. They remain ignored for
configuration semantics: stale v1 keys still cannot enable a retired
capability, and an otherwise valid file still loads. Warnings name keys
and the recognized set, never values or file contents. Recognized
malformed values still fail the call; explicitly removed `surface` still
rejects with teaching.

Migration: remove the reported typo or stale key. Repeated dispatches with
unchanged content do not repeat the warning. Manual-only profile discovery
stays silent. Normative rule: SPEC.md, "Unknown configuration keys".

## Call row shows labels, not prompts (user-approved 2026-10-10)

The `delegate` call row is the static line shown while a call is outstanding.
It used to show the first ~86 characters of each task's prompt. Those prompts
shared a long boilerplate opening, so the previews told rows apart by nothing.
The row now reads `delegate N tasks`, then one line per task (up to four, then
`… and K more`): the task's label — `id`, else `agent`, else `inline` — and a
`↻<tag>` marker on every resumed task. Tagged labels pad to a common width so
the tags line up.

Display only. Dispatch arguments, results, tickets, and the live board are
unchanged. Two visible consequences:

- A resumed task that also has a prompt now shows its `↻<tag>`. Before, the
  prompt took the slot and the marker was hidden. Results already show the
  marker for every resumed task, so the row now matches them.
- Existing sessions re-render in the new layout, because the call row is
  computed from the recorded arguments each time it draws.

SPEC.md has no call-row preview language, so it stays as is.

## Terminal-safe operational diagnostics (#122)

This supersedes the inherited stderr-only logging, including delivery-skip logs.
Normative text: SPEC.md, "Operational diagnostics (#122, user-authorized)". Residual points that
SPEC.md does not state: no log rotation or automatic deletion is introduced (operators
remove old process logs); diagnostic-destination failures never interfere with
telemetry; caller-visible tool errors, task lifecycle, models, and settings are unchanged.

## Prompt size cap (#121)

BREAKING: each task `prompt` and the shared `brief` longer than 32,768
characters now reject at validation, before any task starts — previously
such calls attempted execution. Owner-confirmed 2026-10-05, motivated by
the 2026-10-04 stream-livelock incident class: delegate owns the extreme
argument-size tail callers emit (measured max 923,192 bytes of arguments;
largest legitimate recorded prompt 7,983 chars), and inlined-content
prompts both bloat accepted-call context and stretch the tool-argument
stream that the upstream pi-ai parser bug feeds on. Reference files by
path instead of inlining contents — subagents read the working tree
themselves. At ratification the cap was identical on compact and full
surfaces (ADR 0002 has since removed the split), and remains identical for
async and inline calls; it is a constant with no config escape. Other
fields were unchanged at that decision (`systemPrompt` uncapped in v1;
`description` then kept its 200-character display-label bound); #130 has
since removed both task fields. Rejections ride semantic
validation — diagnostics name field, task, limit, and count only, never
request-body dumps — and record `validation`-phase misfire rows.

## Task deadlines removed (#118, user-approved)

BREAKING: `deadlineMs` is removed (in both compact and full mode when this was decided;
ADR 0002 later merged the two into one surface). Its presence rejects before execution,
including null and flat/stringified recovery shapes. Remove it from calls: tasks have no
wall-clock deadline. Use cooperative ticket cancel/interrupt to stop work; waits park until
settlement, a worker question, or a caller abort (#130). Normative text: SPEC.md, "Task
deadlines removed (#118, user-approved)".

## Unordered shared-writer rejection (#126, owner-approved 2026-10-08)

BREAKING: same-phase overlapping shared writers in one call now reject
before execution, enumerating the remedies: order with `dependsOn`, run
independent edits in workspace `isolated`, or split into separate calls.
Formerly such batches serialized silently in task order with an advisory
notice — the notice shipped 2026-09-12 (`e0998c3`) and was delivered five
times in session `01a11872` with zero behavior change, so the advisory tier
is retired as measurably ineffective for the fan-out shape it targeted.

Scope is the admission wave, not graph order: a `dependsOn` edge always
lands the dependent in a later phase, so same-phase pairs are unordered by
construction — that is the fan-out shape that rejected nothing and cost
hours. Cross-phase overlapping writers keep the old contract unchanged:
serialized in (phase, task) order with the later waiting for the earlier's
confirmed quiescence, an incidentally-ordered successor still runs after a
predecessor fails, and the advisory notice still fires (reworded).
Deliberate loss: failure-tolerant sequencing for same-phase writers now
requires split calls or isolated; the `isolated` remedy's
dependency-provisioning gap for suite-running tasks closed with #120
below. Cross-call and mixed-kind unordered rejections are unchanged.

## Isolated worktree dependency provisioning (#120)

Isolated worker worktrees are no longer tracked-state-only: at group
preparation each worktree is provisioned with the source root's
Git-ignored entries (collapsed form — `node_modules/` materializes as
one tree), copied with reflink/Copy-on-Write where the filesystem
supports it and a plain copy otherwise. This closes the degradation
the #126 record called out: `isolated` is now a usable parallel path
for suite-running tasks (reviews that run `bun test` / `tsc`), not
just edit fan-outs.

Invariants, mechanism, and failure rules are normative in SPEC.md, "Isolated worktree
dependency provisioning (#120)": ignored files are read-only inputs and never enter
proposals, merges, or drift; Delegate-owned runtime trees are never provisioned; a provisioning
failure fails the group loud, while a source entry that vanishes mid-copy is skipped. One
rationale SPEC.md does not carry: artifact trees are excluded because `fs.cp` refuses to copy
a directory into itself, and copying sibling workers' live trees is wasted disk.

Design provenance: port-of-idea from xai-org/grok-build's
`xai-fast-worktree` copy arm, second pass (`execute.rs:832-871`,
`copy/skip.rs:19-40`) — pass 1 is `git worktree add` at the synthetic
baseline. Its overlay/btrfs-subvolume arms were not adopted: whole-
volume snapshots including `.git` conflict with the
baseline-commit/proposal machinery, which needs real linked worktrees
of the source repo. v1's reflink probe/fail-loud discipline is
consciously NOT adopted either — provisioning degrades to a full copy
on ext4/tmpfs instead of failing (in-repo precedent:
`src/scratch.ts` `copyTree`).

## One tool surface (ADR 0002, 2026-10-07)

This section supersedes #61's compact/full exposure split; #61's other
rules (canonical fields, exact names, background default) stand.

- BREAKING: the `"surface"` key is removed from delegate.json and the
  compact/full schema split no longer exists. There is one advertised and
  accepted schema — the former full vocabulary, pruned per the #130 field
  verdicts. A supplied `"surface"` key rejects at config load with
  teaching; remove the key and /reload.
- Rationale and the 2,001-dispatch evidence: docs/decisions/0002-one-surface.md. The
  normative rule (one schema; a supplied `"surface"` key rejects at config load) is SPEC.md,
  "One surface (ADR 0002, 2026-10-07)".

## Simplified v3 surface (#61, user-approved 2026-09-29)

This section supersedes the older alias and cardinality entries below.

- BREAKING: omitted `async` now means background execution for one task as
  well as many. Add `async: false` where inline results are required.
- BREAKING: cross-harness field synonyms and built-in name translations are
  removed. Use `agent`, `prompt`, `id`, `async`, and `brief`, plus exact
  built-in or authored profile names (the wait `timeoutMs` destination is
  gone — #130). Removed
  fields reject the entire call, including null values. Existing saved
  ticket metadata remains readable; it does not authorize new alias calls.
- BREAKING (superseded by ADR 0002 above): the compact-by-default surface and its
  `"surface": "full"` opt-in are gone; the key now rejects at config load. Original
  wording is in git history.
- Malformed supplied non-array `tasks` reject instead of being discarded by
  flat recovery. Schema diagnostics exclude request-body dumps; pre-schema
  rejection telemetry stores those safe messages verbatim, never prompts or
  base instructions. Non-object calls also record empty-shape misfires.
  Recovery guards omit malformed values; correction examples retain relevant
  addresses but use placeholders for task/message/answer bodies.
- Reusable tools/base-instruction choices belong in Markdown profiles
  (#130: per-task overrides are removed, not mode-gated). Dependencies,
  resume, and pooled sessions are unchanged. The batch budget, output
  tailing, pause/resume actions, and the wait `timeoutMs` are removed
  (#130): waits park until settlement, a worker question, or a caller abort.
- No changes to cancellation, workspace admission/application, session
  freezing, model authorization, usage, durable results, or delivery.

## v2 → v3 changes (SPEC v3, ratified 2026-09-27)

v3 is a contract layer on the same engine. Caller-visible changes:

- **BREAKING — multi-task batches default to async.** A `delegate` call
  with two or more tasks now returns a ticket immediately and
  auto-delivers the settled result, instead of blocking. Callers that
  relied on the v2 blanket sync default must pass `async: false`.
  Single-task calls still block inline by default (**superseded by #61:** omitted `async` now backgrounds single tasks too); `async: true`
  overrides either way.
- **Superseded — agent-name aliases (retired by #61).** The alias table (`general`,
  `general-purpose`, `worker`, `explorer`, `plan`, `scout`, `implement`) is gone. Names match
  exactly, and an unauthored alias rejects the whole batch as an unknown agent, pinned by
  `tests/contract/grammar.test.ts`. An authored `general.md` or `scout.md` is an ordinary profile.
- **Renamed — the read-only built-in is `explore`, not `scout` (#40).**
  The trained read-only name is canonical. Superseded by #61: `agent: "scout"` no longer
  resolves to `explore`, and an unauthored `scout` rejects as an unknown agent
  (`tests/contract/grammar.test.ts`).
  **Breaking for config:** `models.scout` and `modelsByParent` `scout`
  keys are rejected at load with a migration message (unless an authored global scout profile exists, #61) — rename them to
  `models.explore`. Built-in semantics (toolset, role, read-only
  concurrency) are unchanged.
- **Additive — misfire telemetry.** Dispatches rejected before
  execution record a telemetry row. No behavior change.
- **Superseded — cross-harness task-field spellings (#41, retired by #61).**
  `subagent_type`, `agent_type`, `task_name`, `run_in_background`, `timeout_ms`, and a
  task-level `message` now reject with teaching
  (`delegate.ts`, `rejectFieldAliases`). `timeout_ms` names `timeoutMs`; a dispatch that sends `timeoutMs` is rejected toward `async: true` and a ticket wait (`delegate.ts`), and on the wait tool `timeoutMs` is removed (#130). The folding and conflict rules are gone.
- **Additive — shared batch `brief` (#43).** Top-level `brief` prepends a
  `--- batch brief ---` preamble to every task's prompt; the result and ticket headers name it
  once. The `context` spelling no longer normalizes to `brief`: `context` is removed and
  rejects with teaching (see the #14 entry below). The old `brief`+`context` conflict rule went with it.
- **Changed — default `maxConcurrent` is 8, not 3 (#41).** Field
  survey: letta/grok/oh-my-pi default 32; minimax/deepseek/MiMo/fx
  uncapped. The `concurrency` maps remain the rate-limit guard.
- **Superseded — trained-reflex long tail (#44; folds retired by #61).** The name-folding
  described before is gone; the spellings now reject with teaching (see #41 above). What stays
  from #44: a bare top-level `message` gets the `delegate_ticket` steer teaching, `reasoning_effort` rejects with the `thinking` teaching at every level, and model
  and effort selection is user-configured only (#32).
- **Changed — no nested dispatch (#45).** The alias-precedence half of this bullet is
  superseded by #61 (names match exactly). The delegate family is stripped silently from
  every child toolset — profile frontmatter, and the mirrored parent set (task-level `tools` is removed by #130)
  alike — so subagents never nest.
- **Changed — pooled-session idle residency is bounded (#46).** Idle
  sessions beyond `sessions.maxIdle` (default 4) unload to their
  transcript and transparently reload on the next reuse — callers see
  no difference; memory footprint drops. Checked-out sessions are
  never evicted, `maxIdle: 0` unloads everything settled, and
  `delegate_session` `list`/`close` cover unloaded records.
- **Removed — batch `tokenBudget` (#129, 2026-10-07; formerly additive
  #47).** The caller-controlled ceiling is gone and the concept dies
  entirely: supplied `tokenBudget` rejects with teaching before any
  task starts (every shape). The account, `budget-exhausted`
  settlement, dependent blocking, and `details.tokenBudget` are
  removed; historical telemetry columns and journal fields stay
  readable for pre-removal records. The former #47 entry survives
  only in this note.
- **Removed — batch `operationId` (#130, 2026-10-07).** Dispatches are
  no longer caller-deduplicated: the idempotency store, fingerprint
  conflict checks, and settled-record retention are gone, and a
  supplied `operationId` rejects with teaching before any work
  starts. Identical requests execute independently; if a transport
  retry ever double-runs a writer batch, the remedy is an automatic
  derived key (the steer pattern), never a manual caller field.
- **Removed — ticket `pause`/`resume` actions (#130, 2026-10-07).** The
  model-facing actions are gone and reject with teaching toward
  wait/cancel; the pause state machine survives as operator machinery
  (the /subagents dashboard `p` keybinding calls the store directly).
  Test coverage that drove the RPC (paused-watchdog scenarios, the
  paused footer case, answer replay while parked) lost its public
  trigger and is a noted gap pending a dashboard integration test.
- **Removed — ticket `tail` action and `offset`/`waitMs` fields (#130,
  2026-10-07).** "What is it doing?" is answered by poll's live per-task
  activity rows and the settled result; humans watching mid-flight have
  the /subagents dashboard. Unknown ticket actions now enumerate the
  available set (enumerate-or-inherit). The transcript-span read
  machinery stays internal to poll views and spill.
- **Removed — task `tools` and `systemPrompt` overrides (#130,
  2026-10-10).** Capability and base prompts belong to agents: the
  default profile mirrors the parent's active tools, built-ins carry
  fixed toolsets, and authored profiles select both via frontmatter
  `tools` and body. Both fields reject with teaching before any work
  (the string/array tools repairs and the blank-systemPrompt rule die
  with the field); profile-frontmatter tool names keep their
  discovery-time validation (an unknown name drops the profile, so
  dispatching it fails closed as an enumerated unknown agent). The
  web_search caller vector is gone with the field — children reach
  extension tools only through the default profile's parent mirror,
  gated per-task by the child provider's allowlist.
- **Removed — task `description` display label (#130, 2026-10-10).**
  Labels are derived: call rows and result headers show the task id,
  else the agent name, else `inline` — an id set for correlation
  doubles as the label. Presence rejects with teaching before any
  work. Historical records keep their labels: the render/replay
  paths still honor a stored `description` from pre-removal
  journals, and the journal/details read shape is unchanged (new
  tickets simply never set it).
- **Removed — caller steer key `steerId` (#130, 2026-10-10; the
  optional field was #44).** Every steer receipts under a key derived
  from its own call (`steer:<toolCallId>`), so dedup survives without
  a caller field: a transport retry replays the stored receipt.
  Presence rejects with teaching (both spellings, every action); the
  charset rule and the same-key-conflict error lost their public
  trigger with the field — the store's collision guard remains
  defensive. Same-key `duplicate` replay and conflict coverage has no
  public trigger left (the playbook boundary mints unique call ids);
  noted gap, same class as the pause RPC scenarios.
- **Removed — wait `timeoutMs` and wait-any `tickets` (#130,
  2026-10-07; wait-any was #58).** Waits are unbounded: they park until
  the ticket settles or wakes on activity worth a turn (worker
  question, interruption), and wake delivery settles the parent anyway
  — a caller-side bound had no work left. Both fields reject with
  teaching before any work (the `timeout_ms` alias still resolves into
  that teaching); `wait` takes a single `ticket`, and watching several
  means waiting on each or polling the roster. The engine's settle
  queue and coalesced multi-ticket wake delivery are untouched.
- Landed since: steering receipts (#37), `delegate_ticket interrupt`
  (#42 — abort one task's in-flight turn; it settles `interrupted`,
  resumable, distinct from `cancel`'s ticket teardown), recovery resume
  hints (#123 — the worker's claimed transcript is journaled before its
  first turn; a recovered `interrupted` outcome names the durable file
  with the same `resumeFrom` recipe a failed outcome renders).
- **Changed — shutdown quiescence is bounded (#52, 0.3.2).** Shutdown waits up to about 30s
  for confirmed quiescence, then proceeds with a warning; an expired budget never releases
  reservations. The current rule is under Known host limitations, "Blocking shutdown."

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
  departures below and #130's removal of caller capability/base-prompt
  overrides. `verifier` was subsequently added under SPEC.md's
  completion-evidence rules.
- User-global `delegate.json` configuration. Project files do not become
  delegate configuration.
- Parent model inheritance and project instructions and extension isolation, with children
  resolved through the parent's shared model runtime (extension-free by
  default; the 2026-09-26 live check, issue #5, recorded "no provider-extension
  allowlist" — **superseded by #59**, which ships one: see SPEC.md's
  provider-scoped extensions bullet) and the
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
- Async fire-and-forget tickets, poll/wait/cancel behavior (pause/resume
  removed by #130),
  idempotent settlement, retained results, and session-tree leaf-aware delivery
  as specified in `SPEC.md` "Background delivery".
- Saved async ticket results are pollable on a cold extension instance; an
  unfinished snapshot is `interrupted`, not resumed or automatically delivered.
  Since #123 the interrupted outcome carries the transcript journaled at claim
  time — recovery names the file for a deliberate `resumeFrom`, never an
  automatic resume. Recovered cancelled tickets warn in the roster when a recorded worker's
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
- Owner-approved scratch-copy strengthening (this repository's #50,
  2026-10-07): copying holds a temporary source read reservation and rejects
  overlapping active/reserved shared or isolated writers, including quarantine;
  new overlapping writers reject during copying. Concurrent scratch readers
  may coexist. Same-call planned writers are safe only before they start,
  and earlier-phase writers require confirmed quiescence through source-mutating
  deferred cleanup and reconciliation. The claim releases
  after copying stops on every exit, before worker execution; scratch workers
  still hold no source write reservation. This is same-host Delegate admission,
  not cross-process protection or an atomic tree snapshot.
- Fail-closed shared-write admission, canonical overlap rules, unknown tools as
  writers, same-phase unordered rejection with cross-phase serialization
  (#126), and cross-call rejection.
- Isolated preservation of dirty/untracked baseline state and the user's
  branch/index; task-order, all-or-nothing application; retained conflict and
  cancellation artifacts; `applied_unverified` wording.
- The safe-reuse, safe-cleanup, and quarantine outcomes in `INVARIANTS.md`;
  v1's quiescence-barrier algorithm is not preserved.

### Signals and data

- Actionable errors that preserve the relevant correction, even if wording
  changes.
  Current Git-scope failures explain how to repair discovery and retry;
  inherited-redirection failures name the variables to clear or correct before
  retrying (this repository's #51). Historical scratch-recommendation helpers
  and exact clauses are not restored: scratch is not a general safety bypass.
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
- Optional duplicate-safe dispatch identity (`operationId`, issue #16) — **removed by #130**.
  Dispatches are not caller-deduplicated, and a supplied `operationId` rejects with teaching.
  The superseded keyed-reuse contract is in git history; SPEC.md's canonical-surface removed-field
  list records the removal.
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
  Conversely (#126), same-phase unordered shared-writer overlap in one call
  now rejects before execution with enumerated remedies (dependsOn,
  `isolated`, separate calls) — the strictness direction, replacing silent
  serialization whose advisory notice was measurably ignored.
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
  **Current override (SPEC.md, "Task durations"):** v3 records each
  task's admitted span in `duration_ms`; never-started tasks keep NULL.
  **Current override (SPEC.md, "Misfire rows"):** the
  completed-dispatch-only description is historical. Pre-execution
  rejections also record sanitized batch metadata and the caller-visible
  rejection message verbatim. That explicit message exception does not
  authorize arbitrary prompt, output, credential, or path payloads.

## v2 deliberate breaking changes

- **Touched-file attribution: removed 2026-09-27, restored under v3 the same day, then extended
  2026-10-02.** The current contract is SPEC.md, "Observability" (bullet "Completion evidence", #38):
  paths from write/edit calls, plus a Git evidence window for changes made from the shell, with
  concurrent writers named rather than hidden. Paths are resolved against the task cwd, ordered, and deduplicated, with no symlink canonicalization. Same-call graph-ordered writers still serialize, and their completion notices name the serialized tasks. V1's physical-identity tracking and its
  `details.overlapWarning` shape were not restored. Decision record: docs/history/V1-V2-MAP.md §3d item 1.

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
  prompt disables inheritance with a logged skip. Authored prompts (Markdown
  profile bodies — the task `systemPrompt` override was removed by #130
  after this section was written) are used verbatim with nothing appended.
  Migration: none for callers — `default` now genuinely mirrors the
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
  **Current surface:** `pause` and `resume` in this historical entry are
  no longer RPC actions (#130); the model-facing set is SPEC.md's
  `poll`/`wait`/`cancel`/`answer`/`steer`/`interrupt`.

Departures from the preserve list above. Each must carry its own motivation
and migration guidance; none may arrive as silent rewrite drift.

- **Unavailable parent tools fail closed for default-profile inheritance.**
  A throwing active-tool probe no longer silently falls back to writer tools.
  If any `default` task omits `tools`, the whole sync or async call rejects
  before children start, with a logged, actionable error preserving the cause.
  Migration: restore the parent's tool inventory (the task-level `tools`
  override is gone — #130; pick a named agent whose profile carries its
  own tools). Named-profile, explore/coder/reviewer, and inline dispatches
  do not probe the inventory;
  their existing capabilities are unchanged.
  **Current ownership (#130):** the task `tools` field is removed, so
  every `default` task uses the parent's inventory probe; callers cannot
  bypass it. Named profiles own their tools.

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
  **Overridden by #136:** leaving the stale key still changes no
  capability, but now warns once per changed configuration; the
  silent-ignore wording above is the v2 migration record.

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
  per-agent `tools` preferences are Markdown profile frontmatter (the
  task-level field was removed by #130). Async tickets
  are uncapped in count and live for the host lifetime: `concurrency`
  bounds execution, not ticket creation, and settled tickets stay pollable
  until the host exits.
  Migration: express per-agent effort as `:effort` on `models`/
  `modelsByParent` entries and per-agent tools as Markdown profile
  frontmatter (task fields removed — #130); drop the stale keys; rely on concurrency bounds and
  polling rather than a ticket cap or TTL sweep.
  **Overridden by #136:** these stale entries remain semantically ignored,
  but warn once per changed configuration through `DiagnosticSink`.

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
  and an example built from the values the caller sent. (#130 note: the
  action set has since narrowed — pause/resume and the wait `timeoutMs`
  rule named below are removed; the rules and table are historical.)
  The within-operation
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

- **Operator-visibility layer (#24)** — shipped 2026-09-22; the subagent
  browser was redesigned 2026-10-08 (#128) after failing at fleet scale
  (a roster hard-capped at four rows for a 50-task fleet, a tool-spam
  detail pane, no ticket grouping, and full absolute paths eating the
  scan lines): the footer
  status line, the once-per-ticket settle warning, the switch/fork consent
  guards, the tree-navigation consent prompt (2-way: cancel force-cancels
  live tickets and proceeds, stay blocks the transition, dismissal stays;
  a deliberate divergence from v1's third "hold" option, dropped by
  owner decision 2026-09-22 — its safety half is leaf-aware delivery,
  the non-waking append at the current leaf), the quit/reload abort
  traces, and the live subagent browser (`/subagents`, Ctrl+Shift+B).
  Deliberate divergences recorded here, not planned work: live rows for
  in-flight sync dispatches (finished sync calls are retained; **shipped
  by #119**, including the display-only heartbeat board), and agent
  names in the shutdown summary (ids only today).
  The #128 browser is a two-pane fleet dashboard: a ticket-grouped roster
  owning the full panel height (live tickets expanded, settled tickets
  collapsed to one row each, retained inline runs grouped, newest first)
  beside the selected agent's interleaved transcript — assistant text and
  condensed tool one-liners in stream order, tail-following live with
  PgUp/PgDn/Home/End scrollback. Tool scan lines condense absolute paths
  to their last two segments and fold consecutive identical settled calls
  with a `×N` multiplier; in-flight calls mark `⏳`, failed calls `✗` and
  never fold. Enter expands retained previews (at most 512 characters,
  not full commands or transcripts) and expands/collapses the selected
  ticket group, diving to its first task; ← collapses back to the header.
  Tab switches to the text-only view (the 32K assistant tail); retained
  sync runs without recorded events render that tail as their
  transcript. Whole-ticket pause/resume (`p`) is unchanged and works
  from both a ticket's header and its task rows; the store additionally
  journals a bounded chronological event log per task (250 events,
  2 000 characters per text event) feeding the interleaved view.
  Below ~96 columns the panes stack; below 40×16 the browser asks for a
  larger terminal.
- **Large-output bounding (#25)** — shipped 2026-09-23 with v1's semantics. The normative rules
  (thresholds, tail, failed-write fallback, stable spill path, owner-only files) are SPEC-V2.md,
  "LLM-facing projection" (settled output through stability). Config defaults:
  `output.spillThresholdChars` 8000, `output.spillTailChars` 2000.

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
  workers and their cleanup to actually stop, up to the shutdown-quiescence
  budget (~30s; #52). Cancellation is cooperative: if a provider or tool
  ignores the abort past that budget, shutdown proceeds only with a warning
  naming the still-unconfirmed work. Budget expiry never releases its
  reservations. A visible status names the dispatches being waited on.
- **Saved tickets, not resumed work.** Ticket identities and saved results
  survive `/reload` and session replacement under the same agent directory;
  orderly shutdown cancels active tickets. An unclean exit leaves a running
  ticket `interrupted` with any saved outcomes, never a resumed worker.
  Since #123 the interrupted outcome names the transcript journaled at claim
  time (the `session:` line and `resumeFrom` retry recipe) — a continuation
  affordance for a deliberate re-dispatch, not a resume; records written
  before claim-time journaling render unchanged. Undelivered results are not
  automatically delivered on restart. OperationId
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

Moved verbatim to TEST-MIGRATION.md, section "Migration policy (moved from COMPATIBILITY.md, 2026-10-10)". This contract
does not govern how v1 tests are migrated.

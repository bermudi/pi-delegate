# V1 test migration

The v1 suite is evidence, not source material. Tests are rewritten against the
registered `delegate` tool; they do not import implementation helpers.

## Task deadline removal (#118, user-approved)

The user said “cut deadline.” SPEC.md overrides inherited SPEC-V2 deadlines;
no deadline behavior remains required. `tests/contract/deadline-removal.test.ts`
checks both registered surfaces' schemas/manual/descriptions and rejection
before any child executes: positive, zero, negative, null, string, and boolean
values across task, flat, stringified, empty-task recovery, stranded top-level,
and malformed-object shapes. `validation.test.ts` and `telemetry.test.ts` now
assert removal rather than positivity; `sessions.test.ts` proves rejection
leaves a pooled conversation untouched with no provider call.

Safety scenarios formerly triggered by deadlines now use the stall watchdog:
sync provisional settlement, retained write claims, dependent blocking,
cross-phase serialization, lower-bound accounting, and provisional telemetry.
`preflight-races.test.ts` covers slow loading without a budget and cancellation
of blocked loading. `failure-propagation.test.ts` covers safe retry/backoff
without a wall-clock budget. Cancellation, question shutdown/late answers,
stall suspension during pause/questions, wait/tail detachment, and shutdown
bounds remain covered. Only deadline-specific paused/cause-precedence and
question expiry assertions are retired. `recovery.test.ts` verifies historical
saved deadline failures remain pollable/waitable without replay. Historical
v1 deadline scenarios are superseded, not a coverage gap.

## Classification

- **Contract** — proves behavior promised by `SPEC.md`.
- **Regression** — preserves a previously observed public failure scenario.
- **Internal** — proves only v1 helper behavior, decomposition, private state,
  rendering implementation, or an exact algorithm. Do not migrate.

When one v1 test mixes categories, extract only the public scenario. Do not
copy its fixtures, mocks, call graph, or intermediate assertions.

## Conventions

- `pendingTest` (`tests/support/pending.ts`) marks a migrated test whose
  contract needs unimplemented subsystems. Pending tests compile and
  typecheck, list as `(todo)` under `bun test`, and run for real with
  `DELEGATE_RUN_PENDING=1 bun test`, where they are expected to **fail
  meaningfully** against the scaffold's not-implemented boundary. Promote a
  pending test to `test` when its subsystem lands — or earlier, if its
  assertions already hold (two were promoted in the second tranche).
- `callDelegateDetached` (`tests/support/pi-boundary.ts`) fires a delegate
  call without awaiting it inline, so a test can interrupt the in-flight
  call through the raw `AgentSession` the harness exposes
  (`session.session.abort()`) — the awaited `run` API cannot express this.
- `installSubagentModel` (`tests/support/pi-boundary.ts`) registers pi-ai's
  built-in `faux` provider on the test session's `modelRuntime` and **sets
  the parent session's model to it** — inline tasks inherit the parent's
  model, so unnamed test tasks exercise real inheritance and stream through
  the scripted provider (the harness playbook replaces the parent's own
  streamFn, so the parent itself never streams it). A second provider
  (`alt`) serves named-agent override proofs, configured through
  `models` entries; `configureDelegate(session, patch)` shallow-merges into
  the session's `delegate.json`. This encodes a testability assumption for
  v2: subagent model resolution and streaming must route through the parent
  session's model runtime/registry. If v2 ends up creating subagent sessions
  on a different runtime, update the support layer — not the tests.
- The harness session's `agentDir` is its temporary cwd, so
  `<cwd>/delegate.json` stands in for the user-global config file. Pi
  0.87 still does not expose `agentDir` on `ExtensionContext`; the boundary
  fixture supplies an instance-local session directory underneath the
  harness cwd. Tests of cwd fallback opt out explicitly. Cold-ticket tests
  point a second boundary's session directory at the first one's agent
  directory; no process-global env override is needed.
- Assertions target observable outcomes (result text/isError/details, ticket
  status wording, filesystem effects, provider call counts), never v1 prose
  or internal state. Exact ticket-id format and wording stay loose on
  purpose.

## Coverage map

### Canonical compact/full surface (#61, 2026-09-29)

- **Contract:** one canonical spelling per field, exact authored/built-in
  names, compact advertised AND validated schemas by default, operator
  `surface: "full"` plus reload for advanced controls, stable background
  default for every nonempty task count. Existing engine features/invariants
  remain unchanged. Tools/base instructions are profile defaults; full-mode
  task overrides retain their precedence.
- **Covered now:** `surface.test.ts` proves actual compact/full declarations,
  strict advanced-field/action exclusion (including flat/stringified/null),
  profile defaults, authored scout config pins, instance independence, reload
  selection, invalid-selection visibility, and gated background return.
  `grammar.test.ts` covers one/two/three-task defaults in both modes, explicit
  inline results, exact names/case, and canonical model pins. Engine suites
  explicitly select full mode through `tests/support/full-surface.ts`;
  inline calls explicitly pass async:false, never a helper-injected default.
- **Removed-alias regression:** grammar/reflex-tail/brief/no-nesting suites
  replace former positive folds with rejection (agreement/null included),
  while preserving authored former-alias profile names and canonical features.
  `tool-boundary.test.ts` pins the full canonical schema.
- **Telemetry:** pre-schema/preparation rejections use real host start/end
  events, retaining sanitized batch metadata only, without duplicate execute
  rows. `telemetry.test.ts` proves removed-field rows, non-object root rows,
  safe schema diagnostics without prompt/base-instruction dumps, and existing
  phases. Recovery-guard and wrong-tool examples also avoid copying private
  bodies; a later extension blocking tool_call still records exactly one row,
  because execution—not preflight approval—transfers telemetry ownership.
  `surface.test.ts` also rejects malformed supplied task lists instead
  of discarding them during flat recovery, and verifies omitted/true async
  operation equivalence versus explicit-false conflict.
- **Surface-scoped manual (#64):** `surface.test.ts` proves the compact
  manual keeps the shared sections yet never names a full-only control as
  callable (no full-mode-controls section, no pause/resume/tail/timed-wait/
  steerId docs) and closes with the "Full surface adds" signpost; the full
  manual keeps every section. Outside the sessions section's `close`
  argument and the closing delta, the compact text never names
  `sessionId`/`resumeFrom` at all — shared rules, workspace exclusions,
  the interrupt doc, and the `delegate_session` description all drop
  them.
- **Provenance:** user-approved simplification supersedes #35/#41/#43/#44
  alias acceptance and cardinality defaults.


### Dispatch preflight races

- **Contract:** resource loading has no task wall-clock budget (#118), remains
  abortable, and never starts a worker after cancellation. Shutdown racing
  whole-call resolution must reject before admission or ticket creation.
- **Covered now:** `tests/regression/preflight-races.test.ts` delays the child
  resource loader, cancels a still-blocked reload before any prompt, and races
  shutdown against sync and async writer-scope resolution through registered tools.
- **Provenance:** v2 slow-loading/deadline and shutdown-resolution review;
  #118 supersedes the deadline behavior while preserving abort/shutdown safety.

### Restart visibility and provider limits (#26)

- **Contract:** ticket creation and outcomes survive a cold extension instance;
  unfinished snapshots show `interrupted` without worker replay, questions,
  delivery, or live reservations. Storage is owner-only and malformed/insecure
  records fail visibly. Provider reset-window errors do not trigger an
  immediate child retry; unhinted short rate limits may still get one
  side-effect-safe retry. Quota/account guidance does not claim auto-resume.
- **Covered now:** `tests/contract/recovery.test.ts` drives poll/wait/roster
  across separate public-tool instances, a running snapshot, terminal
  cancellation with missing outcomes or a fully recorded quarantined worker
  (including roster warning), invalid storage that does not block sync
  dispatch/session RPC, failed writes after launch, and orderly shutdown;
  `tests/contract/provider-limits.test.ts` proves the provider-call
  counts and guidance for reset headers, timed 403 limits (including
  `rate_limit_exceeded`), explicit credential failures despite incidental
  rate-limit fields and reset headers, unhinted 403 provider limits versus
  bare 403, and short limits.
  `tests/regression/failure-propagation.test.ts` retains the v1
  no-whole-task-retry scenario but replaces its model-swap expectation
  with the new account-limit contract.
- **Gap:** process-kill recovery and session replacement through Pi's own
  navigation API are not independently exercised by these tests. The journal
  has no automatic retention policy.
- **Provenance:** new v2 issue #26; v1 lifecycle.test.ts model-attributable
  failure scenario is regression evidence, not a migrated implementation test.

### Async worker questions (#17)

- **Contract:** async-only child `ask_parent` and correlated ticket `answer`;
  visible unanswered questions; parked execution capacity with session/write
  reservation retained; cancellation, pause, duplicate/late answers;
  a parent ticket wait returns on a question rather than deadlocking.
- **Covered now:** provider-free public-tool tests in `tests/contract/questions.test.ts`
  exercise ask/answer/resume, another ticket using yielded capacity, shared
  write rejection while parked, wrong/duplicate/late answers, pause,
  cancellation, invalid RPCs, and a parent already waiting.
  Also covers rejection of parallel tool calls, questions from reused
  pooled sessions, and cancellation while reacquiring capacity.
  `tool-boundary.test.ts` checks the published schema.
- **Provenance:** new v2 issue #17 contract; no v1 worker-question scenario
  exists. These are new contract tests, not migrated v1 internals.

### Parent conversation removal (#14)

- **Contract:** no parent transcript extraction/injection; obsolete `context`
  fields reject before any task starts, including `fresh`.
- **Covered now:** public schema omission; normal fresh child dispatch with no
  parent transcript reads or message injection; sync/async mixed-batch rejection; flat/stringified
  requests and invalid/null values get migration guidance (`dispatch.test.ts`).
  Existing `sessions.test.ts` proves child-owned pooled and explicit resume
  history still continues. Model inheritance tests remain unchanged.
- **Provenance:** user-directed v2 breaking removal, superseding the former
  parent-sharing contract test, not a migrated v1 implementation test.


Per subsystem: contract behaviors, regression scenarios carried forward,
internal-only v1 tests discarded, what v2 tests already represent, and known
gaps.

### Input recovery and cross-tool validation

- **Contract:** three sibling tools after normalization; fields belonging to
  another tool reject with guidance naming it; closed enums; batch validated
  before any task starts; actionable errors.
- **Regression:** stringified/flat/task-string normalization; task-level
  `async`/`sessionAction` silently degrading; `workspace:"none"` misparse;
  orphaned ticket fields producing help.
- **Internal:** direct calls to `normalizeDelegateArguments` /
  `validateDelegateOperation`; exact error wording; description-length
  budgets.
- **Covered now:** the three registered names/labels/schema keys (task keys
  without `model`); help for omitted/empty tasks; orphaned-field rejection;
  enum rejection on each tool's `action`; task-level control-field rejection;
  task-id charset; stringified/flat/tools recovery; `null` stripping at
  top-level and inside tasks; blank-identifier rules in both directions
  (poll roster on blank ticket, required-field errors on blank
  `sessionId`/`taskId`/`questionId`/`answer`, still-invalid blank `id`/
  `prompt`/`systemPrompt`, one-shot dispatch on blank task `sessionId`);
  cross-tool guidance asserted on result text including the example call —
  pre-split selectors and foreign dispatch/ticket/session fields on all
  three tools, a sibling tool's action value routing there, and examples
  that clamp an invalid action instead of echoing it; a mixed call's
  guidance naming the fields that did not run; flat fields never
  merged into an explicit task array, with the stray field named; a
  top-level `model` beside `tasks` getting the model rejection; duplicate
  task/session ids;
  removed `deadlineMs` (all values, #118); scratch/isolated + `sessionId`/`resumeFrom`;
  prompt-less task without resume; unknown agent guidance; required-field
  messages for ticket/session RPC; a task `model` field is rejected before
  any task starts with guidance toward the config; a named agent's `models`
  entry overrides the parent model for that agent (and inline tasks provably
  inherit the parent); a configured reference that does not resolve in the
  registry names the entry and the config file
  (`tests/contract/dispatch.test.ts`, `tests/contract/tool-boundary.test.ts`,
  `tests/contract/input-normalization.test.ts`,
  `tests/contract/validation.test.ts`, `tests/regression/input-recovery.test.ts`).
- **Gap:** none specific to model selection.

### Synchronous dispatch

- **Contract:** explicit async:false returns input-ordered inline outcomes
  for every task count; omission backgrounds every nonempty dispatch (#61).
- **Regression:** failed task does not fail siblings or destroy index
  alignment; partial output/usage preserved on failure (v1 additionally
  preserved touched-file lists — the heavier physical tracking was dropped
  2026-09-27 and a lighter observed-path attribution returned under SPEC v3
  "Observability — Completion evidence"; see the attribution section below).
- **Internal:** `formatCompletedTask`/`formatFailedTask` rendering, header
  markers, `fmt*`/`trunc*` helpers, touched-file extraction helpers.
- **Covered now:** ordered results; sibling failure isolation — a mixed
  sync batch is a normal result while an all-failure batch is error-valued
  (#6's sync analog); task-id echo;
  aggregate usage on the tool result; parent-abort of an in-flight sync call
  settles as a structured cancellation (asserted in the cancellation
  regression suite via `callDelegateDetached` + raw-session `abort()`);
  stall outcomes visible in result text (cancellation suite);
  a sabotaged model-runtime grab (truthy impostor injected through the raw
  harness session) fails the whole call with the actionable error before any
  task starts (`tests/regression/host-runtime.test.ts`, issue #11);
  incomplete accounting marks usage totals as lower bounds (§3d item 9):
  a quarantined outcome prints "at least" output/usage wording and the
  result carries `details.usageLowerBound`
  (`tests/contract/dispatch.test.ts`).
- **Covered now (#13, v2 regression evidence):** throwing parent active-tool
  probes reject mixed sync/async batches before any child starts, preserving
  cause, guidance, and logging; explicit tools (including `[]`), built-in
  explore/coder/reviewer, and inline choices bypass the probe; successful
  restricted-parent mirroring retains read-only tools and preserves empty or
  unsupported-only inventories; a public extension's `setActiveTools` on the
  three delegate tools independently exercises the real host path
  (review 5722868479)
  (`tests/regression/parent-tools.test.ts`). Host-only injection in
  `tests/support/parent-tools.ts` targets Pi 0.84.2's extension runtime callback
  while retaining the wrapper's live inventory. Calls still use the registered
  delegate tool. The original AgentSession fault seam also broke the wrapper
  before delegate ran; its verifier commit is retained, with one explicitly
  user-authorized correction commit (#13 exception comment).
- **Gap:** none — overlap reporting returned in lighter form under SPEC v3
  "Observability — Completion evidence" (one `overlap:` line per path two
  tasks attributed, naming both ids; see the attribution section below).

### Multi-task / concurrent dispatch

- **Contract:** bounded global and per-model concurrency; order independent
  of completion order; queued tasks hold no execution resources.
- **Regression:** abort wakes queued tasks without waiting for a slot; a
  gated successor waits without holding a global slot.
- **Internal:** `mapConcurrent*` helpers; `reconfigureGlobalConcurrency`
  mechanics.
- **Covered now:** configured bound (`delegate.json` `maxConcurrent`) limits
  simultaneous subagent work (measured through the faux provider's live call
  tracking); the bound is re-read per call in both directions; a per-model
  bound (`concurrency.models`) serializes below the global limit; a task
  cancelled while queued behind the bound never reaches the provider.
- **Gap:** per-provider limit variants; abort-of-queued while parked behind
  a serialized writer.

### Async tickets

- **Contract:** `async: true` — and every nonempty call under the v3
  stable background default — returns a ticket immediately; auto-delivery;
  poll roster and single-ticket views; wait blocks to settlement or timeout;
  tickets stay pollable after settlement; natural settlement is `completed`
  (every task ok), `partial` (at least one ok and at least one not),
  `cancelled` (all cancelled), or `failed` (none ok, at least one failed)
  while forced cancellation stays `cancelled`; a singular ticket RPC on an
  unknown id is a tool error while an empty roster poll succeeds.
- **Regression:** cancelled tickets retain partial results with index
  alignment; a late worker cannot flip a cancelled ticket to done; wait
  timeout/abort detaches only that waiter; delivery failure never unsettles.
- **Internal:** ticket id generation, TTL sweeping, roster/format string
  composition, busy-index internals, waiter plumbing.
- **Covered now:** empty roster; error-valued unknown-ticket handling for
  all singular actions; wait-to-settlement; timeout detach; cancel preview
  vs force; explicit `partial` mixed-batch and `failed` all-failure
  settlement; cancelled-ticket retains completed results; pause/resume;
  live activity in running polls (§3d item 8) — each unfinished task's
  row names the in-flight tool or the `last:` completed one, the running
  tool count, and an `active now`/`active Ns ago` age, queued tasks read
  `waiting…`, and the header totals active/queued tasks and tool calls.
- **Covered now (`tests/contract/delivery.test.ts`, `SPEC.md` "Background
  delivery" and "Wake delivery"):** same-leaf steering wake
  (`deliverAs: "steer"` + `triggerTurn: true`) — on an idle parent it
  triggers a new turn, including after a prior navigation; on a busy
  parent the delivered `delegate-result` custom message enters context
  before the run's final assistant message (proven through a held
  tool-call turn — the harness cannot place the message between two
  model calls of one run, so the turn-boundary ordering is asserted as
  "before final assistant message / before `agent_end`", live session
  01a0fdba, 2026-10-02); durable no-wake append plus "appended" notice
  after `/tree` navigation (`triggerTurn: false` — the custom message
  lands in the session at the current leaf); delivery held until
  isolated reconciliation applies and final annotations land; delivery
  failure (throw or async rejection) is logged/surfaced and leaves the
  ticket settled and pollable; failed and cancelled batches deliver
  their safe partial results; pause holds delivery until the whole
  batch finishes; `session_shutdown` force-cancels tickets, resolves
  waiters, performs no delivery, and holds until worker quiescence is
  actually confirmed and through the batch's finalization — when
  shutdown completes, the pollable view already carries the integration
  annotations, so a replacement session never starts into a tree the
  old batch is still reconciling; the visible waiting status names the
  awaited ticket id; new dispatches reject once shutdown begins while
  ticket RPCs still answer. Wake coalescing (#36): settlements inside
  the ~100ms flush window emit ONE steering message whose content names
  every settled ticket and whose details carry the merged ids and
  outcomes; settlements past the window wake separately; a window
  mixing same-leaf and moved-leaf tickets emits one wake plus one
  append + one notify naming the moved tickets; a ticket enqueues at
  most once ever; a settlement queued at shutdown is suppressed, logged,
  and stays pollable. Delivered-result suppression (closes the gap
  named below, live session 01a0fdba, 2026-10-02): a `wait` or `poll`
  that returned the ticket's terminal view consumes the pending wake —
  no `delegate-result` message is appended and the skip is logged; a
  wait consuming one of two settled tickets still delivers the
  unconsumed sibling alone; a timed-out wait that returned while the
  ticket kept running does not consume — the result delivers on
  settlement.
- **Gap:** progress/onUpdate frames; roster wording details; replacement-session
  non-inheritance (no real session replacement is expressible through the
  harness — the emitted `session_shutdown` path is covered instead).

### Output bounding (#25)

- **Contract:** LLM-facing output is bounded — settled/sync output over
  `output.spillThresholdChars` spills the complete output to an
  owner-only `delegate-output-<agent>-<rand>.md` temp file and renders a
  `output.spillTailChars` tail plus pointer; running-ticket views render
  tail-only and never write or name a file; a failed write returns the
  complete output in-context; empty/`"(no output)"` outputs pass through;
  bounds snapshot per ticket at creation; a frozen settled view keeps one
  stable spill path across polls; the complete record stays in `details`.
- **Regression:** surrogate-pair-safe tail cut; exclusive create (no
  overwrite on collision); mode 0o600.
- **Internal:** `decideSpill`/`spillToTempFile`/render helpers, the v1
  `spillFileOperations` test seam, exact pointer/note wording — v2
  exercises the whole behavior through the tool boundary, steering the
  spill directory with `TMPDIR` (`os.tmpdir()` reads it per call).
- **Covered now:** pass-through under threshold; sync spill file
  contents/name/mode + stable tail pointer + complete `details.results`;
  failed-task partial bounded; running-ticket poll tail-only with zero
  files, settling spills; pointer stability across settled polls;
  creation-time bounds snapshot; lossless write-failure fallback;
  surrogate-safe tail; empty/placeholder passthrough; malformed `output`
  bounds reject before any task starts
  (`tests/contract/output-bounds.test.ts`); the registered tool/message
  renderers show the complete recorded output when expanded — sync
  result, running and settled ticket polls, and the delivered
  `delegate-result` message — while collapsed views keep the bounded
  content (`tests/contract/rendering.test.ts`).
- **Provenance:** v1 `spill.test.ts` scenarios (threshold/tail, surrogate
  pairs, file contract, write-failure degrade, poll no-file) replayed at
  the public boundary; v1 `config.ts` `output` validation wording
  preserved.
- **Gap:** none identified.

### Static call rows (tool `renderCall`, 2026-09-27)

- **Contract:** all three delegate tools render a static call row — the
  line the host shows while the tool call is outstanding. `delegate`
  renders `delegate N task(s)` plus up to four prompt previews (`↻<tag>`
  on resume-only tasks, caller ids where given) and `… and K more`;
  an empty call reads `delegate manual`. `delegate_ticket` and
  `delegate_session` render `action target` one-liners. No timers,
  spinners, or live state.
- **Covered now:** `tests/contract/rendering.test.ts` — the registered
  tools' `renderCall` return `Text` components whose lines match the
  contract for empty, single, four-plus, and resume-only calls. #63
  relabels rows by description → caller id → agent → `inline` (positional
  `task-N` dropped — compact callers cannot set ids), pads labels to a
  common width, and shortens ticket ids in display only (`t-<first8>`,
  including compound `<ticket>#<task>` steer/interrupt/tail/answer
  targets).
- **Collapsed result views (#63):** the collapsed `renderResult`/`message`
  renderers draw their own document, not a truncated content preview:
  `✓`/`✗`/`⊘`/`○` status glyphs with description/agent/id labels and a
  first-output-line summary (markdown markers stripped), `· N file(s)` and
  exceptional integration/`source drift` meta, a `ticket t-<8> · status
  done/total` header over live-ticket results, a one-line
  `↳ background ticket …` async receipt, a muted `manual` stub for help,
  and first-line-plus-hint for receipts/rosters — expanded views unchanged.
  Covered: per-status icons and labels, ticket header + running slots,
  async one-liner, receipt/roster truncation, delivered-message collapsed
  lines. The same honesty the expanded view carries applies collapsed:
  `unknown shell` survives a file count, unevidenced PASS/FAIL verdicts
  keep their `unverifiable`/`not corroborated` qualification, recovery
  warnings/notices/pending questions and a wait's tail note (timeout,
  detached, wait-any roster via `details.note`) render below the task
  lines, roster entries keep their warning/question sub-lines, a settled
  ticket's missing slot words itself (`cancelled`/`no outcome recorded`,
  never `running`), an error-flagged result still draws the task rows,
  and a delivered message renders per-ticket headers only when every
  named ticket resolves — otherwise the recorded merged outcomes, so a
  store-missed ticket's failures cannot silently vanish. Untrusted text
  (task output, errors, questions, call arguments, notices) is stripped
  of C0/C1 terminal controls before display.
- **Gap:** none identified.

### Cancellation

- **Contract:** preview unless `force`; cooperative; never claims rollback or
  subprocess termination; cause precedence parent-abort > stall;
  cancelled work must still produce a caller-visible outcome; unsafe-to-clean
  resources stay quarantined.
- **Regression:** cancellation during prompt/turn produces structured
  cancellation (not provider-error text); completed writes survive.
- **Internal:** quiescence-barrier internals, unwind budgets, settle-path
  plumbing.
- **Covered now:** cancel preview/force and retained results; a task
  cancelled while queued behind the concurrency bound never starts; a task
  cancelled while paused between model turns does not start another
  provider call; a mid-stream abort is a structured cancellation, not an
  error, and no extra turn starts. Caller settlement is decoupled from
  worker wind-down: a forced cancel settles while a gated provider keeps
  cleanup blocked, a sync call returns a structured outcome when its
  inactivity watchdog fires against a non-cooperative worker, conflicting work
  rejects while the quarantined worker may still mutate, and the
  reservation releases only after quiescence is actually confirmed.
  Parent-abort of an in-flight sync call settles with the `cancelled` cause
  (which outranks stall) while the gated worker is
  still held — proven by driving `session.session.abort()` on the raw
  AgentSession mid-call. The stall cause: a worker silent past the
  `delegate.json` `stallTimeoutMs` budget settles as a structured stall
  (not a deadline, not a plain cancel) with its reservation retained until
  the gated worker winds down; parked time behind a paused ticket is not
  inactivity (the countdown freezes between turns), while a silent
  in-flight turn still stalls under a paused ticket. The workspace
  preparation races (issue #1 unification): a shutdown force-cancel
  aborting a dispatch parked in preparation lets the boundary settle while
  the sync batch quiesces under its barrier and the async caller keeps its
  cancelled ticket; a forced cancel racing preparation likewise still
  returns the ticket id with its cancelled outcomes recorded; and the
  prep-failure variants — where the copy/worktree throws rather than
  aborts — fail the whole call with the cause, expose no ticket, and leave
  no shutdown barrier behind (async and sync).
- **Gap:** a worker whose abort is delivered
  but then completes "ok" anyway (the faux provider always honors a
  tripped signal once its gate releases, so the boundary cannot produce a
  late success — the abortReason guard is what keeps it cancelled);
  cancellation landing during child-session creation (no deterministic
  boundary seam for it).

### Pause / resume

- **Contract:** cooperative boundary between tasks and model turns; paused
  ticket stays running and keeps sessions and reservations.
- **Regression:** resume-then-repause cannot leak a waiting operation; a
  naturally final turn completes instead of parking; parked time is not
  inactivity; tasks have no wall-clock deadlines (#118).
- **Internal:** checkpoint machinery, `Agent.subscribe` gating, parked
  listener bookkeeping.
- **Covered now:** pause holds queued work; paused ticket remains running;
  resume continues to settlement; parked time is not inactivity (the stall
  countdown freezes while parked and resumes with its remaining budget),
  and a silent in-flight turn still stalls under a paused ticket. v2 gates
  queued tasks before slot acquisition and parks between-turn continuations
  via the core `prepareNextTurnWithContext` hook. `tests/contract/pause.test.ts`
  adds: domain rejections (pause/resume on settled, resume on non-paused)
  as returned error results; the mid-turn sequence `pausing — finishing
  current turn` → `paused between turns` (poll lines) with tail
  `taskState: "paused"`; resume continuing the same live session
  (`callCount === 2`, no replay).
- **Gap:** closed — mid-turn pause semantics and pause unavailability on
  terminal tickets are covered by `tests/contract/pause.test.ts`.

### Session reuse and lifecycle

- **Contract:** `sessionId` pools a live session for host lifetime; same-id
  serializes; frozen cwd/tools/thinking/model/base-prompt/extension config;
  insert-on-success; `resumeFrom` rehydrates and may then pool; `close`
  disposes; `list` reports live sessions; shutdown cleans up.
- **Regression:** frozen-config mismatch is an actionable rejection; missing
  `resumeFrom` transcript errors; busy sessions (including cancelling
  tickets) reject conflicting reuse; cancelled/stalled pooled sessions are
  evicted; rejected deadline fields leave the pooled session intact with no
  provider call (#118); late materialization after cancellation is never prompted or pooled.
- **Internal:** pool map/locks, config cloning, quarantine registry, session
  file bookkeeping.
- **Covered now:** pool + list + continuation on reuse; `close` removes and
  a later call starts fresh; frozen-config mismatch rejects with an
  actionable error; a pooled session whose agent's configured model changed
  between calls rejects the same way (model freeze compares resolved models);
  a pooled session cancelled mid-reuse is evicted and the
  next call starts fresh (busy `close` also rejected in-flight); `close` on
  an unknown session errors; missing-transcript `resumeFrom` error; a
  `sessionId` held by a running ticket rejects conflicting reuse;
  `resumeFrom` without a prompt rehydrates the transcript and sends the
  default continuation instruction (live test with a real `.jsonl`
  fixture); empty `sessionId` rejected.
- **Gap:** usage recorded for ordinary failures on pooled sessions remains
  open: the "records its attempt" test witnesses the single provider call,
  not usage. Stall/cancel eviction, shutdown cleanup, and rejection before
  pooled-session acquisition are covered. Deadline eviction is retired (#118).

### Transcript exclusivity (2026-09-27)

- **Contract:** one transcript, one live owner. A `resumeFrom` (or symlink
  alias) whose transcript is owned by a running worker rejects before any
  child starts; a live pooled session's durable file rejects the same way
  (discovered at admission through the pool, and for a pooled first run at
  execution through the grant's `holdTranscript`); two tasks in one call
  never share a transcript; exclusivity releases on confirmed quiescence,
  retaining through quarantine like every other reservation (INVARIANTS
  "Session reuse").
- **Covered now:** `tests/contract/transcripts.test.ts` — same-call
  duplicates reject the whole call naming both tasks with zero provider
  calls; a gated async worker's transcript rejects cross-call resume naming
  the owning ticket, then resumes cleanly once the ticket settles; a
  symlink alias rejects with the canonical path in the error; a pooled
  session checked out by a gated run rejects `resumeFrom` at its durable
  file, then resumes after the run settles.
- **Provenance:** v1 `task-resolution.test.ts` "rejects a canonical alias of
  a quarantined resumeFrom transcript" and v1 `session-quarantine.ts` —
  v2 dropped the quarantine in the rewrite (2026-09-27 gap audit,
  V1-V2-MAP §3d item 6); user decision restored the live-worker half.
  v1's abandoned-transcript quarantine (workers that died mid-run) was
  **not** restored: a dead writer no longer mutates the file, and v2
  reservations cannot outlive the process that held them.

### Failed-run transcripts and resume visibility (§3d items 5+7, 2026-09-27)

- **Contract:** a failed fresh shared-workspace task leaves its session
  `.jsonl` under the agent directory; the result names `session:
  <abs path>` and, when the transcript carries messages, a `→ To retry:`
  hint whose `resumeFrom` round-trips. Scratch/isolated failures stay
  memory-only and print no `session:` line. A transcript without messages
  (header flushed, never prompted) reports "no prior messages" with no
  resume hint. Resumed tasks carry the `↻<tag>` marker in sync result
  sections, running/settled ticket views, and cancel previews; the tag
  survives journal reload so a cold poll shows the same marker.
- **Covered now:** `tests/contract/transcripts.test.ts` — fresh shared
  failure leaves a real resumable transcript and its hint's `resumeFrom`
  completes a second provider call; scratch failure prints nothing and
  leaves no file; the ↻ tag appears in every v1-covered view (sync
  section, running poll row, cancel preview, settled view) and is not
  duplicated when the agent label already carries it.
  `tests/contract/recovery.test.ts` — a recovered failed ticket renders
  the same session path and hint cold; a saved outcome whose sessionFile
  is header-only reports "no prior messages" and no hint.
- **Provenance:** v1 `format.ts`/`task-format.ts` resume-tag formatting
  and v1's failure-output `session:`/`→ To retry:` lines (§3d items 5
  and 7). The header-only cold case is exercised through journal seeding
  because no deterministic public seam exists for aborting between
  session creation and the first prompt (see "Cancellation" Gap).

### Admission and shared writes

- **Contract:** fail closed on ambiguous Git/cwd scope; canonical equal /
  ancestor / descendant roots overlap; `read`, `grep`, `find`, `ls`,
  `web_search` are read-only; unknown tools count as mutating; same-call
  overlapping writers serialize in task order; overlap with active or
  quarantined work rejects; shared/isolated overlap rejects. (The v1
  operator-only warned bypass is deliberately not carried — see
  `COMPATIBILITY.md` 2026-09-21.)
- **Regression:** symlink canonicalization; inherited `GIT_DIR`/
  `GIT_COMMON_DIR`/`core.worktree` redirection fails closed with bash-capable
  writers; nested repositories reject; path-prefix siblings are not nested;
  a predecessor failure does not block a serialized successor.
- **Internal:** `findSharedWriteConflicts` grouping internals, canonical-path
  helpers.
- **Covered now:** same-call writer serialization order; cross-call
  rejection against a running ticket — the rejection names the live
  running-task count against `maxConcurrent` and the held write claims
  (task + owner) (#51); shared + isolated same-call rejection;
  an inherited `GIT_DIR` redirect fails closed for a bash-capable
  multi-writer batch; the scope probe runs with `GIT_*` scrubbed so a bogus
  redirect cannot shrink the reserved scope.
- **Gap:** read-only + writer parallelism allowed; unknown-but-real tools
  treated as mutating; symlink canonicalization; external `core.worktree`
  dual-root reservation; scratch
  suggestion in rejection prose.

### Scratch workspaces

- **Contract:** one-shot; disposable copy; changes discarded; no `sessionId`
  or `resumeFrom`; relative-write protection only; actionable setup-failure
  remedy; read-only tasks rejected; no source write reservation.
- **Regression:** stale-copy sweep (pid-namespaced, dead pids collected);
  linked-worktree rejection (a `.git` file redirects Git into the real
  repository); setup failure appends the `workspace:"shared"` remedy.
  V1's symlink-escape rejection is deliberately dropped — scratch is not a
  sandbox, and stores like pnpm/bun make escaping links common; links are
  preserved verbatim instead.
- **Internal:** lease layout/markers, sweep mechanics, copy strategy.
- **Covered now:** discarded mutations never reach the source tree;
  read-only tasks reject before any provider call; a linked worktree
  rejects with the shared/isolated remedy; a scratch task does not
  conflict with an overlapping shared writer; copies from dead processes
  are swept; copies land under the agent dir, never beside the source;
  an `edit` to the absolute source path is refused naming the copy-mapped
  path and leaves the source untouched (#62); a shell escape into the
  source is drift evidence on the shell-capable worker's integration
  (`integration.sourceDrift`), journal-delivered on async tickets
  (settlement holds through scratch finalize), with repositories lacking
  commits seeding from an empty index; the window closes before
  same-phase isolated proposals apply, so legitimate applies never pose
  as escapes; a same-batch shared writer's attributed files are
  subtracted from drift, and a shell-capable shared sibling de-scopes
  pinning for the overlapped root entirely (unattributable, logged); a
  shell-less worker is never pinned; non-Git sources get no evidence and
  log once.
- **Gap:** nested repositories whose `.git` files use absolute gitdirs
  (accepted risk: an ordinary copy preserves them, and scratch is not a
  security boundary).

### Isolated workspaces

- **Contract:** one-shot Git isolation; baseline (dirty/untracked) and the
  user's index/branch preserved; task-order all-or-nothing reconciliation;
  conflicts and pre-apply cancellation retain recoverable artifacts;
  `applied_unverified` never claims correctness; worker activity ends before
  output is accepted.
- **Regression:** source changed mid-execution refuses apply; failed workers
  are discarded; abandoned workers are never snapshotted or applied;
  proposals with no changes leave nothing behind.
- **Internal:** temporary-index strategy, private refs, patch representation,
  candidate-worktree mechanics.
- **Covered now:** ordered apply of two proposals with `applied_unverified`
  wording; conflict retains artifacts without clobbering a human edit while
  an independent proposal still applies; a failed apply preserves unrelated
  working-tree edits as a per-path conflict (verify-before-write); an
  identical second proposal reports `applied_unverified` with empty
  `appliedFiles` and already-present wording, never a fresh apply.
  Workspace guard (#62): a `write` to the absolute source path is refused
  naming the copy-mapped path, the mapped write reconciles normally, and
  the refused path is not attributed; both surfaces' child prompts carry
  the workspace note with real roots (authored `systemPrompt`s
  included); a worker's shell write into the
  source is reported as `sourceDrift` on its integration and renders as
  `source drift:` — while a worker that never ran a shell is not blamed
  for drift it could not have caused. Path spellings normalize like pi's
  own write/edit layer before the guard compares (`@`-prefix, `file://`
  URLs, unicode spaces), a dangling symlink's write-through is refused
  rather than redirected into the source, a refused re-write preserves an
  earlier write's attribution on the same path, delegate-owned agent-dir
  churn under the repo is excluded from drift, and a cancelled batch's
  drift report still lands (the check runs off the dispatch abort signal,
  `-z --no-renames`).
- **Gap:** binary-content proposals end-to-end — patches always carry
  `--binary` and the failed-apply tests fault that invocation, but no test
  pushes actual non-text content through a live proposal; index/branch
  invariance asserted on refused paths — the success-path test asserts the
  staged index survived, the conflict/failed-apply tests assert file bytes
  only. Cancellation before apply, baseline-drift refusal (same-file
  mid-flight edits, drift between check and write, partial duplicates),
  symlink/mode reconciliation, and abandoned-worker cleanup are covered
  above and under "Invariant hardening"; worker termination itself is
  cooperative by contract (see "Cancellation and quiescence").

### Failure propagation and retries

- **Contract:** transient failures may retry; account and provider-window
  failures do not blindly retry on the same model; exhausted retries return
  the last error; validation failure starts no tasks.
- **Regression:** retry accounting stays aligned on abort during backoff;
  observed bash activity suppresses whole-task retry; usage-limit results
  retain the provider reason without promising auto-resume.
- **Internal:** `isModelAttributableError`, retry-gating internals, backoff
  timing.
- **Covered now:** transient retry to success; usage-limit no-retry +
  account-limit hint; serialized successor after predecessor failure; batch
  validation starts nothing; safe retry and backoff have no task wall-clock
  budget (#118).
- **Gap:** retry-count visibility in results; stall structured outcomes;
  no-retry-after-side-effects (needs a mutating tool before a transient
  failure).

### Telemetry and observable events

- **Contract:** usage on synchronous results; async delivered results never
  add usage; telemetry is fail-open and never stores prompt/output content;
  externally visible signals (ticket roster/poll text, status surfaces) stay
  meaningful.
- **Internal:** SQLite layout, sweep cadence, record-once mechanics — all
  free to change; only privacy and outcome-meaning are contract.
- **Covered now:** aggregate usage present on the sync tool result;
  telemetry is disabled by default and creates no file; explicit opt-in
  writes call/task rows carrying only the allowed metadata with legacy
  privacy columns NULL and `version`/`pi_version` stamped with the
  extension and host Pi versions on every row — misfires included
  (#50); `telemetry.dbPath` > `DELEGATE_TELEMETRY_DB` >
  `<agentDir>/delegate-usage.db` precedence; open/write failure is
  fail-open and leaves dispatch results intact; DB/WAL/SHM files are
  owner-only; a v1 database migrates in place preserving existing rows;
  simultaneous first-open writers each persist exactly one call and one
  task row per batch; malformed telemetry config rejects before provider work;
  force-cancelled calls record authoritative cancellation; a failed destination
  retries after the identity changes; isolated integration status records only
  after reconciliation; an unfinished span is dropped when the destination
  changes before its batch finishes; task rows whose workers have unconfirmed
  quiescence are marked provisional; a dispatch rejected before execution —
  config load, call-shape/semantic validation (exact requested agent names recorded),
  or admission — writes a `misfires` row with the phase, the verbatim
  caller-visible message, and the batch shape, and a completed dispatch
  writes none (#35, `SPEC.md` "Observability").
- **Gap:** async-no-usage property; TUI/status rendering is
  intentionally out of scope for boundary tests.

### Agent directory resolution

- **Contract:** the user-global agent directory resolves from
  `DELEGATE_AGENT_DIR` when set, else Pi's own `PI_CODING_AGENT_DIR`
  override (via pi-coding-agent's exported `getAgentDir()`), else Pi's
  session-store layout (`<agentDir>/sessions/<slug>`), else the session
  cwd. Pi 0.87 exposes no `agentDir` on `ExtensionContext`; when it does
  (earendil-works/pi#4807), the inference and the fallback are deleted.
  Host-compat reaches (the parent model-runtime handle and this
  resolution) are probed on `session_start` — the probe **logs** a failure
  and never throws (a throw would reach every session through the
  extension-error channel, and the model wiring may not be final that
  early); the definitive failure stays at first dispatch with the same
  message (#9).
- **Regression (#12):** the cwd fallback — taken by embedded/in-memory
  hosts — must not be silent: it warns once per extension instance before
  the first dispatch, naming the directory, `delegate.json`, the
  `delegate-*` trees that may be created under it, and the
  `DELEGATE_AGENT_DIR` escape hatch; the call itself proceeds (warn, not
  reject). A file-backed session under `<agentDir>/sessions/` resolves to
  that agent dir via the "session" source with no warning.
- **Internal:** the provenance tuple shape and the warning latch are free
  to change; only warn-once-then-proceed and source precedence are
  contract.
- **Covered now:** `tests/regression/agent-dir-fallback.test.ts` —
  including `PI_CODING_AGENT_DIR` winning over session-store inference.
  `tests/regression/boundary-isolation.test.ts` covers the v2 review
  regression: overlapping harness sessions keep configuration reads and
  pooled transcript writes in their own directories without changing the
  process environment.
- **Regression (review of #9):** a broken host seam at session start must
  not break or scold the chat — the probe logs a `[delegate]` line, the
  session opens with tools registered, and the first dispatch fails
  whole-call with the actionable runtime-grab message. Covered by
  `tests/regression/session-start-probe.test.ts`, which loads a fault
  extension (`tests/support/broken-runtime-fault.ts`) before delegate.ts
  so its own `session_start` handler sabotages the registry first; the
dispatch-time failure is separately pinned by
`tests/regression/host-runtime.test.ts`.
- **Retired gap:** the `session_start` probe's failure path was previously
  listed as untestable without reaching below the extension boundary — the
  fault extension loads through the same extension path the harness uses,
  so no production seam was added for the test.

### Explicit dispatch identity (#16)

- **Contract:** `operationId` scopes a dispatch to one execution per live
  key+request: the same normalized `{async, tasks}` reuses the in-flight
  promise or settled result (sync result or async ticket), a changed
  request conflicts before any work, retention is bounded (one-hour
  expiry, 256 settled records, in-flight never evicted), the first caller
  owns cancellation/context/progress/delivery, and unkeyed dispatches are
  never deduplicated. Host-lifetime only; no crash or exactly-once claim.
- **Regression:** concurrent retries share one gated execution; a
  duplicate caller's aborted signal cannot cancel the shared operation;
  post-settlement retries reuse; same-id changed requests conflict while
  running and after settlement; forced-cancel results are reused, never
  restarted; an in-flight async operation survives settled-cap pressure
  and retries to the same ticket; expiry and capacity eviction permit
  fresh operations; intentional unkeyed repeats always execute;
  equivalent supported normalizations (flat task vs one-task array,
  batch workspace default vs task workspace) count as identical.
- **Internal:** the map, the fingerprint hash (SHA-256 today), and prune
  mechanics are free to change; only the identity semantics and bounds
  are contract.
- **Covered now:** `tests/contract/operations.test.ts`, including
  failed-result reuse after the configuration that caused the failure is
  fixed, alongside forced-cancel result reuse.
- **Gap:** none.

### Operator-visibility signals (issue #24)

V1 evidence: `status.ts` (footer formats, settle warning, replacement
guards), `extension.ts` shutdown traces, `browser.ts`/`browser-state.ts`
(browser surface, retention, pause key).

- **Contract:** footer appears/merges/clears with ticket lifecycle and
  reflects pause/resume; settle warning once per ticket activation with
  warning severity; sync dispatches never set the footer. Added
  2026-09-22 with the guard itself: the tree-navigation consent prompt —
  exactly two choices (v1's third "hold" option dropped by owner
  decision), dismissal stays, the cancel choice force-cancels live
  tickets and proceeds — driven through the host's own `navigateTree`;
  the cross-leaf append contract in `tests/contract/delivery.test.ts`
  drives the guard's fail-open path (no consent-to-hold choice exists
  anymore). Live tests in `tests/contract/visibility.test.ts`.
- **Regression:** footer dedupe must retry after a failed setStatus push
  (a stale context must not wedge the footer); a throwing activity sink
  must never fail a dispatch. `tests/regression/browser-layout.test.ts`
  drives real provider-free dispatches and the registered `/subagents`
  command through the host's custom-UI boundary: full-width framed
  occlusion, one physical row per compact tool, multiline prompt safety,
  expanded bounded previews, response switching, roster selection,
  scrollback/live-follow, resize/tiny-terminal behavior, editor non-mutation,
  whole-ticket pause/resume, Escape completion and refresh cleanup.
- **Internal:** browser rendering internals (SelectList wiring, refresh
  timer, generation counter), activity-store caps. The browser tests capture
  the public custom component using a terminal fixture, not production
  internals; an installed-Pi render-only check covers real-host composition.
  Not ported: the `session_before_switch`/`fork` guards cannot be driven
  through the harness — verified by typecheck and fresh-context review;
  an accepted gap, not a coverage target.
- **Gap:** live sync-run rows (deliberate divergence, #24).

### Dependencies and handoffs (issue #18)

New v2 contract — no v1 evidence; the dependency graph is an additive
`dependsOn` field, so there is nothing to migrate.

- **Contract:** `dependsOn` names same-batch prerequisites by explicit id or
  generated `task-N`; the whole graph validates before any task starts
  (unknown references, self-dependencies, cycles, ambiguous ids are
  whole-call errors); a dependent runs only after every prerequisite is
  confirmed-quiescent and ended `ok` — isolated prerequisites must also
  have applied (or cleanly empty) proposals; a failed/unapplied
  prerequisite blocks the dependent visibly without consuming a worker,
  while unrelated branches still run; a dependent's prompt carries each
  prerequisite's bounded output plus what became of its work (applied file
  list, discarded-scratch note); scratch/isolated workspace preparation is
  phase-late so dependents see earlier applied changes; same-call
  shared/isolated overlap is admitted only when the graph orders every
  overlapping pair. Live tests in `tests/contract/dependencies.test.ts`.
- **Regression:** predecessor edges chain writers in (phase, index)
  order — never pointing at a later-phase task, which would deadlock
  the phase loop — because the phase boundary awaits recorded outcomes,
  not confirmed quiescence (`admission.ts`); a dependent of a
  quarantined prerequisite blocks without waiting on quiescence that
  may never arrive, since a post-cancellation worker truth can never
  satisfy the gate (`coordinator.ts`). Live tests in
  `tests/regression/cancellation.test.ts`.
- **Internal:** graph resolution/phasing helpers (`graph.ts`) — not
  boundary-tested directly.
- **Gap:** none — blocked outcomes under `async` wait/poll/delivery views
  are covered live (see "Invariant hardening" below), as is cancellation
  superseding the dependency gate.

### Invariant hardening (2026-09-26, not v1-migrated)

Coverage added from an INVARIANTS/SPEC gap review rather than v1 evidence:
behavior that had no live test pinning it. Each entry names the invariant
and the file that carries it.

- **Isolated cancellation beyond preparation** (INVARIANTS "Isolated
  application"): cancelling a batch after an isolated worker finished
  retains its proposal unapplied with recoverable artifacts; parallel
  isolated workers cannot see each other's edits; an abandoned worker's
  edits are never applied and its worktree is cleaned up after confirmed
  quiescence. `tests/contract/workspaces.test.ts` (mutation-verified:
  cutting both the reconcile-signal and the should-apply gate fails the
  retain test).
- **Reservation release at settlement** (INVARIANTS "Ticket state":
  terminal tickets do not block conflicting work): a settled async ticket
  releases its write reservation for the next dispatch.
  `tests/contract/workspaces.test.ts`.
- **Session-reuse dispositions** (INVARIANTS "Session reuse"): stall
  eviction; deadline-field rejection leaving the session intact with no
  provider call (no usage possible); ordinary failure keeping the session
  reusable; the busy-while-running/reusable-after-settle cycle; shutdown
  disposing every pooled session — running ones after quiescence — and
  refusing later sessionId dispatches. Cleanup-failure REPORTING is
  log-only: `AgentSession.dispose` is built not to throw, so it has no
  boundary-observable failure mode. `tests/contract/sessions.test.ts`.
- **Timer rules** (INVARIANTS "Cancellation and quiescence", #118): tasks
  have no wall-clock budget (watchdog disabled, worker stays running despite
  advancing wall time); the removed field rejects before execution in both
  surfaces. `tests/regression/cancellation.test.ts` and
  `tests/contract/deadline-removal.test.ts`. Paused/question inactivity
  suspension and silent in-flight stall behavior remain covered.
- **Waiting tasks hold no concurrency slot** (INVARIANTS "Shared writes"
  and "Dependencies"): serialized same-call writers and dependency waiters
  hold no slot while waiting — at `maxConcurrent: 1` a slot-holding wait
  deadlocks the batch; a dependent reached after cancellation is
  cancelled, not blocked. `tests/contract/dependencies.test.ts`
  (mutation-verified: acquiring capacity before the predecessor wait
  fails both slot tests).
- **Shutdown cancels pending questions** (SPEC "Worker questions"):
  session shutdown invalidates a worker's unanswered question, settles the
  ticket cancelled, and late answers error.
  `tests/contract/questions.test.ts`.
- **operationId is host-lifetime** (INVARIANTS "Dispatch identity"):
  after a restart over the same agent directory the same key re-runs the
  work under a fresh ticket while saved results stay pollable.
  `tests/contract/operations.test.ts`.
- **Unknown tools fail closed** (INVARIANTS "Shared writes" — unknown
  tools are mutating): v2's stricter boundary rejects an unrecognized
  tool name whole-call during resolution, before admission or any worker;
  a caller-supplied name can never silently downgrade a writer into an
  unreserved reader. `tests/contract/validation.test.ts`.
- **Pi's per-turn auto-retry stays off in child sessions** (COMPATIBILITY
  "Subagent Pi auto-retry is disabled…"; AGENTS.md requires rechecking on
  every Pi bump): a retryable provider error yields exactly Delegate's
  two whole-task attempts — one provider call each — never Pi's in-turn
  retries. `tests/regression/child-auto-retry.test.ts` (mutation-verified
  against `setRetryEnabled(true)`).
- **Blocked outcomes in async views** (INVARIANTS "Dependencies and
  handoffs"; SPEC "Dependencies and handoffs" — the issue #18 gap's
  remaining half after the cancellation-supersession tests): a blocked
  dependent's terminal outcome — status, blocking prerequisites, reason —
  appears in the async ticket's settled `wait` and `poll` views (text and
  `details.results`) and in the delivered `delegate-result` message
  (content and `details`), under the `partial` settlement header, with no
  provider call ever made for the blocked task.
  `tests/contract/dependencies.test.ts` (mutation-verified: recording
  blocked outcomes as `failed` fails the view assertions).

### Interaction grammar (#35, updated by #61)

The #61 coverage entry above describes current defaults, exact agent names,
strict field rejection and preflight telemetry. Foreign history-fork spellings
still reject at every level with guidance to brief. Concurrency-default proofs
remain in dispatch.test.ts. The old alias/cardinality tests have been replaced,
not retained as misleading current promises.

### Steering with delivery receipts (v3, #37, 2026-09-27)

New v3 contract — no v1 evidence; SPEC.md "Interaction grammar —
Steering" defines the surface. Pi 0.87 delivers steers at turn
boundaries only (`pi-agent-core` agent-loop.js drains the steering
queue at `turn_end` and at run start), so `steered` means queued on a
live run — never a mid-turn merge.

- **Contract:** `delegate_ticket steer` takes `message`, `steerId`, and
  optional `taskId` (defaults to the single running task; ambiguous
  omissions error naming the running ids). Receipts — `steered`,
  `activated`, `duplicate`, `not-applied` — ride the tool result text
  and `details.steer`. Reusing a `steerId` with the same message and
  target replays the original receipt verbatim; with a different
  message or target it is a conflict error. A parked steer whose task
  settles first voids to `not-applied`; recovered tickets refuse.
- **Covered now:** `tests/contract/steering.test.ts` — a steer on a
  live run receipts `steered` and lands exactly once in the child's
  provider-visible transcript on its next turn; a steer for a
  queued-behind-`maxConcurrent` task receipts `activated` and opens
  its first turn; duplicate replay returns the original text and
  `replayed` status; not-applied on settled tickets, unknown tickets,
  and unknown task ids (which lists the real ids); the ambiguous
  omission error names both running ids without consuming the
  `steerId`; message- and target-conflict errors; a parked steer
  voided by cancellation replays `not-applied` and the never-started
  child receives nothing. Continuation teaching on not-applied
  receipts (#57): a settled task that ran pooled teaches
  re-dispatch with its `sessionId` (named-task and terminal-ticket
  paths), a fresh task's durable transcript teaches `resumeFrom`,
  and a task that never ran keeps the plain text. Cold-recovered
  tickets refuse with `not-applied` in `tests/contract/recovery.test.ts`.

### Completion evidence — file attribution (v3, #38, 2026-09-27; git windows 2026-10-02)

SPEC v3 "Observability — Completion evidence" restores a lighter form of
v1's touched-file reporting: the union of observed write/edit call paths
(resolved against the task cwd, ordered, deduplicated) and the changes a
Git evidence window saw — a `HEAD`/`status`/`lstat` snapshot before the
task's first attempt and another after the last, plus
`git diff --name-only` across a moved `HEAD`. Never v1's physical
tracking (inode signatures, symlink canonicalization). Evidence, not
confinement: nothing reads it for admission, scheduling, or execution.
The git-diff carve-out in the original restoration was reversed by user
decision 2026-10-02 after live session `01a0fdba`, where every
bash-using worker had reported only `files: uncertain (bash)`.

- **Contract:** `files: a.ts, src/b.md` / `files: unknown (shell used
  outside git)` lines beside each task's claim in sync results,
  live/settled ticket views, and delivered wakes; a covered window that
  saw nothing shows no files line; `· may include concurrent edits by:
  <writers>` on windows that overlapped the parent's mutating calls
  (fact only) or same-root mutating siblings; `overlap: <path>` once per
  path two tasks attributed, naming both task ids — computed on
  write/edit observation plus Git windows with no named writers;
  `details.attributedFiles` (with optional `concurrentWriters`) on sync
  results and poll/wait; journal persistence via optional fields, so
  pre-attribution records parse unchanged; cancel previews carry no
  attribution.
- **Covered now:** `tests/contract/attribution.test.ts` — write and edit
  attribution, relative-path resolution against a task `cwd`, dedupe,
  out-of-root paths rendering absolute, the uncovered-shell mark without
  output parsing, combined write+shell evidence, the single named
  overlap line, ticket/wake/live-poll rendering,
  `details.attributedFiles`, cancel previews staying evidence-free,
  cold recovery of recorded attribution, and pre-attribution journal
  records parsing cleanly. Git windows (provenance: live session
  `01a0fdba`, 2026-10-02): bash-created files reported by path, a
  pre-dirty file reported only when the run rewrote it (its untouched
  pre-dirty sibling excluded), a no-change window showing no files
  line, committed paths via a moved `HEAD`, non-Git shells falling
  back to the unknown mark, a snapshot failure logging to stderr and
  degrading without failing the task, overlapping mutating tasks on
  one repository naming each other with no false overlap line, the
  parent named for a mutating call inside a window, a read-only task
  beside a writing sibling opening no window and reporting nothing,
  and sequential tasks on one repository not naming each other (the
  registry prunes closed windows that no open window could overlap).

### Ticket interrupt — abort the turn, keep the worker (v3, #42)

New v3 contract — no v1 evidence (v1 had only whole-ticket cancel);
SPEC.md "Interaction grammar — Interrupt" defines the surface. The
abort rides the same cooperative cancellation/quiescence machinery as
cancel, but settles the task `interrupted` — a first-class terminal
state, distinct from `cancelled` by resumability.

- **Contract:** `delegate_ticket interrupt` takes `ticket` and an
  optional `taskId` (defaults to the single still-running task;
  ambiguous omissions error naming the running ids). Receipts —
  `interrupted` / `not-applied` — ride the text and
  `details.interrupt`. A pooled-session task returns its session
  reusable; a fresh task keeps its persisted transcript and the
  `resumeFrom` hint. `not-applied` covers settled tickets, settled or
  already-interrupted tasks, unknown ids, and not-yet-running tasks.
  Dependents block naming the interruption; an all-interrupted batch
  settles the ticket `interrupted`; telemetry records the interrupted
  task outcome and call status.
- **Covered now:** `tests/contract/interrupt.test.ts` — fresh-task
  interrupt (interrupted status in the view, transcript path and
  `resumeFrom` hint once worker truth lands, never `cancelled`), the
  pooled-session round trip (interrupt → pool listing → a later task
  reuses the same conversation), the not-applied paths (unknown
  ticket, unknown task, settled ticket, queued task, ambiguous
  omission, already-interrupted retry), a dependent blocking with the
  interruption named, the #57 continuation hints (pooled task's
  `sessionId`, fresh transcript's `resumeFrom`), and the telemetry rows.
  The action is pinned in `tests/contract/tool-boundary.test.ts`.

### Shared batch brief (v3, #43)

New v3 contract — v1's task-level `context` (`fresh` /
`with-parent-transcript`, transcript sharing) is unrelated; its
removal error stands on task fields and on the trained enum values
even at top level.

- **Contract:** top-level `brief` prepends a `--- batch brief ---
  …--- end batch brief ---` preamble to every task's prompt (before
  its own prose; the dependent handoff still trails). `context` is a
  removed spelling, not a fold: its presence rejects at every level —
  top-level or inside a task, valued or null, beside a canonical
  `brief` or alone — with guidance toward `brief` for shared batch
  context. The sync result, async receipt, and ticket views name
  the brief once (~80-char head, `details.brief` carries it on
  dispatch results); the journal persists it for recovered views.
  A whitespace-only brief is absent.
- **Covered now:** `tests/contract/brief.test.ts` — every child's
  provider-visible first message carries the fenced brief before its
  prompt (both tasks of a batch), the once-in-the-header rule, the
  async receipt + recovered-ticket header, `context` rejection beside
  a canonical `brief` (valued and null, before any execution),
  absent-brief behavior, and the brief→prompt→handoff ordering on a
  dependent. Task-level, flat, and stringified `context` rejection
  live in `tests/contract/dispatch.test.ts`; its misfire-telemetry
  rows in `tests/contract/telemetry.test.ts`. Schema pin in
  `tests/contract/tool-boundary.test.ts`.

### Canonical boundary long tail (#44, updated by #61)

reflex-tail.test.ts rejects agent_type/task_name/task message and timeout_ms,
including agreeing canonical fields, flat/stringified shapes and null. It
retains bare-message steer guidance, canonical ticket message, reasoning_effort
rejection and derived/explicit steering retry-key behavior.

### No nested dispatch + profile precedence (v3, #45)

New v3 contract — no v1 evidence; SPEC.md "Surface rules — No nesting"
and "Canonical surface — Exact agent names" define it.

- **Contract:** `delegate`, `delegate_ticket`, and `delegate_session`
  are stripped — silently — from every inventory a child can be given:
  explicit task `tools`, Markdown-profile frontmatter `tools`, and the
  mirrored parent set (excluded by construction). A discovered profile
  resolves by its exact name, so an authored
  `general.md` resolves to that profile with no expansion note;
  built-ins still win same-named collisions, and the unknown-agent
  error lists exact built-in and authored names without alias annotations.
- **Covered now:** `tests/contract/no-nesting.test.ts` — the explicit
  `tools` strip, the inline `*`-group child, the mirrored-parent strip
  (parent inventory carries all three delegate tools), the profile
  frontmatter strip, the `general.md` claim (profile prompt and `ro`
  tools run; no `agent "general" →` note), and the claimed-alias
  listing in the unknown-agent error.

### Pooled-session residency (v3, #46)

New v3 contract — v1 kept every pooled session resident for the
parent's lifetime; v3 bounds idle residency while preserving the
reuse contract (the transcript file was always the resume authority).

- **Contract:** `sessions.maxIdle` (default 4) bounds idle pooled
  sessions held in memory; over the bound the least-recently-idle
  session unloads to its transcript, and the next task naming its
  `sessionId` transparently reloads it with the conversation intact.
  A checked-out session is never evicted, and it joins the idle set
  only when it settles — the LRU victim is the older idle session.
  `maxIdle: 0` unloads every settled session. `delegate_session list`
  marks unloaded records and `close` removes them the same as live
  ones. The frozen-config invariant still rejects an incompatible
  reuse after unload.
- **Covered now:** `tests/contract/session-residency.test.ts` —
  over-bound eviction to disk and transparent reload with history
  preserved, incompatible-config rejection after reload, a checked-out
  session surviving the bound while the older idle session evicts,
  `list`/`close` over unloaded records, and `maxIdle: 0`.

### Batch token budget (v3, #47)

New v3 contract — no v1 analog (the `rollout_budget` analog the issue
names); SPEC.md "Interaction grammar — Batch token budget" defines it.

- **Contract:** top-level `tokenBudget` (positive integer, off by
  default) is a shared ceiling on the batch's recorded usage. Settled
  tasks charge `usage.totalTokens` to it; once the total reaches the
  limit, still-queued tasks settle `budget-exhausted` without
  consuming a slot, worker, or session — checked before dependency and
  semaphore waits and again at the start boundary. Running tasks are
  never hard-aborted and finish normally. Dependents of an exhausted
  task block with a reason naming the budget. Result and ticket
  headers report `token budget: consumed/limit`, `details.tokenBudget`
  carries `{limit, consumed, exhaustedAt}` on dispatch results and
  poll/wait, the ticket journal persists it for recovered views, the
  dispatch's telemetry row records it (schema v6), and the value joins
  the `operationId` request fingerprint. Non-integer, non-positive,
  and string values reject naming the field.
- **Covered now:** `tests/contract/token-budget.test.ts` — queued
  tasks settle `budget-exhausted` without a provider call, an
  in-flight task finishes after exhaustion, a dependent of an
  exhausted task blocks naming it, the telemetry call/task rows, the
  validation rejections, the unchanged default, and the fingerprint
  conflict.

### Event-sensitive ticket waits (v3, #48)

Extends "Async tickets" — SPEC.md "Waiting is explicit and detachable".
A parked `delegate_ticket wait` resolves on any ticket activity worth a
turn, not only settlement; `timeoutMs` still detaches the waiter only.

- **Contract:** the wait wakes on settlement (complete settled view), a
  worker-question arrival (the result carries the pending question —
  ticket id, task id, question text, the `answer` invocation — inline;
  the parent's separate question-wake turn still fires), and a task
  newly settling `interrupted` (the result names the task and reports
  the ticket still running). Activity already on record when the wait
  begins is stale news — the view shows it but a fresh wait keeps
  waiting; a timeout detaches only that waiter.
- **Covered now:** `tests/contract/tickets.test.ts` — the question wake
  carrying the full notice plus the `Wait detached` hint, the interrupt
  wake naming the task while the ticket keeps running (the interrupt
  fires through the registered `delegate_ticket` tool directly — the
  harness serializes parent turns, so a parked wait can never see a
  second turn's tool call), and a wait entered after an interruption
  parking for the next event and timing out cleanly. The separate
  question-wake turn stays covered in
  `tests/contract/questions.test.ts`.

### Verifier profile — verdict evidence (v3, #49)

New v3 contract — no v1 analog; SPEC.md "Observability — Completion
evidence — verifier verdict" defines the layer.

- **Contract:** built-in `verifier` profile — the reviewer's
  `read` + `bash` toolset under a prompt demanding a final
  machine-parseable `VERDICT: PASS|FAIL|AMBIGUOUS` line (an optional
  parenthetical count allowed); no alias maps onto it. Only tasks run
  under the profile are parsed: the final output's last well-formed
  `VERDICT:` line (case-sensitive marker, whitespace-tolerant; none
  found → nothing reported) lands on the outcome beside its
  `attributedFiles`, renders as a `verdict:` line in sync results,
  delivered wakes, and ticket views, and rides `details.verdict` as
  `{verdict, taskId}`. A `FAIL` with zero attributed files reports
  `claim not corroborated by any observed file change`; a `PASS` with
  zero attribution reports `unverifiable`. Reporting only — never
  admission or gating; non-verifier tasks are untouched.
- **Covered now:** `tests/contract/verdict.test.ts` — PASS/FAIL/
  AMBIGUOUS parsing and rendering, the last-line-wins and
  malformed-tail rules, whitespace tolerance, parenthetical counts,
  case sensitivity, absent-verdict silence, the zero-attribution notes,
  `details.verdict` on sync dispatch and poll/wait, the delivered-wake
  message carrying verdict in text and details, ticket-view rendering,
  and non-verifier isolation in mixed batches.

### Result-details stabilization and admission/manual disclosure (v3, #51)

New v3 contract — no v1 analog. The Pi `ToolDefinition` seam carries no
result/details schema slot (`parameters` is the only TypeBox surface), so
`src/details.ts` exports internal TypeBox schemas that describe the
emitted details as-built; the producing literals satisfy the `Static`
types at compile time, and the contract tests `Check` real dispatches
against them.

- **Contract:** every machine-readable details surface has a pinned
  shape — the sync/async dispatch envelopes (`tasks`, `results`,
  `attributedFiles`, `verdict`, `brief`, `tokenBudget`,
  `usageLowerBound`, `notices`), the ticket RPC envelope (plus
  `details.steer`/`details.interrupt` receipts and `details.questions`),
  the session RPC envelope, the delivered `delegate-result` message
  (single- and multi-ticket shapes), and the `delegate-question`
  notification. A cross-call write-overlap rejection names live capacity
  — running tasks against `maxConcurrent` — and every held write claim
  (task + owner). The manual's discovered-profile listing names each
  profile's delegate.json pin (`model[:effort]` + its config origin);
  unpinned profiles render unchanged.
- **Covered now:** `tests/contract/details.test.ts` — `Check` against
  the exported schemas on a real help call, sync dispatch (brief,
  tokenBudget, write attribution, verifier verdict,
  uncovered-shell uncertainty), async dispatch + poll/wait + delivered wake, steer
  and interrupt receipts, a worker-question notification, a session
  list, and a quarantined-outcome `usageLowerBound`. The capacity
  sentence lives in `tests/contract/workspaces.test.ts` (held claim
  names task id and owner ticket). The pin disclosure lives in
  `tests/contract/profiles.test.ts` (unscoped + parent-scoped pins,
  unpinned profile unchanged).

### Ticket output tails (v3, #52)

New v3 contract — no v1 analog. `delegate_ticket` action `tail` returns
`{text, nextOffset, done, taskState}` — an incremental read of one
task's clean assistant output. File-backed runs (shared workspace,
`sessionId`, `resumeFrom`) are read from the durable `.jsonl`
transcript between a per-attempt byte baseline and EOF — pooled and
resumed transcripts never leak earlier conversations — while
scratch/in-memory runs read the activity store's captured
`assistantTail`; a recorded outcome is the last fallback once both are
gone. `offset` is a clamped char cursor into the extracted text,
`waitMs` bounds a park that resolves early on new output or
settlement, and each call's `text` is capped at the ticket's
`spillTailChars` (no spill file on a running read).

- **Covered now:** `tests/contract/tail.test.ts` — growing transcript
  text with advancing offsets across a file-backed task's life,
  settled-task `done`+state with the full stream, `waitMs` early
  resolve on fresh output (task still `running`, proving output — not
  settlement — woke it) and timeout at the bound on a silent stream,
  out-of-range offset clamping, scratch/in-memory reads from captured
  activity text, per-call bound paging, and the targeting/field rules
  (ambiguous and unknown taskIds name the ticket's tasks, `offset`/
  `waitMs` reject on non-tail actions). `details.tail` is pinned by
  `Check` against `tailDetailsSchema` on every call. The published
  schema gains the action and fields in `tool-boundary.test.ts`.

### Canonical task addresses (v3, #53)

New v3 contract — no v1 analog. Anywhere `taskId` is accepted
(`steer`/`answer`/`interrupt`/`tail`), the compound
`"<ticketId>#<taskId>"` resolves the task AND its ticket — the separate
`ticket` field is then optional. A disagreeing `ticket` + compound pair
conflicts naming both; a compound with an empty half is malformed;
unknown ticket parts name the live tickets and unknown task parts name
the ticket's tasks as compound addresses. `#` is schema-impossible in
dispatched task ids, so `#` in `taskId` is always the separator — plain
forms are untouched. Receipts, wakes, question notices, the roster's
waiting lines, unknown-task lists, and settled task-section heads all
render the compound so the parent can copy it verbatim.

- **Covered now:** `tests/contract/addressing.test.ts` — steer,
  interrupt, and tail resolving compounds with the ticket field omitted
  (receipt details still decompose ticket/taskId); answer resolving the
  compound while the question wake and poll notice render it verbatim;
  the settled view (the delivered wake's content) carrying
  `### Task <id> — <status> · <ticket>#<id>`; unknown ticket/task
  components naming the available names; disagreeing and malformed
  compounds rejecting; and the plain two-field form unchanged.

### Owner-liveness startup recovery (v3, #54)

New v3 contract — no v1 analog (v1's restart recovery blanket-interrupted
every `running` journal row; a second host could kill a live sibling's
work). Dispatch journals the owning host `{pid, bootId, sessionId}`; a
later startup's scan settles a `running` record `interrupted` — reason
"owning session ended before settlement" on every unfinished outcome and
one ticket notice — exactly once, journal-durable before any view
reports it. Owner is provably dead when the recorded boot id differs from
this boot's or the pid no longer exists; a missing owner (pre-tracking
records), an absent boot id (Windows fallback — pid evidence only), and a
live pid all leave the record untouched. Recovery never restarts work;
the never-resume invariant is unchanged.

- **Covered now:** `tests/contract/owner-liveness.test.ts` — the journaled
  owner identity at dispatch; a dead-pid owner interrupted at startup
  with the reason, durable in the journal and idempotent across a second
  startup; a live-owner ticket left `running`; a cross-boot owner treated
  as dead while its pid lives; the no-boot-id fallback judged on pid
  liveness alone; settled records never reopened; and ownerless records
  left alone. `tests/contract/recovery.test.ts` models cold starts by
  orphaning the journaled owner pid — a same-process second boundary is
  a live sibling under #54, not a restart.
- **Session-scoped roster (#64):** `owner-liveness.test.ts` proves the bare
  poll roster and unknown-ticket hints list only records whose owner
  sessionId is the calling session's — a sibling-owned and an ownerless
  record hide behind the trailing "from other sessions" count, this
  session's own ticket lists, and explicit-id poll still reads a hidden
  ticket (settled records stay pollable per SPEC axiom 2).

### Wait-any (v3, #58)

Extends "Event-sensitive ticket waits" — SPEC.md "Waiting is explicit
and detachable". `delegate_ticket wait` accepts `tickets: [ids]`
alongside the singular `ticket`: the call parks across the list and
resolves on the first ticket to settle, the watcher's `Promise.any`.

- **Contract:** the resolved call leads with the settling ticket's view
  and appends a one-line roster of the watched tickets still running;
  the same parked-wait wakes (a pending question, a newly interrupted
  task) apply per watched ticket, and the same detach-only timeout
  governs the whole call — a timeout with nothing settled reports so
  and lists every watched ticket, all left running. `ticket` and
  `tickets` name the same target under two spellings: a one-id list —
  or one agreeing with `ticket` — folds into the single-ticket wait;
  divergence is a validation error naming both spellings and both
  values. `tickets` on a non-wait action is a belongs error; unknown
  ids fail the call like the singular unknown. A watch list whose
  tickets can all never produce activity here (recovered records owned
  by another session) returns unhearable at once instead of parking
  out the timeout.
- **Covered now:** `tests/contract/tickets.test.ts` — first-settlement
  resolution showing the settler's view plus the running roster (watch
  order is not outcome order; `details.ticket` names the settler), the
  none-settled timeout leaving every ticket running, and the
  validation matrix: disagreement naming both fields, `ticket` +
  one-id agreement folding to the untouched single-ticket path,
  unknown-list ids erroring, `tickets` rejected outside `wait`, and a
  bare wait teaching both spellings. The ticket-owned misroute and
  wait-example inference for `tickets` stranded on `delegate` or
  `delegate_session` are pinned in
  `tests/contract/input-normalization.test.ts`.

## First tranche

| V1 evidence | Class | V2 treatment |
| --- | --- | --- |
| `delegate.test.ts`: extension registration and parameter surface | Contract | Rewritten in `tests/contract/tool-boundary.test.ts` |
| `delegate.test.ts`: empty-call help mode | Contract | Rewritten in `tests/contract/tool-boundary.test.ts`; asserts meaning, not exact manual copy |
| `schema.test.ts`: stringified tasks, flat fields, and string tools | Regression | Rewritten in `tests/regression/input-recovery.test.ts` through Pi's full registered-tool execution path |
| `schema.test.ts`: empty agent becomes inline | Regression | Deferred until agent resolution makes the effective profile observable |
| `schema.test.ts`: ticket/session intent must not become a task | Regression | Rewritten in `tests/regression/input-recovery.test.ts` |
| `schema.test.ts`: direct calls to normalizer/validator helpers | Internal | Not ported |
| `delegate.test.ts`: exact description lengths and wording | Internal | Not ported |
| `delegate.test.ts`: barrel exports and helper behavior | Internal | Not ported |
| `schema.test.ts`: orphaned ticket fields and async-without-tasks | Contract | Rewritten in `tests/contract/tool-boundary.test.ts` |

## Second tranche

| V1 evidence | Class | V2 treatment |
| --- | --- | --- |
| `schema.test.ts`/`delegate.test.ts`: enum, control-field, and id rejection | Contract | Live tests in `tests/contract/validation.test.ts` |
| `schema.test.ts`/`task-resolution.test.ts`: semantic validation (duplicates, removed deadline fields, workspace conflicts, mode mixing, unknown agent, required fields) | Contract | Pending tests in `tests/contract/validation.test.ts` |
| `lifecycle.test.ts`/`dispatch.test.ts`: ordered sync results, sibling failure isolation, task-id echo, usage, async ticket return, concurrency bound | Contract | Pending tests in `tests/contract/dispatch.test.ts` |
| `delegate.test.ts`/`pause.test.ts` ticket integration: roster, not-found, wait, timeout detach, cancel preview/force, retained results, pause/resume | Contract + Regression | Pending tests in `tests/contract/tickets.test.ts` |
| `lifecycle.test.ts` pool/session tests: pooling, list, close, frozen config, `resumeFrom` errors, busy conflicts | Contract + Regression | Live tests in `tests/contract/sessions.test.ts` |
| `dispatch.test.ts`/`shared-write-safety.test.ts`/`workspace.test.ts`/`isolated-workspace.test.ts`: writer serialization, cross-call rejection, shared/isolated rejection, scratch discard, ordered apply, conflict retention | Contract + Regression | `tests/contract/workspaces.test.ts` (live) |
| `lifecycle.test.ts` retry matrix and `dispatch.test.ts` serialized-successor | Regression | Pending tests in `tests/regression/failure-propagation.test.ts` |
| All helper/private-state/rendering/internals tests (see per-subsystem "Internal" rows) | Internal | Not ported |

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
  `shared` serializes overlapping same-repo writers in task order;
  `isolated` runs independent edits in parallel and merges in order.
- Admission exposes `serialized` groups on the grant; results prepend a
  notice naming the serialized tasks and scope with the isolated remedy
  (sync: live `onUpdate` frame plus the final result; async: ticket
  creation text and poll/wait views).

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

## 2026-09-26 — composed child base prompt (issue #33)

New live tests in `tests/contract/child-prompt.test.ts` (v1 evidence:
`agents.ts` `buildSubagentSystemPrompt` / `sanitizeParentToolInventory`,
redesigned per user decision — see V1-V2-MAP 3a): an inline child inherits
the parent's custom persona and receives the fixed subagent framing; a
stock parent still frames the child; built-in role lines (explore, coder)
compose *under* the parent persona rather than beating it (deliberate
divergence from v1 precedence, recorded in COMPATIBILITY); an explicit
task `systemPrompt` and a Markdown profile body are verbatim with no
framing; extension-contributed guidelines/sections (injected by a leading
fault extension mutating `before_agent_start` prompt options) are never
inherited; a force-replaced parent prompt skips inheritance with one
logged warning. All assertions observe the child's provider-facing system
message (content + sections). The harness parent's custom persona comes
from `openDelegateBoundary({ systemPrompt })` (forwarded to
`createTestSession`); prompt-channel fault injection lives in
`tests/support/prompt-extension-content-fault.ts` and
`tests/support/forced-prompt-fault.ts`.

## Next contract slices

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

Remaining:

1. Usage properties.
2. The per-subsystem **Gap** entries above.

Each slice should add only the public test driver capabilities it needs. Tests
must not introduce public exports solely to reach private v2 state.

## 2026-09-29 — provider-scoped extensions (issue #59) and usage events (issue #60)

New contract suite `tests/contract/provider-extensions.test.ts` (v1
evidence: `config.ts:455-480` shipped `openai-codex` →
`npm:@bermudi/pi-codex` default; `config.test.ts:63-275` provenance —
user-listed sources required, shipped defaults best-effort, empty arrays
ignored, exact re-list of the default required; `delegate.test.ts:594`
`web_search` in the child's tool inventory). Live coverage: malformed
`providerExtensions` shapes fail loudly naming the key (a v2 divergence
from v1's silent drops, per the file's fail-loud config stance); a
missing required source fails the whole dispatch before any child
starts; the shipped default degrades silently when uninstalled;
re-listing the default makes it required; an empty array neither errors
nor disables the default; other providers stay untouched; explicit
`web_search` rejects without an allowlist and a user-configured local
extension loads into the child — its `web_search` executes (marker
file). Non-inheritance is pinned twice: without an allowlist the
mirrored `web_search` is stripped (no marker), and with one the child
executes its own copy, distinguishable from the parent's registry
entry. A required root that fails to load fails the whole dispatch
before any child starts — a resolved sibling on another provider never
runs, and the rejection is a config error, not an `internal dispatch
error` — and a `providerExtensions` change invalidates a pooled
session's frozen configuration. Same file's `delegate:usage` block (#60): task
settlement emits provider/model/token payload on `pi.events`,
same-window settlements throttle to one emission, a settlement after
the 30s window emits again, and a ticketed batch carries both
`ticketId` and `taskId`. Fixtures: `tests/fixtures/web-search-ext/`
(child-side extension, marker on execute), `parent-web-search-ext/`
(parent-side, distinguishable marker), `broken-ext/` (module-eval
throw for the load-failure path); the `pi.events` listener test seam
is `tests/support/usage-listener.ts` loaded via `leadingExtensions`.

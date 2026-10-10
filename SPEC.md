# SPEC v3 — contract layer on the v2 engine

Status: **ratified 2026-09-27** by the v3 owner — stewardship delegated
by bermudi ("you're gonna own this. v3 is now your baby"). This
document is the sole behavioral authority; `SPEC-V2.md` is the
engine-as-built contract it inherits. Nothing here requires a new
codebase: v3 is a contract layer on the same engine (#34).

Origin: the 2026-09-27 comparison against the six professional harnesses
(`~/build/testing/subagents`; letta, MiMo-Code, codex, fx, deepseek,
minimax) and the misfire transcript that started it. Every decision
below is traced to that evidence.

---

## Task deadlines removed (#118, user-approved)

The user's explicit decision, “cut deadline,” overrides SPEC-V2's
`deadlineMs` dispatch field, execution/retry wall-clock budgets, and deadline
rules during resource loading, pause, questions, and pooled-session settlement.
Tasks have no wall-clock deadline. Supplied `deadlineMs` rejects the entire call
before execution in compact and full mode, including null, flat, and
stringified-task recovery shapes; it is not silently discarded. Historical
saved deadline failures remain readable, but cannot authorize new calls.

Inactivity/stall detection, cooperative abort and confirmed quiescence,
reservations and quarantine, paused/question-waiting worker safety, detachable
bounded ticket waits, and shutdown bounds remain unchanged. This removes
only task deadlines, not unrelated internal timer bounds or batch token budgets.

## Operational diagnostics (#122, user-authorized)

Delegate diagnostics never write to an attached terminal: routing depends only
on actual `process.stderr.isTTY`, not `ctx.hasUI`, print mode, or the working
configuration/session directory. False or undefined means stderr for every
level (`error`, `warn`, `info`), never diagnostic stdout. True means owner-only,
append-only JSONL at `<DELEGATE_AGENT_DIR>/delegate-diagnostics/<pid>.jsonl`
when the explicit environment override is nonempty; otherwise the base is Pi's
public `getAgentDir()`. This destination is independent of the engine's
context/session/cwd fallback. It explicitly overrides SPEC-V2's stderr logging
promise, including consumed-result delivery skips.

The diagnostic directory is 0700 and the regular, single-link file 0600,
owned by the current user. Symlinks, insecure existing entries, foreign-owned
bases, and writable/untrusted ancestors are rejected (root-owned sticky
temporary ancestors are allowed). A failed primary destination routes to
`<tmpdir>/pi-delegate-diagnostics-<uid>-<pid>/<pid>.jsonl` with the same privacy
checks and safe primary-failure operation/path/class/code context. The fallback
is deterministic per process and has no cached state or persistent handle.
It never falls back to the terminal. Diagnostics MUST NOT control execution,
state mutations, admission release, cancellation, quiescence, cleanup, recovery,
or surface selection, even if both destinations fail. An extension-owned,
nonthrowing sink retains a bounded failure count and safe routing context
(event, primary destination/operation and primary/fallback class/code), reports
through Pi-managed UI notices when available, and adds a warning to the next
public tool result's content and per-return `details.diagnosticWarning`. This
metadata is cloned, preserving the original typed fields without mutating cached
operation/ticket results. All three tool renderers show it collapsed and expanded,
including recorded-history views with no live store. A repaired operation replay
must not retain an earlier return's warning. Notice failures remain explicitly visible in that warning;
they never recurse into the unavailable logger. Original tool errors stand.
A standalone dormant worker supervisor reports diagnostic failures on its exit
result without changing its worker exit classification.

Directory components exactly named `delegate-diagnostics` or
`pi-delegate-diagnostics-<numeric uid>-<numeric pid>` are reserved runtime
namespaces anywhere in a source tree, including retained other-process fallback
trees. They and existing symlink aliases are excluded before scratch copying,
from every private Git snapshot (including seeded tracked entries, before any
new blobs are written), and from source-drift/completion-attribution evidence.
A runtime tree created by another process during snapshot preparation must not
be hashed into the source Git object database. Actual diagnostic destinations are
also excluded when not yet created; exclusion never depends only on the engine's
agent directory. Other ordinary source names (for example `delegate-diagnostics.md`
and `pi-delegate-diagnostics-guide`) remain source. Delegate does not scrub
historical objects already present in the user's Git database.

Secure descriptor-relative file routing is currently supported only on Linux
with getuid, O_NOFOLLOW, and O_DIRECTORY. Other platforms/capability gaps are
reported as unsupported through the same managed warning path, without crashing
Delegate or writing to an attached terminal. Foreign filesystem behavior is
unverified; headless stderr routing remains available on every platform.

Records carry a timestamp, pid, level, static operational event, and bounded
operational metadata (at most 16 fields, strings at most 512 characters; event
at most 192). JSON escapes terminal controls and additional line separators.
Error diagnostics contain only allowlisted class/code (including codes found
through at most four Error.cause links, without invoking accessors), never raw messages,
stacks, provider payloads, or prompt/profile/question/answer/steer contents.
Caller-facing tool errors are unchanged. Manual profile discovery retains its
intentional silent warning sink. Framed worker stdout remains protocol-only.
No interception of global console, mutable global state, new configuration
knobs, or persistent file handles are introduced.

## Axioms

1. **The weights are the platform.** Models arrive RL-trained on the
   incumbent harnesses' idioms (Claude Code's blocking single `Task`,
   codex/grok/letta/minimax fire-and-forget fan-outs). Delegate has no
   RL flywheel and cannot retrain them. The surface meets trained
   reflexes: converge where the idiom is arbitrary, differentiate only
   where the difference is the product, teach every delta at the
   boundary; the user-approved canonical surface below supersedes automatic
   cross-harness aliases without changing the execution engine.

2. **Records survive supervisors.** The supervision of record outlives
   any session: settled outcomes are durable and cold-recoverable,
   running snapshots report `interrupted` honestly — and name the
   worker's journaled transcript when one was claimed before the crash
   (#123), so the same `resumeFrom` continuation a live interrupt
   offers is available to a deliberate re-dispatch — delivery is
   at-most-once — a suppressed or failed wake-up never undoes settlement,
   and settled results remain pollable. The parent agent is a fallible
   client above a dispatch service, not the ledger.

3. **Admission is the one coordination layer an extension owns.** No
   sandbox, no process boundary, no permission system — an extension
   owns ordering and write scope. Read-only intent is structural (tool
   set), not behavioral (prompt), and buys full concurrency. There is
   no bypass and never will be.

## Interaction grammar (the loop)

The trained loop is: dispatch returns immediately, the parent keeps
working, results arrive as wake-up turns with payload in-context, and
mid-flight the parent can steer. The grammar:

- **Stable background default (#61, user-approved 2026-09-29; surface split
  removed by ADR 0002).** Every
  nonempty dispatch runs async unless the caller passes `async: false`.
  Task count never changes execution mode. The explicit sync override returns
  inline results; async tickets still auto-deliver settled results.
- **No timers.** Parking budgets are rejected: the pros don't decide
  them because their grammar has no long-blocking dispatch to convert
  (#28 superseded). Waits are unbounded (#130 verdict 7) — a parked
  wait ends on settlement or on ticket activity worth a turn, never on
  a caller clock.
- **Waiting is explicit and unbounded.** `delegate_ticket wait` parks
  until the ticket settles. A parked wait also wakes on ticket activity
  worth a turn (#48): settlement returns the complete settled view; a
  worker-question arrival carries the question notice inline (ticket
  id, task id, question text, answer invocation) — the separate
  question-wake turn still delivers to the parent independently; a
  task newly settling `interrupted` carries the interrupted notice
  naming the task. Events already on record when a wait begins are
  stale news — view-visible, not a wake. (Engine behavior already;
  promoted to grammar.) Waiting on several tickets means waiting on
  each or polling the roster — the wait-any watch list (#58) was
  removed with the timeout (#130 verdict 7): with delivery waking the
  parent on settlement, a caller-side multiplexer had no work left.
- **Fan-out shape.** Batches in one call, taught at the boundary.
  N parallel single-task dispatches — the trained fan-out reflex — must
  work for read-only tasks (they hold no write claims); for overlapping
  writers they reject before execution with teaching, never serialize
  across calls.
- **Steering.** Steering is a message with a delivery receipt,
  idempotent on retry — never polling. Outcome vocabulary adopted
  from the field: `queued` / `applied` / `not-applied` (fx) and
  `activated` / `steered` / `duplicate` (minimax). The `interrupt`
  action diverges from codex's same-named verb by lifecycle position:
  codex interrupt is a non-final status on a persistent, re-taskable
  agent; v3 interrupt settles the task `interrupted` — terminal for
  the task, with the continuation path named (pooled session returned
  reusable, transcript resumable). Codex-trained callers expecting
  interrupt-then-message should steer or re-dispatch instead.

  `delegate_ticket steer` carries `message` and an optional `taskId`
  (default: the single still-running task; an ambiguous omission errors
  naming the running ids). Every steer receipts under a key derived
  from its own call (#44/#130 — `steer:<toolCallId>`; the caller key
  field is removed): a transport-level retry of the same tool call
  replays the stored receipt instead of re-injecting. Pi delivers
  steers at turn boundaries — never mid-turn — so the receipts map:
  `steered` = queued on the live child run, observed as a user
  message at its next turn boundary; `activated` = no turn in flight
  (queued, preparing, between attempts), the parked message opens the
  task's next turn; `duplicate` = the same call replayed — the
  original receipt replays verbatim, nothing re-injects;
  `not-applied` = the target settled, is unknown, or is a recovered
  ticket, with teaching toward poll — and toward continuation when
  the settled task is identifiable (#57): a pooled session still live
  teaches re-dispatch with its `sessionId`, a fresh task's durable
  transcript teaches `resumeFrom`, and a task with neither keeps the
  plain text. A parked steer whose task settles before delivery
  voids to `not-applied` on retry — nothing delivers into a dead
  session. When a transient failure retries the whole task, the task
  has not settled: steers the failed attempt already injected —
  drained parked messages and live steers alike — are re-supplied
  through the next attempt's drain, so a receipted message survives
  the session that died with it.
- **Interrupt.** `delegate_ticket interrupt` (ticket, optional
  `taskId` defaulting like steer) cooperatively aborts the task's
  in-flight turn through the cancellation machinery — the same
  quiescence gate, write reservations held until the worker
  confirms it stopped — but settles the task `interrupted`, not
  `cancelled` (#42, the codex interrupt_agent primitive). The
  distinction is resumability: a pooled-session task returns its
  session to the pool reusable; a fresh task keeps its persisted
  transcript and the resume hint. `interrupted` is a first-class
  terminal state in views, telemetry, and the journal; dependents
  treat it as not-succeeded and block naming the interruption.
  Receipts ride the steer vocabulary — `interrupted` when the
  abort lands on a live turn, `not-applied` on a settled,
  interrupted-already, unknown, ambiguous, or not-yet-running
  target. A whole ticket whose tasks all settle interrupted
  settles `interrupted`.
- **Batch brief.** A top-level `brief` is shared batch context
  (#43): prepended to every task's prompt as a delimited
  `--- batch brief ---` preamble — before the task's own prose,
  with the dependent handoff appendix still trailing — never
  merged into the prompt's text. The result and ticket headers
  name it once (~80-char head); task sections never repeat it,
  and `details.brief` carries it on dispatch results. The brief
  persists on the ticket record so a recovered view still names
  it. A whitespace-only brief is absent; `prompt` stays required
  per task.
- **Batch token budget — removed (#129, owner ruling 2026-10-07).** The
  caller-controlled `tokenBudget` field and its machinery are gone;
  the concept dies entirely. A model-set spend ceiling is the party
  being protected arming its own guard — 0 of 2,001 production
  dispatches ever set one, and the field was unreachable on the
  operator's install. Supplied `tokenBudget` rejects with teaching
  before any task starts (deadlineMs/#118 pattern: every shape, even
  null, flat, or stringified). Nothing generates `budget-exhausted`
  anymore; the status literal and journal-record field remain readable
  so pre-removal settled records keep their honest state (axiom 2),
  and historical telemetry columns stay queryable. If a cost ceiling
  is ever wanted again it is operator-side config, a fresh unit from
  real requirements — never a caller field.
- **Wake delivery.** Settled results inject as steering wakes,
  leaf-aware: a busy parent merges one at its next turn boundary
  (after the current turn's tool calls, before the next model call),
  an idle parent starts a new turn; simultaneous settlements batch
  into one wake. A `wait` or `poll` that already returned the same
  terminal view consumes the wake — the result is not delivered
  again (live session 01a0fdba, 2026-10-02).

## Canonical surface (#61, user-approved 2026-09-29)

- **One spelling per field.** Canonical dispatch fields are `tasks`,
  `async`, `workspace`, and `brief` (`tokenBudget` and `operationId`
  were canonical until #129/#130 removed them — their rejections are
  taught at the boundary). Task fields retain their canonical names. Cross-harness
  synonyms (`subagent_type`, `agent_type`, `task_name`, task `message`,
  `run_in_background`, top-level `context`, `timeout_ms`) reject
  before any execution, even when null or supplied beside a canonical field.
  Errors name the canonical replacement; no synonym is silently ignored.
  A supplied malformed non-array `tasks` value rejects before flat recovery;
  it must never be discarded in favor of adjacent flat task fields.
- **Prompt size bound (#121).** Each task `prompt` and the shared
  `brief` accept at most 32,768 characters. Oversized values reject
  at validation — before any task starts, identically on both
  surfaces and for async and inline — with a teaching error naming
  the field, the offending task, the limit, and the supplied count,
  pointing at the remedy: reference files by path instead of inlining
  contents. The bound is a constant, not a knob, and its diagnostics
  carry counts, never content.
- **Exact agent names.** Built-ins and discovered profiles resolve only by
  their exact, case-sensitive names. No automatic agent-name translations.
  User-authored profiles named `general` or `scout` remain valid exact
  definitions. Unknown names list the available names.
- **Profiles own capability and base prompts (#130 verdict 5).** Markdown
  profile `tools` frontmatter and body are the only per-task capability
  and base-instruction selectors; the task-level `tools` and
  `systemPrompt` overrides are removed (presence rejects with
  teaching). The default profile mirrors the parent's active tools;
  built-in profiles carry fixed toolsets. Operator configuration, model
  inheritance, admission, and all safety invariants are unchanged.
- **One surface (ADR 0002, 2026-10-07).** There is one advertised schema.
  The former operator `surface` split (compact default, full opt-in via
  delegate.json and /reload) is removed: the mode wall made every
  advanced field structurally unreachable (zero production dispatches
  could express one; the session pool was write-only; #123/#124
  recovery hints were muted behind a /reload that cancels active
  workers). A supplied `"surface"` key in delegate.json rejects at
  config load with that teaching. The advertised schema AND the
  accepted arguments are the single schema; nothing hidden executes
  through recovery normalization. Dispatch advertises `tasks`, `async`,
  `workspace`, and `brief`; each task has `prompt`, `agent`, `cwd`,
  `workspace`, `id`,
  `sessionId`, `resumeFrom`, and `dependsOn`;
  ticket actions are poll, wait, cancel, answer, steer, and
  interrupt. (Field set as of the ADR 0002 unification; prune
  verdicts in #130 remove fields in their own changes — `tokenBudget`
  (#129), `operationId`, `pause`/`resume`, `tail` with `offset`/
  `waitMs`, the wait bound `timeoutMs` with wait-any `tickets`, the
  caller steer key `steerId`, the task display label
  `description`, and the task `tools`/`systemPrompt` overrides
  are already gone.) Session
  list/close unchanged. The manual is
  single-edition: it documents exactly what the schema accepts.
- **Labels are derived, not supplied.** Call rows and result headers
  label tasks by id, falling back to the agent name and `inline`;
  the optional `description` label was removed with the rest of the
  #130 prunes — an id set for correlation doubles as the label.
- **Conversation and model boundaries remain closed.** Parent history is
  never shared. `context` and foreign history-fork fields reject with
  guidance toward `brief`; model/effort selectors remain forbidden.

## Surface rules

- **Boundary teaching.** Every contract that diverges from the
  incumbent default is legible in the tool description — it is the only
  channel that reaches trained weights. (Landed 2026-09-27: read-only
  concurrency, batch-in-one-call.) Landed 2026-09-29: when-to-delegate,
  answer-shape, and parallel-reads/serial-writes guidance.
- **No model-facing knobs for machinery.** Internal tuning lives in
  `delegate.json`, not the schema. The schema stays reflex-shaped.
- **Concurrency default.** `maxConcurrent` defaults to 8 (#41): the
  field survey found letta/grok/oh-my-pi default 32 and
  minimax/deepseek/MiMo/fx uncapped — 3 taxed ordinary fan-outs. The
  `concurrency.models`/`providers` maps remain the rate-limit guard
  for providers that need one.
- **No nesting.** Children never receive the delegate family —
  `delegate`, `delegate_ticket`, and `delegate_session` are stripped,
  silently, from every toolset a subagent can be given (#45): a
  profile's frontmatter `tools` and the mirrored parent inventory
  alike (the mirror excludes them by construction).
  This matches the largest training surface (Claude Code subagents
  lack Task) and avoids recursion admission and depth accounting
  entirely. `ask_parent` is unaffected.
- **Resident idle bound.** Idle pooled sessions held in memory are
  bounded by `sessions.maxIdle` in `delegate.json` (default 4, #46):
  beyond the bound the least-recently-idle session unloads to its
  transcript file, and the next task naming its `sessionId`
  transparently reloads it — the transcript was always the resume
  authority, so unloading loses nothing but memory. Checked-out
  (running) sessions are never evicted; `maxIdle: 0` keeps nothing
  resident. `delegate_session list` shows unloaded records and
  `close` removes them the same as live ones. Config machinery —
  never a model-facing field.
- **Provider-scoped extensions (#59).** Subagents run with no extension
  inventory — not the parent's, not the project's — except a
  per-provider allowlist of user-scope packages via `delegate.json`
  `providerExtensions` (`{"openai-codex": ["npm:@bermudi/pi-codex"]}`
  is the shipped default). A provider the user lists is replaced
  wholesale, not appended to, and its sources are required: missing,
  unverifiable, or failing to load, the dispatch fails before any
  child starts. Providers the user never lists fall back to shipped
  defaults, which are best-effort — a missing or broken one degrades
  silently to an extension-free child, and an empty configured array
  does not disable a default. Sources resolve user-scope only and are
  verified against their configured origin/version; extensions a
  provider supplies (today `web_search` for codex children) join the
  child toolset through the same allowlist as built-ins. Operator
  machinery — the schema never exposes it.

## Observability

- **Completion evidence.** A settled task's record carries the file
  changes attributed to it: the union of paths observed in its
  write/edit tool calls and the changes a Git evidence window saw in
  the worker's repository (user decision 2026-10-02, live session
  01a0fdba — a bash-only worker had reported only `uncertain (bash)`
  and nothing usable). Only a mutating toolset opens a window at
  all (bash counts): a read-only run pays no snapshot cost and can
  never wear a sibling's or the parent's concurrent edits. The
  window opens before the task's first attempt and closes after
  the last: it snapshots `HEAD` plus
  `git status --porcelain -z` with an lstat per listed path, and the
  reported set is the paths whose status or stat differs between the
  two snapshots plus `git diff --name-only` across a moved `HEAD` —
  so committed work reports, a file already dirty before the run
  reports only when the run rewrote it, and paths excluded by
  `.gitignore` are never covered. When a bash/exec call ran and no
  snapshot covered the window — the cwd is not a repository, or Git
  failed (logged, never fatal) — the unknown-shell mark stands
  instead; a covered window that saw nothing reports no files line
  at all.

  Every window is shared evidence, not exclusive: a window that
  overlapped other writers — the parent's own write/edit/bash/exec
  calls (fact only, never arguments) or mutating sibling tasks on the
  same repository root — names them. Overlap reporting claims a
  shared file only on write/edit observation or a Git window with no
  named writers, so two overlapping tasks cannot each falsely claim
  the other's changes. The inline result, delivered wake, and ticket
  views show each task's attributed files beside its claim, and
  `details.attributedFiles` carries them machine-readably with the
  optional `concurrentWriters` names; when two tasks in one batch are
  attributed the same file, the result says so. Attribution is
  evidence, not confinement — it reports what changed inside a window
  and claims nothing it could not observe.

  A task run under the built-in `verifier` profile (#49 — the
  reviewer's read + bash toolset under a prompt that demands a
  machine-parseable closing line) adds a second evidence layer: the
  verdict parsed from the last `VERDICT:` line of its final output
  (`PASS`/`FAIL`/`AMBIGUOUS`; case-sensitive marker,
  whitespace-tolerant, an optional parenthetical count allowed; no
  parseable line means no verdict is reported). The verdict renders
  beside attribution in the same views, and `details.verdict` carries
  `{verdict, taskId}` machine-readably. A `FAIL` with zero attributed
  files reports the claim as not corroborated by any observed file
  change; a `PASS` with zero attribution reports `unverifiable`. It is
  reporting only — never admission, scheduling, or gating input —
  and non-verifier tasks are untouched by the layer.

- **Misfire rows.** Rejected and failed dispatches — validation errors,
  admission rejects, unknown names — record telemetry. v2's SPEC
  recorded nothing for rejected calls; v3 reverses this deliberately:
  misfires are the only feedback channel an N=1 project has against
  trained-reflex collisions, the lab-telemetry substitute.

  Decided (owner ratification, 2026-09-27): rows exist for every
  dispatch that ends before execution — validation rejections
  (including unknown exact agent names and pre-schema rejections), config-load
  failures, and admission rejections. Each row carries the timestamp,
  the phase, the caller-visible rejection message verbatim, and the
  batch shape (task count, requested agents, workspace selections,
  sync/async). Retention is identical to dispatch rows — one policy,
  no extra knobs. Same-call shared writers that serialize (cross-phase
  batches, #126) keep riding normal completed rows.

  Pre-schema errors carry paths and diagnostic messages only, never Pi's
  request-body dump. Caller-visible diagnostics are safe before persistence,
  so the saved misfire message remains verbatim without storing prompt or
  base-instruction content. Non-object wire arguments also produce a row
  with empty sanitized batch metadata.
  Recovery diagnostics omit supplied malformed values and corrective
  examples use placeholders for task/message/answer bodies.

- **Usage events (#60).** Task settlement emits `delegate:usage` on
  the shared `pi.events` bus: `{ticketId?, taskId?, provider, model,
  totalTokens, inputTokens, outputTokens, costUsd?}` from the settled
  outcome's recorded usage. Batch settlement adds one emission per
  distinct provider/model pair with that pair's summed usage. The
  channel is a refresh wake for sibling extensions (provider-balance),
  not an accounting stream — emission is throttled to one per 30 s per
  extension instance, listener errors can never break settlement, and
  tickets remain the durable usage record.

## Substrate inheritance

The engine is inherited as-built; v2's contracts become its historical
contract:

- `INVARIANTS.md` carries over verbatim, pending a ratification pass
  (admission, quiescence, ticket state, session reuse, isolated
  application — the red lines earned their keep in the comparison).
- Engine behaviors unchanged in v3: workspaces
  (shared/scratch/isolated) and their admission semantics, session
  pools, spill, delivery once-ness,
  evidence-bearing telemetry rows — except the scratch-copy admission
  strengthening below, the unordered-shared-writer rejection (#126),
  and the isolated worktree dependency provisioning (#120) below.
- **Scratch-copy admission (this repository's #50, owner-approved
  2026-10-07).** Scratch holds no source write reservation during worker
  execution, but copying takes a temporary read reservation on the
  canonical source tree. An overlapping shared/isolated writer or
  quarantined writer rejects copying; a new overlapping writer rejects
  while copying is underway. Rejection, not waiting or a race warning,
  is the policy. Concurrent scratch readers may coexist. Same-call
  not-yet-started writers may coexist because each phase's copies finish
  before that phase's workers start; earlier-phase writers must be
  confirmed quiescent, including source-mutating deferred cleanup and
  reconciliation, before they can be exempted. Copy claims release
  on success, failure, or cancellation only after copying stops, before
  the scratch worker starts. This protects against Delegate-owned writers
  in the same host, not external processes or an atomic filesystem
  snapshot.
- **Actionable scope failures (this repository's #51).** Git-scope
  discovery failures explain how to repair discovery and retry; inherited
  Git-redirection failures name the offending variables and tell the
  caller to clear or correct them before retrying. Neither failure
  recommends scratch as an unconditional safety workaround.
- **Workspace path guard (#62).** Isolated and scratch copies protect
  relative writes; absolute paths into the original tree previously
  sailed past the copy (observed live: workers edited the source tree
  while reconcile reported `no_changes`). Every isolated/scratch child
  now runs an inline `tool_call` guard — the only extension in its
  loader besides allowlisted provider sources — that refuses
  `write`/`edit` calls targeting the original source root outside the
  worker's copy, naming the copy-mapped path to edit instead. Paths
  outside the source root are untouched: the guard fixes the
  copy-confusion, it is not a sandbox, and reads are never blocked. A
  guard that fails to load fails the task — workers never run
  unguarded. The child prompt carries a workspace note mapping source
  paths to copy paths (appended over authored base prompts too).
  Shell commands remain unconfined: when source drift is observed
  during an isolated run — or a scratch run on a usable Git repository —
  in which a worker used a shell, that worker's `integration.sourceDrift`
  reports the source-relative paths — evidence beside the proposal
  machinery, never silently applied. Scratch drift windows close before
  isolated proposals apply in the same phase, so legitimate applies are
  never mistaken for escapes; scratch sources without a usable Git
  repository have no drift evidence (logged once). Same-batch shared
  siblings complicate attribution: their attributed files are excluded
  from drift, and a root overlapped by a shell-capable shared sibling is
  unattributable — its pinning is de-scoped and logged, not guessed.
  Ticketed scratch batches hold settlement through finalize, so `wait`
  never renders a pre-reconcile record without the evidence.
- **Session-scoped roster (#64).** The ticket store also holds
  journaled records owned by other Pi sessions — live sibling tickets
  still running elsewhere and settled records kept pollable (axiom 2).
  The bare `poll` roster and unknown-ticket hints list only records
  whose owner `sessionId` is the calling session's — a record with a
  different or missing owner session is another session's — and count
  the hidden remainder in a trailing note teaching explicit-id poll.
  Naming a ticket by id reaches it unchanged regardless of owner.
- **Isolated worktree dependency provisioning (#120).** Each isolated
  worker worktree is provisioned, at preparation, with the source
  root's Git-ignored entries in collapsed form (e.g. `node_modules/`
  copies as one tree) — reflink/Copy-on-Write where the filesystem
  supports it, a plain copy otherwise — so suite-running tasks work in
  isolation. Ignored files never enter proposals, merges, or drift:
  they are read-only inputs, and worker-local mutations of them are
  discarded with the worktree at reconcile. Delegate-owned runtime
  trees (artifact roots and the agent-dir delegate trees) are never
  provisioned, however the source's gitignore covers them — including
  a collapsed ignored ancestor that contains them. Baselines,
  candidate worktrees, and drift checks are never provisioned; a
  source entry that vanishes between listing and copying is skipped,
  while any other provisioning failure fails the group loud.

## Compatibility posture

- The v1 behavioral-oracle relationship is retired; it becomes a
  migration note (one user: bermudi).
- The oracle for the engine layer is v2's SPEC as the engine-as-built
  contract.

- **Pause is dashboard-only (#130).** The `pause`/`resume` ticket actions
  are removed from the `delegate_ticket` surface — a model that wants work
  held waits; one that wants it stopped cancels; removed actions reject
  with that teaching. The pause state machine survives as operator
  machinery: the /subagents dashboard's `p` keybinding drives
  TicketStore pause/resume directly, with no tool schema involved, and
  the paused-worker protections (INVARIANTS) continue to apply to it.

## Ratification record

All items decided by the v3 owner, 2026-09-27 (stewardship delegated
by bermudi; the pre-ownership draft framed this checklist as "walked
with bermudi" — the handoff superseded that):

- [x] Axioms confirmed
- [x] Cardinality defaults (absorbs #30)
- [x] Parking/budget rejection (#28 closes as superseded)
- [x] Alias set — decided above
- [x] Misfire telemetry scope — decided above
- [x] INVARIANTS carry-over pass — no conflict (sync/async appear only
      operationally; nothing pins a dispatch default or forbids
      aliases/reject-telemetry)
- [x] Swap ceremony executed 2026-09-27: `SPEC.md` (v2) →
      `SPEC-V2.md`; this file → `SPEC.md`; AGENTS.md updated; #28/#30
      closed with pointers; #34 closed (spec written and ratified)

### Surface simplification ratification — 2026-09-29 (#61)

User approved items 1–4: canonical fields/exact agent names, profile defaults
with retained full overrides, operator-selected compact/full schema exposure,
and one background default independent of task count. This supersedes the
original alias and cardinality ratifications above; no lifecycle rewrite,
family-specific interface or weakened safety guarantee was authorized.

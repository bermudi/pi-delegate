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
bounded ticket waits/tails, and shutdown bounds remain unchanged. This removes
only task deadlines, not unrelated internal timer bounds or batch token budgets.

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
   running snapshots report `interrupted` honestly, delivery is
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

- **Stable background default (#61, user-approved 2026-09-29).** Every
  nonempty dispatch runs async unless the caller passes `async: false`.
  Task count never changes execution mode. The explicit sync override returns
  inline results; async tickets still auto-deliver settled results.
- **No timers.** Parking budgets are rejected: the pros don't decide
  them because their grammar has no long-blocking dispatch to convert
  (#28 superseded). The only timeouts are caller-chosen, on waits.
- **Waiting is explicit and detachable.** `delegate_ticket wait` with
  the caller's `timeoutMs`; a timeout detaches the waiter only — the
  ticket keeps running. A parked wait also wakes on ticket activity
  worth a turn (#48): settlement returns the complete settled view; a
  worker-question arrival carries the question notice inline (ticket
  id, task id, question text, answer invocation) — the separate
  question-wake turn still delivers to the parent independently; a
  task newly settling `interrupted` carries the interrupted notice
  naming the task. Events already on record when a wait begins are
  stale news — view-visible, not a wake. (Engine behavior already;
  promoted to grammar.) `wait` also takes `tickets: [ids]` —
  wait-any (#58): the call resolves on the first watched ticket to
  settle, returning that ticket's view plus a one-line roster of the
  rest still running; the same parked-wait wakes (question,
  interruption) apply across the watch list, and the same
  detach-only timeout governs the whole call. `ticket` and
  `tickets` naming different targets is a validation error naming
  both; a one-id `tickets` is the single-ticket wait under another
  spelling.
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

  `delegate_ticket steer` carries `message`, an optional `steerId`
  (#44 — omitted, the boundary derives `steer:<toolCallId>` and the
  receipt names it; the derived id dedupes a transport-level retry of
  the same tool call), and an optional `taskId` (default: the single
  still-running task; an ambiguous omission errors naming the
  running ids). Pi delivers steers at turn boundaries — never
  mid-turn — so the receipts map: `steered` = queued on the live
  child run, observed as a user message at its next turn boundary;
  `activated` = no turn in flight (queued, preparing, between
  attempts), the parked message opens the task's next turn;
  `duplicate` = same `steerId`, byte-identical message, same
  target — the original receipt replays verbatim, nothing
  re-injects; `not-applied` = the target settled, is unknown, or
  is a recovered ticket, with teaching toward poll — and toward
  continuation when the settled task is identifiable (#57): a
  pooled session still live teaches re-dispatch with its
  `sessionId`, a fresh task's durable transcript teaches
  `resumeFrom`, and a task with neither keeps the plain text.
  Reusing a
  `steerId` with a different message or target is a conflict error
  naming both attempts. A parked steer whose task settles before
  delivery voids to `not-applied` on retry — nothing delivers into
  a dead session. When a transient failure retries the whole
  task, the task has not settled: steers the failed attempt
  already injected — drained parked messages and live steers
  alike — are re-supplied through the next attempt's drain, so a
  receipted message survives the session that died with it.
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
- **Batch token budget.** A top-level `tokenBudget` (positive
  integer, off by default) is a shared token ceiling for the
  batch (#47): each settled task charges its recorded usage to
  the account, and once the total reaches the limit the batch
  stops starting new tasks — a task still queued settles
  `budget-exhausted` with a visible reason naming the limit,
  without consuming a slot, worker, or session. Tasks already
  running always finish; the budget never hard-aborts a turn.
  Dependents of a `budget-exhausted` task block with a reason
  naming the exhausted budget, and unrelated branches still run.
  `budget-exhausted` is a first-class terminal outcome in views,
  telemetry, and the journal. The result and ticket headers
  report the account (`token budget: consumed/limit`), and
  `details.tokenBudget` carries `{limit, consumed, exhaustedAt?}`
  on dispatch results, polls, and waits; it persists on the
  ticket record so a recovered view still reports it.
- **Wake delivery.** Settled results inject as steering wakes,
  leaf-aware: a busy parent merges one at its next turn boundary
  (after the current turn's tool calls, before the next model call),
  an idle parent starts a new turn; simultaneous settlements batch
  into one wake. A `wait` or `poll` that already returned the same
  terminal view consumes the wake — the result is not delivered
  again (live session 01a0fdba, 2026-10-02).

## Canonical surface (#61, user-approved 2026-09-29)

- **One spelling per field.** Canonical dispatch fields are `tasks`,
  `async`, `workspace`, `brief`, `tokenBudget`, and `operationId`.
  Task fields retain their canonical names. Cross-harness synonyms
  (`subagent_type`, `agent_type`, `task_name`, task `message`,
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
- **Profile defaults.** Markdown profile `tools` and body provide reusable
  capability and base-instruction defaults. Full-mode task overrides remain
  available and retain their existing precedence. Operator configuration,
  model inheritance, admission, and all safety invariants are unchanged.
- **Compact/full exposure.** The operator chooses `surface: "compact"`
  (default) or `surface: "full"` in user-global `delegate.json` and reloads
  the extension. The choice is session-scoped, never model-family-specific.
  Both modes use the same execution engine. The advertised schema AND the
  accepted arguments match the selected mode; hidden advanced inputs must
  reject with guidance, never silently execute.
  Compact dispatch advertises `tasks`, `async`, `workspace`, and
  `brief`; each task has `prompt`, `agent`, `cwd`, and `workspace`.
  Full mode adds task `id`, `description`, `tools`, `systemPrompt`,
  `sessionId`, `resumeFrom`, `dependsOn` and batch
  `tokenBudget`, `operationId`. Compact ticket actions are poll, wait,
  cancel, answer, steer, and interrupt, with their required addressing and
  payload fields; full mode also exposes pause/resume/tail, wait-any
  `tickets`, `timeoutMs`, `steerId`, `offset`, and `waitMs`.
  Session list/close remain available in both modes. The manual itself
  is scoped to the selected surface (#64): the compact edition documents
  only controls the compact schema accepts — it must not teach a call
  that rejects — and closes with a line naming what full adds and how
  to enable it; the full edition carries the complete controls.
- **Description is a feature, not an alias.** The optional task display label
  remains available in full mode; it is not a task correlation id.
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
  silently, from every toolset a subagent can be given (#45): explicit
  task `tools`, a profile's frontmatter `tools`, and the mirrored
  parent inventory alike (the mirror excludes them by construction).
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
  no extra knobs. Serialized — not rejected — batches keep riding
  normal completed rows.

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
  pools, `operationId` idempotency, spill, delivery once-ness,
  evidence-bearing telemetry rows.
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
  paths to copy paths (appended under authored `systemPrompt`s too).
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

## Compatibility posture

- The v1 behavioral-oracle relationship is retired; it becomes a
  migration note (one user: bermudi).
- The oracle for the engine layer is v2's SPEC as the engine-as-built
  contract.

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

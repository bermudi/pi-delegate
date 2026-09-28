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

## Axioms

1. **The weights are the platform.** Models arrive RL-trained on the
   incumbent harnesses' idioms (Claude Code's blocking single `Task`,
   codex/grok/letta/minimax fire-and-forget fan-outs). Delegate has no
   RL flywheel and cannot retrain them. The surface meets trained
   reflexes: converge where the idiom is arbitrary, differentiate only
   where the difference is the product, teach every delta at the
   boundary, and treat a trained reflex hitting our walls as a surface
   bug — bend the surface before blaming the model.

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

- **Cardinality defaults.** A single task runs sync and returns its
  result inline (Claude Code `Task` reflex — the largest training
  surface). A multi-task batch runs async by default: returns a ticket
  immediately and auto-delivers the settled result as a wake-up turn
  (codex/grok/letta/minimax reflex). Explicit override both ways:
  `async: false` blocks a batch (scripts, CI); `async: true`
  backgrounds a single task.
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
  promoted to grammar.)
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
  is a recovered ticket, with teaching toward poll. Reusing a
  `steerId` with a different message or target is a conflict error
  naming both attempts. A parked steer whose task settles before
  delivery voids to `not-applied` on retry — nothing delivers into
  a dead session.
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
- **Wake delivery.** Settled results inject as follow-up turns,
  leaf-aware; simultaneous settlements batch into one wake.

## Reflex meeting

- **Agent-name aliases.** Trained names map onto built-ins:
  `general` → `default`, `general-purpose` → `default`,
  `scout` → `explore`. Alias expansion is visible in the result so the
  model learns the canonical name.

  Decided (owner ratification, 2026-09-27; rename 2026-09-28, #40;
  `explorer` added #44 — codex's built-in role name):
  `general`, `general-purpose`, and `worker` → `default`;
  `explorer`, `plan`, and `scout` → `explore`; `implement` → `coder`.
  The read-only built-in is
  `explore` — the trained canonical across grok, minimax, and Claude
  Code; `scout` survives only as a reverse alias. Each alias is sourced
  from a trained incumbent surface — Claude Code/letta/grok
  `general-purpose`, MiMo `general`, minimax `worker`, codex
  `explorer`, grok `plan`,
  pi-dialect `scout`. Exact case-sensitive match only, no fuzzy
  matching.

  Alias precedence (#45): a discovered user or project profile claims
  its exact name ahead of the alias table — an authored `general.md`
  is that user's agent and the `general` → `default` alias never
  fires; the alias applies only to names no profile claims. Built-ins
  still win collisions with same-named profiles (they never leave the
  catalog), and the unknown-agent error's available list keeps
  naming built-ins with their live aliases — a claimed alias name is
  listed as the profile, not as an alias.
- **Unknown names still error** — with the available list, in one
  teachable round-trip (the v1 `general` error recovered in one retry).
- **Cross-harness field spellings.** Task objects also accept the
  Claude-Code-shaped spellings trained callers emit: `subagent_type`
  normalizes to `agent` before agent resolution (the alias table
  applies to it — `subagent_type: "general-purpose"` resolves
  `default`), `description` (≤200 chars) is a display label preferred
  over the id in call rows and section headers (never a correlation
  key), and `run_in_background` — at top level or per task —
  normalizes to the dispatch-level `async` decision. Top-level
  `context` is the same folding for the batch `brief` (#43). The
  #44 tail adds `agent_type` → `agent` (same machinery and conflict
  rules as `subagent_type`), `task_name` → `id`, and `message` →
  `prompt` — the spawn_agent-shaped call (`task_name` + `message` on
  `delegate`) dispatches as a task rather than bouncing to steer
  guidance, while a bare `message` with no task shape keeps its
  `delegate_ticket` routing; `message` on `delegate_ticket` stays
  steer-owned. `delegate_ticket wait` accepts `timeout_ms` →
  `timeoutMs`. `reasoning_effort` rejects with the same no-caller-
  effort teaching as `thinking`, at task level, top level, and on
  the sibling tools (#44).
  Any two spellings of one field
  present with different values is a validation
  error naming both fields; every applied rename is reported on the
  result/receipt as `field "<field>" → "<to>"`, the same teaching
  pattern as alias expansion (#41). `additionalProperties: false`
  stays closed — unrecognized fields still fail at the schema.

## Surface rules

- **Boundary teaching.** Every contract that diverges from the
  incumbent default is legible in the tool description — it is the only
  channel that reaches trained weights. (Landed 2026-09-27: read-only
  concurrency, batch-in-one-call.)
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

## Observability

- **Completion evidence.** A settled task's record carries the file
  changes attributed to it: paths observed in its write/edit tool
  calls, with changes sourced from bash marked uncertain. The inline
  result, delivered wake, and ticket views show each task's attributed
  files beside its claim, and `details.attributedFiles` carries them
  machine-readably; when two tasks in one batch are attributed the
  same file, the result says so. Attribution is evidence, not
  confinement — it reports what tools touched and claims nothing
  about paths it could not observe.

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
  (including unknown agent names after alias expansion), config-load
  failures, and admission rejections. Each row carries the timestamp,
  the phase, the caller-visible rejection message verbatim, and the
  batch shape (task count, requested agents, workspace selections,
  sync/async). Retention is identical to dispatch rows — one policy,
  no extra knobs. Serialized — not rejected — batches keep riding
  normal completed rows.

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

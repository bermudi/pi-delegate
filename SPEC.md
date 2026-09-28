# SPEC v3 — contract layer on the v2 engine

Status: **ratified 2026-09-27** by the v3 owner — stewardship delegated
by bermudi ("you're gonna own this. v3 is now your baby"). This
document is the sole behavioral authority; `SPEC-V2.md` is the
gine-as-built contract it inherits. Nothing here requires a new
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
   exactly-once. The parent agent is a fallible client above a dispatch
   service, not the ledger.

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
  ticket keeps running. (Engine behavior already; promoted to grammar.)
- **Fan-out shape.** Batches in one call, taught at the boundary.
  N parallel single-task dispatches — the trained fan-out reflex — must
  work for read-only tasks (they hold no write claims); for overlapping
  writers they reject before execution with teaching, never serialize
  across calls.
- **Steering.** Steering is a message with a delivery receipt,
  idempotent on retry — never polling. Outcome vocabulary adopted
  from the field: `queued` / `applied` / `not-applied` (fx) and
  `activated` / `steered` / `duplicate` (minimax).

  `delegate_ticket steer` carries `message`, a caller-chosen
  `steerId`, and an optional `taskId` (default: the single
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
- **Wake delivery.** Settled results inject as follow-up turns,
  leaf-aware; simultaneous settlements batch into one wake.

## Reflex meeting

- **Agent-name aliases.** Trained names map onto built-ins:
  `general` → `default`, `general-purpose` → `default`,
  `scout` → `explore`. Alias expansion is visible in the result so the
  model learns the canonical name.

  Decided (owner ratification, 2026-09-27; rename 2026-09-28, #40):
  `general`, `general-purpose`, and `worker` → `default`; `plan` and
  `scout` → `explore`; `implement` → `coder`. The read-only built-in is
  `explore` — the trained canonical across grok, minimax, and Claude
  Code; `scout` survives only as a reverse alias. Each alias is sourced
  from a trained incumbent surface — Claude Code/letta/grok
  `general-purpose`, MiMo `general`, minimax `worker`, grok `plan`,
  pi-dialect `scout`. Exact case-sensitive match only, no fuzzy
  matching.
- **Unknown names still error** — with the available list, in one
  teachable round-trip (the v1 `general` error recovered in one retry).
- **Cross-harness field spellings.** Task objects also accept the
  Claude-Code-shaped spellings trained callers emit: `subagent_type`
  normalizes to `agent` before agent resolution (the alias table
  applies to it — `subagent_type: "general-purpose"` resolves
  `default`), `description` (≤200 chars) is a display label preferred
  over the id in call rows and section headers (never a correlation
  key), and `run_in_background` — at top level or per task —
  normalizes to the dispatch-level `async` decision. `agent` and
  `subagent_type` present with different agents, or `async` and
  `run_in_background` present with different values, is a validation
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

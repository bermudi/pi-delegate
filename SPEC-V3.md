# SPEC v3 — contract layer on the v2 engine

Status: **draft for ratification.** `SPEC.md` (v2) remains the sole
behavioral authority until this document is ratified and the swap
ceremony runs. Nothing here requires a new codebase: v3 is a new
contract layer on the same engine (#34).

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
- **Steering (later phase; grammar fixed now).** Steering is a message
  with a delivery receipt, idempotent on retry — never polling.
  Outcome vocabulary adopted from the field: `queued` / `applied` /
  `not-applied` (fx) and `activated` / `steered` / `duplicate`
  (minimax).
- **Wake delivery.** Settled results inject as follow-up turns,
  leaf-aware; simultaneous settlements batch into one wake.

## Reflex meeting

- **Agent-name aliases.** Trained names map onto built-ins:
  `general` → `default`, `general-purpose` → `default`,
  `explore` → `scout`. Alias expansion is visible in the result so the
  model learns the canonical name. *(Ratify: the concrete alias set.)*
- **Unknown names still error** — with the available list, in one
  teachable round-trip (the v1 `general` error recovered in one retry).

## Surface rules

- **Boundary teaching.** Every contract that diverges from the
  incumbent default is legible in the tool description — it is the only
  channel that reaches trained weights. (Landed 2026-09-27: read-only
  concurrency, batch-in-one-call.)
- **No model-facing knobs for machinery.** Internal tuning lives in
  `delegate.json`, not the schema. The schema stays reflex-shaped.

## Observability

- **Misfire rows.** Rejected and failed dispatches — validation errors,
  admission rejects, unknown names — record telemetry. v2's SPEC
  recorded nothing for rejected calls; v3 reverses this deliberately:
  misfires are the only feedback channel an N=1 project has against
  trained-reflex collisions, the lab-telemetry substitute. *(Ratify:
  retention and scope.)*

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

## Ratification checklist

- [ ] Axioms confirmed
- [ ] Cardinality defaults (absorbs #30)
- [ ] Parking/budget rejection (#28 closes as superseded)
- [ ] Alias set (general, general-purpose → default; explore → scout; more?)
- [ ] Misfire telemetry scope
- [ ] INVARIANTS carry-over pass
- [ ] Swap ceremony: `SPEC.md` → `SPEC-V2.md` (historical engine
      contract), this file → `SPEC.md`; AGENTS.md updated; #28/#30
      closed with pointers

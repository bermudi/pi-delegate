# ADR-0001: SessionPool owns policy, not session materialization

- **Status:** Accepted
- **Date:** 2026-07-06
- **Tracking:** https://github.com/bermudi/pi-delegate/issues

## Context

The pooled-session state was smeared across three modules. `pool.ts` exported a
raw `Map` (`agentPool`); `lifecycle.ts` reached into it for pool-hit detection,
config-freeze validation, insert-on-success, and stats-on-hit; `task-resolution.ts`
peeked `agentPool.get(id).config` to default tasks that supply only a `sessionId`.
No single module owned the pool's contract (freeze-on-insert, validate-on-reuse,
insert-only-on-success, stats-on-hit, per-sessionId serialization, explicit close,
and parent-shutdown cleanup).

An architecture review proposed deepening the pool into a first-class module. The
obvious "deeper" move is to make `acquire(task) → session` the pool's interface —
absorbing pool-hit reuse, resume-from-`.jsonl`, and fresh-create behind one call.

## Decision

The `SessionPool` module owns pooled-session **state and policy only**. Its seam
is a small set of behavioral operations (`checkout`, `commit`, `configFor`,
`close`, `closeAll`, `list`, `withSessionLock`) over a **private** `Map`; the raw
`Map` is not part of the public barrel.

**Session materialization** — acquiring a usable `AgentSession` by pool-hit reuse,
resume-from-`.jsonl`, or fresh-create — **stays in `lifecycle.ts`**
(`acquireAgentSession`). The pool never imports `host.ts`, `sessions.ts`,
`createAgentSession`, or `node:fs`.

Supporting decisions: the pool owns the config-freeze compare and returns a
structured diff (caller formats); the per-session lock stays a pool-exported
primitive that the caller brackets the whole run with; live sessions persist
until explicit close or parent-session shutdown rather than silently expiring.

## Rationale

Folding materialization into the pool makes it **shallow by a wide interface**,
not deep. Materialization needs host deps (`getHostDeps`), session persistence
(`sessions.ts`), the SDK (`createAgentSession` / `SessionManager`), and `fs`. A
pool whose `acquire(task)` owned all that would have to accept or import every one
of those dependencies — a wide interface that hides little per unit the caller
must learn. That is the opposite of depth.

The pool's depth comes from owning **policy** behind a narrow interface. Its
dependencies are language primitives (a `Map` and a promise-chain lock) —
in-process + local-substitutable, no port at the external seam.
Materialization is a separate concern that legitimately spans several modules and
belongs in `lifecycle.ts`, which orchestrates against the pool.

The pool's invariants (freeze, validate, insert-on-success, insert-vs-recordUse)
concentrate in one module; `lifecycle` becomes a thin orchestrator and
`task-resolution` stops reaching into pool internals (it calls `configFor`).

## Consequences

- `agentPool` (the raw `Map`), `commitPoolInsert`, `commitPoolStats`, the
  `shouldPoolAfter` field, and the dead `syncInserted` field are all removed.
- `lifecycle.ts`'s acquire path calls `checkout`; its commit path calls `commit`,
  which decides insert-vs-recordUse internally by `Map` presence (sound because
  the per-session lock serializes same-`sessionId` tasks).
- Tests no longer hand-build `PooledAgent` literals or call `Map` methods; they
  go through `commit` / `configFor` and close behavior.

## Do not re-litigate

A future review that re-suggests "make `acquire(task)` the pool's interface" or
"fold resume/fresh creation into the pool" should re-read this ADR first. The
rejected move is shallow-by-wide-interface; the accepted seam is policy-only.
Re-open only if materialization's dependency surface shrinks materially (e.g. the
SDK collapses `createAgentSession` + `SessionManager` + host deps into one call).

# ADR 0001: In-process worker execution is permanent; running work is lost by design across host death

- **Status:** Accepted (alternative declined)
- **Date:** 2026-10-06 (owner decision; recorded as ADR 2026-10-08)
- **Authority:** bermudi — #96 closed wontfix ("in-process execution stays
  permanent"), #44 closed declined on that basis; commit 8923683
- **Revisit trigger:** an observed child-session freeze of the parent's
  agent loop (named in 8923683 so no future session resumes the cutover
  uninvited)

## Context

Delegate's workers are in-process `AgentSession`s inside the extension
closure. Pi tears that closure down on `session_shutdown` — all five
reasons (`quit`, `reload`, `new`, `resume`, `fork`) — so every host
event kills running work. #44 named the consequences: process-local
ticket registry and pool, no reconnect to surviving work, no
rematerialized sessions after restart. It proposed a staged fix
(journal → worker reconnect → lazy pooled rematerialization) gated on
#96's subprocess-worker boundary (v2 numbering: #43; stage-A scaffolding
survives dormant in `src/worker/`).

The motivating user incident (2026-09-18, recorded on #44): an
accidental `/reload` cancelled a background task; polling the same
ticket afterward returned "not found"; recovery required manual
transcript discovery and a `resumeFrom` re-dispatch.

## Decision

In-process execution stays permanent. Worker reconnect across host
restart and post-restart pool rematerialization are **declined** — they
require process-backed workers, and that boundary is wontfix.

**Net restart contract:** running work is lost by design. Transcripts,
settled outcomes, and workspace artifacts survive; recovered `running`
records settle `interrupted` (with their durable transcript named —
#123, 0.3.6) and are never automatically resumed or delivered.

## Rationale

1. **Incumbent parity is the platform.** No incumbent harness (Claude
   Code, codex, et al.) isolates subagents as subprocesses or resumes
   running subagent work across its own restart either. Exceeding that
   behavior buys nothing the trained weights know to use, at the cost
   of a process-management surface (IPC, kill escalation, lifecycle
   supervision) the incumbent-trained world has never exercised.
2. **The record layer already tells the truth.** Settled outcomes are
   cold-recoverable (#79), orphaned records settle exactly-once only
   when the owner is provably dead (#107), and since #123 the
   interruption names its transcript. The durable half of #44's ask is
   served without processes.

## Explicitly not decided here

The 2026-09-18 incident also asked that reload-caused stoppage be
**distinguished from explicit cancellation** in the record
("interrupted by reload" vs `cancelled`). That is a labeling question
about the permanent architecture, not part of the declined alternative,
and it remains open — do not read this ADR as settling it.

## Consequences

- `session_shutdown` force-cancels live tickets on all reasons; the
  quiescence bound (#52) stays the only grace period.
- The approved sequencing's "restart recovery" phase reduces to its
  record-level half (landed: #79, #107, #123, #124) plus the live
  browser (#48). No execution-level recovery work is pending.
- `src/worker/` stays dormant scaffolding; nothing in dispatch may
  call it without reopening this ADR.

# ADR 0003: A fourth tool surface — the parent model's bug-report spool

- **Status:** Accepted (adds a tool surface; changes no existing one)
- **Date:** 2026-10-15 (owner ruling, follow-up to the design review of the
  same day; implemented the same day)
- **Authority:** bermudi — the operator's go-ahead directive after being walked
  through the design review: the collision-return-channel proposal, the
  bounded-fields/local-record shape, and the standing description cost of a
  fourth tool. The operator's instruction to implement it is the ruling
  recorded here.
- **Revisit trigger:** the standing description cost of the fourth tool — a
  measured, attributable change in ordinary callers' behavior (misfire rate or
  spool noise) — never a speculative preference for a smaller tool list. A
  second trigger sits on the other side: if the spool accumulates without being
  emptied, the surface is being used as a backlog and the intake contract, not
  the tool, is what needs revisiting.

## Context

Delegate has three tool surfaces (dispatch, tickets, sessions) and one guiding
principle: *watch for collisions — where a trained reflex hits our walls, prefer
bending the surface over blaming the model*. That principle's loop is currently
open at the model's end. The operator sees misfire telemetry (what the extension
observed: a rejection, a phase, a message) and can read transcripts, but nothing
captures the model's own interpretation of what went wrong — "this error
message lied", "the result contradicts the description", "the rejection never
told me the resolvable set", "this shape isn't the shape I was trained on".

That is precisely the class of evidence that cannot be recovered later by an
operator reading telemetry: telemetry says a call was rejected, never that the
description taught the wrong thing. The design review settled the shape of the
return channel and the operator approved it:

- **The model is a lossy witness.** Bounded structured input only: `what`,
  `expected`, `observed`, optional `ticketId`. The extension attaches the ground
  truth it already holds (versions, session file, tickets touched this session,
  a telemetry pointer), so a report is never asked to carry facts a witness
  would get wrong.
- **Local record, not an action.** Filing writes one owner-only file for the
  operator and changes nothing about running work. No promise of action, no
  corrective guidance, no auto-filed issue: a public side effect from a model's
  prose is a red line.
- **Intake, not backlog.** A per-session cap, content-addressed dedup, and a
  mandated triage step keep the spool a queue that gets emptied rather than a
  second issue tracker.

## Decision

Delegate registers a fourth tool, `delegate_report`, whose standing description
cost — a fourth entry in every session's tool list and system-prompt tool doc —
is **accepted** by the operator as the price of closing the collision loop.

The surface is small by construction: three bounded text fields plus one
optional identifier; a bounded receipt with no advice; a cap, not a knob. The
report is a *file*, never a message: `delegate-reports/` under the agent
directory, owner-only (0700/0600, single-link, `O_NOFOLLOW` traversal), with the
same reserved-namespace exclusion rules as `delegate-diagnostics`, and a
graceful unsupported answer on platforms without secure routing.

Workers are not reporters. `delegate_report` is stripped from every child
toolset exactly like the other three delegate tools; a worker that hits a wall
says so in its result to its parent, where the parent's context and the parent's
evidence pointers apply.

The description teaches the taxonomy (what is reportable, what is not, and the
host discriminators for Pi-side failures) because the description is the only
channel that reaches the trained weights — the same rule every other boundary in
this project follows.

## Consequences

- Every session pays for a fourth tool description whether or not it ever files
  a report. The revisit trigger above is the honest check on that trade.
- The operator gains a machine-readable record of *model-visible* contract
  failures, including the taxonomy cases telemetry structurally cannot express:
  misleading errors, non-enumerating rejections, and untaught divergences from
  the incumbent harness idiom.
- The spool is model-authored content living on disk. It is deliberately not
  routed through the diagnostic sink (which is content-free by contract), and it
  is excluded from every place Delegate copies or hashes a source tree, so a
  record can never ride into a worker or a private Git snapshot.
- A new runtime tree exists at a new path; the reserved-namespace machinery
  (namespace predicate, runtime roots, every exclusion site) now covers two
  trees, and the audit that landed with this ADR found and closed one hole it
  had: an ignored directory being provisioned into an isolated worktree could
  carry a runtime tree inside it.
- Records accumulate until triaged by design (deleting one would let an
  identical resubmission re-fill the spool); `bun run reports:triage` is the
  emptying step, and dispositions live beside the records they mark.
- `SPEC.md` "Report surface", `INVARIANTS.md` "Bug reports", and
  `COMPATIBILITY.md` "Report surface" state the normative behavior; #147
  carries the design's open numbers (12-hex content-addressed id, cap 3,
  512-character fields) restated for operator ratification.

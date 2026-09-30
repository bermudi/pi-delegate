# pi-delegate v2

A Pi extension for delegating bounded work to subagents while the parent
retains coordination. This is a specification-first rewrite, not a port of
v1's internals or a general-purpose agent team platform.

This file is orientation, not a behavioral contract. Read [SPEC.md](../SPEC.md),
[INVARIANTS.md](../INVARIANTS.md), and [COMPATIBILITY.md](../COMPATIBILITY.md)
for the sole behavioral authorities; [TEST-MIGRATION.md](../TEST-MIGRATION.md)
retains test provenance and coverage status. A specified outcome is not proof
that its implementation is complete.

## Mental models

- **Dispatch and tickets:** bounded tasks, either awaited or tracked in the
  background; completion and result delivery are distinct concerns.
- **Sessions:** live reusable conversations; explicit transcript recovery is
  distinct from automatic recovery after a host restart.
- **Workspaces:** shared edits, disposable scratch work, or isolated proposals;
  isolation is not a security sandbox and application is not verification.

## Flows

1. Delegate a bounded investigation or edit, then inspect its ordered results.
2. Dispatch background work, continue parent work, then receive or poll its
   ticket result; cancellation still requires safe resource handling.
3. Continue a successful named session, or resume an explicit transcript;
   inspect isolated proposals and recovery artifacts when reconciliation fails.

Work planning lives in GitHub issues, not here. See [AGENTS.md](../AGENTS.md)
for the workflow.

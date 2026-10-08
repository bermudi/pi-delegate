# Delegate v2 invariants

These are externally meaningful safety properties, not a prescription for
recreating v1. References to v1 mechanisms—including event counters,
quiescence barriers, locks, controllers, indexes, temporary Git indexes,
private refs, worktrees, and timeout constants—are intentionally absent. V2 may
use any design that makes these properties true and testable.

## Cancellation and quiescence

- A session MUST NOT be returned to the pool, disposed, or have its workspace
  removed while provider, tool, compaction, or extension continuation work may
  still mutate it.
- Apparent request completion MUST NOT be treated as proof that deferred
  provider, tool, compaction, or extension work has stopped.
- Healthy long-running cleanup MUST NOT be misclassified as cancellation merely
  because it exceeds an internal fixed duration.
- Cancelled work MUST eventually produce a caller-visible outcome even when
  termination cannot be confirmed. In that case its resources remain
  quarantined.
- Work that restarts or continues after cancellation MUST remain cancelled and
  MUST NOT make its resources eligible for reuse. Failed safety checks MUST NOT
  authorize cleanup.
- Cancellation is cooperative. It MUST NOT claim to stop subprocesses or roll
  back completed side effects.
- Cancellation cause precedence is parent abort, then stall.
- Tasks MUST carry no wall-clock deadline (#118, user-approved). Supplied
  `deadlineMs` MUST reject before execution in both surfaces, even null or
  recovered flat/stringified shapes. No configuration or host default may add
  a task deadline, and the inactivity watchdog MUST NOT become a wall-clock
  limit. Historical saved deadline failures MUST remain readable.

## Dispatch identity

- The same live `operationId` and normalized request MUST share one
  execution and one result — the original in-flight promise or settled
  value, never a second run.
- The same `operationId` with a changed normalized request MUST conflict
  before any work, admission, or config resolution starts.
- Unkeyed dispatches MUST never be deduplicated; identical requests without
  an `operationId` execute independently.
- An in-flight operation MUST never be evicted or dropped by retention
  bounds; an async operation remains in-flight until its ticket's batch
  finishes.
- The first caller MUST own the dispatch signal, host context, progress
  reporting, and delivery origin; a duplicate dispatch call's signal MUST
  NOT cancel the original operation. Ticket RPC cancellation authority is
  unchanged: any caller holding the ticket id MAY cancel it through the
  ordinary ticket RPC.
- Cancellation or failure MUST be retained as the operation's result and
  MUST NOT restart the operation while the record lives.
- Settled-record retention MUST be bounded: expiry after one hour, at most
  256 settled records, oldest-settled evicted first.
- Operation identity MUST live only as long as the host extension/session;
  saved tickets MUST NOT deduplicate a new dispatch by operationId, and no
  exactly-once execution claim may be made.

## Surface selection

- Removed aliases MUST reject the whole call before any work starts.
- Advertised and validated schemas MUST match the operator-selected compact
  or full surface. Hidden fields/actions MUST NOT execute through recovery
  normalization; full mode MUST preserve all canonical advanced features.
- Surface selection MUST NOT depend on model family or weaken any execution
  invariant. A nonempty call with omitted async MUST run in background,
  independently of task count.

## Conversation isolation

- Dispatch MUST NOT extract or inject the parent conversation into children.
- Obsolete `context` fields MUST reject the whole call before any task starts.
- Children retain project instructions and their own pooled or explicitly
  resumed history; freshness relative to the parent MUST NOT reset that history.

## Session reuse

- Same-ID calls MUST serialize across acquisition, execution, and final state
  update; different IDs may proceed concurrently. No particular locking
  strategy is required.
- A pooled session's cwd, tools, thinking, model, base prompt, and provider
  extension configuration MUST be frozen. Tool comparison is order-independent.
  Explicitly incompatible reuse MUST fail.
- Fresh or resumed sessions enter the pool only after a successful,
  non-cancelled, non-stalled run and only when a durable session file exists.
- A transcript file MUST have one owner at a time: a `resumeFrom` (or a
  symlink to it, or a pooled session's durable file) owned by a live worker
  MUST reject, holding the exclusivity until the worker is confirmed
  quiescent — never released by caller settlement alone. Two tasks in one
  call MUST NOT share a transcript.
- A pooled session cancelled or stalled after prompting MUST be evicted.
  Cancellation before prompting may leave it intact and MUST record no usage.
- Ordinary provider/task failure on an existing pooled session remains
  reusable and its attempt usage is recorded.
- A late materialization after cancellation MUST NOT be prompted or pooled.
- Shutdown MUST reject new reusable sessions, request termination of active
  sessions, avoid racing their state updates, attempt every cleanup, and surface
  cleanup failures.
- Scratch and isolated workspaces MUST remain one-shot and MUST NOT support
  pooling or transcript resume.

## Ticket state

- An async ticket MUST be saved before its workers start. Saved terminal
  outcomes MUST remain pollable on a new extension instance using the same
  agent directory. A formerly running ticket MUST be reported as interrupted
  after an unclean restart, never resumed, delivered, or mistaken for an
  ordinary failure. A worker's claimed transcript MUST be journaled before
  its first turn (#123) so the interrupted outcome can name the durable
  file for a deliberate `resumeFrom` — an affordance, never an automatic
  resume; records without the pointer render without it. Completed
  outcomes remain visible; unfinished effects
  are unknown. A recovered cancelled ticket with an unconfirmed worker MUST
  warn in the roster even if every task has an outcome. Persistence failures
  MUST be visible, not swallowed.
- Recovered tickets MUST NOT own live sessions, questions, worker handles,
  reservations, or delivery rights. Automatic replay of an unfinished task
  is forbidden without a separate side-effect-safe contract.
- A waiting question MUST remain owned by its running ticket and worker.
  Yielding execution capacity MUST NOT yield the session, workspace, admission
  reservation, or confirmed-quiescence obligation. Capacity MUST be reacquired
  before an answer lets worker execution continue.
- A question MUST NOT wake the wrong parent branch. Cancellation
  and shutdown MUST invalidate pending questions; late answers MUST NOT
  resurrect terminal work. Question waits MUST NOT count as stall inactivity.
  Tasks have no wall-clock deadline, including while awaiting an answer.

- Ticket terminal state MUST be internally consistent and idempotent regardless
  of racing completion, cancellation, and shutdown.
- Running and cancelling tickets remain unavailable for conflicting work;
  terminal tickets do not.
- After forced cancellation begins, later worker completion MUST NOT turn the
  ticket into a successful completion.
- Shutdown cancellation settles immediately, resolves waiters, and performs no
  follow-up delivery.
- Session shutdown or replacement MUST wait for every dispatch's
  confirmed quiescence, bounded by a fixed budget (~30s; see
  `DELEGATE_SHUTDOWN_QUIESCENCE_MS`). Past the budget the boundary MAY
  proceed only by naming the still-unconfirmed work loudly — a
  permanently wedged worker MUST NOT wedge host exit (#52). Workspace
  reservations are still released only by confirmed quiescence, never by
  a session boundary or by the budget expiring, and are never handed to
  a replacement extension instance.
- A terminal cancellation response MUST NOT falsely imply that unsafe worker
  cleanup has completed. Later safe-to-expose results must remain visible.
- A result MUST NOT be delivered before it is safe to expose: settled, and
  with isolated reconciliation and final annotations recorded.
- A delivered result MUST NOT trigger a turn on a session-tree leaf other
  than the one it was dispatched from.
- Delivery failure MUST NOT undo settlement or make results unpollable.
- Wait timeout or caller abort MUST detach only that waiter.
- Pause is orthogonal to lifecycle: a paused ticket remains running and retains
  its sessions, workspace reservations, and protection against
  conflicting work.

## Dependencies and handoffs

- The dependency graph MUST be fully validated before any task starts:
  unknown references, self-dependencies, cycles, and ambiguous ids are
  whole-call errors.
- A task MUST NOT start until every declared prerequisite has reached a
  confirmed-quiescent terminal outcome; a provisional outcome MUST NOT
  unblock dependents.
- A prerequisite that did not succeed — including an isolated prerequisite
  whose proposal was not applied — MUST block its dependents with a visible
  reason and MUST NOT block unrelated branches. A blocked task consumes no
  worker, session, or concurrency slot.
- A task's scratch or isolated workspace MUST be prepared no earlier than
  its phase: a copy or baseline taken before earlier phases applied would
  hide their work. A dependent MUST see every earlier phase's applied
  changes — never only the prerequisite's summary.
- Cross-kind overlap MAY be admitted only when the dependency graph orders
  every overlapping shared/isolated pair in some direction; unordered
  cross-kind overlap MUST still reject.
- Dependency blocking MUST NOT weaken cancellation: a task reached while
  the batch is cancelled is cancelled, not blocked.

## Shared writes

- Admission MUST fail closed when the physical cwd/Git scope is ambiguous.
  Canonical equal, ancestor, and descendant roots overlap.
- `read`, `grep`, `find`, `ls`, and `web_search` are read-only for admission;
  unknown tools are mutating.
- Same-call overlapping shared writers never run concurrently, and
  same-phase overlap MUST reject before execution, enumerating the
  remedies (order with `dependsOn`, run independent edits in workspace
  `isolated`, or split into separate calls) — a graph edge always lands
  the dependent in a later phase, so any same-phase pair is unordered by
  construction. Cross-phase overlapping writers MUST serialize in
  (phase, task) order, the later waiting for the earlier's confirmed
  quiescence; a failure MUST still allow an incidentally-ordered
  successor to run (only graph dependents block on failure).
  Serialization MUST NOT consume scarce execution capacity while no task
  can execute.
- Overlap with another active sync/async dispatch or quarantined task MUST
  reject, not queue. Shared/isolated overlap MUST reject — except within
  one call whose dependency graph orders every overlapping pair (see
  "Dependencies and handoffs").
- Inherited Git redirection with bash-capable multiple writers MUST fail closed.
- Scratch source copying MUST hold a temporary read reservation on the
  canonical tree being copied. Overlapping Delegate-owned shared/isolated
  writers or quarantined writers MUST reject copying; new overlapping
  writers MUST reject while the copy reservation is held. Concurrent copy
  readers MAY coexist. Same-call planned writers MAY be exempted only when
  they have not started; earlier-phase writers MUST be confirmed quiescent
  including source-mutating deferred cleanup and reconciliation before exemption.
  A copy reservation MUST remain held until copying stops,
  including on cancellation or failure, and MUST release before the scratch
  worker runs. Scratch worker execution holds no source write reservation.
- Git-scope and inherited-redirection failures MUST include the relevant
  correction and retry guidance, without suggesting an unconditional scratch
  bypass.
- V2 ships no unsafe-write bypass: no operator or caller setting may skip
  admission. Reintroducing one is a contract change, not a restoration.
- Admission MUST NOT claim path confinement, cross-process locking, or
  protection from external processes.

## Isolated application

- Preparation MUST capture tracked, deleted, and untracked dirty baseline state
  without changing the user's branch or index.
- Each worker MUST be isolated from other workers' ordinary relative writes.
  Worker activity MUST terminate before its output is accepted for application.
- Worker write/edit tool calls targeting the source tree outside the worker's
  copy MUST be refused (isolated and scratch). Shell effects are not confined;
  source drift observed during an isolated or scratch run (scratch evidence
  requires a usable Git repository) in which a worker used a shell MUST be
  reported on that worker's outcome — excluding writes attributable to
  same-batch shared siblings; a root overlapped by a shared sibling whose
  shell writes are unobservable (a shell that ran outside Git evidence
  coverage) is unattributable and MUST NOT carry a pin (logged instead).
- Every successful proposal MUST have a durable recovery representation before
  reconciliation.
- Proposals MUST reconcile in task order. Each proposal is all-or-nothing;
  predecessor conflict MUST NOT prevent later independent proposals from being
  considered.
- Source apply MUST first verify that its baseline assumptions still hold and
  MUST leave the user's index and branch unchanged. A failed apply MUST restore
  the baseline and preserve recovery artifacts when needed.
- Conflicts and cancellation before source apply MUST retain discoverable,
  recoverable proposal artifacts. Cancellation MUST NOT apply accepted
  proposals.
- An abandoned worker MUST be discarded, never snapshotted or applied, and its
  cleanup MUST wait for safety confirmation.
- Source reservations persist through preparation, execution, reconciliation,
  and worker cleanup.
- A clean apply is `applied_unverified`; it MUST NOT assert semantic correctness
  or successful tests.

# Delegate v2 behavioral specification

This document describes the user-visible contract to carry forward from
`pi-delegate` v1. It specifies outcomes, not how v2 must produce them. V1
modules, algorithms, state machines, timers, storage layouts, and cleanup
mechanisms are explicitly not requirements.

## Operations

Delegate registers three sibling tools. Each owns one concern, so dispatch,
ticket, and session fields can never be combined in one call:

1. **`delegate`** — dispatches subagent tasks; an empty `tasks` array shows
   the manual.
2. **`delegate_ticket`** — ticket RPC on a required `action` field.
3. **`delegate_session`** — session RPC on a required `action` field.

Fields belonging to a different tool fail the call with guidance naming the
right tool. Validation happens before any task starts.

### Dispatch

```ts
delegate({ tasks: [task, ...], async?: boolean, workspace?: "shared" | "scratch" | "isolated", operationId?: string })
```

Dispatch is synchronous by default. `async: true` applies to the whole batch,
returns a ticket immediately, and later auto-delivers the batch result.
Synchronous results preserve task input order and include aggregate usage when
the Pi host supports it. A top-level `workspace` is the default for every task
that does not name its own. A synchronous result is error-valued only when
every task failed or was blocked — a partially failed batch is a normal
result carrying each task's own status, mirroring an async ticket's
`partial` settlement.

A task accepts:

| Field | Meaning |
| --- | --- |
| `id` | Optional correlation key: 1–64 ASCII letters, digits, `.`, `_`, or `-`; unique in the batch |
| `prompt` | Self-contained instruction; optional only when continuing with `resumeFrom` |
| `agent` | Named profile; omission selects an inline task |
| `cwd` | Working directory; relative paths resolve from the parent cwd |
| `systemPrompt` | Base prompt; project context is added separately |
| `tools` | Exact capability list; `*` = read/write/edit/bash, `ro` = read/grep/find/ls |
| `sessionId` | Key for a live reusable session |
| `resumeFrom` | Absolute `.jsonl` transcript path |
| `deadlineMs` | Positive wall-clock budget beginning after queueing; omission means no deadline |
| `workspace` | `shared`, `scratch`, or `isolated` |
| `dependsOn` | Ids of tasks in this batch that must succeed first; their outputs are handed off |

Omitting `agent` creates an `inline` task with `*` by default. The built-ins are:

- `default`: mirrors the live parent's model, thinking level, delegatable native
  tools, and sanitized base prompt.
- `scout`: read-only investigation.
- `coder`: shared-tree implementation.
- `reviewer`: shared-tree review by default.

If reading the parent's active tools throws and any `default`-profile task
omits `tools`, the whole sync or async dispatch fails before any child starts.
The failure is logged and returned with its cause and guidance to restore the
parent inventory or supply explicit tools. Explicit `tools` (including `[]`),
`scout`, `coder`, `reviewer`, and inline tasks do not require that probe;
inline tasks retain their writer default.

Children never inherit the parent conversation: no parent transcript is extracted
or injected. Supply a self-contained task brief. The obsolete `context` field
is rejected before any task starts, including `context: "fresh"`; omit it.
This does not remove a child's own pooled `sessionId` or explicit `resumeFrom` history.

Task fields override profile defaults. Project context is rebuilt for the
task cwd; the parent's extension inventory, MCP tools, and user-global
harness instructions are not inherited. Children run with all extensions
disabled and resolve provider registrations and auth through the parent's
shared model runtime; a model the runtime cannot resolve or authenticate
fails the task with that cause — there is no provider-extension fallback.
Verified live against real providers 2026-09-26 (issue #5).

Named agents also come from user-authored Markdown profiles, discovered per
dispatch — edits take effect without a reload — in first-definition-wins
order:

1. `<project>/.pi/agents/*.md` — the nearest ancestor of the parent cwd that
   contains the directory. These are user-authored project config, not
   prompt injection.
2. `<agentDir>/agents/*.md` — the same resolved agent directory that hosts
   `delegate.json` (`~/.pi/agent/agents` in a normal install).

A profile needs `name` and `description` frontmatter; the Markdown body is
its system prompt. Optional frontmatter: `tools` (the `*`/`ro` groups or a
comma list; omitted means `*`), `thinking` (a thinking level — the profile's
effort default), and `model` (a `provider/model[:effort]` reference — the
profile's model pin; an explicit `thinking` wins over the suffix). Unknown
keys are ignored. Files ending `.chain.md` are skipped. A file that is
unreadable, has malformed frontmatter, misses a required field, or carries
invalid `tools`/`thinking`/`model` values is skipped with a logged warning —
a half-loaded profile is worse than none. Built-ins always win name
collisions: a `scout.md` is ignored with a warning rather than reshaping the
built-in. Claude Code's `.claude/agents` is not imported.

Only globally defined profile names are valid `models`/`modelsByParent` keys:
a user-global config cannot name a project-local profile — it would fail
validation in every other session — so project profiles pin their model via
frontmatter `model:` instead.

Subagents run on the parent's model. The user may override a **named agent**
under `"models"` in the user-global `delegate.json` — an object mapping agent
name to a model reference. There is deliberately no `"default"` entry and no
way to redirect inline or `default`-profile tasks: they mirror the parent's
model unconditionally. A second map, `"modelsByParent"`, scopes those pins to
the parent's exact `provider/model-id` (case-insensitive):
`{"modelsByParent": {"<parent provider/model-id>": {"scout": "..."}}}` — a
scoped entry wins over the unscoped `"models"` entry for the same agent.
Below both sits a Markdown profile's frontmatter `model:` pin: the model
chain is parent-scoped pin → unscoped pin → profile `model:` → the parent's
model. Callers never select models: a task `model` field is rejected before
tasks start, whatever value it carries — the model registry containing a
model is not authorization to spend on it. A configured or profile-pinned
reference that does not resolve in the session's model registry fails the
whole call, naming the config entry or profile file.

Effort is likewise user-configured only — a task `thinking` field is rejected
like `model`. A `"models"`/`"modelsByParent"` reference or a profile's
frontmatter `model:` may carry a `:effort` suffix (`off`…`max`) pinning the
child's thinking level; an unrecognized suffix fails at config load or skips
the profile. Effective effort resolves as: a delegate.json `:effort` (a
scoped pin's wins over an unscoped one's) → the profile's own thinking
default → the parent's live thinking level when the child runs the parent's
model → the model's default otherwise.

The user-global `delegate.json` is discovered from the session's agent
directory: the `DELEGATE_AGENT_DIR` environment variable when set, else
Pi's own `PI_CODING_AGENT_DIR` override, else the session-store layout
(`<agentDir>/sessions/<slug>`), else — for sessions with no session
directory — the session cwd behind a visible warning.
Delegate-owned trees (`delegate-sessions/`, `delegate-scratch/`,
`delegate-isolated/`) are created under the same resolved directory.
Project files never become delegate configuration.

Tasks run concurrently subject to global and per-model limits. Overlapping
same-call shared writers serialize in task order, and the result names the
serialized tasks and scope with the `isolated` remedy — independent same-repo
edits are meant to run in parallel worktrees. Overlap with active work, or
between shared and isolated work, rejects the whole call before execution —
except as ordered by explicit dependencies below.

### Dependencies and handoffs

A task may name prerequisites in the same batch via `dependsOn`, a list of
task ids (caller `id`s or generated `task-N` ids). Dependencies are always
explicit; they are never inferred from task prose. The complete graph is
validated before any task starts: unknown references, self-dependencies,
cycles, and ambiguous ids fail the whole call.

Dependencies partition the batch into phases. A task with no prerequisites
is phase 0; any other task's phase is one deeper than its deepest
prerequisite. A phase starts only after every earlier phase has finished —
including its isolated reconciliation — so a task's tree always contains
every earlier phase's applied work: a `shared` task reads the source
directly, and a `scratch` copy or `isolated` baseline is captured at its
phase's start. A reviewer depending on a builder sees the actual changes,
not merely the builder's summary. A `scratch` prerequisite hands off only
its output — its edits are discarded by definition.

A task runs only when every prerequisite ended `ok` — for an isolated
prerequisite, with its proposal applied or cleanly empty. Otherwise it is
`blocked`: a caller-visible terminal status naming the blocking
prerequisites and their reasons, consuming no worker, session, or
concurrency slot. Blocking is per-edge — independent branches still run —
and cancellation supersedes it: a task reached while the batch is cancelled
is `cancelled`, not `blocked`. A dependent waits for its prerequisite's
confirmed quiescence before evaluating, so a worker that only provisionally
settled can never unblock downstream work.

A starting dependent receives each prerequisite's handoff appended to its
prompt: the prerequisite's id, its terminal state (with the applied file
list for an applied isolated prerequisite, or a discarded-edits note for a
scratch one), and its final output bounded to the dispatch's
`output.spillThresholdChars` as a tail. The complete output stays on the
task record; the handoff is a projection of it, as with spill.

Same-call overlapping shared and isolated tasks still reject — unless the
dependency graph orders every overlapping cross-kind pair, in either
direction. A shared task that transitively depends on an isolated task
reads the tree after that proposal applied; an isolated task that depends
on a shared task is worktreed after that writer stopped. Unordered overlap
remains a whole-call error.

Settlement treats `blocked` as a non-success that ran no worker: a batch is
`partial` when at least one task succeeded, `failed` when none did and at
least one failed or was blocked, and `cancelled` only when every task was
cancelled. The synchronous result is error-valued when every task failed
or was blocked.

### Explicit operation identity

`operationId` is an optional top-level dispatch key of 1–64 ASCII letters,
digits, `.`, `_`, or `-`. It is dispatch-only; ticket, session, and help calls
reject it.

Its scope is one extension/session lifetime: it is never persisted across
reload, replacement, or restart. Two requests are equivalent when their
normalized validated `{async, tasks}` structures are identical after
supported boundary repairs and batch workspace-default application, before
config/profile/model/cwd resolution; `operationId` itself is excluded.

The same id plus the same normalized request reuses the exact original
in-flight promise or settled result — the sync result or the async ticket —
and only one execution ever runs. The same id plus a changed request
conflicts before config resolution, admission, or work starts.

The first caller owns the dispatch invocation's signal, host context,
progress callback, and delivery origin. A duplicate dispatch call cannot
contribute its own signal, recontextualize, or replay progress. For async
results, the reused ticket remains cancelable through the ordinary ticket
RPC by any caller holding its id. Cancellation or failure is itself a
result and is reused; an operation is never restarted inside its
retention.

Settled records expire one hour after settlement and at most 256 settled
records are retained, evicting the oldest-settled first; in-flight records
are never evicted. An async operation's record counts as in-flight — and
its retention clock has not started — until its ticket's batch finishes,
so it survives capacity and expiry pressure while the ticket runs. After
expiry or eviction, reuse may start a new operation.

Unkeyed identical dispatches always execute independently: there is no
content deduplication and no exactly-once crash guarantee.

### Workspaces

- **shared** operates directly in the source tree.
- **scratch** runs once in a disposable reflink copy and discards its changes.
  It cannot use `sessionId` or `resumeFrom`. A task whose resolved tools are
  all read-only is rejected — the copy buys nothing. Scratch holds no write
  reservation on the source tree.
- **isolated** runs one-shot tasks in detached Git worktrees and reconciles
  successful proposals into the source tree in task order. It cannot use
  `sessionId` or `resumeFrom`.

Scratch and isolated workspaces protect against ordinary relative writes; they
are not security sandboxes.

### Ticket RPC

```ts
delegate_ticket({ action: "poll", ticket? })
delegate_ticket({ action: "wait", ticket, timeoutMs? })
delegate_ticket({ action: "pause" | "resume", ticket })
delegate_ticket({ action: "cancel", ticket, force? })
delegate_ticket({ action: "answer", ticket, taskId, questionId, answer })
```

- `poll` returns one ticket or the ticket roster.
- `wait` blocks until settlement or timeout. Timeout/parent abort detaches the
  waiter; it does not cancel background work. A pending worker question also
  detaches the waiter immediately with the question visible, rather than
  deadlocking the parent who needs to answer it.
- `pause` cooperatively stops queued tasks and future model turns, not current
  model/tool work or subprocesses.
- `resume` continues the same ticket.
- `cancel` previews unless `force: true`; forced cancellation is cooperative
  and does not undo completed writes or commands.

Tickets remain pollable after settlement.

### Restart visibility

Async ticket identities, completed task outcomes (including full output), and
terminal results are saved under the resolved agent directory in owner-only
storage. On a new extension instance, poll, wait, and the roster expose saved
tickets without starting children or replaying delivery. A ticket last recorded
as running becomes terminal `interrupted`: its saved outcomes remain visible,
but unfinished tasks have unknown effects and are never restarted by polling,
waiting, or redispatching an `operationId`. A recovered terminal cancellation
with missing task outcomes or a recorded quarantined worker warns that tasks
may still have had effects, including in the roster when every outcome is
recorded; the terminal status alone does not prove their workers stopped. An
orderly session shutdown still cancels running tickets before it completes.
Recovered tickets cannot be
paused, resumed, answered, or cancelled; new tickets use fresh opaque ids.
No live write reservation is recovered: an orphaned subprocess may still be
mutating a shared tree after a process crash. Inspect it before new writes.

If storage cannot be initialized or the ticket creation record cannot be
written, async dispatch fails before workers start. Ticket RPCs also fail
visibly when saved storage is invalid; synchronous dispatch and live session
RPCs do not require ticket storage and continue independently. A later save failure is
logged and disclosed on that ticket; disk recovery may then show an older
snapshot, conservatively marking unfinished work interrupted. Corrupt or
unsupported saved records fail visibly rather than being silently discarded.
Saving tickets does not guarantee exactly-once execution, automatic recovery
of the child session, or delivery after a restart. Saved results contain task
outputs and must be treated as private; Delegate does not automatically delete
them.

### Worker questions (#17)

Only async-ticket workers have a delegate-owned `ask_parent` tool, independently
of their ordinary tool list; sync workers do not. It takes a nonempty `question`
string. A worker must issue it as the **only tool call in that model turn**;
parallel tool calls alongside a question fail the question rather than
releasing capacity while other tools may still run. At most one unanswered
question is allowed per task. The question is correlated to its ticket, task
id, and opaque question id, visible in single-ticket polls, roster polls,
timed-out waits, and a parent notification. The worker's tool call waits for
the answer; the parent sends a nonempty answer through the ticket RPC above.
There is no automatic human escalation or guessed answer; the parent may ask
the human explicitly. A parent must not wait on the ticket it needs to answer.

Identical repeat answers are idempotent while the ticket is running; a different
repeat answer is an error. Unknown, wrong-task, late, cancelled, and terminal
answers are errors, not successful no-ops. The question stops being pending
when answered, cancelled, or its worker ends; cancellation/shutdown prevents
an answer from restarting it. Pausing a ticket does not erase questions:
an answer may be recorded during pause, but the worker may not continue its
next model turn until resumed. The question wait suspends the inactivity
watchdog; explicit task deadlines continue to count wall time. Deadline,
cancellation, and shutdown interrupt unanswered questions without resurrecting
terminal work.

An exclusively question-waiting worker yields its global and per-model
execution slots while parked, and reacquires both before its answer returns
to the child. Its session, workspace admission, and write reservations remain
owned throughout — another dispatch with conflicting write scope still
rejects. A question notification uses background delivery's leaf-aware
wake/append rule, but does not settle or deliver the ticket's final result.

A naturally settled batch is `completed` only when every task succeeded. It is
`partial` when at least one task succeeded and at least one did not,
`cancelled` when every task was cancelled, and `failed` when no task succeeded
and at least one failed. Forced ticket cancellation remains authoritative and
settles the ticket as `cancelled` regardless of late worker outcomes.

A singular ticket RPC (poll with a ticket id, wait, cancel, pause, or resume)
for an unknown id returns a tool error naming the missing ticket. Roster
polling without a ticket id remains a successful empty/list response.

### Output bounding

Two audiences share one source of truth — each task's complete recorded
output, which is never truncated or discarded. What differs is the
LLM-facing projection:

- **Settled output** (a synchronous result, or a terminal ticket's
  poll/wait/delivery text): output at or below `output.spillThresholdChars`
  chars is returned verbatim. Over the threshold, the complete output is
  written to a temp file and the text carries only a bounded tail of at
  most `output.spillTailChars` chars plus a pointer naming the file, the
  full size, and that retention follows OS temp policy. A failed task's
  partial output is bounded the same way. The tail never begins with a
  lone half of a surrogate pair.
- **Running-ticket views**: a poll or timed-out/aborted wait on a running
  ticket bounds every recorded outcome to the tail budget only and never
  writes a spill file or names one — the note states whether completion
  will spill or include the full output.
- **Recovery**: the complete output always remains on the ticket record
  and in the `results` field of the tool result's and delivered message's
  `details`; a human expanding the result sees it whole. If the spill
  write itself fails, the complete output is returned in-context instead —
  bounding degrades losslessly, never to a hard truncation.
- **Stability**: once a settled ticket's record can no longer change,
  repeated polls render one stable view — the same spill path, not a new
  file per poll.

Spill files live under the OS temp directory, named
`delegate-output-<agent>-<random>.md`, created exclusively with owner-only
permissions, and are never deleted by Delegate (pointers can persist in
transcripts; the OS temp policy owns their lifecycle).

`output.spillThresholdChars` (positive integer, default 8000) and
`output.spillTailChars` (non-negative integer, default 2000) are read from
the user-global `delegate.json`; malformed values fail the call before any
task starts. Each ticket snapshots the bounds at creation — a later config
edit does not retroactively reshape a settled ticket's rendered result.

### Background delivery

Delivery runs on Pi's public extension API only: no Pi source patch, patched
install, or unreleased host field is required, and loading the extension in a
stock Pi allows dispatch.

An async result is delivered once, after the ticket has settled *and* its
outcome is safe to expose (isolated reconciliation applied or retained, final
annotations recorded). Cancellation settles the ticket at once; its delivery
still waits for the safe outcome.

- **Same leaf, no transition:** if the parent is still on the session-tree
  leaf where the ticket was dispatched and no shutdown or tree transition has
  been observed, the result is sent as a follow-up that wakes an idle parent
  and queues behind a busy one's remaining tool calls.
- **Otherwise** (leaf moved, tree transition in progress, shutdown observed):
  the result is appended to the session as a custom message at the current
  leaf without triggering a turn, and a notice announces it. It enters model
  context on the next user turn. Nothing wakes the wrong branch.
- **Delivery failure**: synchronous send failures are logged with the ticket
  id and surfaced as a notice; async send rejections are surfaced through
  the host's extension-error channel without a delegate notice (the stock
  `ExtensionAPI.sendMessage` is fire-and-forget). Either way the ticket
  stays settled and pollable.

Session shutdown — quit, `/reload`, `/new`, `/resume`, `/fork` — rejects new
dispatches, force-cancels every running ticket with no follow-up delivery,
and then holds the shutdown until every worker's quiescence is confirmed,
showing a visible waiting status. Replacement sessions never inherit live
workers or workspace reservations. They may poll saved ticket results from
the same agent directory, but do not auto-deliver them.

Because Pi runs extension lifecycle handlers in order, a preceding
extension's slow handler can delay Delegate's shutdown or tree hooks. A
ticket settling inside that window may wake the outgoing session once; Pi
aborts that turn during teardown. This is an accepted, documented limitation
(see `COMPATIBILITY.md`), never a workspace-safety gap.

### Telemetry

Telemetry is disabled by default. Only an explicit
`"telemetry": { "enabled": true }` in the user-global `delegate.json` enables
it.

Telemetry writes to a local SQLite database only; nothing is transmitted
remotely. The destination resolves as `telemetry.dbPath`, then
`DELEGATE_TELEMETRY_DB`, then `<agentDir>/delegate-usage.db`.

Each dispatch pins the resolved destination when the batch is accepted. If a
later dispatch disables telemetry or selects another destination before the
first finishes, the unfinished span is dropped rather than reopening or
writing the obsolete destination.

Rows are written only for dispatches that reach a completed batch outcome;
rejected calls and failed admission or preparation record nothing. For each
such dispatch it records the batch start timestamp and wall duration,
sync/async mode, task count, terminal call status, caller-visible task status,
agent/model/thinking/tools/workspace selections, integration status, retry
count, and numeric token/cost usage. Task records capture metadata and outcomes
at batch finish; v2 leaves the legacy per-task duration field NULL. A task row
whose worker could not be confirmed stopped is marked provisional and may later
be superseded in the live ticket.

It never stores prompt, system-prompt, output, or error text; cwd or session
paths; caller task IDs; operation IDs; or parent transcript content. Legacy v1
rows may retain older values; v2 does not rewrite or delete them.

Telemetry is fail-open: an open, schema, write, or close failure logs and
disables telemetry for that destination; delegation results never change.

An existing v1 database migrates in place with old rows preserved. Disabled
telemetry leaves existing files unopened and untouched. On intentional enable
the database, WAL, and SHM files are owner-only.

### Session RPC

```ts
delegate_session({ action: "list" })
delegate_session({ action: "close", sessionId })
```

`list` reports live pooled sessions. `close` aborts, disposes, and removes the
named session. Session controls are top-level only.

## Input recovery and errors

For compatibility with imperfect tool callers, Delegate silently repairs only
unambiguous shapes:

- a JSON-stringified task array;
- flat task fields wrapped into one task;
- `tools` supplied as a JSON array string or one bare token;
- `agent: ""`, treated as omitted;
- `null` on any field, treated as absent — top-level and inside tasks alike;
- a blank (`""` or whitespace-only) optional identifier, treated as absent:
  `operationId`, `ticket`, `sessionId`, `taskId`, `questionId`, and a task's
  `sessionId`, `cwd`, `resumeFrom`, or `agent`.

It does not merge flat fields into an existing non-empty task array. A `tasks`
field that stays absent becomes `[]`, so `{}` still returns the manual. Blank
values that are not optional identifiers — task `id`, `prompt`,
`systemPrompt`, `dependsOn` entries, and ticket `answer` — remain present and
fail their normal validation. Unknown task keys, task-level `async`/`sessionAction`,
duplicate IDs or session IDs, busy sessions, unresolved agents/tools, a task
`model` field, and fields belonging to a sibling tool fail the whole call with
an actionable error and no started tasks.

## Sessions, retries, and cancellation

A successful task with `sessionId` keeps a live conversation for the lifetime
of the host process.
Later calls with that ID serialize and continue it. Its cwd, tools, thinking,
model, base prompt, and provider-extension configuration are frozen; incompatible
reuse is rejected. `resumeFrom` rehydrates a durable transcript and may then be
pooled under a new `sessionId`.

Transient whole-task failures may retry. Temporary rate limits without a
provider reset window can receive one short retry only before side effects;
limits with a reset window (including provider reset headers and timed 403 rate
limits), exhausted quota, billing, and authentication do not receive an
immediate retry. Explicit credential failures take precedence over incidental
rate-limit metadata or reset headers; explicit unhinted 403 provider rate limits
may receive the short retry, while a bare 403 remains an account problem. The
failure distinguishes waiting for a provider window from
account/configuration problems and preserves any provider-supplied
reset hint. It does not promise an exact reset time or auto-resume. Callers
cannot select a different model.

Stall timeouts measure inactivity; deadlines measure wall-clock time.
Deadlines exist only when the caller passes `deadlineMs`. Omission means no
deadline: no configuration key, host default, or implicit budget may
introduce a wall-clock time limit.
Cancellation does not promise rollback or immediate termination. Delegate does
not reuse or clean up resources while they may still mutate state; resources
whose safety cannot be established remain unavailable.

# Delegate v2 behavioral specification

This document describes the user-visible contract to carry forward from
`pi-delegate` v1. It specifies outcomes, not how v2 must produce them. V1
modules, algorithms, state machines, timers, storage layouts, and cleanup
mechanisms are explicitly not requirements.

> **Status (2026-10-10): inherited engine contract, partly overridden.** SPEC.md
> (v3, ratified 2026-09-27) is the sole behavioral authority, and this file is the
> engine-as-built contract it inherits. Where SPEC.md states a different rule,
> SPEC.md wins. Known overrides are marked **Overridden** in place, with their
> source. The section-by-section override sweep was completed for the
> 2026-10-10 contract state (#137), including ADR 0001, ADR 0002 and the
> current INVARIANTS.md. Marks describe that audited state, not a guarantee
> against future changes: where this file and SPEC.md disagree, SPEC.md
> always controls. Historical signatures, examples and quoted prompts do
> not authorize fields or capabilities explicitly removed by current rules.

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
delegate({ tasks: [task, ...], async?: boolean, workspace?: "shared" | "scratch" | "isolated", operationId?: string }) // operationId removed by #130
```

**Current surface (SPEC.md, "Canonical surface", #130):** the signature
above is the historical v2 shape. Dispatch now advertises `tasks`,
`async`, `workspace` and `brief`; `operationId` rejects. The task table
below is also historical where its rows are marked overridden.

Dispatch is synchronous by default. **Overridden (SPEC.md, #61):** an omitted `async` now backgrounds nonempty work for one task as well as many; add `async: false` for inline results. `async: true` applies to the whole batch,
returns a ticket immediately, and later auto-delivers the batch result.
Synchronous results preserve task input order and include aggregate usage when
the Pi host supports it. When a task's worker could not be confirmed stopped
(a quarantined outcome), its recorded output and usage are labelled as lower
bounds — "at least" what was observed — and the result's details carry
`usageLowerBound: true`; totals that omit an unknown remainder must say so.
A top-level `workspace` is the default for every task
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
| `cwd` | Working directory; relative paths resolve from the parent cwd. A leading `~` expands against the home directory (`~`, `~/x`) and, like absolute paths, ignores the parent cwd |
| `systemPrompt` | Authored base prompt, used verbatim — it replaces the composed child base prompt; project context is added separately |
| `tools` | Exact capability list; `*` = read/write/edit/bash, `ro` = read/grep/find/ls |
| `sessionId` | Key for a live reusable session |
| `resumeFrom` | Absolute `.jsonl` transcript path; a transcript owned by a live worker rejects (symlinks canonicalize) |
| `deadlineMs` | Positive wall-clock budget beginning after queueing; omission means no deadline |
| `workspace` | `shared`, `scratch`, or `isolated` |
| `dependsOn` | Ids of tasks in this batch that must succeed first; their outputs are handed off |

**Overridden (SPEC.md, #118 and #130):** the `deadlineMs`, `systemPrompt`, and `tools` rows are removed. Capability and base-prompt selection now belong to Markdown profiles (frontmatter `tools`, body).

Omitting `agent` creates an `inline` task with `*` by default. The built-ins are:

- `default`: mirrors the live parent's model, thinking level, and delegatable
  native tools.
- `scout`: read-only investigation (`ro` tools — never serializes with
  writers). **Overridden (#40, #61):** this built-in is now `explore`. An unauthored `scout` is rejected at dispatch and in `models` config; an authored global `scout.md` is an ordinary profile (see COMPATIBILITY.md, v2 → v3 changes).
- `coder`: shared-tree implementation (writer tools).
- `reviewer`: shared-tree review with `read` + `bash` — it can run focused
  checks, and admission treats it as a writer: it serializes with other
  writers on the same roots.

**Overridden (SPEC.md, #126):** same-phase unordered overlapping shared
writers reject; only ordered cross-phase writers serialize. This applies
to reviewer tasks too. **Added (SPEC.md, "Completion evidence", #49):**
`verifier` is also a built-in, with the reviewer's capabilities and a
reporting-only parsed verdict.

**Child base prompt.** A child without an authored prompt — an inline task or
any built-in profile — composes its base prompt from the parent's
user-authored prompt inputs: the parent's custom base prompt (when one
replaces the stock prefix) and the text the user appended to it.
Extension-contributed prompt sections and guidelines are never inherited:
children run extension-free (superseded by #59 for allowlisted providers, see
SPEC.md's provider-scoped extensions bullet), and inherited extension prose would reference
tools they do not have. Tool documentation is never inherited either; the
child's session builds it from the child's own inventory. The composition
appends the profile's role line (each built-in carries one) and closes with
the fixed subagent framing:

> You are a subagent spawned by the delegate extension on behalf of a parent
> session. No user is watching this session and questions cannot be asked;
> your final message is the only result returned to the caller. Complete the
> task in your brief, then stop. Use only the tools provided.

**Qualification (SPEC.md, "Interaction grammar"; inherited worker
questions below):** the historical framing does not forbid the async
worker's child-only `ask_parent` capability. It asks the parent, not a
human watching the child; inline workers still have no question tool.

The framing carries no parent identity — never a model name. An explicit
task `systemPrompt` (removed by #130) or a Markdown profile body is authored prompt text and
is used verbatim: no inheritance, no framing appended. When an extension
has force-replaced the parent's prompt wholesale, inheritance is skipped —
the child runs on the stock base prompt plus role line and framing — and
the skip is logged.

If reading the parent's active tools throws and any `default`-profile task
omits `tools`, the whole sync or async dispatch fails before any child starts.
The failure is logged and returned with its cause and guidance to restore the
parent inventory or use a named profile that carries its own tools. Profile-selected tools (task `tools` was removed by #130),
`explore` (formerly `scout`, #40), `coder`, `reviewer`, and inline tasks do not require that probe;
inline tasks retain their writer default.

**Overridden (SPEC.md, #130):** task-level `tools` is removed, so a
`default` task cannot bypass this inventory probe with a caller override.
Other profiles retain their profile-owned capabilities.

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
Verified live against real providers 2026-09-26 (issue #5). **Superseded by
#59:** an allowlisted provider's children load its listed user-scope extensions,
and the shipped default allowlists `openai-codex` (SPEC.md, provider-scoped
extensions); the two sentences above describe the 2026-09-26 state.

**Overridden (SPEC.md, "Profiles own capability and base prompts", #130):**
the task-over-profile statement does not authorize task `tools` or
`systemPrompt`; both reject. Models and effort remain operator/profile-owned
under the model-selection rules below. The default profile's eligible
parent tool mirror and provider-scoped extension capabilities are governed
by SPEC.md's #59 and #130 rules, not the historical blanket extension
statement.

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
a half-loaded profile is worse than none. A warning surfaces once per file
path per session (discovery re-reads the disk per dispatch; the log does not
reflood), and the manual's profile listing is silent — asking for help never
scolds. Within one directory, files are considered in name order, so the
first-definition-wins winner between same-named files is deterministic.
Built-ins always win name collisions: a `scout.md` is ignored with a warning
rather than reshaping the built-in. **Overridden (SPEC.md, #61):** `scout` is no longer a built-in, so `scout.md` is an ordinary profile. Claude Code's `.claude/agents` is not
imported.

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
scoped entry wins over the unscoped `"models"` entry for the same agent. **Overridden (#40):** the example key `scout` is now `explore`; `models.scout` is rejected at load unless an authored global scout profile exists.
A `modelsByParent` key names the parent's exact `provider/model-id`
(provider before the first slash, then the full model id — which may itself
contain slashes, e.g. OpenRouter's `openrouter/anthropic/claude-sonnet-4`). A key that could never match — empty, missing the slash, an empty provider or model id, doubled slashes, or internal whitespace — fails at config load rather than
sitting dead; colons are legal because model ids carry them
(`ollama/qwen2.5:32b`) and keys name the parent's exact id. Below both sits a Markdown profile's
frontmatter `model:` pin: the model chain is parent-scoped pin → unscoped
pin → profile `model:` → the parent's model. Callers never select models: a
task `model` field is rejected before
tasks start, whatever value it carries — the model registry containing a
model is not authorization to spend on it. A configured or profile-pinned
reference that does not resolve in the session's model registry fails the
whole call, naming the config entry or profile file.

Effort is likewise user-configured only — a task `thinking` field is rejected
like `model`. A `"models"`/`"modelsByParent"` reference or a profile's
frontmatter `model:` may carry a `:effort` suffix (`off`…`max`) pinning the
child's thinking level. Only the last `:segment` is a suffix candidate and
only when it names a known level — any other colon is part of the model id
itself, and a reference that then does not resolve fails at dispatch naming
the entry (the profile is skipped only on parse-level errors, not on an
unresolvable id). Effective effort resolves as: a delegate.json `:effort` (a
scoped pin's wins over an unscoped one's) → the profile's own thinking
default → the parent's live thinking level when the child runs the parent's
model (identity compared case-insensitively, like config matching) → the
model's default otherwise.

The user-global `delegate.json` is discovered from the session's agent
directory: the `DELEGATE_AGENT_DIR` environment variable when set, else
Pi's own `PI_CODING_AGENT_DIR` override, else the session-store layout
(`<agentDir>/sessions/<slug>`), else — for sessions with no session
directory — the session cwd behind a visible warning.
Delegate-owned trees (`delegate-sessions/`, `delegate-scratch/`,
`delegate-isolated/`) are created under the same resolved directory.
Project files never become delegate configuration.

The recognized top-level keys are `maxConcurrent`, `concurrency`,
`stallTimeoutMs`, `models`, `modelsByParent`, `telemetry`, and `output` (also
`providerExtensions`, #59, and `sessions`, #46; a supplied `surface` key rejects, ADR 0002);
unknown keys are silently ignored. The file is re-read on every call, and
a malformed value — a non-integer or non-positive `maxConcurrent`, a
negative or non-integer `stallTimeoutMs`, a `concurrency` block or bound
of the wrong shape, or a malformed `output`/`models`/`modelsByParent`/
`telemetry` entry — fails the whole call at load, before any task starts,
naming the offending key. There is no keep-last-good fallback: dispatch
does not proceed on a partially valid `delegate.json` (deliberate — see
`COMPATIBILITY.md`).

**Overridden (SPEC.md, "Unknown configuration keys", #136):** unknown
top-level keys warn once per changed file content through `DiagnosticSink`;
they do not reject an otherwise valid configuration. Recognized-value
validation and per-call reload are unchanged. Explicitly removed `surface`
continues to reject with teaching.

Tasks run concurrently subject to a global bound and per-model bounds.
`maxConcurrent` (positive integer, default 8; it was 3 before #41) caps the total number of
tasks executing at once. The `concurrency` block holds the per-model
bounds: `concurrency.models` maps an exact `provider/model-id` to a
positive integer, `concurrency.providers` maps a provider name to one,
and `concurrency.default` is the per-model fallback. A task's per-model
bound resolves `models` → `providers` → `default` → `maxConcurrent`; the
global cap always applies on top. Each call applies the bounds from its
own loaded config. **Overridden (SPEC.md, #126):** same-phase overlapping shared writers in one call now reject before execution, with enumerated remedies. Cross-phase overlap still serializes in phase order; the `isolated` workspace is the parallel path. Overlap with active work, or
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

**Overridden (SPEC.md, #130):** `operationId` is removed. Dispatches are not
caller-deduplicated: a supplied `operationId` rejects with teaching before any work starts.
The keyed-reuse contract this section described (same id and same request reuses an in-flight
or settled result; a changed request conflicts; 256-record and one-hour retention) is
superseded and survives only in git history.

Unkeyed identical dispatches always execute independently: there is no content deduplication
and no exactly-once crash guarantee.

### Workspaces

- **shared** operates directly in the source tree.
- **scratch** runs once in a disposable reflink copy and discards its changes.
  It cannot use `sessionId` or `resumeFrom`. A task whose resolved tools are
  all read-only is rejected — the copy buys nothing. Scratch holds no write
  reservation on the source tree.
- **isolated** runs one-shot tasks in detached Git worktrees and reconciles
  successful proposals into the source tree in task order. It cannot use
  `sessionId` or `resumeFrom`.

**Strengthened (SPEC.md, "Scratch-copy admission"; INVARIANTS.md, "Shared
writes", this repository's #50):** scratch copying holds a temporary source
read reservation until copying stops on every exit. Scratch worker
execution still holds no source write reservation; the historical sentence
above does not exempt the copy from admission.

Scratch and isolated workspaces protect against ordinary relative writes; they
are not security sandboxes.

### Ticket RPC

```ts
delegate_ticket({ action: "poll", ticket? })
delegate_ticket({ action: "wait", ticket, timeoutMs? }) // timeoutMs removed by #130; waits park
delegate_ticket({ action: "pause" | "resume", ticket }) // removed from the model surface by #130; dashboard only
delegate_ticket({ action: "cancel", ticket, force? })
delegate_ticket({ action: "answer", ticket, taskId, questionId, answer })
```

**Current surface (SPEC.md, "Interaction grammar" and "Canonical
surface"):** the examples above retain the v2 record. The model-facing
actions are `poll`, `wait`, `cancel`, `answer`, `steer` and `interrupt`;
wait is unbounded. `pause`/`resume` are dashboard-only, and removed wait
fields reject rather than becoming optional legacy inputs.

- `poll` returns one ticket or the ticket roster.
- `wait` blocks until settlement (`timeoutMs` was removed by #130). Parent abort detaches the
  waiter; it does not cancel background work. A pending worker question also
  detaches the waiter immediately with the question visible, rather than
  deadlocking the parent who needs to answer it.
- `pause` (model-facing removal by #130; the /subagents `p` key still drives it) cooperatively stops queued tasks and future model turns, not current
  model/tool work or subprocesses.
- `resume` (model-facing removal by #130; dashboard only) continues the same ticket.
- `cancel` previews unless `force: true`; forced cancellation is cooperative
  and does not undo completed writes or commands.

Tickets remain pollable after settlement.

A poll on a running ticket shows live activity, not just a count of finished
tasks: each unfinished task's row names the tool call currently in flight —
or the `last:` completed one when between calls — its running tool count,
and how long ago it last emitted an event (`active now` / `active Ns ago`).
Queued tasks read `waiting…`; the view header totals active and queued
tasks and the tool calls recorded so far. Settled views show each task's
terminal state instead of live rows.

### Restart visibility

Async ticket identities, completed task outcomes (including full output), and
terminal results are saved under the resolved agent directory in owner-only
storage. On a new extension instance, poll, wait, and the roster expose saved
tickets without starting children or replaying delivery. A ticket last recorded
as running becomes terminal `interrupted`: its saved outcomes remain visible,
but unfinished tasks have unknown effects and are never restarted by polling,
waiting, or a new dispatch (`operationId` was removed by #130). Since #123 the interrupted outcome
carries the worker's transcript when it was journaled at claim time — recovery
renders the `session:` line and the same `resumeFrom` retry recipe a failed
outcome offers — but naming the file is a continuation affordance, never an
automatic resume; records written before claim-time journaling carry no
task-level pointer (their synthesized outcomes never hint; a settled outcome
that already carried a `sessionFile` keeps rendering it, as it always did).
A recovered terminal cancellation
with missing task outcomes or a recorded quarantined worker warns that tasks
may still have had effects, including in the roster when every outcome is
recorded; the terminal status alone does not prove their workers stopped. An
orderly session shutdown still cancels running tickets before it completes.
Recovered tickets cannot be
paused, resumed, answered, or cancelled; new tickets use fresh opaque ids.
No live write reservation is recovered: an orphaned subprocess may still be
mutating a shared tree after a process crash. Inspect it before new writes.

**Qualified (ADR 0001):** Delegate workers are permanently in-process and
do not survive host death or reconnect. The subprocess warning concerns
external commands/effects a worker may have launched, not a recoverable
Delegate worker. Recovered records own no live resources or delivery
rights (INVARIANTS.md, "Ticket state"). Roster listing is additionally
session-scoped by SPEC.md's #64 rule; an explicit ticket id still reaches
another owner's saved record.

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
waits, and a parent notification (waits no longer time out, #130). The worker's tool call waits for
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
watchdog; **Overridden (#118):** task deadlines were removed, so no wall-clock timer applies here. Cancellation and shutdown interrupt unanswered questions without resurrecting
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

**Added (SPEC.md, "Interrupt"):** a naturally settled batch whose tasks
all ended `interrupted` is `interrupted`. The historical summary above
does not collapse that state into failure or cancellation; forced ticket
cancellation still wins over later worker truth.

A singular ticket RPC (poll with a ticket id, wait, cancel; pause and resume are dashboard-only since #130)
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
- **Running-ticket views**: a poll or aborted wait (waits no longer time out, #130) on a running
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

A `wait` or `poll` that already returned the ticket's terminal view consumes
its pending delivery: the flush compares the exact view text the caller saw
with the view the wake would send and skips the ticket only on an identical
match, logging the skip to stderr (or to the diagnostics file when stderr is a terminal, #122; a record that gained content since the
render — late outcomes, notices (the budget account was removed by #129) — still delivers). A group
mixing consumed and unconsumed tickets delivers only the unconsumed ones.

- **Same leaf, no transition:** if the parent is still on the session-tree
  leaf where the ticket was dispatched and no shutdown or tree transition has
  been observed, the result is sent as a steering wake: on an idle parent it
  starts a new turn; on a busy parent it merges at the next turn boundary —
  after the current assistant turn's tool calls finish, before the next model
  call.
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
dispatches, force-cancels every running ticket with no delivered wake,
and then holds the shutdown until every worker's quiescence is confirmed (**Overridden by #52:** bounded to about 30s; see COMPATIBILITY.md, Known host limitations),
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
rejected calls and failed admission or preparation record nothing. **Overridden by SPEC.md, "Misfire rows":** a call rejected before execution writes a misfire row (see SPEC.md, misfire telemetry). For each
such dispatch it records the batch start timestamp and wall duration,
sync/async mode, task count, terminal call status, caller-visible task status,
agent/model/thinking/tools/workspace selections, integration status, retry
count, and numeric token/cost usage. Task records capture metadata and outcomes
at batch finish; v2 leaves the legacy per-task duration field NULL.
**Overridden by SPEC.md, "Task durations":** v3 records the admitted
span there. A task row
whose worker could not be confirmed stopped is marked provisional and may later
be superseded in the live ticket.

It never stores prompt, system-prompt, output, or error text (**Overridden by SPEC.md, "Misfire rows":** misfire rows keep the caller-visible rejection message verbatim, by design); cwd or session
paths (**Overridden by SPEC.md, "Misfire rows":** `misfires.parent_cwd` carries the parent's working directory as project-scope debugging signal; call/task path columns stay NULL); caller task IDs; operation IDs; or parent transcript content. Legacy v1
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

**Qualified (SPEC.md, "Resident idle bound"; INVARIANTS.md, "Session
reuse"):** `list` also includes unloaded records. `close` rejects while a
live or quarantined task owns the session; it does not authorize disposal
of possibly mutating work.

## Input recovery and errors

For compatibility with imperfect tool callers, Delegate silently repairs only
unambiguous shapes:

- a JSON-stringified task array;
- flat task fields wrapped into one task;
- `tools` supplied as a JSON array string or one bare token (**Overridden:** `tools` is removed by #130, so this repair went with it);
- `agent: ""`, treated as omitted;
- `null` on any field, treated as absent — top-level and inside tasks alike;
- a blank (`""` or whitespace-only) optional identifier, treated as absent:
  `operationId` (removed by #130), `ticket`, `sessionId`, `taskId`, `questionId`, and a task's
  `sessionId`, `cwd`, `resumeFrom`, or `agent`.

**Overridden (SPEC.md, "Canonical surface", #61/#118/#129/#130):** null
stripping and blank recovery apply only after removed/foreign field
presence guards. Null does not legalize a forbidden model/effort selector,
removed field or alias. A supplied malformed non-array `tasks` value
cannot be discarded in favor of flat recovery. Removed task
`tools`/`systemPrompt`, `operationId`, wait fields and `steerId` have no
recovery path.

It does not merge flat fields into an existing non-empty task array. A `tasks`
field that stays absent becomes `[]`, so `{}` still returns the manual. Blank
values that are not optional identifiers — task `id`, `prompt`,
`systemPrompt` (removed by #130), `dependsOn` entries, and ticket `answer` — remain present and
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

Fresh tasks in the shared workspace — and pooled `sessionId` sessions — write
their transcripts to `<agentDir>/delegate-sessions/` from the start, so a
failure does not lose the conversation. A failed or cancelled task that left
a durable transcript names it in the result as `session: <absolute path>`.
When the transcript carries messages, the failure also prints a copy-pasteable
`→ To retry:` hint whose `resumeFrom` continues that transcript; when it has
none (a worker that failed before its first prompt), the result reports
"no prior messages" instead and offers no hint — resuming an empty
conversation would pretend continuity that does not exist. Scratch and
isolated one-shot tasks keep memory-only transcripts: their filesystem is
disposable, so nothing is advertised as resumable.

Tasks dispatched with `resumeFrom` are marked `↻<tag>` — an 8-character tag
derived from the transcript filename — wherever tasks are listed: sync
result sections, running and settled ticket views, and cancel previews. The
tag is recorded on the ticket, so a cold-recovered poll shows the same
marker.

A transcript file has one owner at a time. A task resuming a transcript
(`resumeFrom`), or pointing at a live pooled session's durable file, rejects
while the owning worker is live — children write into resumed transcripts,
so a second owner would interleave writes into one file. Symlink aliases
canonicalize, so a link to a busy transcript rejects too. Two tasks in one
call never share a transcript: chain the work in separate calls or hand off
through the task prompt. The exclusivity lasts until the owning worker is
confirmed quiescent — not merely caller-settled — and releases with the
same reservation retention as every other admission conflict.

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

Stall timeouts measure inactivity; deadlines measure wall-clock time. **Overridden by #118:** no deadlines remain; the sentence below describes the removed rule.
The inactivity watchdog reads `stallTimeoutMs` from `delegate.json` — a
non-negative integer of milliseconds, default 900000 (15 minutes); `0`
disables detection. [Overridden by #118: no task deadline exists and `deadlineMs` rejects.] Deadlines exist only when the caller passes
`deadlineMs`. Omission means no
deadline: no configuration key, host default, or implicit budget may
introduce a wall-clock time limit.
Cancellation does not promise rollback or immediate termination. Delegate does
not reuse or clean up resources while they may still mutate state; resources
whose safety cannot be established remain unavailable.

# pi-delegate

Subagent dispatch for the [Pi coding agent](https://github.com/earendil-works/pi).
Delegate registers three tools: `delegate` runs one task or a batch of tasks;
`delegate_ticket` operates the durable ticket a backgrounded dispatch returns
(poll, wait, cancel, answer, steer, interrupt); `delegate_session` lists and
closes pooled subagent sessions. Tasks run against the shared tree, a disposable
copy, or a private Git worktree. `SPEC.md` is the v3 behavioral contract;
`COMPATIBILITY.md` records deliberate breaks from earlier versions.

## Quickstart

```ts
// One task or many — returns a background ticket; results arrive automatically.
delegate({
  tasks: [{ agent: "explore", prompt: "Map the authentication flow" }],
});

// A batch — asynchronous by default: returns a ticket immediately. When every
// task settles, the result wakes the parent once (tickets settling in the same
// window share one wake); if the conversation branch moved, it is durably
// appended instead. Either way it stays pollable.
delegate({
  tasks: [
    { prompt: "Implement the parser change", workspace: "isolated" },
    { prompt: "Update the parser tests", workspace: "isolated" },
  ],
});
```

`async: false` waits for inline results for any task count. Omitted `async`
always means background execution. `tasks: []` shows the manual.

Delegation is never automatic: the parent model decides whether to call
these tools, so a model that never calls them does all the work itself.

## One tool surface

There is one tool surface (ADR 0002). Every field and action in this README is
advertised and accepted; there is no compact or full mode to choose. A
`delegate.json` that still sets `surface` fails at load — remove the key and
`/reload`. Removed fields reject with an explanation rather than being ignored
(see Dispatch).

## Dispatch

A call resolves profiles, tools, workspaces and write claims before running
work. Task fields are `prompt` (required unless `resumeFrom`), `id` (optional
correlation key; unnamed tasks are `task-1`, `task-2`…), `agent`, `cwd`,
`sessionId`, `resumeFrom`, `workspace`, and `dependsOn`. The top-level
`workspace` is the default for tasks that do not set their own.

Each `prompt` and the top-level `brief` are capped at 32,768 characters.
Reference files by path instead of pasting their contents.

Tasks have no wall-clock deadline (#118): `deadlineMs` is removed and rejects
before execution, even when null. Stall detection remains an inactivity
watchdog (`stallTimeoutMs`). Cancel and interrupt stop work cooperatively.
Saved historical deadline failures remain readable.

Only canonical field names are accepted. Removed fields reject before any
worker starts, even when null or accompanied by the canonical field:
`description`, `systemPrompt`, `tools`, `operationId`, `steerId`, `deadlineMs`,
`tokenBudget` (batch spend is bounded by task count and concurrency, not a
caller budget), `timeoutMs`, and the cross-harness spellings `subagent_type`,
`agent_type`, `task_name`, `run_in_background`, `timeout_ms`, and a task-level
`message`. Each rejection says what to do instead. `model`, `thinking`, and
`reasoning_effort` are rejected wherever they appear: models and effort are
configured in `delegate.json`, never set by a call.

Top-level `brief` is shared batch context: it prepends to every task's prompt
inside a `--- batch brief ---` fence (task sections and headers note it once; it
never merges into the prompt's prose).

Delivery happens once, when the batch fully settles: tickets settling within the
same flush window coalesce into a single steering wake when the parent is still
on the dispatching branch — it starts a turn on an idle parent and merges at the
next turn boundary on a busy one — or a single durable append when the branch
moved or a navigation is in flight. A `wait` or `poll` that already returned the
same terminal view consumes the wake, so a result you already saw is not
delivered again. Delivery failure never undoes settlement — the ticket stays
pollable — and delivery suppressed at shutdown leaves it the same way.

Concurrency: `maxConcurrent` caps simultaneous tasks globally (default 8).
Per-model bounds work per model key — an exact `concurrency.models`
`provider/model` entry wins over `concurrency.providers.<provider>`, which wins
over `concurrency.default`, which falls back to `maxConcurrent`. Tasks over a
bound queue pending.

## Agents

Built-in profiles:

| Agent | Tools | Purpose |
| --- | --- | --- |
| `default` | mirrors the parent's delegatable tools | Mirrors the parent's model and thinking; the base prompt composes from the parent's user-authored prompt inputs. |
| `explore` | `read`, `grep`, `find`, `ls` | Read-only investigation; runs fully concurrently. |
| `coder` | `read`, `write`, `edit`, `bash` | Implementation in the shared workspace. |
| `reviewer` | `read`, `bash` | Review that can run checks — carries `bash`, so it serializes as a writer. |
| `verifier` | `read`, `bash` | Rules on a claim; its result carries a parsed `VERDICT:` line beside file evidence — reporting only, never gating. |

Agent names are exact and case-sensitive: built-ins or authored profiles,
without automatic translations. Unknown names list available profiles.

Markdown profiles come from `.pi/agents/*.md` under the working directory first,
then `<agentDir>/agents/*.md` — first definition wins; built-ins win name
collisions. Frontmatter requires `name` and `description` and may set `tools`,
`model`, `thinking`; the body is the system prompt. `.claude/agents` is never
imported. An authored `general.md` or `scout.md` is an ordinary exact-name
profile, not an alias. Profile tools and body are the only capability and
base-prompt selectors; there are no per-task overrides.

## Steering

`delegate_ticket({ ticket, action: "steer", message })` sends text to a running
task. `taskId` picks the target when several run; it defaults to the only running
task, and an ambiguous call errors naming the running ids. Each steer receipts
under a key derived from its own tool call, so a transport-level retry replays
the receipt instead of injecting the message twice. Receipts:

- `steered` — queued on a live run; the child sees it at the next turn boundary.
- `activated` — no run in flight (queued, between retries, pre-prompt); the
  message is parked and opens the task's next turn.
- `duplicate` — this steer already applied; nothing re-applies.
- `not-applied` — the task settled, the ticket was recovered, or nothing
  matches.

Steering is boundary delivery: the child's model receives the
message at run start or a turn boundary, never merged into a turn already
streaming. Parked steers void to `not-applied` if the task settles first;
recovered tickets always refuse steering. A whole-task retry re-supplies
the failed attempt's injected steers through the next attempt's first
turn — a receipted message is not dropped with the session that died.

## Safety and admission

Admission resolves physical Git roots and real tool sets before any subagent
starts. Tasks whose tools cannot mutate (e.g. `explore`) hold no write claims and
run fully concurrently. Shared writers touching the same repository serialize
in task order within one call. A call whose writer overlaps a still-running
dispatch from an earlier call is rejected before anything starts — there is no
unsafe-write bypass.

Workspaces:

- `shared` (default) — writes go to the real tree.
- `scratch` — the task runs in a disposable copy of the containing repository
  (reflink fast path where the filesystem supports it, full copy otherwise),
  discarded when it settles.
- `isolated` — a private detached Git worktree per task. Completed proposals
  reconcile into the source in task order, all-or-nothing; conflicts retain the
  proposal ref, full patch, and conflict worktree. Rejects repositories with
  submodules.

Both non-shared modes are one-shot: they reject `sessionId` and `resumeFrom`.

Completion evidence — results name the files each task touched: the union of
`write`/`edit`-observed paths and the changes a Git snapshot taken before and
after the run saw in the worker's repository (committed paths included via a
moved `HEAD`; ignored files are never covered). A shell run outside Git
coverage shows `files: unknown (shell used outside git)`, a covered window
that saw nothing shows no files line, a window that overlapped other writers
names them, and an `overlap:` note flags batch tasks that claimed the same
file. Evidence records observed changes only; it is not confinement and does
not prove other paths were untouched.

## Configuration

`delegate.json` in the agent directory (`DELEGATE_AGENT_DIR`, else Pi's
`PI_CODING_AGENT_DIR`, else `~/.pi/agent` in a normal install).
Unknown top-level keys are ignored; unknown keys inside the `telemetry`,
`sessions`, and `models`/`modelsByParent` blocks are rejected. Malformed
values fail loudly at the dispatch boundary. Retired v1 keys
(`agentOverrides`, `agentOverridesByParentModel`, `maxAsyncTickets`,
`allowUnsafeSharedWrites`) are among the ignored — a stale v1 config
silently does nothing; see `COMPATIBILITY.md` for the mapping.

| Key | Default | Meaning |
| --- | --- | --- |
| `maxConcurrent` | `8` | Global cap on simultaneous tasks. |
| `concurrency.default` | unset | Fallback in-flight bound. |
| `concurrency.providers` | `{}` | Per-provider bound, e.g. `{"anthropic": 2}`. |
| `concurrency.models` | `{}` | Per-model bound, e.g. `{"openai/gpt-5.2": 1}`; wins over provider and default. |
| `models` | `{}` | Model override per canonical agent, e.g. `{"coder": "openai/gpt-5.2"}`. No `default` entry — it mirrors the parent. Keys name built-ins and globally defined (`<agentDir>/agents`) profiles only; project `.pi/agents` profiles pin via their frontmatter `model:` instead. |
| `modelsByParent` | `{}` | `models` scoped by exact normalized parent `provider/model-id`; wins over `models`. |
| `stallTimeoutMs` | `900000` (15 min) | Inactivity watchdog: no session events for this long aborts the task. `0` disables. |
| `sessions.maxIdle` | `4` | Idle pooled sessions kept resident in memory; beyond the bound the least-recently-idle unloads to its transcript and reloads on next use. `0` unloads every settled session. |
| `telemetry.enabled` | `false` | Record dispatches in a local SQLite file. |
| `telemetry.dbPath` | unset | Store location; falls back to `DELEGATE_TELEMETRY_DB`, then `<agentDir>/delegate-usage.db`. |
| `providerExtensions` | `{"openai-codex": ["npm:@bermudi/pi-codex"]}` | Per-provider user-scope packages injected into that provider's subagents (e.g. `{"openai-codex": ["npm:@bermudi/pi-codex"]}`). A listed provider's array replaces the shipped default for that provider and its sources are required — missing or unverifiable, the dispatch fails. Providers never listed fall back to shipped defaults, which degrade silently to extension-free children. Empty arrays are ignored. |
| `output.spillThresholdChars` | `8000` | Characters before a result spills to a file. |
| `output.spillTailChars` | `2000` | Tail kept inline on spill. |

Telemetry writes a `calls` row per dispatch plus a `tasks` row per task —
durations, token counts and cost, tool mix, workspace, outcome — and a
`misfires` row per dispatch rejected before execution (config-load failures,
validation errors including unknown agent names, and admission rejects) with
the phase, the verbatim caller-visible message, and the batch shape. The store
stays on the local machine; recording is fail-open, so a broken database logs
and disables telemetry without changing delegation results. Inspect with
`sqlite3 <db> 'SELECT * FROM calls'` (or `tasks` / `misfires`).

## Tickets

`delegate_ticket({ ticket, action, ... })` operates on a ticket. Its actions are
`poll`, `wait`, `cancel`, `answer`, `steer`, and `interrupt`. Any other action
name is rejected with that list.

- `poll` — this session's ticket roster, or one ticket's task list and
  settled results.
- `wait` — parks until the ticket settles, a worker asks a question, or an
  interruption arrives. Waits are unbounded; detaching never affects the task,
  and delivered results arrive on their own, so polling is enough if you would
  rather move on.
- `cancel` — the first call previews what would stop and warns that writes and
  commands are not rolled back; `force: true` terminates the ticket and asks
  workers to abort.
- `answer` — reply to a worker question (see below).
- `steer` — send text to a running task (see Steering).
- `interrupt` — abort one task's in-flight turn cooperatively (`taskId`
  defaults to the only still-running task). The task settles
  `interrupted`, not `cancelled`: a pooled session returns reusable, a
  fresh task keeps its transcript and a `resumeFrom` hint. A settled,
  already-interrupted, or not-yet-running target receipts `not-applied`.

Pause and resume are not model-facing. They are operator controls in the
`/subagents` dashboard, and the tool rejects `pause` and `resume` with a pointer
to `wait` and `cancel`. A paused task keeps its execution slot, session, and
workspace reservation by design — paused remains running (INVARIANTS) — so a
small `maxConcurrent` can be starved by a long-paused ticket; resuming it frees
the slot.

Tickets are durable journals under `<agentDir>/delegate-tickets/` with
owner-only permissions. Settled outcomes are recoverable after a restart via
`poll`/`wait`; a snapshot that was running recovers as `interrupted` — running
work is never resumed automatically. Delivered wakes do not survive restart;
only the recorded outcomes do. The bare roster and unknown-ticket hints list
only the current session's tickets — records owned by sibling sessions stay
readable by explicit id and are counted in a trailing note.

## Worker questions

A subagent's `ask_parent` call parks that task — sibling tasks keep running —
and surfaces the question in the ticket view plus an immediate delivery to the
parent (a wake on the same branch, a durable append otherwise).
`delegate_ticket({ action: "answer", ticket, taskId, questionId, answer })`
releases it. Only ticket tasks carry `ask_parent`; on a synchronous run the
tool is not offered. One unanswered question per task. Questions are
in-memory only — a restart interrupts the waiting task like any other running
work.

## Sessions

A task with `sessionId` keeps its subagent conversation pooled; a later task
reusing the id continues the same conversation. Idle residents are bounded by
`sessions.maxIdle` — over the bound, the least-recently-idle session unloads to
its transcript file and the next reuse transparently reloads it; a running
session is never evicted. `delegate_session` `list` shows pooled sessions
(resident and on-disk) and `close` shuts one down. Pooled sessions end with the
parent process; `resumeFrom` instead rehydrates a session from a prior `.jsonl`
transcript.

## Parent conversation isolation

Children do not share the parent's conversation. The child system prompt is a
Markdown profile's body, verbatim, when the profile has one; otherwise —
including the built-in profiles — it is composed from the parent's
user-authored prompt inputs plus a subagent framing.
Project context files under the task's cwd are kept; user-global context files
are excluded. Children run with an in-memory settings profile and no parent
extensions, no parent history or transcript tail, and no MCP tools from the
parent. One exception is `providerExtensions`: a provider's subagents may load
the packages configured for that provider (the shipped default gives
`openai-codex` children a companion package, best-effort — see Configuration).
No delegate tools are ever available to children — `delegate`,
`delegate_ticket`, and `delegate_session` are stripped from every child toolset
(explicit `tools`, profile frontmatter, and the mirrored parent set alike), so
subagents never nest dispatches.

## Develop

```bash
bun install
bun run typecheck
bun test
```

The extension entry point is `delegate.ts`; `package.json` exposes it via
`pi.extensions` for local development.

## Operational diagnostics

Delegate does not print diagnostics over Pi's terminal UI. When stderr is
terminal-attached, error/warn/info records append to
`<agentDir>/delegate-diagnostics/<pid>.jsonl` (directory 0700, file 0600).
`agentDir` here means nonempty `DELEGATE_AGENT_DIR`, otherwise Pi's public
`getAgentDir()` (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), independent of any
context/session/cwd fallback used for configuration. Print mode also logs to
this file if stderr is still attached to the terminal. With redirected/piped
stderr, all levels go to stderr instead; diagnostic stdout is never used.

If the primary path is blocked or insecure, the private fallback is
`<system-temp>/pi-delegate-diagnostics-<uid>-<pid>/<pid>.jsonl`; its records
include safe primary-failure context. Existing symlinks, insecure permissions,
foreign ownership, and linked log files are rejected, never silently repaired.
If both secure destinations fail, work and cleanup still finish. Delegate
reports a safe warning through Pi's managed notices and the next public tool
result, including the primary path/operation and both failure codes. Failed
notices remain visible in the result warning; logs never fall back to the
attached terminal. Startup, recovery, telemetry and cancellation remain
noninterfering even when neither destination is writable. The warning also rides
cloned per-return `details.diagnosticWarning`, visible in collapsed/expanded tool
views and history replay; it never contaminates cached operation/ticket results.

Whole directory components `delegate-diagnostics` and
`pi-delegate-diagnostics-<numeric uid>-<numeric pid>` are reserved runtime trees
anywhere under source. Both worker-copy kinds, private Git snapshots, and
source-drift/file-attribution evidence omit them and existing symlink aliases,
regardless of the engine's agent directory. Retained fallback trees are covered;
ordinary names such as `delegate-diagnostics.md` or
`pi-delegate-diagnostics-guide` remain source. Historical Git objects already in
your repository are not scrubbed.

Secure file routing is currently Linux-only and requires user-id and no-follow
filesystem capabilities. Other attached platforms report a managed unsupported
warning rather than crashing; foreign filesystem behavior has not been verified.
Headless/piped stderr remains available on every platform.

Records are bounded JSON events with operational metadata and safe error
class/code, not raw errors/stacks, provider payloads, or task/profile/question/
answer/steering contents. Logs are append-only, with no rotation or automatic
cleanup; remove old process logs when no longer needed.

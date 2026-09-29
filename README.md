# pi-delegate

Subagent dispatch for the [Pi coding agent](https://github.com/earendil-works/pi).
Delegate registers three tools: `delegate` runs one task or a batch of tasks;
`delegate_ticket` operates the durable ticket a backgrounded dispatch returns
(poll, wait, cancel, interrupt, pause, resume, answer, steer, tail);
`delegate_session` lists and
closes pooled subagent sessions. Tasks run against the shared tree, a disposable
copy, or a private Git worktree. `SPEC.md` is the v3 behavioral contract;
`COMPATIBILITY.md` records deliberate v2→v3 breaks.

## Quickstart

```ts
// One task — synchronous by default: blocks until it settles and returns inline.
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

`async` overrides either default: `async: true` backgrounds a single task;
`async: false` blocks on a batch.

## Dispatch

A call resolves each task's agent, tools, workspace, and claims, then admits and
runs the batch in task order. Task fields: `prompt` (required), `id` (auto
`task-1`…), `agent`, `cwd` (defaults to the parent cwd), `systemPrompt`, `tools`,
`sessionId`, `resumeFrom`, `deadlineMs`, `workspace`, `dependsOn`. Top-level
`workspace` defaults the batch's mode for tasks that don't name their own, and
top-level `operationId` deduplicates the whole call against retries.
Cross-harness spellings are accepted and normalized at validation —
`subagent_type`/`agent_type` → `agent` (aliases still apply),
`task_name` → `id`, `message` beside task-shaped fields → `prompt`,
`description` (≤200 chars)
labels the task in call rows and section headers, `run_in_background`
(top-level or per task) → `async`, and `context` → `brief`; each applied
rename is reported on the result (`field "subagent_type" → "agent"`),
conflicting spellings error, and unknown fields still fail
(`additionalProperties: false`). A bare `message` without task shape is
steer-shaped — the call is rejected with guidance toward
`delegate_ticket`, and caller-supplied `model`, `thinking`, or
`reasoning_effort` reject likewise: models and effort are configured,
never call arguments. Top-level `brief` is shared batch
context: it prepends to every task's prompt inside a `--- batch brief ---`
fence (task sections and headers note it once; it never merges into the
prompt's prose). Top-level `tokenBudget` (positive integer) caps the
batch's recorded token usage: settled tasks charge their usage to it, and
once the ceiling is reached queued tasks settle `budget-exhausted`
instead of starting — tasks already running always finish, and dependents
of an exhausted task block naming the budget. Result and ticket headers
report `token budget: consumed/limit`, `details.tokenBudget` carries
`{limit, consumed, exhaustedAt}`, and the dispatch's telemetry row
records the account.

Delivery happens once, when the batch fully settles: tickets settling within the
same flush window coalesce into a single follow-up wake when the parent is still
on the dispatching branch — it wakes an idle parent and queues behind a busy
one — or a single durable append when the branch moved or a navigation is in
flight. Delivery failure never undoes settlement — the ticket stays pollable —
and delivery suppressed at shutdown leaves it the same way.

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

Aliases expand to a canonical built-in, and the expansion is named in the
result: `general`, `general-purpose`, `worker` → `default`; `explorer`,
`plan`, `scout` → `explore`; `implement` → `coder`. Matching is exact and
case-sensitive.

Markdown profiles come from `.pi/agents/*.md` under the working directory first,
then `<agentDir>/agents/*.md` — first definition wins; built-ins win name
collisions. Frontmatter requires `name` and `description` and may set `tools`,
`model`, `thinking`; the body is the system prompt. `.claude/agents` is never
imported. A discovered profile claims its exact name ahead of the alias
table — a `general.md` is your agent, not the `general` → `default` alias.

## Steering

`delegate_ticket({ ticket, action: "steer", message, steerId })` sends text to a
running task; `taskId` picks the target when several run (it defaults to the
only running task, and an ambiguous call errors naming the running ids).
`steerId` is optional — omitted, the receipt names a `steer:<tool-call-id>`
key derived from the tool call itself, so a transport-level retry dedupes
instead of re-injecting.
Receipts:

- `steered` — queued on a live run; the child sees it at the next turn boundary.
- `activated` — no run in flight (queued, between retries, pre-prompt); the
  message is parked and opens the task's next turn.
- `duplicate` — this `steerId` already applied an identical steer; nothing
  re-applies.
- `not-applied` — the task settled, the ticket was recovered, or nothing
  matches.

Reusing `steerId` with a different task or message is a conflict error naming
both attempts. Steering is boundary delivery: the child's model receives the
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

Completion evidence — results name the files each task touched: ordered,
deduplicated paths observed on `write`/`edit` calls, resolved against the task
cwd, plus a `files: uncertain (bash)` marker when shell commands ran and an
`overlap:` note when batch tasks claimed the same file. Evidence records
observed calls only; it is not confinement and does not prove other paths were
untouched.

## Configuration

`delegate.json` in the agent directory (`PI_AGENT_DIR` or `~/.pi/agent`).
Unknown top-level keys are ignored; unknown keys inside the `telemetry`,
`sessions`, and `models`/`modelsByParent` blocks are rejected. Malformed
values fail loudly at the dispatch boundary.

| Key | Default | Meaning |
| --- | --- | --- |
| `maxConcurrent` | `8` | Global cap on simultaneous tasks. |
| `concurrency.default` | unset | Fallback in-flight bound. |
| `concurrency.providers` | `{}` | Per-provider bound, e.g. `{"anthropic": 2}`. |
| `concurrency.models` | `{}` | Per-model bound, e.g. `{"openai/gpt-5.2": 1}`; wins over provider and default. |
| `models` | `{}` | Model override per canonical agent, e.g. `{"coder": "openai/gpt-5.2"}`. No `default` entry — it mirrors the parent. |
| `modelsByParent` | `{}` | `models` scoped by exact normalized parent `provider/model-id`; wins over `models`. |
| `stallTimeoutMs` | `900000` (15 min) | Inactivity watchdog: no session events for this long aborts the task. `0` disables. |
| `sessions.maxIdle` | `4` | Idle pooled sessions kept resident in memory; beyond the bound the least-recently-idle unloads to its transcript and reloads on next use. `0` unloads every settled session. |
| `telemetry.enabled` | `false` | Record dispatches in a local SQLite file. |
| `telemetry.dbPath` | unset | Store location; falls back to `DELEGATE_TELEMETRY_DB`, then `<agentDir>/delegate-usage.db`. |
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

`delegate_ticket({ ticket, action, ... })` operates on a ticket:

- `poll` — the ticket roster, or one ticket's task list and settled results.
- `wait` — block until the ticket settles; `timeoutMs` bounds the wait (unset
  means wait for settlement; `timeout_ms` is the same field and reports the
  rename). A `tickets` array watches several and returns when the first
  watched ticket settles — a one-id list folds into the single-ticket wait.
  Timing out or detaching never affects the task.
- `cancel` — the first call previews what would stop and warns that writes and
  commands are not rolled back; `force: true` terminates the ticket and asks
  workers to abort.
- `pause` / `resume` — cooperative pause at a turn boundary; the current model
  response and tool calls finish first.
- `answer` — reply to a worker question (see below).
- `steer` — send text to a running task (see Steering).
- `interrupt` — abort one task's in-flight turn cooperatively (`taskId`
  defaults to the only still-running task). The task settles
  `interrupted`, not `cancelled`: a pooled session returns reusable, a
  fresh task keeps its transcript and a `resumeFrom` hint. A settled,
  already-interrupted, or not-yet-running target receipts `not-applied`.
- `tail` — a bounded, incremental read of one task's assistant output
  (`taskId` defaults to the ticket's only unsettled or only task and is
  required when several ran).
  `offset` is a char cursor that clamps when out of range; the reply
  carries the chunk plus a `nextOffset` cursor for the following read.
  `waitMs` bounds a park that resolves early when new output lands or the
  task settles — omitted or `0` is a pure snapshot.

Tickets are durable journals under `<agentDir>/delegate-tickets/` with
owner-only permissions. Settled outcomes are recoverable after a restart via
`poll`/`wait`; a snapshot that was running recovers as `interrupted` — running
work is never resumed automatically. `operationId` deduplication and delivered
wakes do not survive restart; only the recorded outcomes do.

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

Children do not share the parent's conversation. The child system prompt is an
authored `systemPrompt` or Markdown profile body verbatim when present;
otherwise the parent's user-authored prompt inputs plus a subagent framing.
Project context files under the task's cwd are kept; user-global context files
are excluded. Children run with no extensions and an in-memory settings
profile: no parent extensions or MCP tools, no parent history or transcript
tail, and no delegate tools of their own — `delegate`, `delegate_ticket`, and
`delegate_session` are stripped from every child toolset (explicit `tools`,
profile frontmatter, and the mirrored parent set alike), so subagents never
nest dispatches.

## Develop

```bash
bun install
bun run typecheck
bun test
```

The extension entry point is `delegate.ts`; `package.json` exposes it via
`pi.extensions` for local development.

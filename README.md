# pi-delegate

Subagent dispatch for the [Pi coding agent](https://github.com/earendil-works/pi).
Delegate registers three tools: `delegate` runs one task or a batch of tasks;
`delegate_ticket` operates the durable ticket a backgrounded dispatch returns
(poll, wait, cancel, pause, resume, answer, steer); `delegate_session` lists and
closes pooled subagent sessions. Tasks run against the shared tree, a disposable
copy, or a private Git worktree. `SPEC.md` is the v3 behavioral contract;
`COMPATIBILITY.md` records deliberate v2→v3 breaks.

## Quickstart

```ts
// One task — synchronous by default: blocks until it settles and returns inline.
delegate({
  tasks: [{ agent: "scout", prompt: "Map the authentication flow" }],
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

Delivery happens once, when the batch fully settles: tickets settling within the
same flush window coalesce into a single follow-up wake when the parent is still
on the dispatching branch — it wakes an idle parent and queues behind a busy
one — or a single durable append when the branch moved or a navigation is in
flight. Delivery failure never undoes settlement — the ticket stays pollable —
and delivery suppressed at shutdown leaves it the same way.

Concurrency: `maxConcurrent` caps simultaneous tasks globally (default 3).
Per-model bounds work per model key — an exact `concurrency.models`
`provider/model` entry wins over `concurrency.providers.<provider>`, which wins
over `concurrency.default`, which falls back to `maxConcurrent`. Tasks over a
bound queue pending.

## Agents

Built-in profiles:

| Agent | Tools | Purpose |
| --- | --- | --- |
| `default` | mirrors the parent's delegatable tools | Mirrors the parent's model and thinking; the base prompt composes from the parent's user-authored prompt inputs. |
| `scout` | `read`, `grep`, `find`, `ls` | Read-only investigation; runs fully concurrently. |
| `coder` | `read`, `write`, `edit`, `bash` | Implementation in the shared workspace. |
| `reviewer` | `read`, `bash` | Review that can run checks — carries `bash`, so it serializes as a writer. |

Aliases expand to a canonical built-in, and the expansion is named in the
result: `general`, `general-purpose`, `worker` → `default`; `explore`, `plan` →
`scout`; `implement` → `coder`. Matching is exact and case-sensitive.

Markdown profiles come from `.pi/agents/*.md` under the working directory first,
then `<agentDir>/agents/*.md` — first definition wins; built-ins win name
collisions. Frontmatter requires `name` and `description` and may set `tools`,
`model`, `thinking`; the body is the system prompt. `.claude/agents` is never
imported.

## Steering

`delegate_ticket({ ticket, action: "steer", message, steerId })` sends text to a
running task; `taskId` picks the target when several run (it defaults to the
only running task, and an ambiguous call errors naming the running ids).
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
recovered tickets always refuse steering.

## Safety and admission

Admission resolves physical Git roots and real tool sets before any subagent
starts. Tasks whose tools cannot mutate (e.g. `scout`) hold no write claims and
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
Unknown keys and malformed values fail loudly at the dispatch boundary.

| Key | Default | Meaning |
| --- | --- | --- |
| `maxConcurrent` | `3` | Global cap on simultaneous tasks. |
| `concurrency.default` | unset | Fallback in-flight bound. |
| `concurrency.providers` | `{}` | Per-provider bound, e.g. `{"anthropic": 2}`. |
| `concurrency.models` | `{}` | Per-model bound, e.g. `{"openai/gpt-5.2": 1}`; wins over provider and default. |
| `models` | `{}` | Model override per canonical agent, e.g. `{"coder": "openai/gpt-5.2"}`. No `default` entry — it mirrors the parent. |
| `modelsByParent` | `{}` | `models` scoped by exact normalized parent `provider/model-id`; wins over `models`. |
| `stallTimeoutMs` | `900000` (15 min) | Inactivity watchdog: no session events for this long aborts the task. `0` disables. |
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
  means wait for settlement). Timing out or detaching never affects the task.
- `cancel` — the first call previews what would stop and warns that writes and
  commands are not rolled back; `force: true` terminates the ticket and asks
  workers to abort.
- `pause` / `resume` — cooperative pause at a turn boundary; the current model
  response and tool calls finish first.
- `answer` — reply to a worker question (see below).
- `steer` — send text to a running task (see Steering).

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

A task with `sessionId` keeps its subagent conversation pooled in memory; a
later task reusing the id continues the same conversation. `delegate_session`
`list` shows pooled sessions and `close` shuts one down. Pooled sessions end
with the parent process; `resumeFrom` instead rehydrates a session from a prior
`.jsonl` transcript.

## Parent conversation isolation

Children do not share the parent's conversation. The child system prompt is an
authored `systemPrompt` or Markdown profile body verbatim when present;
otherwise the parent's user-authored prompt inputs plus a subagent framing.
Project context files under the task's cwd are kept; user-global context files
are excluded. Children run with no extensions and an in-memory settings
profile: no parent extensions or MCP tools, no parent history or transcript
tail, and no delegate tools of their own.

## Develop

```bash
bun install
bun run typecheck
bun test
```

The extension entry point is `delegate.ts`; `package.json` exposes it via
`pi.extensions` for local development.

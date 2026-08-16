# CONTEXT.md — domain glossary

Names for the concepts that draw good seams in pi-delegate. Architecture
reviews and design discussions use these terms; add a term here when a
deepened module or seam gets a name, so future explorers share the vocabulary.

## Agents

**Custom agent** — a subagent profile defined by the parent. It can be shaped
inline in a delegate task (`systemPrompt`, `tools`, and `thinking`) or persisted
as a Markdown file. The model chooses the subagent it needs for each call;
Markdown agents are examples of custom agents. The subagent inherits the parent
model by default; a custom `model` override is a rare, deliberate escape hatch.

**Markdown agent** / **Named agent** — a custom agent persisted as a Markdown
file with YAML frontmatter. Discovered from `.pi/agents/` (project),
`~/.pi/agent/agents/` (global), legacy `~/.agents/`, and `.claude/agents/`.

## Sessions & the pool

**Pooled session** — a live `AgentSession` retained for reuse across prompts,
keyed by a caller-chosen `sessionId`. Carries a **frozen config**.

**Frozen config** — the immutable `{ systemPrompt, model, thinking, tools, cwd }`
captured when a session enters the pool. A later reuse must match on
`{ cwd, thinking, tools }`; explicitly requested model or base-prompt changes
must also match, while omitted values continue the frozen session. Mismatch
rejection is a **pool invariant**, not caller policy — the pool enforces it
and returns a structured diff; the caller only formats the error.

**SessionPool** — the module (`pool.ts`) owning pooled-session _state and
policy_: the session map, the per-session serialization lock, freeze-on-insert,
validate-on-reuse, insert-only-on-success, stats-on-hit, explicit close, and
parent-shutdown cleanup. Its seam is a small set of behavioral operations
(`checkout`, `commit`, `configFor`, `close`, `closeAll`, `list`,
`withSessionLock`); the raw map is private and is **not** part of the public
barrel.

**Session materialization** — acquiring a usable `AgentSession` for a task by
one of three paths: **pool hit** (reuse), **resume** (open a prior `.jsonl`),
or **fresh** (create). This is _not_ the SessionPool's concern — it needs host
deps (`host.ts`), session persistence (`sessions.ts`), the SDK
(`createAgentSession` / `SessionManager`), and `fs`. It lives in `lifecycle.ts`
(`acquireAgentSession`), which orchestrates against the SessionPool.

> **Do not fold materialization into the pool.** Doing so makes the pool
> shallow by widening its interface with every materialization dependency
> (host deps, SDK, fs), rather than deep. The pool's depth comes from owning
> _policy_ behind a narrow interface; materialization is a separate concern
> that legitimately spans several modules. A future review that re-suggests
> "make `acquire(task)` the pool's interface" should re-read this before
> proceeding.

**Quiescence barrier** — the module (`quiescence.ts`) that decides when a
subagent `AgentSession` is actually done, so lifecycle may dispose or re-pool
it. Pi awaits `agent_settled` handlers but not the detached work they start
(`ctx.compact()` is fire-and-forget), and exposes no pending-extension-work
primitive, so the barrier waits for **stability** — idle, non-compacting, and
event-quiet across N consecutive event-loop turns — instead of completion. Its
seam is three operations (`noteEvent`, `noteCancellationRequested`, `wait`)
over two observed flags.

**Cancelled unwind** — the barrier's bounded mode. Once cancellation has been
requested the session should be tearing down, so the wait is capped and expiry
yields `"abandoned"`; a healthy wait is unbounded and relies on the stall
watchdog instead. The bound exists because a hung barrier is worse than a
cancelled task whose session may still be active.

## Dispatch & tickets

**Resolved task** — a `TaskDef` fully resolved into `{ cwd, systemPrompt, model,
tools, thinking, prompt, agentName, warnings }`. Produced by `resolveTasks`;
consumed by the dispatch/lifecycle path.

**Async ticket** — a fire-and-forget background batch. Spawns, returns a ticket
id immediately, and delivers results via `sendMessage` when all tasks settle.
Poll/cancel/wait are top-level `ticketAction` values. Lives in `tickets.ts`.

**Leaf affinity** — the session-tree leaf a ticket was spawned on
(`spawnLeafId`, tracked in `leaf.ts`). `/tree` navigation happens inside the
same session, so a live ticket survives it; delivering with `triggerTurn` would
then wake the agent on a branch that never asked for the work. A cross-leaf
ticket is delivered with `deliverAs: "nextTurn"` and announced to the human
instead.

## Telemetry

**Telemetry call span** — one row in `calls` per `execute()` return path. Created
in `extension.ts` and finished by the dispatch/short-circuit path. Sync calls
write a single terminal row; async calls write a spawn row (`status='running'`)
that is updated when the ticket settles (or cancelled on shutdown).

**Telemetry task row** — one row in `tasks` per completed `runResolvedTask`.
Written at the final `finishTask()` in `lifecycle.ts` after `failureKind`,
duration, tokens, and retries are settled. Never contains prompt/output text;
only `prompt_chars` / `output_chars` and a `session_file` pointer to the
subagent `.jsonl`.

The SQLite store is in `~/.pi/agent/delegate-usage.db` by default (overridable
via `delegate.json` `telemetry.dbPath`), uses WAL mode with a 5s busy timeout,
and is fail-open: any write failure disables the backend for the process.
`node:sqlite` is not available under Bun, so tests always inject the in-memory
recorder via `_setTelemetryForTesting`. Example queries:

```sql
-- success rate by version
SELECT version, ROUND(SUM(outcome='success')*100.0/COUNT(*),1) pct, COUNT(*) n
FROM tasks GROUP BY version ORDER BY MAX(ts) DESC;

-- failure-kind breakdown by version
SELECT version, failure_kind, COUNT(*) FROM tasks
WHERE outcome='failed' GROUP BY version, failure_kind;

-- per-model stall / retry behavior
SELECT model, COUNT(*), SUM(failure_kind='stalled') stalls, AVG(retries)
FROM tasks GROUP BY model;

-- token / cost trend by version
SELECT version, SUM(tokens), SUM(cost) FROM tasks GROUP BY version;
```

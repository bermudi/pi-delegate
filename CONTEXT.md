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
`{ cwd, thinking, tools }` (model is inherited, not re-compared). Mismatch
rejection is a **pool invariant**, not caller policy — the pool enforces it
and returns a structured diff; the caller only formats the error.

**SessionPool** — the module (`pool.ts`) owning pooled-session *state and
policy*: the session map, the per-session serialization lock, freeze-on-insert,
validate-on-reuse, insert-only-on-success, stats-on-hit, and TTL eviction.
Its seam is a small set of behavioral operations (`lookup`, `configFor`,
`insert`, `recordUse`, `close`, `sweep`, `list`, `withSessionLock`); the raw
map is private and is **not** part of the public barrel.

**Session materialization** — acquiring a usable `AgentSession` for a task by
one of three paths: **pool hit** (reuse), **resume** (open a prior `.jsonl`),
or **fresh** (create). This is *not* the SessionPool's concern — it needs host
deps (`host.ts`), session persistence (`sessions.ts`), the SDK
(`createAgentSession` / `SessionManager`), and `fs`. It lives in `lifecycle.ts`
(`acquireAgentSession`), which orchestrates against the SessionPool.

> **Do not fold materialization into the pool.** Doing so makes the pool
> shallow by widening its interface with every materialization dependency
> (host deps, SDK, fs), rather than deep. The pool's depth comes from owning
> *policy* behind a narrow interface; materialization is a separate concern
> that legitimately spans several modules. A future review that re-suggests
> "make `acquire(task)` the pool's interface" should re-read this before
> proceeding.

## Dispatch & tickets

**Resolved task** — a `TaskDef` fully resolved into `{ cwd, systemPrompt, model,
tools, thinking, prompt, agentName, warnings }`. Produced by `resolveTasks`;
consumed by the dispatch/lifecycle path.

**Async ticket** — a fire-and-forget background batch. Spawns, returns a ticket
id immediately, and delivers results via `sendMessage` when all tasks settle.
Poll/cancel are top-level `action` values. Lives in `tickets.ts`.

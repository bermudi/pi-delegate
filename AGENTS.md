# AGENTS.md

## Project

A delegate tool extension for the [Pi](https://github.com/earendil-works/pi) coding agent. Spawns subagents to run tasks in parallel — with async ticketing, session pooling, retries, and per-model concurrency limits. Deployed as a bundled single-file extension symlinked into Pi's global extensions dir.

## Stack

TypeScript (strict), Bun, esbuild. Bundles into a single file that runs in Pi's Node process — external packages (`pi-agent-core`, `pi-ai`, `pi-tui`) are shared with the parent. Tests use `@marcfargas/pi-test-harness` (Pi-specific). `@sinclair/typebox` for schema validation.

## Architecture

This is **not a standalone app** — it's a Pi extension. Entry points:

- **`delegate.ts`** — public API surface (barrel re-exports). The build entry point.
- **`extension.ts`** — thin tool-definition orchestrator. Wires `registerTool` and dispatches `execute` to the focused modules below; owns only the poll/cancel/help short-circuits and the session-shutdown handler.
- **`schema.ts`** — `delegateArgumentsSchema` (single source of truth — `DelegateArguments`/`TaskDef` in `types.ts` are `Static<>` projections) plus `validateDelegateOperation` (semantic validation after normalization) and `normalizeDelegateArguments` (pre-validation shim recovering malformed shapes weaker models emit: stringified `tasks` arrays, task fields flattened to the top level → wrapped into a single task, stringified/bare-token `tools`). Without flat-field recovery, a malformed call silently degrades to the manual and models misread that as "the tool is broken".
- **`usage.ts`** — nested-model usage accounting: snapshots cumulative `AgentSession.getSessionStats()`, computes per-task deltas, and aggregates `Usage` for the sync tool result. Pi 0.81+ persists the top-level `usage` on the toolResult message and folds it into the parent footer/session totals. The per-task `tokens` (display, from `extractUsage` over `session.messages`) and the parent-reported `usage` (from `getSessionStats`, compaction-inclusive) intentionally diverge under compaction.
- **`manual.ts`** — schema-driven help generation and the dynamic configured-agent list.
- **`task-resolution.ts`** — `validateTasks` (duplicate sessions, busy conflicts, unknown agents) and `resolveTasks` (agent/model/tools/system-prompt resolution per task).
- **`dispatch.ts`** — `initProgress`, `makeFireUpdater`, `dispatchAsync`, `dispatchSync`. Sync/async execution orchestration.
- **`lifecycle.ts`** — per-task execution: resolves a usable `AgentSession` (pool hit / resume-from-`.jsonl` / fresh), runs the prompt via `runner.ts`, and commits the outcome. Owns session **materialization** and the whole-task retry loop.
- **`runner.ts`** — drives one `AgentSession.prompt()`, maps Pi events to progress, accounts usage/files, and owns inactivity detection. Stall cancellation is cooperative: it calls `AgentSession.abort()` and waits for the session to become idle rather than returning while a provider/tool may still mutate files.
- **`pool.ts`** — the **SessionPool**: a deep module owning pooled-session state + policy (freeze-on-insert, validate-on-reuse, insert-on-success, stats, explicit close/shutdown cleanup, per-`sessionId` lock) behind `checkout` / `commit` / `configFor`. The raw `Map` is private; the public barrel exposes behavior, not state. See `docs/adr/0001` + `CONTEXT.md`.
- **`render-result.ts`** + **`render-branches.ts`** — TUI rendering. `renderDelegateCall` (minimal call display) and `renderDelegateResult` (skeleton + spinner lifecycle) live in `render-result.ts`; the heavy partial/final progress trees live in `render-branches.ts`.
- **`delegate.bundle.ts`** — esbuild output. Never edit by hand.

**Key architectural decisions:**

- **Subagents run without extensions.** Host deps are built with `noExtensions: true`. Subagents must not run the parent's interactive extensions — this closes cross-wiring risks and keeps headless workers headless.
- **Host deps are cached** per `(cwd, systemPrompt)`. `ModelRuntime` (the unified model+auth runtime), `SettingsManager`, and `ResourceLoader` are built once and shared across subagents with the same profile. The `ModelRuntime` is built with `allowModelNetwork: false` — subagents receive an explicit model (resolved by the parent) and never need remote catalog discovery, so the first call per cwd skips the network availability refresh (faster, offline-safe); auth (`getAuth`) still reads `~/.pi/agent/auth.json` directly. Since pi 0.80.8, `createAgentSession` takes a single `modelRuntime` in place of the removed `authStorage`/`modelRegistry` options; the parent's `ctx.modelRegistry` (a sync facade over its own runtime) remains the source for model selection and its runtime-only provider registrations are copied into the child runtime. Extensions themselves remain disabled.
- **Session pooling** is a deep module (`pool.ts`): live `AgentSession`s keyed by `sessionId`, behind a small interface (`checkout` / `commit` / `configFor`). The pool owns **policy** (freeze-on-insert, validate-on-reuse, insert-on-success, stats, explicit close/shutdown cleanup); **session materialization** (pool-hit reuse / resume / fresh-create) lives in `lifecycle.ts`. Sessions stay live until close or parent shutdown. See `docs/adr/0001` + `CONTEXT.md` — don't fold materialization into the pool.
- **Host-compat guard** (`host-compat.ts`): the bundle imports pi internals from the package root, and pi can drop/rename a symbol on any bump — jiti then silently turns the named import into `undefined`, crashing as a cryptic `Cannot read properties of undefined (reading 'create')` (this is exactly what broke delegation across pi 0.80.3→0.80.8). `hostCompatError()` runs once per process (cached) at the top of `execute`'s dispatch path and returns a clear, actionable tool result naming any missing symbol instead. The bundle runs against the _installed_ pi (via jiti's alias), which may differ from the repo's pinned/typecheck target — keep `REQUIRED_SYMBOLS` in sync with the import sites.
- **Async tickets are fire-and-forget.** `async: true` spawns background execution and returns a ticket ID immediately. Results are pushed via `sendMessage({deliverAs:"followUp"})`. Poll/cancel with top-level `action: "poll"` or `action: "cancel"`. Because `CustomMessage` (the followUp shape) has no `usage` slot, **async subagent usage cannot be auto-counted** in the parent total — only sync dispatch attaches top-level `usage` to the tool result.
- **Custom agents are discovered from Markdown files.** `discoverAgents()` walks sources in order, first definition wins: project `.pi/agents/` → global `~/.pi/agent/agents/` → legacy `~/.agents/` → project `.claude/agents/` → global `~/.claude/agents`. A same-named `.md` in a higher-priority dir supersedes anything below it. Custom agents can also be defined inline in a task; Markdown agents are examples of custom agents.
- **Claude Code interchange.** `.claude/agents/*.md` files are imported with field adaptation: capitalized tool names are mapped (`Read`→`read`, `Glob`→`find`, …), unmappable tools dropped, `disallowedTools` honored as a denylist layered on the resolved set, and `model: inherit` stripped to mean parent-inherit. See `loadClaudeAgentFile` in `agents.ts`.

## Conventions

- **Flat package** — all `.ts` files at root. No `src/` directory.
- **Discriminated unions** for variant types (`action`-discriminated `SessionAction`, `status`-discriminated ticket states).
- **Thinking precedence** — `thinking` field > agent override (`settings.json` `delegate.agentOverrides`) > agent frontmatter > frozen pooled config > a `:level` model suffix (last-resort default). The suffix is lowest on purpose so an agent author's `thinking: low` beats a `model: x:max` on the same profile; it's honored only when nothing else sets thinking, preserving intent for model-emitted `claude:max` calls. Override (suffix set but a higher source won) emits a warning.
- **Tools surface** — delegatable set is the 7 native tools (`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`) rebuilt from `TOOL_FACTORIES`; MCP/skills aren't tools and aren't inherited. `*`=read+write+edit+bash, `ro`=read+grep+find+ls (no shell). `bash` subsumes mutation and transitively unlocks MCP (mcporter), and there is **no filesystem isolation** (subagents run in the resolved cwd), so any set with `bash` is full-capability — "read-only" is honest only for `ro`. Deferred fix: sandboxed bash via btrfs `--reflink` copy, if a verifier ever mutates when it shouldn't.

## Workflow

```bash
# Install
ln -s "$PWD/delegate.bundle.ts" ~/.pi/agent/extensions/delegate.ts

# Develop
bun install
bun run build       # regenerate delegate.bundle.ts
bun run typecheck
bun test
```

After install or rebuild, `/reload` in Pi.

### End-to-end verification (Herdr)

Unit tests stub the host-deps / `modelRuntime` path, so they can't catch a regression where pi drops or renames a symbol the bundle imports (the class of bug that broke delegation in the 0.80.3→0.80.8 `authStorage`/`modelRegistry`→`modelRuntime` refactor — it surfaced as a lying `0/1 completed · ~4ms` with `Cannot read properties of undefined (reading 'create')`). The only real proof is firing a `delegate` call inside a running pi. This agent runs in Herdr, so drive one from a sibling pane:

```bash
e2e_dir=$(mktemp -d /tmp/pi-delegate-e2e-XXXXXX)
herdr pane split --current --direction right --no-focus  # capture result.pane.pane_id
herdr pane run <pane> "cd '$e2e_dir' && pi --model 'opencode/deepseek-v4-flash-free'"
herdr agent wait <pane> --until idle --timeout 30000
herdr agent prompt <pane> "Use delegate to spawn one task with tools read/write/edit/bash and prompt: Reply with exactly CONNECTIVITY OK. Report the output verbatim."
herdr agent wait <pane> --until idle --until done --until blocked --timeout 180000
herdr pane read <pane> --source recent-unwrapped --lines 50
herdr pane close <pane>
trash "$e2e_dir"
```

Green = `1/1 completed · … · ✓ ad-hoc … ⎿ CONNECTIVITY OK`. Run from an isolated temp directory: loading the repository context distracts the parent model from the connectivity task and unnecessarily exposes the worktree to a full-capability subagent. The subagent inherits the parent model, so the parent `pi --model` must be authenticated. A fresh pi launch picks up a rebuilt bundle automatically; a long-running pi needs `/reload`.

## Stable Reference Facts

- **Extension dir:** `~/.pi/agent/extensions/`
- **Delegate config:** `~/.pi/agent/delegate.json` (user-edited; `config.ts` reads it — no programmatic mutators)
- **Custom agents** are defined either inline in a task or persisted as Markdown files in `.pi/agents/` (project) and `~/.pi/agent/agents/` (global). Markdown agents are examples of custom agents.
- **Markdown agents** are Markdown files with YAML frontmatter — required fields `name`, `description`; optional `thinking`, `tools`, and rarely `model` (subagents inherit the parent model by default)
- **Settings:** `~/.pi/agent/settings.json` — `delegate.agentOverrides` key for per-agent model/thinking/tool/skill overrides

## Tracking work

Open work is tracked in GitHub Issues, not in-repo markdown plans. Feature work, refactors, bugs, and follow-ups are tracked as issues — no `*-PLAN.md` or `UX-REVIEW.md` files. Priorities are labels (`P0`/`P1`/`P2`/`P3`), not a tracker issue. Triage with `gh issue list --state open --label P1` (or P0/P2/P3); theme grouping uses the existing labels (`architecture`, `refactor`, `tooling`, `tests`, `perf`, `quality`, `enhancement`, `bug`). See https://github.com/bermudi/pi-delegate/issues.

## Security

Dependency vulnerabilities are tracked via GitHub Dependabot, which auto-files alerts when affected versions are detected. Alerts are closed when dependencies are bumped past the patched version. Example: CVE-2026-54328 (GHSA-jfgx-wxx8-mp94) closed by bumping `pi-coding-agent` from `^0.75.3` to `^0.80.3` (commit 991f6b6).

External issues (e.g., test-harness bugs, upstream library problems) are filed in their respective repos and optionally linked from our issues for tracking. See https://github.com/marcfargas/pi-test-harness/issues/8 for an example.

## Constraints & Red Lines

- **Never edit `delegate.bundle.ts`.** Generated by `bun run build`.
- **Subagents must never run extensions.** `noExtensions: true` is not negotiable — removing it introduces cross-wiring bugs.
- **Session pooling is serialized per `sessionId`.** Concurrent delegate calls with the same `sessionId` queue behind a lock — they do not interleave.
- **Duplicate `sessionId` values in a single delegate call are rejected.** Each pooled session handles one task at a time.

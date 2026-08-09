# AGENTS.md

## Project

A delegate tool extension for the [Pi](https://github.com/earendil-works/pi) coding agent. Spawns subagents to run tasks in parallel — with async ticketing, session pooling, retries, and per-model concurrency limits. Production installs use a pinned Git commit or release tag as a Pi package; the generated bundle is a disposable verification artifact, not a live install target.

## Stack

TypeScript (strict), Bun, esbuild. The optional bundle is a single-file smoke-test artifact for Pi's Node process — external packages (`pi-agent-core`, `pi-ai`, `pi-tui`) are shared with the parent. Production Pi loads `delegate.ts` from the installed package. Tests use `@marcfargas/pi-test-harness` (Pi-specific). `@sinclair/typebox` for schema validation.

## Architecture

This is **not a standalone app** — it's a Pi extension. Entry points:

- **`delegate.ts`** — public API surface (barrel re-exports). The build entry point.
- **`extension.ts`** — thin tool-definition orchestrator. Wires `registerTool` and dispatches `execute` to the focused modules below; owns only the poll/wait/cancel/help short-circuits and the session-shutdown handler.
- **`schema.ts`** — `delegateArgumentsSchema` (single source of truth — `DelegateArguments`/`TaskDef` in `types.ts` are `Static<>` projections) plus `validateDelegateOperation` (semantic validation after normalization, including a task-field whitelist that rejects unknown keys with corrective messages — a task-level `async: true` was observed silently degrading to a sync run) and `normalizeDelegateArguments` (pre-validation shim recovering malformed shapes weaker models emit: stringified `tasks` arrays, task fields flattened to the top level → wrapped into a single task, stringified/bare-token `tools`, `agent: ""` → omitted). Without flat-field recovery, a malformed call silently degrades to the manual and models misread that as "the tool is broken". Description strings are budgeted (each ≤110 chars, total ≤1600 with ~50 chars headroom — enforced in `delegate.test.ts`) as a proxy for the repeated provider tool-definition payload; keep copy lean but informative and resize the budget to the copy, not the copy to the budget.
- **`usage.ts`** — nested-model usage accounting: snapshots cumulative `AgentSession.getSessionStats()`, computes per-task deltas, and aggregates `Usage` for the sync tool result. Pi 0.81+ persists the top-level `usage` on the toolResult message and folds it into the parent footer/session totals. The per-task `tokens` display and `usage.totalTokens` now share the same compaction-inclusive stats delta; the `Usage` object additionally preserves provider breakdown and cost.
- **`manual.ts`** — schema-driven help generation and the dynamic configured-agent list.
- **`task-resolution.ts`** — `validateTasks` (duplicate sessions, busy conflicts, unknown agents) and `resolveTasks` (agent/model/tools/system-prompt resolution per task).
- **`dispatch.ts`** — `initProgress`, `makeFireUpdater`, `dispatchAsync`, `dispatchSync`. Sync/async execution orchestration.
- **`lifecycle.ts`** — per-task execution: resolves a usable `AgentSession` (pool hit / resume-from-`.jsonl` / fresh), runs the prompt via `runner.ts`, and commits the outcome. Owns session **materialization** and the whole-task retry loop.
- **`runner.ts`** — drives one `AgentSession.prompt()`, maps Pi events to progress, accounts usage/files, and owns inactivity detection plus the post-prompt quiescence barrier. `prompt()` can return while an `agent_settled` extension is still compacting or launching a continuation; runner does not return ownership to lifecycle until the session is idle and non-compacting across stable event-loop turns. Stall cancellation is cooperative: it cancels compaction/branch summaries, calls `AgentSession.abort()`, and waits for quiescence rather than returning while a provider/tool/extension may still mutate state.
- **`pool.ts`** — the **SessionPool**: a deep module owning pooled-session state + policy (freeze-on-insert, validate-on-reuse, insert-on-success, stats, explicit close/shutdown cleanup, per-`sessionId` lock) behind `checkout` / `commit` / `configFor`. The raw `Map` is private; the public barrel exposes behavior, not state. See `docs/adr/0001` + `CONTEXT.md`.
- **`status.ts`** — background-work visibility for async tickets: the persistent footer status (`ctx.ui.setStatus`, deduped by text, event-driven — no timers), the once-per-ticket `agent_settled` warning, and the confirm guards on the cancellable session-replacement paths (`session_before_switch` / `session_before_fork`). Quit and `/reload` are NOT interceptable (pi's `session_shutdown` is advisory) — `extension.ts` leaves a stderr trace on quit and a warning notify on reload instead.
- **`render-result.ts`** + **`render-branches.ts`** — TUI rendering. `renderDelegateCall` (minimal call display) and `renderDelegateResult` (skeleton + spinner lifecycle) live in `render-result.ts`; the heavy partial/final progress trees live in `render-branches.ts`.
- **`.build/delegate.bundle.ts`** — optional esbuild smoke-test output. Never edit by hand or install it into a running Pi.

**Key architectural decisions:**

- **Subagents avoid parent extensions by default.** Host deps are built with `noExtensions: true`, so subagents do not run the parent's interactive extension inventory and cannot cross-wire into the parent's runtime.
- **Provider-scoped extension allowlist:** for safety-critical provider-specific behavior, `host.ts` injects `additionalExtensionPaths` after `noExtensions` as a narrow exception. Today, the `openai-codex` provider gets `npm:@ogulcancelik/pi-codex-compaction`, while every other provider receives none. This policy is configurable in `~/.pi/agent/delegate.json` as `providerExtensions` (`{ "provider": ["source", ...] }`); defaults live in `DEFAULT_PROVIDER_EXTENSIONS`. Semantics are **replace, not append**: a provider's list substitutes the default entirely — to keep the default source alongside a custom one, re-list both. An empty array is dropped, so the default persists; there is intentionally no config-only way to disable the safety-critical compaction default. Sources must be installed in the user scope; project-local extension installations are rejected, and missing sources fail clearly rather than silently disabling the integration.
- **Extension-free host deps are cached within one delegate dispatch** per `(agentDir, cwd, systemPrompt)`, then invalidated before the next dispatch so auth/model/settings/context edits become visible without restarting Pi. A generation guard prevents an older in-flight build from repopulating or clearing a newer cache. `ModelRuntime` (the unified model+auth runtime), `SettingsManager`, and `ResourceLoader` are shared across extension-free subagents with the same profile in that dispatch. Child resource settings are always constructed with `projectTrusted: false`; project packages and `npmCommand` never execute during delegation. The child loader keeps cwd/ancestor project context but filters user-global `AGENTS.md` files (including the legacy `~/.agents/AGENTS.md`), and parent prompt inheritance strips the already-assembled context section before the child adds its own. Provider-configured or allowlisted-extension sessions receive fresh host deps: Pi binds mutable extension callbacks onto the loader runtime, so sharing those deps would cross-wire sessions. The `ModelRuntime` is built with `allowModelNetwork: false` — subagents receive an explicit model (resolved by the parent) and never need remote catalog discovery. Since pi 0.80.8, `createAgentSession` takes a single `modelRuntime` in place of the removed `authStorage`/`modelRegistry` options; the parent's `ctx.modelRegistry` remains the source for model selection and its runtime-only provider registrations are copied into the child runtime. Extensions themselves remain disabled unless explicitly allowlisted.
- **Session pooling** is a deep module (`pool.ts`): live `AgentSession`s keyed by `sessionId`, behind a small interface (`checkout` / `commit` / `recordUse` / `configFor`). The pool owns **policy** (freeze-on-insert, validate-on-reuse, insert-on-success, all-attempt stats for existing entries, explicit close/shutdown cleanup, and the `open → closing → closed` barrier); **session materialization** (pool-hit reuse / resume / fresh-create) lives in `lifecycle.ts`. Shutdown aborts pooled sessions immediately, waits behind every active session lock, rejects late pool-miss commits, and then disposes entries. Sessions stay live until close or parent shutdown. See `docs/adr/0001` + `CONTEXT.md` — don't fold materialization into the pool.
- **Host-compat guard** (`host-compat.ts`): the bundle imports pi internals from the package root, and pi can drop/rename a symbol or static factory on any bump — jiti can then produce `undefined`, crashing as a cryptic `Cannot read properties of undefined (reading 'create')`. `hostCompatError()` runs once per process at the top of `execute` and validates both exports and required static members (`ModelRuntime.create`, `SettingsManager.create`, `SessionManager.create/open`). Optional rendering hooks such as `getMarkdownTheme` degrade to plain text instead of blocking delegation. The bundle runs against the _installed_ pi, which may differ from the repo's pinned/typecheck target — keep `REQUIRED_EXPORTS` in sync with actual hard dereferences.
- **Async tickets are fire-and-forget.** `async: true` spawns background execution and returns a ticket ID immediately. Results are pushed via `sendMessage({deliverAs:"followUp"})`. Poll/wait/cancel with top-level `ticketAction: "poll"`, `ticketAction: "wait"`, or `ticketAction: "cancel"`. Because `CustomMessage` (the followUp shape) has no `usage` slot, **async subagent usage cannot be auto-counted** in the parent total — only sync dispatch attaches top-level `usage` to the tool result.
- **Built-in default agent:** `agent: "default"` is reserved and mirrors the live parent's exact model object, thinking level, delegatable native tools, and sanitized base prompt. It bypasses delegate/settings model overrides; parent extensions/MCP tools remain excluded and project context is rebuilt for the task cwd. Omitted `agent` remains the existing ad-hoc/inline mode.
- **Custom agents are discovered from Markdown files.** `discoverAgents()` walks sources in order, first definition wins: project `.pi/agents/` → global `~/.pi/agent/agents/` → legacy `~/.agents/` → project `.claude/agents/` → global `~/.claude/agents`. A same-named `.md` in a higher-priority dir supersedes anything below it. Custom agents can also be defined inline in a task; Markdown agents are examples of custom agents. The name `default` is reserved and persisted profiles using it are ignored with a warning.
- **Claude Code interchange.** `.claude/agents/*.md` files are imported with field adaptation: capitalized tool names are mapped (`Read`→`read`, `Glob`→`find`, …), unmappable tools dropped, `disallowedTools` honored as a denylist layered on the resolved set, and `model: inherit` stripped to mean parent-inherit. See `loadClaudeAgentFile` in `agents.ts`.

## Conventions

- **Production installation rule:** Install this extension into Pi from a pinned Git commit or release tag. Never point a running Pi at an agent's working tree or at a bundle that agents build in place. Build bundles only as disposable verification artifacts outside any live extension path; push/tag only when the extension is ready, then update the installed Pi package explicitly. Treat the old global bundle-symlink workflow as legacy.
- **Flat package** — all `.ts` files at root. No `src/` directory.
- **Discriminated unions** for variant types (`sessionAction`-discriminated `SessionAction`, `status`-discriminated ticket states).
- **Thinking precedence** — `thinking` field > agent override (`settings.json` `delegate.agentOverrides`) > agent frontmatter > frozen pooled config > a `:level` model suffix (last-resort default). The suffix is lowest on purpose so an agent author's `thinking: low` beats a `model: x:max` on the same profile; it's honored only when nothing else sets thinking, preserving intent for model-emitted `claude:max` calls. Override (suffix set but a higher source won) emits a warning.
- **Tools surface** — delegatable set is the 7 native tools (`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`) rebuilt from `TOOL_FACTORIES`; MCP/skills aren't tools and aren't inherited. `*`=read+write+edit+bash, `ro`=read+grep+find+ls (no shell). `bash` subsumes mutation and transitively unlocks MCP (mcporter), and there is **no filesystem isolation** (subagents run in the resolved cwd), so any set with `bash` is full-capability — "read-only" is honest only for `ro`. Deferred fix: sandboxed bash via btrfs `--reflink` copy, if a verifier ever mutates when it shouldn't.

## Workflow

Production installation uses a pinned Git commit or release tag:

```bash
# Replace this with a reviewed commit or release tag; never use a moving branch.
pi install git:github.com/bermudi/pi-delegate@<reviewed-commit-or-tag>
```

Remove any old `delegate.ts` symlink from `~/.pi/agent/extensions/` before starting Pi. Pi loads `delegate.ts` from the isolated Git package checkout; do not point it at this working tree or at `.build/delegate.bundle.ts`.

For local development:

```bash
bun install
bun run typecheck
bun test
bun run build       # optional disposable bundle smoke test
```

`delegate.ts` is the package entry point. `.build/delegate.bundle.ts` is generated and ignored; keep it only as a verification artifact. Push/tag only after the extension is ready, then update Pi to that exact Git ref and start a fresh Pi process. Do not use an in-place build or a long-running session's `/reload` as the deployment mechanism.

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

Green = `1/1 completed · … · ✓ ad-hoc … ⎿ CONNECTIVITY OK`. Run from an isolated temp directory: loading the repository context distracts the parent model from the connectivity task and unnecessarily exposes the worktree to a full-capability subagent. The subagent inherits the parent model, so the parent `pi --model` must be authenticated. Run this against a fresh Pi process and the installed package; do not rebuild a bundle that a running Pi is using.

## Stable Reference Facts

- **Extension dir:** `~/.pi/agent/extensions/`
- **Delegate config:** `~/.pi/agent/delegate.json` (user-edited; `config.ts` reads it — no programmatic mutators). `providerExtensions` controls the provider-scoped allowlist for subagent extensions.
- **Custom agents** are defined either inline in a task or persisted as Markdown files in `.pi/agents/` (project) and `~/.pi/agent/agents/` (global). Markdown agents are examples of custom agents.
- **Markdown agents** are Markdown files with YAML frontmatter — required fields `name`, `description`; optional `thinking`, `tools`, and rarely `model` (subagents inherit the parent model by default)
- **Settings:** `~/.pi/agent/settings.json` — `delegate.agentOverrides` key for per-agent model/thinking/tool/skill overrides

## Tracking work

Open work is tracked in GitHub Issues, not in-repo markdown plans. Feature work, refactors, bugs, and follow-ups are tracked as issues — no `*-PLAN.md` or `UX-REVIEW.md` files. Priorities are labels (`P0`/`P1`/`P2`/`P3`), not a tracker issue. Triage with `gh issue list --state open --label P1` (or P0/P2/P3); theme grouping uses the existing labels (`architecture`, `refactor`, `tooling`, `tests`, `perf`, `quality`, `enhancement`, `bug`). See https://github.com/bermudi/pi-delegate/issues.

## Security

Dependency vulnerabilities are tracked via GitHub Dependabot, which auto-files alerts when affected versions are detected. Alerts are closed when dependencies are bumped past the patched version. Example: CVE-2026-54328 (GHSA-jfgx-wxx8-mp94) closed by bumping `pi-coding-agent` from `^0.75.3` to `^0.80.3` (commit 991f6b6).

External issues (e.g., test-harness bugs, upstream library problems) are filed in their respective repos and optionally linked from our issues for tracking. See https://github.com/marcfargas/pi-test-harness/issues/8 for an example.

## Constraints & Red Lines

- **Never edit `.build/delegate.bundle.ts`.** Generated by `bun run build`.
- **Subagents must never run the parent's extension inventory.** `noExtensions: true` is non-negotiable for the default path; the only sanctioned exception is a narrow provider-scoped allowlist via `additionalExtensionPaths` in `host.ts` (defaults currently: only `openai-codex` + `npm:@ogulcancelik/pi-codex-compaction`). The allowlist can be replaced (per-provider, not appended) in `delegate.json` via `providerExtensions`; empty arrays are ignored. Allowlisted sources are resolved from the user scope only, and missing sources fail closed.
- **Session pooling is serialized per `sessionId`.** Concurrent delegate calls with the same `sessionId` queue behind a lock — they do not interleave.
- **Duplicate `sessionId` values in a single delegate call are rejected.** Each pooled session handles one task at a time.
- **`resumeFrom` + `model` resumes on a different model.** `createAgentSession` honors an explicit `model` over the session's stored model, so a failed subagent's conversation can be continued on another model — the mechanism for "continue a failed agent with a different model". Delegate tags model-attributable failures (usage limit, quota, auth) `failureKind: "model_error"`, excludes them from same-model whole-task retry (account-level limits aren't transient for that model), and emits a "retry with a different model" hint pointing at the `model` field.

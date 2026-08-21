# pi-delegate

Repository: https://github.com/bermudi/pi-delegate

Delegate tool for the [Pi coding agent](https://github.com/earendil-works/pi) — spawn
subagents to run tasks in parallel, with async ticketing, session pooling, retries,
and per-model concurrency limits.

Extracted from [`bermudi/agent-extensions`](https://github.com/bermudi/agent-extensions)
as a standalone repo (full history preserved).

## Install

Install a reviewed Git commit or release tag as a Pi package:

```bash
# Replace this with a reviewed commit or release tag; do not use a moving branch.
pi install git:github.com/bermudi/pi-delegate@<reviewed-commit-or-tag>
```

Remove any old `delegate.ts` symlink from `~/.pi/agent/extensions/` before
starting Pi. Pi loads `delegate.ts` from the isolated Git package checkout; do
not point a running Pi at this repository or at `.build/delegate.bundle.ts`.
Start a fresh Pi process after updating the installed ref.

## Usage

Use the built-in `default` profile to run a subagent with the live parent's
model, thinking level, delegatable native tools, and base system prompt:

```ts
delegate({
  tasks: [{ agent: "default", prompt: "Investigate the auth module" }],
});
```

Parent extension/MCP tools are not copied, and project instructions are rebuilt
for the task's `cwd`. Omit `agent` when you want an ad-hoc task using delegate's
normal inline defaults instead.

The other built-ins are:

- `scout` — read-only investigation with `read`, `grep`, `find`, and `ls`.
- `coder` — implementation and verification with `read`, `write`, `edit`, and
  `bash` in the shared workspace.
- `reviewer` — review with `read` and `bash`, using a disposable scratch copy by
  default. Set `workspace: "shared"` when a reviewer needs a persistent
  `sessionId`.

### Shared-write safety

Before starting work, Delegate resolves each task's real tools and physical Git
root. If a task could mutate a shared tree that overlaps another task in the
same call or a still-running sync/async dispatch, the new call is rejected
before any subagent starts. Unknown tool names are treated as mutating. External
processes are outside this in-process gate.

Operators can deliberately bypass this check by setting
`"allowUnsafeSharedWrites": true` in `~/.pi/agent/delegate.json`. This setting
is intentionally absent from the model-facing tool API. It provides no
isolation or rollback, and Delegate marks running and final results with a
visible batch-level warning while it is active.

A same-named Markdown file can override any built-in (first definition wins
across `.pi/agents/`, `~/.pi/agent/agents/`, `~/.agents/`, `.claude/agents/`,
`~/.claude/agents/`). A prompt-only override keeps the built-in's tools and
workspace — `scout` stays read-only and `reviewer` stays scratch unless the
file explicitly sets `tools` or `workspace`. Fresh built-ins inherit the
parent's exact model object and thinking level; an explicit `model`/`thinking`
in the Markdown file replaces that inheritance. Task fields always win, and for
`scout`/`coder`/`reviewer` overrides in `~/.pi/agent/delegate.json`
(`agentOverrides` / `agentOverridesByParentModel`) win over the
Markdown file, while `default` ignores overrides and uses only an explicit
Markdown `model`/`thinking` when present. `delegate.json` is the permanent
config file (user scope, global), and edits apply from the next delegate call.

For the v0.1.12 migration release only, legacy user and nearest-project
`settings.json` `delegate.agentOverrides` /
`delegate.agentOverridesByParentModel` still supply `model` and `thinking`
when a modern value is absent. Modern `delegate.json` wins field-by-field.
Legacy `tools` is never honored because a project file must not restore shell
capability. This bridge is removed in v0.1.13. Project-local replacements are
`.pi/agents/*.md` profiles or explicit task `model`/`thinking` fields; there
will be no new project-level delegate config file.

### Disposable scratch workspace

For review, tests, or other commands whose project changes should be thrown
away, run a one-shot task in a CoW copy:

```ts
delegate({
  tasks: [
    { prompt: "Review this change and run its tests", workspace: "scratch" },
  ],
});
```

Delegate reflink-copies the containing Git repository beside the original, runs
the subagent in the corresponding copied directory, then deletes the copy. It
requires Linux with `/proc/self/fd`, GNU `cp`, and a reflink-capable filesystem
such as Btrfs; it never falls back to an expensive full copy. Scratch mode
cannot use `sessionId`,
`resumeFrom`, session actions, linked Git worktrees, or project symlinks that
point outside the copied tree.

This protects the real project from ordinary relative writes. It is not a
security sandbox: unrestricted commands and absolute paths can still reach the
host filesystem.

### Token accounting

Sync delegate calls report aggregate subagent `Usage` on the tool result, so Pi
(0.81+) folds those tokens **and cost** into the parent footer and session
total automatically — no manual addition needed.

Async tickets can't be auto-counted: their results arrive as a follow-up message,
which has no usage slot. The per-call aggregate (`Nk tokens`) is still shown in
the delegate header for both modes. Use sync delegation when totals must roll
into the session.

### Background-work visibility

Async tickets keep running after the parent's turn settles, and pi renders an
idle session — so delegate adds three signals:

- **Footer status** — while any ticket is active, the footer shows
  `⏳ 2 subagents · t5042v19`, updated live as subagents start and finish.
- **Settle warning** — the first time a turn settles with a ticket still
  active, a warning notification names the ticket and reminds you that
  quitting aborts it. Once per ticket; the footer carries it from there.
- **Switch/fork guard** — `/new`, `/resume`, and forking ask for confirmation
  before killing live subagents (pi lets extensions cancel those paths).

Quitting (Ctrl+C×2 / Ctrl+D / `/quit`) and `/reload` **cannot be intercepted**
by an extension — pi's `session_shutdown` is advisory. The footer status is
the mitigation there; on quit, delegate also prints a trace line to the
terminal naming the aborted tickets and agents, and on `/reload` it shows a
warning notification.

### Stall detection and cancellation

`stallTimeoutMs` is an inactivity watchdog, not a hard execution deadline. When
an active subagent emits no model or tool activity for the configured interval,
delegate reports that a stall was detected and asks Pi's `AgentSession.abort()`
to cancel it, along with any active compaction or branch summary. Cancellation
is cooperative: delegate waits for the session to become idle and non-compacting
before returning a failed task, because returning while a provider, tool, or
extension can still run would let a supposedly finished agent keep mutating
state. An operation that ignores cancellation can therefore delay the final
task result. Set `stallTimeoutMs` to `0` to disable the watchdog.

## Develop

```bash
bun install
bun run typecheck
bun test
bun run build       # optional disposable bundle smoke test
```

The package entry point is `delegate.ts`; `extension.ts` holds the tool
implementation. `.build/delegate.bundle.ts` is generated by `bun run build` and
is only a verification artifact. Never symlink it into a running Pi or build
over an installed extension.

## Glossary

- **Delegate task** — One item in `delegate({ tasks: [...] })`. This is the
  core unit of work: a prompt plus optional overrides such as `agent`, `tools`,
  `systemPrompt`, `thinking`, `cwd`, `context`, `workspace`, `sessionId`, or
  `resumeFrom`.
  `model` is also accepted but should be rare — subagents inherit the parent
  model by default.
- **Default subagent** — The reserved built-in `agent: "default"` profile. It
  mirrors the live parent's model, thinking level, delegatable native tools, and
  base system prompt while preserving delegate's extension/context isolation;
  a `default.md` Markdown file can override its prompt/tools/model/thinking
  (first definition wins — a prompt-only file keeps the parent-mirrored tools
  and thinking/model inheritance).
- **Custom agent** — A subagent profile defined by the parent, either inline in
  a delegate task (`systemPrompt`, `tools`, and `thinking`) or persisted as a
  Markdown file. The subagent inherits the parent model by default; `model` is a
  rare override. Markdown agents are examples of custom agents.
- **Named agent** / **Markdown agent** — A reusable custom agent persisted as a
  Markdown file in `.pi/agents/*.md`, `~/.pi/agent/agents/*.md`, `~/.agents/*.md`,
  `.claude/agents/*.md`, or `~/.claude/agents/*.md` (first definition wins). The frontmatter defines its name, description,
  model, tools, and thinking level; the Markdown body is its system prompt. A
  same-named file for a built-in (`default`/`scout`/`coder`/`reviewer`)
  overrides that built-in; a prompt-only override keeps the built-in's tools
  and workspace, and an explicit `model`/`thinking` replaces parent inheritance
  (for `default` settings are ignored, for others settings win over the file).
- **Ad-hoc subagent** — A subagent created from inline task fields instead of a
  named Markdown agent profile. In current output this is labeled `ad-hoc`.
- **Inline task** — The task object itself when its configuration is supplied
  directly in the delegate call. Prefer this term over “inline agent” when
  talking about the API shape.
- **Subagent run** — The actual execution of a resolved delegate task. Multiple
  runs using the same named agent are independent unless they share a
  `sessionId` or resume from the same session file.
- **Pooled subagent** / **persistent session** — A live subagent kept in memory
  under a `sessionId`. The first call creates it; later calls with the same
  `sessionId` continue the same conversation until explicitly closed or the parent Pi session ends.
- **Resumed subagent** — A subagent rehydrated from a previous session `.jsonl`
  via `resumeFrom`. It can also be pooled by providing a `sessionId`.
- **Async ticket** — A background execution handle returned when top-level
  `async: true` is used. Poll, wait, or cancel tickets with top-level
  `ticketAction: "poll"`, `ticketAction: "wait"` (blocks until the ticket settles;
  optional `timeoutMs`), or `ticketAction: "cancel"`.
- **Skill** — A `SKILL.md` instruction bundle injected into the subagent system
  prompt. Skills are text instructions only; they do not unlock additional
  tools.
- **AGENTS.md context** — Project and ancestor guidance files are automatically
  appended to subagent system prompts. User-global AGENTS.md files are excluded;
  they describe the parent harness, not the delegated task.

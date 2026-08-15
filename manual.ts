import {
  BUILTIN_AGENT_NAMES,
  DEFAULT_AGENT_NAME,
  DEFAULT_TOOLS,
  OUTPUT_SPILL_THRESHOLD_CHARS,
  OUTPUT_SPILL_TAIL_CHARS,
} from "./constants.ts";
import { getMaxAsyncTickets, getMaxConcurrent } from "./config.ts";
import type { TSchema } from "@sinclair/typebox";
import { delegateArgumentsSchema, delegateTaskSchema } from "./schema.ts";
import type { AgentConfig } from "./types.ts";
import { BUILTIN_AGENT_CONFIGS } from "./agents.ts";

function schemaType(schema: TSchema): string {
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (schema.type === "array") return `${schemaType(schema.items)}[]`;
  return typeof schema.type === "string" ? schema.type : "unknown";
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function schemaTable(properties: Record<string, TSchema>): string {
  const rows = Object.entries(properties).map(([name, schema]) => {
    const type = markdownCell(schemaType(schema));
    const defaultValue =
      "default" in schema ? JSON.stringify(schema.default) : "—";
    const description = markdownCell(schema.description ?? "");
    return `| \`${name}\` | \`${type}\` | \`${defaultValue}\` | ${description} |`;
  });
  return [
    "| Field | Type | Default | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Render the current schema and discovered agents as model-facing help. */
export function getSubagentManualMarkdown(
  agents: Map<string, AgentConfig>,
): string {
  const builtinNames = new Set<string>(
    BUILTIN_AGENT_NAMES as readonly string[],
  );
  const entries = [...agents].filter(
    ([name, a]) => !a.builtin && !builtinNames.has(name),
  );
  const builtinLines = (BUILTIN_AGENT_NAMES as readonly string[]).map(
    (name) => {
      const cfg = agents.get(name) ?? BUILTIN_AGENT_CONFIGS[name]!;
      const isDefault = name === DEFAULT_AGENT_NAME;
      // `default` normally mirrors the parent's native tools; only show a
      // fixed list when the file explicitly overrode them. This avoids
      // advertising `read, write, edit, bash` when runtime will actually use
      // the parent's active set. A deny-only `default` (deniedTools with no
      // explicit allowlist) filters the parent at runtime and must surface.
      let toolsPart: string;
      if (isDefault && cfg.deniedTools?.length && !cfg.explicitTools) {
        toolsPart = ` Tools: parent tools minus \`${cfg.deniedTools.join(", ")}\`.`;
      } else {
        const showTools = !isDefault || !!cfg.explicitTools;
        toolsPart = showTools ? ` Tools: \`${cfg.tools.join(", ")}\`.` : "";
      }
      const modelPart =
        cfg.explicitModel && cfg.model ? ` Model: \`${cfg.model}\`.` : "";
      const thinkingPart =
        cfg.explicitThinking && cfg.thinking
          ? ` Thinking: \`${cfg.thinking}\`.`
          : "";
      const workspace =
        cfg.workspace === "scratch"
          ? `Defaults to a disposable scratch workspace; set \`workspace: "shared"\` for a persistent ${name} with \`sessionId\`.`
          : "Shared workspace.";
      return `- **${name}**: ${cfg.description}${toolsPart}${modelPart}${thinkingPart} ${workspace}`;
    },
  );
  const agentList = entries.length
    ? entries
        .map(([n, a]) => {
          const model = a.model ? ` (model: ${a.model})` : "";
          const thinking =
            a.thinking !== "off" ? ` [thinking: ${a.thinking}]` : "";
          const tools =
            a.tools.length !== DEFAULT_TOOLS.length ||
            a.tools.some((t, i) => t !== DEFAULT_TOOLS[i])
              ? ` tools: ${a.tools.join(", ")}`
              : "";
          const scope =
            a.scope === "project"
              ? " [project]"
              : a.scope === "global"
                ? " [global]"
                : a.scope === "claude"
                  ? " [claude]"
                  : "";
          return `- **${n}**${model}${thinking}${tools}${scope}: ${a.description}`;
        })
        .join("\n")
    : "_(none defined)_";

  return [
    "# Delegate Tool Manual",
    "",
    "**Why you're seeing this:** no tasks were provided, so the tool returned help instead of dispatching. Nothing is broken. To dispatch subagents, put task fields inside `tasks: [{ ... }]`.",
    "",
    "```ts",
    'delegate({ tasks: [{ agent: "default", prompt: "Investigate the auth module" }] })',
    "```",
    "",
    "Delegate subagents to execute tasks in parallel. Each subagent gets an independent conversation but uses the real filesystem at its task `cwd`; tasks sharing a directory can observe and overwrite one another's changes. Fresh prompts must therefore be self-contained, and dependent or shared-file work should run separately.",
    "",
    "The three handles have different lifetimes:",
    "",
    "- **ticket** — controls one async batch with `poll`, `wait`, or `cancel`.",
    "- **sessionId** — a caller-chosen key for a live multi-turn worker, retained until close or parent shutdown.",
    "- **resumeFrom** — an absolute `.jsonl` transcript path used to recover an interrupted worker.",
    "",
    "Each task entry may also carry an optional `id` — a caller-provided per-dispatch correlation key. Duplicate `id` values in the same call are rejected; when omitted, tasks are identified by array index, agent, and prompt.",
    "",
    "Subagents cannot call `delegate` recursively. Their tool activity runs at `cwd`, while Pi stores the runtime session transcript in its own session directory outside that `cwd`.",
    "",
    "## Touched Files (best-effort)",
    "",
    "The `touched:` list in each task result is a **best-effort lower bound**, not an authoritative record.",
    "",
    "- `write` and `edit` tool calls are captured reliably from the activity log.",
    "- `bash` mutations are captured only when the task `cwd` is inside a git repo and git is available, via `git status` against the pre-run baseline.",
    "- In a non-git directory, bash-mutated files are not reported.",
    "- Git failures degrade to an empty diff.",
    "- A path missing from `touched:` does **not** mean the file was unchanged. Delegate does not isolate file access or roll back writes.",
    "",
    "## Built-in Agents",
    "",
    ...builtinLines,
    "",
    "Fresh built-ins inherit the parent's exact model object and thinking level. A same-named Markdown file can override any built-in (first definition wins); an explicit `model` or `thinking` in that file replaces parent inheritance. Task-level `model`/`thinking`/`tools` always win. For `scout`/`coder`/`reviewer`, settings overrides (`settings.json` `delegate.agentOverrides` and `delegate.agentOverridesByParentModel`) win over the Markdown file; `default` ignores settings and uses only an explicit Markdown `model`/`thinking` when present. A prompt-only Markdown override keeps the built-in's tools and workspace, so `scout` stays read-only and `reviewer` stays scratch unless the file explicitly changes them. Parent extension/MCP tools are not copied. Parent-global `AGENTS.md` instructions are also excluded. Project-local context and skills are rebuilt for the task's `cwd`; per-task fields remain explicit overrides.",
    "",
    "## Available Custom Agents",
    "",
    agentList,
    "",
    "Custom agents are defined either inline in a task (using `systemPrompt`, `tools`, and `thinking`) or persisted as Markdown files in `.pi/agents/*.md` (project-local), `~/.pi/agent/agents/` (global), and `.claude/agents/` (interchange with Claude Code). Markdown agents are examples of custom agents — the parent model can shape the subagent it needs on each call. Each Markdown file is an agent with YAML frontmatter:",
    "",
    "```markdown",
    "---",
    "name: my-agent",
    "description: What it does",
    "thinking: low                     # off/minimal/low/medium/high/xhigh/max",
    "tools: *                          # * = full agent. ro = read-only. Omit to inherit *.",
    "---",
    "You are a helpful agent...",
    "```",
    "",
    "## Task Fields",
    "",
    schemaTable(delegateTaskSchema.properties),
    "",
    "## Top-level Fields",
    "",
    schemaTable(delegateArgumentsSchema.properties),
    "",
    "## Session Reuse",
    "",
    "When `sessionId` is set, the subagent is kept alive in a pool for the duration of the pi session.",
    "Subsequent calls with the same `sessionId` continue the conversation — the agent remembers prior context.",
    "",
    "```ts",
    "// First call — creates and runs an inline custom agent",
    'delegate({ tasks: [{ prompt: "Investigate the auth module", systemPrompt: "You are a focused investigator. Map files and dependencies.", tools: ["read", "grep", "find", "ls"], sessionId: "auth-research" }] })',
    "",
    "// Second call — continues the same agent",
    'delegate({ tasks: [{ prompt: "Now check the tests for that module", sessionId: "auth-research" }] })',
    "",
    "// Clean up when done",
    'delegate({ tasks: [{ sessionId: "auth-research", sessionAction: "close" }] })',
    "```",
    "",
    'Pooled agents remain live until `sessionAction: "close"` or parent Pi session shutdown.',
    "",
    "## Resuming Previous Sessions",
    "",
    "Use `resumeFrom` to continue a failed or interrupted subagent from where it left off.",
    "Pass the exact absolute path to the session `.jsonl` file copied from delegate retry output. Do not invent placeholder values or use it as a ticket ID; async resume is supported.",
    "The agent gets the full conversation history and the new `prompt` continues naturally.",
    "",
    "```ts",
    "// Copy this exact path from the failed delegate result; do not invent it.",
    "const exactRetrySessionFile = failedTaskResult.sessionFile;",
    'delegate({ tasks: [{ prompt: "Continue testing — the server is already running on :3000",',
    "  resumeFrom: exactRetrySessionFile }] })",
    "```",
    "",
    "Combine with `sessionId` to resume AND pool the agent for further multi-turn use:",
    "",
    "```ts",
    'delegate({ tasks: [{ prompt: "Continue the investigation",',
    "  resumeFrom: exactRetrySessionFile,",
    '  sessionId: "my-resumed-agent" }] })',
    "```",
    "",
    "## Resuming on a Different Model",
    "",
    "A failed subagent's conversation can be resumed on a **different model** — useful when the original model hit an account usage limit, quota, or auth error (delegate tags these `model_error` and won't waste same-model retries on them). `createAgentSession` honors an explicit `model` over the session's stored model, so the resumed subagent keeps its full conversation history but runs the next turn on the model you name:",
    "",
    "```ts",
    'delegate({ tasks: [{ prompt: "continue",',
    "  resumeFrom: exactRetrySessionFile,",
    '  model: "anthropic/claude-sonnet-4" }] })',
    "```",
    "",
    "Pick a model you have auth for (the parent session's provider list). The failed result's retry hint names this exact shape when `failureKind` is `model_error`.",
    "",
    "## Async Mode",
    "",
    "Set `async: true` to run tasks in the background. The top-level `ticketAction` controls the ticket:",
    "",
    "```ts",
    'delegate({ async: true, tasks: [{ prompt: "Investigate auth", systemPrompt: "You are a focused investigator.", tools: ["read", "grep", "find", "ls"] }] })',
    "```",
    "",
    '- `delegate({ ticketAction: "poll" })` \u2014 list all tickets',
    '- `delegate({ ticketAction: "poll", ticket: "abc123" })` \u2014 take one progress snapshot',
    '- `delegate({ ticketAction: "wait", ticket: "abc123" })` \u2014 block until finished; omit `timeoutMs` when the result is needed this turn',
    '- `delegate({ ticketAction: "wait", ticket: "abc123", timeoutMs: 600000 })` \u2014 bounded wait; timeout includes the latest snapshot, so do not poll afterward',
    '- `delegate({ ticketAction: "cancel", ticket: "abc123" })` \u2014 preview activity and partial effects before cancelling',
    '- `delegate({ ticketAction: "cancel", ticket: "abc123", force: true })` \u2014 abort after review',
    "",
    `See the field tables above for the full semantics. Max ${getMaxAsyncTickets()} concurrent async tickets.`,
    "Async results arrive as follow-up messages, so Pi cannot fold their usage into the parent session total; displayed task usage remains informational.",
    "",
    "## Gotchas",
    "",
    "- Dispatch validation is batch-wide and runs before spawning: one invalid task rejects the call without starting its siblings.",
    "- `*` means read/write/edit/bash, not every tool. `grep`, `find`, and `ls` are valid explicit tools and are the `ro` preset.",
    '- `tasks` is an array. The tool recovers common stringified calls for compatibility, but canonical calls use `{ tasks: [{ prompt: "..." }] }`.',
    '- Use `agent: "default"` for the parent\'s live model/thinking/native tools/base prompt. Built-ins are `default`, `scout`, `coder`, and `reviewer`; omitting `agent` creates an ad-hoc task.',
    "- An ad-hoc task with no `tools` uses `*`; a named custom task uses its profile; a profile with no tools uses `*`.",
    "- Subagents inherit all skills discovered in their `cwd` (via AgentSession's resource loader). Per-task skill filtering is not supported — curate the cwd's skill set instead.",
    `- Sync \`delegate\` runs at most ${getMaxConcurrent()} tasks at once (the rest queue, not fail). Use \`async: true\` to move work to the background.`,
    "- `deadlineMs` is a per-task wall-clock budget measured from when the task starts running (after queuing). It requests cooperative abort and is not a hard kill; completed writes/commands remain. Omission disables the deadline.",
    "",
    "## Legacy `action` compatibility",
    "",
    "The overloaded `action` field was split into `ticketAction` (poll/wait/cancel) and `sessionAction` (prompt/close/list). Legacy `action` values are still accepted at runtime through automatic normalization, but new calls should use the canonical fields. Programmatic TypeScript consumers should note the exported type `DelegateAction` is now `TicketAction`.",
    "",
    "## Config",
    "",
    "Tunables live in `~/.pi/agent/delegate.json`: `maxConcurrent` (sync ceiling), `maxAsyncTickets` (background ticket cap), `stallTimeoutMs` (inactivity watchdog; default 900000, 0 disables), per-model/per-provider concurrency limits, and legacy custom-agent model overrides. Built-in model/thinking/tools overrides live in `settings.json`; `agentOverridesByParentModel` uses an exact `provider/model-id` key and project settings take precedence.",
    "The inactivity watchdog requests cooperative `AgentSession.abort()` cancellation and waits for the subagent to become idle; it is not a hard wall-clock execution deadline.",
    "",
    `Output bounding: subagent outputs longer than ${OUTPUT_SPILL_THRESHOLD_CHARS} characters are spilled to a temp file, and only the last ${OUTPUT_SPILL_TAIL_CHARS} characters stay in the LLM-facing result. Adjust with \`output.spillThresholdChars\` and \`output.spillTailChars\`. Spill files are written to the system temp directory with owner-only permissions; the full output is always available in the expanded TUI view and the spilled file.`,
  ].join("\n");
}

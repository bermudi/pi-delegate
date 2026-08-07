import {
  DEFAULT_TOOLS,
  OUTPUT_SPILL_THRESHOLD_CHARS,
  OUTPUT_SPILL_TAIL_CHARS,
} from "./constants.ts";
import { getMaxAsyncTickets, getMaxConcurrent } from "./config.ts";
import type { TSchema } from "@sinclair/typebox";
import { delegateArgumentsSchema, delegateTaskSchema } from "./schema.ts";
import type { AgentConfig } from "./types.ts";

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
  const entries = [...agents];
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
    "Delegate subagents to execute tasks in parallel. Each subagent gets an independent context. Use the built-in `default` profile when it should mirror the live parent's model, thinking level, delegatable native tools, and base system prompt. Custom agents can be defined inline in a task or persisted as Markdown files.",
    "",
    "## Built-in Agent",
    "",
    "- **default**: mirrors the live parent model, thinking level, delegatable native tools, and base system prompt.",
    "",
    "Parent extension/MCP tools are not copied, and project context is rebuilt safely for the task's `cwd`. Per-task fields remain explicit overrides.",
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
    'delegate({ tasks: [{ sessionId: "auth-research", action: "close" }] })',
    "```",
    "",
    'Pooled agents remain live until `action: "close"` or parent Pi session shutdown.',
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
    "Set `async: true` to run tasks in the background. The top-level `action` controls the ticket:",
    "",
    "```ts",
    'delegate({ async: true, tasks: [{ prompt: "Investigate auth", systemPrompt: "You are a focused investigator.", tools: ["read", "grep", "find", "ls"] }] })',
    "```",
    "",
    '- `delegate({ action: "poll" })` \u2014 list all tickets',
    '- `delegate({ action: "poll", ticket: "abc123" })` \u2014 check one ticket',
    '- `delegate({ action: "wait", ticket: "abc123", timeoutMs: 600000 })` \u2014 block until finished or timeout',
    '- `delegate({ action: "cancel", ticket: "abc123" })` \u2014 preview activity and partial effects before cancelling',
    '- `delegate({ action: "cancel", ticket: "abc123", force: true })` \u2014 abort after review',
    "",
    `See the field tables above for the full semantics. Max ${getMaxAsyncTickets()} concurrent async tickets.`,
    "",
    "## Gotchas",
    "",
    "- `*` means read/write/edit/bash, not every tool. `grep`, `find`, and `ls` are valid explicit tools and are the `ro` preset.",
    '- `tasks` is an array. The tool recovers common stringified calls for compatibility, but canonical calls use `{ tasks: [{ prompt: "..." }] }`.',
    '- Use `agent: "default"` for the parent\'s live model/thinking/native tools/base prompt. Omitting `agent` creates an ad-hoc task with delegate defaults.',
    "- An ad-hoc task with no `tools` uses `*`; a named custom task uses its profile; a profile with no tools uses `*`.",
    "- Subagents inherit all skills discovered in their `cwd` (via AgentSession's resource loader). Per-task skill filtering is not supported — curate the cwd's skill set instead.",
    `- Sync \`delegate\` runs at most ${getMaxConcurrent()} tasks at once (the rest queue, not fail). Use \`async: true\` to move work to the background.`,
    "",
    "## Config",
    "",
    "Tunables live in `~/.pi/agent/delegate.json`: `maxConcurrent` (sync ceiling), `maxAsyncTickets` (background ticket cap), `stallTimeoutMs` (inactivity watchdog; default 900000, 0 disables), per-model/per-provider concurrency limits, and per-agent model overrides.",
    "The inactivity watchdog requests cooperative `AgentSession.abort()` cancellation and waits for the subagent to become idle; it is not a hard wall-clock execution deadline.",
    "",
    `Output bounding: subagent outputs longer than ${OUTPUT_SPILL_THRESHOLD_CHARS} characters are spilled to a temp file, and only the last ${OUTPUT_SPILL_TAIL_CHARS} characters stay in the LLM-facing result. Adjust with \`output.spillThresholdChars\` and \`output.spillTailChars\`. Spill files are written to the system temp directory with owner-only permissions; the full output is always available in the expanded TUI view and the spilled file.`,
  ].join("\n");
}

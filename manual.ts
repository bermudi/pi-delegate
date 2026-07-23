import {
  DEFAULT_TOOLS,
  POOL_TTL_MS,
  OUTPUT_SPILL_THRESHOLD_CHARS,
  OUTPUT_SPILL_TAIL_CHARS,
} from "./constants.ts";
import { getMaxAsyncTickets, getMaxConcurrent } from "./config.ts";
import type { TSchema } from "@sinclair/typebox";
import { delegateParameters, delegateTaskParameters } from "./schema.ts";
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
    "Delegate subagents to execute tasks in parallel. Each subagent gets an independent context, system prompt, model, tools, and thinking level. Custom agents can be defined inline in a task or persisted as Markdown files.",
    "",
    "## Available Custom Agents",
    "",
    agentList,
    "",
    "Custom agents are defined either inline in a task (using `systemPrompt`, `tools`, and `thinking`) or persisted as Markdown files in `.pi/agents/*.md` (project-local), `~/.pi/agent/agents/` (global), and `.claude/agents/` (interchange with Claude Code). Markdown agents are examples of custom agents — the parent model can shape the subagent it needs on each call. Each Markdown file is an agent with YAML-ish frontmatter:",
    "",
    "```markdown",
    "---",
    "name: my-agent",
    "description: What it does",
    "thinking: low                     # off/minimal/low/medium/high/xhigh",
    "tools: *                          # * = full agent. ro = read-only. Omit to inherit *.",
    "---",
    "You are a helpful agent...",
    "```",
    "",
    "## Task Fields",
    "",
    schemaTable(delegateTaskParameters.properties),
    "",
    "## Top-level Fields",
    "",
    schemaTable(delegateParameters.properties),
    "",
    "## Session Reuse",
    "",
    "When `sessionId` is set, the subagent is kept alive in a pool for the duration of the pi session.",
    "Subsequent calls with the same `sessionId` continue the conversation — the agent remembers prior context.",
    "",
    "```json",
    "// First call — creates and runs an inline custom agent",
    '{ "prompt": "Investigate the auth module", "systemPrompt": "You are a focused investigator. Map files and dependencies.", "tools": ["read", "grep", "find", "ls"], "sessionId": "auth-research" }',
    "",
    "// Second call — continues the same agent",
    '{ "prompt": "Now check the tests for that module", "sessionId": "auth-research" }',
    "",
    "// Clean up when done",
    '{ "prompt": "", "sessionId": "auth-research", "action": "close" }',
    "```",
    "",
    `Pooled agents are automatically closed after ${POOL_TTL_MS / 60_000} minutes of inactivity.`,
    "",
    "## Resuming Previous Sessions",
    "",
    "Use `resumeFrom` to continue a failed or interrupted subagent from where it left off.",
    "Pass the exact absolute path to the session `.jsonl` file copied from delegate retry output. Do not invent placeholder values, and do not use `resumeFrom` for async polling.",
    "The agent gets the full conversation history and the new `prompt` continues naturally.",
    "",
    "```json",
    "// Resume a failed browser test — agent remembers everything it already did",
    '{ "prompt": "Continue testing — the server is already running on :3000",',
    '  "resumeFrom": "/home/user/.pi/agent/sessions/project/2026-01-01T12-00-00Z_abc123.jsonl" }',
    "```",
    "",
    "Combine with `sessionId` to resume AND pool the agent for further multi-turn use:",
    "",
    "```json",
    '{ "prompt": "Continue the investigation",',
    '  "resumeFrom": "/path/to/session.jsonl",',
    '  "sessionId": "my-resumed-agent" }',
    "```",
    "",
    "## Async Mode",
    "",
    "Set `async: true` on the top-level call to fire tasks in the background:",
    "",
    "```json",
    'delegate({ async: true, tasks: [{ prompt: "Investigate auth", "systemPrompt": "You are a focused investigator.", "tools": ["read", "grep", "find", "ls"] }] })',
    "```",
    "\u2192 Returns ticket ID immediately. Parent keeps working.",
    "",
    '- `delegate({ action: "poll" })` \u2014 list all tickets',
    '- `delegate({ action: "poll", ticket: "abc123" })` \u2014 check one ticket',
    '- `delegate({ action: "cancel", ticket: "abc123" })` \u2014 abort a running ticket',
    "",
    `Max ${getMaxAsyncTickets()} concurrent async tickets. Results are delivered automatically when all tasks finish. Poll for progress while running, but avoid polling in a tight loop \u2014 do other work while waiting.`,
    "",
    "## Gotchas",
    "",
    '- `*` means the full agent (read, write, edit, bash), not "every tool." The grep/find/ls trio exists only for `ro` (read-only) agents where bash is unavailable — bash already subsumes them.',
    '- `tasks` must be an array, not a string containing JSON. Use `{ "tasks": [{ "prompt": "..." }] }`, never `{ "tasks": "[{...}]" }`.',
    "- Omitting `tools:` inherits the full agent set (`*`) — for both inline tasks and named agent files.",
    "- Omitting `model` inherits the parent model. Only specify a model when the subagent genuinely needs a different one; consistent model usage avoids auth and context surprises.",
    "- Subagents inherit all skills discovered in their `cwd` (via AgentSession's resource loader). Per-task skill filtering is not supported — curate the cwd's skill set instead.",
    `- Sync \`delegate\` runs at most ${getMaxConcurrent()} tasks at once (the rest queue, not fail). Use \`async: true\` to move work to the background.`,
    "- `with-parent-transcript` injects your entire conversation. A 50k-token session means the subagent starts 50k tokens deep.",
    "",
    "## Config",
    "",
    "Tunables live in `~/.pi/agent/delegate.json`: `maxConcurrent` (sync ceiling), `maxAsyncTickets` (background ticket cap), per-model/per-provider concurrency limits, and per-agent model overrides. Prefer parent model inheritance and use overrides sparingly.",
    "",
    `Output bounding: subagent outputs longer than ${OUTPUT_SPILL_THRESHOLD_CHARS} characters are spilled to a temp file, and only the last ${OUTPUT_SPILL_TAIL_CHARS} characters stay in the LLM-facing result. Adjust with \`output.spillThresholdChars\` and \`output.spillTailChars\`. Spill files are written to the system temp directory with owner-only permissions; the full output is always available in the expanded TUI view and the spilled file.`,
  ].join("\n");
}

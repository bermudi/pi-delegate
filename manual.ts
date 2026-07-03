import { Type } from "@sinclair/typebox";
import { DEFAULT_TOOLS, VALID_THINKING, POOL_TTL_MS } from "./constants.ts";
import { getMaxAsyncTickets, getMaxConcurrent } from "./config.ts";
import type { AgentConfig } from "./types.ts";

// ── Extracted schema constant ───────────────────────────────────────────
// Avoids inline `this` context issues and lets TypeScript infer params safely.
export const delegateParameters = Type.Object({
  action: Type.Optional(
    Type.String({
      enum: ["poll", "cancel"],
    }),
  ),
  async: Type.Optional(Type.Boolean()),
  ticket: Type.Optional(Type.String()),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        prompt: Type.Optional(Type.String()),
        agent: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        // ── Undocumented overrides — accepted but not advertised in schema.
        // Discovered via empty-tasks help text.
        systemPrompt: Type.Optional(Type.String()),
        context: Type.Optional(
          Type.String({ enum: ["fresh", "with-parent-transcript"] }),
        ),
        model: Type.Optional(Type.String()),
        tools: Type.Optional(Type.Array(Type.String())),
        thinking: Type.Optional(
          Type.String({
            enum: [...VALID_THINKING],
          }),
        ),
        sessionId: Type.Optional(Type.String()),
        action: Type.Optional(
          Type.String({
            enum: ["prompt", "close", "list", "poll", "cancel"],
          }),
        ),
        resumeFrom: Type.Optional(Type.String()),
      }),
      {
        minItems: 0,
      },
    ),
  ),
});

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
                  : a.scope === "builtin"
                    ? " [builtin]"
                    : "";
          return `- **${n}**${model}${thinking}${tools}${scope}: ${a.description}`;
        })
        .join("\n")
    : "_(none defined)_";

  return [
    "# Delegate Tool Manual",
    "",
    "Delegate subagents to execute tasks in parallel. Each subagent gets an independent context, system prompt, model, tools, and thinking level.",
    "",
    "## Available Agents",
    "",
    agentList,
    "",
    "Agents live in `.pi/agents/*.md` (project-local), `~/.pi/agent/agents/` (global), and `.claude/agents/` (interchange with Claude Code). Each agent file is Markdown with YAML-ish frontmatter:",
    "",
    "```markdown",
    "---",
    "name: my-agent",
    "description: What it does",
    "model: anthropic/claude-haiku-4-5  # optional",
    "thinking: low                     # off/minimal/low/medium/high/xhigh",
    "tools: *                          # * = full agent. ro = read-only. Omit to inherit *.",
    "---",
    "You are a helpful agent...",
    "```",
    "",
    "## Task Fields",
    "",
    "- `prompt` — The task for this subagent. Optional when `resumeFrom` is set (defaults to a continuation prompt).",
    "- `agent` — Named agent from the list above. Inline fields override agent defaults.",
    "- `systemPrompt` — System prompt. Falls back to agent definition, then parent session system prompt.",
    "- `model` — e.g. `anthropic/claude-sonnet-4`. Falls back to agent default, then parent model.",
    "- `tools` — Tool names or shorthands (`*` = full: read,write,edit,bash; `ro` = read-only: read,grep,find,ls). Omitted → inherit `*`. Claude Code tool names (Read/Glob/…) are mapped automatically; unmappable tools are dropped.",
    "- `thinking` — off, minimal, low, medium, high, xhigh. Default: agent setting or 'off'.",
    "- `cwd` — Working directory for the subagent (settings, AGENTS.md resolution). Default: parent session cwd. Named-agent discovery is always parent-session-scoped regardless of per-task cwd.",
    "- `context` — 'fresh' (default) or 'with-parent-transcript' to inject the full parent conversation into the subagent's prompt (token-expensive — use deliberately).",
    "- `sessionId` — Name for a persistent subagent. First use creates it, subsequent calls reuse the same agent (multi-turn).",
    "- `action` — Per-task action: 'prompt' (default), 'close' to tear down a pooled session, 'list' to show active sessions.",
    "- top-level `action` — Async ticket action: 'poll' or 'cancel'. Does not require `tasks`.",
    "- `tasks` must be a real JSON array of objects, not a quoted/stringified JSON array.",
    "",
    "## Session Reuse",
    "",
    "When `sessionId` is set, the subagent is kept alive in a pool for the duration of the pi session.",
    "Subsequent calls with the same `sessionId` continue the conversation — the agent remembers prior context.",
    "",
    "```json",
    "// First call — creates and runs",
    '{ "prompt": "Investigate the auth module", "agent": "scout", "sessionId": "auth-research" }',
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
    'delegate({ async: true, tasks: [{ agent: "scout", prompt: "Investigate auth" }] })',
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
    "- Subagents inherit all skills discovered in their `cwd` (via AgentSession's resource loader). Per-task skill filtering is not supported — curate the cwd's skill set instead.",
    `- Sync \`delegate\` runs at most ${getMaxConcurrent()} tasks at once (the rest queue, not fail). Use \`async: true\` to move work to the background.`,
    "- `with-parent-transcript` injects your entire conversation. A 50k-token session means the subagent starts 50k tokens deep.",
    "",
    "## Config",
    "",
    "Tunables live in `~/.pi/agent/delegate.json`: `maxConcurrent` (sync ceiling), `maxAsyncTickets` (background ticket cap), per-model/per-provider concurrency limits, and global model overrides.",
  ].join("\n");
}

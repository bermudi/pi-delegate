/**
 * delegate — In-process subagent delegation for pi.
 *
 * Borrows apple-pi's architecture (pi-agent-core Agent class, Promise.all
 * parallelism) with per-task overrides for model, skills, tools, thinking
 * level, system prompt, and working directory.
 *
 * Agent definitions live in .pi/agents/*.md (project) and ~/.pi/agent/agents/*.md (user).
 * Each task can reference a named agent and/or supply inline overrides.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Api, type Model, streamSimple } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinking: ThinkingLevel;
  tools: string[];
  skills: string[];
  systemPrompt: string;
}

export interface TaskDef {
  prompt: string;
  agent?: string;
  model?: string;
  skills?: string[];
  tools?: string[];
  thinking?: string;
  systemPrompt?: string;
  cwd?: string;
  context?: "fresh" | "inherit";
}

export interface TaskProgress {
  index: number;
  agent: string;
  task: string;
  status: "pending" | "running" | "done" | "failed";
  durationMs: number;
  tokens: number;
  toolUses: number;
  error?: string;
  model?: string;
}

export interface DelegateDetails {
  tasks: TaskDef[];
  results: (TaskResult | { error: string })[];
  progress: TaskProgress[];
  parentModel?: string;
}

export interface TaskResult {
  agent: string;
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

export const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool registry needs generic param to avoid contravariance on execute()
export const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any>> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

export const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

// ── Frontmatter ───────────────────────────────────────────────────────────

export function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: content.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { data, body: m[2]!.trim() };
}

// ── Agent Discovery ───────────────────────────────────────────────────────

export function findProjectRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".pi", "agents"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadAgentFile(filePath: string): AgentConfig | null {
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }
  const { data, body } = parseFrontmatter(content);
  if (!data.name || !data.description) return null;
  return {
    name: data.name,
    description: data.description,
    model: data.model,
    thinking: VALID_THINKING.has(data.thinking ?? "") ? (data.thinking as ThinkingLevel) : "off",
    tools: data.tools ? data.tools.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TOOLS,
    skills: data.skills ? data.skills.split(",").map((s) => s.trim()).filter(Boolean) : [],
    systemPrompt: body,
  };
}

export function discoverAgents(cwd: string): Map<string, AgentConfig> {
  const dirs: string[] = [];
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot) dirs.push(path.join(projectRoot, ".pi", "agents"));
  dirs.push(userDir);

  const agents = new Map<string, AgentConfig>();
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.name.endsWith(".md") || e.name.endsWith(".chain.md")) continue;
      const cfg = loadAgentFile(path.join(dir, e.name));
      if (cfg && !agents.has(cfg.name)) agents.set(cfg.name, cfg);
    }
  }
  return agents;
}

// ── Parent Context ────────────────────────────────────────────────────────

export function buildParentTranscript(entries: SessionEntry[], leafId: string | null): string | null {
  try {
    const ctx = buildSessionContext(entries, leafId);
    const lines: string[] = [];
    for (const msg of ctx.messages) {
      if (msg.role === "user") {
        const text = extractTextContent(msg.content);
        if (text) lines.push(`**User:** ${text.trim()}`);
      } else if (msg.role === "assistant") {
        const text = extractTextContent(msg.content);
        if (text) lines.push(`**Assistant:** ${text.trim()}`);
      }
    }
    return lines.join("\n\n") || null;
  } catch {
    return null;
  }
}

export function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// ── Skill Loading ─────────────────────────────────────────────────────────

export function loadSkill(name: string, cwd: string): string | null {
  const candidates = [
    // Project (standard → pi-specific)
    path.join(cwd, ".agents", "skills", name, "SKILL.md"),
    path.join(cwd, ".pi", "skills", name, "SKILL.md"),
    // User (standard → pi-specific)
    path.join(os.homedir(), ".agents", "skills", name, "SKILL.md"),
    path.join(os.homedir(), ".pi", "agent", "skills", name, "SKILL.md"),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf-8"); } catch { /* skip */ }
  }
  return null;
}

// ── Model Resolution ──────────────────────────────────────────────────────

export function resolveModel(spec: string | undefined, registry: ModelRegistry, parentModel: Model<Api> | undefined): Model<Api> | undefined {
  if (!spec) return parentModel;
  const idx = spec.indexOf("/");
  if (idx === -1) {
    // Bare id — match against available models
    const match = registry.getAvailable().find((m) => m.id === spec);
    return match ?? undefined;
  }
  return registry.find(spec.slice(0, idx), spec.slice(idx + 1)) ?? undefined;
}

// ── Agent Runner ──────────────────────────────────────────────────────────

interface AgentProgressUpdate {
  tokens: number;
  toolUses: number;
  durationMs: number;
}

async function runAgent(
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  },
  prompt: string,
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
  onProgress?: (update: AgentProgressUpdate) => void,
): Promise<{ output: string; error?: string; durationMs: number; tokens: number }> {
  const start = Date.now();

  const tools = config.tools
    .map((name) => TOOL_FACTORIES[name]?.(config.cwd))
    .filter(Boolean) as AgentTool[];

  let tokens = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model: config.model,
      thinkingLevel: config.thinking,
      tools,
    },
    convertToLlm,
    streamFn: async (m, context, options) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(m);
      if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
      return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
    },
  });

  // Track real-time progress via agent events
  let toolUses = 0;
  if (onProgress) {
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        toolUses++;
        const usage = extractUsage(agent.state.messages);
        onProgress({ tokens: usage.total, toolUses, durationMs: Date.now() - start });
      } else if (event.type === "message_end") {
        const usage = extractUsage(agent.state.messages);
        onProgress({ tokens: usage.total, toolUses, durationMs: Date.now() - start });
      }
    });
  }

  if (signal) {
    const onAbort = () => { try { agent.abort(); } catch { /* */ } };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();

    const state = (agent as unknown as { state: { messages: AgentMessage[]; errorMessage?: string } }).state;
    const errorMessage = state.errorMessage;

    const output = extractOutput(state.messages);
    const usage = extractUsage(state.messages);

    return {
      output: output || "(no output)",
      error: errorMessage,
      durationMs: Date.now() - start,
      tokens: usage.total,
    };
  } catch (err) {
    return {
      output: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      tokens: 0,
    };
  }
}

// ── Output Extraction ────────────────────────────────────────────────────

export function extractOutput(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

export function extractUsage(messages: AgentMessage[]) {
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0 };
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = msg.usage as any;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.total += u.total ?? (u.input ?? 0) + (u.output ?? 0);
  }
  return usage;
}

// ── Formatting ────────────────────────────────────────────────────────────

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}m${secs}s`;
}

export function fmtTokens(n: number): string {
  return n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export const tree = (i: number, n: number) => i === n - 1 ? "└─" : "├─";
export const indent = (i: number, n: number) => i === n - 1 ? "   " : "│  ";

// ── Extension ─────────────────────────────────────────────────────────────

export default function delegateExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    promptSnippet: "Spawn subagents in parallel — each with independent context, model, tools, and skills.",
    promptGuidelines: [
      "Use delegate to parallelize independent work across subagents. Each task must include \"prompt\"; specify \"agent\" (name from .pi/agents/*.md or ~/.pi/agent/agents/*.md) and/or \"systemPrompt\". All other fields (model, tools, skills, thinking, cwd, context) are optional and fall back to agent defaults or parent session values.",
      "Subagents only have pi core tools: read, write, edit, bash, grep, find, ls.",
      "Call delegate with an empty tasks array to see available agents and full usage documentation.",
    ],
    description:
      "Spawn subagents in parallel. Call with an empty tasks array for full help.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          prompt: Type.String({ description: "The task for this subagent to perform." }),
          agent: Type.Optional(Type.String({
            description: "Named agent from .pi/agents/*.md (project) or ~/.pi/agent/agents/*.md (user). Inline fields override agent defaults.",
          })),
          model: Type.Optional(Type.String({
            description: "Model (e.g. 'anthropic/claude-sonnet-4'). Falls back to agent default, then parent model.",
          })),
          skills: Type.Optional(Type.Array(Type.String(), {
            description: "Skill names to inject into the system prompt.",
          })),
          tools: Type.Optional(Type.Array(Type.String(), {
            description: "Tools the subagent may use: read, write, edit, bash, grep, find, ls.",
          })),
          thinking: Type.Optional(Type.String({
            description: "Thinking level: off, minimal, low, medium, high, xhigh. Defaults to agent or off.",
          })),
          systemPrompt: Type.Optional(Type.String({
            description: "System prompt. Replaces agent system prompt entirely if set.",
          })),
          cwd: Type.Optional(Type.String({
            description: "Working directory. Defaults to parent session cwd.",
          })),
          context: Type.Optional(Type.String({
            enum: ["fresh", "inherit"],
            description: "'fresh' for clean context, 'inherit' to include parent session transcript.",
          })),
        }),
        { minItems: 0, description: "Tasks to run in parallel. Pass an empty array to see available agents and usage docs." },
      ),
    }),

    async execute(_id, params: { tasks: TaskDef[] }, signal, onUpdate, ctx) {
      const parentModelId = ctx.model?.id;
      const agents = discoverAgents(ctx.cwd);

      // ── Help mode ─────────────────────────────────────────────────
      if (!params.tasks.length) {
        const names = [...agents.keys()];
        const agentList = names.length
          ? names.map((n) => {
              const a = agents.get(n)!;
              const model = a.model ? ` (model: ${a.model})` : "";
              const thinking = a.thinking !== "off" ? ` [thinking: ${a.thinking}]` : "";
              const tools = a.tools.length !== DEFAULT_TOOLS.length || a.tools.some((t, i) => t !== DEFAULT_TOOLS[i])
                ? ` tools: ${a.tools.join(", ")}` : "";
              return `- **${n}**${model}${thinking}${tools}: ${a.description}`;
            }).join("\n")
          : "_(none defined)_";
        return {
          content: [{ type: "text", text: [
            "# Delegate Help",
            "",
            "Spawn subagents to execute tasks in parallel. Each subagent gets an independent context, system prompt, model, tools, skills, and thinking level.",
            "",
            "## Available Agents",
            "",
            agentList,
            "",
            "Agents live in `.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (user). Project agents override user agents by name. Each agent file is Markdown with YAML-ish frontmatter:",
            "",
            "```markdown",
            "---",
            "name: my-agent",
            "description: What it does",
            "model: anthropic/claude-haiku-4-5  # optional",
            "thinking: low                     # off/minimal/low/medium/high/xhigh",
            "tools: read, grep, bash           # default: all 7 core tools",
            "skills: web-content               # comma-separated skill names",
            "---",
            "You are a helpful agent...",
            "```",
            "",
            "## Task Fields",
            "",
            "- `prompt` (required) — The task for this subagent.",
            "- `agent` — Named agent from the list above. Inline fields override agent defaults.",
            "- `systemPrompt` — System prompt. Required if no `agent` specified.",
            "- `model` — e.g. `anthropic/claude-sonnet-4`. Falls back to agent default, then parent model.",
            "- `tools` — Array of tool names. Default: read, write, edit, bash, grep, find, ls.",
            "- `skills` — Skill names injected into the system prompt.",
            "- `thinking` — off, minimal, low, medium, high, xhigh. Default: agent setting or 'off'.",
            "- `cwd` — Working directory. Default: parent session cwd.",
            "- `context` — 'fresh' (default) or 'inherit' to include parent session transcript.",
          ].join("\n") }],
          details: { tasks: [], results: [], progress: [], parentModel: parentModelId },
        };
      }

      // ── Validate ──────────────────────────────────────────────────
      const unknown: string[] = [];
      for (const t of params.tasks) {
        if (t.agent && !agents.has(t.agent)) unknown.push(t.agent);
      }
      if (unknown.length) {
        const names = [...agents.keys()];
        return {
          content: [{ type: "text", text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}. Call delegate with no tasks for full help.` }],
          details: { tasks: params.tasks, results: [], progress: [], parentModel: parentModelId },
        };
      }

      // ── Resolve tasks ─────────────────────────────────────────────
      // Build parent transcript lazily — only computed once if any task uses inherit
      let parentTranscript: string | null = null;
      const hasInherit = params.tasks.some((t) => t.context === "inherit");
      if (hasInherit) {
        parentTranscript = buildParentTranscript(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      }

      const resolved = params.tasks.map((t, i) => {
        const agent = t.agent ? agents.get(t.agent) : undefined;
        const cwd = t.cwd ?? ctx.cwd;

        // Build system prompt
        let systemPrompt = t.systemPrompt ?? agent?.systemPrompt ?? "";
        if (!systemPrompt.trim()) {
          throw new Error(`Task ${i}: no system prompt — specify agent, systemPrompt, or both.`);
        }

        // Inject skills
        const skillNames = t.skills ?? agent?.skills ?? [];
        const skillBodies: string[] = [];
        for (const name of skillNames) {
          const content = loadSkill(name, cwd);
          if (content) skillBodies.push(content);
        }
        if (skillBodies.length) {
          systemPrompt = systemPrompt.trimEnd() + "\n\n" + skillBodies.join("\n\n");
        }

        // Build prompt — wrap with parent context if inheriting
        let prompt = t.prompt;
        const inheritCtx = t.context === "inherit" && parentTranscript ? parentTranscript : null;
        if (inheritCtx) {
          prompt = [
            "<parent-session>",
            "The following is the conversation from the parent session.",
            "Read this for context, then execute the task below.",
            "Do not continue the parent conversation or respond to prior messages.",
            "",
            inheritCtx,
            "</parent-session>",
            "",
            "## Task",
            prompt,
          ].join("\n");
        }

        // Resolve model (falls back to parent model if specification fails to resolve)
        const modelSpec = t.model ?? agent?.model;
        const resolvedModel = resolveModel(modelSpec, ctx.modelRegistry, ctx.model) ?? ctx.model;
        if (!resolvedModel) {
          throw new Error(`Task ${i}: no model available — parent session has no model set.`);
        }
        const model = resolvedModel;

        // Resolve tools — warn about unknown tool names
        const tools = t.tools ?? agent?.tools ?? DEFAULT_TOOLS;
        const unknownTools = tools.filter((name) => !(name in TOOL_FACTORIES));

        // Resolve thinking
        const thinkingRaw = t.thinking ?? agent?.thinking ?? "off";
        const thinking = VALID_THINKING.has(thinkingRaw) ? (thinkingRaw as ThinkingLevel) : "off";

        const warnings: string[] = [];
        if (unknownTools.length) {
          warnings.push(`Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`);
        }
        return { ...t, cwd, systemPrompt, model, tools, thinking, prompt, agentName: agent?.name ?? "inline", warnings };
      });

      // ── Progress tracking ─────────────────────────────────────────
      const startedAt = Date.now();
      const progress: TaskProgress[] = resolved.map((t, i) => ({
        index: i,
        agent: t.agentName,
        task: trunc(t.prompt, 50),
        status: "pending" as const,
        durationMs: 0,
        tokens: 0,
        toolUses: 0,
        model: t.model?.id,
      }));
      const fire = () => onUpdate?.({
        content: [{ type: "text", text: `Running ${resolved.length} subagent${resolved.length > 1 ? "s" : ""}…` }],
        details: { tasks: params.tasks, results: [], progress: [...progress], parentModel: parentModelId },
      });
      fire();

      // ── Run parallel ──────────────────────────────────────────────
      const results = await Promise.allSettled(resolved.map(async (t, i) => {
        const p = progress[i]!;
        p.status = "running"; p.model = t.model?.id; fire();
        try {
          const r = await runAgent(
            { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd },
            t.prompt,
            ctx.modelRegistry,
            signal,
            (u) => { p.tokens = u.tokens; p.toolUses = u.toolUses; p.durationMs = u.durationMs; fire(); },
          );
          p.status = r.error ? "failed" : "done";
          p.durationMs = r.durationMs;
          p.tokens = r.tokens;
          p.error = r.error;
          fire();
          return { agent: t.agentName, output: r.output, error: r.error, durationMs: r.durationMs, tokens: r.tokens };
        } catch (err) {
          p.status = "failed";
          p.error = err instanceof Error ? err.message : String(err);
          fire();
          throw err;
        }
      }));

      // ── Format for LLM ────────────────────────────────────────────
      const finalResults = results.map((r, i) =>
        r.status === "fulfilled" ? r.value : { agent: resolved[i]!.agentName, output: "", error: String(r.reason), durationMs: 0, tokens: 0 },
      );
      const elapsedTotal = Date.now() - startedAt;

      const parts: string[] = [];
      const succeeded = finalResults.filter((r) => !r.error).length;
      parts.push(`${succeeded}/${finalResults.length} tasks completed successfully · ${fmtDuration(elapsedTotal)} wall time\n`);
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i]!;
        const t = resolved[i]!;
        parts.push(`=== ${r.agent}: ${trunc(t.prompt, 80)} ===`);
        if (t.warnings?.length) {
          for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
        }
        if (r.error) {
          parts.push(`[FAILED: ${r.error}]`);
        } else {
          parts.push(`[OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens]\n\n${r.output}`);
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: { tasks: params.tasks, results: finalResults, progress, parentModel: parentModelId },
      };
    },

    renderCall(args, theme, ctx) {
      const state = ctx.state as { startedAt?: number; interval?: ReturnType<typeof setInterval> };
      if (ctx.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
      const tasks = (args as { tasks?: TaskDef[] }).tasks ?? [];
      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (!tasks.length) {
        text.setText(theme.fg("toolTitle", theme.bold("delegate")));
        return text;
      }
      const lines = [theme.fg("toolTitle", theme.bold(`delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""}`))];
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]!;
        const label = t.agent ? theme.bold(t.agent) : "inline";
        lines.push(`${tree(i, tasks.length)} ${label} ${theme.fg("muted", trunc(t.prompt, 60))}`);
      }
      text.setText(lines.join("\n"));
      return text;
    },

    renderResult(result, options, theme, ctx) {
      const state = ctx.state as { startedAt?: number; interval?: ReturnType<typeof setInterval> };
      if (options.isPartial && !state.interval) state.interval = setInterval(() => ctx.invalidate(), 1000);
      if (!options.isPartial && state.interval) { clearInterval(state.interval); state.interval = undefined; }
      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      const details = result.details as DelegateDetails | undefined;
      if (!details?.progress?.length) {
        const content = (result.content as Array<{ type: string; text: string }>)
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") ?? "";
        text.setText(content ? `\n${content}` : "");
        return text;
      }

      const { progress, results: taskResults } = details;
      const total = progress.length;
      const lines: string[] = [""];

      if (options.isPartial) {
        const done = progress.filter((p) => p.status === "done" || p.status === "failed").length;
        const elapsed = state.startedAt ? ` · ${fmtDuration(Date.now() - state.startedAt)}` : "";
        lines.push(theme.fg("muted", `Running ${total} subagent${total > 1 ? "s" : ""}…${elapsed}`), "");
        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const stats = (parts: string[]) => parts.length ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "";
          const modelTag = p.model && p.model !== details.parentModel ? theme.fg("accent", ` ${p.model}`) : "";
          switch (p.status) {
            case "done":
              lines.push(`${tree(i, total)} ${theme.fg("success", "✓")} ${theme.bold(p.agent)}${modelTag}${stats([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`);
              break;
            case "failed":
              lines.push(`${tree(i, total)} ${theme.fg("error", "✗")} ${theme.bold(p.agent)}${modelTag}${p.error ? theme.fg("error", ` ${p.error}`) : ""}`);
              break;
            case "running":
              lines.push(`${tree(i, total)} ${theme.fg("warning", "●")} ${theme.bold(p.agent)}${modelTag}${stats(p.toolUses > 0 ? [`${p.toolUses} tool use${p.toolUses > 1 ? "s" : ""}`, `${fmtTokens(p.tokens)} tokens`] : [])}`);
              break;
            default:
              lines.push(`${tree(i, total)} ${theme.fg("muted", "○")} ${theme.bold(p.agent)}${modelTag} ${theme.fg("muted", "waiting…")}`);
          }
        }
        if (done > 0 && done < total) lines.push("", theme.fg("muted", `${done}/${total} complete`));
      } else {
        const succeeded = progress.filter((p) => p.status === "done").length;
        const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);
        const totalMs = progress.reduce((sum, p) => sum + p.durationMs, 0);
        const elapsed = state.startedAt ? fmtDuration(Date.now() - state.startedAt) : fmtDuration(totalMs);
        lines.push(theme.fg("muted", `${succeeded}/${total} completed · ${elapsed} wall · ${fmtTokens(totalTokens)} tokens`), "");

        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const r = taskResults[i];
          const ind = indent(i, total);
          const icon = p.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const stats = theme.fg("muted", ` · ${fmtDuration(p.durationMs)} · ${fmtTokens(p.tokens)} tokens`);
          lines.push(`${tree(i, total)} ${icon} ${theme.bold(p.agent)} ${theme.fg("muted", `(${p.task})`)}${stats}`);

          if (r && "output" in r && r.output?.trim() && r.output !== "(no output)") {
            const outputLines = r.output.trim().split("\n");
            const maxLines = options.expanded ? outputLines.length : 3;
            for (const line of outputLines.slice(0, maxLines)) lines.push(`${ind}${theme.fg("toolOutput", line)}`);
            const remaining = outputLines.length - maxLines;
            if (remaining > 0) lines.push(`${ind}${theme.fg("muted", `… ${remaining} more lines`)}`);
          } else if (r && "error" in r && r.error) {
            lines.push(`${ind}${theme.fg("error", r.error)}`);
          }
        }
      }

      text.setText(lines.join("\n"));
      return text;
    },
  });
}

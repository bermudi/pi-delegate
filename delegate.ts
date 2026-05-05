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

export interface ToolActivity {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: {
    content: Array<{ type: string; text?: string }>;
    isError: boolean;
  };
  startTime: number;
  endTime?: number;
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
  lastActivityAt?: number;
  activities: ToolActivity[];
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

/** Maximum concurrent subagent tasks. Prevents rate-limit thundering herds. */
export const MAX_CONCURRENCY = 3;

// ── Render helpers ───────────────────────────────────────────────────────

/** Braille spinner frames for live progress animation. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function spinnerFrame(): string {
  return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}

/** Get terminal width, clamped to a reasonable range. */
function getTermWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns || 120, 200));
}

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 * Uses Intl.Segmenter for proper Unicode/emoji handling.
 */
function truncLine(text: string, maxWidth: number): string {
  // Quick path for short strings
  if (text.length <= maxWidth + 20) {
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
    if (stripped.length <= maxWidth) return text;
  }

  const target = maxWidth - 1; // reserve space for "…"
  let result = "";
  let vis = 0;
  let activeStyles: string[] = [];
  let i = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  while (i < text.length) {
    // Capture ANSI escape sequences
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;
      if (code === "\x1b[0m" || code === "\x1b[m") activeStyles = [];
      else activeStyles.push(code);
      i += code.length;
      continue;
    }

    const ch = text[i++]!;
    // Count visible width (rough approximation for most chars)
    const w = ch.codePointAt(0)! > 0x1f00 && ch.codePointAt(0)! < 0xffff ? 2 : 1;

    if (vis + w > target) return result + activeStyles.join("") + "…";
    result += ch;
    vis += w;
  }

  return text;
}

/** Fit text to terminal width, expanding visually when expanded mode is on. */
function fit(text: string, width: number, expanded: boolean): string {
  return expanded ? text : truncLine(text, width);
}

/**
 * Apply a line budget so the TUI doesn't overflow the terminal.
 * Returns lines trimmed to fit within `budget` visible rows.
 */
function applyLineBudget(lines: string[], expanded: boolean): string[] {
  const rows = process.stdout.rows || 30;
  const budget = expanded
    ? Math.max(12, Math.min(24, Math.floor(rows * 0.55)))
    : Math.max(8, Math.min(14, Math.floor(rows * 0.35)));
  if (lines.length <= budget) return lines;
  const hidden = lines.length - budget + 1;
  return [...lines.slice(0, budget - 1), `… ${hidden} lines hidden · Ctrl+O expands`];
}

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

// ── Retry ─────────────────────────────────────────────────────────────────

/** Pattern matching transient errors that benefit from retry.
 *  Exported for testability — add test cases when error signatures evolve. */
export const RETRYABLE_PATTERN = /overloaded|429|rate.?limit|too many requests|500|502|503|504|timed? out|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|terminated|retry delay/i;

/**
 * Custom error for abort signals — avoids brittle string-matching on
 * error messages when distinguishing between expected aborts and real failures.
 */
class AbortError extends Error {
  override name = "AbortError";
  constructor() { super("Aborted"); }
}

/** Sleep for ms, aborting early if signal fires. */
async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(new AbortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      // Close TOCTOU window: signal could have fired between our early
      // aborted check above and addEventListener here.
      if (signal.aborted) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(new AbortError());
      }
    }
  });
}

// ── Concurrency Limiter ───────────────────────────────────────────────────

/** Map over items with a concurrency cap, returning Promise.allSettled-shaped results.
 *  Callers must ensure `fn` always settles (either resolves or throws) — the
 *  concurrency limiter guarantees every claimed index gets a result assigned.
 *  If `fn` exits early on abort (via the signal param), it must throw so
 *  `results[i]` is populated with a rejection. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!, i) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  };
  await Promise.all(Array(limit).fill(null).map(() => worker()));
  return results;
}

// ── Agent Runner ──────────────────────────────────────────────────────────

interface AgentProgressUpdate {
  tokens: number;
  toolUses: number;
  durationMs: number;
  lastActivityAt?: number;
  activities: ToolActivity[];
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
  // maxRetries is the number of *retries* after the initial attempt (total = maxRetries + 1).
  maxRetries = 3,
  retryBaseMs = 2000,
): Promise<{ output: string; error?: string; durationMs: number; tokens: number }> {
  const start = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return { output: "", error: "Aborted", durationMs: Date.now() - start, tokens: 0 };
    }

    const tools = config.tools
      .map((name) => TOOL_FACTORIES[name]?.(config.cwd))
      .filter(Boolean) as AgentTool[];

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

    // Track real-time progress via agent events (reset each attempt so UI
    // reflects the current attempt, not a stale peak from a failed one).
    let toolUses = 0;
    let lastActivityAt: number | undefined;
    const activities: ToolActivity[] = [];
    const pendingById = new Map<string, ToolActivity>();

    if (onProgress) {
      if (attempt > 0) onProgress({ tokens: 0, toolUses: 0, durationMs: Date.now() - start, activities: [] });
      agent.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          const now = Date.now();
          lastActivityAt = now;
          const activity: ToolActivity = {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            startTime: now,
          };
          pendingById.set(event.toolCallId, activity);
          activities.push(activity);
          // Fire progress so UI shows the new activity immediately,
          // not just when the tool completes.
          const usage = extractUsage(agent.state.messages);
          onProgress({ tokens: usage.total, toolUses, durationMs: Date.now() - start, lastActivityAt, activities: [...activities] });
        } else if (event.type === "tool_execution_end") {
          lastActivityAt = Date.now();
          const activity = pendingById.get(event.toolCallId);
          if (activity) {
            activity.result = {
              content: event.result?.content ?? [],
              isError: event.isError,
            };
            activity.endTime = lastActivityAt;
            pendingById.delete(event.toolCallId);
          }
          toolUses++;
          const usage = extractUsage(agent.state.messages);
          onProgress({ tokens: usage.total, toolUses, durationMs: Date.now() - start, lastActivityAt, activities: [...activities] });
        } else if (event.type === "message_end") {
          lastActivityAt = Date.now();
          const usage = extractUsage(agent.state.messages);
          onProgress({ tokens: usage.total, toolUses, durationMs: Date.now() - start, lastActivityAt, activities: [...activities] });
        }
      });
    }

    // Register abort handler and clean up on success so listeners don't
    // accumulate across retries.
    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => { try { agent.abort(); } catch { /* */ } };
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      await agent.prompt(prompt);
      await agent.waitForIdle();

      const state = agent.state as { messages: AgentMessage[]; errorMessage?: string };
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
      const msg = err instanceof Error ? err.message : String(err);

      if (attempt < maxRetries && RETRYABLE_PATTERN.test(msg)) {
        // Exponential backoff with jitter
        const delay = retryBaseMs * Math.pow(2, attempt) + Math.random() * retryBaseMs;
        try { await sleepWithAbort(delay, signal); } catch (sleepErr) {
          // Swallow expected abort during sleep; re-throw anything unexpected.
          if (!(sleepErr instanceof AbortError)) throw sleepErr;
        }
        continue;
      }

      // Non-retryable or max retries exhausted
      return {
        output: "",
        error: msg,
        durationMs: Date.now() - start,
        tokens: 0,
      };
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  // Unreachable — every code path inside the loop returns. Defense-in-depth.
  return {
    output: "",
    error: "Unknown error",
    durationMs: Date.now() - start,
    tokens: 0,
  };
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

/** Shorten a path by replacing $HOME with ~ */
export function shortenPath(p: string): string {
  const home = process.env.HOME;
  if (!home || home === "/") return p;
  // Exact home match
  if (p === home) return "~";
  // Prefix check with separator to avoid /home/alice matching /home/alice2
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (p.startsWith(prefix)) return "~" + path.sep + p.slice(prefix.length);
  return p;
}

/** Human-readable activity age ("active now", "active 5s ago", etc.) */
export function getActivityAge(lastActivityAt: number | undefined): string {
  if (lastActivityAt === undefined) return "";
  const ago = Math.max(0, Date.now() - lastActivityAt);
  if (ago < 1000) return "active now";
  if (ago < 60000) return `active ${Math.floor(ago / 1000)}s ago`;
  return `active ${Math.floor(ago / 60000)}m ago`;
}

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

// ── Tool Activity Formatting ─────────────────────────────────────────────

/** Pick the first non-empty arg value for display, preferring the named key then common fallbacks. */
function firstArg(args: Record<string, unknown>, primary: string, fallbacks: string[] = []): string | undefined {
  for (const key of [primary, ...fallbacks]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val;
  }
  return undefined;
}

function formatToolCallShort(name: string, args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return name;
  switch (name) {
    case "bash": {
      const cmd = firstArg(args, "command") ?? "...";
      const maxLen = 80;
      return `$ ${cmd.length > maxLen ? cmd.slice(0, maxLen) + "…" : cmd}`;
    }
    case "read": {
      const p = shortenPath(firstArg(args, "path", ["file_path"]) ?? "...");
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let line = `read ${p}`;
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "";
        line += `:${start}${end ? `-${end}` : ""}`;
      }
      return line;
    }
    case "write": {
      const p = shortenPath(firstArg(args, "path", ["file_path"]) ?? "...");
      const lines = String(args.content ?? "").split("\n").length;
      return `write ${p}${lines > 1 ? ` (${lines} lines)` : ""}`;
    }
    case "edit": {
      const p = shortenPath(firstArg(args, "path", ["file_path"]) ?? "...");
      return `edit ${p}`;
    }
    case "ls": return `ls ${shortenPath(String(args.path ?? "."))}`;
    case "grep": return `grep /${String(args.pattern ?? "")}/ in ${shortenPath(String(args.path ?? "."))}`;
    case "find": return `find ${String(args.pattern ?? "*")} in ${shortenPath(String(args.path ?? "."))}`;
    default: {
      // Try to pick a meaningful first arg before falling back to JSON
      for (const key of ["command", "path", "file_path", "pattern", "query", "url", "task", "prompt"]) {
        const val = args[key];
        if (typeof val === "string" && val.trim()) {
          const preview = val.length > 50 ? val.slice(0, 50) + "…" : val;
          return `${name} ${preview}`;
        }
      }
      try {
        const preview = JSON.stringify(args).slice(0, 50);
        return `${name} ${preview}${preview.length >= 50 ? "…" : ""}`;
      } catch {
        return name;
      }
    }
  }
}


function getToolResultText(activity: ToolActivity): string {
  if (!activity.result) return "";
  const blocks = activity.result.content.filter(
    (c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string",
  );
  return blocks.map((b) => b.text).join("\n");
}

/** Collect the last `maxLines` non-empty output lines from completed tool activities. */
function getRecentOutput(activities: ToolActivity[], maxLines: number): string[] {
  const lines: string[] = [];
  for (let i = activities.length - 1; i >= 0 && lines.length < maxLines; i--) {
    const activity = activities[i]!;
    if (!activity.result || activity.result.isError) continue;
    const text = getToolResultText(activity);
    const textLines = text.split("\n").filter((l) => l.trim());
    for (let j = textLines.length - 1; j >= 0 && lines.length < maxLines; j--) {
      lines.unshift(textLines[j]!);
    }
  }
  return lines;
}

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
        activities: [],
        model: t.model?.id,
      }));
      const fire = () => onUpdate?.({
        content: [{ type: "text", text: `Running ${resolved.length} subagent${resolved.length > 1 ? "s" : ""}…` }],
        details: { tasks: params.tasks, results: [], progress: [...progress], parentModel: parentModelId },
      });
      fire();

      // ── Run parallel (with concurrency limiter) ───────────────────
      const results = await mapWithConcurrency(resolved, MAX_CONCURRENCY, async (t, i) => {
        const p = progress[i]!;
        // Skip the "running" flash if we're already aborted.
        if (signal?.aborted) {
          p.status = "failed"; p.error = "Aborted"; fire();
          throw new Error("Aborted");
        }
        p.status = "running"; p.model = t.model?.id; fire();
        try {
          const r = await runAgent(
            { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd },
            t.prompt,
            ctx.modelRegistry,
            signal,
            (u) => { p.tokens = u.tokens; p.toolUses = u.toolUses; p.durationMs = u.durationMs; p.lastActivityAt = u.lastActivityAt; p.activities = u.activities; fire(); },
          );
          p.status = r.error ? "failed" : "done";
          p.durationMs = r.durationMs;
          p.tokens = r.tokens;
          p.error = r.error;
          fire();
          return { agent: t.agentName, output: r.output, error: r.error, durationMs: r.durationMs, tokens: r.tokens };
        } catch (err) {
          // runAgent swallows most errors internally, but this guards against
          // aborts raised from this callback and any future thrown-error paths.
          p.status = "failed";
          p.error = err instanceof Error ? err.message : String(err);
          fire();
          throw err;
        }
      }, signal);

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
      const tasks = (args as { tasks?: TaskDef[] }).tasks ?? [];
      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const w = getTermWidth();
      if (!tasks.length) {
        text.setText(theme.fg("toolTitle", theme.bold("delegate")));
        return text;
      }
      // Show spinner when execution is running
      if (ctx.executionStarted) {
        if (state.startedAt === undefined) state.startedAt = Date.now();
        const elapsed = fmtDuration(Date.now() - state.startedAt);
        const lines = [theme.fg("toolTitle", theme.bold(`${spinnerFrame()} delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""} · ${elapsed}`))];
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i]!;
          const label = t.agent ? theme.bold(t.agent) : "inline";
          lines.push(truncLine(`${tree(i, tasks.length)} ${label} ${theme.fg("muted", trunc(t.prompt, Math.min(60, w - 30)))}`, w));
        }
        text.setText(lines.join("\n"));
        return text;
      }
      const lines = [theme.fg("toolTitle", theme.bold(`delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""}`))];
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]!;
        const label = t.agent ? theme.bold(t.agent) : "inline";
        lines.push(truncLine(`${tree(i, tasks.length)} ${label} ${theme.fg("muted", trunc(t.prompt, 60))}`, w));
      }
      text.setText(lines.join("\n"));
      return text;
    },

    renderResult(result, options, theme, ctx) {
      const state = ctx.state as { startedAt?: number; interval?: ReturnType<typeof setInterval> };
      // Use a faster animation cadence for spinner (80ms) vs the old 1s
      const tickMs = 80;
      if (options.isPartial && !state.interval) state.interval = setInterval(() => ctx.invalidate(), tickMs);
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
      const w = getTermWidth() - 4;
      const lines: string[] = [""];

      const statJoin = (parts: string[]) => parts.length ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "";
      const modelLabel = (p: TaskProgress) =>
        p.model && p.model !== details.parentModel ? ` ${theme.fg("accent", p.model)}` : "";

      // ── Helper: format the collapsed "current activity" line ─────
      const compactActivity = (p: TaskProgress): string => {
        const current = p.activities.findLast((a) => !a.result);
        if (current) {
          const call = formatToolCallShort(current.name, current.args);
          const toolAge = fmtDuration(Date.now() - current.startTime);
          return `${call} | ${toolAge}`;
        }
        return getActivityAge(p.lastActivityAt) || "thinking…";
      };

      if (options.isPartial) {
        const done = progress.filter((p) => p.status === "done" || p.status === "failed").length;
        const running = progress.filter((p) => p.status === "running").length;
        const elapsed = state.startedAt ? ` · ${fmtDuration(Date.now() - state.startedAt)}` : "";

        // Richer header: agent counts + wall time
        const headerParts: string[] = [];
        if (running > 0) headerParts.push(`${running} running`);
        headerParts.push(`${done}/${total} done`);
        lines.push(theme.fg("muted", `${headerParts.join(" · ")}${elapsed}`), "");

        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const ind = indent(i, total);
          const runParts: string[] = [];
          if (p.toolUses > 0) runParts.push(`${p.toolUses} tool${p.toolUses > 1 ? "s" : ""}`);
          if (p.tokens > 0) runParts.push(`${fmtTokens(p.tokens)} tokens`);

          switch (p.status) {
            case "done":
              lines.push(truncLine(`${tree(i, total)} ${theme.fg("success", "✓")} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`, w));
              if (options.expanded) {
                for (const activity of p.activities.slice(-3)) {
                  const call = formatToolCallShort(activity.name, activity.args);
                  const icon = activity.result?.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
                  lines.push(truncLine(`${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`, w));
                }
              }
              break;
            case "failed":
              lines.push(truncLine(`${tree(i, total)} ${theme.fg("error", "✗")} ${theme.bold(p.agent)}${modelLabel(p)}${p.error ? theme.fg("error", ` ${p.error}`) : ""}`, w));
              if (options.expanded) {
                for (const activity of p.activities.slice(-3)) {
                  const call = formatToolCallShort(activity.name, activity.args);
                  const icon = activity.result?.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
                  lines.push(truncLine(`${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`, w));
                }
              }
              break;
            case "running": {
              const activityAge = getActivityAge(p.lastActivityAt);
              const ageTag = activityAge ? ` · ${activityAge}` : "";
              const glyph = theme.fg("warning", spinnerFrame());
              lines.push(truncLine(`${tree(i, total)} ${glyph} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin(runParts)}${theme.fg("muted", ageTag)}`, w));

              // Current in-flight tool
              const current = p.activities.findLast((a) => !a.result);

              if (options.expanded) {
                // ── Expanded: detailed live view ────────────────────
                if (current) {
                  const call = formatToolCallShort(current.name, current.args);
                  const elapsedTool = fmtDuration(Date.now() - current.startTime);
                  lines.push(truncLine(`${ind}${theme.fg("warning", `> ${call} | ${elapsedTool}`)}`, w));
                }
                if (activityAge) lines.push(truncLine(`${ind}${activityAge}`, w));
                lines.push(truncLine(`${ind}${theme.fg("accent", "Press Ctrl+O for live detail")}`, w));
                // Recent completed tools
                for (const activity of p.activities.filter((a) => a.result).slice(-3)) {
                  const call = formatToolCallShort(activity.name, activity.args);
                  const icon = activity.result!.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
                  lines.push(truncLine(`${ind}  ${theme.fg("muted", call)} ${icon}`, w));
                }
                // Recent output from completed tools
                const recentOutput = getRecentOutput(p.activities, 5);
                for (const line of recentOutput) {
                  lines.push(truncLine(`${ind}  ${theme.fg("muted", line)}`, w));
                }
              } else {
                // ── Collapsed: compact tool line with duration ─────
                lines.push(truncLine(`${ind}${theme.fg("muted", `⎿  ${compactActivity(p)}`)}`, w));
                lines.push(truncLine(`${ind}${theme.fg("accent", "Press Ctrl+O for live detail")}`, w));
              }
            }
              break;
            default:
              // Pending / waiting
              lines.push(truncLine(`${tree(i, total)} ${theme.fg("muted", "○")} ${theme.bold(p.agent)}${modelLabel(p)} ${theme.fg("muted", "waiting…")}`, w));
          }
        }
        const budgeted = applyLineBudget(lines.filter(Boolean), options.expanded ?? false);
        lines.length = 0;
        lines.push(...budgeted);
      } else {
        // ── Final result ─────────────────────────────────────────────
        const succeeded = progress.filter((p) => p.status === "done").length;
        const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);
        const elapsed = state.startedAt ? fmtDuration(Date.now() - state.startedAt) : fmtDuration(progress.reduce((sum, p) => sum + p.durationMs, 0));
        lines.push(theme.fg("muted", `${succeeded}/${total} completed · ${elapsed} wall · ${fmtTokens(totalTokens)} tokens`), "");

        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const r = taskResults[i];
          const ind = indent(i, total);
          const icon = p.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const taskPreview = theme.fg("muted", trunc(p.task, w - 30));
          lines.push(truncLine(`${tree(i, total)} ${icon} ${theme.bold(p.agent)} ${taskPreview}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}${modelLabel(p)}`, w));

          // Tool activities with expand/collapse parity to native tool calls
          if (p.activities.length > 0) {
            for (const activity of p.activities) {
              const call = formatToolCallShort(activity.name, activity.args);
              if (!activity.result) {
                lines.push(truncLine(`${ind}${theme.fg("muted", `→ ${call}`)}`, w));
                continue;
              }
              const text = getToolResultText(activity);
              const iconA = activity.result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
              if (options.expanded) {
                lines.push(truncLine(`${ind}${theme.fg("muted", "→ ")}${theme.fg("toolTitle", call)} ${iconA}`, w));
                if (text) {
                  for (const line of text.split("\n")) {
                    lines.push(truncLine(`${ind}  ${theme.fg("toolOutput", line)}`, w));
                  }
                }
              } else {
                const textLines = text.split("\n");
                const preview = textLines[0]?.slice(0, Math.min(80, w - 10)) ?? "";
                const remaining = textLines.length - 1;
                lines.push(truncLine(`${ind}${theme.fg("muted", "→ ")}${theme.fg("toolTitle", call)} ${iconA}${preview ? `  ${theme.fg("toolOutput", preview)}` : ""}`, w));
                if (remaining > 0) {
                  lines.push(truncLine(`${ind}  ${theme.fg("muted", `… ${remaining} more lines`)}`, w));
                }
              }
            }
            lines.push("");
          }

          if (r && "output" in r && r.output?.trim() && r.output !== "(no output)") {
            const outputLines = r.output.trim().split("\n");
            const maxLines = options.expanded ? outputLines.length : 3;
            for (const line of outputLines.slice(0, maxLines)) lines.push(truncLine(`${ind}${theme.fg("toolOutput", line)}`, w));
            const remaining = outputLines.length - maxLines;
            if (remaining > 0) lines.push(truncLine(`${ind}${theme.fg("muted", `… ${remaining} more lines`)}`, w));
          } else if (r && "error" in r && r.error) {
            lines.push(truncLine(`${ind}${theme.fg("error", r.error)}`, w));
          }
        }
      }

      text.setText(lines.join("\n"));
      return text;
    },
  });
}

/**
 * delegate — In-process subagent delegation for pi.
 *
 * Borrows apple-pi's architecture (pi-agent-core Agent class, Promise.all
 * parallelism) with per-task overrides for model, skills, tools, thinking
 * level, system prompt, and working directory.
 *
 * Agent definitions live in .pi/agents/*.md (project-local).
 * Each task can reference a named agent and/or supply inline overrides.
 */

import { execFile } from "node:child_process";
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
  createReadTool,
  createWriteTool,
  SessionManager,
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

export type SessionAction = "prompt" | "close" | "list";

export interface TaskDef {
  prompt: string;
  agent?: string;
  model?: string;
  skills?: string[];
  tools?: string[];
  thinking?: string;
  systemPrompt?: string;
  cwd?: string;
  context?: "fresh" | "inherit" | "fork";
  /** Name for a persistent subagent session. First use creates it, subsequent uses reuse it. */
  sessionId?: string;
  /** Action for session management. Default: "prompt". "close" tears down a pooled agent. "list" shows active sessions. */
  action?: SessionAction;
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
  sessionFile?: string;
  touchedFiles: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────

export const DEFAULT_TOOLS = ["read", "write", "edit", "bash"];

/** Maximum concurrent subagent tasks. Prevents rate-limit thundering herds. */
export const MAX_CONCURRENCY = 3;

/** Idle timeout for pooled agents. 10 minutes. */
const POOL_TTL_MS = 10 * 60 * 1000;

// ── Agent Pool ────────────────────────────────────────────────────────────

interface PooledAgent {
  agent: Agent;
  sessionManager: SessionManagerLike;
  sessionFile: string;
  /** Config frozen at creation time — used for validation on reuse. */
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  };
  lastUsed: number;
  createdAt: number;
  /** Total tokens consumed across all prompts on this agent. */
  totalTokens: number;
  /** Number of prompts sent to this agent. */
  promptCount: number;
}

/** Module-level pool — lives for the entire pi session. */
export const agentPool = new Map<string, PooledAgent>();

/** Per-session lock — serializes access to a pooled agent so concurrent
 *  delegate calls with the same sessionId queue instead of interleaving. */
const sessionLocks = new Map<string, Promise<void>>();

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const existing = sessionLocks.get(sessionId);
  if (existing) await existing;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  sessionLocks.set(sessionId, promise);
  try {
    return await fn();
  } finally {
    sessionLocks.delete(sessionId);
    resolve();
  }
}

/** Close and remove a pooled agent. */
export function closePooledAgent(sessionId: string): boolean {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return false;
  try { pooled.agent.abort(); } catch { /* best effort */ }
  agentPool.delete(sessionId);
  return true;
}

/** Evict idle agents that exceeded the TTL. */
export function sweepPool(): void {
  const now = Date.now();
  for (const [id, pooled] of agentPool) {
    if (now - pooled.lastUsed > POOL_TTL_MS) {
      closePooledAgent(id);
    }
  }
}

/** List active pooled agents for help/status display. */
export function listPooledAgents(): string[] {
  sweepPool();
  const lines: string[] = [];
  if (agentPool.size === 0) return ["_(no active sessions)_"];
  for (const [id, pooled] of agentPool) {
    const idle = fmtDuration(Date.now() - pooled.lastUsed);
    const age = fmtDuration(Date.now() - pooled.createdAt);
    lines.push(`- **${id}** · ${pooled.promptCount} prompts · ${fmtTokens(pooled.totalTokens)} tokens · idle ${idle} · age ${age} · ${shortenPath(pooled.sessionFile)}`);
  }
  return lines;
}

/**
 * Rehydrate an agent from a session file on disk.
 * Loads the conversation history via SessionManager, creates a new Agent
 * pre-seeded with those messages.
 */
export function rehydrateAgent(
  sessionFile: string,
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  },
  modelRegistry: ModelRegistry,
): { agent: Agent; sessionManager: SessionManagerLike } | null {
  try {
    const sm = (SessionManager as unknown as { open(p: string): SessionManager }).open(sessionFile);
    const ctx = sm.buildSessionContext();
    if (!ctx.messages.length) return null;

    const tools = config.tools
      .map((name) => TOOL_FACTORIES[name]?.(config.cwd))
      .filter(Boolean) as AgentTool[];

    const agent = new Agent({
      initialState: {
        systemPrompt: config.systemPrompt,
        model: config.model,
        thinkingLevel: config.thinking,
        tools,
        messages: ctx.messages,
      },
      convertToLlm,
      streamFn: async (m, context, options) => {
        const auth = await modelRegistry.getApiKeyAndHeaders(m);
        if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
        return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
      },
    });

    return { agent, sessionManager: sm as unknown as SessionManagerLike };
  } catch {
    return null;
  }
}

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
    : Math.max(8, Math.min(18, Math.floor(rows * 0.35)));
  if (lines.length <= budget) return lines;
  const hidden = lines.length - budget + 1;
  return [...lines.slice(0, budget - 1), `… ${hidden} lines hidden · Ctrl+O expands`];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool registry needs generic param to avoid contravariance on execute()
export const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any>> = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
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
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot) dirs.push(path.join(projectRoot, ".pi", "agents"));

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

// ── File Tracking (git + activity) ────────────────────────────────────────

async function getGitChangedFiles(cwd: string): Promise<Set<string>> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    const files = new Set<string>();
    for (const line of result.split("\n")) {
      if (line.length < 4) continue;
      const rawPath = line.slice(3).trim();
      if (!rawPath) continue;
      const targetPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
      if (targetPath) files.add(path.resolve(cwd, targetPath.replace(/^"|"$/g, "")));
    }
    return files;
  } catch {
    return new Set();
  }
}

/** Extract file paths mutated by edit/write from the activity log. */
export function extractTouchedFromActivities(activities: ToolActivity[], cwd: string): string[] {
  const files = new Set<string>();
  for (const a of activities) {
    if (a.name !== "edit" && a.name !== "write") continue;
    const raw = a.args?.path ?? a.args?.file_path ?? a.args?.filePath;
    if (typeof raw !== "string" || !raw) continue;
    files.add(path.resolve(cwd, raw));
  }
  return [...files];
}

// ── Session Forking ───────────────────────────────────────────────────────

interface SessionManagerLike {
  appendMessage(message: unknown): string;
  getSessionFile(): string | undefined;
}

/**
 * Create a session manager for a subagent run.
 * - `fork`: branches from the parent session so the full conversation is preserved
 *   and searchable via session_search.
 * - `fresh` / `inherit`: creates a standalone session file so subagent work is still
 *   persisted and searchable.
 */
function createSubagentSessionManager(
  parentSessionManager: unknown,
  context: "fresh" | "inherit" | "fork" | undefined,
  cwd: string,
): { manager: SessionManagerLike; file: string } | undefined {
  if (context === "fork") {
    if (!parentSessionManager) {
      throw new Error("Forked subagent context requires a persisted parent session.");
    }
    const pm = parentSessionManager as { getSessionFile(): string | undefined; getLeafId(): string | null };
    const parentFile = pm.getSessionFile();
    const leafId = pm.getLeafId();
    if (!parentFile) {
      throw new Error("Forked subagent context requires a persisted parent session.");
    }
    if (!leafId) {
      throw new Error("Forked subagent context requires a current leaf to fork from.");
    }
    const sm = (SessionManager as unknown as { open(path: string): SessionManager }).open(parentFile);
    const sessionFile = sm.createBranchedSession(leafId);
    if (!sessionFile) {
      throw new Error("Session manager did not return a session file.");
    }
    return { manager: sm as unknown as SessionManagerLike, file: sessionFile };
  }

  // Always persist subagent work so the main agent can search it later.
  const sm = SessionManager.create(cwd);
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) return undefined;
  return { manager: sm as unknown as SessionManagerLike, file: sessionFile };
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

// ── AGENTS.md Loading ────────────────────────────────────────────────────

/** Load AGENTS.md context files for a given cwd, mirroring pi's discovery.
 *  Walks from cwd up to root, plus the global agent dir. Returns ordered
 *  list of file contents (global first, then ancestor → cwd). */
export function loadAgentsMdFiles(cwd: string): string[] {
  const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const seen = new Set<string>();
  const files: { priority: number; content: string }[] = [];

  const tryLoad = (dir: string, priority: number) => {
    for (const name of candidates) {
      const fp = path.join(dir, name);
      if (seen.has(fp)) return;
      seen.add(fp);
      try {
        const content = fs.readFileSync(fp, "utf-8").trim();
        if (content) {
          files.push({ priority, content });
          return; // found valid content, stop trying other candidates in this dir
        }
        // empty/whitespace-only file — treat as not found, fall through to next candidate
      } catch { /* skip */ }
    }
  };

  // Global agent dir (highest priority for ordering, loaded first)
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  tryLoad(agentDir, 0);

  // Walk from root → cwd, stopping before filesystem root (no one puts AGENTS.md in /)
  const ancestorDirs: string[] = [];
  let current = path.resolve(cwd);
  const root = path.resolve("/");
  while (true) {
    ancestorDirs.unshift(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (let i = 0; i < ancestorDirs.length; i++) {
    if (ancestorDirs[i] === root) continue;
    tryLoad(ancestorDirs[i]!, i + 1);
  }

  return files.sort((a, b) => a.priority - b.priority).map((f) => f.content);
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

/** Run a single prompt on an Agent instance. Shared by both fresh and pooled paths. */
async function runAgentOnce(
  agent: Agent,
  prompt: string,
  config: { systemPrompt: string; model: Model<Api>; thinking: ThinkingLevel; tools: string[]; cwd: string },
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
  onProgress?: (update: AgentProgressUpdate) => void,
  sessionManager?: SessionManagerLike,
  gitBaseline?: Set<string>,
  start?: number,
): Promise<{ output: string; error?: string; durationMs: number; tokens: number; touchedFiles: string[] }> {
  const startTime = start ?? Date.now();
  const baseline = gitBaseline ?? new Set<string>();
  let toolUses = 0;
  let lastActivityAt: number | undefined;
  const activities: ToolActivity[] = [];
  const pendingById = new Map<string, ToolActivity>();
  let usageBeforeTotal = 0;

  const fireProgress = () => {
    if (!onProgress) return;
    const usage = extractUsage(agent.state.messages);
    const delta = Math.max(0, usage.total - usageBeforeTotal);
    onProgress({ tokens: delta, toolUses, durationMs: Date.now() - startTime, lastActivityAt, activities: [...activities] });
  };

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const now = Date.now();
      lastActivityAt = now;
      const activity: ToolActivity = { id: event.toolCallId, name: event.toolName, args: event.args, startTime: now };
      pendingById.set(event.toolCallId, activity);
      activities.push(activity);
      fireProgress();
    } else if (event.type === "tool_execution_end") {
      lastActivityAt = Date.now();
      const activity = pendingById.get(event.toolCallId);
      if (activity) {
        activity.result = { content: event.result?.content ?? [], isError: event.isError };
        activity.endTime = lastActivityAt;
        pendingById.delete(event.toolCallId);
      }
      toolUses++;
      fireProgress();
    } else if (event.type === "message_end") {
      lastActivityAt = Date.now();
      fireProgress();
    }
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => { try { agent.abort(); } catch { /* */ } };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    // Snapshot state before prompt for delta-based persistence and token counting.
    const messagesBefore = agent.state.messages.length;
    const usageBefore = extractUsage(agent.state.messages);
    usageBeforeTotal = usageBefore.total;

    await agent.prompt(prompt);
    await agent.waitForIdle();

    const state = agent.state as { messages: AgentMessage[]; errorMessage?: string };
    const errorMessage = state.errorMessage;
    // Extract only the new output from this prompt (not cumulative history).
    const output = extractOutput(state.messages.slice(messagesBefore));
    const usageAfter = extractUsage(state.messages);
    const tokensThisCall = usageAfter.total - usageBeforeTotal;

    // Persist only the new messages added by this prompt (avoids duplication on pool reuse).
    if (sessionManager) {
      try {
        for (let mi = messagesBefore; mi < state.messages.length; mi++) {
          const msg = state.messages[mi]!;
          if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult" || msg.role === "custom") {
            sessionManager.appendMessage(msg);
          }
        }
      } catch { /* best effort */ }
    }

    // Compute touched files: union of activity-based (edit/write) and git diff.
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const gitAfter = await getGitChangedFiles(config.cwd);
    const fromGit = [...gitAfter].filter((f) => !baseline.has(f));
    const touchedFiles = [...new Set([...fromActivities, ...fromGit])];

    return { output: output || "(no output)", error: errorMessage, durationMs: Date.now() - startTime, tokens: tokensThisCall, touchedFiles };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: "", error: msg, durationMs: Date.now() - startTime, tokens: 0, touchedFiles: [] };
  } finally {
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    unsubscribe();
  }
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
  sessionManager?: SessionManagerLike,
  maxRetries = 3,
  retryBaseMs = 2000,
  /** Pre-existing agent for pooled sessions. When provided, skips creation and retry — runs once. */
  existingAgent?: Agent,
): Promise<{ output: string; error?: string; durationMs: number; tokens: number; touchedFiles: string[] }> {
  const start = Date.now();

  // Snapshot git status before the agent starts so we can diff after.
  const gitBaseline = await getGitChangedFiles(config.cwd);

  // For pooled agents: single attempt, no retry loop.
  if (existingAgent) {
    return runAgentOnce(existingAgent, prompt, config, modelRegistry, signal, onProgress, sessionManager, gitBaseline, start);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return { output: "", error: "Aborted", durationMs: Date.now() - start, tokens: 0, touchedFiles: [] };
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

    // Signal retry to the progress UI.
    if (attempt > 0 && onProgress) onProgress({ tokens: 0, toolUses: 0, durationMs: Date.now() - start, activities: [] });

    const result = await runAgentOnce(agent, prompt, config, modelRegistry, signal, onProgress, sessionManager, gitBaseline, start);
    if (result.error && attempt < maxRetries && RETRYABLE_PATTERN.test(result.error)) {
      const delay = retryBaseMs * Math.pow(2, attempt) + Math.random() * retryBaseMs;
      try { await sleepWithAbort(delay, signal); } catch (sleepErr) {
        if (!(sleepErr instanceof AbortError)) throw sleepErr;
      }
      continue;
    }
    return result;
  }

  // Unreachable — every code path inside the loop returns. Defense-in-depth.
  return {
    output: "",
    error: "Unknown error",
    durationMs: Date.now() - start,
    tokens: 0,
    touchedFiles: [],
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
      "Use delegate to parallelize independent work across subagents. Each task must include \"prompt\"; specify \"agent\" (name from .pi/agents/*.md) and/or \"systemPrompt\". All other fields (model, tools, skills, thinking, cwd, context) are optional and fall back to agent defaults or parent session values.",
      "Subagents only have pi core tools: read, write, edit, bash.",
      "Call delegate with an empty tasks array to see how to use the delegate tool.",
    ],
    description:
      "Spawn subagents in parallel. Call with an empty tasks array for full help.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          prompt: Type.Optional(Type.String({ description: "The task for this subagent to perform. Required unless action is 'close' or 'list'." })),
          agent: Type.Optional(Type.String({
            description: "Named agent from .pi/agents/*.md (project-local). Inline fields override agent defaults.",
          })),
          model: Type.Optional(Type.String({
            description: "Model (e.g. 'anthropic/claude-sonnet-4'). Falls back to agent default, then parent model.",
          })),
          skills: Type.Optional(Type.Array(Type.String(), {
            description: "Skill names to inject into the system prompt.",
          })),
          tools: Type.Optional(Type.Array(Type.String(), {
            description: "Tools the subagent may use: read, write, edit, bash.",
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
            enum: ["fresh", "inherit", "fork"],
            description: "'fresh' for clean context, 'inherit' to include parent session transcript, 'fork' to branch the session so subagent work is searchable.",
          })),
          sessionId: Type.Optional(Type.String({
            description: "Name for a persistent subagent session. First use creates it, subsequent uses reuse the same agent. Use action='close' to tear down.",
          })),
          action: Type.Optional(Type.String({
            enum: ["prompt", "close", "list"],
            description: "'prompt' (default) runs a task, 'close' tears down a pooled session, 'list' shows active sessions.",
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
            "Agents live in `.pi/agents/*.md` (project-local). Each agent file is Markdown with YAML-ish frontmatter:",
            "",
            "```markdown",
            "---",
            "name: my-agent",
            "description: What it does",
            "model: anthropic/claude-haiku-4-5  # optional",
            "thinking: low                     # off/minimal/low/medium/high/xhigh",
            "tools: read, bash                 # default: all 4 core tools",
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
            "- `tools` — Array of tool names. Default: read, write, edit, bash.",
            "- `skills` — Skill names injected into the system prompt.",
            "- `thinking` — off, minimal, low, medium, high, xhigh. Default: agent setting or 'off'.",
            "- `cwd` — Working directory. Default: parent session cwd.",
            "- `context` — 'fresh' (default), 'inherit' to include parent session transcript, or 'fork' to branch the session so subagent work is persisted and searchable.",
            "- `sessionId` — Name for a persistent subagent. First use creates it, subsequent calls reuse the same agent (multi-turn).",
            "- `action` — 'prompt' (default), 'close' to tear down a pooled session, 'list' to show active sessions.",
            "",
            "## Session Reuse",
            "",
            "When `sessionId` is set, the subagent is kept alive in a pool for the duration of the pi session.",
            "Subsequent calls with the same `sessionId` continue the conversation — the agent remembers prior context.",
            "",
            "```json",
            "// First call — creates and runs",
            "{ \"prompt\": \"Investigate the auth module\", \"agent\": \"scout\", \"sessionId\": \"auth-research\" }",
            "",
            "// Second call — continues the same agent",
            "{ \"prompt\": \"Now check the tests for that module\", \"sessionId\": \"auth-research\" }",
            "",
            "// Clean up when done",
            "{ \"prompt\": \"\", \"sessionId\": \"auth-research\", \"action\": \"close\" }",
            "```",
            "",
            "Pooled agents are automatically closed after 10 minutes of inactivity.",
          ].join("\n") }],
          details: { tasks: [], results: [], progress: [], parentModel: parentModelId },
        };
      }

      // ── Validate ──────────────────────────────────────────────────
      // Disallow same sessionId across multiple parallel tasks (one agent can't serve two prompts concurrently).
      const sessionIds = params.tasks.map((t) => t.sessionId).filter(Boolean);
      const duplicateSessions = sessionIds.filter((id, i) => sessionIds.indexOf(id) !== i);
      if (duplicateSessions.length) {
        return {
          content: [{ type: "text", text: `Duplicate sessionId(s) across tasks: ${[...new Set(duplicateSessions)].join(", ")}. A pooled agent can only handle one prompt at a time.` }],
          details: { tasks: params.tasks, results: [], progress: [], parentModel: parentModelId },
        };
      }

      const unknown: string[] = [];
      for (const t of params.tasks) {
        if (t.agent && !agents.has(t.agent)) unknown.push(t.agent);
      }
      if (unknown.length) {
        const names = [...agents.keys()];
        return {
          content: [{ type: "text", text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}. Call delegate with an empty tasks array for help.` }],
          details: { tasks: params.tasks, results: [], progress: [], parentModel: parentModelId },
        };
      }

      // ── Resolve tasks ─────────────────────────────────────────────
      // Build parent transcript lazily — only computed once if any task uses inherit/fork
      let parentTranscript: string | null = null;
      const needsParentContext = params.tasks.some((t) => t.context === "inherit" || t.context === "fork");
      if (needsParentContext) {
        if (!ctx.sessionManager) {
          throw new Error("context: 'inherit' or 'fork' requires a persisted parent session.");
        }
        parentTranscript = buildParentTranscript(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      }

      const resolved = params.tasks.map((t, i) => {
        const agent = t.agent ? agents.get(t.agent) : undefined;
        const cwd = t.cwd ?? ctx.cwd;

        // Build system prompt (pooled agents already have one baked in)
        const pooledConfig = t.sessionId ? agentPool.get(t.sessionId)?.config : undefined;
        let systemPrompt = t.systemPrompt ?? agent?.systemPrompt ?? pooledConfig?.systemPrompt ?? "";
        if (!systemPrompt.trim()) {
          throw new Error(`Task ${i}: no system prompt — specify agent, systemPrompt, or both.`);
        }

        // Prompt is required for actual task execution.
        if (t.action !== "close" && t.action !== "list" && !t.prompt?.trim()) {
          throw new Error(`Task ${i}: prompt is required unless action is 'close' or 'list'.`);
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

        // Inject AGENTS.md context files (global + cwd ancestors)
        const agentsMdFiles = loadAgentsMdFiles(cwd);
        if (agentsMdFiles.length) {
          systemPrompt = systemPrompt.trimEnd() + "\n\n" + agentsMdFiles.join("\n\n");
        }

        // Build prompt — wrap with parent context if inheriting or forking
        let prompt = t.prompt;
        const parentCtx = (t.context === "inherit" || t.context === "fork") && parentTranscript ? parentTranscript : null;
        if (parentCtx) {
          prompt = [
            "<parent-session>",
            "The following is the conversation from the parent session.",
            "Read this for context, then execute the task below.",
            "Do not continue the parent conversation or respond to prior messages.",
            "",
            parentCtx,
            "</parent-session>",
            "",
            "## Task",
            prompt,
          ].join("\n");
        }

        // Resolve model (falls back to parent model if specification fails to resolve)
        let model: Model<Api> | undefined;
        let tools: string[] = [];
        let thinking: ThinkingLevel = "off";
        const warnings: string[] = [];

        if (t.action !== "close" && t.action !== "list") {
          const modelSpec = t.model ?? agent?.model ?? pooledConfig?.model?.id;
          const resolvedModel = resolveModel(modelSpec, ctx.modelRegistry, ctx.model) ?? ctx.model;
          if (!resolvedModel) {
            throw new Error(`Task ${i}: no model available — parent session has no model set.`);
          }
          model = resolvedModel;

          // Resolve tools — warn about unknown tool names
          tools = t.tools ?? agent?.tools ?? DEFAULT_TOOLS;
          const unknownTools = tools.filter((name) => !(name in TOOL_FACTORIES));
          if (unknownTools.length) {
            warnings.push(`Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`);
          }

          // Resolve thinking
          const thinkingRaw = t.thinking ?? agent?.thinking ?? "off";
          thinking = VALID_THINKING.has(thinkingRaw) ? (thinkingRaw as ThinkingLevel) : "off";
        }
        return { ...t, cwd, systemPrompt, model, tools, thinking, prompt, agentName: agent?.name ?? "inline", warnings };
      });

      // ── Progress tracking ─────────────────────────────────────────
      const startedAt = Date.now();
      const progress: TaskProgress[] = resolved.map((t, i) => ({
        index: i,
        agent: t.agentName,
        task: trunc(t.prompt || t.action || "", 50),
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
      // Sweep stale pooled agents before dispatching.
      sweepPool();

      const results = await mapWithConcurrency(resolved, MAX_CONCURRENCY, async (t, i) => {
        const p = progress[i]!;
        // Skip the "running" flash if we're already aborted.
        if (signal?.aborted) {
          p.status = "failed"; p.error = "Aborted"; fire();
          throw new Error("Aborted");
        }
        p.status = "running"; p.model = t.model?.id; fire();

        // ── Session action handling ────────────────────────────────
        if (t.action === "close") {
          if (!t.sessionId) {
            p.status = "failed"; p.error = "action='close' requires sessionId."; fire();
            return { agent: t.agentName, output: "", error: "action='close' requires sessionId.", durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
          }
          const closed = closePooledAgent(t.sessionId);
          p.status = "done"; p.durationMs = Date.now() - startedAt; fire();
          return { agent: t.agentName, output: closed ? `Session '${t.sessionId}' closed.` : `Session '${t.sessionId}' not found.`, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
        }

        if (t.action === "list") {
          const listing = listPooledAgents();
          p.status = "done"; p.durationMs = Date.now() - startedAt; fire();
          return { agent: t.agentName, output: `Active sessions:\n${listing.join("\n")}`, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
        }

        // ── Pooled agent resolution ────────────────────────────────
        let existingAgent: Agent | undefined;
        let poolSessionManager: SessionManagerLike | undefined;
        let poolSessionFile: string | undefined;
        let pendingPoolInsert = false; // Set true when we create a new agent that should be pooled on success.

        if (t.sessionId) {
          const pooled = agentPool.get(t.sessionId);
          if (pooled) {
            // Pool hit — validate config compatibility.
            const frozen = pooled.config;
            const mismatches: string[] = [];
            if (frozen.cwd !== t.cwd) mismatches.push(`cwd: '${frozen.cwd}' vs '${t.cwd}'`);
            if (frozen.thinking !== t.thinking) mismatches.push(`thinking: '${frozen.thinking}' vs '${t.thinking}'`);
            const frozenToolSet = [...frozen.tools].sort().join(",");
            const newToolSet = [...t.tools].sort().join(",");
            if (frozenToolSet !== newToolSet) mismatches.push(`tools: [${frozenToolSet}] vs [${newToolSet}]`);
            if (mismatches.length) {
              p.status = "failed"; p.error = `Session '${t.sessionId}' config mismatch. Close and recreate: ${mismatches.join("; ")}`; fire();
              return { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
            }
            existingAgent = pooled.agent;
            poolSessionManager = pooled.sessionManager;
            poolSessionFile = pooled.sessionFile;
            pooled.lastUsed = Date.now();
          } else {
            // Pool miss — try to rehydrate from disk, or create fresh.
            const session = createSubagentSessionManager(ctx.sessionManager, t.context, t.cwd);
            poolSessionManager = session?.manager;
            poolSessionFile = session?.file;

            const tools = t.tools.map((name) => TOOL_FACTORIES[name]?.(t.cwd)).filter(Boolean) as AgentTool[];
            const agentConfig = { systemPrompt: t.systemPrompt, model: t.model, thinkingLevel: t.thinking, tools };

            let agent: Agent | undefined;
            if (poolSessionFile) {
              const rehydrated = rehydrateAgent(
                poolSessionFile,
                { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd },
                ctx.modelRegistry,
              );
              if (rehydrated) {
                agent = rehydrated.agent;
                poolSessionManager = rehydrated.sessionManager;
              }
            }
            if (!agent) {
              const streamFn = async (m: any, context: any, options: any) => {
                const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
                if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
                return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
              };
              agent = new Agent({ initialState: agentConfig, convertToLlm, streamFn });
            }
            pendingPoolInsert = true;
            existingAgent = agent;
          }
        }

        // Create a session manager for non-pooled tasks.
        const session = t.sessionId
          ? { manager: poolSessionManager, file: poolSessionFile }
          : createSubagentSessionManager(ctx.sessionManager, t.context, t.cwd);

        const isPoolHit = t.sessionId && !pendingPoolInsert;

        const doRun = async (): Promise<TaskResult> => {
          try {
            const config = { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd };
            const r = await runAgent(
              config,
              t.prompt,
              ctx.modelRegistry,
              signal,
              (u) => { p.tokens = u.tokens; p.toolUses = u.toolUses; p.durationMs = u.durationMs; p.lastActivityAt = u.lastActivityAt; p.activities = u.activities; fire(); },
              session?.manager,
              undefined, // maxRetries (default)
              2000,      // retryBaseMs
              existingAgent, // pre-existing agent for pooled sessions
            );

            // Insert into pool only after successful first run.
            if (t.sessionId && pendingPoolInsert && !r.error && session?.manager && session?.file) {
              agentPool.set(t.sessionId, {
                agent: existingAgent!,
                sessionManager: session.manager,
                sessionFile: session.file,
                config: { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd },
                lastUsed: Date.now(),
                createdAt: Date.now(),
                totalTokens: r.tokens,
                promptCount: 1,
              });
            }

            // Update pool stats on subsequent successful runs.
            if (t.sessionId && !pendingPoolInsert) {
              const pooled = agentPool.get(t.sessionId);
              if (pooled) {
                pooled.lastUsed = Date.now();
                pooled.totalTokens += r.tokens;
                pooled.promptCount++;
              }
            }

            p.status = r.error ? "failed" : "done";
            p.durationMs = r.durationMs;
            p.tokens = r.tokens;
            p.error = r.error;
            fire();
            return { agent: t.agentName, output: r.output, error: r.error, durationMs: r.durationMs, tokens: r.tokens, sessionFile: session?.file ?? poolSessionFile, touchedFiles: r.touchedFiles };
          } catch (err) {
            p.status = "failed";
            p.error = err instanceof Error ? err.message : String(err);
            fire();
            throw err;
          }
        };

        if (isPoolHit && t.sessionId) {
          return withSessionLock(t.sessionId, doRun);
        }
        return doRun();
      }, signal);

      // ── Format for LLM ────────────────────────────────────────────
      const finalResults = results.map((r, i) =>
        r.status === "fulfilled" ? r.value : { agent: resolved[i]!.agentName, output: "", error: String(r.reason), durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] },
      );
      const elapsedTotal = Date.now() - startedAt;

      const parts: string[] = [];
      const succeeded = finalResults.filter((r) => !r.error).length;
      parts.push(`${succeeded}/${finalResults.length} tasks completed successfully · ${fmtDuration(elapsedTotal)} wall time\n`);
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i]!;
        const t = resolved[i]!;
        parts.push(`=== ${r.agent}: ${trunc(t.prompt || t.action || "", 80)} ===`);
        if (t.warnings?.length) {
          for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
        }
        if (r.error) {
          parts.push(`[FAILED: ${r.error}]`);
        } else {
          const meta = [`OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens`];
          if (r.sessionFile) meta.push(shortenPath(r.sessionFile));
          if (r.touchedFiles.length > 0) {
            const rel = r.touchedFiles.map((f) => path.relative(t.cwd, f)).filter((f) => f && !f.startsWith(".."));
            if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
          }
          parts.push(`[${meta.join(" · ")}]\n\n${r.output}`);
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
      if (!tasks.length) {
        text.setText(theme.fg("toolTitle", theme.bold("delegate")));
        return text;
      }
      // Minimal call rendering — renderResult handles all detail.
      // ToolExecutionComponent stacks call + result, so duplication
      // happens if both show task trees.
      // Only show spinner while still running (ctx.isPartial).
      if (ctx.executionStarted && ctx.isPartial) {
        if (state.startedAt === undefined) state.startedAt = Date.now();
        const elapsed = fmtDuration(Date.now() - state.startedAt);
        text.setText(theme.fg("toolTitle", theme.bold(`${spinnerFrame()} delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""} · ${elapsed}`)));
        return text;
      }
      text.setText(theme.fg("toolTitle", theme.bold(`delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""}`)));
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

          // Tool activities: expanded shows full details; collapsed shows a compact summary
          if (p.activities.length > 0) {
            if (options.expanded) {
              for (const activity of p.activities) {
                const call = formatToolCallShort(activity.name, activity.args);
                if (!activity.result) {
                  lines.push(truncLine(`${ind}${theme.fg("muted", `→ ${call}`)}`, w));
                  continue;
                }
                const text = getToolResultText(activity);
                const iconA = activity.result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
                lines.push(truncLine(`${ind}${theme.fg("muted", "→ ")}${theme.fg("toolTitle", call)} ${iconA}`, w));
                if (text) {
                  for (const line of text.split("\n")) {
                    lines.push(truncLine(`${ind}  ${theme.fg("toolOutput", line)}`, w));
                  }
                }
              }
            } else {
              // Collapsed: compact single-line tool summary (token stats already in header)
              const names = p.activities.map((a) => a.name).filter((n, i, arr) => arr.indexOf(n) === i);
              const nameList = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");
              lines.push(truncLine(`${ind}${theme.fg("muted", `${p.activities.length} tool${p.activities.length > 1 ? "s" : ""}: ${nameList}`)}`, w));
            }
            if (!options.expanded) lines.push("");
          }

          if (r && "output" in r && r.output?.trim() && r.output !== "(no output)") {
            const outputLines = r.output.trim().split("\n");
            const maxLines = options.expanded ? outputLines.length : 12;
            for (const line of outputLines.slice(0, maxLines)) lines.push(truncLine(`${ind}${theme.fg("toolOutput", line)}`, w));
            const remaining = outputLines.length - maxLines;
            if (remaining > 0) lines.push(truncLine(`${ind}${theme.fg("muted", `… ${remaining} more lines`)}`, w));
          } else if (r && "error" in r && r.error) {
            lines.push(truncLine(`${ind}${theme.fg("error", r.error)}`, w));
          }
        }

        // Prevent terminal overflow — only strip blank lines if budget is exceeded
        const nonEmpty = lines.filter(Boolean);
        const budgeted = applyLineBudget(nonEmpty, options.expanded ?? false);
        lines.length = 0;
        lines.push(...(budgeted.length < nonEmpty.length ? budgeted : nonEmpty));
      }

      text.setText(lines.join("\n"));
      return text;
    },
  });
}

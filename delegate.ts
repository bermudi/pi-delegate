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
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Api, type Model, streamSimple } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  getMarkdownTheme,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Text, Markdown } from "@mariozechner/pi-tui";
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

export type SessionAction = "prompt" | "close" | "list" | "poll" | "cancel";
export type DelegateAction = "poll" | "cancel";

export interface DelegateParams {
  action?: DelegateAction;
  async?: boolean;
  ticket?: string;
  tasks?: TaskDef[];
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
  context?: "fresh" | "with-parent-transcript";
  /** Name for a persistent subagent session. First use creates it, subsequent uses reuse it. */
  sessionId?: string;
  /** Action for session management. Default: "prompt". "close" tears down a pooled agent. "list" shows active sessions. "poll" checks async tickets. "cancel" aborts async ticket. */
  action?: SessionAction;
  /** Absolute path to a previous subagent session .jsonl to continue from. The agent resumes with full conversation context. */
  resumeFrom?: string;
}

// ── Async Ticket Types ─────────────────────────────────────────────────────

export interface AsyncTicket {
  id: string;
  created: number;
  completedAt?: number;
  tasks: TaskDef[];
  resolved: ResolvedTask[];
  status: "running" | "done" | "failed" | "cancelled";
  results: (TaskResult | undefined)[];
  progress: TaskProgress[];
  controller: AbortController;
  error?: string;
  parentModelId?: string;
}

export interface ResolvedTask {
  prompt: string;
  agent?: string;
  model: Model<Api>;
  skills?: string[];
  tools: string[];
  thinking: ThinkingLevel;
  systemPrompt: string;
  cwd: string;
  context?: "fresh" | "with-parent-transcript";
  sessionId?: string;
  action?: SessionAction;
  resumeFrom?: string;
  agentName: string;
  warnings: string[];
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
  ticketId?: string;
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

/** Maximum concurrent background async tickets. */
const MAX_ASYNC_TICKETS = 5;

/** Completed tickets cleaned up after 30 minutes. */
const ASYNC_TICKET_TTL_MS = 30 * 60 * 1000;

/** Hard timeout per async ticket. 30 minutes. */
const ASYNC_MAX_RUNTIME_MS = 30 * 60 * 1000;

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
  const prev = sessionLocks.get(sessionId);
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  // Install ourselves BEFORE awaiting — so the next waiter queues behind us,
  // not behind the same predecessor we're waiting on.
  sessionLocks.set(sessionId, promise);
  try {
    if (prev) await prev;
    return await fn();
  } finally {
    resolve();
    // Only clean up if no one queued behind us (our promise is still current).
    // If a waiter installed their own promise, leave it — deleting would
    // clobber their map entry and break the chain.
    if (sessionLocks.get(sessionId) === promise) {
      sessionLocks.delete(sessionId);
    }
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

// ── Async Ticket Registry ────────────────────────────────────────────────

/** Module-level registry for async tickets — lives for the entire pi session. */
export const ticketRegistry = new Map<string, AsyncTicket>();

function generateTicketId(): string {
  // 8-char alphanumeric, no lookalikes
  return Math.random().toString(36).slice(2, 10);
}

/** Abort and remove tickets that exceeded runtime or TTL. */
export function sweepTickets(): void {
  const now = Date.now();
  for (const [id, ticket] of ticketRegistry) {
    // Hard runtime timeout
    if (ticket.status === "running" && now - ticket.created > ASYNC_MAX_RUNTIME_MS) {
      ticket.controller.abort();
      ticket.status = "failed";
      ticket.error = "Exceeded maximum runtime";
      ticket.completedAt = now;
    }
    // TTL cleanup for completed/failed/cancelled
    if (ticket.status !== "running" && ticket.completedAt && now - ticket.completedAt > ASYNC_TICKET_TTL_MS) {
      ticketRegistry.delete(id);
    }
  }
}

/** Check if any running async ticket holds a given sessionId. */
export function isSessionBusy(sessionId: string): string | null {
  for (const ticket of ticketRegistry.values()) {
    if (ticket.status !== "running") continue;
    if (ticket.resolved.some(t => t.sessionId === sessionId)) {
      return ticket.id;
    }
  }
  return null;
}

/** Format a completed ticket for LLM consumption. Reuses sync result formatting. */
function formatCompletedTicket(ticket: AsyncTicket): AgentToolResult<DelegateDetails> {
  const parts: string[] = [];
  const succeeded = ticket.results.filter(r => r && !("error" in r && r.error)).length;
  const elapsedTotal = ticket.completedAt ? ticket.completedAt - ticket.created : 0;
  parts.push(`${succeeded}/${ticket.results.length} tasks completed · ${fmtDuration(elapsedTotal)} wall time\n`);

  for (let i = 0; i < ticket.results.length; i++) {
    const r = ticket.results[i];
    const t = ticket.resolved[i]!;
    if (!r) {
      parts.push(`=== ${t.agentName}: ${trunc(t.prompt || "", 80)} ===`);
      parts.push(`[PENDING — result not available]`);
      continue;
    }
    parts.push(`=== ${r.agent}: ${trunc(t.prompt || "", 80)} ===`);
    if (t.warnings?.length) {
      for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
    }
    if ("error" in r && r.error) {
      const failParts = [r.error];
      if (r.sessionFile) failParts.push(`session: ${shortenPath(r.sessionFile)}`);
      parts.push(`[FAILED: ${failParts.join(" · ")}]`);
      if (r.sessionFile && fs.existsSync(r.sessionFile)) {
        const safePath = JSON.stringify(r.sessionFile);
        parts.push(`→ To retry: delegate({ tasks: [{ resumeFrom: ${safePath}, prompt: "continue" }] })`);
      }
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
    details: { tasks: ticket.tasks, results: ticket.results.filter((r): r is TaskResult => r !== undefined), progress: [...ticket.progress], parentModel: ticket.parentModelId },
  };
}

/** Push results into parent session via sendMessage when background ticket completes. */
export function deliverTicketResults(pi: ExtensionAPI, ticket: AsyncTicket): void {
  if (!ticket.completedAt) return;

  const formatted = formatCompletedTicket(ticket);
  const text = formatted.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  pi.sendMessage({
    customType: "async_delegate_result",
    content: text,
    display: true,
    details: { ...formatted.details, ticketId: ticket.id, status: ticket.status },
  }, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
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

// Re-used segmenter for grapheme-aware truncation
const _segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const _wideCharRe = /[\u{1100}-\u{10FFFF}]/u;
// Combining marks (NFD decomposition) — force slow path since length != display width
const _combiningRe = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/u;

/** Return the display width of a single grapheme cluster. */
function charWidth(seg: string): number {
  const cp = seg.codePointAt(0)!;
  if (cp < 0x20) return 0; // control chars
  if (cp === 0x7f) return 0; // DEL
  if (cp >= 0x1100 && cp <= 0x115f) return 2; // Hangul Jamo
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2; // CJK, Yi, etc.
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // Hangul Syllables
  if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK Compatibility Ideographs
  if (cp >= 0xfe10 && cp <= 0xfe19) return 2; // Vertical forms
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2; // CJK Compatibility Forms
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // Fullwidth ASCII variants
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2; // Fullwidth symbol variants
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2; // CJK Extensions B-I
  if (cp >= 0x1f000 && cp <= 0x1fffd) return 2; // Symbols, emoticons, transport, etc.
  if (cp >= 0xe0000 && cp <= 0xe007f) return 0; // Tags (invisible formatting)
  // Note: ZWJ sequences (👨‍👩‍👧‍👦) and skin-tone modifiers (👍🏻) are handled
  // by Intl.Segmenter as single graphemes. The base emoji code point
  // determines width (typically 2), which is correct for display.
  return 1;
}

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 * Uses Intl.Segmenter for proper Unicode/emoji handling.
 */
export function truncLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  // Fast path: plain ASCII (no ANSI, no wide chars, no combining marks)
  if (!/\x1b\[[0-9;]*m/.test(text) && !_wideCharRe.test(text) && !_combiningRe.test(text)) {
    if (text.length <= maxWidth) return text;
    return text.slice(0, maxWidth - 1) + "…";
  }

  // Split on ANSI sequences so they remain atomic
  const parts = text.split(/(\x1b\[[0-9;]*m)/);

  // Pre-check: does the text fit without truncation?
  let totalVis = 0;
  for (const part of parts) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) continue;
    for (const segment of _segmenter.segment(part)) {
      totalVis += charWidth(segment.segment);
      if (totalVis > maxWidth) break;
    }
    if (totalVis > maxWidth) break;
  }
  if (totalVis <= maxWidth) return text;

  const target = maxWidth - 1; // reserve space for "…"
  let result = "";
  let vis = 0;
  let activeStyles: string[] = [];

  for (const part of parts) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) {
      result += part;
      if (part === "\x1b[0m" || part === "\x1b[m") activeStyles = [];
      else activeStyles.push(part);
      continue;
    }

    // Fast path: ASCII-only part that fits entirely (no combining marks)
    if (!_wideCharRe.test(part) && !_combiningRe.test(part) && vis + part.length <= target) {
      result += part;
      vis += part.length;
      continue;
    }

    for (const segment of _segmenter.segment(part)) {
      const seg = segment.segment;
      const w = charWidth(seg);
      if (vis + w > target) return result + activeStyles.join("") + "…";
      result += seg;
      vis += w;
    }
  }

  return result;
}

/**
 * Apply a line budget so the TUI doesn't overflow the terminal.
 * Returns lines trimmed to fit within `budget` visible rows.
 */
function applyLineBudget(lines: string[], expanded: boolean): string[] {
  if (expanded) return [...lines]; // expanded shows everything
  const rows = process.stdout.rows || 30;
  const budget = Math.max(10, Math.min(18, Math.floor(rows * 0.4)));
  if (lines.length <= budget) return [...lines];
  const hidden = lines.length - budget + 1;
  return [...lines.slice(0, budget - 1), truncLine(`… ${hidden} lines hidden · Ctrl+O expands`, getTermWidth())];
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
  // Global user agents — same convention as skills, AGENTS.md, and pi-subagents
  dirs.push(path.join(os.homedir(), ".pi", "agent", "agents"));
  dirs.push(path.join(os.homedir(), ".agents")); // legacy

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
  appendSessionInfo(name: string): string;
}

/**
 * Patch the `parentSession` field in a session header.
 * SessionManager.create() doesn't accept parentSession, so we inject it after creation.
 * The header may be in memory only (deferred flush) or already on disk.
 */
function setParentSession(sm: SessionManager, parentPath: string): void {
  // @ts-expect-error — accessing private fileEntries to mutate header's parentSession
  const header = (sm as { fileEntries: Array<{ type: string; parentSession?: string }> }).fileEntries[0];
  if (header && header.type === "session") {
    header.parentSession = parentPath;
  }
}

/**
 * Create a session manager for a subagent run.
 *
 * Always creates a standalone session file in the target cwd.
 * Sets `parentSession` in the header so subagent work is discoverable
 * as a child of the parent session in `/resume`.
 */
function createSubagentSessionManager(
  parentSessionManager: unknown,
  cwd: string,
): { manager: SessionManagerLike; file: string } | undefined {
  // Resolve parent session file path for linking.
  const parentFile = (parentSessionManager as { getSessionFile?(): string | undefined } | undefined)?.getSessionFile?.();

  // Always persist subagent work so the main agent can search it later.
  const sm = SessionManager.create(cwd);
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) return undefined;

  // Link to parent session so subagent appears as a child in /resume.
  if (parentFile) {
    setParentSession(sm, parentFile);
  }

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

// ── Settings Overrides ────────────────────────────────────────────────────

interface DelegateSettings {
  agentOverrides?: Record<string, { model?: string; thinking?: string; tools?: string[]; skills?: string[] }>;
}

export function readDelegateSettingsFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch { return null; }
}

function getDelegateSettings(filePath: string): DelegateSettings | null {
  const settings = readDelegateSettingsFile(filePath);
  if (!settings?.delegate || typeof settings.delegate !== "object" || Array.isArray(settings.delegate)) return null;
  return settings.delegate as DelegateSettings;
}

/** Load merged delegate settings: project overrides user.
 *  Result is cached per cwd for the lifetime of the delegate call. */
const delegateSettingsCache = new Map<string, DelegateSettings | null>();
export function loadDelegateSettings(cwd: string): DelegateSettings | null {
  const key = path.resolve(cwd);
  const cached = delegateSettingsCache.get(key);
  if (cached !== undefined) return cached;

  const userPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  // Look for project root by finding .pi/ directory, not just .pi/agents/
  let projectPath: string | null = null;
  let dir = key;
  const root = path.resolve("/");
  while (true) {
    if (fs.existsSync(path.join(dir, ".pi"))) { projectPath = path.join(dir, ".pi", "settings.json"); break; }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const user = getDelegateSettings(userPath);
  const project = projectPath ? getDelegateSettings(projectPath) : null;

  if (!user && !project) { delegateSettingsCache.set(key, null); return null; }
  const result: DelegateSettings = {
    agentOverrides: {
      ...(user?.agentOverrides ?? {}),
      ...(project?.agentOverrides ?? {}),
    },
  };
  delegateSettingsCache.set(key, result);
  return result;
}

// ── Retry ─────────────────────────────────────────────────────────────────

/** Patterns matching transient errors that benefit from retry.
 *  Organized as an array for readability/maintainability.
 *  Exported for testability. */
export const RETRYABLE_PATTERNS: RegExp[] = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /overloaded/i,
  /service unavailable/i,
  /temporar(?:ily)? unavailable/i,
  /provider.*unavailable/i,
  /model.*unavailable/i,
  /model.*disabled/i,
  /model.*not found/i,
  /unknown model/i,
  /connection refused/i,
  /connection.*(?:error|lost)/i,
  /other side closed/i,
  /reset before headers/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /ended without/i,
  /http2 request did not get a response/i,
  /upstream/i,
  /timed? out/i,
  /\btimeout\b/i,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /retry delay/i,
];

/** Backward-compat single regex for callers that import the old name.
 *  @deprecated Use isRetryableError() or RETRYABLE_PATTERNS */
export const RETRYABLE_PATTERN = new RegExp(
  RETRYABLE_PATTERNS.map((p) => p.source).join("|"),
  "i",
);

/** Check if an error message matches any retryable pattern. */
export function isRetryableError(error: string): boolean {
  if (!error) return false;
  return RETRYABLE_PATTERNS.some((p) => p.test(error));
}

/** Patterns that indicate a rate-limit (429 / quota) error. */
export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /overloaded/i,
  /retry delay/i,
];

/** Check if an error is specifically a rate limit (429 / quota) error.
 *  Rate limits need much longer backoff than transient network errors. */
export function isRateLimitError(error: string): boolean {
  if (!error) return false;
  return RATE_LIMIT_PATTERNS.some((p) => p.test(error));
}

/** Pure helper for retry backoff math. Exported for testing. */
export function computeRetryDelay(
  attempt: number,
  retryBaseMs: number,
  taskIndex: number,
  isRateLimit: boolean,
): { baseDelay: number; jitter: number; stagger: number; delay: number } {
  const rawBase = isRateLimit ? 30_000 : retryBaseMs;
  const baseDelay = rawBase * Math.pow(2, attempt);
  const jitter = Math.random() * rawBase;
  const stagger = taskIndex * 10_000;
  const delay = Math.min(baseDelay + jitter + stagger, isRateLimit ? 300_000 : 60_000);
  return { baseDelay, jitter, stagger, delay };
}

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

/** Map over items with a concurrency cap, returning indexed results.
 *  Errors propagate naturally — no Promise.allSettled wrapper. */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/** Run a single prompt on an Agent instance. Shared by both fresh and pooled paths. */
export async function runAgentOnce(
  agent: Agent,
  prompt: string,
  config: { systemPrompt: string; model: Model<Api>; thinking: ThinkingLevel; tools: string[]; cwd: string },
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
  onProgress?: (update: AgentProgressUpdate) => void,
  sessionManager?: SessionManagerLike,
  gitBaseline?: Set<string>,
  start?: number,
  suppressSessionAppend = false,
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
    // When retrying, we defer this flush so failed attempts don't pollute the session file.
    if (sessionManager && !suppressSessionAppend) {
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

export async function runAgent(
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
  /** Pre-existing agent. When provided AND allowRetry=false, skips creation and retry — runs once (pool hits). */
  existingAgent?: Agent,
  /** When true, existingAgent is a resumed session — safe to retry on transient errors. */
  allowRetry = false,
  /** Task index within a concurrent delegate batch. Used to stagger retries across tasks. */
  taskIndex = 0,
): Promise<{ output: string; error?: string; durationMs: number; tokens: number; touchedFiles: string[] }> {
  const start = Date.now();

  // Snapshot git status before the agent starts so we can diff after.
  const gitBaseline = await getGitChangedFiles(config.cwd);

  // Pool hits: single attempt, no retry loop (stateful agent with accumulated context).
  // Resumed agents (allowRetry=true) fall through to the retry loop.
  if (existingAgent && !allowRetry) {
    return runAgentOnce(existingAgent, prompt, config, modelRegistry, signal, onProgress, sessionManager, gitBaseline, start);
  }

  // Create agent once — reuse across retries to preserve prior work (tool results, reasoning).
  // Fresh agents start empty; resumed/pooled agents start with loaded state.
  let agent: Agent;
  if (existingAgent) {
    agent = existingAgent;
  } else {
    agent = new Agent({
      initialState: {
        systemPrompt: config.systemPrompt,
        model: config.model,
        thinkingLevel: config.thinking,
        tools: config.tools
          .map((name) => TOOL_FACTORIES[name]?.(config.cwd))
          .filter(Boolean) as AgentTool[],
      },
      convertToLlm,
      streamFn: async (m, context, options) => {
        const auth = await modelRegistry.getApiKeyAndHeaders(m);
        if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
        return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
      },
    });
  }

  // Track sessionManager — may be replaced on rehydration.
  let currentSessionManager = sessionManager;

  // Snapshot message count before first prompt — trim back to here on retry.
  const initialMessageCount = agent.state.messages.length;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return { output: "", error: "Aborted", durationMs: Date.now() - start, tokens: 0, touchedFiles: [] };
    }

    // Signal retry to the progress UI.
    if (attempt > 0 && onProgress) onProgress({ tokens: 0, toolUses: 0, durationMs: Date.now() - start, activities: [] });

    if (attempt > 0) {
      if (existingAgent) {
        existingAgent.state.messages.length = initialMessageCount;
      } else if (currentSessionManager) {
        const sessionFile = currentSessionManager.getSessionFile();
        if (sessionFile) {
          const rehydrated = rehydrateAgent(sessionFile, config, modelRegistry);
          if (rehydrated) {
            agent = rehydrated.agent;
            currentSessionManager = rehydrated.sessionManager;
          } else {
            // Fallback: fresh agent.
            agent = new Agent({
              initialState: {
                systemPrompt: config.systemPrompt,
                model: config.model,
                thinkingLevel: config.thinking,
                tools: config.tools
                  .map((name) => TOOL_FACTORIES[name]?.(config.cwd))
                  .filter(Boolean) as AgentTool[],
              },
              convertToLlm,
              streamFn: async (m, context, options) => {
                const auth = await modelRegistry.getApiKeyAndHeaders(m);
                if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
                return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
              },
            });
            currentSessionManager = sessionManager;
          }
        }
      }
    }

    const messagesBeforeAttempt = agent.state.messages.length;
    const result = await runAgentOnce(agent, prompt, config, modelRegistry, signal, onProgress, currentSessionManager, gitBaseline, start, true);
    if (result.error && attempt < maxRetries && isRetryableError(result.error)) {
      const isRateLimit = isRateLimitError(result.error);
      const { delay } = computeRetryDelay(attempt, retryBaseMs, taskIndex, isRateLimit);

      try { await sleepWithAbort(delay, signal); } catch (sleepErr) {
        if (!(sleepErr instanceof AbortError)) throw sleepErr;
      }
      continue;
    }

    // Flush pending messages only on success. Failed attempts (even the final
    // exhausted retry) should not pollute the session file.
    if (currentSessionManager && !result.error) {
      try {
        for (let mi = messagesBeforeAttempt; mi < agent.state.messages.length; mi++) {
          const msg = agent.state.messages[mi]!;
          if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult" || msg.role === "custom") {
            currentSessionManager.appendMessage(msg);
          }
        }
      } catch { /* best effort */ }
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

// ── Completion Mutation Guard ──────────────────────────────────────────

const IMPLEMENTATION_PATTERNS = [
  /\b(?:implement|fix|edit|modify|patch|refactor)\b/i,
  /\bapply\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
  /\bmake\s+(?:the\s+)?changes\b/i,
  /\bdo those fixes\b/i,
  /\b(?:update|add|remove|replace|delete|create)\b(?!\s+(?:(?:a|an|the)\s+)?(?:report|summary|findings?|overview|analysis)(?:\b|$))/i,
];

const REVIEW_ONLY_PATTERNS = [
  /\breview only\b/i,
  /\bsuggest fixes only\b/i,
  /\bonly return findings\b/i,
  /\breturn findings only\b/i,
  /\bdo not edit\b/i,
  /\bdon't edit\b/i,
  /\bdo not modify\b/i,
  /\bdo not change files\b/i,
];

/** Check if a task description implies the agent should produce edits. */
export function taskImpliesEdits(task: string): boolean {
  const text = task;
  if (REVIEW_ONLY_PATTERNS.some((p) => p.test(text))) return false;
  return IMPLEMENTATION_PATTERNS.some((p) => p.test(text));
}

/** Check if the agent's tool activities include any mutations (edit/write/mutating bash). */
export function hasMutationActivity(activities: ToolActivity[]): boolean {
  return activities.some((a) =>
    a.name === "edit" || a.name === "write" ||
    (a.name === "bash" && typeof a.args?.command === "string" &&
     /\b(?:sed|awk|perl|python\d*|tee|dd|mv|cp|rm|truncate|sponge|git\s+(?:commit|add|rm|mv|cherry-pick|rebase|merge|am|apply|stash\s+pop))\b/i.test(a.args.command))
  );
}

/** Resolve a cwd string: expand ~ and make absolute. */
export function resolveCwd(cwd: string): string {
  const expanded = cwd.startsWith("~") ? path.join(os.homedir(), cwd.slice(1)) : cwd;
  return path.resolve(expanded);
}

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


// ── Extension ─────────────────────────────────────────────────────────────

// ── Async Poll/Cancel Handlers ────────────────────────────────────────────

export function handlePoll(params: { ticket?: string }, ctx: ExtensionContext): AgentToolResult<DelegateDetails> {
  sweepTickets();
  const parentModelId = ctx.model?.id;

  // Only use top-level ticket param — per-task prompt is NOT a ticket ID
  const ticketId = params.ticket;

  // No ticket specified — list all
  if (!ticketId) {
    const tickets = [...ticketRegistry.values()];
    if (!tickets.length) {
      return {
        content: [{ type: "text", text: "No async tickets." }],
        details: { tasks: [], results: [], progress: [], parentModel: parentModelId },
      };
    }
    const lines = tickets.map(t => {
      const icon = t.status === "running" ? "⏳" : t.status === "done" ? "✓" : "✗";
      const done = t.progress.filter(p => p.status === "done").length;
      const age = fmtDuration(Date.now() - t.created);
      return `${icon} ${t.id} · ${done}/${t.progress.length} tasks · ${t.status} · ${age}`;
    });
    return {
      content: [{ type: "text", text: `Async tickets:\n${lines.join("\n")}` }],
      details: { tasks: [], results: [], progress: [], parentModel: parentModelId },
    };
  }

  // Specific ticket
  const ticket = ticketRegistry.get(ticketId);
  if (!ticket) {
    return {
      content: [{ type: "text", text: `Ticket '${ticketId}' not found. It may have expired or never existed.` }],
      details: { tasks: [], results: [], progress: [], parentModel: parentModelId },
    };
  }

  if (ticket.status === "running") {
    const lines = ticket.progress.map(p => {
      const icon = p.status === "done" ? "✓" : p.status === "running" ? "⏳" : p.status === "failed" ? "✗" : "○";
      const activity = p.activities.findLast(a => !a.result);
      const currentTool = activity ? ` · ${formatToolCallShort(activity.name, activity.args)}` : "";
      const duration = fmtDuration(Date.now() - ticket.created);
      return `${icon} ${p.agent} · ${p.status}${currentTool} · ${duration}`;
    });
    return {
      content: [{ type: "text", text: `Ticket ${ticket.id}: RUNNING (${fmtDuration(Date.now() - ticket.created)})\n${lines.join("\n")}` }],
      details: { tasks: ticket.tasks, results: [], progress: [...ticket.progress], parentModel: ticket.parentModelId },
    };
  }

  // Done / Failed / Cancelled — full results
  return formatCompletedTicket(ticket);
}

export function handleCancel(params: { ticket?: string }): AgentToolResult<DelegateDetails> {
  sweepTickets();
  const ticketId = params.ticket;

  if (!ticketId) {
    return {
      content: [{ type: "text", text: "action='cancel' requires a ticket ID." }],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  const ticket = ticketRegistry.get(ticketId);
  if (!ticket) {
    return {
      content: [{ type: "text", text: `Ticket '${ticketId}' not found.` }],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  if (ticket.status !== "running") {
    return {
      content: [{ type: "text", text: `Ticket '${ticketId}' is already ${ticket.status}.` }],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  ticket.controller.abort();
  ticket.status = "cancelled";
  ticket.completedAt = Date.now();
  return {
    content: [{ type: "text", text: `Ticket '${ticketId}' cancelled.` }],
    details: { tasks: [], results: [], progress: [] },
  };
}

export default function delegateExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    promptSnippet: "Spawn subagents in parallel — each with independent context, model, tools, and skills.",
    promptGuidelines: [
      "Use delegate to parallelize independent work across subagents. For prompt tasks, each task must include \"prompt\"; specify \"agent\" (name from .pi/agents/*.md) and/or \"systemPrompt\". All other fields (model, tools, skills, thinking, cwd, context) are optional and fall back to agent defaults or parent session values.",
      "Subagents only have pi core tools: read, write, edit, bash.",
      "Call delegate with an empty tasks array to see how to use the delegate tool.",
      "For async mode: set async:true to fire tasks in the background. Results are automatically delivered when complete. Use delegate({action:\"poll\"}) to check status or delegate({action:\"poll\",ticket:\"id\"}) for a specific ticket.",
    ],
    description:
      "Spawn subagents in parallel. Call with an empty tasks array for full help.",
    parameters: Type.Object({
      action: Type.Optional(Type.String({
        enum: ["poll", "cancel"],
        description: "Top-level async ticket action. Use 'poll' to list/check tickets or 'cancel' to abort one.",
      })),
      async: Type.Optional(Type.Boolean({
        description: "Return immediately with a ticket ID. Poll with action='poll'.",
      })),
      ticket: Type.Optional(Type.String({
        description: "Ticket ID for poll/cancel actions.",
      })),
      tasks: Type.Optional(Type.Array(
        Type.Object({
          prompt: Type.Optional(Type.String({ description: "The task for this subagent to perform. Required unless action is 'close'/'list' or resumeFrom is set." })),
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
            enum: ["fresh", "with-parent-transcript"],
            description: "'fresh' (default) for clean context, 'with-parent-transcript' to include the full parent session transcript in the subagent's prompt (expensive — use deliberately)."
          })),
          sessionId: Type.Optional(Type.String({
            description: "Name for a persistent subagent session. First use creates it, subsequent uses reuse the same agent. Use action='close' to tear down.",
          })),
          action: Type.Optional(Type.String({
            enum: ["prompt", "close", "list", "poll", "cancel"],
            description: "'prompt' (default) runs a task, 'close' tears down a pooled session, 'list' shows sessions, 'poll' checks async tickets, 'cancel' aborts async ticket.",
          })),
          resumeFrom: Type.Optional(Type.String({
            description: "Absolute path to a previous subagent session .jsonl to continue from. Agent resumes with full context.",
          })),
        }),
        { minItems: 0, description: "Tasks to run in parallel. Pass an empty array to see available agents and usage docs." },
      )),
    }),

    async execute(_id, params: DelegateParams, signal, onUpdate, ctx) {
      const parentModelId = ctx.model?.id;
      const tasks = params.tasks ?? [];

      // ── Poll action ───────────────────────────────────────────────────
      // Top-level action is the public API. Per-task action is accepted for
      // backward compatibility with early async builds.
      if (params.action === "poll" || tasks.some(t => t.action === "poll")) {
        return handlePoll(params, ctx);
      }

      // ── Cancel action ─────────────────────────────────────────────────
      // Top-level action is the public API. Per-task action is accepted for
      // backward compatibility with early async builds.
      if (params.action === "cancel" || tasks.some(t => t.action === "cancel")) {
        return handleCancel(params);
      }

      const agents = discoverAgents(ctx.cwd);

      // ── Help mode ─────────────────────────────────────────────────
      if (!tasks.length) {
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
            "- `prompt` — The task for this subagent. Optional when `resumeFrom` is set (defaults to 'continue').",
            "- `agent` — Named agent from the list above. Inline fields override agent defaults.",
            "- `systemPrompt` — System prompt. Required if no `agent` specified.",
            "- `model` — e.g. `anthropic/claude-sonnet-4`. Falls back to agent default, then parent model.",
            "- `tools` — Array of tool names. Default: read, write, edit, bash.",
            "- `skills` — Skill names injected into the system prompt.",
            "- `thinking` — off, minimal, low, medium, high, xhigh. Default: agent setting or 'off'.",
            "- `cwd` — Working directory. Default: parent session cwd.",
            "- `context` — 'fresh' (default) or 'with-parent-transcript' to inject the full parent conversation into the subagent's prompt (token-expensive — use deliberately).",
            "- `sessionId` — Name for a persistent subagent. First use creates it, subsequent calls reuse the same agent (multi-turn).",
            "- `action` — Per-task action: 'prompt' (default), 'close' to tear down a pooled session, 'list' to show active sessions.",
            "- top-level `action` — Async ticket action: 'poll' or 'cancel'. Does not require `tasks`.",
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
            "",
            "## Resuming Previous Sessions",
            "",
            "Use `resumeFrom` to continue a failed or interrupted subagent from where it left off.",
            "Pass the absolute path to the session `.jsonl` file (shown in delegate output).",
            "The agent gets the full conversation history and the new `prompt` continues naturally.",
            "",
            "```json",
            "// Resume a failed browser test — agent remembers everything it already did",
            "{ \"prompt\": \"Continue testing — the server is already running on :3000\",",
            "  \"resumeFrom\": \"/home/user/.pi/agent/sessions/project/2026-01-01T12-00-00Z_abc123.jsonl\" }",
            "```",
            "",
            "Combine with `sessionId` to resume AND pool the agent for further multi-turn use:",
            "",
            "```json",
            "{ \"prompt\": \"Continue the investigation\",",
            "  \"resumeFrom\": \"/path/to/session.jsonl\",",
            "  \"sessionId\": \"my-resumed-agent\" }",
            "```",
            "",
            "## Async Mode",
            "",
            "Set `async: true` on the top-level call to fire tasks in the background:",
            "",
            "```json",
            "delegate({ async: true, tasks: [{ agent: \"scout\", prompt: \"Investigate auth\" }] })",
            "```",
            "→ Returns ticket ID immediately. Parent keeps working.",
            "",
            "- `delegate({ action: \"poll\" })` — list all tickets",
            "- `delegate({ action: \"poll\", ticket: \"abc123\" })` — check one ticket",
            "- `delegate({ action: \"cancel\", ticket: \"abc123\" })` — abort a running ticket",
            "",
            "Max 5 concurrent async tickets. Completed tickets auto-deliver results.",
          ].join("\n") }],
          details: { tasks: [], results: [], progress: [], parentModel: parentModelId },
        };
      }

      // ── Validate ──────────────────────────────────────────────────
      // Disallow same sessionId across multiple parallel tasks (one agent can't serve two prompts concurrently).
      const sessionIds = tasks.map((t) => t.sessionId).filter(Boolean);
      const duplicateSessions = sessionIds.filter((id, i) => sessionIds.indexOf(id) !== i);
      if (duplicateSessions.length) {
        return {
          content: [{ type: "text", text: `Duplicate sessionId(s) across tasks: ${[...new Set(duplicateSessions)].join(", ")}. A pooled agent can only handle one prompt at a time.` }],
          details: { tasks, results: [], progress: [], parentModel: parentModelId },
        };
      }

      const unknown: string[] = [];
      for (const t of tasks) {
        if (t.agent && !agents.has(t.agent)) unknown.push(t.agent);
      }
      if (unknown.length) {
        const names = [...agents.keys()];
        return {
          content: [{ type: "text", text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}. Call delegate with an empty tasks array for help.` }],
          details: { tasks, results: [], progress: [], parentModel: parentModelId },
        };
      }

      // ── Resolve tasks ─────────────────────────────────────────────
      // Build parent transcript lazily — only computed once if any task uses with-parent-transcript
      let parentTranscript: string | null = null;
      const needsParentContext = tasks.some((t) => t.context === "with-parent-transcript");
      if (needsParentContext) {
        if (!ctx.sessionManager) {
          throw new Error("context: 'with-parent-transcript' requires a persisted parent session.");
        }
        parentTranscript = buildParentTranscript(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      }

      const resolved = tasks.map((t, i) => {
        const agent = t.agent ? agents.get(t.agent) : undefined;
        const cwd = resolveCwd(t.cwd ?? ctx.cwd);

        // Load settings-based overrides for this agent
        const settings = loadDelegateSettings(cwd);
        const agentOverride = (t.agent && settings?.agentOverrides?.[t.agent]) ? settings.agentOverrides[t.agent] : undefined;

        // Build system prompt (pooled agents already have one baked in)
        const pooledConfig = t.sessionId ? agentPool.get(t.sessionId)?.config : undefined;
        let systemPrompt = t.systemPrompt ?? agent?.systemPrompt ?? pooledConfig?.systemPrompt ?? "";
        if (!systemPrompt.trim()) {
          systemPrompt = (typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "") || "You are a helpful coding assistant.";
        }

        // Prompt is required for fresh tasks. ResumeFrom provides context already.
        if (t.action !== "close" && t.action !== "list" && !t.resumeFrom && !t.prompt?.trim()) {
          throw new Error(`Task ${i}: prompt is required unless action is 'close'/'list' or resumeFrom is set.`);
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

        // Build prompt — wrap with parent context if using with-parent-transcript
        let prompt = t.prompt || (t.resumeFrom ? "Continue from where you left off. Pick up the task and keep going." : t.prompt);
        const parentCtx = t.context === "with-parent-transcript" && parentTranscript ? parentTranscript : null;
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

        // Resolve model — explicit specs must resolve or fail; omitted falls back to parent
        let model: Model<Api> | undefined;
        let tools: string[] = [];
        let thinking: ThinkingLevel = "off";
        const warnings: string[] = [];

        if (t.action !== "close" && t.action !== "list") {
          // For pool hits, the model is already baked into the agent — skip resolution.
          if (t.sessionId && agentPool.has(t.sessionId)) {
            model = agentPool.get(t.sessionId)!.config.model;
          } else {
            const explicitModelSpec = t.model ?? agentOverride?.model ?? agent?.model;
            const modelSpec = explicitModelSpec ?? pooledConfig?.model?.id;
            const resolvedModel = resolveModel(modelSpec, ctx.modelRegistry, ctx.model);

            if (explicitModelSpec && !resolvedModel) {
              // Caller explicitly requested a specific model that couldn't be resolved.
              // Fail loudly — silent fallback defeats the purpose of specifying a model.
              throw new Error(`Task ${i}: requested model '${explicitModelSpec}' is not available. Check provider config or remove the model field to use the parent model.`);
            }

            model = resolvedModel ?? ctx.model;
          }

          if (!model) {
            throw new Error(`Task ${i}: no model available — parent session has no model set.`);
          }

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
        return { ...t, cwd, systemPrompt, model: model!, tools, thinking, prompt, agentName: agent?.name ?? "inline", warnings };
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
        details: { tasks, results: [], progress: [...progress], parentModel: parentModelId },
      });
      fire();

      // ── Async mode ───────────────────────────────────────────────────
      if (params.async) {
        sweepTickets();
        const runningCount = [...ticketRegistry.values()].filter(t => t.status === "running").length;
        if (runningCount >= MAX_ASYNC_TICKETS) {
          return {
            content: [{ type: "text", text: `Too many async tickets running (${runningCount}/${MAX_ASYNC_TICKETS}). Poll existing tickets or cancel one first.` }],
            details: { tasks, results: [], progress: [], parentModel: parentModelId },
          };
        }

        const ticketId = generateTicketId();
        const controller = new AbortController();
        const ticket: AsyncTicket = {
          id: ticketId,
          created: Date.now(),
          tasks,
          resolved,
          status: "running",
          results: new Array(resolved.length),
          progress: [...progress],
          controller,
          parentModelId,
        };
        ticketRegistry.set(ticketId, ticket);

        // Capture values for the closure — do NOT use `signal` from execute()
        // The parent turn's signal dies when execute() returns.
        const ticketSignal = controller.signal;
        const modelRegistry = ctx.modelRegistry;

        // Fire and forget — runs on the event loop
        mapConcurrent(resolved, MAX_CONCURRENCY, async (t, i) => {
          // IMPORTANT: wrap each task in try/catch so one failure
          // doesn't reject the entire mapConcurrent promise.
          const p = ticket.progress[i]!;
          try {
            // Check if parent signal already aborted
            if (signal?.aborted) {
              p.status = "failed"; p.error = "Aborted";
              ticket.results[i] = { agent: t.agentName, output: "", error: "Aborted", durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
              return ticket.results[i]!;
            }

            // ── Session busy guard (async) ───────────────────────────
            if (t.sessionId) {
              const busyTicketId = isSessionBusy(t.sessionId);
              if (busyTicketId && busyTicketId !== ticketId) {
                p.status = "failed";
                p.error = `Session '${t.sessionId}' is busy with async ticket ${busyTicketId}. Poll or cancel that ticket first.`;
                ticket.results[i] = { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
                return ticket.results[i]!;
              }
            }

            p.status = "running"; p.model = t.model?.id;

            // ── Session action handling (async) ─────────────────────
            if (t.action === "close") {
              if (!t.sessionId) {
                p.status = "failed"; p.error = "action='close' requires sessionId.";
                ticket.results[i] = { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
                return ticket.results[i]!;
              }
              const closed = closePooledAgent(t.sessionId);
              p.status = "done"; p.durationMs = Date.now() - ticket.created;
              ticket.results[i] = { agent: t.agentName, output: closed ? `Session '${t.sessionId}' closed.` : `Session '${t.sessionId}' not found.`, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
              return ticket.results[i]!;
            }

            if (t.action === "list") {
              const listing = listPooledAgents();
              p.status = "done"; p.durationMs = Date.now() - ticket.created;
              ticket.results[i] = { agent: t.agentName, output: `Active sessions:\n${listing.join("\n")}`, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
              return ticket.results[i]!;
            }

            // ── Pooled agent resolution (async) ───────────────────
            let existingAgent: Agent | undefined;
            let poolSessionManager: SessionManagerLike | undefined;
            let poolSessionFile: string | undefined;
            let pendingPoolInsert = false;

            if (t.sessionId) {
              const pooled = agentPool.get(t.sessionId);
              if (pooled) {
                // Pool hit — validate config compatibility
                const frozen = pooled.config;
                const mismatches: string[] = [];
                if (frozen.cwd !== t.cwd) mismatches.push(`cwd: '${frozen.cwd}' vs '${t.cwd}'`);
                if (frozen.thinking !== t.thinking) mismatches.push(`thinking: '${frozen.thinking}' vs '${t.thinking}'`);
                const frozenToolSet = [...frozen.tools].sort().join(",");
                const newToolSet = [...t.tools].sort().join(",");
                if (frozenToolSet !== newToolSet) mismatches.push(`tools: [${frozenToolSet}] vs [${newToolSet}]`);
                if (mismatches.length) {
                  p.status = "failed"; p.error = `Session '${t.sessionId}' config mismatch. Close and recreate: ${mismatches.join("; ")}`;
                  ticket.results[i] = { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
                  return ticket.results[i]!;
                }
                existingAgent = pooled.agent;
                poolSessionManager = pooled.sessionManager;
                poolSessionFile = pooled.sessionFile;
                pooled.lastUsed = Date.now();
                p.model = frozen.model.id;
              } else {
                // Pool miss
                if (t.resumeFrom) {
                  pendingPoolInsert = true;
                } else {
                  const session = createSubagentSessionManager(ctx.sessionManager, t.cwd);
                  poolSessionManager = session?.manager;
                  poolSessionFile = session?.file;

                  const tools = t.tools.map((name) => TOOL_FACTORIES[name]?.(t.cwd)).filter(Boolean) as AgentTool[];
                  const agentConfig = { systemPrompt: t.systemPrompt, model: t.model, thinkingLevel: t.thinking, tools };

                  let agent: Agent | undefined;
                  if (poolSessionFile) {
                    const rehydrated = rehydrateAgent(
                      poolSessionFile,
                      { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd },
                      modelRegistry,
                    );
                    if (rehydrated) {
                      agent = rehydrated.agent;
                      poolSessionManager = rehydrated.sessionManager;
                    }
                  }
                  if (!agent) {
                    const streamFn = async (m: any, context: any, options: any) => {
                      const auth = await modelRegistry.getApiKeyAndHeaders(m);
                      if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
                      return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
                    };
                    agent = new Agent({ initialState: agentConfig, convertToLlm, streamFn });
                  }
                  existingAgent = agent;
                  pendingPoolInsert = true;

                  // Synchronous pool insertion — prevent race conditions
                  if (t.sessionId && existingAgent && poolSessionManager && poolSessionFile) {
                    agentPool.set(t.sessionId, {
                      agent: existingAgent,
                      sessionManager: poolSessionManager,
                      sessionFile: poolSessionFile,
                      config: { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd },
                      lastUsed: Date.now(),
                      createdAt: Date.now(),
                      totalTokens: 0,
                      promptCount: 0,
                    });
                    pendingPoolInsert = false;
                  }
                }
              }
            }

            // ── Resume from previous session (async) ────────────────
            let resumedSessionManager: SessionManagerLike | undefined;
            let resumedSessionFile: string | undefined;
            const isPoolHit = t.sessionId && !pendingPoolInsert && agentPool.has(t.sessionId!);

            if (t.resumeFrom) {
              if (isPoolHit) {
                const msg = `resumeFrom conflicts with active sessionId '${t.sessionId}'. The pooled agent has its own accumulated context. Close the session first if you want to resume from a different point.`;
                p.status = "failed"; p.error = msg;
                ticket.results[i] = { agent: t.agentName, output: "", error: msg, durationMs: 0, tokens: 0, sessionFile: poolSessionFile, touchedFiles: [] };
                return ticket.results[i]!;
              } else {
                const resolvedPath = resolveCwd(t.resumeFrom);
                if (!fs.existsSync(resolvedPath)) {
                  p.status = "failed"; p.error = `resumeFrom: file not found: ${resolvedPath}`;
                  ticket.results[i] = { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: resolvedPath, touchedFiles: [] };
                  return ticket.results[i]!;
                }
                const resumeConfig = { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd };
                const rehydrated = rehydrateAgent(resolvedPath, resumeConfig, modelRegistry);
                if (!rehydrated) {
                  p.status = "failed"; p.error = `resumeFrom: empty or corrupt session: ${resolvedPath}`;
                  ticket.results[i] = { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: resolvedPath, touchedFiles: [] };
                  return ticket.results[i]!;
                }
                existingAgent = rehydrated.agent;
                resumedSessionManager = rehydrated.sessionManager;
                resumedSessionFile = resolvedPath;
              }
            }

            const session = resumedSessionManager
              ? { manager: resumedSessionManager, file: resumedSessionFile }
              : t.sessionId
                ? { manager: poolSessionManager, file: poolSessionFile }
                : createSubagentSessionManager(ctx.sessionManager, t.cwd);

            if (session?.manager && !isPoolHit && !resumedSessionManager) {
              const label = `⎇ delegate · ${t.agentName}`;
              session.manager.appendSessionInfo(label);
            }

            // ── Run agent (async) ──────────────────────────────────
            const config = { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd };
            const r = await runAgent(
              config,
              t.prompt,
              modelRegistry,
              ticketSignal,  // Fresh controller, NOT parent signal
              (u) => {
                // Update ticket progress directly — NO fire()/onUpdate
                p.tokens = u.tokens;
                p.toolUses = u.toolUses;
                p.durationMs = u.durationMs;
                p.lastActivityAt = u.lastActivityAt;
                p.activities = u.activities;
              },
              session?.manager,
              undefined,  // maxRetries
              2000,       // retryBaseMs
              existingAgent,
              !isPoolHit, // allowRetry
              i,
            );

            // Pool insertion on success (only if not already inserted synchronously)
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

            // Update pool stats on subsequent successful runs
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
            ticket.results[i] = { agent: t.agentName, output: r.output, error: r.error, durationMs: r.durationMs, tokens: r.tokens, sessionFile: session?.file ?? poolSessionFile, touchedFiles: r.touchedFiles };
            return ticket.results[i]!;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            p.status = "failed";
            p.error = msg;
            ticket.results[i] = { agent: t.agentName, output: "", error: msg, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
            return ticket.results[i]!;
          }
        }, ticketSignal).then(() => {
          // All tasks settled — determine final ticket status
          const anyFailed = ticket.results.some(r => r && "error" in r && r.error);
          const allSettled = ticket.results.every(r => r !== undefined);
          if (ticket.status === "running") {
            ticket.status = allSettled && !anyFailed ? "done" : anyFailed && !ticket.results.some(r => r && !r.error) ? "failed" : anyFailed ? "failed" : "done";
            ticket.completedAt = Date.now();
          }
          deliverTicketResults(pi, ticket);
        }).catch((err) => {
          // Defense-in-depth — should not happen if individual tasks catch properly
          ticket.status = "failed";
          ticket.error = err instanceof Error ? err.message : String(err);
          ticket.completedAt = Date.now();
          deliverTicketResults(pi, ticket);
        });

        return {
          content: [{
            type: "text",
            text: [
              `Async ticket: ${ticketId}`,
              `${resolved.length} task(s) dispatched · ${runningCount + 1}/${MAX_ASYNC_TICKETS} async slots in use`,
              "",
              "Results will be delivered when all tasks complete.",
              `Poll anytime: delegate({ action: "poll", ticket: "${ticketId}" })`,
              `Cancel if needed: delegate({ action: "cancel", ticket: "${ticketId}" })`,
            ].join("\n"),
          }],
          details: { tasks, results: [], progress: [...progress], parentModel: parentModelId, ticketId },
        };
      }

      // ── Sync mode (existing path) ──────────────────────────────────
      // Sweep stale pooled agents before dispatching.
      sweepPool();

      const results = await mapConcurrent(resolved, MAX_CONCURRENCY, async (t, i) => {
        const p = progress[i]!;
        // Skip the "running" flash if we're already aborted.
        if (signal?.aborted) {
          p.status = "failed"; p.error = "Aborted"; fire();
          return { agent: t.agentName, output: "", error: "Aborted", durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
        }
        p.status = "running"; p.model = t.model?.id; fire();

        // ── Session busy guard (sync) ───────────────────────────
        if (t.sessionId) {
          const busyTicketId = isSessionBusy(t.sessionId);
          if (busyTicketId) {
            p.status = "failed"; p.error = `Session '${t.sessionId}' is busy with async ticket ${busyTicketId}. Poll or cancel that ticket first.`; fire();
            return { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
          }
        }

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
            // Model was already resolved from frozen config at task resolution time.
            // Sync progress display to match.
            p.model = frozen.model.id;
          } else {
            // Pool miss — when resumeFrom is specified, defer to the resume block
            // which will rehydrate from the target session file. Creating a session
            // here would orphan an empty .jsonl on disk.
            if (t.resumeFrom) {
              pendingPoolInsert = true;
            } else {
              // Try to rehydrate from disk, or create fresh.
              const session = createSubagentSessionManager(ctx.sessionManager, t.cwd);
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
        }

        // ── Resume from previous session ────────────────────────────
        let resumedSessionManager: SessionManagerLike | undefined;
        let resumedSessionFile: string | undefined;
        // isPoolHit: sessionId exists AND agent was found in pool (not a fresh pool miss).
        const isPoolHit = t.sessionId && !pendingPoolInsert;

        if (t.resumeFrom) {
          if (isPoolHit) {
            // Pool has accumulated state — resumeFrom can't override it. Hard error.
            const msg = `resumeFrom conflicts with active sessionId '${t.sessionId}'. The pooled agent has its own accumulated context. Close the session first if you want to resume from a different point.`;
            p.status = "failed"; p.error = msg; fire();
            return { agent: t.agentName, output: "", error: msg, durationMs: 0, tokens: 0, sessionFile: poolSessionFile, touchedFiles: [] };
          } else {
            const resolvedPath = resolveCwd(t.resumeFrom);
            if (!fs.existsSync(resolvedPath)) {
              p.status = "failed"; p.error = `resumeFrom: file not found: ${resolvedPath}`; fire();
              return { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: resolvedPath, touchedFiles: [] };
            }
            const resumeConfig = { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd };
            const rehydrated = rehydrateAgent(resolvedPath, resumeConfig, ctx.modelRegistry);
            if (!rehydrated) {
              p.status = "failed"; p.error = `resumeFrom: empty or corrupt session: ${resolvedPath}`; fire();
              return { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: resolvedPath, touchedFiles: [] };
            }
            existingAgent = rehydrated.agent;
            resumedSessionManager = rehydrated.sessionManager;
            resumedSessionFile = resolvedPath;

            // Link resumed session to parent for /resume discoverability.
            const parentFile = (ctx.sessionManager as { getSessionFile?(): string | undefined } | undefined)?.getSessionFile?.();
            if (parentFile) {
              setParentSession(rehydrated.sessionManager as unknown as SessionManager, parentFile);
            }
          }
        }

        // Create a session manager — prefer resumed, then pool, then fresh.
        // When resumeFrom is active, skip pool-miss session creation to avoid orphaned empty files.
        const session = resumedSessionManager
          ? { manager: resumedSessionManager, file: resumedSessionFile }
          : t.sessionId
            ? { manager: poolSessionManager, file: poolSessionFile }
            : createSubagentSessionManager(ctx.sessionManager, t.cwd);

        // Label subagent sessions so they're identifiable in /resume.
        // Skip pool hits (already labeled) and resumed sessions (keep original label).
        if (session?.manager && !isPoolHit && !resumedSessionManager) {
          const label = `⎇ delegate · ${t.agentName}`;
          session.manager.appendSessionInfo(label);
        }

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
              existingAgent, // pre-existing agent for pooled, resumed, or pool-miss sessions
              !isPoolHit,    // allowRetry: safe unless pool hit (accumulated multi-turn state)
              i,
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
            const msg = err instanceof Error ? err.message : String(err);
            p.status = "failed";
            p.error = msg;
            fire();
            return { agent: t.agentName, output: "", error: msg, durationMs: 0, tokens: 0, sessionFile: session?.file ?? poolSessionFile ?? resumedSessionFile, touchedFiles: [] };
          }
        };

        if (isPoolHit && t.sessionId) {
          return withSessionLock(t.sessionId, doRun);
        }
        return doRun();
      }, signal);

      // ── Format for LLM ────────────────────────────────────────────
      const finalResults = results;
      const elapsedTotal = Date.now() - startedAt;

      // ── Completion mutation guard ───────────────────────────────
      const mutationWarnings: string[] = [];
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i]!;
        if (r.error) continue;
        const t = resolved[i]!;
        if (t.action === "close" || t.action === "list") continue;
        const p = progress[i]!;
        if (taskImpliesEdits(t.prompt || "") && !hasMutationActivity(p.activities)) {
          mutationWarnings.push(`[GUARD] ${r.agent}: task implies edits but no mutation tools ran (edit/write/mutating bash). Did the agent only produce text below?`);
        }
      }

      const parts: string[] = [];
      const succeeded = finalResults.filter((r) => !r.error).length;
      parts.push(`${succeeded}/${finalResults.length} tasks completed successfully · ${fmtDuration(elapsedTotal)} wall time\n`);
      for (const w of mutationWarnings) parts.push(w);
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i]!;
        const t = resolved[i]!;
        parts.push(`=== ${r.agent}: ${trunc(t.prompt || t.action || "", 80)} ===`);
        if (t.warnings?.length) {
          for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
        }
        if (r.error) {
          const failParts = [r.error];
          if (r.sessionFile) failParts.push(`session: ${shortenPath(r.sessionFile)}`);
          parts.push(`[FAILED: ${failParts.join(" · ")}]`);
          if (r.sessionFile && fs.existsSync(r.sessionFile)) {
            const safePath = JSON.stringify(r.sessionFile);
            parts.push(`→ To retry: delegate({ tasks: [{ resumeFrom: ${safePath}, prompt: "continue" }] })`);
          }
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
        details: { tasks, results: finalResults, progress, parentModel: parentModelId },
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
      const state = ctx.state as Record<string, unknown> & { startedAt?: number; interval?: ReturnType<typeof setInterval> };
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
        p.model ? ` ${theme.fg("accent", p.model)}` : "";

      // ── Helper: format the "current activity" line (collapsed or expanded fallback) ─────
      const compactActivity = (p: TaskProgress): string => {
        const current = p.activities.findLast((a) => !a.result);
        if (current) {
          const call = formatToolCallShort(current.name, current.args);
          const toolAge = fmtDuration(Date.now() - current.startTime);
          return `${call} | ${toolAge}`;
        }
        // No current tool — show the last completed one, or "thinking…"
        if (p.activities.length > 0) {
          const last = p.activities[p.activities.length - 1]!;
          const call = formatToolCallShort(last.name, last.args);
          return `${call} ✓`;
        }
        return "thinking…";
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
                // ── Expanded: current activity (or last completed if none in-flight) ──
                const call = current
                  ? formatToolCallShort(current.name, current.args)
                  : compactActivity(p);
                const elapsedTool = current
                  ? ` | ${fmtDuration(Date.now() - current.startTime)}`
                  : "";
                const prefix = current ? "> " : "  ";
                lines.push(truncLine(`${ind}${theme.fg("warning", `${prefix}${call}${elapsedTool}`)}`, w));
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
          lines.push(truncLine(`${tree(i, total)} ${icon} ${theme.bold(p.agent)}${modelLabel(p)} ${taskPreview}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`, w));

          // Tool activities: compact summary only in expanded mode.
          if (p.activities.length > 0 && options.expanded) {
            const names = p.activities.map((a) => a.name).filter((n, i, arr) => arr.indexOf(n) === i);
            const nameList = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");
            const okCount = p.activities.filter((a) => a.result && !a.result.isError).length;
            const errCount = p.activities.filter((a) => a.result?.isError).length;
            const statusParts: string[] = [];
            if (okCount > 0) statusParts.push(`${okCount} ✓`);
            if (errCount > 0) statusParts.push(`${errCount} ✗`);
            const status = statusParts.length ? ` · ${statusParts.join(", ")}` : "";
            lines.push(truncLine(`${ind}${theme.fg("muted", `${p.activities.length} tool${p.activities.length > 1 ? "s" : ""}: ${nameList}${status}`)}`, w));
          }

          // Surface errors even when output exists (agent may have emitted text before failing).
          if (r && "error" in r && r.error) {
            lines.push(truncLine(`${ind}${theme.fg("error", r.error)}`, w));
          }
          // Output: render markdown only in expanded mode.
          if (r && "output" in r && r.output?.trim() && r.output !== "(no output)" && options.expanded) {
            const cacheKey = `md_${i}_${options.expanded ? "exp" : "col"}_${w - ind.length}`;
            let mdLines: string[] | undefined = state[cacheKey] as string[] | undefined;
            if (!mdLines || state[`${cacheKey}_src`] !== r.output) {
              const md = new Markdown(r.output.trim(), 0, 0, getMarkdownTheme());
              mdLines = md.render(Math.max(20, w - ind.length));
              state[`${cacheKey}_src`] = r.output;
              state[cacheKey] = mdLines;
            }
            for (const line of mdLines) {
              lines.push(truncLine(ind + line, w));
            }
          }
          // Visual separator between tasks — only in expanded mode.
          if (options.expanded) lines.push("");
        }

        // Prevent terminal overflow — preserve blank lines for visual spacing
        const budgeted = applyLineBudget(lines, options.expanded ?? false);
        lines.length = 0;
        lines.push(...budgeted);
      }

      text.setText(lines.join("\n"));
      return text;
    },
  });

  // ── Session shutdown: abort all running async tickets ───────────────
  pi.on("session_shutdown", () => {
    for (const ticket of ticketRegistry.values()) {
      if (ticket.status === "running") {
        ticket.controller.abort();
        ticket.status = "cancelled";
        ticket.completedAt = Date.now();
      }
    }
    // Do NOT clear the entire registry here — only abort running tickets.
    // Cleared tickets are cleaned up by sweepTickets() TTL.
  });
}

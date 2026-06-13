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
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
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
  scope?: "project" | "global";
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
  /** Name for a persistent subagent session. First use creates it, subsequent calls reuse it. Each session handles one task at a time — duplicate sessionIds in the same call are rejected. */
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
  /** Live stdout/stderr preview from tool_execution_update events. */
  liveOutput?: string;
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

/** Single source of truth for an Agent's runtime configuration.
 *  Used by createAgent, rehydrateAgent, runAgent, and the pool. */
export interface AgentRunConfig {
  systemPrompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  tools: string[];
  cwd: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

export const DEFAULT_TOOLS = ["read", "write", "edit", "bash"];

/** Expand `"*"` in a tools list to all registered tool names. */
export function expandToolsStar(tools: string[]): string[] {
  if (!tools.includes("*")) return tools;
  const allNames = Object.keys(TOOL_FACTORIES);
  return [...new Set([...allNames, ...tools.filter((t) => t !== "*")])];
}

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

// ── Delegate Config ──────────────────────────────────────────────────────

/** Shape of ~/.pi/agent/delegate.json — persisted config for delegate extension. */
export interface DelegateConfig {
  agent: {
    /** Global default model for all agent types. */
    default: string | null;
    /** Per-agent-type model overrides. Keys are agent names or "default". */
    [agentType: string]: string | null | undefined;
  };
  /** Per-model and per-provider concurrency limits. */
  concurrency: {
    /** Default concurrency limit for unspecified models. */
    default: number;
    /** Per-provider limits (e.g. "llamacpp": 2). */
    providers?: Record<string, number>;
    /** Per-model limits keyed by "provider/modelId". */
    models?: Record<string, number>;
  };
  /** Hard ceiling on total concurrent agents across all models. */
  maxConcurrent?: number;
  /** Max concurrent async tickets. */
  maxAsyncTickets?: number;
}

/** Session-only model overrides. Not persisted — cleared on session_start. */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

const DELEGATE_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const DELEGATE_CONFIG_PATH = path.join(DELEGATE_CONFIG_DIR, "delegate.json");

const DEFAULT_DELEGATE_CONFIG: DelegateConfig = {
  agent: { default: null },
  concurrency: { default: MAX_CONCURRENCY },
  maxConcurrent: MAX_CONCURRENCY,
};

/** Module-level config singleton. Loaded lazily, mutated by setters. */
let __delegateConfig: DelegateConfig = {
  ...DEFAULT_DELEGATE_CONFIG,
  agent: { ...DEFAULT_DELEGATE_CONFIG.agent },
  concurrency: { ...DEFAULT_DELEGATE_CONFIG.concurrency },
};

/** Session-only overrides. Cleared on session_start. */
let sessionOverrides: SessionModelOverrides = { default: null };

export function resetSessionOverrides(): void {
  sessionOverrides = { default: null };
}

/** Read delegate config from disk. Returns defaults if file missing or corrupt. */
export function loadDelegateConfig(): DelegateConfig {
  try {
    const raw = fs.readFileSync(DELEGATE_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return structuredClone(DEFAULT_DELEGATE_CONFIG);
    // Merge with defaults so new fields are always present
    return {
      ...DEFAULT_DELEGATE_CONFIG,
      ...parsed,
      agent: { ...DEFAULT_DELEGATE_CONFIG.agent, ...(parsed.agent ?? {}) },
      concurrency: { ...DEFAULT_DELEGATE_CONFIG.concurrency, ...(parsed.concurrency ?? {}) },
    } as DelegateConfig;
  } catch {
    return structuredClone(DEFAULT_DELEGATE_CONFIG);
  }
}

/** Write delegate config to disk with atomic rename. */
export function saveDelegateConfigAtomic(config: DelegateConfig): void {
  const tmpPath = DELEGATE_CONFIG_PATH + ".tmp";
  try {
    fs.mkdirSync(DELEGATE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, DELEGATE_CONFIG_PATH);
  } catch (err) {
    console.error(`[delegate] Failed to save config: ${err}`);
  }
}

/** Initialize module config from disk. Called once at extension load. */
function initDelegateConfig(): void {
  __delegateConfig = loadDelegateConfig();
}

// Auto-init on module load
initDelegateConfig();

// ── Config Mutators ──────────────────────────────────────────────────────

/** Set or update a model override for an agent type (or "default" for global). */
export function setModelOverride(type: string, value: string | null): void {
  __delegateConfig.agent[type] = value;
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Set the global default model. */
export function setDefaultModel(value: string | null): void {
  __delegateConfig.agent.default = value;
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Clear a single per-type model override. */
export function clearModelOverride(type: string): void {
  delete __delegateConfig.agent[type];
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Clear all model overrides, preserving non-model config. */
export function clearAllModelOverrides(): void {
  __delegateConfig.agent = { default: null };
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Set the global concurrency default. */
export function setConcurrencyDefault(n: number): void {
  __delegateConfig.concurrency.default = Math.max(1, n);
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Set or update a per-provider concurrency limit. */
export function setConcurrencyProvider(key: string, n: number): void {
  const current = __delegateConfig.concurrency.providers ?? {};
  __delegateConfig.concurrency.providers = { ...current, [key]: Math.max(1, n) };
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Set or update a per-model concurrency limit. */
export function setConcurrencyModel(key: string, n: number): void {
  const current = __delegateConfig.concurrency.models ?? {};
  __delegateConfig.concurrency.models = { ...current, [key]: Math.max(1, n) };
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Remove a per-provider concurrency limit. */
export function removeConcurrencyProvider(key: string): void {
  if (__delegateConfig.concurrency.providers) {
    delete __delegateConfig.concurrency.providers[key];
    saveDelegateConfigAtomic(__delegateConfig);
  }
}

/** Remove a per-model concurrency limit. */
export function removeConcurrencyModel(key: string): void {
  if (__delegateConfig.concurrency.models) {
    delete __delegateConfig.concurrency.models[key];
    saveDelegateConfigAtomic(__delegateConfig);
  }
}

/** Reset all concurrency settings to defaults. */
export function resetConcurrency(): void {
  __delegateConfig.concurrency = { ...DEFAULT_DELEGATE_CONFIG.concurrency };
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Get the effective concurrency limit for a model key. */
export function getConcurrencyLimit(modelKey: string): number {
  // 1. Per-model
  const perModel = __delegateConfig.concurrency.models?.[modelKey];
  if (perModel != null) return perModel;
  // 2. Per-provider
  const provider = modelKey.split("/")[0];
  const perProvider = __delegateConfig.concurrency.providers?.[provider];
  if (perProvider != null) return perProvider;
  // 3. Default
  return __delegateConfig.concurrency.default;
}

/** Get the effective max async tickets limit. */
export function getMaxAsyncTickets(): number {
  return __delegateConfig.maxAsyncTickets ?? MAX_ASYNC_TICKETS;
}

/** Get the hard ceiling on total concurrent agents. */
export function getMaxConcurrent(): number {
  return __delegateConfig.maxConcurrent ?? MAX_CONCURRENCY;
}

/** Set the hard ceiling on total concurrent agents. */
export function setMaxConcurrent(n: number): void {
  __delegateConfig.maxConcurrent = Math.max(1, n);
  saveDelegateConfigAtomic(__delegateConfig);
}

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

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionLocks.get(sessionId);
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
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
  try {
    pooled.agent.abort();
  } catch {
    /* best effort */
  }
  agentPool.delete(sessionId);
  return true;
}

/** Evict idle agents that exceeded the TTL. */
export function sweepPool(): void {
  const now = Date.now();
  for (const [id, pooled] of agentPool) {
    // Skip sessions that are actively locked — closing them would abort the
    // in-flight prompt. The wider session lock in runResolvedTask covers
    // first-use, resume, and pool-hit runs, so any locked session has live work.
    if (sessionLocks.has(id)) continue;
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
    lines.push(
      `- **${id}** · ${pooled.promptCount} prompts · ${fmtTokens(pooled.totalTokens)} tokens · idle ${idle} · age ${age} · ${shortenPath(pooled.sessionFile)}`,
    );
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
    if (
      ticket.status === "running" &&
      now - ticket.created > ASYNC_MAX_RUNTIME_MS
    ) {
      ticket.controller.abort();
      ticket.status = "failed";
      ticket.error = "Exceeded maximum runtime";
      ticket.completedAt = now;
    }
    // TTL cleanup for completed/failed/cancelled
    if (
      ticket.status !== "running" &&
      ticket.completedAt &&
      now - ticket.completedAt > ASYNC_TICKET_TTL_MS
    ) {
      ticketRegistry.delete(id);
    }
  }
}

/** Check if any running async ticket holds a given sessionId. */
export function isSessionBusy(sessionId: string): string | null {
  for (const ticket of ticketRegistry.values()) {
    if (ticket.status !== "running") continue;
    if (ticket.resolved.some((t) => t.sessionId === sessionId)) {
      return ticket.id;
    }
  }
  return null;
}

/** Format a completed ticket for LLM consumption. Reuses sync result formatting. */
function formatCompletedTicket(
  ticket: AsyncTicket,
): AgentToolResult<DelegateDetails> {
  const parts: string[] = [];
  const succeeded = ticket.results.filter(
    (r) => r && !("error" in r && r.error),
  ).length;
  const elapsedTotal = ticket.completedAt
    ? ticket.completedAt - ticket.created
    : 0;
  parts.push(
    `${succeeded}/${ticket.results.length} tasks completed · ${fmtDuration(elapsedTotal)} wall time\n`,
  );

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
      if (r.sessionFile)
        failParts.push(`session: ${shortenPath(r.sessionFile)}`);
      parts.push(`[FAILED: ${failParts.join(" · ")}]`);
      if (r.sessionFile && fs.existsSync(r.sessionFile)) {
        const safePath = JSON.stringify(r.sessionFile);
        parts.push(
          `→ To retry: delegate({ tasks: [{ resumeFrom: ${safePath}, prompt: "continue" }] })`,
        );
      }
    } else {
      const meta = [
        `OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens`,
      ];
      if (r.sessionFile) meta.push(shortenPath(r.sessionFile));
      if (r.touchedFiles.length > 0) {
        const rel = r.touchedFiles
          .map((f) => path.relative(t.cwd, f))
          .filter((f) => f && !f.startsWith(".."));
        if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
      }
      parts.push(`[${meta.join(" · ")}]\n\n${r.output}`);
    }
  }

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    details: {
      tasks: ticket.tasks,
      results: [...ticket.results].map(
        (r) => r ?? { error: "PENDING — result not available" },
      ),
      progress: [...ticket.progress],
      parentModel: ticket.parentModelId,
    },
  };
}

/** Push results into parent session via sendMessage when background ticket completes. */
export function deliverTicketResults(
  pi: ExtensionAPI,
  ticket: AsyncTicket,
): void {
  if (!ticket.completedAt) return;

  const formatted = formatCompletedTicket(ticket);
  const text = formatted.content
    .filter(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n");

  pi.sendMessage(
    {
      customType: "async_delegate_result",
      content: text,
      display: true,
      details: {
        ...formatted.details,
        ticketId: ticket.id,
        status: ticket.status,
      },
    },
    {
      deliverAs: "steer",
      triggerTurn: true,
    },
  );
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
    const sm = (
      SessionManager as unknown as { open(p: string): SessionManager }
    ).open(sessionFile);
    const ctx = sm.buildSessionContext();
    if (!ctx.messages.length) return null;

    const agent = createAgent(config, modelRegistry, ctx.messages);

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
const _combiningRe =
  /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/u;

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
  if (
    !/\x1b\[[0-9;]*m/.test(text) &&
    !_wideCharRe.test(text) &&
    !_combiningRe.test(text)
  ) {
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
    if (
      !_wideCharRe.test(part) &&
      !_combiningRe.test(part) &&
      vis + part.length <= target
    ) {
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
  return [
    ...lines.slice(0, budget - 1),
    truncLine(`… ${hidden} lines hidden · Ctrl+O expands`, getTermWidth()),
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool registry needs generic param to avoid contravariance on execute()
export const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any>> = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
};

export const VALID_THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

// ── Frontmatter ───────────────────────────────────────────────────────────

export function parseFrontmatter(content: string): {
  data: Record<string, string>;
  body: string;
} {
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
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(content);
  if (!data.name || !data.description) return null;
  return {
    name: data.name,
    description: data.description,
    model: data.model,
    thinking: VALID_THINKING.has(data.thinking ?? "")
      ? (data.thinking as ThinkingLevel)
      : "off",
    tools: expandToolsStar(
      data.tools
        ? data.tools
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : DEFAULT_TOOLS,
    ),
    skills: data.skills
      ? data.skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    systemPrompt: body,
  };
}

export function discoverAgents(cwd: string): Map<string, AgentConfig> {
  const dirs: { dir: string; scope: "project" | "global" }[] = [];
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot)
    dirs.push({
      dir: path.join(projectRoot, ".pi", "agents"),
      scope: "project",
    });
  // Global user agents — same convention as skills, AGENTS.md, and pi-subagents
  dirs.push({
    dir: path.join(os.homedir(), ".pi", "agent", "agents"),
    scope: "global",
  });
  dirs.push({ dir: path.join(os.homedir(), ".agents"), scope: "global" }); // legacy

  const agents = new Map<string, AgentConfig>();
  for (const { dir, scope } of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name.endsWith(".md") || e.name.endsWith(".chain.md")) continue;
      const cfg = loadAgentFile(path.join(dir, e.name));
      if (cfg && !agents.has(cfg.name)) {
        cfg.scope = scope;
        agents.set(cfg.name, cfg);
      }
    }
  }
  return agents;
}

// ── Parent Context ────────────────────────────────────────────────────────

export function buildParentTranscript(
  entries: SessionEntry[],
  leafId: string | null,
): string | null {
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

export function extractTextContent(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("");
}

// ── File Tracking (git + activity) ────────────────────────────────────────

async function getGitChangedFiles(cwd: string): Promise<Set<string>> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["status", "--porcelain", "--untracked-files=all"],
        { cwd, timeout: 5000 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
    const files = new Set<string>();
    for (const line of result.split("\n")) {
      if (line.length < 4) continue;
      const rawPath = line.slice(3).trim();
      if (!rawPath) continue;
      const targetPath = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").at(-1)
        : rawPath;
      if (targetPath)
        files.add(path.resolve(cwd, targetPath.replace(/^"|"$/g, "")));
    }
    return files;
  } catch {
    return new Set();
  }
}

/** Extract file paths mutated by edit/write from the activity log. */
export function extractTouchedFromActivities(
  activities: ToolActivity[],
  cwd: string,
): string[] {
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
  const header =
    // @ts-expect-error — accessing private fileEntries to mutate header's parentSession
    (sm as { fileEntries: Array<{ type: string; parentSession?: string }> })
      .fileEntries[0];
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
  const parentFile = (
    parentSessionManager as
      | { getSessionFile?(): string | undefined }
      | undefined
  )?.getSessionFile?.();

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
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      /* skip */
    }
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
      } catch {
        /* skip */
      }
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

// ── Subagent Prompt Assembly ──────────────────────────────────────────────

const DEFAULT_SUBAGENT_SYSTEM_PROMPT = "You are a helpful coding assistant.";

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function appendPromptSections(systemPrompt: string, sections: string[]): string {
  let result = systemPrompt.trimEnd();
  for (const section of sections) {
    const body = section.trim();
    if (!body) continue;
    result = result ? `${result}\n\n${body}` : body;
  }
  return result || DEFAULT_SUBAGENT_SYSTEM_PROMPT;
}

function buildSubagentSystemPrompt(options: {
  taskSystemPrompt?: string;
  agentSystemPrompt?: string;
  pooledSystemPrompt?: string;
  skillBodies: string[];
  agentsMdFiles: string[];
}): string {
  // Pooled agents already have a frozen prompt baked into their Agent state.
  // Return it unchanged so repeated sessionId calls do not re-append skills or
  // AGENTS.md content in resolved task metadata.
  if (options.pooledSystemPrompt?.trim()) return options.pooledSystemPrompt;

  const base =
    firstNonBlank(options.taskSystemPrompt, options.agentSystemPrompt) ??
    DEFAULT_SUBAGENT_SYSTEM_PROMPT;
  const agentsMdContext = options.agentsMdFiles.length
    ? options.agentsMdFiles.join("\n\n")
    : undefined;

  return appendPromptSections(base, [
    ...options.skillBodies,
    agentsMdContext ?? "",
  ]);
}

// ── Model Resolution ──────────────────────────────────────────────────────

/**
 * Resolve a model string spec against the registry.
 * Returns undefined if the spec can't be found.
 */
export function resolveModel(
  spec: string | undefined,
  registry: ModelRegistry,
  parentModel: Model<Api> | undefined,
): Model<Api> | undefined {
  if (!spec) return parentModel;
  const idx = spec.indexOf("/");
  if (idx === -1) {
    // Bare id — match against available models
    const match = registry.getAvailable().find((m) => m.id === spec);
    return match ?? undefined;
  }
  return registry.find(spec.slice(0, idx), spec.slice(idx + 1)) ?? undefined;
}

/** Find an available model with the same id as the given model, preferring
 *  a different provider if the original has no configured auth. */
export function findAvailableAlternative(
  model: Model<Api> | undefined,
  registry: ModelRegistry,
): Model<Api> | undefined {
  if (!model) return undefined;
  if (registry.hasConfiguredAuth(model)) return model;
  // Look for another model with the same id that DOES have auth.
  // Prefer a different provider (avoid returning the same broken model).
  return registry.getAvailable().find(
    (m) => m.id === model.id && m.provider !== model.provider,
  );
}

/**
 * Resolve the model spec string using the precedence chain.
 * Returns the first non-null, non-empty string value.
 *
 * Precedence (highest to lowest):
 *   1. taskModel        — per-task explicit override (from API call)
 *   2. sessionOverrides[agentType]  — session per-type
 *   3. sessionOverrides["default"]  — session global
 *   4. config.agent[agentType]      — config per-type
 *   5. config.agent["default"]     — config global
 *   6. frontmatterModel            — agent .md frontmatter
 *   7. parentModelId               — inherit from parent (final fallback)
 */
export function resolveModelSpec(options: {
  taskModel?: string;
  agentType: string;
  frontmatterModel?: string;
  parentModelId?: string;
  config?: DelegateConfig;
  overrides?: SessionModelOverrides;
}): string | undefined {
  const {
    taskModel,
    agentType,
    frontmatterModel,
    parentModelId,
    config = __delegateConfig,
    overrides = sessionOverrides,
  } = options;

  const candidates: Array<string | null | undefined> = [
    taskModel,
    overrides[agentType],
    overrides["default"],
    config.agent[agentType] as string | null | undefined,
    config.agent["default"],
    frontmatterModel,
    parentModelId,
  ];

  return candidates.find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

// ── Settings Overrides ────────────────────────────────────────────────────

interface DelegateSettings {
  agentOverrides?: Record<
    string,
    { model?: string; thinking?: string; tools?: string[]; skills?: string[] }
  >;
}

export function readDelegateSettingsFile(
  filePath: string,
): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getDelegateSettings(filePath: string): DelegateSettings | null {
  const settings = readDelegateSettingsFile(filePath);
  if (
    !settings?.delegate ||
    typeof settings.delegate !== "object" ||
    Array.isArray(settings.delegate)
  )
    return null;
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
    if (fs.existsSync(path.join(dir, ".pi"))) {
      projectPath = path.join(dir, ".pi", "settings.json");
      break;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const user = getDelegateSettings(userPath);
  const project = projectPath ? getDelegateSettings(projectPath) : null;

  if (!user && !project) {
    delegateSettingsCache.set(key, null);
    return null;
  }
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
  const delay = Math.min(
    baseDelay + jitter + stagger,
    isRateLimit ? 300_000 : 60_000,
  );
  return { baseDelay, jitter, stagger, delay };
}

/**
 * Custom error for abort signals — avoids brittle string-matching on
 * error messages when distinguishing between expected aborts and real failures.
 */
class AbortError extends Error {
  override name = "AbortError";
  constructor() {
    super("Aborted");
  }
}

/** Sleep for ms, aborting early if signal fires. */
async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError());
      };
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
      const i = next++;
      if (i >= items.length) return;
      // Deliberately do NOT check signal?.aborted here — the caller
      // (runResolvedTask) handles abort at entry and returns a proper
      // TaskResult. Early-returning here would leave results[i] as
      // undefined, causing a crash in the sync result-dereference path.
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/** Extract a model key string for concurrency grouping. Falls back to "_no_model" for actions without a model. */
function getModelKey(model: Model<Api> | undefined): string {
  // provider/id — e.g. "openrouter/deepseek/deepseek-v4-pro"
  return model ? `${model.provider}/${model.id}` : "_no_model";
}

/**
 * Like mapConcurrent but with per-model concurrency limits.
 * Groups items by model key, runs each group with its own limit.
 * All groups run in parallel (Promise.all across groups).
 */
async function mapConcurrentByModel<T, R>(
  items: T[],
  getModelKey: (item: T, index: number) => string,
  getConcurrency: (modelKey: string) => number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
  maxTotal?: number,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);

  // Group items by model key, preserving original indices
  const groups = new Map<string, { indices: number[]; limit: number }>();
  for (let i = 0; i < items.length; i++) {
    const key = getModelKey(items[i]!, i);
    let group = groups.get(key);
    if (!group) {
      group = { indices: [], limit: getConcurrency(key) };
      groups.set(key, group);
    }
    group.indices.push(i);
  }

  // Global semaphore — caps total concurrent tasks across all model groups
  let totalRunning = 0;
  const totalWaiters: Array<() => void> = [];
  const acquireTotal = async () => {
    if (!maxTotal || totalRunning < maxTotal) { totalRunning++; return; }
    await new Promise<void>((r) => totalWaiters.push(r));
  };
  const releaseTotal = () => {
    totalRunning--;
    if (totalWaiters.length > 0) { totalRunning++; totalWaiters.shift()!(); }
  };

  // Run all groups in parallel, each with its own concurrency limit + global cap
  await Promise.all(
    [...groups.entries()].map(([, group]) => {
      const groupItems = group.indices.map((i) => items[i]!);
      return mapConcurrent(
        groupItems,
        group.limit,
        async (_item, localIdx) => {
          await acquireTotal();
          try {
            const globalIdx = group.indices[localIdx]!;
            results[globalIdx] = await fn(_item, globalIdx);
            return results[globalIdx];
          } finally {
            releaseTotal();
          }
        },
        signal,
      );
    }),
  );
  return results;
}

/** Run a single prompt on an Agent instance. Shared by both fresh and pooled paths. */
export async function runAgentOnce(
  agent: Agent,
  prompt: string,
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  },
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
  onProgress?: (update: AgentProgressUpdate) => void,
  sessionManager?: SessionManagerLike,
  gitBaseline?: Set<string>,
  start?: number,
  suppressSessionAppend = false,
): Promise<{
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
  touchedFiles: string[];
}> {
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
    onProgress({
      tokens: delta,
      toolUses,
      durationMs: Date.now() - startTime,
      lastActivityAt,
      activities: [...activities],
    });
  };

  const unsubscribe = agent.subscribe((event) => {
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
      fireProgress();
    } else if (event.type === "tool_execution_update") {
      lastActivityAt = Date.now();
      const activity = pendingById.get(event.toolCallId);
      if (activity) {
        const text = extractTextFromPartialResult(event.partialResult);
        if (text !== undefined) activity.liveOutput = text;
        fireProgress();
      }
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
      fireProgress();
    } else if (event.type === "message_end") {
      lastActivityAt = Date.now();
      fireProgress();
    }
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      try {
        agent.abort();
      } catch {
        /* */
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    // Snapshot state before prompt for delta-based persistence and token counting.
    const messagesBefore = agent.state.messages.length;
    const usageBefore = extractUsage(agent.state.messages);
    usageBeforeTotal = usageBefore.total;

    await agent.prompt(prompt);
    await agent.waitForIdle();

    const state = agent.state as {
      messages: AgentMessage[];
      errorMessage?: string;
    };
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
          if (
            msg.role === "user" ||
            msg.role === "assistant" ||
            msg.role === "toolResult" ||
            msg.role === "custom"
          ) {
            sessionManager.appendMessage(msg);
          }
        }
      } catch {
        /* best effort */
      }
    }

    // Compute touched files: union of activity-based (edit/write) and git diff.
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const gitAfter = await getGitChangedFiles(config.cwd);
    const fromGit = [...gitAfter].filter((f) => !baseline.has(f));
    const touchedFiles = [...new Set([...fromActivities, ...fromGit])];

    return {
      output: output || "(no output)",
      error: errorMessage,
      durationMs: Date.now() - startTime,
      tokens: tokensThisCall,
      touchedFiles,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: "",
      error: msg,
      durationMs: Date.now() - startTime,
      tokens: 0,
      touchedFiles: [],
    };
  } finally {
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
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
): Promise<{
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
  touchedFiles: string[];
}> {
  const start = Date.now();

  // Snapshot git status before the agent starts so we can diff after.
  const gitBaseline = await getGitChangedFiles(config.cwd);

  // Pool hits: single attempt, no retry loop (stateful agent with accumulated context).
  // Resumed agents (allowRetry=true) fall through to the retry loop.
  if (existingAgent && !allowRetry) {
    return runAgentOnce(
      existingAgent,
      prompt,
      config,
      modelRegistry,
      signal,
      onProgress,
      sessionManager,
      gitBaseline,
      start,
    );
  }

  // Create agent once — reuse across retries to preserve prior work (tool results, reasoning).
  // Fresh agents start empty; resumed/pooled agents start with loaded state.
  let agent: Agent;
  if (existingAgent) {
    agent = existingAgent;
  } else {
    agent = createAgent(config, modelRegistry);
  }

  // Snapshot messages before any attempts — used to restore clean state on retry.
  // The Agent's messages setter is a public API that copies the array, so this
  // avoids poking at internals (unlike the old .length mutation approach).
  const messagesSnapshot = [...agent.state.messages];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return {
        output: "",
        error: "Aborted",
        durationMs: Date.now() - start,
        tokens: 0,
        touchedFiles: [],
      };
    }

    // Signal retry to the progress UI.
    if (attempt > 0 && onProgress)
      onProgress({
        tokens: 0,
        toolUses: 0,
        durationMs: Date.now() - start,
        activities: [],
      });

    // On retry, restore messages to pre-attempt state using the public setter.
    if (attempt > 0) {
      agent.state.messages = messagesSnapshot;
    }

    const messagesBeforeAttempt = agent.state.messages.length;
    const result = await runAgentOnce(
      agent,
      prompt,
      config,
      modelRegistry,
      signal,
      onProgress,
      sessionManager,
      gitBaseline,
      start,
      true,
    );
    if (
      result.error &&
      attempt < maxRetries &&
      isRetryableError(result.error)
    ) {
      const isRateLimit = isRateLimitError(result.error);
      const { delay } = computeRetryDelay(
        attempt,
        retryBaseMs,
        taskIndex,
        isRateLimit,
      );

      try {
        await sleepWithAbort(delay, signal);
      } catch (sleepErr) {
        if (!(sleepErr instanceof AbortError)) throw sleepErr;
      }
      continue;
    }

    // Flush pending messages only on success. Failed attempts (even the final
    // exhausted retry) should not pollute the session file.
    if (sessionManager && !result.error) {
      try {
        for (
          let mi = messagesBeforeAttempt;
          mi < agent.state.messages.length;
          mi++
        ) {
          const msg = agent.state.messages[mi]!;
          if (
            msg.role === "user" ||
            msg.role === "assistant" ||
            msg.role === "toolResult" ||
            msg.role === "custom"
          ) {
            sessionManager.appendMessage(msg);
          }
        }
      } catch {
        /* best effort */
      }
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

// ── Task Lifecycle (unified sync/async) ────────────────────────────────

/** Construct a fresh Agent with the standard streamFn. */
function createAgent(
  config: AgentRunConfig,
  modelRegistry: ModelRegistry,
  messages?: AgentMessage[],
): Agent {
  const tools = config.tools
    .map((name) => TOOL_FACTORIES[name]?.(config.cwd))
    .filter(Boolean) as AgentTool[];
  return new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model: config.model,
      thinkingLevel: config.thinking,
      tools,
      ...(messages ? { messages } : {}),
    },
    convertToLlm,
    streamFn: async (m, context, options) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(m);
      if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
      return streamSimple(m, context, {
        ...options,
        apiKey: auth.apiKey,
        headers: auth.headers ?? undefined,
      });
    },
  });
}

/** Build a failed TaskResult. Used for early-failure paths (abort, busy, validation). */
function failTask(
  task: ResolvedTask,
  error: string,
  sessionFile?: string,
): TaskResult {
  return {
    agent: task.agentName,
    output: "",
    error,
    durationMs: 0,
    tokens: 0,
    sessionFile,
    touchedFiles: [],
  };
}

/** Build a successful TaskResult for session-management actions (close/list).
 *  Pass elapsedMs to record wall time since delegate started (matches the live progress UI). */
function completeSessionAction(
  task: ResolvedTask,
  output: string,
  elapsedMs?: number,
): TaskResult {
  return {
    agent: task.agentName,
    output,
    durationMs: elapsedMs ?? 0,
    tokens: 0,
    sessionFile: undefined,
    touchedFiles: [],
  };
}

/** Mirror a progress update from runAgent into a TaskProgress row. */
function updateProgressFromRun(
  p: TaskProgress,
  u: AgentProgressUpdate,
): void {
  p.tokens = u.tokens;
  p.toolUses = u.toolUses;
  p.durationMs = u.durationMs;
  p.lastActivityAt = u.lastActivityAt;
  p.activities = u.activities;
}

/** Mirror a completed TaskResult into a TaskProgress row (status/duration/error). */
function updateProgressFromResult(p: TaskProgress, r: TaskResult): void {
  p.status = r.error ? "failed" : "done";
  p.durationMs = r.durationMs;
  p.tokens = r.tokens;
  p.error = r.error;
}

/** Apply a TaskResult to progress and notify the env (sync fires onUpdate).
 *  Used at every return point in runResolvedTask — mirrors the old fire() pattern
 *  that the duplicated sync/async bodies used after every early-return. */
function finishTask(
  env: TaskRunEnv,
  p: TaskProgress,
  r: TaskResult,
): TaskResult {
  updateProgressFromResult(p, r);
  env.onStatusChange?.();
  return r;
}

/** Environment passed to runResolvedTask. Encapsulates the sync/async split. */
interface TaskRunEnv {
  /** Abort signal — parent's for sync, ticket's for async. May be undefined when no parent signal is available. */
  signal: AbortSignal | undefined;
  modelRegistry: ModelRegistry;
  /** Parent session manager — used to link subagent sessions for /resume. */
  parentSessionManager: { getSessionFile?(): string | undefined } | undefined;
  /** Ticket id for busy-guard self-checks. undefined for sync. */
  ticketId?: string;
  /** When the delegate started. Used for close/list progress (elapsed time). */
  delegateStartedAt: number;
  /** Called for every progress update from runAgent. */
  onProgress: (p: TaskProgress, u: AgentProgressUpdate) => void;
  /** Called after every TaskProgress mutation (early-returns, completion). Sync uses this to fire onUpdate. */
  onStatusChange?: () => void;
}

interface AcquiredSession {
  agent: Agent;
  sessionManager: SessionManagerLike | undefined;
  sessionFile: string | undefined;
  /** True if agent came from the pool (stateful multi-turn — skip retry). */
  isPoolHit: boolean;
  /** True if this is a fresh agent that should be inserted into the pool after a successful run. */
  shouldPoolAfter: boolean;
  /** True if we synchronously inserted the agent into the pool (race protection).
   *  If the run fails, we may need to remove the empty entry to let a retry try fresh. */
  syncInserted: boolean;
}

/** Resolve the agent + session for a task. Single source of truth for pool, resume, and miss logic. */
async function acquireAgentSession(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
): Promise<AcquiredSession | { error: TaskResult }> {
  let agent: Agent | undefined;
  let sessionManager: SessionManagerLike | undefined;
  let sessionFile: string | undefined;
  let isPoolHit = false;
  let shouldPoolAfter = false;
  let syncInserted = false;

  if (task.sessionId) {
    const pooled = agentPool.get(task.sessionId);
    if (pooled) {
      // Pool hit — validate frozen config matches the new task's request.
      const frozen = pooled.config;
      const mismatches: string[] = [];
      if (frozen.cwd !== task.cwd)
        mismatches.push(`cwd: '${frozen.cwd}' vs '${task.cwd}'`);
      if (frozen.thinking !== task.thinking)
        mismatches.push(`thinking: '${frozen.thinking}' vs '${task.thinking}'`);
      const frozenToolSet = [...frozen.tools].sort().join(",");
      const newToolSet = [...task.tools].sort().join(",");
      if (frozenToolSet !== newToolSet)
        mismatches.push(`tools: [${frozenToolSet}] vs [${newToolSet}]`);
      if (mismatches.length) {
        return {
          error: failTask(
            task,
            `Session '${task.sessionId}' config mismatch. Close and recreate: ${mismatches.join("; ")}`,
          ),
        };
      }
      agent = pooled.agent;
      sessionManager = pooled.sessionManager;
      sessionFile = pooled.sessionFile;
      pooled.lastUsed = Date.now();
      p.model = frozen.model.id;
      isPoolHit = true;
    } else {
      // Pool miss.
      if (task.resumeFrom) {
        // Defer to the resume block below — creating a session here would orphan an empty .jsonl.
        shouldPoolAfter = true;
      } else {
        const session = createSubagentSessionManager(
          env.parentSessionManager,
          task.cwd,
        );
        sessionManager = session?.manager;
        sessionFile = session?.file;

        if (sessionFile) {
          const rehydrated = rehydrateAgent(
            sessionFile,
            {
              systemPrompt: task.systemPrompt,
              model: task.model,
              thinking: task.thinking,
              tools: task.tools,
              cwd: task.cwd,
            },
            env.modelRegistry,
          );
          if (rehydrated) {
            agent = rehydrated.agent;
            sessionManager = rehydrated.sessionManager;
          }
        }
        if (!agent) {
          agent = createAgent(
            {
              systemPrompt: task.systemPrompt,
              model: task.model,
              thinking: task.thinking,
              tools: task.tools,
              cwd: task.cwd,
            },
            env.modelRegistry,
          );
        }

        // Synchronous pool insertion — close the race window where a concurrent
        // task with the same sessionId (across tickets) could also pass the busy
        // guard and create a second agent. By claiming the sessionId now, a
        // second task's isSessionBusy() will see this one and fail.
        // The drift fix is preserved: isPoolHit stays false, so the run still
        // retries on transient errors. If the run fails, commitPoolCleanup
        // removes the empty entry so a retry starts fresh.
        if (task.sessionId && sessionManager && sessionFile) {
          agentPool.set(task.sessionId, {
            agent: agent!,
            sessionManager,
            sessionFile,
            config: {
              systemPrompt: task.systemPrompt,
              model: task.model,
              thinking: task.thinking,
              tools: task.tools,
              cwd: task.cwd,
            },
            lastUsed: Date.now(),
            createdAt: Date.now(),
            totalTokens: 0,
            promptCount: 0,
          });
          syncInserted = true;
        } else {
          shouldPoolAfter = true;
        }
      }
    }
  }

  // Resume from a previous session file.
  if (task.resumeFrom) {
    if (isPoolHit) {
      return {
        error: failTask(
          task,
          `resumeFrom conflicts with active sessionId '${task.sessionId}'. The pooled agent has its own accumulated context. Close the session first if you want to resume from a different point.`,
          sessionFile,
        ),
      };
    }
    const resolvedPath = resolveCwd(task.resumeFrom);
    if (!fs.existsSync(resolvedPath)) {
      return {
        error: failTask(
          task,
          `resumeFrom: file not found: ${resolvedPath}`,
          resolvedPath,
        ),
      };
    }
    const rehydrated = rehydrateAgent(
      resolvedPath,
      {
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.tools,
        cwd: task.cwd,
      },
      env.modelRegistry,
    );
    if (!rehydrated) {
      return {
        error: failTask(
          task,
          `resumeFrom: empty or corrupt session: ${resolvedPath}`,
          resolvedPath,
        ),
      };
    }
    agent = rehydrated.agent;
    sessionManager = rehydrated.sessionManager;
    sessionFile = resolvedPath;

    // Link resumed session to parent for /resume discoverability.
    const parentFile = (
      env.parentSessionManager as
        | { getSessionFile?(): string | undefined }
        | undefined
    )?.getSessionFile?.();
    if (parentFile) {
      setParentSession(
        rehydrated.sessionManager as unknown as SessionManager,
        parentFile,
      );
    }
  }

  // Fresh task (no sessionId, no resumeFrom) — create session + agent.
  if (!agent) {
    const fresh = createSubagentSessionManager(env.parentSessionManager, task.cwd);
    sessionManager = fresh?.manager;
    sessionFile = fresh?.file;
    agent = createAgent(
      {
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.tools,
        cwd: task.cwd,
      },
      env.modelRegistry,
    );
  }

  // At this point sessionManager/sessionFile are set for all paths except
  // pool-miss-with-resumeFrom (which defers session creation). The agent
  // is guaranteed to exist. Label new sessions.
  if (sessionManager && !isPoolHit && !task.resumeFrom) {
    const label = `⎇ delegate · ${task.agentName}`;
    sessionManager.appendSessionInfo(label);
  }

  if (!agent) {
    // Defensive: acquireAgentSession should always produce an agent for run tasks.
    return { error: failTask(task, "Internal: no agent acquired") };
  }

  return {
    agent,
    sessionManager,
    sessionFile,
    isPoolHit,
    shouldPoolAfter,
    syncInserted,
  };
}

/** Insert a freshly-run agent into the pool. Called after a successful run for a new pooled session. */
function commitPoolInsert(
  sessionId: string,
  task: ResolvedTask,
  acquired: AcquiredSession,
  result: { tokens: number },
): void {
  if (!acquired.sessionManager || !acquired.sessionFile) return;
  agentPool.set(sessionId, {
    agent: acquired.agent,
    sessionManager: acquired.sessionManager,
    sessionFile: acquired.sessionFile,
    config: {
      systemPrompt: task.systemPrompt,
      model: task.model,
      thinking: task.thinking,
      tools: task.tools,
      cwd: task.cwd,
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    totalTokens: result.tokens,
    promptCount: 1,
  });
}

/** Update pool stats for a subsequent prompt on an existing pooled session. */
function commitPoolStats(
  sessionId: string,
  result: { tokens: number },
): void {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return;
  pooled.lastUsed = Date.now();
  pooled.totalTokens += result.tokens;
  pooled.promptCount++;
}

/** Remove a synchronously-inserted empty agent from the pool if it's still ours.
 *  Called after a failed run for a fresh pooled session — we claimed the sessionId
 *  to close the race window, but the run failed, so the empty entry is dead weight.
 *  If another task already claimed the slot (pool entry is now a different agent),
 *  leave it alone. */
export function commitPoolCleanup(sessionId: string, acquiredAgent: Agent): void {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return;
  if (pooled.agent !== acquiredAgent) return; // Another task already claimed/replaced it.
  agentPool.delete(sessionId);
}

/** Run a single resolved task. Single source of truth for the per-task lifecycle.
 *  Used by both sync (params.async === false) and async (params.async === true) paths.
 *  When task.sessionId is set, the entire acquire/run/close lifecycle runs under
 *  a per-session mutex so concurrent tasks with the same sessionId serialize
 *  cleanly. The lock also covers action='close' and the early-busy/abort paths. */
async function runResolvedTask(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  taskIndex: number,
): Promise<TaskResult> {
  if (task.sessionId) {
    return withSessionLock(task.sessionId, () =>
      runResolvedTaskUnlocked(env, task, p, taskIndex),
    );
  }
  return runResolvedTaskUnlocked(env, task, p, taskIndex);
}

async function runResolvedTaskUnlocked(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  taskIndex: number,
): Promise<TaskResult> {
  try {
    // ── Aborted before we started? ───────────────────────────────────
    if (env.signal?.aborted) {
      return finishTask(env, p, failTask(task, "Aborted"));
    }

    // ── Session busy guard (defense-in-depth) ────────────────────────
    // Primary validation is in execute() before ticket creation.
    // This catches edge cases where validation missed a conflict.
    if (task.sessionId) {
      const busyTicketId = isSessionBusy(task.sessionId);
      if (busyTicketId && busyTicketId !== env.ticketId) {
        const msg = `Session '${task.sessionId}' is already in use by ticket ${busyTicketId}. Each session can only handle one task at a time.`;
        return finishTask(env, p, failTask(task, msg));
      }
    }

    p.status = "running";
    p.model = task.model?.id;

    // ── Session action handling ───────────────────────────────────────
    if (task.action === "close") {
      if (!task.sessionId) {
        return finishTask(env, p, failTask(task, "action='close' requires sessionId."));
      }
      const closed = closePooledAgent(task.sessionId);
      return finishTask(
        env,
        p,
        completeSessionAction(
          task,
          closed
            ? `Session '${task.sessionId}' closed.`
            : `Session '${task.sessionId}' not found.`,
          Date.now() - env.delegateStartedAt,
        ),
      );
    }

    if (task.action === "list") {
      return finishTask(
        env,
        p,
        completeSessionAction(
          task,
          `Active sessions:\n${listPooledAgents().join("\n")}`,
          Date.now() - env.delegateStartedAt,
        ),
      );
    }

    // ── Pool / resume / fresh-agent resolution ────────────────────────
    const acquired = await acquireAgentSession(env, task, p);
    if ("error" in acquired) {
      return finishTask(env, p, acquired.error);
    }

    // ── Run the agent ─────────────────────────────────────────────────
    const doRun = async (): Promise<TaskResult> => {
      const config: AgentRunConfig = {
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.tools,
        cwd: task.cwd,
      };
      try {
        const r = await runAgent(
          config,
          task.prompt,
          env.modelRegistry,
          env.signal,
          (u) => env.onProgress(p, u),
          acquired.sessionManager,
          undefined, // maxRetries
          2000, // retryBaseMs
          acquired.agent,
          // allowRetry: pooled agents carry accumulated state — retrying is unsafe.
          // Fresh agents and resumed sessions are safe to retry.
          !acquired.isPoolHit,
          taskIndex,
        );

        // Pool bookkeeping.
        if (task.sessionId) {
          if (r.error && acquired.syncInserted) {
            // Failed first run with a synchronously-claimed sessionId: clean up
            // the empty entry so a retry can try fresh.
            commitPoolCleanup(task.sessionId, acquired.agent);
          } else if (!r.error) {
            if (acquired.shouldPoolAfter) {
              commitPoolInsert(task.sessionId, task, acquired, r);
            } else {
              // Pool hit OR sync-inserted: agent is already in pool, just bump stats.
              commitPoolStats(task.sessionId, r);
            }
          }
        }

        return {
          agent: task.agentName,
          output: r.output,
          error: r.error,
          durationMs: r.durationMs,
          tokens: r.tokens,
          sessionFile: acquired.sessionFile,
          touchedFiles: r.touchedFiles,
        };
      } catch (err) {
        // Abnormal error (e.g., runAgent threw rather than returning r.error).
        // Clean up the sync-inserted entry if it's still ours, then re-throw
        // for the outer catch to convert to a TaskResult.
        if (acquired.syncInserted && task.sessionId) {
          commitPoolCleanup(task.sessionId, acquired.agent);
        }
        throw err;
      }
    };

    // The session lock is now taken at the top of runResolvedTask (covers the
    // full acquire/run/close lifecycle), so doRun executes serially per sessionId
    // without needing an inner lock here.
    const result = await doRun();
    return finishTask(env, p, result);
  } catch (err) {
    // If we synchronously claimed a sessionId before the error, clean it up.
    return finishTask(
      env,
      p,
      failTask(task, err instanceof Error ? err.message : String(err)),
    );
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────

/** Resolve a cwd string: expand ~ and make absolute. */
export function resolveCwd(cwd: string): string {
  const expanded = cwd.startsWith("~")
    ? path.join(os.homedir(), cwd.slice(1))
    : cwd;
  return path.resolve(expanded);
}

/** Extract text content from a partial tool result (tool_execution_update). */
function extractTextFromPartialResult(
  partialResult: unknown,
): string | undefined {
  if (
    !partialResult ||
    typeof partialResult !== "object" ||
    !("content" in partialResult)
  )
    return undefined;
  const content = (partialResult as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (c): c is { type: string; text?: string } =>
        c && typeof c === "object" && "type" in c && c.type === "text",
    )
    .map((c) => c.text)
    .filter((t): t is string => typeof t === "string")
    .join("\n");
  return text || undefined;
}

/** Strip ANSI escape sequences from text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Resolve carriage-return progress bars to their final line state. */
function resolveCarriageReturn(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
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
  return n < 1000
    ? `${n}`
    : n < 10000
      ? `${(n / 1000).toFixed(1)}k`
      : `${Math.round(n / 1000)}k`;
}

export function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export const tree = (i: number, n: number) => (i === n - 1 ? "└─" : "├─");
export const indent = (i: number, n: number) => (i === n - 1 ? "   " : "│  ");

// ── Tool Activity Formatting ─────────────────────────────────────────────

/** Pick the first non-empty arg value for display, preferring the named key then common fallbacks. */
function firstArg(
  args: Record<string, unknown>,
  primary: string,
  fallbacks: string[] = [],
): string | undefined {
  for (const key of [primary, ...fallbacks]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val;
  }
  return undefined;
}

function formatToolCallShort(
  name: string,
  args: Record<string, unknown>,
): string {
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
      for (const key of [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "task",
        "prompt",
      ]) {
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

export function handlePoll(
  params: { ticket?: string },
  ctx: ExtensionContext,
): AgentToolResult<DelegateDetails> {
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
        details: {
          tasks: [],
          results: [],
          progress: [],
          parentModel: parentModelId,
        },
      };
    }
    const lines = tickets.map((t) => {
      const icon =
        t.status === "running" ? "⏳" : t.status === "done" ? "✓" : "✗";
      const done = t.progress.filter((p) => p.status === "done").length;
      const age = fmtDuration(Date.now() - t.created);
      return `${icon} ${t.id} · ${done}/${t.progress.length} tasks · ${t.status} · ${age}`;
    });
    return {
      content: [{ type: "text", text: `Async tickets:\n${lines.join("\n")}` }],
      details: {
        tasks: [],
        results: [],
        progress: [],
        parentModel: parentModelId,
      },
    };
  }

  // Specific ticket
  const ticket = ticketRegistry.get(ticketId);
  if (!ticket) {
    return {
      content: [
        {
          type: "text",
          text: `Ticket '${ticketId}' not found. It may have expired or never existed.`,
        },
      ],
      details: {
        tasks: [],
        results: [],
        progress: [],
        parentModel: parentModelId,
      },
    };
  }

  if (ticket.status === "running") {
    const doneCount = ticket.progress.filter(
      (p) => p.status === "done" || p.status === "failed",
    ).length;
    const totalCount = ticket.progress.length;
    const lines: string[] = [];
    // Index-aligned sparse array — same shape as ticket.results, so consumers
    // can correlate results[i] with progress[i] and tasks[i].
    const completedResults: (TaskResult | undefined)[] = new Array(
      ticket.progress.length,
    ).fill(undefined);

    for (let i = 0; i < ticket.progress.length; i++) {
      const p = ticket.progress[i]!;
      const r = ticket.results[i];

      if (p.status === "done" && r) {
        const meta = [
          fmtDuration(r.durationMs),
          `${fmtTokens(r.tokens)} tokens`,
        ];
        if (r.touchedFiles.length > 0) {
          const t = ticket.resolved[i]!;
          const rel = r.touchedFiles
            .map((f) => path.relative(t.cwd, f))
            .filter((f) => f && !f.startsWith(".."));
          if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
        }
        lines.push(`✓ ${r.agent} · ${meta.join(" · ")}`);
        if (r.output && r.output !== "(no output)") {
          lines.push(r.output);
        }
        completedResults[i] = r;
      } else if (p.status === "failed" && r) {
        lines.push(`✗ ${r.agent} · ${r.error ?? "unknown error"}`);
        if (r.sessionFile)
          lines.push(`  session: ${shortenPath(r.sessionFile)}`);
        if (r.output) lines.push(r.output);
        completedResults[i] = r;
      } else if (p.status === "running") {
        const activity = p.activities.findLast((a) => !a.result);
        const currentTool = activity
          ? ` · ${formatToolCallShort(activity.name, activity.args)}`
          : "";
        lines.push(
          `⏳ ${p.agent}${currentTool} · ${fmtDuration(Date.now() - ticket.created)}`,
        );
      } else {
        lines.push(`○ ${p.agent} · waiting…`);
      }
    }

    const header = `Ticket ${ticket.id}: RUNNING · ${doneCount}/${totalCount} done (${fmtDuration(Date.now() - ticket.created)})`;
    const guidance =
      doneCount === totalCount
        ? ""
        : doneCount > 0
          ? "Tasks are progressing. Do other work while remaining tasks finish — results will be delivered automatically when all complete."
          : "Tasks are still running. Do other work while you wait — polling again immediately will not speed them up. Results are delivered automatically when all tasks complete.";

    return {
      content: [
        {
          type: "text",
          text: `${header}\n${lines.join("\n")}${guidance ? `\n\n${guidance}` : ""}`,
        },
      ],
      details: {
        tasks: ticket.tasks,
        results: completedResults.map(
          (r) => r ?? { error: "PENDING — result not available" },
        ),
        progress: [...ticket.progress],
        parentModel: ticket.parentModelId,
      },
    };
  }

  // Done / Failed / Cancelled — full results
  return formatCompletedTicket(ticket);
}

export function handleCancel(params: {
  ticket?: string;
}): AgentToolResult<DelegateDetails> {
  sweepTickets();
  const ticketId = params.ticket;

  if (!ticketId) {
    return {
      content: [
        { type: "text", text: "action='cancel' requires a ticket ID." },
      ],
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
      content: [
        {
          type: "text",
          text: `Ticket '${ticketId}' is already ${ticket.status}.`,
        },
      ],
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

// ── Extracted schema constant ───────────────────────────────────────────
// Avoids inline `this` context issues and lets TypeScript infer params safely.
const delegateParameters = Type.Object({
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
        skills: Type.Optional(Type.Array(Type.String())),
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

function getSubagentManualMarkdown(agents: Map<string, AgentConfig>): string {
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
                : "";
          return `- **${n}**${model}${thinking}${tools}${scope}: ${a.description}`;
        })
        .join("\n")
    : "_(none defined)_";

  return [
    "# Delegate Tool Manual",
    "",
    "Delegate subagents to execute tasks in parallel. Each subagent gets an independent context, system prompt, model, tools, skills, and thinking level.",
    "",
    "## Available Agents",
    "",
    agentList,
    "",
    "Agents live in `.pi/agents/*.md` (project-local) and `~/.pi/agent/agents/` (global). Each agent file is Markdown with YAML-ish frontmatter:",
    "",
    "```markdown",
    "---",
    "name: my-agent",
    "description: What it does",
    "model: anthropic/claude-haiku-4-5  # optional",
    "thinking: low                     # off/minimal/low/medium/high/xhigh",
    "tools: read, bash                 # default: all 4 core tools. Use * for all.",
    "skills: web-content               # comma-separated skill names",
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
    '{ "prompt": "Investigate the auth module", "agent": "scout", "sessionId": "auth-research" }',
    "",
    "// Second call — continues the same agent",
    '{ "prompt": "Now check the tests for that module", "sessionId": "auth-research" }',
    "",
    "// Clean up when done",
    '{ "prompt": "", "sessionId": "auth-research", "action": "close" }',
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
    "Max 5 concurrent async tickets. Results are delivered automatically when all tasks finish. Poll for progress while running, but avoid polling in a tight loop \u2014 do other work while waiting.",
  ].join("\n");
}

export default function delegateExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate to Subagents",
    description: ".",
    parameters: delegateParameters,

    async execute(_id, params: DelegateParams, signal, onUpdate, ctx) {
      const parentModelId = ctx.model?.id;
      const tasks = params.tasks ?? [];

      // ── Poll action ───────────────────────────────────────────────────
      // Top-level action is the public API. Per-task action is accepted for
      // backward compatibility with early async builds.
      if (params.action === "poll" || tasks.some((t) => t.action === "poll")) {
        return handlePoll(params, ctx);
      }

      // ── Cancel action ─────────────────────────────────────────────────
      // Top-level action is the public API. Per-task action is accepted for
      // backward compatibility with early async builds.
      if (
        params.action === "cancel" ||
        tasks.some((t) => t.action === "cancel")
      ) {
        return handleCancel(params);
      }

      const agents = discoverAgents(ctx.cwd);

      // ── Help mode ─────────────────────────────────────────────────
      if (!tasks.length) {
        return {
          content: [{ type: "text", text: getSubagentManualMarkdown(agents) }],
          details: {
            tasks: [],
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      // ── Validate ──────────────────────────────────────────────────
      // Disallow same sessionId across multiple parallel tasks (one agent can't serve two prompts concurrently).
      const sessionIds = tasks.map((t) => t.sessionId).filter(Boolean) as string[];
      const duplicateSessions = sessionIds.filter(
        (id, i) => sessionIds.indexOf(id) !== i,
      );
      if (duplicateSessions.length) {
        return {
          content: [
            {
              type: "text",
              text: `Duplicate sessionId(s) across tasks: ${[...new Set(duplicateSessions)].join(", ")}. Each session can only handle one task at a time.`,
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      // Disallow sessionIds already claimed by a running async ticket.
      const busyConflicts: string[] = [];
      for (const sid of sessionIds) {
        const owner = isSessionBusy(sid);
        if (owner) busyConflicts.push(`${sid} (ticket ${owner})`);
      }
      if (busyConflicts.length) {
        return {
          content: [
            {
              type: "text",
              text: `Session(s) already in use: ${busyConflicts.join(", ")}. Each session can only handle one task at a time.`,
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      const unknown: string[] = [];
      for (const t of tasks) {
        if (t.agent && !agents.has(t.agent)) unknown.push(t.agent);
      }
      if (unknown.length) {
        const names = [...agents.keys()];
        return {
          content: [
            {
              type: "text",
              text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}. Call delegate with an empty tasks array for help.`,
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      // ── Resolve tasks ─────────────────────────────────────────────
      // Build parent transcript lazily — only computed once if any task uses with-parent-transcript
      let parentTranscript: string | null = null;
      const needsParentContext = tasks.some(
        (t) => t.context === "with-parent-transcript",
      );
      if (needsParentContext) {
        if (!ctx.sessionManager) {
          throw new Error(
            "context: 'with-parent-transcript' requires a persisted parent session.",
          );
        }
        parentTranscript = buildParentTranscript(
          ctx.sessionManager.getEntries(),
          ctx.sessionManager.getLeafId(),
        );
      }

      const resolved = tasks.map((t, i) => {
        const agent = t.agent ? agents.get(t.agent) : undefined;
        const cwd = resolveCwd(t.cwd ?? ctx.cwd);

        // Load settings-based overrides for this agent
        const settings = loadDelegateSettings(cwd);
        const agentOverride =
          t.agent && settings?.agentOverrides?.[t.agent]
            ? settings.agentOverrides[t.agent]
            : undefined;

        // Build system prompt without inheriting the parent's full effective
        // prompt. The parent prompt contains the parent tool catalogue,
        // promptGuidelines, and project context; subagents get their own lean
        // base prompt plus explicit skills/AGENTS.md injection below.
        const pooledConfig = t.sessionId
          ? agentPool.get(t.sessionId)?.config
          : undefined;
        const usingPooledPrompt = Boolean(pooledConfig?.systemPrompt.trim());

        // Prompt is required for fresh tasks. ResumeFrom provides context already.
        if (
          t.action !== "close" &&
          t.action !== "list" &&
          !t.resumeFrom &&
          !t.prompt?.trim()
        ) {
          throw new Error(
            `Task ${i}: prompt is required unless action is 'close'/'list' or resumeFrom is set.`,
          );
        }

        // Inject skills
        const skillNames =
          t.skills ?? agentOverride?.skills ?? agent?.skills ?? [];
        const skillBodies: string[] = [];
        if (!usingPooledPrompt) {
          for (const name of skillNames) {
            const content = loadSkill(name, cwd);
            if (content) skillBodies.push(content);
          }
        }

        // Inject AGENTS.md context files (global + cwd ancestors)
        const agentsMdFiles = usingPooledPrompt ? [] : loadAgentsMdFiles(cwd);
        const systemPrompt = buildSubagentSystemPrompt({
          taskSystemPrompt: t.systemPrompt,
          agentSystemPrompt: agent?.systemPrompt,
          pooledSystemPrompt: pooledConfig?.systemPrompt,
          skillBodies,
          agentsMdFiles,
        });

        // Build prompt — wrap with parent context if using with-parent-transcript
        let prompt =
          t.prompt ||
          (t.resumeFrom
            ? "Continue from where you left off. Pick up the task and keep going."
            : t.prompt);
        const parentCtx =
          t.context === "with-parent-transcript" && parentTranscript
            ? parentTranscript
            : null;
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
            // Use precedence chain: task > session > config > frontmatter > parent
            const agentType = t.agent ?? "inline";
            const modelSpec = resolveModelSpec({
              taskModel: t.model ?? agentOverride?.model,
              agentType,
              frontmatterModel: agent?.model,
              parentModelId: ctx.model?.id,
            });
            const resolvedModel = resolveModel(
              modelSpec ?? pooledConfig?.model?.id,
              ctx.modelRegistry,
              ctx.model,
            );

            // If the task or settings explicitly set a model but it couldn't resolve, fail loudly
            const explicitRequest = t.model ?? agentOverride?.model;
            if (explicitRequest && !resolvedModel) {
              throw new Error(
                `Task ${i}: requested model '${explicitRequest}' is not available. Check provider config or remove the model field to use the parent model.`,
              );
            }

            model = resolvedModel ?? findAvailableAlternative(ctx.model, ctx.modelRegistry) ?? ctx.model;
          }

          if (!model) {
            throw new Error(
              `Task ${i}: no model available — parent session has no model set.`,
            );
          }

          // Resolve tools — warn about unknown tool names.
          // For active pooled sessions, fall back to the frozen pooled config so
          // "continue with only sessionId" works without re-supplying tools.
          // Explicit overrides that don't match get rejected by acquireAgentSession.
          const isPoolHit = t.sessionId ? agentPool.has(t.sessionId) : false;
          tools = expandToolsStar(
            t.tools ??
              agentOverride?.tools ??
              agent?.tools ??
              (isPoolHit ? pooledConfig?.tools : undefined) ??
              DEFAULT_TOOLS,
          );
          const unknownTools = tools.filter(
            (name) => !(name in TOOL_FACTORIES),
          );
          if (unknownTools.length) {
            warnings.push(
              `Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`,
            );
          }

          // Resolve thinking — for active pooled sessions, default from the
          // frozen pooled config (same reasoning as tools above).
          const thinkingRaw =
            t.thinking ??
            agentOverride?.thinking ??
            agent?.thinking ??
            (isPoolHit ? pooledConfig?.thinking : undefined) ??
            "off";
          thinking = VALID_THINKING.has(thinkingRaw)
            ? (thinkingRaw as ThinkingLevel)
            : "off";
        }
        return {
          ...t,
          cwd,
          systemPrompt,
          model: model!,
          tools,
          thinking,
          prompt,
          agentName: agent?.name ?? "inline",
          warnings,
        };
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
      const fire = () =>
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Running ${resolved.length} subagent${resolved.length > 1 ? "s" : ""}…`,
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [...progress],
            parentModel: parentModelId,
          },
        });
      fire();

      // ── Async mode ───────────────────────────────────────────────────
      if (params.async) {
        sweepTickets();
        const runningCount = [...ticketRegistry.values()].filter(
          (t) => t.status === "running",
        ).length;
        if (runningCount >= getMaxAsyncTickets()) {
          return {
            content: [
              {
                type: "text",
                text: `Too many async tickets running (${runningCount}/${getMaxAsyncTickets()}). Poll existing tickets or cancel one first.`,
              },
            ],
            details: {
              tasks,
              results: [],
              progress: [],
              parentModel: parentModelId,
            },
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

        const asyncEnv: TaskRunEnv = {
          signal: ticketSignal,
          modelRegistry,
          parentSessionManager: ctx.sessionManager,
          ticketId,
          delegateStartedAt: ticket.created,
          onProgress: (p, u) => {
            updateProgressFromRun(p, u);
          },
        };

        // Fire and forget — runs on the event loop.
        // Worker must store the TaskResult back into ticket.results, since
        // formatCompletedTicket/handlePoll read from there. Without the write,
        // completed async tasks would be reported as PENDING.
        mapConcurrentByModel(
          resolved,
          (t) => getModelKey(t.model),
          getConcurrencyLimit,
          async (t, i) => {
            const result = await runResolvedTask(
              asyncEnv,
              t,
              ticket.progress[i]!,
              i,
            );
            ticket.results[i] = result;
            return result;
          },
          ticketSignal,
          getMaxConcurrent(),
        )
          .then(() => {
            // All tasks settled — determine final ticket status.
            // Use progress (set by runResolvedTask) for settled-ness so the
            // status reflects work completion, not just result-array density.
            const anyFailed = ticket.results.some(
              (r) => r && "error" in r && r.error,
            );
            const allSettled = ticket.progress.every(
              (p) => p.status === "done" || p.status === "failed",
            );
            if (ticket.status === "running") {
              if (allSettled && anyFailed) ticket.status = "failed";
              else if (allSettled) ticket.status = "done";
              else ticket.status = "done"; // partial — report what we have
              ticket.completedAt = Date.now();
            }
            deliverTicketResults(pi, ticket);
          })
          .catch((err) => {
            // Defense-in-depth — should not happen if individual tasks catch properly
            ticket.status = "failed";
            ticket.error = err instanceof Error ? err.message : String(err);
            ticket.completedAt = Date.now();
            deliverTicketResults(pi, ticket);
          });

        return {
          content: [
            {
              type: "text",
              text: [
                `Async ticket: ${ticketId}`,
                `${resolved.length} task(s) dispatched · ${runningCount + 1}/${getMaxAsyncTickets()} async slots in use`,
                "",
                "Completed task results are available via poll. Final results delivered automatically when all tasks complete.",
                `Check progress: delegate({ action: "poll", ticket: "${ticketId}" }) — avoid polling in a tight loop`,
                `Cancel if needed: delegate({ action: "cancel", ticket: "${ticketId}" })`,
              ].join("\n"),
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [...progress],
            parentModel: parentModelId,
            ticketId,
          },
        };
      }

      // ── Sync mode ─────────────────────────────────────────────────
      // Sweep stale pooled agents before dispatching.
      sweepPool();

      const syncEnv: TaskRunEnv = {
        signal,
        modelRegistry: ctx.modelRegistry,
        parentSessionManager: ctx.sessionManager,
        ticketId: undefined,
        delegateStartedAt: startedAt,
        onProgress: (p, u) => {
          updateProgressFromRun(p, u);
          fire();
        },
        onStatusChange: () => fire(),
      };

      const results = await mapConcurrentByModel(
        resolved,
        (t) => getModelKey(t.model),
        getConcurrencyLimit,
        async (t, i) => runResolvedTask(syncEnv, t, progress[i]!, i),
        signal,
        getMaxConcurrent(),
      );

      // ── Format for LLM ────────────────────────────────────────────
      const finalResults = results;
      const elapsedTotal = Date.now() - startedAt;

      const parts: string[] = [];
      const succeeded = finalResults.filter((r) => !r.error).length;
      parts.push(
        `${succeeded}/${finalResults.length} tasks completed successfully · ${fmtDuration(elapsedTotal)} wall time\n`,
      );
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i]!;
        const t = resolved[i]!;
        parts.push(
          `=== ${r.agent}: ${trunc(t.prompt || t.action || "", 80)} ===`,
        );
        if (t.warnings?.length) {
          for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
        }
        if (r.error) {
          const failParts = [r.error];
          if (r.sessionFile)
            failParts.push(`session: ${shortenPath(r.sessionFile)}`);
          parts.push(`[FAILED: ${failParts.join(" · ")}]`);
          if (r.sessionFile && fs.existsSync(r.sessionFile)) {
            const safePath = JSON.stringify(r.sessionFile);
            parts.push(
              `→ To retry: delegate({ tasks: [{ resumeFrom: ${safePath}, prompt: "continue" }] })`,
            );
          }
        } else {
          const meta = [
            `OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens`,
          ];
          if (r.sessionFile) meta.push(shortenPath(r.sessionFile));
          if (r.touchedFiles.length > 0) {
            const rel = r.touchedFiles
              .map((f) => path.relative(t.cwd, f))
              .filter((f) => f && !f.startsWith(".."));
            if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
          }
          parts.push(`[${meta.join(" · ")}]\n\n${r.output}`);
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: {
          tasks,
          results: finalResults,
          progress,
          parentModel: parentModelId,
        },
      };
    },

    renderCall(args, theme, ctx) {
      const state = ctx.state as {
        startedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };
      const tasks = (args as { tasks?: TaskDef[] }).tasks ?? [];
      const text =
        (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
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
        text.setText(
          theme.fg(
            "toolTitle",
            theme.bold(
              `${spinnerFrame()} delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""} · ${elapsed}`,
            ),
          ),
        );
        return text;
      }
      text.setText(
        theme.fg(
          "toolTitle",
          theme.bold(
            `delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""}`,
          ),
        ),
      );
      return text;
    },

    renderResult(result, options, theme, ctx) {
      const state = ctx.state as Record<string, unknown> & {
        startedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };
      // Use a faster animation cadence for spinner (80ms) vs the old 1s
      const tickMs = 80;
      if (options.isPartial && !state.interval)
        state.interval = setInterval(() => ctx.invalidate(), tickMs);
      if (!options.isPartial && state.interval) {
        clearInterval(state.interval);
        state.interval = undefined;
      }
      const text =
        (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      const details = result.details as DelegateDetails | undefined;
      if (!details?.progress?.length) {
        const content =
          (result.content as Array<{ type: string; text: string }>)
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

      const statJoin = (parts: string[]) =>
        parts.length ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "";
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
        const done = progress.filter(
          (p) => p.status === "done" || p.status === "failed",
        ).length;
        const running = progress.filter((p) => p.status === "running").length;
        const elapsed = state.startedAt
          ? ` · ${fmtDuration(Date.now() - state.startedAt)}`
          : "";

        // Richer header: agent counts + wall time
        const headerParts: string[] = [];
        if (running > 0) headerParts.push(`${running} running`);
        headerParts.push(`${done}/${total} done`);
        lines.push(
          theme.fg("muted", `${headerParts.join(" · ")}${elapsed}`),
          "",
        );

        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const ind = indent(i, total);
          const runParts: string[] = [];
          if (p.toolUses > 0)
            runParts.push(`${p.toolUses} tool${p.toolUses > 1 ? "s" : ""}`);
          if (p.tokens > 0) runParts.push(`${fmtTokens(p.tokens)} tokens`);

          switch (p.status) {
            case "done":
              lines.push(
                truncLine(
                  `${tree(i, total)} ${theme.fg("success", "✓")} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`,
                  w,
                ),
              );
              if (options.expanded) {
                for (const activity of p.activities.slice(-3)) {
                  const call = formatToolCallShort(
                    activity.name,
                    activity.args,
                  );
                  const icon = activity.result?.isError
                    ? theme.fg("error", "✗")
                    : theme.fg("success", "✓");
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`,
                      w,
                    ),
                  );
                }
              }
              break;
            case "failed":
              lines.push(
                truncLine(
                  `${tree(i, total)} ${theme.fg("error", "✗")} ${theme.bold(p.agent)}${modelLabel(p)}${p.error ? theme.fg("error", ` ${p.error}`) : ""}`,
                  w,
                ),
              );
              if (options.expanded) {
                for (const activity of p.activities.slice(-3)) {
                  const call = formatToolCallShort(
                    activity.name,
                    activity.args,
                  );
                  const icon = activity.result?.isError
                    ? theme.fg("error", "✗")
                    : theme.fg("success", "✓");
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`,
                      w,
                    ),
                  );
                }
              }
              break;
            case "running":
              {
                const activityAge = getActivityAge(p.lastActivityAt);
                const ageTag = activityAge ? ` · ${activityAge}` : "";
                const glyph = theme.fg("warning", spinnerFrame());
                lines.push(
                  truncLine(
                    `${tree(i, total)} ${glyph} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin(runParts)}${theme.fg("muted", ageTag)}`,
                    w,
                  ),
                );

                if (options.expanded) {
                  // ── Expanded: recent activity history (like done/failed) ──
                  if (p.activities.length > 0) {
                    for (const activity of p.activities.slice(-5)) {
                      const call = formatToolCallShort(
                        activity.name,
                        activity.args,
                      );
                      if (!activity.result) {
                        // In-flight
                        const elapsed = ` | ${fmtDuration(Date.now() - activity.startTime)}`;
                        lines.push(
                          truncLine(
                            `${ind}${theme.fg("warning", `> ${call}${elapsed}`)}`,
                            w,
                          ),
                        );
                        // Show live stdout/stderr preview for streaming tools
                        if (activity.liveOutput) {
                          const clean = stripAnsi(
                            resolveCarriageReturn(activity.liveOutput),
                          );
                          const preview = clean
                            .split("\n")
                            .filter((l) => l.trim())
                            .slice(-3);
                          for (const outLine of preview) {
                            lines.push(
                              truncLine(
                                `${ind}  ${theme.fg("toolOutput", outLine)}`,
                                w,
                              ),
                            );
                          }
                        }
                      } else {
                        const icon = activity.result.isError
                          ? theme.fg("error", "✗")
                          : theme.fg("success", "✓");
                        lines.push(
                          truncLine(
                            `${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`,
                            w,
                          ),
                        );
                      }
                    }
                  } else {
                    lines.push(
                      truncLine(
                        `${ind}${theme.fg("muted", "  thinking…")}`,
                        w,
                      ),
                    );
                  }
                } else {
                  // ── Collapsed: compact tool line with duration ─────
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `⎿  ${compactActivity(p)}`)}`,
                      w,
                    ),
                  );
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("accent", "Press Ctrl+O for live detail")}`,
                      w,
                    ),
                  );
                }
              }
              break;
            default:
              // Pending / waiting
              lines.push(
                truncLine(
                  `${tree(i, total)} ${theme.fg("muted", "○")} ${theme.bold(p.agent)}${modelLabel(p)} ${theme.fg("muted", "waiting…")}`,
                  w,
                ),
              );
          }
        }
        const budgeted = applyLineBudget(
          lines.filter(Boolean),
          options.expanded ?? false,
        );
        lines.length = 0;
        lines.push(...budgeted);
      } else {
        // ── Final result ─────────────────────────────────────────────
        const succeeded = progress.filter((p) => p.status === "done").length;
        const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);
        const elapsed = state.startedAt
          ? fmtDuration(Date.now() - state.startedAt)
          : fmtDuration(progress.reduce((sum, p) => sum + p.durationMs, 0));
        lines.push(
          theme.fg(
            "muted",
            `${succeeded}/${total} completed · ${elapsed} wall · ${fmtTokens(totalTokens)} tokens`,
          ),
          "",
        );

        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const r = taskResults[i];
          const ind = indent(i, total);
          const icon =
            p.status === "done"
              ? theme.fg("success", "✓")
              : theme.fg("error", "✗");
          const taskPreview = theme.fg("muted", trunc(p.task, w - 30));
          lines.push(
            truncLine(
              `${tree(i, total)} ${icon} ${theme.bold(p.agent)}${modelLabel(p)} ${taskPreview}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`,
              w,
            ),
          );

          // Tool activities: compact summary only in expanded mode.
          if (p.activities.length > 0 && options.expanded) {
            const names = p.activities
              .map((a) => a.name)
              .filter((n, i, arr) => arr.indexOf(n) === i);
            const nameList =
              names.slice(0, 4).join(", ") +
              (names.length > 4 ? ` +${names.length - 4}` : "");
            const okCount = p.activities.filter(
              (a) => a.result && !a.result.isError,
            ).length;
            const errCount = p.activities.filter(
              (a) => a.result?.isError,
            ).length;
            const statusParts: string[] = [];
            if (okCount > 0) statusParts.push(`${okCount} ✓`);
            if (errCount > 0) statusParts.push(`${errCount} ✗`);
            const status = statusParts.length
              ? ` · ${statusParts.join(", ")}`
              : "";
            lines.push(
              truncLine(
                `${ind}${theme.fg("muted", `${p.activities.length} tool${p.activities.length > 1 ? "s" : ""}: ${nameList}${status}`)}`,
                w,
              ),
            );
          }

          // Surface errors even when output exists (agent may have emitted text before failing).
          if (r && "error" in r && r.error) {
            lines.push(truncLine(`${ind}${theme.fg("error", r.error)}`, w));
          }
          // Output: render markdown only in expanded mode.
          if (
            r &&
            "output" in r &&
            r.output?.trim() &&
            r.output !== "(no output)" &&
            options.expanded
          ) {
            const cacheKey = `md_${i}_${options.expanded ? "exp" : "col"}_${w - ind.length}`;
            let mdLines: string[] | undefined = state[cacheKey] as
              | string[]
              | undefined;
            if (!mdLines || state[`${cacheKey}_src`] !== r.output) {
              const md = new Markdown(
                r.output.trim(),
                0,
                0,
                getMarkdownTheme(),
              );
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

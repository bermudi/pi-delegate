import type {
  Agent,
  AgentMessage,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

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

export interface AgentProgressUpdate {
  tokens: number;
  toolUses: number;
  durationMs: number;
  lastActivityAt?: number;
  activities: ToolActivity[];
}

export interface SessionManagerLike {
  sessionFile?: string;
  getSessionFile?(): string | undefined;
  appendMessage?(msg: AgentMessage): void;
  appendSessionInfo?(label: string): void;
  getEntries?(): unknown[];
}

export interface TaskRunEnv {
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

export interface AcquiredSession {
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

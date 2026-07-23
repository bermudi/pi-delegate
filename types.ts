import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AgentSession,
  ModelRegistry,
  SessionManager,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import type { delegateParameters } from "./schema.ts";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinking: ThinkingLevel;
  tools: string[];
  systemPrompt: string;
  /** Origin of the profile. `claude` denotes imported .claude/agents files. */
  scope?: "project" | "global" | "claude";
}

// ── Tool parameter types — derived from the TypeBox schema ────────────────
// `delegateParameters` in schema.ts is the single source of truth; these are
// projections of it, so schema and types cannot drift. Field semantics live
// in the schema's `description`s (which the calling model also sees).
// The import is type-only, so the schema.ts ↔ types.ts cycle is erased at
// compile time.

export type DelegateParams = Static<typeof delegateParameters>;
export type TaskDef = NonNullable<DelegateParams["tasks"]>[number];
/** Top-level async ticket action: "poll" | "cancel". */
export type DelegateAction = NonNullable<DelegateParams["action"]>;
/** Per-task session action: "prompt" | "close" | "list" | "poll" | "cancel". */
export type SessionAction = NonNullable<TaskDef["action"]>;

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
  /** Human-facing notices (e.g. unknown tools ignored). Surfaced in the TUI
   *  under the task; the LLM gets the same text in `content` already. */
  warnings?: string[];
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

/** Single source of truth for a subagent's runtime configuration.
 *  Passed to `createAgentSession` as `model` / `thinkingLevel` / `tools` / `cwd`. */
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
  /** Called for every progress update from runAgentSession. */
  onProgress: (p: TaskProgress, u: AgentProgressUpdate) => void;
  /** Called after every TaskProgress mutation (early-returns, completion). Sync uses this to fire onUpdate. */
  onStatusChange?: () => void;
}

/** Structural subset of Pi's `ExtensionContext` used by delegate's
 *  task-resolution and dispatch modules. Kept loose so the orchestrator can
 *  pass the real ctx through without re-typing every Pi field. The
 *  `sessionManager` mirrors Pi's `ReadonlySessionManager` (not re-exported
 *  from the package index) — only the members delegate actually touches are
 *  listed. */
export interface DelegateToolCtx {
  cwd: string;
  model: Model<Api> | undefined;
  modelRegistry: ModelRegistry;
  sessionManager:
    | {
        getEntries(): SessionEntry[];
        getLeafId(): string | null;
        getSessionFile?(): string | undefined;
      }
    | undefined;
  /** Optional hook Pi exposes for extensions to read the live system prompt. */
  getSystemPrompt?: () => string | undefined;
}

/** Shape returned by the delegate tool's `execute`. Mirrors Pi's
 *  `AgentToolResult<DelegateDetails>` without depending on the generic. */
export interface DelegateToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: DelegateDetails;
}

export interface AcquiredSession {
  /** The live AgentSession — constructed once and reused across prompts (pool hits). */
  session: AgentSession;
  sessionManager: SessionManager | undefined;
  sessionFile: string | undefined;
}

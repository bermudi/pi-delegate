import type {
  ThinkingLevel,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ModelRegistry,
  SessionManager,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import type { delegateArgumentsSchema } from "./schema.ts";
import type { CallRecord } from "./telemetry.ts";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  /** Markdown agents default invalid/omitted values to "off". Built-ins omit
   *  this field so they can inherit the parent's thinking level. */
  thinking?: ThinkingLevel;
  tools: string[];
  systemPrompt: string;
  /** Built-in profiles can be overridden by a same-named Markdown file. */
  builtin?: boolean;
  /** Default workspace for a built-in profile. Custom agents use shared. */
  workspace?: WorkspaceMode;
  /** Origin of the profile. `claude` denotes imported .claude/agents files. */
  scope?: "project" | "global" | "claude";
  /** Whether `tools` was explicitly set in the Markdown frontmatter (vs inherited default). */
  explicitTools?: boolean;
  /** Whether `model` was explicitly set in the Markdown frontmatter. */
  explicitModel?: boolean;
  /** Whether `thinking` was explicitly set in the Markdown frontmatter. */
  explicitThinking?: boolean;
  /** Denylist applied to a built-in `default` override with no explicit allowlist – materialized against parentNativeTools at resolution. */
  deniedTools?: string[];
}

// ── Tool parameter types — derived from the TypeBox schema ────────────────
// `delegateArgumentsSchema` in schema.ts is the canonical provider-visible
// shape; these types are its `Static<>` projections. The import is type-only,
// so the schema.ts ↔ types.ts cycle is erased at compile time.

type CanonicalDelegateArguments = Static<typeof delegateArgumentsSchema>;
type CanonicalTaskDef = NonNullable<
  CanonicalDelegateArguments["tasks"]
>[number];

/** Top-level async ticket action: "poll" | "cancel" | "wait". */
export type TicketAction = NonNullable<
  CanonicalDelegateArguments["ticketAction"]
>;
/** Per-task session action: "prompt" | "close" | "list". */
export type SessionAction = NonNullable<CanonicalTaskDef["sessionAction"]>;
/** Filesystem mode: shared source tree or an ephemeral CoW scratch copy. */
export type WorkspaceMode = NonNullable<CanonicalTaskDef["workspace"]>;

export type TaskDef = CanonicalTaskDef;

export type DelegateArguments = CanonicalDelegateArguments;

// ── Async Ticket Types ─────────────────────────────────────────────────────

export interface TicketWaiter {
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<DelegateDetails>;
  resolve: (result: AgentToolResult<DelegateDetails>) => void;
  reject: (reason: unknown) => void;
  clearDeadline?: () => void;
  settled: boolean;
}

export interface AsyncTicket {
  id: string;
  created: number;
  completedAt?: number;
  tasks: TaskDef[];
  resolved: ResolvedTask[];
  status: "running" | "cancelling" | "done" | "failed" | "cancelled";
  results: (TaskResult | undefined)[];
  progress: TaskProgress[];
  controller: AbortController;
  error?: string;
  parentModelId?: string;
  /** Session-tree leaf active when the ticket was spawned (see leaf.ts).
   *  `undefined` = the leaf the session opened on. Compared at delivery time
   *  so results are not used to wake the agent on a foreign branch. */
  spawnLeafId?: string | null;
  /** Active blocking waiters. Resolved by terminal delivery or timeout/abort. */
  waiters?: TicketWaiter[];
  /** Telemetry call span id attached to this async ticket. */
  callId?: string;
  /** Telemetry call span start timestamp for accurate wall-time on cancellation. */
  callStartedAt?: number;
  /** Snapshot of the call row at spawn, used to write the cancelled/settled row. */
  callRecord?: CallRecord;
  /** Runtime generation for rejecting shutdown writes from stale tickets. */
  telemetryGeneration?: number;
  /** Telemetry config captured at dispatch; binds shutdown aggregate rows to the
   *  same backend the call span wrote to. */
  telemetryConfig?: import("./config.ts").TelemetryConfig;
  /** Resolves after every async worker has settled, including shutdown aborts. */
  completion?: Promise<void>;
  /** False from admission until every worker has quiesced. Unlike `status`,
   * this remains false during shutdown's early terminal transition. */
  workersSettled?: boolean;
  /** Batch-level warning attached to this dispatch, not to any one task. */
  dispatchWarning?: string;
  /** Immutable dispatch-scoped delegate.json snapshot used by async workers and
   *  later result formatting. */
  config?: import("./config.ts").DelegateConfig;
}

/** Live parent settings captured when a delegate call starts. The built-in
 *  `default` profile mirrors these settings, limited to tools delegate can
 *  safely recreate without loading the parent's extensions. */
export interface ParentAgentDefaults {
  thinking: ThinkingLevel;
  tools: string[];
}

export interface ReuseIntent {
  /** Explicit model requested by this call/profile; omitted means use frozen. */
  model?: Model<Api>;
  /** Explicit base prompt requested by this call/profile; omitted means frozen. */
  systemPrompt?: string;
}

export interface ResolvedTask {
  id?: string;
  prompt: string;
  agent?: string;
  model: Model<Api>;
  tools: string[];
  thinking: ThinkingLevel;
  systemPrompt: string;
  cwd: string;
  workspace?: WorkspaceMode;
  context?: "fresh" | "with-parent-transcript";
  sessionId?: string;
  sessionAction?: SessionAction;
  resumeFrom?: string;
  /** Hard wall-clock budget in milliseconds, measured from task start. */
  deadlineMs?: number;
  agentName: string;
  warnings: string[];
  /** Explicit settings that must match a live pooled session on reuse. */
  reuseIntent?: ReuseIntent;
  /** Stable signature of the provider-scoped extension allowlist for this task's
   *  model provider. Pool reuse compares this to the frozen session value so a
   *  revoked or reconfigured extension cannot continue executing in a reused
   *  session. */
  providerExtensionSources?: string;
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

/** Stable machine-readable reason for a task failure.
 *  - `stalled`: inactivity watchdog fired; the prompt was cooperatively aborted.
 *  - `model_error`: the failure is attributable to the resolved model/provider
 *    (account usage limit, quota exhausted, auth lost) — not transient for that
 *    model, so same-model retry is pointless. The parent should resume with a
 *    different `model` (see `resumeFrom` + `model`).
 *  - `deadline_exceeded`: the task's `deadlineMs` wall-clock budget expired
 *    (measured from when the task left the concurrency queue). The prompt was
 *    cooperatively aborted; completed side effects are not rolled back. */
export type TaskFailureKind = "stalled" | "model_error" | "deadline_exceeded";

export interface TaskProgress {
  id?: string;
  index: number;
  agent: string;
  task: string;
  status: "pending" | "running" | "done" | "failed";
  durationMs: number;
  tokens: number;
  toolUses: number;
  error?: string;
  failureKind?: TaskFailureKind;
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
  /** Terminal/live ticket status when this result comes from an async ticket. */
  status?: AsyncTicket["status"];
  /** Global overlap warning derived from result.attributedFiles, surfaced in both
   *  the textual content and the custom TUI. */
  overlapWarning?: string;
  /** Warning that applies to the whole dispatch rather than an individual task. */
  dispatchWarning?: string;
}

export interface TaskResult {
  id?: string;
  agent: string;
  output: string;
  error?: string;
  /** Stable machine-readable failure reason; error remains human-facing. */
  failureKind?: TaskFailureKind;
  durationMs: number;
  /** Display token count for the task, derived from the compaction-inclusive
   *  session-stat delta. This matches `usage.totalTokens`; the usage object
   *  additionally preserves the provider breakdown and cost. */
  tokens: number;
  /** Full provider Usage consumed by this task, including compacted-away
   *  history. Always present (`emptyUsage()` on no-op/early-failure paths) so a
   *  sync delegate call can fold subagent spend into the parent's session
   *  total. Aggregate `cost.total` is accurate; the per-component cost fields
   *  stay 0 because `getSessionStats()` exposes only the aggregate cost — and
   *  Pi sums `cost.total` for nested usage anyway. */
  usage: Usage;
  /** Scratch results are excluded from shared-file conflict detection and never resumable. */
  workspace?: WorkspaceMode;
  sessionFile?: string;
  /** All files the subagent is known to have touched, including bash mutations
   *  captured via git diff and other tasks' concurrent git changes. This is a
   *  best-effort, repository-wide list for display, not for attribution. */
  touchedFiles: string[];
  /** Files directly attributable to this task's edit/write tool calls. Used
   *  for overlap detection so concurrent tasks in the same repo do not
   *  fabricate false conflicts from shared git snapshots. */
  attributedFiles?: string[];
  /** Git-native proposal/reconciliation outcome for workspace:"isolated". */
  integration?: TaskIntegration;
}

export type TaskIntegrationStatus =
  | "applied_unverified"
  | "no_changes"
  | "conflict"
  | "discarded"
  | "apply_failed";

export interface TaskIntegration {
  status: TaskIntegrationStatus;
  proposedFiles: string[];
  appliedFiles: string[];
  conflicts?: Array<{ path: string; reason: string }>;
  baselineRef?: string;
  proposalRef?: string;
  patchPath?: string;
  worktreePath?: string;
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
  /** Set as soon as a terminal condition is detected, before cleanup settles. */
  failureKind?: TaskFailureKind;
}

export interface TaskRunEnv {
  /** Abort signal — parent's for sync, ticket's for async. May be undefined when no parent signal is available. */
  signal: AbortSignal | undefined;
  modelRegistry: ModelRegistry;
  /** Ticket id for busy-guard self-checks. undefined for sync. */
  ticketId?: string;
  /** When the delegate started. Used for close/list progress (elapsed time). */
  delegateStartedAt: number;
  /** Called for every progress update from runAgentSession. */
  onProgress: (p: TaskProgress, u: AgentProgressUpdate) => void;
  /** Called after every TaskProgress mutation (early-returns, completion). Sync uses this to fire onUpdate. */
  onStatusChange?: () => void;
  /** Telemetry call id for this dispatch. undefined when telemetry is disabled or not started. */
  telemetryCallId?: string;
  /** Runtime generation for rejecting writes from a stale shutdown worker. */
  telemetryGeneration?: number;
  /** Telemetry config captured at dispatch; binds task rows to the same backend
   *  as the call span. */
  telemetryConfig?: import("./config.ts").TelemetryConfig;
  /** Whether this task is part of an async ticket. */
  async?: boolean;
  /** Immutable dispatch-scoped delegate.json snapshot. Long-lived async workers
   *  use this instead of the live singleton so retry/stall/output/provider
   *  settings stay stable for the ticket's lifetime. */
  config?: import("./config.ts").DelegateConfig;
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
  /** Optional TUI notice boundary used for migration warnings. */
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
}

/** Shape returned by the delegate tool's `execute`. Mirrors Pi's
 *  `AgentToolResult<DelegateDetails>` without depending on the generic.
 *  `usage` (sync dispatch only) is the aggregate subagent spend; Pi 0.81+
 *  persists it on the tool result and folds it into the parent's
 *  session/footer totals. Older hosts ignore it. Async tickets can't attach
 *  usage — their results arrive via a follow-up message with no usage slot. */
export interface DelegateToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: DelegateDetails;
  /** Aggregate subagent usage for sync dispatch. Pi reads this for session
   *  totals on 0.81+; harmless on older versions. */
  usage?: Usage;
}

export interface AcquiredSession {
  /** The live AgentSession — constructed once and reused across prompts (pool hits). */
  session: AgentSession;
  sessionManager: SessionManager | undefined;
  sessionFile: string | undefined;
  /** Fresh/resumed sessions are lifecycle-owned until a successful pool commit. */
  lifecycleOwnsSession: boolean;
}

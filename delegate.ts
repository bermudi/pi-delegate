export { default } from "./extension.ts";

export type {
  AgentConfig,
  SessionAction,
  WorkspaceMode,
  TicketAction,
  DelegateAction,
  DelegateArguments,
  TaskDef,
  AsyncTicket,
  ResolvedTask,
  ToolActivity,
  TaskProgress,
  DelegateDetails,
  TaskResult,
  TaskFailureKind,
  ReuseIntent,
  ParentAgentDefaults,
  AgentRunConfig,
  TaskRunEnv,
} from "./types.ts";
export type { DelegateConfig } from "./config.ts";

export {
  DEFAULT_AGENT_NAME,
  SCOUT_AGENT_NAME,
  CODER_AGENT_NAME,
  REVIEWER_AGENT_NAME,
  BUILTIN_AGENT_NAMES,
  DEFAULT_TOOLS,
  READONLY_TOOLS,
  MAX_CONCURRENCY,
  VALID_THINKING,
} from "./constants.ts";
export { TOOL_FACTORIES, resolveToolGroups } from "./tools.ts";
export {
  loadDelegateConfig,
  getConcurrencyLimit,
  getMaxAsyncTickets,
  getMaxConcurrent,
  getStallTimeoutMs,
  resolveModelSpec,
  getOutputSpillThreshold,
  getOutputSpillTail,
} from "./config.ts";
export {
  checkout,
  commit,
  configFor,
  closePooledAgent,
  closeAllPooledAgents,
  listPooledAgents,
  withSessionLock,
} from "./pool.ts";
export type {
  FrozenConfig,
  ConfigCandidate,
  ConfigMismatch,
  CheckoutResult,
  CommitPayload,
} from "./pool.ts";
export {
  ticketRegistry,
  sweepTickets,
  cancelTicketForShutdown,
  requestTicketCancel,
  isSessionBusy,
  handlePoll,
  handleCancel,
  handleWait,
  notifyWaiters,
  deliverTicketResults,
  resolveFinalTicketStatus,
  formatCompletedTicket,
} from "./tickets.ts";
export type { TicketDelivery } from "./tickets.ts";
export {
  recordTreeNavigation,
  getCurrentLeafId,
  resetLeafTracking,
  isCrossLeafTicket,
} from "./leaf.ts";
export { runAgentSession } from "./runner.ts";
export { createScratchWorkspace } from "./workspace.ts";
export type { ScratchWorkspace } from "./workspace.ts";
export {
  activeTicketSummary,
  buildStatusText,
  clearDelegateStatusContext,
  describeActiveTickets,
  syncDelegateStatus,
  notifyActiveTicketsOnSettled,
  guardSessionReplacement,
  guardTreeNavigation,
  notifyCrossLeafDelivery,
} from "./status.ts";
export type { ActiveTicketSummary } from "./status.ts";
export { getHostDeps, invalidateHostDepsCache } from "./host.ts";
export type { HostDeps, HostDepsOptions } from "./host.ts";
export {
  aggregateTaskResults,
  emptyUsage,
  snapshotSessionUsage,
  usageDelta,
  addUsage,
  sumUsage,
} from "./usage.ts";
export type { SessionUsageSnapshot } from "./usage.ts";
export {
  truncLine,
  shortenPath,
  getActivityAge,
  fmtDuration,
  fmtTokens,
  trunc,
  tree,
  indent,
  formatFailedTask,
  formatCompletedTask,
  findTouchedOverlaps,
  formatTouchedOverlapWarning,
} from "./format.ts";
export {
  parseFrontmatter,
  findProjectRoot,
  loadAgentFile,
  loadClaudeAgentFile,
  discoverAgents,
  BUILTIN_AGENT_CONFIGS,
  isBuiltinAgentName,
  buildSubagentSystemPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
} from "./agents.ts";
export { buildParentTranscript, extractTextContent } from "./parent-context.ts";
export { extractTouchedFromActivities } from "./file-tracking.ts";
export {
  resolveModel,
  resolveModelRequest,
  findAvailableAlternative,
} from "./model.ts";
export {
  readDelegateSettingsFile,
  loadDelegateSettings,
  clearDelegateSettingsCache,
} from "./settings.ts";
export type { AgentOverride } from "./settings.ts";
export { resolveCwd, extractOutput, extractUsage } from "./utils.ts";
export {
  decideSpill,
  spillToTempFile,
  renderOutputForLLM,
  renderOutputForPoll,
} from "./spill.ts";
export type { SpillDecision } from "./spill.ts";

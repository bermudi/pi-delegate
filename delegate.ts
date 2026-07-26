export { default } from "./extension.ts";

export type {
  AgentConfig,
  SessionAction,
  DelegateAction,
  DelegateParams,
  TaskDef,
  AsyncTicket,
  ResolvedTask,
  ToolActivity,
  TaskProgress,
  DelegateDetails,
  TaskResult,
  AgentRunConfig,
  TaskRunEnv,
} from "./types.ts";
export type { DelegateConfig } from "./config.ts";

export {
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
  resolveModelSpec,
  getOutputSpillThreshold,
  getOutputSpillTail,
} from "./config.ts";
export {
  checkout,
  commit,
  configFor,
  closePooledAgent,
  sweepPool,
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
  isSessionBusy,
  handlePoll,
  handleCancel,
  handleWait,
  notifyWaiters,
  deliverTicketResults,
  resolveFinalTicketStatus,
  formatCompletedTicket,
} from "./tickets.ts";
export { runAgentSession } from "./runner.ts";
export { getHostDeps } from "./host.ts";
export type { HostDeps, HostDepsOptions } from "./host.ts";
export {
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
} from "./format.ts";
export {
  parseFrontmatter,
  findProjectRoot,
  loadAgentFile,
  loadClaudeAgentFile,
  discoverAgents,
  buildSubagentSystemPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
} from "./agents.ts";
export { buildParentTranscript, extractTextContent } from "./parent-context.ts";
export { extractTouchedFromActivities } from "./file-tracking.ts";
export { resolveModel, findAvailableAlternative } from "./model.ts";
export { readDelegateSettingsFile, loadDelegateSettings } from "./settings.ts";
export { resolveCwd, extractOutput, extractUsage } from "./utils.ts";
export {
  decideSpill,
  spillToTempFile,
  renderOutputForLLM,
  renderOutputForPoll,
} from "./spill.ts";
export type { SpillDecision } from "./spill.ts";

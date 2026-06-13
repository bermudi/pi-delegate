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
export type { DelegateConfig, SessionModelOverrides } from "./config.ts";

export { DEFAULT_TOOLS, MAX_CONCURRENCY, VALID_THINKING } from "./constants.ts";
export { TOOL_FACTORIES, expandToolsStar } from "./tools.ts";
export {
  resetSessionOverrides,
  loadDelegateConfig,
  saveDelegateConfigAtomic,
  setModelOverride,
  setDefaultModel,
  clearModelOverride,
  clearAllModelOverrides,
  setConcurrencyDefault,
  setConcurrencyProvider,
  setConcurrencyModel,
  removeConcurrencyProvider,
  removeConcurrencyModel,
  resetConcurrency,
  getConcurrencyLimit,
  getMaxAsyncTickets,
  getMaxConcurrent,
  setMaxConcurrent,
  resolveModelSpec,
} from "./config.ts";
export {
  agentPool,
  withSessionLock,
  closePooledAgent,
  sweepPool,
  listPooledAgents,
} from "./pool.ts";
export {
  ticketRegistry,
  sweepTickets,
  isSessionBusy,
  handlePoll,
  handleCancel,
  deliverTicketResults,
} from "./tickets.ts";
export { rehydrateAgent } from "./sessions.ts";
export {
  truncLine,
  shortenPath,
  getActivityAge,
  fmtDuration,
  fmtTokens,
  trunc,
  tree,
  indent,
} from "./format.ts";
export {
  parseFrontmatter,
  findProjectRoot,
  loadAgentFile,
  discoverAgents,
  loadSkill,
  loadAgentsMdFiles,
} from "./agents.ts";
export { buildParentTranscript, extractTextContent } from "./parent-context.ts";
export { extractTouchedFromActivities } from "./file-tracking.ts";
export { resolveModel, findAvailableAlternative } from "./model.ts";
export { readDelegateSettingsFile, loadDelegateSettings } from "./settings.ts";
export {
  RETRYABLE_PATTERNS,
  RETRYABLE_PATTERN,
  RATE_LIMIT_PATTERNS,
  isRetryableError,
  isRateLimitError,
  computeRetryDelay,
} from "./retry.ts";
export { runAgentOnce, runAgent } from "./runner.ts";
export { commitPoolCleanup } from "./lifecycle.ts";
export { resolveCwd, extractOutput, extractUsage } from "./utils.ts";

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
  resolveFinalTicketStatus,
  formatCompletedTicket,
} from "./tickets.ts";
export { runAgentSession } from "./runner.ts";
export { getHostDeps } from "./host.ts";
export type { HostDeps, HostDepsOptions } from "./host.ts";
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
} from "./format.ts";
export {
  parseFrontmatter,
  findProjectRoot,
  loadAgentFile,
  loadClaudeAgentFile,
  discoverAgents,
  loadSkill,
  loadAgentsMdFiles,
  buildSubagentSystemPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
} from "./agents.ts";
export { buildParentTranscript, extractTextContent } from "./parent-context.ts";
export { extractTouchedFromActivities } from "./file-tracking.ts";
export { resolveModel, findAvailableAlternative } from "./model.ts";
export { readDelegateSettingsFile, loadDelegateSettings } from "./settings.ts";
export { resolveCwd, extractOutput, extractUsage } from "./utils.ts";

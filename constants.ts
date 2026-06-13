export const DEFAULT_TOOLS = ["read", "write", "edit", "bash"];

/** Maximum concurrent subagent tasks. Prevents rate-limit thundering herds. */
export const MAX_CONCURRENCY = 3;

/** Idle timeout for pooled agents. 10 minutes. */
export const POOL_TTL_MS = 10 * 60 * 1000;

/** Maximum concurrent background async tickets. */
export const MAX_ASYNC_TICKETS = 5;

/** Completed tickets cleaned up after 30 minutes. */
export const ASYNC_TICKET_TTL_MS = 30 * 60 * 1000;

/** Hard timeout per async ticket. 30 minutes. */
export const ASYNC_MAX_RUNTIME_MS = 30 * 60 * 1000;

export const VALID_THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

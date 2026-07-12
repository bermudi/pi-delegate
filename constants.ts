/** Full-capability agent set. Inline-task default and the `*` shorthand.
 *  Bash subsumes search, so the dedicated grep/find/ls tools are excluded. */
export const DEFAULT_TOOLS = ["read", "write", "edit", "bash"];

/** Read-only scout set: search without a shell. The `ro` shorthand. */
export const READONLY_TOOLS = ["read", "grep", "find", "ls"];

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

/** Subagent final output longer than this (chars) is spilled to a temp file,
 *  keeping only a tail in the LLM-facing context. See `spill.ts`. */
export const OUTPUT_SPILL_THRESHOLD_CHARS = 8000;

/** Tail length (chars) kept in-context when an output is spilled. */
export const OUTPUT_SPILL_TAIL_CHARS = 2000;

export const VALID_THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

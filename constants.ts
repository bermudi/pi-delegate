/** Reserved built-in profile that mirrors the live parent configuration. */
export const DEFAULT_AGENT_NAME = "default";

/** Reserved built-in profile for read-only investigation. */
export const SCOUT_AGENT_NAME = "scout";

/** Reserved built-in profile for shared-workspace implementation work. */
export const CODER_AGENT_NAME = "coder";

/** Reserved built-in profile for isolated review work. */
export const REVIEWER_AGENT_NAME = "reviewer";

/** All names reserved by delegate's built-in profiles. */
export const BUILTIN_AGENT_NAMES = [
  DEFAULT_AGENT_NAME,
  SCOUT_AGENT_NAME,
  CODER_AGENT_NAME,
  REVIEWER_AGENT_NAME,
] as const;

/** Full-capability agent set. Inline-task default and the `*` shorthand.
 *  Bash subsumes search, so the dedicated grep/find/ls tools are excluded. */
export const DEFAULT_TOOLS = ["read", "write", "edit", "bash"];

/** Read-only scout set: search without a shell. The `ro` shorthand. */
export const READONLY_TOOLS = ["read", "grep", "find", "ls"];

/** Maximum concurrent subagent tasks. Prevents rate-limit thundering herds. */
export const MAX_CONCURRENCY = 3;

/** Maximum concurrent background async tickets. */
export const MAX_ASYNC_TICKETS = 5;

/** Completed tickets cleaned up after 30 minutes. */
export const ASYNC_TICKET_TTL_MS = 30 * 60 * 1000;

/** Subagent final output longer than this (chars) is spilled to a temp file,
 *  keeping only a tail in the LLM-facing context. See `spill.ts`. */
export const OUTPUT_SPILL_THRESHOLD_CHARS = 8000;

/** Tail length (chars) kept in-context when an output is spilled. */
export const OUTPUT_SPILL_TAIL_CHARS = 2000;

/** Literal union of valid thinking levels. Source of truth for both the
 *  runtime Set (below) and the TypeBox schema's static type — the `as const`
 *  tuple keeps `StringEnum`'s `T[number]` narrow so `DelegateArguments["tasks"]`
 *  projects `thinking` to the literal union rather than `string`. */
export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Runtime membership check for thinking levels. Kept as `Set<string>` (not
 *  `Set<VALID_THINKING_LEVELS[number]>`) so the `.has(string)` call sites in
 *  task-resolution.ts and agents.ts stay ergonomic under strict typing. */
export const VALID_THINKING: Set<string> = new Set(VALID_THINKING_LEVELS);

/** Session-control actions: RPC against the session pool, not work. They may
 *  only appear in all-control batches and never combine with `async` (see the
 *  fence in schema.ts). Per-action behavior lives at the branch sites; this
 *  predicate is the one shared spelling of the control set. */
export function isSessionControlAction(action: unknown): boolean {
  return action === "close" || action === "list";
}

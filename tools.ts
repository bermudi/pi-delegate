import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_TOOLS, READONLY_TOOLS } from "./constants.ts";

/** Shorthand → concrete tool list. `*` = full agent (bash subsumes search);
 *  `ro` = read-only scout (search without shell). */
const TOOL_GROUPS: Record<string, string[]> = {
  "*": DEFAULT_TOOLS,
  ro: READONLY_TOOLS,
};

export const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any>> = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

/** Expand tool-group shorthands (`*`, `ro`) into concrete tool lists.
 *  Unknown names pass through unchanged for the caller to validate.
 *  Returns a deduped list. */
export function resolveToolGroups(tools: string[]): string[] {
  const resolved: string[] = [];
  for (const t of tools) {
    const group = TOOL_GROUPS[t];
    if (group) resolved.push(...group);
    else resolved.push(t);
  }
  return [...new Set(resolved)];
}

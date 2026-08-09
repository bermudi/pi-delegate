import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS, READONLY_TOOLS } from "./constants.ts";

/** Shorthand → concrete tool list. `*` = full agent (bash subsumes search);
 *  `ro` = read-only scout (search without shell). */
const TOOL_GROUPS: Record<string, string[]> = Object.create(null) as Record<
  string,
  string[]
>;
TOOL_GROUPS["*"] = DEFAULT_TOOLS;
TOOL_GROUPS.ro = READONLY_TOOLS;

export const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any>> =
  Object.create(null) as Record<string, (cwd: string) => AgentTool<any>>;
TOOL_FACTORIES.read = createReadTool;
TOOL_FACTORIES.write = createWriteTool;
TOOL_FACTORIES.edit = createEditTool;
TOOL_FACTORIES.bash = createBashTool;
TOOL_FACTORIES.grep = createGrepTool;
TOOL_FACTORIES.find = createFindTool;
TOOL_FACTORIES.ls = createLsTool;

/** Expand tool-group shorthands (`*`, `ro`) into concrete tool lists.
 *  Unknown names pass through unchanged for the caller to validate.
 *  Returns a deduped list. */
export function resolveToolGroups(tools: string[]): string[] {
  const resolved: string[] = [];
  for (const t of tools) {
    if (Object.hasOwn(TOOL_GROUPS, t)) resolved.push(...TOOL_GROUPS[t]);
    else resolved.push(t);
  }
  return [...new Set(resolved)];
}

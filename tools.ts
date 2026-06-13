import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";

export const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any>> = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
};

/** Expand `"*"` in a tools list to all registered tool names. */
export function expandToolsStar(tools: string[]): string[] {
  if (!tools.includes("*")) return tools;
  const allNames = Object.keys(TOOL_FACTORIES);
  return [...new Set([...allNames, ...tools.filter((t) => t !== "*")])];
}

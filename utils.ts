import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export function resolveCwd(cwd: string): string {
  const expanded = cwd.startsWith("~")
    ? path.join(os.homedir(), cwd.slice(1))
    : cwd;
  return path.resolve(expanded);
}

/** Extract text content from a partial tool result (tool_execution_update). */
export function extractTextFromPartialResult(
  partialResult: unknown,
): string | undefined {
  if (
    !partialResult ||
    typeof partialResult !== "object" ||
    !("content" in partialResult)
  )
    return undefined;
  const content = (partialResult as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (c): c is { type: string; text?: string } =>
        c && typeof c === "object" && "type" in c && c.type === "text",
    )
    .map((c) => c.text)
    .filter((t): t is string => typeof t === "string")
    .join("\n");
  return text || undefined;
}

/** Strip ANSI escape sequences from text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Resolve carriage-return progress bars to their final line state. */
export function resolveCarriageReturn(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}

export function extractOutput(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

export function extractUsage(messages: AgentMessage[]) {
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0 };
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = msg.usage as any;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.total += u.total ?? (u.input ?? 0) + (u.output ?? 0);
  }
  return usage;
}

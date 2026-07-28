import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function resolveCwd(cwd: string): string {
  const expanded = cwd.startsWith("~")
    ? path.join(os.homedir(), cwd.slice(1))
    : cwd;
  return path.resolve(expanded);
}

export function validateResumeFromPath(resumeFrom: string): string | undefined {
  if (!resumeFrom.trim()) {
    return "expected an absolute .jsonl session file path copied from delegate retry output";
  }

  if (!resumeFrom.endsWith(".jsonl")) {
    return "expected an absolute .jsonl session file path copied from delegate retry output";
  }

  const expanded = resumeFrom.startsWith("~")
    ? path.join(os.homedir(), resumeFrom.slice(1))
    : resumeFrom;
  if (!path.isAbsolute(expanded)) {
    return "expected an absolute .jsonl session file path copied from delegate retry output";
  }

  return undefined;
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

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  total?: number;
  totalTokens?: number;
}

function isUsageLike(u: unknown): u is UsageLike {
  if (u === null || typeof u !== "object") return false;
  const r = u as Record<string, unknown>;
  const numericKeys: (keyof UsageLike)[] = [
    "input",
    "output",
    "cacheRead",
    "total",
    "totalTokens",
  ];
  let hasNumeric = false;
  for (const k of numericKeys) {
    const v = r[k as string];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v)) return false;
      hasNumeric = true;
    }
  }
  return hasNumeric;
}

export function extractUsage(messages: AgentMessage[]) {
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0 };
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const rawUsage: unknown = msg.usage;
    if (!isUsageLike(rawUsage)) continue;
    const u = rawUsage;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.total += u.total ?? u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
  }
  return usage;
}

import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Resolve a path relative to the caller's working directory. Tilde paths and
 * absolute paths intentionally ignore `baseCwd`. */
export function resolveCwd(cwd: string, baseCwd = process.cwd()): string {
  const expanded = cwd.startsWith("~")
    ? path.join(os.homedir(), cwd.slice(1))
    : cwd;
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseCwd, expanded);
}

/** Validate the absolute `.jsonl` path accepted by `resumeFrom`. */
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
  // A scanner keeps malformed, unterminated control strings linear-time.
  // Regexes with lazy "anything until ST" branches become quadratic on input
  // containing many unterminated OSC/DCS introducers.
  let clean = "";
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);

    if (code === 0x1b) {
      const next = text.charCodeAt(index + 1);
      if (next === 0x5d) {
        index = skipControlString(text, index + 2, true);
        continue;
      }
      if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipControlString(text, index + 2, false);
        continue;
      }
      if (next === 0x5b) {
        index = skipCsi(text, index + 2);
        continue;
      }
      if (next === 0x5c) {
        // Preserve a boundary for a standalone 7-bit ST just as for C1 ST,
        // so removing it cannot concatenate attacker-controlled words.
        clean += " ";
        index += 2;
        continue;
      }

      // Generic ESC sequence: intermediates followed by one final byte.
      index++;
      while (index < text.length) {
        const value = text.charCodeAt(index);
        if (value < 0x20 || value > 0x2f) break;
        index++;
      }
      if (index < text.length) {
        const final = text.charCodeAt(index);
        if (final >= 0x30 && final <= 0x7e) index++;
      }
      continue;
    }

    if (code === 0x9d) {
      index = skipControlString(text, index + 1, true);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipControlString(text, index + 1, false);
      continue;
    }
    if (code === 0x9b) {
      index = skipCsi(text, index + 1);
      continue;
    }
    if (code === 0x9c) {
      // Preserve a boundary for a stray terminator so sanitization cannot
      // concatenate attacker-controlled words around the removed control.
      clean += " ";
      index++;
      continue;
    }

    clean += text[index]!;
    index++;
  }
  return clean;
}

function skipControlString(
  text: string,
  index: number,
  bellTerminates: boolean,
): number {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if ((bellTerminates && code === 0x07) || code === 0x9c) return index + 1;
    if (
      code === 0x1b &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) === 0x5c
    ) {
      return index + 2;
    }
    index++;
  }
  return index;
}

function skipCsi(text: string, index: number): number {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    // A malformed CSI must not consume diagnostic layout while searching for
    // a final byte. Leave common layout controls for the outer sanitizer.
    if (code === 0x09 || code === 0x0a || code === 0x0d) return index;
    index++;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

/**
 * Remove terminal controls from untrusted multiline text while preserving its
 * line and ordinary whitespace structure for markdown/plain-text rendering.
 */
export function sanitizeTerminalText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, " ");
}

/**
 * Flatten untrusted text for one terminal row. ANSI sequences and terminal
 * controls are removed before whitespace is normalized, so callers can safely
 * truncate and store the result without preserving a partial escape sequence.
 */
export function sanitizeTerminalLine(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
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

/** Concatenate text blocks from assistant messages in a session slice. */
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

/** Sum finite usage fields from assistant messages. */
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

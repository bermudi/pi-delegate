import {
  buildSessionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export function buildParentTranscript(
  entries: SessionEntry[],
  leafId: string | null,
): string | null {
  try {
    const ctx = buildSessionContext(entries, leafId);
    const lines: string[] = [];
    for (const msg of ctx.messages) {
      if (msg.role === "user") {
        const text = extractTextContent(msg.content);
        if (text) lines.push(`**User:** ${text.trim()}`);
      } else if (msg.role === "assistant") {
        const text = extractTextContent(msg.content);
        if (text) lines.push(`**Assistant:** ${text.trim()}`);
      }
    }
    return lines.join("\n\n") || null;
  } catch {
    return null;
  }
}

export function extractTextContent(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("");
}

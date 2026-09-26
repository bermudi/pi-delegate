import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fault injection at the host boundary (tests only). Simulates an extension
 * force-replacing the parent's system prompt wholesale during
 * `before_agent_start`, before delegate.ts's capture handler runs. The
 * composed child prompt must skip inheritance (the forced text is
 * extension-authored and cannot be sanitized through the structured
 * inputs) and log the skip once.
 */
export default function forcedPromptFault(api: ExtensionAPI): void {
  api.on("before_agent_start", (event) => {
    event.systemPromptOptions.forceSystemPrompt = "FORCED-PARENT-PROMPT";
  });
}

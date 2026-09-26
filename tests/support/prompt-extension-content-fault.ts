import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fault injection at the host boundary (tests only). During its own
 * `before_agent_start` — which runs before delegate.ts's capture handler,
 * since leading extensions load first — this extension contributes prompt
 * content through the extension channels: an extra guideline bullet and an
 * XML-wrapped section. The child-prompt contract must not inherit either:
 * children run extension-free, and inherited extension prose would
 * reference tools they do not have.
 */
export default function promptExtensionContentFault(api: ExtensionAPI): void {
  api.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    options.promptGuidelines = [
      ...options.promptGuidelines,
      "EXTENSION-GUIDELINE-MARKER",
    ];
    options.sections = {
      ...options.sections,
      ext_marker: "EXTENSION-SECTION-MARKER",
    };
  });
}

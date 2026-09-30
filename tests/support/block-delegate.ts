import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function blockDelegate(api: ExtensionAPI): void {
  api.on("tool_call", (event) => {
    if (event.toolName === "delegate") {
      return { block: true, reason: "Delegate blocked by a later extension." };
    }
  });
}

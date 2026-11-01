import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function blockOperations(api: ExtensionAPI): void {
  api.on("tool_call", (event) => {
    if (event.toolName === "delegate_ticket" || event.toolName === "delegate_session") {
      return { block: true, reason: "PRIVATE-BLOCKED" };
    }
  });
}

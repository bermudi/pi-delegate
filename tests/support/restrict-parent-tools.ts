import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Apply the real host restriction after the harness installs its playbook tools.
export default function restrictParentTools(api: ExtensionAPI) {
  api.on("tool_call", (event) => {
    if (event.toolName === "delegate") {
      api.setActiveTools(["delegate", "delegate_ticket", "delegate_session"]);
    }
  });
}

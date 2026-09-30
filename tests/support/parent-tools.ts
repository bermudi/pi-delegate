import { spyOn } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";

function hasToolProbe(value: unknown): value is { getActiveTools: () => string[] } {
  return value !== null && typeof value === "object" &&
    "getActiveTools" in value && typeof value.getActiveTools === "function";
}

/** Pi 0.84.2 host-only fault injection; never bypasses the registered tool.
 * The wrapper calls runner.getActiveTools before/after execution, whereas
 * the extension API calls runtime.getActiveTools. Keep wrapper inventory live.
 */
export function mockParentTools(session: TestSession, read: () => string[]) {
  const runner: unknown = session.session.extensionRunner;
  if (!hasToolProbe(runner) || !("runtime" in runner) || !hasToolProbe(runner.runtime)) {
    throw new Error("Pinned Pi extension runner tool-probe seam unavailable");
  }
  const wrapper = spyOn(runner, "getActiveTools")
    .mockImplementation(() => session.session.getActiveToolNames());
  const probe = spyOn(runner.runtime, "getActiveTools").mockImplementation(read);
  return {
    probe,
    restore() {
      probe.mockRestore();
      wrapper.mockRestore();
    },
  };
}

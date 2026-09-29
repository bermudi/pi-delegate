import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Test listener for the #60 usage signal: appends every `delegate:usage`
 * emission on the shared event bus as a JSON line under the session cwd,
 * so contract tests assert payload shape and throttling through the real
 * `pi.events` seam — the same seam the provider-balance listener uses.
 * Loaded as a leading extension; `session_start` supplies the cwd.
 */
export default function usageListener(api: ExtensionAPI): void {
  let cwd: string | undefined;
  api.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
  });
  api.events.on("delegate:usage", (data: unknown) => {
    if (cwd === undefined) return;
    appendFileSync(join(cwd, "DELEGATE_USAGE.jsonl"), `${JSON.stringify(data)}\n`);
  });
}

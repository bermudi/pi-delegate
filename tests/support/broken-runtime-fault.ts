import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fault injection at the host boundary (tests only). Sabotages the
 * extension registry's private model-runtime handle during this
 * extension's own `session_start`, before any extension loaded after it
 * runs its handler. Loading this before delegate.ts simulates a Pi
 * upgrade that repacked the registry — the exact break the session-start
 * probe must log through (not throw) and the dispatch-time grab must
 * still fail loudly on.
 */
export default function brokenRuntimeFault(api: ExtensionAPI): void {
  api.on("session_start", (_event, ctx) => {
    (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime = {
      getModel: () => undefined,
      getModels: () => [],
    };
  });
}

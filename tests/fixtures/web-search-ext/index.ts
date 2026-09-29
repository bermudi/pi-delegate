import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/**
 * Provider-extension fixture (#59 contract tests). Registers a
 * `web_search` tool whose execution writes WEB_SEARCH_MARKER.txt into
 * the task's cwd — an observable side effect proving the extension
 * loaded into the CHILD registry and its tool was active. The marker
 * content ("provider-ext-search") distinguishes this copy from the
 * parent-side fixture, so tests can prove which registry executed the
 * call. Dependency-light on purpose: a copy of this file is loaded
 * from a temporary agent directory where bare package imports could
 * not resolve; `import type` lines erase at transpile.
 */
export default function webSearchExtension(api: ExtensionAPI): void {
  api.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web (test fixture).",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    } as unknown as TSchema,
    execute: async (
      _toolCallId: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      writeFileSync(join(ctx.cwd, "WEB_SEARCH_MARKER.txt"), "provider-ext-search");
      return {
        content: [{ type: "text" as const, text: "SEARCH-OK" }],
        details: {},
      };
    },
  });
}

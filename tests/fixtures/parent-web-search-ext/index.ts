import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/**
 * Parent-side fixture (#59 contract tests): registers `web_search` on
 * the PARENT session via leadingExtensions. If a subagent's call
 * executes this copy, the marker reads "parent-ext-search" — proof the
 * child inherited the parent's extension registry, which must never
 * happen. A correctly isolated child either cannot call the tool at
 * all (no marker) or executes its own allowlisted copy
 * ("provider-ext-search").
 */
export default function parentWebSearchExtension(api: ExtensionAPI): void {
  api.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web (parent test fixture).",
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
      writeFileSync(join(ctx.cwd, "WEB_SEARCH_MARKER.txt"), "parent-ext-search");
      return {
        content: [{ type: "text" as const, text: "PARENT-SEARCH-OK" }],
        details: {},
      };
    },
  });
}

import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { DelegateToolResult } from "./types.ts";

/**
 * Symbols the dispatch / host-deps path dereferences. A `new`, `.create()`, or
 * bare call on any of these crashes with a cryptic
 * `Cannot read properties of undefined (reading '…')` if pi drops or renames it.
 * Keep this list in sync with the actual import sites (host.ts, sessions.ts,
 * lifecycle.ts, agents.ts).
 */
type ExportCheck = {
  name: string;
  requiredMember?: string;
};

/**
 * Host symbols actually dereferenced by delegate. Static members are listed by
 * `<symbol>.<member>` so we fail fast when a constructor is present but no longer
 * exposes the required factory methods.
 */
const REQUIRED_EXPORTS: ExportCheck[] = [
  { name: "ModelRuntime", requiredMember: "create" },
  { name: "SettingsManager", requiredMember: "create" },
  { name: "SessionManager", requiredMember: "create" },
  { name: "SessionManager", requiredMember: "open" },
  { name: "SessionManager", requiredMember: "inMemory" },
  { name: "DefaultResourceLoader" },
  { name: "DefaultPackageManager" },
  { name: "createAgentSession" },
  { name: "getAgentDir" },
  { name: "parseFrontmatter" },
];

/**
 * Build a tool result describing any required symbols missing from a pi
 * namespace, or `null` if all are present. Pure (no I/O, no cache) so it can be
 * unit-tested with a stub namespace.
 */
export function hostCompatResult(
  ns: Record<string, unknown>,
): DelegateToolResult | null {
  const missing: string[] = [];
  for (const entry of REQUIRED_EXPORTS) {
    const value = ns[entry.name];
    if (value === undefined) {
      missing.push(`'${entry.name}'`);
      continue;
    }

    if (typeof value !== "function") {
      missing.push(`'${entry.name}'`);
      continue;
    }

    if (entry.requiredMember) {
      const symbolValue = value as unknown as { [key: string]: unknown };
      if (!(entry.requiredMember in symbolValue)) {
        missing.push(`'${entry.name}.${entry.requiredMember}'`);
        continue;
      }
      if (typeof symbolValue[entry.requiredMember] !== "function") {
        missing.push(`'${entry.name}.${entry.requiredMember}'`);
      }
    }
  }

  if (missing.length === 0) return null;
  const listed = missing.join(", ");
  return {
    content: [
      {
        type: "text",
        text: [
          "delegate extension: host compatibility check failed.",
          "",
          `pi no longer exports ${listed} from @earendil-works/pi-coding-agent.`,
          "This is a version mismatch — the delegate bundle was built against a",
          "pi version that has since removed or renamed these symbols (the same",
          "class of regression that broke delegation across pi 0.80.3→0.80.8,",
          "when `authStorage` + `modelRegistry` were folded into `modelRuntime`).",
          "",
          "Fix: from the pi-delegate repo run `bun install && bun run build`, then",
          "`/reload` in Pi — or pin pi to a version compatible with this build.",
        ].join("\n"),
      },
    ],
    details: { tasks: [], results: [], progress: [] },
  };
}

let cached: DelegateToolResult | null | undefined;

/**
 * One-time compatibility check against the *installed* pi. The bundle marks the
 * pi-* packages external, so this namespace resolves — via pi's jiti alias — to
 * whatever pi is actually installed, which may differ from the build/typecheck
 * target. Cached because module exports are immutable for the process lifetime.
 */
export function hostCompatError(): DelegateToolResult | null {
  if (cached === undefined) {
    cached = hostCompatResult(piCodingAgent as Record<string, unknown>);
  }
  return cached;
}

/** Test-only: reset the cache (for exercising the detection path afresh). */
export function _resetHostCompatCacheForTesting(): void {
  cached = undefined;
}

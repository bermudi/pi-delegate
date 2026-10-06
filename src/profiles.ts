import { DiagnosticSink } from "./diagnostics.ts";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter as parsePiFrontmatter } from "@earendil-works/pi-coding-agent";

/** Built-in coding tools a subagent session can actually be given. */
export const CHILD_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/**
 * The delegate-family tool names. Children never nest dispatch (#45):
 * these are stripped — silently — from every inventory a subagent can be
 * given: explicit task `tools`, profile `tools`, and the parent's mirrored
 * active set (which already excludes them by construction, via CHILD_TOOLS).
 */
export const DELEGATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "delegate",
  "delegate_ticket",
  "delegate_session",
]);

/** Tools that cannot mutate the workspace, for shared-write admission. */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
]);

const TOOL_GROUPS: Record<string, readonly string[]> = {
  "*": ["read", "bash", "edit", "write"],
  ro: ["read", "grep", "find", "ls"],
};

export interface AgentProfile {
  readonly name: string;
  /** One-line role for the manual's profile list. */
  readonly description?: string;
  /** Fixed tool set; undefined means "resolve like the default profile". */
  readonly tools?: readonly string[];
  /**
   * Profile-default effort: a frontmatter `thinking`, or the `:effort`
   * suffix on a frontmatter `model`. Sits below a delegate.json `:effort`
   * and above the parent-mirror fallback.
   */
  readonly thinking: ThinkingLevel | undefined;
  /** Frontmatter `model` pin; resolved like a delegate.json reference. */
  readonly modelPin?: string;
  /** File the profile was defined in, for error messages. */
  readonly source?: string;
  readonly systemPrompt: string | undefined;
  /**
   * Built-in role line. Unlike an authored `systemPrompt`, a role does not
   * replace the child's base prompt: it is composed under the parent's
   * inherited user-authored prompt inputs and the fixed subagent framing
   * (SPEC "Child base prompt").
   */
  readonly role?: string;
}

/**
 * The fixed subagent framing appended to every composed child base prompt
 * (inline tasks and built-in profiles). Authored prompts — an explicit task
 * `systemPrompt` or a Markdown profile body — never receive it. Carries no
 * parent identity: never a model name.
 */
export const SUBAGENT_FRAMING =
  "You are a subagent spawned by the delegate extension on behalf of a parent " +
  "session. No user is watching this session and questions cannot be asked; " +
  "your final message is the only result returned to the caller. Complete the " +
  "task in your brief, then stop. Use only the tools provided.";

const BUILTIN_PROFILES: Record<string, Omit<AgentProfile, "tools" | "name"> & { tools?: readonly string[] }> = {
  default: {
    // Mirrors the parent's model, thinking, and active tools at resolution;
    // its base prompt composes from the parent's user-authored inputs.
    thinking: undefined,
    systemPrompt: undefined,
  },
  explore: {
    tools: TOOL_GROUPS.ro,
    thinking: undefined,
    systemPrompt: undefined,
    role: "You are a read-only investigation subagent. Report findings precisely; do not modify files.",
  },
  coder: {
    thinking: undefined,
    systemPrompt: undefined,
    role: "You are an implementation subagent working directly in the source tree.",
  },
  reviewer: {
    // v1 parity: read + bash — a reviewer that cannot run focused checks
    // is materially weaker, and bash makes it a writer for shared-write
    // admission, exactly as v1 treated it.
    tools: ["read", "bash"],
    thinking: undefined,
    systemPrompt: undefined,
    role: "You are a code-review subagent. Inspect the tree and report concrete findings.",
  },
  verifier: {
    // The reviewer's toolset (read + bash — it must run focused checks)
    // but a different job: it rules on a claim and must close on a
    // machine-parseable verdict. The verdict is completion evidence
    // (#49) — reporting only, never admission or gating input.
    tools: ["read", "bash"],
    thinking: undefined,
    systemPrompt: undefined,
    role:
      "You are a verification subagent. Your brief names a claim to check. " +
      "Test it against the actual state of the tree: inspect files and run " +
      "focused checks, then rule on the claim. Close your final message with " +
      "a verdict line in exactly this form, on its own line: " +
      "`VERDICT: PASS` when the claim held up, `VERDICT: FAIL` when the " +
      "evidence contradicts it, or `VERDICT: AMBIGUOUS` when you cannot " +
      "decide either way. A parenthetical count may follow the verdict word " +
      "(e.g. `VERDICT: FAIL (2 findings)`). Emit exactly one verdict line, " +
      "as the last line of your reply.",
  },
};

export function knownAgentNames(): string[] {
  return [...Object.keys(BUILTIN_PROFILES)];
}

export function getBuiltinProfile(name: string): AgentProfile | undefined {
  const profile = Object.hasOwn(BUILTIN_PROFILES, name)
    ? BUILTIN_PROFILES[name]
    : undefined;
  return profile ? { name, ...profile } : undefined;
}

/**
 * Expand the task `tools` field into concrete child tool names.
 * `*` and `ro` are groups; every other entry must name a known tool.
 * Returns an error string instead of throwing so callers can compose it.
 *
 * `web_search` is not a built-in child tool: it exists only when a
 * provider extension supplies it, so it expands only for tasks whose
 * resolved provider has a non-empty extension allowlist (#59 —
 * `options.providerExtensions`). When the named extension fails to load
 * (best-effort roots may drop), the session activates only what the
 * registry has — the name then rests inertly, same as v1.
 */
export function expandTools(
  spec: readonly string[] | undefined,
  options?: { readonly providerExtensions?: boolean },
): string[] | string {
  if (!spec) return [...TOOL_GROUPS["*"]!];
  const expanded: string[] = [];
  for (const entry of spec) {
    // A trained caller may pass the dispatch family through — children
    // never nest, so the entry drops silently rather than erroring (#45).
    if (DELEGATE_TOOL_NAMES.has(entry)) continue;
    const group = TOOL_GROUPS[entry];
    if (group) {
      expanded.push(...group);
      continue;
    }
    if (!READ_ONLY_TOOLS.has(entry) && !(CHILD_TOOLS as readonly string[]).includes(entry)) {
      return `unknown tool '${entry}'. Known tools: ${[...CHILD_TOOLS].join(", ")}; groups: *, ro.`;
    }
    if (!(CHILD_TOOLS as readonly string[]).includes(entry)) {
      if (entry === "web_search" && options?.providerExtensions === true) {
        expanded.push(entry);
        continue;
      }
      return `tool '${entry}' is not available to subagents. Known tools: ${[...CHILD_TOOLS].join(", ")}; groups: *, ro.`;
    }
    expanded.push(entry);
  }
  return [...new Set(expanded)];
}

/** A task can mutate its workspace when any effective tool is not read-only. */
export function isWriter(tools: readonly string[]): boolean {
  return tools.some((tool) => !READ_ONLY_TOOLS.has(tool));
}

const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** A parsed `provider/model[:effort]` pin (config or frontmatter). */
export interface ModelAssignment {
  /** Model reference with any `:effort` suffix already stripped. */
  readonly ref: string;
  /** Configured effort suffix, when one was given. */
  readonly thinking: ThinkingLevel | undefined;
}

/**
 * Parse one `provider/model[:effort]` reference. The last `:`-segment pins
 * the child's thinking level only when it is a known level; any other
 * trailing colon belongs to the model id itself — ids legitimately carry
 * colons (`ollama/qwen2.5:32b`, `openrouter/...:free`) — and stays in the
 * reference. A reference that does not resolve fails later at dispatch,
 * naming this entry. An id that literally ends in a known level is
 * unexpressible: the suffix always wins. `name` names the entry in errors.
 */
export function parseModelEntry(
  value: unknown,
  name: string,
  path: string,
): ModelAssignment {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${path}: ${name} must be a non-empty model reference; got ${JSON.stringify(value)}.`,
    );
  }
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return { ref: trimmed, thinking: undefined };
  const suffix = trimmed.slice(colon + 1);
  if (!THINKING_LEVELS.has(suffix)) {
    return { ref: trimmed, thinking: undefined };
  }
  const ref = trimmed.slice(0, colon);
  if (ref === "") {
    throw new Error(
      `${path}: ${name} must name a model before its :${suffix} suffix; got ${JSON.stringify(trimmed)}.`,
    );
  }
  return { ref, thinking: suffix as ThinkingLevel };
}

// ── Markdown profiles ──────────────────────────────────────────────────────

/**
 * The resolvable profile set for one dispatch: built-ins plus discovered
 * Markdown agents. `globalNames` lists the globally defined custom profile
 * names (built-ins are already implied) — the names a user-global
 * `delegate.json` may pin beyond built-ins. Project-scoped profiles are
 * deliberately excluded: a global config key that only resolves inside one
 * repo would fail validation in every other session.
 */
export interface ProfileCatalog {
  readonly profiles: ReadonlyMap<string, AgentProfile>;
  readonly globalNames: readonly string[];
}

/** Frontmatter fence: `---\n … \n---\n body`. CRLF-tolerant. */
const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Coerce parsed YAML frontmatter into flat strings (v1 shape). */
function frontmatterToData(
  fm: Record<string, unknown>,
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) data[k] = v.map(String).join(", ");
    else if (typeof v === "object") data[k] = JSON.stringify(v);
    else data[k] = String(v);
  }
  return data;
}

/** Quote ambiguous YAML scalar values before handing them to Pi's parser. */
function sanitizeYamlScalars(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)([\w-]+)(\s*:\s*)(.*)$/);
      if (!m) return line;
      const [, leading, key, sep, rawValue] = m;
      const value = rawValue?.trim();
      if (!value) return line;
      if (/^["'|>\[{]/.test(value)) return line;
      if (!/:\s/.test(value)) return line;
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${leading}${key}${sep}"${escaped}"`;
    })
    .join("\n");
}

/** Parse a frontmatter fence into flat data + trimmed body; warns and empties on malformed YAML. */
function parseProfileFrontmatter(
  content: string,
  filePath: string,
  warnPath: (filePath: string, message: string, error?: unknown) => void,
): { data: Record<string, string>; body: string } {
  // Windows-authored profiles arrive CRLF-ended; normalize before matching
  // so the fence, YAML sanitization, and body all follow the LF path.
  const normalized = content.replace(/\r\n/g, "\n");
  const m = normalized.match(FRONTMATTER_FENCE);
  if (!m) return { data: {}, body: normalized.trim() };
  const body = m[2]!.trim();
  // A bare `*` is an invalid YAML alias, so `tools: *` must be quoted first.
  const sanitized = sanitizeYamlScalars(
    m[1]!.replace(
      /^([ \t]*[\w-]+:[ \t]*)\*([ \t]*(?:#[^\r\n]*)?)(?=\r?$)/gm,
      '$1"*"$2',
    ),
  );
  try {
    const { frontmatter } = parsePiFrontmatter(
      `---\n${sanitized}\n---\n${body}`,
    );
    return {
      data: frontmatterToData((frontmatter ?? {}) as Record<string, unknown>),
      body,
    };
  } catch (error) {
    warnPath(
      filePath,
      "malformed agent frontmatter",
      error,
    );
    return { data: {}, body };
  }
}

/**
 * Load one Markdown profile file, or null with a logged warning when the
 * file is unreadable or invalid. `name` and `description` are required;
 * `tools` accepts the `*`/`ro` groups or a comma list (omitted means `*`);
 * `thinking` must be a known level; `model` is a `provider/model[:effort]`
 * pin (an explicit `thinking` field wins over the suffix). Unknown keys are
 * ignored — model pins in particular are honored here because profile files
 * are user-authored config, on par with delegate.json.
 */
function loadProfileFile(
  filePath: string,
  warnPath: (filePath: string, message: string, error?: unknown) => void,
): AgentProfile | null {
  const warn = (problem: string, error?: unknown): null => {
    warnPath(
      filePath,
      `ignoring agent profile: ${problem}`,
      error,
    );
    return null;
  };
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    // An unreadable file (permissions, races) warns like any other bad
    // profile — silence here would make a permissions problem look like a
    // missing profile.
    return warn(
      "unreadable",
      error,
    );
  }
  const { data, body } = parseProfileFrontmatter(content, filePath, warnPath);
  if (!data.name?.trim()) return warn("missing required `name` in frontmatter.");
  if (!data.description?.trim()) {
    return warn("missing required `description` in frontmatter.");
  }
  let tools: readonly string[] | undefined;
  if (data.tools !== undefined && data.tools.trim() !== "") {
    const expanded = expandTools(
      data.tools
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
    if (typeof expanded === "string") {
      return warn("invalid tools");
    }
    tools = expanded;
  }
  let thinking: ThinkingLevel | undefined;
  if (data.thinking !== undefined && data.thinking.trim() !== "") {
    const level = data.thinking.trim();
    if (!THINKING_LEVELS.has(level)) {
      return warn(
        "invalid thinking level",
      );
    }
    thinking = level as ThinkingLevel;
  }
  let modelPin: string | undefined;
  if (data.model !== undefined && data.model.trim() !== "") {
    let pin: ModelAssignment;
    try {
      pin = parseModelEntry(data.model, `model`, filePath);
    } catch (error) {
      return warn("invalid model pin", error);
    }
    modelPin = pin.ref;
    // An explicit `thinking` field outranks the model's :effort suffix.
    thinking = thinking ?? pin.thinking;
  }
  return {
    name: data.name.trim(),
    description: data.description.trim(),
    tools,
    thinking,
    modelPin,
    source: filePath,
    systemPrompt: body,
  };
}

/** Options for {@link discoverProfiles}. */
interface ProfileDiscoveryOptionsBase {
  /**
   * Sink for safe profile warnings; dispatch supplies its owned diagnostic sink. The manual's
   * profile listing passes a silent sink — asking for help must not scold.
   */
  /**
   * File paths already warned about, owned by the caller (the extension
   * closure holds one set per session): a broken profile file warns once
   * per session, not once per dispatch. Omit to warn on every discovery.
   */
  readonly warnedPaths?: Set<string>;
}

/**
 * Discover Markdown agent profiles, first definition wins, in order:
 *   1. `<projectRoot>/.pi/agents` — nearest ancestor of `cwd` containing one
 *   2. `<agentDir>/agents`        — the user-global agent directory
 * Built-ins always win name collisions: an `explore.md` is ignored with a
 * warning rather than silently reshaping a built-in. Files ending in
 * `.chain.md` are skipped (v1 convention). Within one directory, files are
 * visited in name order — readdir order is filesystem-dependent, and the
 * winner between two same-named files must not be.
 */
export type ProfileDiscoveryOptions = ProfileDiscoveryOptionsBase & (
  { readonly diagnostics: DiagnosticSink; readonly warn?: never } | { readonly warn: (message: string) => void; readonly diagnostics?: never }
);

export function discoverProfiles(
  cwd: string,
  agentDir: string,
  options: ProfileDiscoveryOptions,
): ProfileCatalog {
  const warnedPaths = options.warnedPaths;
  /** Emit one warning per file path for the options' lifetime. */
  const warnPath = (filePath: string, message: string, error?: unknown): void => {
    if (warnedPaths !== undefined) {
      if (warnedPaths.has(filePath)) return;
      warnedPaths.add(filePath);
    }
    if (options.warn) options.warn(`[delegate] ${message}: ${filePath}`);
    else options.diagnostics.log("warn", message, { path: filePath }, error);
  };
  const profiles = new Map<string, AgentProfile>();
  for (const name of knownAgentNames()) {
    profiles.set(name, getBuiltinProfile(name)!);
  }
  const globalNames = new Set<string>();

  const loadDir = (dir: string, global: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Deterministic first-definition-wins: sort by file name so two
    // same-named profiles in one directory always resolve the same way.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        entry.name.endsWith(".chain.md")
      ) {
        continue;
      }
      const filePath = join(dir, entry.name);
      const profile = loadProfileFile(filePath, warnPath);
      if (!profile) continue;
      if (getBuiltinProfile(profile.name) !== undefined) {
        warnPath(
          filePath,
          "ignoring agent profile: built-in agent cannot be overridden",
        );
        continue;
      }
      // Globally defined even when shadowed: a project profile winning
      // first-definition-wins must not erase the global definition from
      // the models/modelsByParent key set (SPEC: only globally defined
      // names are valid keys — a shadowed name is still globally defined).
      if (global) globalNames.add(profile.name);
      if (profiles.has(profile.name)) continue; // first definition wins
      profiles.set(profile.name, profile);
    }
  };

  let projectRoot = cwd;
  while (true) {
    if (existsSync(join(projectRoot, ".pi", "agents"))) break;
    const parent = dirname(projectRoot);
    if (parent === projectRoot) {
      projectRoot = "";
      break;
    }
    projectRoot = parent;
  }
  if (projectRoot !== "") loadDir(join(projectRoot, ".pi", "agents"), false);
  loadDir(join(agentDir, "agents"), true);

  return { profiles, globalNames: [...globalNames] };
}

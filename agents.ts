import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { parseFrontmatter as parsePiFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS, VALID_THINKING } from "./constants.ts";
import { resolveToolGroups } from "./tools.ts";
import type { AgentConfig } from "./types.ts";

// Frontmatter fence: `---\n … \n---\n body`. CRLF-tolerant. Captures the
// YAML block (group 1) and the body (group 2). The YAML itself is parsed by
// pi-coding-agent's `parseFrontmatter` (built on the `yaml` package, which is
// a guaranteed dependency of the host pi) — we only use this regex to split
// the fence from the body and to detect the no-frontmatter case.
const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Coerce a parsed YAML frontmatter object into the flat
 *  `Record<string, string>` shape the rest of the loader expects. Arrays
 *  (e.g. `tools: [read, write]`) are joined with ", " so the downstream
 *  comma-split in `resolveFrontmatterTools` still works. Nested maps are
 *  JSON-stringified rather than `String()`-ified (which would emit the
 *  useless "[object Object]"). `null`/`undefined` are dropped. The agent
 *  frontmatter schema is flat by convention, so the object branch only fires
 *  on malformed input and keeps it debuggable instead of silently garbage. */
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
      const value = rawValue.trim();
      if (!value) return line;
      if (/^["'|>\[{]/.test(value)) return line;
      if (!/:\s/.test(value)) return line;
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${leading}${key}${sep}"${escaped}"`;
    })
    .join("\n");
}

/** Parse an agent Markdown frontmatter fence and return its body. */
export function parseFrontmatter(
  content: string,
  filePath?: string,
): {
  data: Record<string, string>;
  body: string;
} {
  const m = content.match(FRONTMATTER_FENCE);
  if (!m) return { data: {}, body: content.trim() };
  const yamlString = m[1]!;
  const body = m[2]!.trim();

  // A bare `*` is a YAML alias indicator and is invalid as a scalar, so
  // `tools: *` (the full-agent shorthand) would throw. Quote any value that is
  // exactly `*` so it parses as the string "*", which resolveFrontmatterTools
  // then expands via TOOL_GROUPS. (A `*` mid-scalar, e.g. `use * here`, is a
  // legal plain scalar and needs no quoting.)
  const sanitized = sanitizeYamlScalars(
    yamlString.replace(/^(\s*[\w-]+):\s*\*(?=\s*$)/gm, '$1: "*"'),
  );

  try {
    // Re-wrap and let pi's parser (yaml under the hood) do the real work.
    const { frontmatter, body: parsedBody } = parsePiFrontmatter(
      `---\n${sanitized}\n---\n${body}`,
    );
    return {
      data: frontmatterToData((frontmatter ?? {}) as Record<string, unknown>),
      body: parsedBody,
    };
  } catch (e) {
    // Malformed frontmatter is a user error, not a crash. Log a clear,
    // actionable message (with the file path when available) and return empty
    // data so the caller's `!data.name || !data.description` check skips the
    // file rather than importing a half-parsed agent.
    const where = filePath ? ` (${filePath})` : "";
    console.warn(
      `[delegate] malformed agent frontmatter${where}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    );
    return { data: {}, body: content.trim() };
  }
}

// ── Agent Discovery ───────────────────────────────────────────────────────

/** Find the nearest ancestor containing project-scoped agent files. */
export function findProjectRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    // A project root is any dir hosting a pi-native or Claude agent dir.
    // Recognizing .claude/agents here means a project using only Claude Code's
    // convention still resolves its project-scoped agents.
    if (
      fs.existsSync(path.join(dir, ".pi", "agents")) ||
      fs.existsSync(path.join(dir, ".claude", "agents"))
    )
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Map Claude Code's capitalized tool names to delegate's lowercase set.
 *  Unmappable tools (WebSearch, WebFetch, TodoWrite, …) are dropped — they are
 *  not delegate tools, and warning per imported agent would be noise. The map
 *  is exported for tests; do not call it for native pi frontmatter. */
const CLAUDE_TOOL_ALIASES: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  glob: "find",
  grep: "grep",
  ls: "ls",
};

/** Parse a `tools:` frontmatter value into a resolved tool list.
 *  Omitted or blank → inherit the full agent set (`*`), matching CC/OpenCode/
 *  Devin convention. This is the only caller-owned knob — both inline tasks
 *  and named agents now inherit-all when `tools:` is absent. */
function resolveFrontmatterTools(
  raw: string | undefined,
  aliasMap?: Record<string, string>,
): string[] {
  if (!raw) return DEFAULT_TOOLS; // omitted/blank → inherit *
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return DEFAULT_TOOLS;
  const mapped = aliasMap
    ? names
        .map((n) => aliasMap[n.toLowerCase()] ?? null)
        .filter((n): n is string => n !== null)
    : names;
  // Empty after aliasing (e.g. a Claude agent listing only WebSearch) → inherit.
  return mapped.length ? resolveToolGroups(mapped) : DEFAULT_TOOLS;
}

/** Parse and alias a comma-separated Claude tool list into delegate tool names,
 *  WITHOUT inheriting on empty. Returns the mapped names only (may be empty).
 *  Used when the result will be subtracted from a base set (disallowedTools). */
function mapClaudeToolNames(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => CLAUDE_TOOL_ALIASES[n.toLowerCase()] ?? null)
    .filter((n): n is string => n !== null);
}

/** Load a native Pi agent Markdown file, or null when it is invalid. */
export function loadAgentFile(filePath: string): AgentConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(content, filePath);
  if (!data.name || !data.description) return null;
  return {
    name: data.name,
    description: data.description,
    model: data.model,
    thinking: VALID_THINKING.has(data.thinking ?? "")
      ? (data.thinking as ThinkingLevel)
      : "off",
    // Omitted/blank `tools:` → inherit the full agent set (`*`), matching
    // CC/OpenCode/Devin. A previous version rejected empty tools; that was
    // stricter than every comparable tool and surprised anyone porting a
    // profile. Inline tasks still get `[]` as a deliberate escape hatch —
    // this code path only governs named-agent file loading.
    tools: resolveFrontmatterTools(data.tools),
    systemPrompt: body,
  };
}

/** Variant for `.claude/agents/*.md` files. Two Claude-specific adaptations:
 *  - Maps capitalized tool names (Read/Glob/…) to delegate tools, dropping
 *    unmappable ones (WebSearch, TodoWrite, …). Omitted `tools` inherits `*`.
 *  - Honors `disallowedTools` as a denylist layered on top of the resolved
 *    set (Claude semantics: denylist applies whether or not an allowlist is
 *    set). Since delegate has no runtime denylist, we bake it into `tools` at
 *    import time. A reviewer with `disallowedTools: Write, Edit` and no
 *    `tools` becomes `read, bash, grep, find, ls` — it does NOT silently
 *    inherit full tools.
 *  - `model: inherit` (Claude's default) is mapped to "omit" so the agent
 *    inherits the parent model; passing it through verbatim would crash
 *    resolveModel() with "model 'inherit' is not available". */
export function loadClaudeAgentFile(filePath: string): AgentConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(content, filePath);
  if (!data.name || !data.description) return null;

  let tools = resolveFrontmatterTools(data.tools, CLAUDE_TOOL_ALIASES);
  // disallowedTools is a denylist applied after the allowlist resolves.
  // Empty-after-mapping denylist (e.g. only unmappable names) → no-op.
  const denied = new Set(mapClaudeToolNames(data.disallowedTools));
  if (denied.size) tools = tools.filter((t) => !denied.has(t));

  return {
    name: data.name,
    description: data.description,
    // `inherit` is Claude's "use parent" default — drop it so we fall through
    // to parent-model inheritance. Any other value passes through verbatim.
    model:
      data.model && data.model.toLowerCase() === "inherit"
        ? undefined
        : data.model,
    thinking: VALID_THINKING.has(data.thinking ?? "")
      ? (data.thinking as ThinkingLevel)
      : "off",
    tools,
    systemPrompt: body,
  };
}

/** Discover native and Claude-compatible agents in priority order. */
export function discoverAgents(cwd: string): Map<string, AgentConfig> {
  // Discovery order for persisted Markdown agents (first definition wins;
  // later dirs cannot overwrite):
  //   1. project  .pi/agents            (highest priority)
  //   2. global   ~/.pi/agent/agents
  //   3. global   ~/.agents             (legacy)
  //   4. project  .claude/agents        (Claude Code interchange)
  //   5. global   ~/.claude/agents
  //
  // Custom agents are defined by the parent either inline in a task or as a
  // Markdown file in one of the directories above. Markdown agents are
  // examples of custom agents; the parent model can shape the subagent it
  // needs on each call.
  const projectRoot = findProjectRoot(cwd);
  const nativeDirs: { dir: string; scope: "project" | "global" }[] = [];
  if (projectRoot)
    nativeDirs.push({
      dir: path.join(projectRoot, ".pi", "agents"),
      scope: "project",
    });
  // Global user agents — same convention as skills, AGENTS.md, and pi-subagents
  nativeDirs.push({
    dir: path.join(os.homedir(), ".pi", "agent", "agents"),
    scope: "global",
  });
  nativeDirs.push({ dir: path.join(os.homedir(), ".agents"), scope: "global" }); // legacy

  const claudeDirs: { dir: string; scope: "claude" }[] = [];
  if (projectRoot)
    claudeDirs.push({
      dir: path.join(projectRoot, ".claude", "agents"),
      scope: "claude",
    });
  claudeDirs.push({
    dir: path.join(os.homedir(), ".claude", "agents"),
    scope: "claude",
  });

  const agents = new Map<string, AgentConfig>();
  const loadDir = (
    { dir, scope }: { dir: string; scope: AgentConfig["scope"] },
    loader: (fp: string) => AgentConfig | null,
  ) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.name.endsWith(".md") || e.name.endsWith(".chain.md")) continue;
      const cfg = loader(path.join(dir, e.name));
      if (cfg && !agents.has(cfg.name)) {
        cfg.scope = scope;
        agents.set(cfg.name, cfg);
      }
    }
  };

  for (const d of nativeDirs) loadDir(d, loadAgentFile);
  for (const d of claudeDirs) loadDir(d, loadClaudeAgentFile);

  return agents;
}

// ── Subagent Prompt Assembly ──────────────────────────────────────────────

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  "You are a helpful coding assistant.";

function firstNonBlank(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
}

/** Select the frozen, task, agent, or parent prompt for a subagent. */
export function buildSubagentSystemPrompt(options: {
  taskSystemPrompt?: string;
  agentSystemPrompt?: string;
  parentSystemPrompt?: string;
  pooledSystemPrompt?: string;
}): string {
  // Pooled agents already have a frozen prompt baked into their session state.
  // Return it unchanged so repeated sessionId calls do not re-resolve.
  if (options.pooledSystemPrompt?.trim()) return options.pooledSystemPrompt;

  // Return only the base prompt. AgentSession constructs the full system prompt
  // from this custom prompt + its own resource-loader discovery (skills,
  // AGENTS.md, active-tool snippets). We previously appended skills/AGENTS.md
  // here; that duplicated AgentSession's work.
  const base =
    firstNonBlank(
      options.taskSystemPrompt,
      options.agentSystemPrompt,
      options.parentSystemPrompt,
    ) ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT;

  return base;
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { DEFAULT_TOOLS, VALID_THINKING } from "./constants.ts";
import { resolveToolGroups } from "./tools.ts";
import { BUILTIN_AGENTS } from "./builtin-agents.ts";
import type { AgentConfig } from "./types.ts";

export function parseFrontmatter(content: string): {
  data: Record<string, string>;
  body: string;
} {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: content.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { data, body: m[2]!.trim() };
}

// ── Agent Discovery ───────────────────────────────────────────────────────

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

export function loadAgentFile(filePath: string): AgentConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(content);
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
  const { data, body } = parseFrontmatter(content);
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
    model: data.model && data.model.toLowerCase() === "inherit"
      ? undefined
      : data.model,
    thinking: VALID_THINKING.has(data.thinking ?? "")
      ? (data.thinking as ThinkingLevel)
      : "off",
    tools,
    systemPrompt: body,
  };
}

export function discoverAgents(cwd: string): Map<string, AgentConfig> {
  // Discovery order (first definition wins; later dirs cannot overwrite):
  //   1. project  .pi/agents            (highest priority)
  //   2. global   ~/.pi/agent/agents
  //   3. global   ~/.agents             (legacy)
  //   4. project  .claude/agents        (Claude Code interchange)
  //   5. global   ~/.claude/agents
  //   6. built-in scout/reviewer/workhorse  (lowest — superseded by any .md)
  //
  // Built-ins are seeded last so any same-named user markdown silently
  // supersedes them. That is the customization contract: a user who dislikes
  // a built-in drops a same-named .md anywhere above and wins.
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

  // Built-ins seeded last — superseded by any same-named user .md above.
  for (const builtin of BUILTIN_AGENTS) {
    if (!agents.has(builtin.name)) {
      agents.set(builtin.name, { ...builtin, scope: "builtin" });
    }
  }
  return agents;
}

export function loadSkill(name: string, cwd: string): string | null {
  const candidates = [
    // Project (standard → pi-specific)
    path.join(cwd, ".agents", "skills", name, "SKILL.md"),
    path.join(cwd, ".pi", "skills", name, "SKILL.md"),
    // User (standard → pi-specific)
    path.join(os.homedir(), ".agents", "skills", name, "SKILL.md"),
    path.join(os.homedir(), ".pi", "agent", "skills", name, "SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      /* skip */
    }
  }
  return null;
}

// ── AGENTS.md Loading ────────────────────────────────────────────────────

/** Load AGENTS.md context files for a given cwd, mirroring pi's discovery.
 *  Walks from cwd up to root, plus the global agent dir. Returns ordered
 *  list of file contents (global first, then ancestor → cwd). */
export function loadAgentsMdFiles(cwd: string): string[] {
  const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const seen = new Set<string>();
  const files: { priority: number; content: string }[] = [];

  const tryLoad = (dir: string, priority: number) => {
    for (const name of candidates) {
      const fp = path.join(dir, name);
      if (seen.has(fp)) return;
      seen.add(fp);
      try {
        const content = fs.readFileSync(fp, "utf-8").trim();
        if (content) {
          files.push({ priority, content });
          return; // found valid content, stop trying other candidates in this dir
        }
        // empty/whitespace-only file — treat as not found, fall through to next candidate
      } catch {
        /* skip */
      }
    }
  };

  // Global agent dir (highest priority for ordering, loaded first)
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  tryLoad(agentDir, 0);

  // Walk from root → cwd, stopping before filesystem root (no one puts AGENTS.md in /)
  const ancestorDirs: string[] = [];
  let current = path.resolve(cwd);
  const root = path.resolve("/");
  while (true) {
    ancestorDirs.unshift(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (let i = 0; i < ancestorDirs.length; i++) {
    if (ancestorDirs[i] === root) continue;
    tryLoad(ancestorDirs[i]!, i + 1);
  }

  return files.sort((a, b) => a.priority - b.priority).map((f) => f.content);
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

export function buildSubagentSystemPrompt(options: {
  taskSystemPrompt?: string;
  agentSystemPrompt?: string;
  parentSystemPrompt?: string;
  pooledSystemPrompt?: string;
  /**
   * Kept for API compatibility but no longer appended here. The AgentSession's
   * resource loader owns skill/AGENTS.md discovery and appends them to the
   * system prompt itself (via `_rebuildSystemPrompt`). Appending them here too
   * caused double-inclusion. These fields are accepted and ignored.
   */
  skillBodies?: string[];
  agentsMdFiles?: string[];
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

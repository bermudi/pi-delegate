import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { VALID_THINKING } from "./constants.ts";
import { resolveToolGroups } from "./tools.ts";
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
    if (fs.existsSync(path.join(dir, ".pi", "agents"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
    tools: data.tools
      ? resolveToolGroups(
          data.tools
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : [], // named agents must declare tools; empty triggers a resolution error
    systemPrompt: body,
  };
}

export function discoverAgents(cwd: string): Map<string, AgentConfig> {
  const dirs: { dir: string; scope: "project" | "global" }[] = [];
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot)
    dirs.push({
      dir: path.join(projectRoot, ".pi", "agents"),
      scope: "project",
    });
  // Global user agents — same convention as skills, AGENTS.md, and pi-subagents
  dirs.push({
    dir: path.join(os.homedir(), ".pi", "agent", "agents"),
    scope: "global",
  });
  dirs.push({ dir: path.join(os.homedir(), ".agents"), scope: "global" }); // legacy

  const agents = new Map<string, AgentConfig>();
  for (const { dir, scope } of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name.endsWith(".md") || e.name.endsWith(".chain.md")) continue;
      const cfg = loadAgentFile(path.join(dir, e.name));
      if (cfg && !agents.has(cfg.name)) {
        cfg.scope = scope;
        agents.set(cfg.name, cfg);
      }
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

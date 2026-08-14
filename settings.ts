import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { VALID_THINKING } from "./constants.ts";

export interface AgentOverride {
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
}

export interface DelegateSettings {
  agentOverrides?: Record<string, AgentOverride>;
  agentOverridesByParentModel?: Record<string, Record<string, AgentOverride>>;
}

/** Read and validate a JSON settings object, returning null on I/O or parse errors. */
export function readDelegateSettingsFile(
  filePath: string,
): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        `[delegate] ignoring malformed settings file ${filePath}: expected a JSON object.`,
      );
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    console.warn(
      `[delegate] could not read settings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeOverride(
  raw: unknown,
  source: string,
  agentName: string,
): AgentOverride | null {
  if (!isRecord(raw)) {
    console.warn(
      `[delegate] ignoring malformed settings override for agent '${agentName}' in ${source}: expected an object.`,
    );
    return null;
  }

  const result: AgentOverride = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "model") {
      if (typeof value !== "string" || value.trim().length === 0) {
        console.warn(
          `[delegate] ignoring malformed settings override for agent '${agentName}' in ${source}: model must be a nonempty string.`,
        );
        return null;
      }
      result.model = value.trim();
    } else if (key === "thinking") {
      if (typeof value !== "string" || !VALID_THINKING.has(value)) {
        console.warn(
          `[delegate] ignoring malformed settings override for agent '${agentName}' in ${source}: thinking must be a supported level.`,
        );
        return null;
      }
      result.thinking = value as ThinkingLevel;
    } else if (key === "tools") {
      if (
        !Array.isArray(value) ||
        value.some((tool) => typeof tool !== "string")
      ) {
        console.warn(
          `[delegate] ignoring malformed settings override for agent '${agentName}' in ${source}: tools must be a string array.`,
        );
        return null;
      }
      result.tools = [...value];
    } else if (key === "skills") {
      console.warn(
        `[delegate] ignoring unsupported skills override for agent '${agentName}' in ${source}: per-agent skill filtering is not supported.`,
      );
      return null;
    } else {
      console.warn(
        `[delegate] ignoring malformed settings override for agent '${agentName}' in ${source}: unknown field '${key}'.`,
      );
      return null;
    }
  }
  return result;
}

function normalizeOverrides(
  raw: unknown,
  source: string,
): Record<string, AgentOverride> {
  if (!isRecord(raw)) {
    console.warn(
      `[delegate] ignoring malformed agentOverrides in ${source}: expected an object.`,
    );
    return {};
  }

  const result: Record<string, AgentOverride> = {};
  for (const [agentName, value] of Object.entries(raw)) {
    if (agentName.trim().length === 0) {
      console.warn(
        `[delegate] ignoring malformed settings override in ${source}: agent name must be nonempty.`,
      );
      continue;
    }
    const override = normalizeOverride(value, source, agentName);
    if (override) result[agentName] = override;
  }
  return result;
}

function normalizeOverridesByParentModel(
  raw: unknown,
  source: string,
): Record<string, Record<string, AgentOverride>> {
  if (!isRecord(raw)) {
    console.warn(
      `[delegate] ignoring malformed agentOverridesByParentModel in ${source}: expected an object.`,
    );
    return {};
  }

  const result: Record<string, Record<string, AgentOverride>> = {};
  for (const [parentModel, overrides] of Object.entries(raw)) {
    if (parentModel.trim().length === 0) {
      console.warn(
        `[delegate] ignoring malformed parent-model override in ${source}: model key must be nonempty.`,
      );
      continue;
    }
    result[parentModel] = normalizeOverrides(
      overrides,
      `${source} (parent model '${parentModel}')`,
    );
  }
  return result;
}

function getDelegateSettings(filePath: string): DelegateSettings | null {
  const settings = readDelegateSettingsFile(filePath);
  if (
    !settings?.delegate ||
    typeof settings.delegate !== "object" ||
    Array.isArray(settings.delegate)
  ) {
    if (settings?.delegate !== undefined) {
      console.warn(
        `[delegate] ignoring malformed delegate settings in ${filePath}: expected an object.`,
      );
    }
    return null;
  }
  const raw = settings.delegate as Record<string, unknown>;
  const result: DelegateSettings = {};
  if (raw.agentOverrides !== undefined) {
    result.agentOverrides = normalizeOverrides(raw.agentOverrides, filePath);
  }
  if (raw.agentOverridesByParentModel !== undefined) {
    result.agentOverridesByParentModel = normalizeOverridesByParentModel(
      raw.agentOverridesByParentModel,
      filePath,
    );
  }
  return result;
}

const delegateSettingsCache = new Map<string, DelegateSettings | null>();

/** Load merged delegate settings: project overrides user.
 * Result is cached per cwd until the next delegate dispatch clears it. */
export function loadDelegateSettings(cwd: string): DelegateSettings | null {
  const key = path.resolve(cwd);
  const cached = delegateSettingsCache.get(key);
  if (cached !== undefined) return cached;

  const userPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  // Look for project root by finding .pi/ directory, not just .pi/agents/
  let projectPath: string | null = null;
  let dir = key;
  const root = path.resolve("/");
  while (true) {
    if (fs.existsSync(path.join(dir, ".pi"))) {
      projectPath = path.join(dir, ".pi", "settings.json");
      break;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const user = getDelegateSettings(userPath);
  const project = projectPath ? getDelegateSettings(projectPath) : null;

  if (!user && !project) {
    delegateSettingsCache.set(key, null);
    return null;
  }
  const result: DelegateSettings = {
    ...(user?.agentOverrides || project?.agentOverrides
      ? {
          agentOverrides: mergeOverrides(
            user?.agentOverrides,
            project?.agentOverrides,
          ),
        }
      : {}),
    ...(user?.agentOverridesByParentModel ||
    project?.agentOverridesByParentModel
      ? {
          agentOverridesByParentModel: mergeParentModelOverrides(
            user?.agentOverridesByParentModel,
            project?.agentOverridesByParentModel,
          ),
        }
      : {}),
  };
  delegateSettingsCache.set(key, result);
  return result;
}

function mergeOverride(
  base: AgentOverride | undefined,
  override: AgentOverride | undefined,
): AgentOverride {
  return { ...(base ?? {}), ...(override ?? {}) };
}

function mergeOverrides(
  user: Record<string, AgentOverride> | undefined,
  project: Record<string, AgentOverride> | undefined,
): Record<string, AgentOverride> {
  const result: Record<string, AgentOverride> = {};
  for (const name of new Set([
    ...Object.keys(user ?? {}),
    ...Object.keys(project ?? {}),
  ])) {
    result[name] = mergeOverride(user?.[name], project?.[name]);
  }
  return result;
}

function mergeParentModelOverrides(
  user: Record<string, Record<string, AgentOverride>> | undefined,
  project: Record<string, Record<string, AgentOverride>> | undefined,
): Record<string, Record<string, AgentOverride>> {
  const result: Record<string, Record<string, AgentOverride>> = {};
  for (const model of new Set([
    ...Object.keys(user ?? {}),
    ...Object.keys(project ?? {}),
  ])) {
    result[model] = mergeOverrides(user?.[model], project?.[model]);
  }
  return result;
}

/** Clear settings read from earlier delegate calls so edits are visible. */
export function clearDelegateSettingsCache(): void {
  delegateSettingsCache.clear();
}

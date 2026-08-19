import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { VALID_THINKING } from "./constants.ts";

/**
 * Legacy pi-settings detection — nothing more.
 *
 * Delegate configuration lives exclusively in `~/.pi/agent/delegate.json`
 * (user scope, global; no project-level discovery). The former
 * `delegate.agentOverrides` / `delegate.agentOverridesByParentModel` blocks in
 * pi's `settings.json` — user-scope and project `.pi/settings.json` — are no
 * longer read as configuration. The dispatch boundary only uses this module's
 * detector to warn that overrides moved. `loadDelegateSettings` remains as an
 * isolated deprecated compatibility reader for external callers; its result
 * must never feed configuration into delegation.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function settingsCarryDelegateBlock(filePath: string): boolean {
  const parsed = readDelegateSettingsFile(filePath);
  return parsed !== null && isRecord(parsed.delegate);
}

/** Paths of pi settings files (user + nearest project `.pi/settings.json`)
 *  that still carry a `delegate` block. Fail-open: never throws. */
export function findLegacyDelegateSettings(cwd: string): string[] {
  const paths: string[] = [];
  try {
    const userPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    if (settingsCarryDelegateBlock(userPath)) paths.push(userPath);

    // Nearest `.pi` directory walking up from cwd — the same discovery the
    // old loader used, so a project that relied on overrides is still caught.
    let dir = path.resolve(cwd);
    const root = path.resolve("/");
    for (;;) {
      if (fs.existsSync(path.join(dir, ".pi"))) {
        const projectPath = path.join(dir, ".pi", "settings.json");
        if (settingsCarryDelegateBlock(projectPath)) paths.push(projectPath);
        break;
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Detection is best-effort; it must never block a dispatch.
  }
  return paths;
}

const warnedLegacyDirs = new Set<string>();

/** Shape returned by the deprecated compatibility loader. Delegate itself no
 * longer consumes these settings; new configuration belongs in delegate.json.
 */
export interface DelegateSettings {
  agentOverrides?: Record<string, AgentOverride>;
  agentOverridesByParentModel?: Record<string, Record<string, AgentOverride>>;
}

export interface AgentOverride {
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
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
  const seenNames = new Map<string, string>();
  for (const [agentName, value] of Object.entries(raw)) {
    const normalizedAgentName = agentName.trim();
    if (normalizedAgentName.length === 0) {
      console.warn(
        `[delegate] ignoring malformed settings override in ${source}: agent name must be nonempty.`,
      );
      continue;
    }
    const previousName = seenNames.get(normalizedAgentName);
    if (previousName !== undefined) {
      console.warn(
        `[delegate] ignoring duplicate settings override in ${source}: agent keys '${previousName}' and '${agentName}' both normalize to '${normalizedAgentName}'.`,
      );
      continue;
    }
    seenNames.set(normalizedAgentName, agentName);
    const override = normalizeOverride(value, source, normalizedAgentName);
    if (override) result[normalizedAgentName] = override;
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
  const seenModels = new Map<string, string>();
  for (const [parentModel, overrides] of Object.entries(raw)) {
    const normalizedParentModel = parentModel.trim();
    if (normalizedParentModel.length === 0) {
      console.warn(
        `[delegate] ignoring malformed parent-model override in ${source}: model key must be nonempty.`,
      );
      continue;
    }
    const previousModel = seenModels.get(normalizedParentModel);
    if (previousModel !== undefined) {
      console.warn(
        `[delegate] ignoring duplicate parent-model override in ${source}: model keys '${previousModel}' and '${parentModel}' both normalize to '${normalizedParentModel}'.`,
      );
      continue;
    }
    seenModels.set(normalizedParentModel, parentModel);
    result[normalizedParentModel] = normalizeOverrides(
      overrides,
      `${source} (parent model '${normalizedParentModel}')`,
    );
  }
  return result;
}

function readLegacyDelegateSettings(filePath: string): DelegateSettings | null {
  const settings = readDelegateSettingsFile(filePath);
  if (!isRecord(settings?.delegate)) {
    if (settings?.delegate !== undefined) {
      console.warn(
        `[delegate] ignoring malformed delegate settings in ${filePath}: expected an object.`,
      );
    }
    return null;
  }

  const result: DelegateSettings = {};
  if (settings.delegate.agentOverrides !== undefined) {
    result.agentOverrides = normalizeOverrides(
      settings.delegate.agentOverrides,
      filePath,
    );
  }
  if (settings.delegate.agentOverridesByParentModel !== undefined) {
    result.agentOverridesByParentModel = normalizeOverridesByParentModel(
      settings.delegate.agentOverridesByParentModel,
      filePath,
    );
  }
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

const legacySettingsCache = new Map<string, DelegateSettings | null>();

/**
 * @deprecated Reads the legacy user/project settings for callers that already
 * depend on this API. It accepts a working directory and returns the merged
 * view (project fields override user fields). Delegate never consumes this
 * result; use delegate.json for actual delegate configuration.
 */
export function loadDelegateSettings(cwd: string): DelegateSettings | null {
  const key = path.resolve(cwd);
  const cached = legacySettingsCache.get(key);
  if (cached !== undefined) return cached;

  const userPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  let projectPath: string | undefined;
  let dir = key;
  const root = path.resolve("/");
  for (;;) {
    if (fs.existsSync(path.join(dir, ".pi"))) {
      projectPath = path.join(dir, ".pi", "settings.json");
      break;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const user = readLegacyDelegateSettings(userPath);
  const project = projectPath ? readLegacyDelegateSettings(projectPath) : null;
  if (!user && !project) {
    legacySettingsCache.set(key, null);
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
  legacySettingsCache.set(key, result);
  return result;
}

/** Warn (once per cwd) when pi settings files still carry a legacy `delegate`
 *  block. Those overrides are ignored — delegate.json is the only source.
 *  Only marks the cwd as warned after at least one legacy block is reported, so
 *  a block added later is still surfaced. */
export function warnLegacyDelegateSettingsMoved(cwd: string): void {
  const key = path.resolve(cwd);
  if (warnedLegacyDirs.has(key)) return;
  const paths = findLegacyDelegateSettings(cwd);
  if (paths.length === 0) return;
  warnedLegacyDirs.add(key);
  for (const filePath of paths) {
    console.warn(
      `[delegate] ignoring 'delegate' block in ${filePath}: delegate configuration lives in ~/.pi/agent/delegate.json (agentOverrides / agentOverridesByParentModel).`,
    );
  }
}

/** @deprecated Clear the set of cwd's already warned about legacy settings. */
export function clearDelegateSettingsCache(): void {
  warnedLegacyDirs.clear();
  legacySettingsCache.clear();
}

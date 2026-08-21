import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { VALID_THINKING } from "./constants.ts";

/**
 * One-release compatibility bridge for delegate overrides formerly stored in
 * Pi's user/project settings.json. Only model and thinking are bridged; tools
 * remain operator-controlled because project files must not restore shell
 * capability. Modern delegate.json values win field-by-field.
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

interface LegacyDetectionCacheEntry {
  signature: string;
  carriesDelegateBlock: boolean;
}

const legacyDetectionCache = new Map<string, LegacyDetectionCacheEntry>();
const warnedLegacyDetectionFailures = new Set<string>();

/** A cheap file identity used to invalidate cached misses and parse failures
 * when a settings file is created or edited. */
function settingsFileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return [
      "present",
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      stat.mode,
    ].join(":");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "missing";
    }
    // An inaccessible or otherwise unstatable file is not a stable miss. Let
    // the read path report it on each attempt rather than hiding a later fix.
    return `unstatable:${Date.now()}`;
  }
}

function settingsCarryDelegateBlock(filePath: string): boolean {
  const key = path.resolve(filePath);
  const signature = settingsFileSignature(key);
  const cached = legacyDetectionCache.get(key);
  if (cached?.signature === signature) return cached.carriesDelegateBlock;

  const parsed = readDelegateSettingsFile(key);
  const carriesDelegateBlock = parsed !== null && isRecord(parsed.delegate);
  legacyDetectionCache.set(key, { signature, carriesDelegateBlock });
  return carriesDelegateBlock;
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
  } catch (error) {
    // Detection is best-effort and must never block a dispatch, but silently
    // losing the migration signal would make ignored legacy overrides hard to
    // diagnose. Report each affected cwd once to avoid warning floods when a
    // dispatch resolves several tasks in the same project.
    if (!warnedLegacyDetectionFailures.has(cwd)) {
      warnedLegacyDetectionFailures.add(cwd);
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[delegate] could not check for legacy delegate settings from '${cwd}': ${detail}. Overrides in pi settings.json may be ignored; move them to ~/.pi/agent/delegate.json.`,
      );
    }
  }
  return paths;
}

const warnedLegacySources = new Set<string>();

/** Shape returned by the temporary compatibility loader. */
export interface DelegateSettings {
  agentOverrides?: Record<string, AgentOverride>;
  agentOverridesByParentModel?: Record<string, Record<string, AgentOverride>>;
}

export interface AgentOverride {
  model?: string;
  thinking?: ThinkingLevel;
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
      console.warn(
        `[delegate] ignoring legacy tools override for agent '${agentName}' in ${source}: the temporary compatibility bridge honors only model and thinking.`,
      );
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

  const result = Object.create(null) as Record<string, AgentOverride>;
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

  const result = Object.create(null) as Record<
    string,
    Record<string, AgentOverride>
  >;
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
  const result = Object.create(null) as Record<string, AgentOverride>;
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
  const result = Object.create(null) as Record<
    string,
    Record<string, AgentOverride>
  >;
  for (const model of new Set([
    ...Object.keys(user ?? {}),
    ...Object.keys(project ?? {}),
  ])) {
    result[model] = mergeOverrides(user?.[model], project?.[model]);
  }
  return result;
}

/**
 * Temporary compatibility reader. It accepts a working directory and returns
 * the merged view (project fields override user fields). Deliberately rereads
 * the two small JSON files: this bridge lasts one release, and avoiding a cache
 * makes file create/edit/delete visible on the very next dispatch.
 */
export function loadDelegateSettings(cwd: string): DelegateSettings | null {
  const key = path.resolve(cwd);
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
  return result;
}

/** Warn (once per cwd) when pi settings files still carry a legacy `delegate`
 * block. The same message goes to stderr and, when available, the TUI. Keys
 * include both cwd and source so a newly-created project setting is not hidden
 * by an earlier user-setting warning. */
export function warnLegacyDelegateSettingsMoved(
  cwd: string,
  notify?: (message: string) => void,
): void {
  const cwdKey = path.resolve(cwd);
  const paths = findLegacyDelegateSettings(cwd);
  if (paths.length === 0) return;
  for (const filePath of paths) {
    const warningKey = `${cwdKey}\0${filePath}`;
    if (warnedLegacySources.has(warningKey)) continue;
    warnedLegacySources.add(warningKey);
    const message =
      `[delegate] TEMPORARY legacy compatibility: using model/thinking overrides from ${filePath}. ` +
      "Move user-global overrides to ~/.pi/agent/delegate.json. Project-local overrides have no future config-file equivalent; use .pi/agents/*.md or explicit task model/thinking fields. " +
      "Legacy settings compatibility is available for v0.1.12 only and will be removed in v0.1.13. Legacy tools overrides are not honored.";
    console.warn(message);
    try {
      notify?.(message);
    } catch (error) {
      console.error(
        "[delegate] legacy settings TUI notification failed",
        error,
      );
    }
  }
}

/** @deprecated Clear the set of cwd's already warned about legacy settings. */
export function clearDelegateSettingsCache(): void {
  warnedLegacySources.clear();
  warnedLegacyDetectionFailures.clear();
  legacyDetectionCache.clear();
}

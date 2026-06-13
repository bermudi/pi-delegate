import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DelegateSettings {
  agentOverrides?: Record<
    string,
    { model?: string; thinking?: string; tools?: string[]; skills?: string[] }
  >;
}

export function readDelegateSettingsFile(
  filePath: string,
): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getDelegateSettings(filePath: string): DelegateSettings | null {
  const settings = readDelegateSettingsFile(filePath);
  if (
    !settings?.delegate ||
    typeof settings.delegate !== "object" ||
    Array.isArray(settings.delegate)
  )
    return null;
  return settings.delegate as DelegateSettings;
}

/** Load merged delegate settings: project overrides user.
 *  Result is cached per cwd for the lifetime of the delegate call. */
const delegateSettingsCache = new Map<string, DelegateSettings | null>();
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
    agentOverrides: {
      ...(user?.agentOverrides ?? {}),
      ...(project?.agentOverrides ?? {}),
    },
  };
  delegateSettingsCache.set(key, result);
  return result;
}

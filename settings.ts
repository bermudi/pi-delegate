import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Legacy pi-settings detection — nothing more.
 *
 * Delegate configuration lives exclusively in `~/.pi/agent/delegate.json`
 * (user scope, global; no project-level discovery). The former
 * `delegate.agentOverrides` / `delegate.agentOverridesByParentModel` blocks in
 * pi's `settings.json` — user-scope and project `.pi/settings.json` — are no
 * longer read as configuration. This module only detects those blocks so the
 * dispatch boundary can warn that the overrides moved; it must never feed
 * configuration into delegation.
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
}

/** @deprecated Use `readDelegateSettingsFile` instead. */
export const loadDelegateSettings = readDelegateSettingsFile;

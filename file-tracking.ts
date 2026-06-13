import { execFile } from "node:child_process";
import * as path from "node:path";
import type { ToolActivity } from "./types.ts";

export async function getGitChangedFiles(cwd: string): Promise<Set<string>> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["status", "--porcelain", "--untracked-files=all"],
        { cwd, timeout: 5000 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
    const files = new Set<string>();
    for (const line of result.split("\n")) {
      if (line.length < 4) continue;
      const rawPath = line.slice(3).trim();
      if (!rawPath) continue;
      const targetPath = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").at(-1)
        : rawPath;
      if (targetPath)
        files.add(path.resolve(cwd, targetPath.replace(/^"|"$/g, "")));
    }
    return files;
  } catch {
    return new Set();
  }
}

/** Extract file paths mutated by edit/write from the activity log. */
export function extractTouchedFromActivities(
  activities: ToolActivity[],
  cwd: string,
): string[] {
  const files = new Set<string>();
  for (const a of activities) {
    if (a.name !== "edit" && a.name !== "write") continue;
    const raw = a.args?.path ?? a.args?.file_path ?? a.args?.filePath;
    if (typeof raw !== "string" || !raw) continue;
    files.add(path.resolve(cwd, raw));
  }
  return [...files];
}

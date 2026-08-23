import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolActivity } from "./types.ts";

function activityPath(
  activity: Pick<ToolActivity, "args">,
  cwd: string,
): string | undefined {
  const raw =
    activity.args?.path ?? activity.args?.file_path ?? activity.args?.filePath;
  return typeof raw === "string" && raw ? path.resolve(cwd, raw) : undefined;
}

/**
 * Capture the physical target of an edit/write call before tool work begins.
 *
 * realpathSync handles an existing symlink leaf directly. For a target that
 * does not yet exist, walk to a resolvable ancestor and append the missing
 * suffix, preserving write-through attribution through symlinked directories.
 * Dangling symlinks retain their intended target conservatively. `undefined`
 * means canonicalization was ambiguous; callers then keep the lexical path.
 */
export function snapshotPhysicalToolTarget(
  activity: Pick<ToolActivity, "args">,
  cwd: string,
): string | undefined {
  const candidate = activityPath(activity, cwd);
  if (!candidate) return undefined;

  const resolvePhysical = (
    value: string,
    seen: Set<string>,
  ): string | undefined => {
    const absolute = path.resolve(value);
    if (seen.has(absolute)) return undefined;
    seen.add(absolute);

    try {
      return fs.realpathSync.native(absolute);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }

    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        return resolvePhysical(
          path.resolve(path.dirname(absolute), target),
          seen,
        );
      }
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }

    const parent = path.dirname(absolute);
    if (parent === absolute) return undefined;
    const physicalParent = resolvePhysical(parent, seen);
    return physicalParent
      ? path.resolve(physicalParent, path.basename(absolute))
      : undefined;
  };

  return resolvePhysical(candidate, new Set<string>());
}

/**
 * Return absolute paths reported as changed by Git in the task cwd.
 *
 * Touched-file tracking is best-effort, not authoritative. On success this
 * returns the set of changed paths (possibly empty for a clean repo). On
 * failure (non-git directory, git unavailable, timeout) it returns `undefined`
 * so callers can tell "git failed" from "clean repo". A failed baseline
 * suppresses git-based attribution in the runner; only explicit edit/write tool
 * activity is captured by {@link extractTouchedFromActivities}.
 */
export async function getGitChangedFiles(
  cwd: string,
): Promise<Set<string> | undefined> {
  try {
    const runGit = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });
    const repoRoot = (await runGit(["rev-parse", "--show-toplevel"])).trim();
    const result = await runGit([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
    ]);
    const files = new Set<string>();
    const entries = result.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.length < 4) continue;

      const status = entry.slice(0, 2);
      const rawPath = entry.slice(3);
      const isRenameOrCopy = status.includes("R") || status.includes("C");
      if (rawPath) files.add(path.resolve(repoRoot, rawPath));

      // With -z, Git emits the destination first and the source second for
      // rename/copy entries. Consume the source so it is not reported too.
      if (isRenameOrCopy) i++;
    }
    return files;
  } catch {
    return undefined;
  }
}

/**
 * Extract file paths from explicit edit/write tool calls in the activity log.
 *
 * This is the conservative, activity-based contribution to touched-file
 * tracking. Every started edit/write call with a usable path is counted:
 * write/edit tools can mutate before returning an error, and cancellation can
 * interrupt them after mutation but before a terminal result is emitted.
 * bash mutations are NOT captured here; they are only captured by git diff when
 * the task cwd is inside a git repo with git available. The combined
 * touchedFiles list is therefore still a lower bound: absence does not mean a
 * file was unchanged.
 */
export function extractTouchedFromActivities(
  activities: ToolActivity[],
  cwd: string,
): string[] {
  const files = new Set<string>();
  for (const activity of activities) {
    if (activity.name !== "edit" && activity.name !== "write") continue;
    const lexicalPath = activityPath(activity, cwd);
    if (lexicalPath) files.add(lexicalPath);
  }
  return [...files];
}

/** Physical edit/write evidence attributable to this run. The execution-time
 * snapshot wins over the mutable final filesystem view. */
export function extractAttributedFromActivities(
  activities: ToolActivity[],
  cwd: string,
): string[] {
  const files = new Set<string>();
  for (const activity of activities) {
    if (activity.name !== "edit" && activity.name !== "write") continue;
    const target = activity.physicalTarget ?? activityPath(activity, cwd);
    if (target) files.add(target);
  }
  return [...files];
}

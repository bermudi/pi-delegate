import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileAttribution, ToolActivity } from "./types.ts";

function activityPath(
  activity: Pick<ToolActivity, "args">,
  cwd: string,
): string | undefined {
  const raw =
    activity.args?.path ?? activity.args?.file_path ?? activity.args?.filePath;
  return typeof raw === "string" && raw ? path.resolve(cwd, raw) : undefined;
}

function errnoOf(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "UNKNOWN")
    : "UNKNOWN";
}

function logCanonicalizationFailure(candidate: string, error: unknown): void {
  console.error(
    `[delegate] could not canonicalize edit/write target '${candidate}' (errno=${errnoOf(error)}); retaining uncertain lexical attribution`,
  );
}

interface PhysicalSnapshot {
  path?: string;
  uncertain: boolean;
}

/**
 * Capture edit/write attribution before tool work begins.
 *
 * realpathSync handles an existing symlink leaf directly. For a target that
 * does not yet exist, walk to a resolvable ancestor and append the missing
 * suffix, preserving write-through attribution through symlinked directories.
 * Dangling symlinks retain their intended target but are marked uncertain.
 * Non-ENOENT/ENOTDIR failures are actionable and logged with the lexical
 * candidate and errno; callers retain that uncertain lexical evidence.
 */
export function snapshotPhysicalToolTarget(
  activity: Pick<ToolActivity, "args" | "name">,
  cwd: string,
): FileAttribution | undefined {
  if (activity.name !== "edit" && activity.name !== "write") return undefined;
  const candidate = activityPath(activity, cwd);
  if (!candidate) return undefined;

  const resolvePhysical = (
    value: string,
    seen: Set<string>,
  ): PhysicalSnapshot => {
    const absolute = path.resolve(value);
    if (seen.has(absolute)) return { uncertain: true };
    seen.add(absolute);

    try {
      return { path: fs.realpathSync.native(absolute), uncertain: false };
    } catch (error) {
      const code = errnoOf(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        logCanonicalizationFailure(candidate, error);
        return { uncertain: true };
      }
    }

    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        const resolved = resolvePhysical(
          path.resolve(path.dirname(absolute), target),
          seen,
        );
        return { ...resolved, uncertain: true };
      }
    } catch (error) {
      const code = errnoOf(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        logCanonicalizationFailure(candidate, error);
        return { uncertain: true };
      }
    }

    const parent = path.dirname(absolute);
    if (parent === absolute) return { uncertain: true };
    const physicalParent = resolvePhysical(parent, seen);
    return {
      path: physicalParent.path
        ? path.resolve(physicalParent.path, path.basename(absolute))
        : undefined,
      uncertain: physicalParent.uncertain,
    };
  };

  const snapshot = resolvePhysical(candidate, new Set<string>());
  return {
    lexicalPath: candidate,
    preExecutionPhysicalPath: snapshot.path,
    provenance: activity.name,
    uncertain: snapshot.uncertain,
  };
}

/** Stable string projection used for overlap reporting. */
export function projectedAttributionPath(attribution: FileAttribution): string {
  return attribution.preExecutionPhysicalPath ?? attribution.lexicalPath;
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

/** Provenance-bearing edit/write evidence attributable to this run. */
export function extractAttributedFromActivities(
  activities: ToolActivity[],
  cwd: string,
): FileAttribution[] {
  const files = new Map<string, FileAttribution>();
  for (const activity of activities) {
    if (activity.name !== "edit" && activity.name !== "write") continue;
    const lexicalPath = activityPath(activity, cwd);
    const attribution =
      activity.fileAttribution ??
      (lexicalPath
        ? {
            lexicalPath,
            provenance: activity.name,
            uncertain: true,
          }
        : undefined);
    if (!attribution) continue;
    const key = `${attribution.provenance}\0${attribution.lexicalPath}\0${attribution.preExecutionPhysicalPath ?? ""}\0${attribution.uncertain}`;
    files.set(key, attribution);
  }
  return [...files.values()];
}

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FileAttribution,
  FileAttributionPathSignature,
  ToolActivity,
} from "./types.ts";

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

function safePathForLog(candidate: string): string {
  const limit = 1_024;
  const sanitized =
    candidate.length > limit
      ? `${candidate.slice(0, limit)}…[truncated ${candidate.length - limit} chars]`
      : candidate;
  // JSON escaping keeps model-supplied control characters out of the terminal.
  return JSON.stringify(sanitized)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function logCanonicalizationFailure(candidate: string, error: unknown): void {
  console.error(
    `[delegate] could not canonicalize edit/write target ${safePathForLog(candidate)} (errno=${errnoOf(error)}); retaining uncertain lexical attribution`,
  );
}

function statKind(stat: fs.Stats): FileAttributionPathSignature["kind"] {
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function signatureOf(
  candidate: string,
  stat: fs.Stats,
  symlinkTarget?: string,
): FileAttributionPathSignature {
  return {
    path: candidate,
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeMs: stat.birthtimeMs,
    kind: statKind(stat),
    ...(symlinkTarget === undefined ? {} : { symlinkTarget }),
  };
}

function sameSignature(
  left: FileAttributionPathSignature,
  right: FileAttributionPathSignature,
): boolean {
  return (
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs &&
    left.kind === right.kind &&
    left.symlinkTarget === right.symlinkTarget
  );
}

interface PhysicalSnapshot {
  path?: string;
  uncertain: boolean;
  signatures: FileAttributionPathSignature[];
}

function pathParts(value: string): { root: string; parts: string[] } {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  return {
    root,
    parts: absolute.slice(root.length).split(path.sep).filter(Boolean),
  };
}

/** Resolve one component at a time so the physical snapshot carries the exact
 * ancestor/symlink identities that justified it. */
function resolvePhysicalSnapshot(
  value: string,
  logCandidate: string,
): PhysicalSnapshot {
  let { root, parts } = pathParts(value);
  let cursor = root;
  let uncertain = false;
  const signatures: FileAttributionPathSignature[] = [];
  const followed = new Set<string>();
  let symlinkExpansions = 0;

  while (parts.length) {
    const component = parts.shift()!;
    const candidate = path.join(cursor, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      const code = errnoOf(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        // A missing or unresolved component can be created or replaced before
        // the tool opens it. Without an identity to guard that transition, the
        // projected target must remain conservative even on a purely lexical
        // path with no symlink seen yet.
        return {
          path: path.resolve(candidate, ...parts),
          uncertain: true,
          signatures,
        };
      }
      logCanonicalizationFailure(logCandidate, error);
      return { uncertain: true, signatures };
    }

    if (stat.isSymbolicLink()) {
      symlinkExpansions++;
      if (symlinkExpansions > 256) {
        logCanonicalizationFailure(
          logCandidate,
          Object.assign(new Error("too many symbolic links"), {
            code: "ELOOP",
          }),
        );
        return { uncertain: true, signatures };
      }
      let target: string;
      try {
        target = fs.readlinkSync(candidate);
        const afterRead = fs.lstatSync(candidate);
        const before = signatureOf(candidate, stat, target);
        const after = signatureOf(candidate, afterRead, target);
        signatures.push(before);
        if (!sameSignature(before, after) || !afterRead.isSymbolicLink()) {
          uncertain = true;
        }
      } catch (error) {
        const code = errnoOf(error);
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EINVAL") {
          logCanonicalizationFailure(logCandidate, error);
        }
        return { path: candidate, uncertain: true, signatures };
      }
      const cycleKey = `${candidate}\0${target}`;
      if (followed.has(cycleKey)) {
        logCanonicalizationFailure(
          logCandidate,
          Object.assign(new Error("symbolic link cycle"), { code: "ELOOP" }),
        );
        return { uncertain: true, signatures };
      }
      followed.add(cycleKey);
      const targetPath = path.isAbsolute(target)
        ? target
        : path.resolve(path.dirname(candidate), target);
      const targetParts = pathParts(targetPath);
      root = targetParts.root;
      cursor = root;
      parts = [...targetParts.parts, ...parts];
      continue;
    }

    // Every existing component is an identity guard, including the leaf. An
    // in-place edit preserves the leaf identity; replacement or creation does
    // not, and may redirect the write through a newly installed symlink.
    signatures.push(signatureOf(candidate, stat));
    cursor = candidate;
  }

  return { path: cursor, uncertain, signatures };
}

/**
 * Capture edit/write attribution before tool work begins.
 *
 * The target is resolved component by component while recording the identity
 * of every existing component, including the leaf, and the text of every
 * followed symlink. Missing or dangling components retain their projected path
 * but are uncertain because creation can redirect the eventual tool open.
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

  const snapshot = resolvePhysicalSnapshot(candidate, candidate);
  const attribution: FileAttribution = {
    lexicalPath: candidate,
    preExecutionPhysicalPath: snapshot.path,
    preExecutionPathSignatures: snapshot.signatures,
    provenance: activity.name,
    uncertain: snapshot.uncertain,
  };
  // Close lstat/readlink and component-walk races before execution starts. A
  // later terminal revalidation performs the same check after execution.
  return revalidateFileAttribution(attribution);
}

/** Revalidate the identities used by a pre-execution physical snapshot without
 * re-resolving that snapshot through the mutable final tree. */
export function revalidateFileAttribution(
  attribution: FileAttribution,
): FileAttribution {
  if (
    attribution.uncertain ||
    !attribution.preExecutionPathSignatures?.length
  ) {
    return attribution;
  }
  for (const expected of attribution.preExecutionPathSignatures) {
    try {
      const stat = fs.lstatSync(expected.path);
      let target: string | undefined;
      if (stat.isSymbolicLink()) target = fs.readlinkSync(expected.path);
      if (!sameSignature(expected, signatureOf(expected.path, stat, target))) {
        return { ...attribution, uncertain: true };
      }
    } catch (error) {
      const code = errnoOf(error);
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EINVAL") {
        logCanonicalizationFailure(attribution.lexicalPath, error);
      }
      return { ...attribution, uncertain: true };
    }
  }
  return attribution;
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
    const revalidated = revalidateFileAttribution(attribution);
    const key = `${revalidated.provenance}\0${revalidated.lexicalPath}\0${revalidated.preExecutionPhysicalPath ?? ""}\0${revalidated.uncertain}`;
    files.set(key, revalidated);
  }
  return [...files.values()];
}

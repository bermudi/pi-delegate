/**
 * Path containment primitives for the subagent trust boundary.
 *
 * These decide whether a resolved package directory is allowed to become
 * executable subagent code, so they compare **canonical** paths: a symlink
 * whose target escapes an install root must not be able to launder itself
 * through a lexically-innocent path.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a path through symlinks, or `undefined` if the path cannot be
 * canonicalized.
 *
 * A path that cannot be resolved to a real filesystem target is never accepted
 * as trusted: returning `undefined` lets callers fail closed rather than
 * falling back to lexical resolution, which a symlink whose target escapes an
 * install root could launder itself through.
 */
export function canonicalPath(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/** Whether `candidate` is `directory` itself or lies beneath it, after symlink
 * resolution. Returns `false` when either path cannot be canonicalized. */
export function isPathWithinDirectory(
  directory: string | undefined,
  candidate: string | undefined,
): boolean {
  if (directory === undefined || candidate === undefined) return false;
  const canonicalDirectory = canonicalPath(directory);
  const canonicalCandidate = canonicalPath(candidate);
  if (canonicalDirectory === undefined || canonicalCandidate === undefined) {
    return false;
  }
  const relativePath = relative(canonicalDirectory, canonicalCandidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

/**
 * Whether `candidate` is `directory` itself or lies beneath it, using lexical
 * resolution only (no symlink resolution).
 *
 * Use this for containment checks on paths that are already trusted or that
 * need not exist on disk (e.g. classifying load failures by root). For the
 * subagent trust boundary, use `isPathWithinDirectory` instead — a symlink
 * whose target escapes an install root must not launder itself through a
 * lexical check.
 */
export function isPathWithinDirectoryLexical(
  directory: string,
  candidate: string,
): boolean {
  const relativePath = relative(resolve(directory), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

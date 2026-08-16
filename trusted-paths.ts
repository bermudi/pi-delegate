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
 * Resolve a path through symlinks.
 *
 * Falls back to lexical resolution only for the race where a path that was
 * just discovered on disk disappears before validation — never as a way to
 * accept an unresolvable path as trusted.
 */
export function canonicalPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return resolve(candidate);
  }
}

/** Whether `candidate` is `directory` itself or lies beneath it, after symlink resolution. */
export function isPathWithinDirectory(
  directory: string,
  candidate: string,
): boolean {
  const relativePath = relative(
    canonicalPath(directory),
    canonicalPath(candidate),
  );
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

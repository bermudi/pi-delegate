import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWithin } from "./fsx.ts";
import type { ResolvedTask } from "./types.ts";

type WorkspaceGuard = NonNullable<ResolvedTask["workspaceGuard"]>;

/**
 * The distinctive fragment every guard refusal reason carries. Pi emits
 * `tool_execution_start` before `tool_call` handlers can block, so a
 * refused write/edit is already on the child's attribution record by the
 * time the block lands — `TaskExecution` recognizes a refusal on
 * `tool_execution_end` by this marker and subtracts the claimed path (a
 * blocked call never touched the file). Keep in sync with the reason
 * text below.
 */
export function isWorkspaceGuardRefusal(text: string): boolean {
  return (
    text.startsWith("Refused: ") &&
    text.includes(" is in the original repository, outside your ")
  );
}

/**
 * The path a write/edit call targets: `path`, `file_path`, or `filePath` —
 * the same alias set `toolCallPath` in execution.ts attributes. Narrowed
 * from the event's loosely typed input; a missing or empty path is not a
 * guard concern.
 */
function callPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filePath"] as const) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Unicode space separators pi's path layer folds to ASCII spaces before
 * resolving (utils/paths.js UNICODE_SPACES). A `dir\u00A0name` spelling
 * resolves to `dir name` in the tool — the guard must see the same target.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Mirrors pi's `normalizeWindowsShellPath` — win32-gated drive spelling. */
function normalizeWindowsShellPath(filePath: string): string {
  if (
    !filePath.startsWith("/") ||
    filePath.startsWith("//") ||
    filePath.includes("\\")
  ) {
    return filePath;
  }
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * The absolute path a write/edit tool call targets: exactly the spelling
 * normalization pi's tools apply (`resolveToCwd` → `resolvePath` with
 * `normalizeUnicodeSpaces` + `stripAtPrefix`) — a leading `@`, a `file://`
 * URL, unicode spaces, `~`, or a win32 shell path all resolve BEFORE the
 * absoluteness check, so comparing the raw string would let each spelling
 * sail past the guard. Mirrors pi-coding-agent dist/utils/paths.js +
 * core/tools/path-utils.js; recheck on Pi upgrades.
 */
export function toolPathTarget(raw: string, cwd: string): string {
  let normalized = raw.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }
  if (normalized === "~") normalized = homedir();
  else if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // A malformed file: URL fails in the tool itself; leave it opaque —
      // the guard simply won't match and the tool's own error stands.
    }
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * Canonicalize a target that may not exist yet: realpath the nearest
 * existing ancestor and re-append the missing tail, so a `write` creating
 * a new file is still compared against the real source/copy roots rather
 * than a symlinked spelling of them. `lstat` — not existence — bounds the
 * ancestor walk: a dangling symlink still redirects a write (the tool's
 * mkdir follows it and CREATES the link's target), so it must be read and
 * followed, never walked past.
 */
function canonicalTarget(target: string, depth = 0): string {
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(target);
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  try {
    return join(realpathSync.native(existing), ...tail);
  } catch {
    // realpath fails on a dangling link even though lstat sees it — fall
    // through and follow its link text manually.
  }
  try {
    if (lstatSync(existing).isSymbolicLink() && depth < 40) {
      const dest = readlinkSync(existing);
      const resolved = isAbsolute(dest)
        ? dest
        : resolve(dirname(existing), dest);
      return canonicalTarget(join(resolved, ...tail), depth + 1);
    }
  } catch {
    // Raced away between lstat and readlink — resolve lexically.
  }
  return join(resolve(existing), ...tail);
}

/**
 * The inline extension factory installed on every isolated/scratch
 * child's resource loader (#62). A workspace copy protects only relative
 * writes; an absolute path into the original tree sails past it — this
 * refuses those calls with a pointer at the same file inside the worker's
 * copy. Paths outside the source root are allowed: the guard claims no
 * sandbox, just the one confusion that has actually bitten. Shell
 * commands cannot be intercepted this way; isolated reconciliation
 * reports their source drift separately.
 */
export function workspaceGuardFactory(
  guard: WorkspaceGuard,
  cwd: string,
): (pi: ExtensionAPI) => void {
  const sourceRoot = canonicalTarget(guard.sourceRoot);
  const copyRoot = canonicalTarget(guard.copyRoot);
  const copyWord = guard.kind === "isolated" ? "isolated" : "disposable";
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName !== "write" && event.toolName !== "edit") return;
      const raw = callPath(event.input as Record<string, unknown>);
      if (raw === undefined) return;
      const target = canonicalTarget(toolPathTarget(raw, cwd));
      if (!isWithin(sourceRoot, target) || isWithin(copyRoot, target)) {
        return;
      }
      const mapped = join(copyRoot, relative(sourceRoot, target));
      return {
        block: true,
        reason: `Refused: ${target} is in the original repository, outside your ${copyWord} copy. Edit ${mapped} instead.`,
      };
    });
  };
}

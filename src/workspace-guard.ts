import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * Canonicalize a target that may not exist yet: realpath the nearest
 * existing ancestor and re-append the missing tail, so a `write` creating
 * a new file is still compared against the real source/copy roots rather
 * than a symlinked spelling of them.
 */
function canonicalTarget(target: string): string {
  let existing = target;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
  }
  let base: string;
  try {
    base = realpathSync.native(existing);
  } catch {
    base = resolve(existing);
  }
  return join(base, ...tail);
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
      const expanded = expandHome(raw);
      const target = canonicalTarget(
        isAbsolute(expanded) ? expanded : resolve(cwd, expanded),
      );
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

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { mapConcurrent } from "./concurrency.ts";
import { isPathWithinDirectoryLexical } from "./trusted-paths.ts";
import type { ResolvedTask } from "./types.ts";

const GIT_TIMEOUT_MS = 5_000;
export const SHARED_WRITE_PREFLIGHT_CONCURRENCY = 4;
const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);
const GIT_REPOSITORY_REDIRECT_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
] as const;

export interface SharedWriteScope {
  kind: "git" | "directory";
  root: string;
}

export interface SharedWriteConflict {
  scope: SharedWriteScope;
  taskIndexes: number[];
}

export class SharedWriteSafetyError extends Error {}

class GitScopeError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function gitRepositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  // Resolve the physical cwd rather than allowing the parent's Git invocation
  // context to redirect discovery. findSharedWriteConflicts fails closed when
  // a bash-capable multi-writer batch inherits repository redirect variables,
  // so preflight never silently disagrees with task execution.
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd,
        signal,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: {
          ...gitEnvironment,
          LC_ALL: "C",
          LANG: "C",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GitScopeError(error.message, stderr.trim(), { cause: error }),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Resolve the physical boundary used by the batch-local shared-write gate.
 * Only Git's explicit "not a repository" response permits a plain-directory
 * fallback. Missing Git, timeouts, dubious ownership, and malformed metadata
 * fail closed rather than silently disabling the protection.
 */
export async function resolveSharedWriteScope(
  cwd: string,
  signal?: AbortSignal,
): Promise<SharedWriteScope> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await fs.promises.realpath(cwd);
  } catch (error) {
    throw new SharedWriteSafetyError(
      `Could not resolve task directory '${cwd}'.`,
      { cause: error },
    );
  }

  let root: string;
  try {
    root = await gitRepositoryRoot(canonicalCwd, signal);
  } catch (error) {
    if (
      error instanceof GitScopeError &&
      /not a git repository/i.test(error.stderr)
    ) {
      return { kind: "directory", root: canonicalCwd };
    }
    const detail =
      error instanceof GitScopeError
        ? error.stderr || error.message
        : error instanceof Error
          ? error.message
          : String(error);
    throw new SharedWriteSafetyError(
      `Could not safely determine the Git root for '${canonicalCwd}': ${detail}`,
      { cause: error },
    );
  }

  if (!root) {
    throw new SharedWriteSafetyError(
      `Git returned an empty repository root for '${canonicalCwd}'.`,
    );
  }

  try {
    return { kind: "git", root: await fs.promises.realpath(root) };
  } catch (error) {
    throw new SharedWriteSafetyError(
      `Could not resolve Git root '${root}' for '${canonicalCwd}'.`,
      { cause: error },
    );
  }
}

function isSharedWriter(task: ResolvedTask): boolean {
  return (
    task.workspace === "shared" &&
    task.tools.some((tool) => MUTATING_TOOLS.has(tool))
  );
}

function scopesOverlap(left: SharedWriteScope, right: SharedWriteScope): boolean {
  return (
    isPathWithinDirectoryLexical(left.root, right.root) ||
    isPathWithinDirectoryLexical(right.root, left.root)
  );
}

function shallowerScope(
  left: SharedWriteScope,
  right: SharedWriteScope,
): SharedWriteScope {
  return isPathWithinDirectoryLexical(left.root, right.root)
    ? left
    : right;
}

/** Find overlapping shared-writer scopes while preserving task-array order. */
export async function findSharedWriteConflicts(
  tasks: readonly ResolvedTask[],
  signal?: AbortSignal,
): Promise<SharedWriteConflict[]> {
  const candidates = tasks
    .map((task, taskIndex) => ({ task, taskIndex }))
    .filter(({ task }) => isSharedWriter(task));

  // With fewer than two shared writers there cannot be a batch-local conflict.
  // Do not make ordinary single-writer calls depend on Git or cwd inspection.
  if (candidates.length < 2) return [];

  const inheritedRedirects = GIT_REPOSITORY_REDIRECT_VARIABLES.filter(
    (name) => process.env[name] !== undefined,
  );
  if (
    inheritedRedirects.length > 0 &&
    candidates.some(({ task }) => task.tools.includes("bash"))
  ) {
    throw new SharedWriteSafetyError(
      `Could not safely verify a bash-capable shared-write batch while ${inheritedRedirects.join(
        ", ",
      )} redirects Git repository context.`,
    );
  }

  const resolved = await mapConcurrent(
    candidates,
    SHARED_WRITE_PREFLIGHT_CONCURRENCY,
    async ({ task, taskIndex }) => ({
      taskIndex,
      scope: await resolveSharedWriteScope(task.cwd, signal),
    }),
  );

  // Build connected components rather than grouping only identical roots.
  // A writer scoped to /work can reach /work/subdir with an ordinary relative
  // path, including when /work/subdir is itself a nested Git repository.
  const parents = resolved.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < resolved.length; left++) {
    for (let right = left + 1; right < resolved.length; right++) {
      if (scopesOverlap(resolved[left]!.scope, resolved[right]!.scope)) {
        union(left, right);
      }
    }
  }

  const groups = new Map<number, SharedWriteConflict>();
  for (let index = 0; index < resolved.length; index++) {
    const candidate = resolved[index]!;
    const component = find(index);
    const group = groups.get(component);
    if (group) {
      group.taskIndexes.push(candidate.taskIndex);
      group.scope = shallowerScope(group.scope, candidate.scope);
    } else {
      groups.set(component, {
        scope: candidate.scope,
        taskIndexes: [candidate.taskIndex],
      });
    }
  }

  return [...groups.values()].filter((group) => group.taskIndexes.length >= 2);
}

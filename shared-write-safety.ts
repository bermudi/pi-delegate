import { execFile } from "node:child_process";
import * as fs from "node:fs";
import type { ResolvedTask } from "./types.ts";

const GIT_TIMEOUT_MS = 5_000;
const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

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
  // Repository-context variables can redirect discovery away from `cwd` or
  // stop it before Git reaches the real root. They belong to the parent's
  // shell invocation, not to this safety decision.
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

/** Find same-scope shared writers while preserving task-array order. */
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

  const resolved = await Promise.all(
    candidates.map(async ({ task, taskIndex }) => ({
      taskIndex,
      scope: await resolveSharedWriteScope(task.cwd, signal),
    })),
  );

  const groups = new Map<
    string,
    { scope: SharedWriteScope; taskIndexes: number[] }
  >();
  for (const candidate of resolved) {
    // `kind` explains how the path was discovered; it is not part of the
    // filesystem identity. In particular, an external Git worktree can make
    // Git report a physical root that another task sees as a plain directory.
    // Those tasks can still mutate the same files and must share one group.
    const key = candidate.scope.root;
    const group = groups.get(key);
    if (group) {
      group.taskIndexes.push(candidate.taskIndex);
    } else {
      groups.set(key, {
        scope: candidate.scope,
        taskIndexes: [candidate.taskIndex],
      });
    }
  }

  return [...groups.values()].filter(
    (group): group is SharedWriteConflict => group.taskIndexes.length >= 2,
  );
}

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { mapConcurrent } from "./concurrency.ts";
import { isPathWithinDirectoryLexical } from "./trusted-paths.ts";
import type { ResolvedTask } from "./types.ts";

const GIT_TIMEOUT_MS = 5_000;
const PREFLIGHT_CONCURRENCY = 4;
const NON_MUTATING_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
]);
const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"] as const;

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
  const env = Object.fromEntries(
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
          ...env,
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

/** Resolve one conservative write boundary. Git repositories use their
 * physical top-level; plain directories use the task cwd. Only Git's explicit
 * "not a repository" response permits directory fallback. */
export async function resolveSharedWriteScope(
  cwd: string,
  signal?: AbortSignal,
): Promise<SharedWriteScope> {
  let physicalCwd: string;
  try {
    physicalCwd = await fs.promises.realpath(cwd);
  } catch (error) {
    throw new SharedWriteSafetyError(
      `Could not resolve task directory '${cwd}'.`,
      { cause: error },
    );
  }

  try {
    const root = await gitRepositoryRoot(physicalCwd, signal);
    if (!root) {
      throw new SharedWriteSafetyError(
        `Git returned an empty repository root for '${physicalCwd}'.`,
      );
    }
    return { kind: "git", root: await fs.promises.realpath(root) };
  } catch (error) {
    if (
      error instanceof GitScopeError &&
      /not a git repository/i.test(error.stderr)
    ) {
      return { kind: "directory", root: physicalCwd };
    }
    if (error instanceof SharedWriteSafetyError) throw error;
    const detail =
      error instanceof GitScopeError
        ? error.stderr || error.message
        : error instanceof Error
          ? error.message
          : String(error);
    throw new SharedWriteSafetyError(
      `Could not safely determine the Git root for '${physicalCwd}': ${detail}`,
      { cause: error },
    );
  }
}

export function isSharedWriter(task: ResolvedTask): boolean {
  return (
    task.workspace === "shared" &&
    task.tools.some((tool) => !NON_MUTATING_TOOLS.has(tool))
  );
}

function overlaps(left: SharedWriteScope, right: SharedWriteScope): boolean {
  return (
    isPathWithinDirectoryLexical(left.root, right.root) ||
    isPathWithinDirectoryLexical(right.root, left.root)
  );
}

function shallower(
  left: SharedWriteScope,
  right: SharedWriteScope,
): SharedWriteScope {
  return isPathWithinDirectoryLexical(left.root, right.root) ? left : right;
}

/** Find connected overlapping writer scopes while preserving task order.
 * Unknown tools fail closed as mutating. This is an in-process admission
 * boundary, not filesystem confinement or a claim about external processes. */
export async function findSharedWriteConflicts(
  tasks: readonly ResolvedTask[],
  signal?: AbortSignal,
): Promise<SharedWriteConflict[]> {
  const candidates = tasks
    .map((task, taskIndex) => ({ task, taskIndex }))
    .filter(({ task }) => isSharedWriter(task));
  if (candidates.length < 2) return [];

  const redirects = GIT_REDIRECTS.filter(
    (name) => process.env[name] !== undefined,
  );
  if (
    redirects.length &&
    candidates.some(({ task }) => task.tools.includes("bash"))
  ) {
    throw new SharedWriteSafetyError(
      `Could not safely verify a bash-capable shared-write batch while ${redirects.join(", ")} redirects Git repository context.`,
    );
  }

  const uniqueCwds = [...new Set(candidates.map(({ task }) => task.cwd))];
  const scopes = await mapConcurrent(uniqueCwds, PREFLIGHT_CONCURRENCY, (cwd) =>
    resolveSharedWriteScope(cwd, signal),
  );
  const byCwd = new Map(
    uniqueCwds.map((cwd, index) => [cwd, scopes[index]!] as const),
  );
  const resolved = candidates.map(({ task, taskIndex }) => ({
    taskIndex,
    scope: byCwd.get(task.cwd)!,
  }));

  const parents = resolved.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parents[b] = a;
  };
  for (let left = 0; left < resolved.length; left++) {
    for (let right = left + 1; right < resolved.length; right++) {
      if (overlaps(resolved[left]!.scope, resolved[right]!.scope)) {
        union(left, right);
      }
    }
  }

  const components = new Map<number, number[]>();
  for (let index = 0; index < resolved.length; index++) {
    const root = find(index);
    const members = components.get(root);
    if (members) members.push(index);
    else components.set(root, [index]);
  }

  const conflicts: SharedWriteConflict[] = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    let witness = resolved[members[0]!]!.scope;
    for (const member of members.slice(1)) {
      const scope = resolved[member]!.scope;
      if (overlaps(witness, scope)) witness = shallower(witness, scope);
    }
    conflicts.push({
      scope: witness,
      taskIndexes: members.map((index) => resolved[index]!.taskIndex),
    });
  }
  return conflicts;
}

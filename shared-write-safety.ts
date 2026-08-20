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

export interface ReachRoot {
  kind: "git" | "directory";
  path: string;
}

export interface SharedWriteScope {
  kind: "git" | "directory";
  root: string;
  /** Full set of canonical roots a shared writer can reach from its cwd: the
   * primary `root` (Git top-level when known, otherwise the physical cwd) plus,
   * when an external `core.worktree` places the Git top-level outside the
   * physical cwd, the physical cwd itself. Overlap detection uses every entry;
   * `root`/`kind` are the primary values used for display. Undefined on scopes
   * assembled for a `SharedWriteConflict`, which only carry the witness root. */
  roots?: ReachRoot[];
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
      return { kind: "directory", root: canonicalCwd, roots: [{ kind: "directory", path: canonicalCwd }] };
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

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.promises.realpath(root);
  } catch (error) {
    throw new SharedWriteSafetyError(
      `Could not resolve Git root '${root}' for '${canonicalCwd}'.`,
      { cause: error },
    );
  }

  // Git's reported top-level is the repository boundary, but a bash-capable
  // writer can also reach files beneath its physical cwd. With an external
  // core.worktree the top-level can live outside the physical cwd (e.g. a bare
  // repository.git whose worktree is a sibling directory), so discarding the
  // physical cwd would miss an overlap with another task scoped to a parent of
  // the Git directory. Track both roots whenever the physical cwd is not within
  // the Git top-level; the union of reach roots is what overlap detection uses.
  const roots: ReachRoot[] = [{ kind: "git", path: canonicalRoot }];
  if (!isPathWithinDirectoryLexical(canonicalRoot, canonicalCwd)) {
    roots.push({ kind: "directory", path: canonicalCwd });
  }
  return { kind: "git", root: canonicalRoot, roots };
}

function isSharedWriter(task: ResolvedTask): boolean {
  return (
    task.workspace === "shared" &&
    task.tools.some((tool) => MUTATING_TOOLS.has(tool))
  );
}

function reachRoots(scope: SharedWriteScope): ReachRoot[] {
  return scope.roots ?? [{ kind: scope.kind, path: scope.root }];
}

function reachRootsOverlap(left: ReachRoot, right: ReachRoot): boolean {
  return (
    isPathWithinDirectoryLexical(left.path, right.path) ||
    isPathWithinDirectoryLexical(right.path, left.path)
  );
}

/** The shallower of two overlapping reach roots (the one that contains the
 * other), used as the witness root for a conflict's display scope. When both
 * paths are equal the left argument wins, preserving task-array order. */
function shallowerReachRoot(left: ReachRoot, right: ReachRoot): ReachRoot {
  return isPathWithinDirectoryLexical(left.path, right.path) ? left : right;
}

/** Find the shallowest witness root among the overlapping reach-root pairs of
 * two scopes. Returns undefined when the scopes do not overlap. */
function overlapWitness(
  left: SharedWriteScope,
  right: SharedWriteScope,
): ReachRoot | undefined {
  let witness: ReachRoot | undefined;
  for (const leftRoot of reachRoots(left)) {
    for (const rightRoot of reachRoots(right)) {
      if (!reachRootsOverlap(leftRoot, rightRoot)) continue;
      const candidate = shallowerReachRoot(leftRoot, rightRoot);
      if (
        witness === undefined ||
        isPathWithinDirectoryLexical(candidate.path, witness.path)
      ) {
        witness = candidate;
      }
    }
  }
  return witness;
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
  // path, including when /work/subdir is itself a nested Git repository, and a
  // writer whose external core.worktree places the Git top-level outside its
  // physical cwd can reach both. Overlap is therefore detected over the full
  // reach-root set, not just the primary Git top-level.
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
      if (
        overlapWitness(resolved[left]!.scope, resolved[right]!.scope) !==
        undefined
      ) {
        union(left, right);
      }
    }
  }

  // Gather members per component, preserving task-array order.
  const components = new Map<number, number[]>();
  for (let index = 0; index < resolved.length; index++) {
    const component = find(index);
    const members = components.get(component);
    if (members) members.push(index);
    else components.set(component, [index]);
  }

  // For each multi-member component, derive the display scope from the
  // shallowest witness root among all intra-component overlapping reach-root
  // pairs. Recomputing here (rather than tracking witnesses during union) is
  // robust to the component root changing as unions proceed.
  const conflicts: SharedWriteConflict[] = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    let witness: ReachRoot | undefined;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const pairWitness = overlapWitness(
          resolved[members[i]!]!.scope,
          resolved[members[j]!]!.scope,
        );
        if (pairWitness === undefined) continue;
        if (
          witness === undefined ||
          isPathWithinDirectoryLexical(pairWitness.path, witness.path)
        ) {
          witness = pairWitness;
        }
      }
    }
    const taskIndexes = members.map((index) => resolved[index]!.taskIndex);
    conflicts.push({
      scope:
        witness === undefined
          ? resolved[members[0]!]!.scope
          : { kind: witness.kind, root: witness.path },
      taskIndexes,
    });
  }

  return conflicts;
}

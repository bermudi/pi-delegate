import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalPath,
  exec,
  gitProbeEnv,
  isWithin,
  stopWorkspaceProcesses,
} from "./fsx.ts";
import type { ResolvedTask, TaskOutcome } from "./types.ts";

// Probes fail fast and produce tiny output; the shared exec takes explicit
// limits so the per-use divergence from the copy path stays visible.
const PROBE_EXEC = { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024 } as const;
// A full (non-reflink) copy of a big tree legitimately takes a while.
const COPY_EXEC = { timeoutMs: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 } as const;

const FALLBACK_REMEDY =
  `Resubmit with workspace: "shared" to run in the source tree, ` +
  `or "isolated" for a detached Git worktree.`;

function log(context: string, error: unknown): void {
  console.error(
    `[delegate] ${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * The tree a scratch task copies. Inside an ordinary Git repository that is
 * the top-level, so the copied `.git` keeps Git commands fully contained.
 * Anything else — not a repository, a Git probe failure, a cwd outside the
 * discovered root — copies just the cwd: containment never depends on Git
 * succeeding, it only decides how much context the copy includes.
 *
 * A linked worktree or submodule checkout is rejected outright: its `.git`
 * is a file redirecting into another repository, and Git commands inside
 * the copy would mutate the real repository's metadata — the one write
 * that escapes an ordinary relative path.
 */
async function copySourceOf(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ root: string; cwd: string }> {
  const physicalCwd = await fs.promises.realpath(cwd);
  let root: string | undefined;
  try {
    const top = (
      await exec("git", ["-C", physicalCwd, "rev-parse", "--show-toplevel"], {
        ...PROBE_EXEC,
        env: gitProbeEnv(),
        signal,
      })
    ).stdout.trim();
    if (top) {
      const resolved = await fs.promises.realpath(top);
      if (isWithin(resolved, physicalCwd)) root = resolved;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Not a repository, or Git unusable: the cwd alone is the copy.
  }
  root ??= physicalCwd;
  const dotGit = await fs.promises
    .lstat(path.join(root, ".git"))
    .catch(() => null);
  if (dotGit?.isFile()) {
    throw new Error(
      `workspace "scratch" cannot copy '${root}': its .git is a file redirecting into another repository (linked worktree or submodule), so Git commands inside the copy would mutate the real repository. ${FALLBACK_REMEDY}`,
    );
  }
  return { root, cwd: physicalCwd };
}

/**
 * Full copy of `source` at `destination` (which must not exist). GNU cp gets
 * the reflink fast path — cheap on copy-on-write filesystems, a transparent
 * full copy elsewhere. Non-GNU cp falls back to Node's copier with links
 * kept verbatim: escaping symlinks still resolve to the real tree, which is
 * fine — scratch guards ordinary relative writes, it is not a sandbox.
 */
async function copyTree(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await exec("cp", ["-a", "--reflink=auto", source, destination], {
      ...COPY_EXEC,
      signal,
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unrecognized option|invalid option|illegal option/i.test(message)) {
      throw new Error(
        `workspace "scratch" could not copy '${source}': ${message} ${FALLBACK_REMEDY}`,
      );
    }
  }
  try {
    if (signal?.aborted) throw new Error("aborted");
    await fs.promises.cp(source, destination, {
      recursive: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    throw new Error(
      `workspace "scratch" could not copy '${source}': ${error instanceof Error ? error.message : String(error)} ${FALLBACK_REMEDY}`,
    );
  }
}

/**
 * Copies live under `<scratchBase>/pid-<pid>/<batch>/`. Namespacing by pid
 * lets a later call remove trees left by a process that died before
 * cleanup — a live pid's directory is never touched, including this one,
 * which may hold batches still running.
 */
async function sweepStaleCopies(scratchBase: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(scratchBase, { withFileTypes: true });
  } catch (error) {
    // Nothing to sweep is normal; an unreadable base is worth a line, but
    // litter cleanup must never fail a dispatch.
    log(`failed to list scratch copies in '${scratchBase}'`, error);
    return;
  }
  for (const entry of entries) {
    const match = /^pid-(\d+)$/.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      alive = (error as { code?: string }).code === "EPERM";
    }
    if (alive) continue;
    await fs.promises
      .rm(path.join(scratchBase, entry.name), { recursive: true, force: true })
      .catch((error: unknown) =>
        log(`failed to sweep stale scratch copies '${entry.name}'`, error),
      );
  }
}

/** rmdir-if-empty: removes the directory only when nothing remains in it. */
async function pruneEmpty(dir: string): Promise<void> {
  await fs.promises.rmdir(dir).catch(() => undefined);
}

interface ScratchWorker {
  readonly taskIndex: number;
  readonly copyRoot: string;
  /** Settled caller-visibly with quiescence unconfirmed — copy stays on disk. */
  retained: boolean;
}

export interface ScratchPlan {
  /** The task list with each scratch task's cwd remapped into its copy. */
  readonly tasks: readonly ResolvedTask[];
  /**
   * Discard every copy whose worker is confirmed quiescent; copies of
   * quarantined workers stay until `cleanupWorker`. Never throws — cleanup
   * failure is litter, not an outcome change.
   */
  finalize(outcomes: TaskOutcome[]): Promise<readonly TaskOutcome[]>;
  /** Discard a retained worker's copy once its quiescence is confirmed. */
  cleanupWorker(taskIndex: number): Promise<void>;
  /** Preparation succeeded but a later stage failed before anything ran. */
  dispose(): Promise<void>;
}

/**
 * Prepare a disposable copy for every scratch task in `phase`, then remap
 * its cwd into the copy. Throws — failing the whole call or phase — when a
 * source tree cannot be copied; everything created so far is removed.
 * Copies are per-task: two scratch tasks on one source never see each
 * other's writes. The phase filter exists so a dependent's copy is taken
 * at its phase's start, after earlier phases' proposals applied.
 */
export async function prepareScratch(
  tasks: readonly ResolvedTask[],
  scratchBase: string,
  signal: AbortSignal | undefined,
  phase: number,
): Promise<ScratchPlan | undefined> {
  const scratchIndexes = tasks
    .map((task, index) =>
      task.workspace === "scratch" && task.phase === phase ? index : -1,
    )
    .filter((index) => index >= 0);
  if (!scratchIndexes.length) return undefined;

  await sweepStaleCopies(scratchBase);
  const procRoot = path.join(scratchBase, `pid-${process.pid}`);
  const batchRoot = path.join(procRoot, randomUUID());
  const workers = new Map<number, ScratchWorker>();
  const translated = [...tasks];

  try {
    for (const taskIndex of scratchIndexes) {
      const task = tasks[taskIndex]!;
      const { root, cwd } = await copySourceOf(task.cwd, signal);
      if (isWithin(root, canonicalPath(scratchBase))) {
        throw new Error(
          `workspace "scratch" cannot copy '${root}': the scratch directory '${scratchBase}' sits inside the copied tree. ${FALLBACK_REMEDY}`,
        );
      }
      const copyRoot = path.join(batchRoot, `worker-${taskIndex}`);
      await fs.promises.mkdir(path.dirname(copyRoot), {
        recursive: true,
        mode: 0o700,
      });
      await copyTree(root, copyRoot, signal);
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const workerCwd = path.join(copyRoot, path.relative(root, cwd));
      await fs.promises.mkdir(workerCwd, { recursive: true });
      workers.set(taskIndex, { taskIndex, copyRoot, retained: false });
      translated[taskIndex] = {
        ...task,
        cwd: workerCwd,
        // #62: prompts routinely name absolute source paths; the note
        // teaches the copy mapping, the inline workspace guard refuses
        // what the note does not catch.
        appendSystemPrompt: [
          ...task.appendSystemPrompt,
          `Workspace: you are working in a disposable copy of ${root} at ${copyRoot}. Your working directory is ${workerCwd}. Paths under ${root} in your instructions mean the same files in your copy: use ${copyRoot}/<same relative path>. Do not modify anything under ${root} — write and edit calls there are refused. Every change you make is discarded when you finish; your final message is the result.`,
        ],
        workspaceGuard: {
          kind: "scratch",
          sourceRoot: root,
          copyRoot,
        },
      };
    }
  } catch (error) {
    await fs.promises
      .rm(batchRoot, { recursive: true, force: true })
      .catch((cleanupError: unknown) =>
        log("failed to remove scratch copies after preparation error", cleanupError),
      );
    throw error;
  }

  const discard = async (worker: ScratchWorker): Promise<boolean> => {
    try {
      await stopWorkspaceProcesses(worker.copyRoot);
    } catch (error) {
      // A straggler keeps writing into an unlinked tree harmlessly; the
      // removal still proceeds — litter is worse than a wedged child.
      log(
        `could not stop leftover processes in scratch copy '${worker.copyRoot}'; removing it anyway`,
        error,
      );
    }
    try {
      await fs.promises.rm(worker.copyRoot, { recursive: true, force: true });
      return true;
    } catch (error) {
      log(`failed to remove scratch copy '${worker.copyRoot}'`, error);
      return false;
    }
  };

  const prune = async (): Promise<void> => {
    await pruneEmpty(batchRoot);
    await pruneEmpty(procRoot);
    await pruneEmpty(scratchBase);
  };

  return {
    tasks: translated,
    async finalize(outcomes: TaskOutcome[]): Promise<readonly TaskOutcome[]> {
      for (const worker of workers.values()) {
        const outcome = outcomes[worker.taskIndex];
        if (!outcome || outcome.quarantined) {
          worker.retained = true;
          continue;
        }
        await discard(worker);
      }
      await prune();
      return outcomes;
    },
    async cleanupWorker(taskIndex: number): Promise<void> {
      const worker = workers.get(taskIndex);
      if (!worker?.retained) return;
      if (await discard(worker)) {
        worker.retained = false;
        await prune();
      }
    },
    async dispose(): Promise<void> {
      await fs.promises
        .rm(batchRoot, { recursive: true, force: true })
        .catch((error: unknown) =>
          log("failed to remove unused scratch copies", error),
        );
      await pruneEmpty(procRoot);
      await pruneEmpty(scratchBase);
    },
  };
}

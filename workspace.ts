import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { scheduleDeadline } from "./timer.ts";

const SCRATCH_PREFIX = ".pi-delegate-scratch-";
const SCRATCH_TREE_NAME = "project";
const COPY_TIMEOUT_MS = 5 * 60 * 1000;

export interface ScratchWorkspace {
  /** Canonical project root copied into the scratch directory. */
  sourceRoot: string;
  /** Canonical cwd requested by the caller. */
  sourceCwd: string;
  /** Root of the disposable reflink copy. */
  scratchRoot: string;
  /** sourceCwd translated into scratchRoot. */
  cwd: string;
  mapPathToSource(candidate: string): string;
  /** Resolve a reported path physically, mapping disposable paths back to the
   * source tree and preserving external host paths after cleanup. */
  resolveReportedPath(candidate: string): Promise<string>;
  /**
   * Resolve an explicitly attributed path. Disposable paths return undefined;
   * external paths are returned in physical (realpath) form so symlink aliases
   * compare with the host path they actually touched.
   */
  resolveAttributedPath(candidate: string): Promise<string | undefined>;
  /** True when the existing path resolves inside the disposable tree. */
  isDisposablePath(candidate: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    options: ErrorOptions,
  ) {
    super(message, options);
  }
}

function runFile(
  file: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          reject(
            new CommandError(
              detail ? `${file}: ${detail}` : `${file}: ${error.message}`,
              detail,
              { cause: error },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function findCopyRoot(cwd: string, signal: AbortSignal): Promise<string> {
  try {
    const root = (
      await runFile("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        timeout: 5000,
        signal,
      })
    ).trim();
    if (!root) {
      throw new Error("Git returned an empty repository root.");
    }
    return await fs.promises.realpath(root);
  } catch (error) {
    // Only Git's explicit "not a repository" result permits treating cwd as a
    // plain directory. Missing Git, timeouts, dubious ownership, malformed
    // metadata, and every other failure stop scratch creation: falling back
    // could leave an ancestor repository or linked-worktree metadata reachable.
    if (
      error instanceof CommandError &&
      /not a git repository/i.test(error.stderr)
    ) {
      return cwd;
    }
    throw new Error("Could not safely determine the scratch project root.", {
      cause: error,
    });
  }
}

function throwIfSetupCancelled(
  signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): void {
  if (!signal.aborted) return;
  throw new Error(
    parentSignal?.aborted
      ? "Scratch workspace creation was aborted."
      : "Scratch workspace creation exceeded the task deadline.",
  );
}

/** Validate the completed copy before any subagent receives its path. */
async function validateCopiedTree(
  root: string,
  signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): Promise<void> {
  const pending = [root];
  while (pending.length) {
    throwIfSetupCancelled(signal, parentSignal);
    const directory = pending.pop()!;
    for (const entry of await fs.promises.readdir(directory, {
      withFileTypes: true,
    })) {
      throwIfSetupCancelled(signal, parentSignal);
      const candidate = path.join(directory, entry.name);
      // The root repository is validated below. A non-directory .git entry can
      // redirect metadata outside the copy. Nested repositories are rejected as
      // unsupported because their own config, alternates, and worktree settings
      // would each need the same independent validation as the root repository.
      if (entry.name === ".git") {
        if (!entry.isDirectory()) {
          throw new Error(
            `Scratch workspace cannot safely copy linked Git metadata at '${path.relative(root, candidate)}'.`,
          );
        }
        if (directory !== root) {
          throw new Error(
            `Scratch workspace does not support nested Git repositories at '${path.relative(root, candidate)}'.`,
          );
        }
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const target = await fs.promises.readlink(candidate);
      const resolvedTarget = path.resolve(path.dirname(candidate), target);
      if (path.isAbsolute(target) || !isWithin(root, resolvedTarget)) {
        throw new Error(
          `Scratch workspace cannot safely copy symlink '${path.relative(root, candidate)}' because it points outside the project.`,
        );
      }
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Make an ephemeral, same-filesystem CoW copy of the Git repository containing
 * cwd (or cwd itself outside Git). This is accidental-write isolation, not a
 * security boundary: absolute paths and commands can still reach the host.
 */
export async function createScratchWorkspace(
  cwd: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<ScratchWorkspace> {
  // Creation requires GNU cp's reflink/archive flags, and cleanup deliberately
  // uses Linux descriptor paths to avoid deleting a renamed/replaced tree.
  if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) {
    throw new Error(
      "Scratch workspaces require Linux with GNU cp and /proc/self/fd available.",
    );
  }

  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const deadlineAbort = () =>
    controller.abort(
      new Error("Scratch workspace creation exceeded the task deadline."),
    );
  const clearDeadline =
    deadlineAt === undefined
      ? undefined
      : scheduleDeadline(deadlineAt, deadlineAbort);
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) deadlineAbort();

  let sourceCwd: string;
  let sourceRoot: string;
  let leaseRoot: string | undefined;
  let scratchRoot: string | undefined;
  let copiedLeaseStat: fs.Stats | undefined;
  let copiedRootStat: fs.Stats | undefined;
  try {
    if (signal?.aborted) controller.abort(signal.reason);
    throwIfSetupCancelled(controller.signal, signal);
    sourceCwd = await fs.promises.realpath(cwd);
    throwIfSetupCancelled(controller.signal, signal);
    sourceRoot = await findCopyRoot(sourceCwd, controller.signal);
    throwIfSetupCancelled(controller.signal, signal);
    if (!isWithin(sourceRoot, sourceCwd)) {
      throw new Error(
        "Scratch workspace could not map the task cwd into its project root.",
      );
    }

    leaseRoot = await fs.promises.mkdtemp(
      path.join(path.dirname(sourceRoot), SCRATCH_PREFIX),
    );
    await fs.promises.chmod(leaseRoot, 0o700);
    scratchRoot = path.join(leaseRoot, SCRATCH_TREE_NAME);
    await fs.promises.mkdir(scratchRoot, { mode: 0o700 });
    // `source/.` copies the contents into the already-created private directory.
    // `always` deliberately refuses a full-copy fallback for unexpectedly large
    // projects or a destination on the wrong filesystem.
    await runFile(
      "cp",
      [
        "--archive",
        "--reflink=always",
        "--",
        `${sourceRoot}${path.sep}.`,
        scratchRoot,
      ],
      { signal: controller.signal, timeout: COPY_TIMEOUT_MS },
    );
    // GNU cp --archive applies the source root's mode to the destination.
    // Restore the private boundary after it has finished copying metadata.
    await fs.promises.chmod(scratchRoot, 0o700);
    await validateCopiedTree(scratchRoot, controller.signal, signal);
    if (
      await fs.promises.stat(path.join(scratchRoot, ".git")).then(
        (stat) => stat.isDirectory(),
        () => false,
      )
    ) {
      const effectiveWorktree = path.resolve(
        (
          await runFile("git", ["rev-parse", "--show-toplevel"], {
            cwd: scratchRoot,
            signal: controller.signal,
            timeout: 5000,
          })
        ).trim(),
      );
      const effectiveGitDir = path.resolve(
        scratchRoot,
        (
          await runFile("git", ["rev-parse", "--absolute-git-dir"], {
            cwd: scratchRoot,
            signal: controller.signal,
            timeout: 5000,
          })
        ).trim(),
      );
      const effectiveCommonDir = path.resolve(
        effectiveGitDir,
        (
          await runFile("git", ["rev-parse", "--git-common-dir"], {
            cwd: scratchRoot,
            signal: controller.signal,
            timeout: 5000,
          })
        ).trim(),
      );
      if (
        effectiveWorktree !== scratchRoot ||
        !isWithin(scratchRoot, effectiveGitDir) ||
        !isWithin(scratchRoot, effectiveCommonDir)
      ) {
        throw new Error(
          "Scratch workspace Git configuration redirects its worktree or metadata outside the copied project.",
        );
      }
    }
    throwIfSetupCancelled(controller.signal, signal);
    // Keep the copied project writable, but make its private parent immutable
    // to ordinary task commands. `mv "$PWD" …` then cannot unlink the project
    // entry. This is accidental-write protection, not a same-user security
    // boundary: unrestricted bash can deliberately chmod the parent again.
    await fs.promises.chmod(leaseRoot, 0o500);
    // Capture cleanup identities inside the guarded region: if either lookup
    // fails, the catch below restores permissions and removes the partial copy.
    copiedLeaseStat = await fs.promises.lstat(leaseRoot);
    copiedRootStat = await fs.promises.lstat(scratchRoot);
  } catch (error) {
    if (leaseRoot) {
      try {
        await fs.promises.chmod(leaseRoot, 0o700);
        await fs.promises.rm(leaseRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(
          "[delegate] failed to clean partial scratch workspace",
          cleanupError,
        );
      }
    }
    if (controller.signal.aborted) {
      throw new Error(
        signal?.aborted
          ? "Scratch workspace creation was aborted."
          : "Scratch workspace creation exceeded the task deadline.",
        { cause: error },
      );
    }
    if (
      error instanceof Error &&
      (error.message.includes("Scratch workspace cannot safely copy") ||
        error.message.includes("Scratch workspace Git configuration") ||
        error.message.includes("Scratch workspace does not support") ||
        error.message.includes("safely determine") ||
        error.message.includes("could not map"))
    ) {
      throw error;
    }
    throw new Error(
      "Could not create a CoW scratch workspace. The project and scratch directory must be on a reflink-capable filesystem (for example Btrfs).",
      { cause: error },
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    clearDeadline?.();
  }

  // Assigned before successful exit from the try block above.
  const completedLeaseRoot = leaseRoot!;
  const completedRoot = scratchRoot!;
  const completedLeaseStat = copiedLeaseStat!;
  const completedRootStat = copiedRootStat!;
  const relativeCwd = path.relative(sourceRoot!, sourceCwd!);
  let cleaned = false;
  const resolveReportedPath = async (candidate: string): Promise<string> => {
    const absolute = path.resolve(candidate);
    try {
      const real = await fs.promises.realpath(absolute);
      return isWithin(completedRoot, real)
        ? path.join(sourceRoot!, path.relative(completedRoot, real))
        : real;
    } catch {
      // A successful edit/write normally leaves a path behind. Keep the
      // source mapping for a disposable path that was deleted immediately,
      // while preserving an external path for later diagnostics.
      return isWithin(completedRoot, absolute)
        ? path.join(sourceRoot!, path.relative(completedRoot, absolute))
        : absolute;
    }
  };
  const resolveAttributedPath = async (
    candidate: string,
  ): Promise<string | undefined> => {
    try {
      const real = await fs.promises.realpath(candidate);
      return isWithin(completedRoot, real) ? undefined : real;
    } catch {
      const absolute = path.resolve(candidate);
      return isWithin(completedRoot, absolute) ? undefined : absolute;
    }
  };
  return {
    sourceRoot: sourceRoot!,
    sourceCwd: sourceCwd!,
    scratchRoot: completedRoot,
    cwd: path.join(completedRoot, relativeCwd),
    mapPathToSource(candidate: string): string {
      const absolute = path.resolve(candidate);
      if (!isWithin(completedRoot, absolute)) return candidate;
      return path.join(sourceRoot!, path.relative(completedRoot, absolute));
    },
    resolveReportedPath,
    resolveAttributedPath,
    async isDisposablePath(candidate: string): Promise<boolean> {
      return (await resolveAttributedPath(candidate)) === undefined;
    },
    async cleanup(): Promise<void> {
      if (cleaned) return;
      if (
        path.dirname(completedLeaseRoot) !== path.dirname(sourceRoot!) ||
        !path.basename(completedLeaseRoot).startsWith(SCRATCH_PREFIX) ||
        path.dirname(completedRoot) !== completedLeaseRoot ||
        path.basename(completedRoot) !== SCRATCH_TREE_NAME
      ) {
        throw new Error(
          "Refusing to clean an unrecognised scratch workspace path.",
        );
      }
      // Open the parent first, then resolve the lease through that handle. The
      // descriptor identifies the checked directory even if its pathname is
      // renamed or replaced while cleanup is running.
      const parentHandle = await fs.promises.open(
        path.dirname(completedLeaseRoot),
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
      );
      let leaseHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
      let rootHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
      try {
        leaseHandle = await fs.promises.open(
          path.join(
            `/proc/self/fd/${parentHandle.fd}`,
            path.basename(completedLeaseRoot),
          ),
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
        );
        rootHandle = await fs.promises.open(
          path.join(`/proc/self/fd/${leaseHandle.fd}`, SCRATCH_TREE_NAME),
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
        );
        const currentLeaseStat = await fs.promises.lstat(completedLeaseRoot);
        const currentRootStat = await fs.promises.lstat(completedRoot);
        const openLeaseStat = await leaseHandle.stat();
        const openRootStat = await rootHandle.stat();
        if (
          !currentLeaseStat.isDirectory() ||
          currentLeaseStat.dev !== completedLeaseStat.dev ||
          currentLeaseStat.ino !== completedLeaseStat.ino ||
          !currentRootStat.isDirectory() ||
          currentRootStat.dev !== completedRootStat.dev ||
          currentRootStat.ino !== completedRootStat.ino ||
          !openLeaseStat.isDirectory() ||
          openLeaseStat.dev !== completedLeaseStat.dev ||
          openLeaseStat.ino !== completedLeaseStat.ino ||
          !openRootStat.isDirectory() ||
          openRootStat.dev !== completedRootStat.dev ||
          openRootStat.ino !== completedRootStat.ino
        ) {
          throw new Error(
            "Scratch workspace root was moved or replaced; refusing to report cleanup success.",
          );
        }
        await leaseHandle.chmod(0o700);
        // Remove the project through the opened lease descriptor. The
        // recursive operation never resolves the disposable root pathname.
        await fs.promises.rm(
          path.join(`/proc/self/fd/${leaseHandle.fd}`, SCRATCH_TREE_NAME),
          { recursive: true, force: false },
        );
        // The lease is empty now. Remove only its directory entry through the
        // opened parent. This is deliberately non-recursive: if a cooperating
        // process replaced the lease with a populated directory, rmdir fails
        // instead of deleting the replacement's contents.
        await fs.promises.rmdir(
          path.join(
            `/proc/self/fd/${parentHandle.fd}`,
            path.basename(completedLeaseRoot),
          ),
        );
        cleaned = true;
      } finally {
        await rootHandle?.close();
        await leaseHandle?.close();
        await parentHandle.close();
      }
    },
  };
}

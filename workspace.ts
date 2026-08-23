import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { scheduleDeadline } from "./timer.ts";
import type { FileAttribution } from "./types.ts";

const SCRATCH_CONTAINER_NAME = ".pi-delegate-scratch";
const SCRATCH_LEASE_PREFIX = "lease-";
const SCRATCH_LEGACY_PREFIX = ".pi-delegate-scratch-";
const SCRATCH_TREE_NAME = "project";
const SCRATCH_OWNER_NAME = ".owner";
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
  /** Project structured attribution without re-resolving its execution-time
   * physical snapshot. Uncertain internal evidence is retained. */
  resolveFileAttribution?(
    attribution: FileAttribution,
  ): Promise<FileAttribution | undefined>;
  /** Project the lexical touched-path half of structured attribution. An
   * unchanged copied symlink node is suppressed; changed nodes stay lexical. */
  resolveAttributedLexicalTouch?(
    attribution: FileAttribution,
  ): Promise<string | undefined>;
  /** True when the existing path resolves inside the disposable tree. */
  isDisposablePath(candidate: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

export class ScratchSetupError extends Error {}

export class ScratchDeadlineError extends ScratchSetupError {}

class ScratchLeaseIdentityError extends Error {}

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
      throw new ScratchSetupError("Git returned an empty repository root.");
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
    throw new ScratchSetupError(
      "Could not safely determine the scratch project root.",
      {
        cause: error,
      },
    );
  }
}

function throwIfSetupCancelled(
  signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): void {
  if (!signal.aborted) return;
  if (parentSignal?.aborted) {
    throw new Error("Scratch workspace creation was aborted.");
  }
  throw new ScratchDeadlineError(
    "Scratch workspace creation exceeded the task deadline.",
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
          throw new ScratchSetupError(
            `Scratch workspace cannot safely copy linked Git metadata at '${path.relative(root, candidate)}'.`,
          );
        }
        if (directory !== root) {
          throw new ScratchSetupError(
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
        throw new ScratchSetupError(
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  // dev+ino alone can alias after an unlink+mkdir reuses the same inode
  // (observed on ext4 in CI: project replaced in the sweep race test
  // reused the previous ino). Birthtime distinguishes a recreated entry
  // and is stable across the chmod 0500→0700 transitions that update
  // ctime. Where birthtime is unavailable (0) we fall back to dev+ino.
  if (left.dev !== right.dev || left.ino !== right.ino) return false;
  if (left.birthtimeMs !== 0 || right.birthtimeMs !== 0) {
    return left.birthtimeMs === right.birthtimeMs;
  }
  return true;
}

function parseOwnerPid(content: string): number | undefined {
  const value = content.trim();
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

type LeaseDeletionExpectations =
  | {
      hasProject: true;
      lease: fs.Stats;
      project: fs.Stats;
      owner: fs.Stats;
    }
  | {
      hasProject: false;
      lease: fs.Stats;
      owner: fs.Stats;
    };

async function deleteLeaseContentsAndRmdir(
  parentHandle: fs.promises.FileHandle,
  leaseName: string,
  leaseHandle: fs.promises.FileHandle,
  expectations: LeaseDeletionExpectations,
): Promise<void> {
  const leasePath = path.join(`/proc/self/fd/${parentHandle.fd}`, leaseName);
  const openLeaseStat = await leaseHandle.stat();
  const currentLeaseStat = await fs.promises.lstat(leasePath);
  if (
    !openLeaseStat.isDirectory() ||
    !sameFileIdentity(openLeaseStat, expectations.lease) ||
    !sameFileIdentity(currentLeaseStat, openLeaseStat)
  ) {
    throw new ScratchLeaseIdentityError(
      "Scratch lease was moved or replaced; refusing cleanup.",
    );
  }

  await leaseHandle.chmod(0o700);
  const ownerPath = path.join(
    `/proc/self/fd/${leaseHandle.fd}`,
    SCRATCH_OWNER_NAME,
  );
  const initialOwnerStat = await fs.promises.lstat(ownerPath);
  if (!sameFileIdentity(initialOwnerStat, expectations.owner)) {
    throw new ScratchLeaseIdentityError(
      "Scratch owner marker was replaced; refusing cleanup.",
    );
  }

  if (expectations.hasProject) {
    const projectPath = path.join(
      `/proc/self/fd/${leaseHandle.fd}`,
      SCRATCH_TREE_NAME,
    );
    const projectHandle = await fs.promises.open(
      projectPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    try {
      const openProjectStat = await projectHandle.stat();
      const currentProjectStat = await fs.promises.lstat(projectPath);
      if (
        !openProjectStat.isDirectory() ||
        !sameFileIdentity(openProjectStat, expectations.project) ||
        !sameFileIdentity(currentProjectStat, openProjectStat)
      ) {
        throw new ScratchLeaseIdentityError(
          "Scratch project was moved or replaced; refusing cleanup.",
        );
      }

      // Remove children through the opened project directory, not the project
      // pathname.  This means a replacement at `project` is never recursively
      // traversed.  The final rmdir is still a pathname operation; the identity
      // is checked again immediately beforehand, so this is fail-closed for
      // the deterministic replacement races we can observe, not an atomic
      // guarantee against a cooperating same-user process.
      for (const name of await fs.promises.readdir(
        `/proc/self/fd/${projectHandle.fd}`,
      )) {
        await fs.promises.rm(
          path.join(`/proc/self/fd/${projectHandle.fd}`, name),
          { recursive: true, force: false },
        );
      }
      const finalProjectStat = await fs.promises.lstat(projectPath);
      if (!sameFileIdentity(finalProjectStat, openProjectStat)) {
        throw new ScratchLeaseIdentityError(
          "Scratch project was moved or replaced; refusing cleanup.",
        );
      }
      await fs.promises.rmdir(projectPath);
    } finally {
      await projectHandle.close();
    }
  }

  const currentOwnerStat = await fs.promises.lstat(ownerPath);
  if (!sameFileIdentity(currentOwnerStat, expectations.owner)) {
    throw new ScratchLeaseIdentityError(
      "Scratch owner marker was replaced; refusing cleanup.",
    );
  }
  await fs.promises.rm(ownerPath, { force: false });

  const finalLeaseStat = await fs.promises.lstat(leasePath);
  if (!sameFileIdentity(finalLeaseStat, openLeaseStat)) {
    throw new ScratchLeaseIdentityError(
      "Scratch lease was moved or replaced; refusing cleanup.",
    );
  }
  await fs.promises.rmdir(leasePath);
}

async function ensureScratchContainer(
  containerDir: string,
  uid: number | undefined,
): Promise<void> {
  try {
    await fs.promises.mkdir(containerDir, { mode: 0o700 });
    await fs.promises.chmod(containerDir, 0o700);
    return;
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    )) {
      throw error;
    }
  }

  const stat = await fs.promises.lstat(containerDir);
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new ScratchSetupError(
      `Scratch container directory '${containerDir}' is not a directory owned by the current user.`,
    );
  }
  if ((stat.mode & 0o7777) !== 0o700) {
    await fs.promises.chmod(containerDir, 0o700);
  }
}

interface SweepOptions {
  prefix?: string;
  onLeaseOpened?: (leaseName: string, leaseFd: number) => Promise<void> | void;
  onLeaseValidated?: (leaseName: string) => Promise<void> | void;
}

/** Remove leases left behind by a process that is no longer running.
 *
 * The owner marker distinguishes our leases from unrelated prefix-matching
 * directories. Live owners are never touched. Descriptors make the scan
 * independent of a renamed parent, while pathname identity checks ensure that
 * a lease renamed or replaced after it was opened is left alone. These checks
 * are snapshots rather than an atomic cross-process locking primitive.
 */
async function sweepStaleScratchLeases(
  container: string,
  options: SweepOptions = {},
): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;

  let parentHandle: fs.promises.FileHandle;
  try {
    parentHandle = await fs.promises.open(
      container,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
  } catch {
    return;
  }

  try {
    const parentStat = await parentHandle.stat();
    if (!parentStat.isDirectory() || parentStat.uid !== uid) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(`/proc/self/fd/${parentHandle.fd}`, {
        withFileTypes: true,
      });
    } catch (error) {
      console.error("[delegate] scratch lease sweep failed", error);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (options.prefix && !entry.name.startsWith(options.prefix)) continue;

      let leaseHandle: fs.promises.FileHandle | undefined;
      try {
        const leasePath = path.join(
          `/proc/self/fd/${parentHandle.fd}`,
          entry.name,
        );
        leaseHandle = await fs.promises.open(
          leasePath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
        );
        const openedLeaseStat = await leaseHandle.stat();
        const scannedLeaseStat = await fs.promises.lstat(leasePath);
        if (
          !openedLeaseStat.isDirectory() ||
          openedLeaseStat.uid !== uid ||
          !sameFileIdentity(scannedLeaseStat, openedLeaseStat)
        ) {
          continue;
        }

        // Snapshot the identities before the test hook / concurrent work. If
        // either pathname changes, the opened descriptor is not used for
        // deletion. In particular, a rename must not turn this into cleanup of
        // a lease that merely moved elsewhere.
        const ownerPath = path.join(
          `/proc/self/fd/${leaseHandle.fd}`,
          SCRATCH_OWNER_NAME,
        );
        let scannedOwnerStat: fs.Stats;
        try {
          scannedOwnerStat = await fs.promises.lstat(ownerPath);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            // Leases from versions without an owner marker, or partial leases
            // from a crash between mkdtemp and the marker write: reclaim only
            // when empty. Anything else may be an unrelated directory. The
            // identity re-check keeps the rmdir anchored to the scanned lease.
            const contents = await fs.promises.readdir(
              `/proc/self/fd/${leaseHandle.fd}`,
            );
            if (contents.length === 0) {
              const currentLeaseStat = await fs.promises.lstat(leasePath);
              if (sameFileIdentity(currentLeaseStat, scannedLeaseStat)) {
                await fs.promises.rmdir(leasePath);
              }
            }
            continue;
          }
          throw error;
        }
        let scannedProjectStat: fs.Stats | undefined;
        try {
          scannedProjectStat = await fs.promises.lstat(
            path.join(`/proc/self/fd/${leaseHandle.fd}`, SCRATCH_TREE_NAME),
          );
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )) {
            throw error;
          }
        }

        if (options.onLeaseOpened) {
          await options.onLeaseOpened(entry.name, leaseHandle.fd);
        }

        const currentLeaseStat = await fs.promises.lstat(leasePath);
        if (!sameFileIdentity(currentLeaseStat, scannedLeaseStat)) continue;
        const currentOwnerStat = await fs.promises.lstat(ownerPath);
        if (!sameFileIdentity(currentOwnerStat, scannedOwnerStat)) continue;
        if (scannedProjectStat) {
          const currentProjectStat = await fs.promises.lstat(
            path.join(`/proc/self/fd/${leaseHandle.fd}`, SCRATCH_TREE_NAME),
          );
          if (!sameFileIdentity(currentProjectStat, scannedProjectStat)) {
            continue;
          }
        }

        if (
          !currentOwnerStat.isFile() ||
          currentOwnerStat.uid !== uid ||
          (currentOwnerStat.mode & 0o077) !== 0
        ) {
          continue;
        }

        const ownerContent = await fs.promises.readFile(ownerPath, "utf8");
        const pid = parseOwnerPid(ownerContent);
        if (pid === undefined || isProcessAlive(pid)) continue;

        const contents = await fs.promises.readdir(
          `/proc/self/fd/${leaseHandle.fd}`,
        );
        if (
          contents.some(
            (name) => name !== SCRATCH_OWNER_NAME && name !== SCRATCH_TREE_NAME,
          )
        ) {
          continue;
        }

        const hasProject = contents.includes(SCRATCH_TREE_NAME);
        if (
          hasProject &&
          (!scannedProjectStat ||
            !scannedProjectStat.isDirectory() ||
            scannedProjectStat.isSymbolicLink())
        ) {
          continue;
        }

        if (options.onLeaseValidated) {
          await options.onLeaseValidated(entry.name);
        }
        if (hasProject) {
          if (!scannedProjectStat) continue;
          await deleteLeaseContentsAndRmdir(
            parentHandle,
            entry.name,
            leaseHandle,
            {
              hasProject: true,
              lease: scannedLeaseStat,
              project: scannedProjectStat,
              owner: scannedOwnerStat,
            },
          );
        } else {
          await deleteLeaseContentsAndRmdir(
            parentHandle,
            entry.name,
            leaseHandle,
            {
              hasProject: false,
              lease: scannedLeaseStat,
              owner: scannedOwnerStat,
            },
          );
        }
      } catch (error) {
        if (error instanceof ScratchLeaseIdentityError) continue;
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" ||
            error.code === "ENOTDIR" ||
            error.code === "ENOTEMPTY")
        ) {
          continue;
        }
        console.error(
          `[delegate] failed to sweep stale scratch lease '${entry.name}'`,
          error,
        );
      } finally {
        await leaseHandle?.close();
      }
    }
  } finally {
    await parentHandle.close();
  }
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
  let containerDir: string;
  let leaseRoot: string | undefined;
  let scratchRoot: string | undefined;
  let copiedLeaseStat: fs.Stats | undefined;
  let copiedRootStat: fs.Stats | undefined;
  let copiedOwnerStat: fs.Stats | undefined;
  try {
    if (signal?.aborted) controller.abort(signal.reason);
    throwIfSetupCancelled(controller.signal, signal);
    sourceCwd = await fs.promises.realpath(cwd);
    throwIfSetupCancelled(controller.signal, signal);
    sourceRoot = await findCopyRoot(sourceCwd, controller.signal);
    throwIfSetupCancelled(controller.signal, signal);
    if (!isWithin(sourceRoot, sourceCwd)) {
      throw new ScratchSetupError(
        "Scratch workspace could not map the task cwd into its project root.",
      );
    }

    containerDir = path.join(path.dirname(sourceRoot), SCRATCH_CONTAINER_NAME);
    const uid = process.getuid?.();
    await ensureScratchContainer(containerDir, uid);
    if (uid !== undefined) {
      await sweepStaleScratchLeases(containerDir);
      await sweepStaleScratchLeases(path.dirname(sourceRoot), {
        prefix: SCRATCH_LEGACY_PREFIX,
      });
    }

    leaseRoot = await fs.promises.mkdtemp(
      path.join(containerDir, SCRATCH_LEASE_PREFIX),
    );
    await fs.promises.chmod(leaseRoot, 0o700);
    await fs.promises.writeFile(
      path.join(leaseRoot, SCRATCH_OWNER_NAME),
      `${process.pid}\n`,
      { mode: 0o600 },
    );
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
        throw new ScratchSetupError(
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
    copiedOwnerStat = await fs.promises.lstat(
      path.join(leaseRoot, SCRATCH_OWNER_NAME),
    );
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
      if (signal?.aborted) {
        throw new Error("Scratch workspace creation was aborted.", {
          cause: error,
        });
      }
      throw new ScratchDeadlineError(
        "Scratch workspace creation exceeded the task deadline.",
        { cause: error },
      );
    }
    if (error instanceof ScratchSetupError) throw error;
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
  const completedOwnerStat = copiedOwnerStat!;
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
  const mapDisposableLexically = (candidate: string): string => {
    const absolute = path.resolve(candidate);
    return isWithin(completedRoot, absolute)
      ? path.join(sourceRoot!, path.relative(completedRoot, absolute))
      : absolute;
  };
  const resolveFileAttribution = async (
    attribution: FileAttribution,
  ): Promise<FileAttribution | undefined> => {
    const physical = attribution.preExecutionPhysicalPath;
    // A certain physical snapshot inside scratch is disposable. Crucially, do
    // not realpath it now: the tool may have replaced that node with a symlink.
    if (
      physical &&
      !attribution.uncertain &&
      isWithin(completedRoot, physical)
    ) {
      return undefined;
    }
    return {
      ...attribution,
      lexicalPath: mapDisposableLexically(attribution.lexicalPath),
      preExecutionPhysicalPath: physical
        ? mapDisposableLexically(physical)
        : undefined,
    };
  };
  const resolveAttributedLexicalTouch = async (
    attribution: FileAttribution,
  ): Promise<string | undefined> => {
    const lexical = path.resolve(attribution.lexicalPath);
    if (!isWithin(completedRoot, lexical)) return lexical;
    const source = path.join(
      sourceRoot!,
      path.relative(completedRoot, lexical),
    );
    const [scratchStat, sourceStat] = await Promise.all([
      fs.promises.lstat(lexical).catch(() => undefined),
      fs.promises.lstat(source).catch(() => undefined),
    ]);
    if (scratchStat?.isSymbolicLink() && sourceStat?.isSymbolicLink()) {
      const [scratchTarget, sourceTarget] = await Promise.all([
        fs.promises.readlink(lexical),
        fs.promises.readlink(source),
      ]);
      if (scratchTarget === sourceTarget) return undefined;
    }
    // This is evidence about the lexical node, not its current target.
    return source;
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
    resolveFileAttribution,
    resolveAttributedLexicalTouch,
    async isDisposablePath(candidate: string): Promise<boolean> {
      return (await resolveAttributedPath(candidate)) === undefined;
    },
    async cleanup(): Promise<void> {
      if (cleaned) return;
      try {
        if (
          path.dirname(completedLeaseRoot) !== containerDir ||
          !path.basename(completedLeaseRoot).startsWith(SCRATCH_LEASE_PREFIX) ||
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
          containerDir,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
        );
        let leaseHandle:
          Awaited<ReturnType<typeof fs.promises.open>> | undefined;
        let rootHandle:
          Awaited<ReturnType<typeof fs.promises.open>> | undefined;
        try {
          const leaseName = path.basename(completedLeaseRoot);
          leaseHandle = await fs.promises.open(
            path.join(`/proc/self/fd/${parentHandle.fd}`, leaseName),
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
          );
          rootHandle = await fs.promises.open(
            path.join(`/proc/self/fd/${leaseHandle.fd}`, SCRATCH_TREE_NAME),
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
          );
          const openLeaseStat = await leaseHandle.stat();
          const openRootStat = await rootHandle.stat();
          const currentLeaseStat = await fs.promises.lstat(
            path.join(`/proc/self/fd/${parentHandle.fd}`, leaseName),
          );
          const currentRootStat = await fs.promises.lstat(
            path.join(`/proc/self/fd/${leaseHandle.fd}`, SCRATCH_TREE_NAME),
          );
          if (
            !openLeaseStat.isDirectory() ||
            !sameFileIdentity(openLeaseStat, completedLeaseStat) ||
            !sameFileIdentity(currentLeaseStat, completedLeaseStat) ||
            !openRootStat.isDirectory() ||
            !sameFileIdentity(openRootStat, completedRootStat) ||
            !sameFileIdentity(currentRootStat, completedRootStat)
          ) {
            throw new Error(
              "Scratch workspace root was moved or replaced; refusing to report cleanup success.",
            );
          }

          // The identity checks are snapshots. The primitive repeats them and
          // removes project children through its opened descriptor, so a
          // replacement observed before removal is preserved. This is not an
          // atomic guarantee against a cooperating process changing the path
          // after the final check.
          await deleteLeaseContentsAndRmdir(
            parentHandle,
            leaseName,
            leaseHandle,
            {
              hasProject: true,
              lease: completedLeaseStat,
              project: completedRootStat,
              owner: completedOwnerStat,
            },
          );
          cleaned = true;
        } finally {
          await rootHandle?.close();
          await leaseHandle?.close();
          await parentHandle.close();
        }
      } catch (error) {
        throw new Error(
          `Scratch workspace cleanup failed for lease '${completedLeaseRoot}': ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
  };
}

export const _testHooks = {
  sweepStaleScratchLeases,
  ensureScratchContainer,
  deleteLeaseContentsAndRmdir,
  SCRATCH_CONTAINER_NAME,
  SCRATCH_LEASE_PREFIX,
  SCRATCH_LEGACY_PREFIX,
  SCRATCH_TREE_NAME,
  SCRATCH_OWNER_NAME,
};

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalPath,
  DELEGATE_TREES,
  exec,
  type ExecOptions,
  type ExecResult,
  gitEnv,
  isWithin,
  stopWorkspaceProcesses,
} from "./fsx.ts";
import type {
  ResolvedTask,
  TaskIntegration,
  TaskOutcome,
} from "./types.ts";

// Snapshot traffic is real tree data; Git over big trees legitimately runs
// long and emits large output. Deliberately larger than the scratch/probe
// exec limits — the divergence is per use case, stated here at the call site.
const GIT_EXEC = { timeoutMs: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 } as const;

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function git(
  args: string[],
  options: Omit<ExecOptions, "timeoutMs" | "maxBuffer" | "errorClass"> = {},
): Promise<ExecResult> {
  return exec("git", args, {
    ...GIT_EXEC,
    ...options,
    env: gitEnv(options.env),
    errorClass: GitCommandError,
  });
}

function log(context: string, error: unknown): void {
  console.error(
    `[delegate] ${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * The repository root an isolated task's source tree lives in. Requires a
 * real commit to base the synthetic baseline on; repositories with
 * submodules and cwds that do not map inside the discovered root fail closed.
 */
async function repositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const physicalCwd = await fs.promises.realpath(cwd);
  let root: string;
  try {
    root = (
      await git(["rev-parse", "--show-toplevel"], {
        cwd: physicalCwd,
        signal,
      })
    ).stdout.trim();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      `workspace "isolated" requires a Git repository: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const physicalRoot = await fs.promises.realpath(root);
  if (!isWithin(physicalRoot, physicalCwd)) {
    throw new Error(
      `Could not map the isolated task cwd '${physicalCwd}' into its Git root '${physicalRoot}'.`,
    );
  }
  try {
    await git(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: physicalRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      `workspace "isolated" requires a repository with at least one commit; '${physicalRoot}' has none.`,
    );
  }
  if (fs.existsSync(path.join(physicalRoot, ".gitmodules"))) {
    throw new Error(
      'workspace "isolated" does not yet support repositories with submodules.',
    );
  }
  return physicalRoot;
}

function privateRef(batchId: string, suffix: string): string {
  return `refs/pi-delegate/batches/${batchId}/${suffix}`;
}

/**
 * Snapshot a tree's full working state — tracked modifications, deletions,
 * and untracked (non-ignored) files — as a tree object, using a temporary
 * index so the user's index is never read or written. `excludePaths` are
 * repository-relative pathspecs kept out of the snapshot — the artifact
 * root is excluded when it lives inside the source tree, so retained
 * artifacts and live worktrees can never leak into a baseline.
 */
async function snapshotTree(
  root: string,
  baseCommit: string,
  indexPath: string,
  signal?: AbortSignal,
  excludePaths: readonly string[] = [],
): Promise<string> {
  await fs.promises.rm(indexPath, { force: true });
  const env = {
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: root,
  };
  await git(["read-tree", baseCommit], { cwd: root, env, signal });
  await git(
    [
      "add",
      "-A",
      "--",
      ".",
      ...excludePaths.map((exclude) => `:(exclude)${exclude}`),
    ],
    { cwd: root, env, signal },
  );
  return (await git(["write-tree"], { cwd: root, env, signal })).stdout.trim();
}

async function commitTree(
  root: string,
  tree: string,
  parent: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  return (
    await git(["commit-tree", tree, "-p", parent, "-m", message], {
      cwd: root,
      signal,
      env: {
        GIT_AUTHOR_NAME: "Pi Delegate",
        GIT_AUTHOR_EMAIL: "delegate@localhost",
        GIT_COMMITTER_NAME: "Pi Delegate",
        GIT_COMMITTER_EMAIL: "delegate@localhost",
      },
    })
  ).stdout.trim();
}

async function addWorktree(
  root: string,
  destination: string,
  commit: string,
  signal?: AbortSignal,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await git(["worktree", "add", "--force", "--detach", destination, commit], {
    cwd: root,
    signal,
  });
}

/** True only when the worktree path is verifiably gone. */
async function removeWorktree(
  root: string,
  destination: string,
): Promise<boolean> {
  try {
    await git(["worktree", "remove", "--force", destination], { cwd: root });
    if (!pathEntryExists(destination)) return true;
    log(
      `Git reported isolated worktree removal success but the path remains at ${JSON.stringify(destination)}`,
      "",
    );
    return false;
  } catch (error) {
    if (!pathEntryExists(destination)) return true;
    log(`failed to remove isolated worktree '${destination}'`, error);
    return false;
  }
}

async function changedFiles(
  root: string,
  from: string,
  to: string,
): Promise<string[]> {
  const output = await git(
    ["diff", "--name-only", "-z", "--no-renames", from, to],
    { cwd: root },
  );
  return output.stdout.split("\0").filter(Boolean);
}

/**
 * Blob shas for every tracked file in `commit`, as repository-relative
 * path → sha. Used to verify a proposal's expected post-apply state
 * before the source is touched: only paths whose current content matches
 * the recorded expectation may be overwritten.
 */
async function trackedBlobs(
  root: string,
  commit: string,
): Promise<Map<string, string>> {
  const output = await git(["ls-tree", "-r", "-z", commit], {
    cwd: root,
  });
  const blobs = new Map<string, string>();
  for (const entry of output.stdout.split("\0")) {
    if (!entry) continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(entry);
    if (!match) continue;
    const [, , kind, sha, filePath] = match;
    if (kind === "blob") blobs.set(filePath!, sha!);
  }
  return blobs;
}

/** Blob sha of one worktree file, or undefined when absent/unreadable. */
async function worktreeBlob(
  root: string,
  relative: string,
): Promise<string | undefined> {
  try {
    const stat = await fs.promises.lstat(path.join(root, relative));
    if (!stat.isFile() && !stat.isSymbolicLink()) return undefined;
    return (
      await git(["hash-object", "--", relative], { cwd: root })
    ).stdout.trim();
  } catch {
    return undefined;
  }
}

/** Full binary patch text for `from → to`, suitable for `git apply` on stdin. */
async function diffPatch(
  root: string,
  from: string,
  to: string,
): Promise<string> {
  return (
    await git(
      ["diff", "--binary", "--full-index", "--no-renames", from, to],
      { cwd: root },
    )
  ).stdout;
}

async function writePatch(
  root: string,
  from: string,
  to: string,
  destination: string,
): Promise<void> {
  await fs.promises.writeFile(destination, await diffPatch(root, from, to), {
    mode: 0o600,
  });
}

interface IsolatedGroup {
  readonly sourceRoot: string;
  readonly artifactRoot: string;
  readonly baselineCommit: string;
  readonly baselineRef: string;
  readonly taskIndexes: number[];
  /**
   * Resolves when this group's reconciliation (including artifact cleanup)
   * has finished all Git operations. Deferred quarantine cleanups wait on it
   * so a worktree removal can never race candidate or source applies.
   */
  readonly reconcileDone: Promise<void>;
  readonly finishReconcile: () => void;
}

interface IsolatedWorker {
  readonly group: IsolatedGroup;
  readonly taskIndex: number;
  readonly workerRoot: string;
  readonly proposalRef: string;
  /** True once the proposal ref exists — cleanup must not delete nonexistent refs. */
  proposalCreated: boolean;
  readonly patchPath: string;
  /**
   * The task settled caller-visibly while its session's quiescence was
   * unconfirmed: the worktree stays on disk until `cleanupWorker` observes
   * confirmed quiescence. Never snapshotted, never applied.
   */
  retained: boolean;
}

interface AcceptedProposal {
  readonly taskIndex: number;
  /** Chain parent — the expected pre-apply state of the source. */
  readonly parent: string;
  readonly commit: string;
  readonly files: readonly string[];
  /**
   * The worker tree's exact post-run state, captured while the worker
   * worktree still exists: path → blob sha for every tracked file in the
   * successful proposal. The source apply verifies each entry before
   * writing, so a failed apply restores from this snapshot — never from
   * an older whole-file version that would erase unrelated changes.
   */
  readonly expectedBlobs: ReadonlyMap<string, string>;
  /** True when the worker worktree was removed during collection. */
  readonly workerRemoved: boolean;
}

export interface IsolatedReconcileOptions {
  /** Checked before every source apply; false retains accepted proposals. */
  readonly shouldApplySource: () => boolean;
  readonly retainedReason?: string;
  readonly signal?: AbortSignal;
}

export interface IsolatedPlan {
  /** The task list with each isolated task's cwd remapped into its worktree. */
  readonly tasks: readonly ResolvedTask[];
  /**
   * Reconcile proposals into their source trees in task order and attach
   * per-task integration results. Runs inside the reservation window — call
   * it before the admission grant is released. Never throws: a group-level
   * failure marks that group's tasks `apply_failed` and retains artifacts.
   * Reads and mutates the live outcome array in place: worker truth that
   * lands mid-reconcile must be observed (a confirmed-quiescent worker is
   * safe to snapshot; a provisional one is not).
   */
  reconcile(
    outcomes: TaskOutcome[],
    options: IsolatedReconcileOptions,
  ): Promise<readonly TaskOutcome[]>;
  /**
   * Remove a retained worker's worktree once its quiescence is confirmed.
   * A no-op for workers already cleaned up or never marked retained.
   */
  cleanupWorker(taskIndex: number): Promise<void>;
  dispose(): Promise<void>;
}

function withIntegration(
  outcome: TaskOutcome,
  integration: TaskIntegration,
): TaskOutcome {
  return { ...outcome, integration };
}

/**
 * Restore one failed source apply: move whatever the apply left behind
 * into a recovery directory, then restore each path's expected pre-apply
 * content from the chain-parent commit. Earlier proposals' applied content
 * is preserved because the expected state already contains it.
 *
 * The recovery move runs first for every path, then the restore pass runs
 * for every path. Each path is independent, but a move failure must not
 * abort the loop and leave later paths unrestored — every path gets both
 * passes, the first error is rethrown at the end, and the caller retains
 * its recovery artifacts either way.
 *
 * Selective restore: a path whose current content no longer matches the
 * verified pre-apply state was changed by someone else after verification
 * (the failed apply itself may have partially written it, or an external
 * edit landed mid-apply). Restoring such a path from the older snapshot
 * would erase that unrelated edit, so it is left in place: its post-apply
 * content stays in the recovery directory for inspection, and the path is
 * reported back so the caller can name it instead of claiming a clean
 * rollback. Returns the paths left unrestored.
 */
async function restorePreApplyState(
  group: IsolatedGroup,
  proposal: AcceptedProposal,
  paths: readonly string[],
  recoveryDir: string,
): Promise<string[]> {
  const skipped: string[] = [];
  let firstError: unknown;
  for (const relative of paths) {
    const source = path.join(group.sourceRoot, relative);
    const stat = await fs.promises.lstat(source).catch(() => null);
    if (!stat) continue;
    const recovered = path.join(recoveryDir, relative);
    try {
      await fs.promises.mkdir(path.dirname(recovered), { recursive: true });
      try {
        await fs.promises.rename(source, recovered);
      } catch {
        // The artifact root can sit on a different filesystem than the
        // source; fall back to copy-then-remove.
        await fs.promises.cp(source, recovered, {
          recursive: true,
          dereference: false,
        });
        await fs.promises.rm(source, { recursive: true, force: true });
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  for (const relative of paths) {
    try {
      // Only restore paths still holding the verified pre-apply state:
      // anything else changed after verification and must not be rolled
      // back to the older snapshot. Created paths (no parent blob) are
      // restored only when still absent; deleted paths only when still
      // matching the parent.
      const parentEntry = (
        await git(["ls-tree", proposal.parent, "--", relative], {
          cwd: group.sourceRoot,
        })
      ).stdout.trim();
      const parentMatch = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(parentEntry);
      const parentSha =
        parentMatch?.[3] !== undefined && parentMatch[2] === "blob"
          ? parentMatch[3]
          : undefined;
      const recoveredBlob = await worktreeBlob(recoveryDir, relative);
      const expected =
        parentSha === undefined
          ? undefined
          : (proposal.expectedBlobs.get(relative) ?? parentSha);
      const stillPristine =
        parentSha === undefined
          ? recoveredBlob === undefined
          : recoveredBlob === expected;
      if (!stillPristine) {
        skipped.push(relative);
        continue;
      }
      const source = path.join(group.sourceRoot, relative);
      if (parentMatch === null) continue;
      const [, mode, kind, sha] = parentMatch;
      if (kind === "tree") {
        await fs.promises.mkdir(source, { recursive: true });
        continue;
      }
      if (kind !== "blob") continue;
      const content = (
        await git(["cat-file", "blob", sha!], {
          cwd: group.sourceRoot,
          buffer: true,
        })
      ).stdoutBuffer;
      await fs.promises.mkdir(path.dirname(source), { recursive: true });
      if (mode === "120000") {
        await fs.promises.symlink(content.toString("utf8"), source);
      } else {
        await fs.promises.writeFile(source, content, {
          mode: mode === "100755" ? 0o755 : 0o644,
        });
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
  return skipped;
}

/**
 * Phase 1 — per worker, in task order: terminate leftover processes, turn
 * the surviving worker tree into a durable proposal (private ref + full
 * binary patch), and test-merge it onto the integrated chain in a disposable
 * candidate worktree. Failures are all-or-nothing and retain artifacts.
 */
async function collectProposals(
  group: IsolatedGroup,
  workers: Map<number, IsolatedWorker>,
  results: TaskOutcome[],
  options: IsolatedReconcileOptions,
): Promise<AcceptedProposal[]> {
  const accepted: AcceptedProposal[] = [];
  let integratedCommit = group.baselineCommit;

  for (const taskIndex of group.taskIndexes) {
    const worker = workers.get(taskIndex)!;
    const outcome = results[taskIndex];
    // A missing outcome means the task's runner failed to record anything —
    // keep the worker's evidence and let the batch-level failure handler
    // report it.
    if (!outcome) {
      worker.retained = true;
      continue;
    }
    const setIntegration = (integration: TaskIntegration) => {
      results[taskIndex] = withIntegration(results[taskIndex]!, integration);
    };

    if (outcome.quarantined) {
      worker.retained = true;
      setIntegration({
        status: "discarded",
        reason:
          "Worker termination was never confirmed; its proposal was not snapshotted or applied. The recovery worktree is retained until quiescence is confirmed.",
        proposedFiles: [],
        appliedFiles: [],
        worktreePath: worker.workerRoot,
      });
      continue;
    }

    try {
      await stopWorkspaceProcesses(worker.workerRoot);
    } catch (error) {
      worker.retained = true;
      setIntegration({
        status: "discarded",
        reason: error instanceof Error ? error.message : String(error),
        proposedFiles: [],
        appliedFiles: [],
        worktreePath: worker.workerRoot,
      });
      continue;
    }

    if (outcome.status !== "ok") {
      const removed = await removeWorktree(group.sourceRoot, worker.workerRoot);
      setIntegration({
        status: "discarded",
        reason: outcome.error ?? `task ${outcome.status}; nothing to apply`,
        proposedFiles: [],
        appliedFiles: [],
        ...(removed ? {} : { worktreePath: worker.workerRoot }),
      });
      continue;
    }

    try {
      const proposalTree = await snapshotTree(
        worker.workerRoot,
        group.baselineCommit,
        path.join(group.artifactRoot, `proposal-${taskIndex}.index`),
        options.signal,
      );
      const proposedFiles = await changedFiles(
        group.sourceRoot,
        group.baselineCommit,
        proposalTree,
      );
      if (!proposedFiles.length) {
        const removed = await removeWorktree(
          group.sourceRoot,
          worker.workerRoot,
        );
        setIntegration({
          status: "no_changes",
          proposedFiles: [],
          appliedFiles: [],
          ...(removed ? {} : { worktreePath: worker.workerRoot }),
        });
        continue;
      }

      // Durable recovery representation before anything else happens to the
      // worker: a private ref plus a full binary patch on disk.
      const proposalCommit = await commitTree(
        group.sourceRoot,
        proposalTree,
        group.baselineCommit,
        `pi-delegate isolated proposal ${taskIndex + 1}`,
        options.signal,
      );
      await git(["update-ref", worker.proposalRef, proposalCommit], {
        cwd: group.sourceRoot,
        signal: options.signal,
      });
      worker.proposalCreated = true;
      await writePatch(
        group.sourceRoot,
        group.baselineCommit,
        proposalCommit,
        worker.patchPath,
      );
      const workerRemoved = await removeWorktree(
        group.sourceRoot,
        worker.workerRoot,
      );

      // Test-merge the proposal onto everything accepted so far. The
      // candidate worktree is disposable; the merge result becomes the next
      // link of the integrated chain.
      const candidateRoot = path.join(
        group.artifactRoot,
        `candidate-${taskIndex}`,
      );
      await addWorktree(
        group.sourceRoot,
        candidateRoot,
        integratedCommit,
        options.signal,
      );
      try {
        await git(["apply", "--3way", "--index", worker.patchPath], {
          cwd: candidateRoot,
          signal: options.signal,
        });
      } catch (error) {
        const reason =
          error instanceof GitCommandError
            ? error.stderr.trim() || error.message
            : error instanceof Error
              ? error.message
              : String(error);
        setIntegration({
          status: "conflict",
          proposedFiles,
          appliedFiles: [],
          conflicts: [{ path: "(proposal)", reason }],
          baselineRef: group.baselineRef,
          proposalRef: worker.proposalRef,
          patchPath: worker.patchPath,
          // The surviving worker worktree is the better recovery pointer —
          // it holds the clean proposal state; the candidate holds merge
          // remnants.
          worktreePath: workerRemoved ? candidateRoot : worker.workerRoot,
        });
        continue;
      }
      const mergedTree = (
        await git(["write-tree"], { cwd: candidateRoot, signal: options.signal })
      ).stdout.trim();
      const chainCommit = await commitTree(
        group.sourceRoot,
        mergedTree,
        integratedCommit,
        `pi-delegate integrate proposal ${taskIndex + 1}`,
        options.signal,
      );
      await removeWorktree(group.sourceRoot, candidateRoot);
      accepted.push({
        taskIndex,
        parent: integratedCommit,
        commit: chainCommit,
        files: proposedFiles,
        // Snapshot the worker's exact post-run blobs now — the worktree
        // may already be gone (workerRemoved) and the source may drift
        // before Phase 2 runs. The source apply verifies each touched
        // path against this snapshot so recovery restores the pre-apply
        // content without clobbering unrelated working-tree changes.
        expectedBlobs: await trackedBlobs(group.sourceRoot, chainCommit),
        workerRemoved,
      });
      integratedCommit = chainCommit;
      // No integration is recorded yet: source application (Phase 2) still
      // has to run. Recording applied_unverified here would falsely report
      // success — and let cleanup delete the recovery net — if Phase 2
      // never reaches this proposal because an earlier Git call fails.
    } catch (error) {
      // A mid-snapshot abort is a cancellation, not a proposal failure:
      // retain whatever evidence exists for recovery.
      if (options.signal?.aborted) {
        setIntegration({
          status: "retained",
          reason:
            options.retainedReason ??
            "The call was aborted before source application.",
          proposedFiles: [],
          appliedFiles: [],
          baselineRef: group.baselineRef,
          proposalRef: worker.proposalCreated ? worker.proposalRef : undefined,
          patchPath: pathEntryExists(worker.patchPath)
            ? worker.patchPath
            : undefined,
          worktreePath: pathEntryExists(worker.workerRoot)
            ? worker.workerRoot
            : undefined,
        });
        continue;
      }
      setIntegration({
        status: "apply_failed",
        proposedFiles: [],
        appliedFiles: [],
        conflicts: [
          {
            path: "(workspace)",
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalCreated ? worker.proposalRef : undefined,
        patchPath: pathEntryExists(worker.patchPath)
          ? worker.patchPath
          : undefined,
        worktreePath: pathEntryExists(worker.workerRoot)
          ? worker.workerRoot
          : undefined,
      });
    }
  }
  return accepted;
}

/**
 * Phase 2 — apply each accepted proposal to the source tree, in task order.
 * Each delta is the chain edge (chain parent → chain commit) applied to the
 * worktree only — the user's index and branch never move. A `--check` first
 * verifies that proposal's baseline assumptions still hold; drift marks only
 * that proposal a conflict — later independent proposals are still
 * considered. A failed apply restores the expected pre-apply content and
 * preserves recovery artifacts.
 */
async function applyToSource(
  group: IsolatedGroup,
  workers: Map<number, IsolatedWorker>,
  results: TaskOutcome[],
  accepted: readonly AcceptedProposal[],
  options: IsolatedReconcileOptions,
): Promise<void> {
  if (!accepted.length) return;
  const reason = options.retainedReason ?? "Source application was cancelled.";

  let stopped = false;
  for (const proposal of accepted) {
    const worker = workers.get(proposal.taskIndex)!;
    const outcome = results[proposal.taskIndex]!;
    if (stopped || !options.shouldApplySource()) {
      stopped = true;
      results[proposal.taskIndex] = withIntegration(outcome, {
        status: "retained",
        reason,
        proposedFiles: proposal.files,
        appliedFiles: [],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
      });
      continue;
    }

    // The applied delta is the chain edge (parent → chain commit); an empty
    // edge means the proposal's effect is already in the integrated state —
    // e.g. an earlier proposal made the identical change — so the desired
    // end state holds and there is nothing to write. `git apply` rejects
    // empty input, so this must be detected before reaching it.
    //
    // Every Git call between collecting the patch and applying it can fail.
    // Such a failure must never leave the optimistic Phase-1 state (or no
    // state) standing as a false success: mark apply_failed honestly and
    // keep the recovery artifacts.
    let deltaPaths: string[];
    let delta: string;
    try {
      deltaPaths = await changedFiles(
        group.sourceRoot,
        proposal.parent,
        proposal.commit,
      );
    } catch (error) {
      results[proposal.taskIndex] = withIntegration(outcome, {
        status: "apply_failed",
        proposedFiles: proposal.files,
        appliedFiles: [],
        conflicts: [
          {
            path: "(source apply)",
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
        ...(proposal.workerRemoved ? {} : { worktreePath: worker.workerRoot }),
      });
      continue;
    }
    if (!deltaPaths.length) {
      results[proposal.taskIndex] = withIntegration(outcome, {
        status: "applied_unverified",
        proposedFiles: proposal.files,
        appliedFiles: [],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
        ...(proposal.workerRemoved ? {} : { worktreePath: worker.workerRoot }),
      });
      continue;
    }
    try {
      delta = await diffPatch(
        group.sourceRoot,
        proposal.parent,
        proposal.commit,
      );
    } catch (error) {
      results[proposal.taskIndex] = withIntegration(outcome, {
        status: "apply_failed",
        proposedFiles: proposal.files,
        appliedFiles: [],
        conflicts: [
          {
            path: "(source apply)",
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
        ...(proposal.workerRemoved ? {} : { worktreePath: worker.workerRoot }),
      });
      continue;
    }
    // Read-only verification, in both directions: the forward `--check`
    // catches drift (the source moved under the proposal — a conflict),
    // and the reverse `--check --reverse` catches a proposal whose change
    // is already present in the source. The reverse check only runs after
    // the forward check FAILED — a delta that applies cleanly forward is
    // by definition not already present, so a passing forward check skips
    // straight to the write. Both checks are read-only; neither writes.
    try {
      await git(["apply", "--check"], {
        cwd: group.sourceRoot,
        input: delta,
        signal: options.signal,
      });
    } catch (error) {
      // The change may already be present — e.g. an earlier proposal
      // already landed an identical change and a later write re-dirtied it
      // back, or the source already contained it. Writing the delta again
      // would double-apply it (duplicate lines) while reporting success
      // for changes that never landed. An aborted reverse check is a
      // cancellation like the forward one, not drift evidence.
      let alreadyPresent = false;
      try {
        await git(["apply", "--check", "--reverse"], {
          cwd: group.sourceRoot,
          input: delta,
          signal: options.signal,
        });
        alreadyPresent = true;
      } catch {
        if (options.signal?.aborted || !options.shouldApplySource()) {
          stopped = true;
          results[proposal.taskIndex] = withIntegration(outcome, {
            status: "retained",
            reason,
            proposedFiles: proposal.files,
            appliedFiles: [],
            baselineRef: group.baselineRef,
            proposalRef: worker.proposalRef,
            patchPath: worker.patchPath,
          });
          continue;
        }
        // Genuinely inapplicable forward AND reverse: real drift below.
      }
      if (alreadyPresent) {
        results[proposal.taskIndex] = withIntegration(outcome, {
          status: "applied_unverified",
          proposedFiles: proposal.files,
          appliedFiles: [],
          baselineRef: group.baselineRef,
          proposalRef: worker.proposalRef,
          patchPath: worker.patchPath,
          ...(proposal.workerRemoved ? {} : { worktreePath: worker.workerRoot }),
        });
        continue;
      }
      // An aborted or gated check is a cancellation, not drift evidence.
      if (options.signal?.aborted || !options.shouldApplySource()) {
        stopped = true;
        results[proposal.taskIndex] = withIntegration(outcome, {
          status: "retained",
          reason,
          proposedFiles: proposal.files,
          appliedFiles: [],
          baselineRef: group.baselineRef,
          proposalRef: worker.proposalRef,
          patchPath: worker.patchPath,
        });
        continue;
      }
      results[proposal.taskIndex] = withIntegration(outcome, {
        status: "conflict",
        proposedFiles: proposal.files,
        appliedFiles: [],
        conflicts: [
          {
            path: "(source tree)",
            reason: `The source tree changed after the baseline was captured; the proposal was retained instead of applied. ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
      });
      continue;
    }

    // Verify-before-write: every path this delta touches must still hold
    // its expected pre-apply content (the chain-parent blob). A path the
    // user or another process changed after the check is left alone and
    // the proposal becomes a conflict — overwriting it would silently
    // erase unrelated working-tree edits, and restoring it from an older
    // snapshot would do the same.
    const stalePaths: string[] = [];
    for (const relative of deltaPaths) {
      const expected = proposal.expectedBlobs.get(relative);
      const parentEntry = (
        await git(["ls-tree", proposal.parent, "--", relative], {
          cwd: group.sourceRoot,
        })
      ).stdout.trim();
      const parentMatch = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(parentEntry);
      const parentSha =
        parentMatch?.[3] !== undefined && parentMatch[2] === "blob"
          ? parentMatch[3]
          : undefined;
      const current = await worktreeBlob(group.sourceRoot, relative);
      // A path the proposal itself creates has no parent blob: it must
      // still be absent. A path the proposal deletes has no expected
      // blob: the deletion must still match the parent.
      const matches =
        parentSha === undefined
          ? current === undefined
          : expected !== undefined && current === expected
            ? true
            : current === parentSha;
      if (!matches) stalePaths.push(relative);
    }
    if (stalePaths.length > 0) {
      results[proposal.taskIndex] = withIntegration(outcome, {
        status: "conflict",
        proposedFiles: proposal.files,
        appliedFiles: [],
        conflicts: stalePaths.map((relative) => ({
          path: relative,
          reason:
            "The source tree changed after the baseline was captured; the proposal was retained instead of applied.",
        })),
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
      });
      continue;
    }

    // Writability probe: `git apply --check` never touches the files, so
    // without this a file made read-only after the check fails the real
    // write mid-way — after earlier paths in the same delta already landed
    // (partial application), forcing recovery to restore every touched
    // path from the snapshot and erase unrelated edits. Failing here keeps
    // the proposal a clean conflict with the source untouched.
    const unwritable = [] as string[];
    for (const relative of deltaPaths) {
      try {
        await fs.promises.access(
          path.join(group.sourceRoot, relative),
          fs.constants.W_OK,
        );
      } catch {
        unwritable.push(relative);
      }
    }
    // A path the proposal creates has nothing to probe — the check is for
    // existing files the apply must overwrite. Filter to paths present in
    // the chain parent (created paths are absent there).
    if (unwritable.length > 0) {
      const existing = [] as string[];
      for (const relative of unwritable) {
        const entry = (
          await git(["ls-tree", proposal.parent, "--", relative], {
            cwd: group.sourceRoot,
          })
        ).stdout.trim();
        if (/^\d+ \w+ [0-9a-f]+\t/.test(entry)) existing.push(relative);
      }
      if (existing.length > 0) {
        results[proposal.taskIndex] = withIntegration(outcome, {
          status: "conflict",
          proposedFiles: proposal.files,
          appliedFiles: [],
          conflicts: existing.map((relative) => ({
            path: relative,
            reason:
              "The file is not writable; the proposal was retained instead of applied.",
          })),
          baselineRef: group.baselineRef,
          proposalRef: worker.proposalRef,
          patchPath: worker.patchPath,
        });
        continue;
      }
    }

    try {
      await git(["apply", "--binary"], {
        cwd: group.sourceRoot,
        input: delta,
        signal: options.signal,
      });
    } catch (error) {
      // The checks passed but the write failed mid-way: move whatever the
      // apply left behind into recovery artifacts and restore the expected
      // pre-apply content — but only for paths that still hold the
      // verified pre-apply state. A path whose content no longer matches
      // was changed by someone else after verification; restoring it from
      // the older snapshot would erase that unrelated edit, so it is
      // left in place and named in the outcome.
      const recoveryDir = path.join(
        group.artifactRoot,
        `failed-apply-${proposal.taskIndex}`,
      );
      let rollbackSucceeded = true;
      let unrestored: string[] = [];
      try {
        unrestored = await restorePreApplyState(
          group,
          proposal,
          // Roll back only the paths this delta actually touched — the
          // proposal's file list can include no-ops the merge dropped, and
          // restoring those would clobber unrelated source drift.
          deltaPaths,
          recoveryDir,
        );
        rollbackSucceeded = unrestored.length === 0;
        if (!rollbackSucceeded) {
          log(
            `isolated apply rollback left ${unrestored.join(", ")} unrestored for task ${proposal.taskIndex}; unrelated edits preserved, recovery artifacts retained`,
            "",
          );
        }
      } catch (rollbackError) {
        rollbackSucceeded = false;
        log(
          `isolated apply rollback failed for task ${proposal.taskIndex}; recovery artifacts retained`,
          rollbackError,
        );
      }
      // An aborted apply is a cancellation, not a proposal failure: the
      // restored baseline holds and the proposal is retained for recovery.
      if (options.signal?.aborted && rollbackSucceeded) {
        stopped = true;
        results[proposal.taskIndex] = withIntegration(outcome, {
          status: "retained",
          reason,
          proposedFiles: proposal.files,
          appliedFiles: [],
          baselineRef: group.baselineRef,
          proposalRef: worker.proposalRef,
          patchPath: worker.patchPath,
        });
        continue;
      }
      results[proposal.taskIndex] = withIntegration(outcome, {
        status: "apply_failed",
        proposedFiles: proposal.files,
        appliedFiles: [],
        conflicts: [
          {
            path: "(source apply)",
            reason: error instanceof Error ? error.message : String(error),
          },
          ...unrestored.map((relative) => ({
            path: relative,
            reason:
              "The file changed after verification and was left in place; its post-apply content is in the recovery directory.",
          })),
        ],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
        worktreePath: recoveryDir,
      });
      continue;
    }

    // The write succeeded: only now is applied_unverified honest. It is
    // recorded here (not during collection) so a Git failure between
    // collecting the patch and applying it can never stand as success.
    results[proposal.taskIndex] = withIntegration(outcome, {
      status: "applied_unverified",
      proposedFiles: proposal.files,
      appliedFiles: proposal.files,
      baselineRef: group.baselineRef,
      proposalRef: worker.proposalRef,
      patchPath: worker.patchPath,
      ...(proposal.workerRemoved ? {} : { worktreePath: worker.workerRoot }),
    });
  }
}

/** Mark every group task that still lacks a terminal integration outcome. */
async function markGroupFailure(
  group: IsolatedGroup,
  workers: Map<number, IsolatedWorker>,
  results: TaskOutcome[],
  error: unknown,
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  for (const taskIndex of group.taskIndexes) {
    const outcome = results[taskIndex];
    if (!outcome) continue;
    // Any recorded integration is already the accurate story — an applied
    // proposal must not be rewritten as apply_failed because a later group
    // step threw, and discarded/conflict/retained carry their own reasons.
    if (outcome.integration !== undefined) continue;
    const worker = workers.get(taskIndex)!;
    results[taskIndex] = withIntegration(outcome, {
      status: "apply_failed",
      proposedFiles: [],
      appliedFiles: [],
      conflicts: [{ path: "(batch)", reason }],
      baselineRef: group.baselineRef,
      proposalRef: worker.proposalCreated ? worker.proposalRef : undefined,
      patchPath: pathEntryExists(worker.patchPath)
        ? worker.patchPath
        : undefined,
      worktreePath: pathEntryExists(worker.workerRoot)
        ? worker.workerRoot
        : undefined,
    });
  }
}

/**
 * Drop refs and artifacts a finished group no longer needs. A group that
 * retained recovery evidence (conflicts, retained proposals, deferred
 * workers, failed applies) keeps its baseline ref and artifact directory.
 */
async function cleanupGroup(
  group: IsolatedGroup,
  workers: Map<number, IsolatedWorker>,
  results: readonly TaskOutcome[],
): Promise<void> {
  const disposableRefs: string[] = [];
  let retainsArtifacts = false;
  for (const taskIndex of group.taskIndexes) {
    const worker = workers.get(taskIndex)!;
    const integration = results[taskIndex]?.integration;
    const status = integration?.status;
    if (
      !worker.retained &&
      integration?.worktreePath === undefined &&
      (status === "applied_unverified" ||
        status === "no_changes" ||
        status === "discarded")
    ) {
      if (worker.proposalCreated) disposableRefs.push(worker.proposalRef);
      continue;
    }
    retainsArtifacts = true;
  }
  const refs = retainsArtifacts
    ? disposableRefs
    : [...disposableRefs, group.baselineRef];
  for (const ref of refs) {
    try {
      await git(["update-ref", "-d", ref], { cwd: group.sourceRoot });
    } catch (error) {
      log(`failed to clean isolated ref ${ref}`, error);
    }
  }
  if (retainsArtifacts) return;
  try {
    await fs.promises.rm(group.artifactRoot, { recursive: true, force: true });
  } catch (error) {
    log(`failed to remove isolated artifacts '${group.artifactRoot}'`, error);
  }
}

/**
 * Prepare detached worker worktrees for every isolated task in `phase`,
 * one group per source repository. Each group gets a synthetic baseline
 * commit capturing the source's dirty state (tracked, deleted, and
 * untracked) without touching the user's branch or index. Throws —
 * failing the whole call or phase — when a source root is unusable;
 * everything created so far is removed. The phase filter keeps a
 * dependent's baseline at its phase's start, after earlier phases'
 * proposals applied.
 */
export async function prepareIsolated(
  tasks: readonly ResolvedTask[],
  artifactBase: string,
  signal: AbortSignal | undefined,
  excludedPaths: readonly string[] = [],
  phase: number,
): Promise<IsolatedPlan | undefined> {
  const isolatedIndexes = tasks
    .map((task, index) =>
      task.workspace === "isolated" && task.phase === phase ? index : -1,
    )
    .filter((index) => index >= 0);
  if (!isolatedIndexes.length) return undefined;

  const batchId = randomUUID();
  const batchRoot = path.join(artifactBase, batchId);
  const groupsByRoot = new Map<string, IsolatedGroup>();
  const workers = new Map<number, IsolatedWorker>();
  const translated = [...tasks];

  let preparationUndone = false;
  const undoPreparation = async (): Promise<void> => {
    if (preparationUndone) return;
    preparationUndone = true;
    let worktreeCleanupFailed = false;
    for (const worker of workers.values()) {
      if (!(await removeWorktree(worker.group.sourceRoot, worker.workerRoot))) {
        worktreeCleanupFailed = true;
      }
    }
    for (const group of groupsByRoot.values()) {
      try {
        await git(["update-ref", "-d", group.baselineRef], {
          cwd: group.sourceRoot,
        });
      } catch (cleanupError) {
        log("failed to clean isolated baseline ref after preparation error", cleanupError);
      }
      group.finishReconcile();
    }
    if (!worktreeCleanupFailed) {
      await fs.promises
        .rm(batchRoot, { recursive: true, force: true })
        .catch((cleanupError: unknown) =>
          log("failed to remove isolated artifacts after preparation error", cleanupError),
        );
    }
  };

  try {
    for (const taskIndex of isolatedIndexes) {
      const task = tasks[taskIndex]!;
      const sourceRoot = await repositoryRoot(task.cwd, signal);
      let group = groupsByRoot.get(sourceRoot);
      if (!group) {
        const sourceHead = (
          await git(["rev-parse", "HEAD"], { cwd: sourceRoot, signal })
        ).stdout.trim();
        const artifactRoot = path.join(
          batchRoot,
          createHash("sha256").update(sourceRoot).digest("hex").slice(0, 12),
        );
        await fs.promises.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
        // The artifact root can live inside the source tree (e.g. an
        // agentDir under the repo): never snapshot retained artifacts or
        // live worktrees into a baseline, or a worker could "delete" them
        // into a proposal. Sibling delegate trees are excluded by name via
        // DELEGATE_TREES so a future workspace mode cannot reintroduce the
        // leak. The batch root is excluded separately for the pathological
        // case where the artifact base IS the source root.
        const excluded: string[] = [];
        for (const base of [
          artifactBase,
          batchRoot,
          path.join(path.dirname(artifactBase), DELEGATE_TREES.scratch),
          path.join(path.dirname(artifactBase), DELEGATE_TREES.sessions),
          ...excludedPaths,
        ]) {
          const resolved = canonicalPath(base);
          const relative = path.relative(sourceRoot, resolved);
          if (relative !== "" && isWithin(sourceRoot, resolved)) {
            excluded.push(relative);
          }
        }
        const baselineTree = await snapshotTree(
          sourceRoot,
          sourceHead,
          path.join(artifactRoot, "baseline.index"),
          signal,
          excluded,
        );
        const baselineCommit = await commitTree(
          sourceRoot,
          baselineTree,
          sourceHead,
          "pi-delegate isolated baseline",
          signal,
        );
        const baselineRef = privateRef(
          batchId,
          `${groupsByRoot.size}/baseline`,
        );
        await git(["update-ref", baselineRef, baselineCommit], {
          cwd: sourceRoot,
          signal,
        });
        let finishReconcile!: () => void;
        const reconcileDone = new Promise<void>((resolve) => {
          finishReconcile = resolve;
        });
        group = {
          sourceRoot,
          artifactRoot,
          baselineCommit,
          baselineRef,
          taskIndexes: [],
          reconcileDone,
          finishReconcile,
        };
        groupsByRoot.set(sourceRoot, group);
      }

      const sourceCwd = await fs.promises.realpath(task.cwd);
      const workerRoot = path.join(group.artifactRoot, `worker-${taskIndex}`);
      const workerCwd = path.join(
        workerRoot,
        path.relative(group.sourceRoot, sourceCwd),
      );
      workers.set(taskIndex, {
        group,
        taskIndex,
        workerRoot,
        proposalRef: privateRef(batchId, `${taskIndex}/proposal`),
        proposalCreated: false,
        patchPath: path.join(group.artifactRoot, `proposal-${taskIndex}.patch`),
        retained: false,
      });
      await addWorktree(sourceRoot, workerRoot, group.baselineCommit, signal);
      // A task cwd that was untracked or ignored in the source may be absent
      // from the baseline tree; the worker still needs a directory.
      await fs.promises.mkdir(workerCwd, { recursive: true });
      group.taskIndexes.push(taskIndex);
      translated[taskIndex] = { ...task, cwd: workerCwd };
    }
  } catch (error) {
    await undoPreparation();
    throw error;
  }

  return {
    tasks: translated,
    async reconcile(
      outcomes: TaskOutcome[],
      options: IsolatedReconcileOptions,
    ): Promise<readonly TaskOutcome[]> {
      const results = outcomes;
      for (const group of groupsByRoot.values()) {
        try {
          const accepted = await collectProposals(
            group,
            workers,
            results,
            options,
          );
          await applyToSource(group, workers, results, accepted, options);
        } catch (error) {
          log("isolated group reconciliation failed", error);
          await markGroupFailure(group, workers, results, error);
        }
        try {
          await cleanupGroup(group, workers, results);
        } finally {
          group.finishReconcile();
        }
      }
      try {
        await fs.promises.rmdir(batchRoot);
      } catch {
        // Retained artifacts or never created — leave the directory.
      }
      return results;
    },
    async cleanupWorker(taskIndex: number): Promise<void> {
      const worker = workers.get(taskIndex);
      if (!worker?.retained) return;
      await worker.group.reconcileDone;
      try {
        await stopWorkspaceProcesses(worker.workerRoot);
      } catch (error) {
        log(`deferred isolated worker cleanup could not stop processes in '${worker.workerRoot}'; retaining it`, error);
        return;
      }
      if (await removeWorktree(worker.group.sourceRoot, worker.workerRoot)) {
        worker.retained = false;
        await fs.promises
          .rmdir(worker.group.artifactRoot)
          .catch(() => undefined);
      }
    },
    dispose: undoPreparation,
  };
}

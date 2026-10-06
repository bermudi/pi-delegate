import { DiagnosticSink, isDiagnosticPath } from "./diagnostics.ts";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalPath,
  DELEGATE_TREES,
  exec,
  gitProbeEnv,
  isWithin,
  stopWorkspaceProcesses,
} from "./fsx.ts";
import {
  changedFiles,
  snapshotTree,
  SOURCE_DRIFT_LIMIT,
} from "./isolated.ts";
import type { ResolvedTask, TaskOutcome } from "./types.ts";

// Probes fail fast and produce tiny output; the shared exec takes explicit
// limits so the per-use divergence from the copy path stays visible.
const PROBE_EXEC = { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024 } as const;

const FALLBACK_REMEDY =
  `Resubmit with workspace: "shared" to run in the source tree, ` +
  `or "isolated" for a detached Git worktree.`;

function log(diagnostics: DiagnosticSink, context: string, error: unknown): void {
  diagnostics.log("error", "scratch workspace cleanup/evidence", { operation: context }, error);
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
): Promise<{ root: string; cwd: string; gitRoot: boolean }> {
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
  const gitRoot = root !== undefined;
  root ??= physicalCwd;
  const dotGit = await fs.promises
    .lstat(path.join(root, ".git"))
    .catch(() => null);
  if (dotGit?.isFile()) {
    throw new Error(
      `workspace "scratch" cannot copy '${root}': its .git is a file redirecting into another repository (linked worktree or submodule), so Git commands inside the copy would mutate the real repository. ${FALLBACK_REMEDY}`,
    );
  }
  return { root, cwd: physicalCwd, gitRoot };
}

/** Filter before copying: copying then deleting would expose runtime records
 * to workers and copied Git state. Node preserves links verbatim; the shared
 * predicate omits reserved trees and their existing symlink aliases. */
async function copyTree(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await fs.promises.cp(source, destination, {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (candidate) => {
        if (signal?.aborted) throw new Error("aborted");
        return !isDiagnosticPath(candidate);
      },
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
async function sweepStaleCopies(diagnostics: DiagnosticSink, scratchBase: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(scratchBase, { withFileTypes: true });
  } catch (error) {
    // Nothing to sweep is normal; an unreadable base is worth a line, but
    // litter cleanup must never fail a dispatch.
    log(diagnostics, `failed to list scratch copies in '${scratchBase}'`, error);
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
        log(diagnostics, `failed to sweep stale scratch copies '${entry.name}'`, error),
      );
  }
}

/** rmdir-if-empty: removes the directory only when nothing remains in it. */
async function pruneEmpty(dir: string): Promise<void> {
  await fs.promises.rmdir(dir).catch(() => undefined);
}

interface ScratchWorker {
  readonly taskIndex: number;
  /** The tree this worker copied — the drift window it belongs to. */
  readonly sourceRoot: string;
  readonly copyRoot: string;
  /** Settled caller-visibly with quiescence unconfirmed — copy stays on disk. */
  retained: boolean;
}

/**
 * One scratch source root's drift window (#62): the working-state tree the
 * phase's copies were taken from, plus the settled drift once captured.
 * Scratch proposals are discarded by definition, so a shell escape into
 * the original tree is the one mutation that would otherwise vanish
 * silently — the window gives it the same evidence the isolated check
 * reports.
 */
interface ScratchDrift {
  readonly sourceRoot: string;
  /** The phase this window belongs to — only same-phase siblings overlap it. */
  readonly phase: number;
  /** Repository-relative pathspecs kept out of both drift snapshots. */
  readonly excluded: readonly string[];
  /** Index path shared by the start and end snapshots (each rm's it first). */
  readonly indexPath: string;
  /** Start-of-phase working-state tree oid. */
  readonly startTree: string;
  /** Source-relative changed paths — sorted, bounded — once captured. */
  drift?: readonly string[];
}

/**
 * Open one source root's drift window: snapshot the working state the
 * phase's copies were taken from. Delegate-owned trees that churn mid-run
 * (every agent-dir tree, telemetry-owned paths) are excluded so our own
 * bookkeeping can never pose as drift. Seeded from HEAD when the
 * repository has commits — a warm index — and an empty index otherwise.
 * Best-effort like the copy itself: evidence that cannot be gathered
 * logs and skips, it never fails containment.
 */
async function openDriftWindow(
  diagnostics: DiagnosticSink,
  sourceRoot: string,
  phase: number,
  scratchBase: string,
  batchRoot: string,
  excludedPaths: readonly string[],
  indexPath: string,
  signal?: AbortSignal,
): Promise<ScratchDrift> {
  const delegateDir = path.dirname(canonicalPath(scratchBase));
  const excluded: string[] = [];
  for (const base of [
    scratchBase,
    batchRoot,
    ...Object.values(DELEGATE_TREES).map((tree) =>
      path.join(delegateDir, tree),
    ),
    ...excludedPaths,
  ]) {
    const resolved = canonicalPath(base);
    const relative = path.relative(sourceRoot, resolved);
    if (relative !== "" && isWithin(sourceRoot, resolved)) {
      excluded.push(relative);
    }
  }
  let head: string | undefined;
  try {
    head =
      (
        await exec("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
          ...PROBE_EXEC,
          env: gitProbeEnv(),
          signal,
        })
      ).stdout.trim() || undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    // Unborn repository (no commits): the empty-index seed covers it.
  }
  const startTree = await snapshotTree(
    diagnostics,
    sourceRoot,
    head,
    indexPath,
    signal,
    excluded,
  );
  return { sourceRoot, phase, excluded, indexPath, startTree };
}

export interface ScratchPlan {
  /** The task list with each scratch task's cwd remapped into its copy. */
  readonly tasks: readonly ResolvedTask[];
  /**
   * Close every drift window (#62): re-snapshot each Git-backed source and
   * diff against the start tree. Must run before isolated reconciliation
   * applies proposals into the source — after an apply, drift cannot tell
   * a legitimate apply from a shell escape. Never throws: a check that
   * fails logs and leaves that window's drift unset.
   */
  captureDrift(): Promise<void>;
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
  diagnostics: DiagnosticSink,
  tasks: readonly ResolvedTask[],
  scratchBase: string,
  signal: AbortSignal | undefined,
  phase: number,
  excludedPaths: readonly string[] = [],
): Promise<ScratchPlan | undefined> {
  const scratchIndexes = tasks
    .map((task, index) =>
      task.workspace === "scratch" && task.phase === phase ? index : -1,
    )
    .filter((index) => index >= 0);
  if (!scratchIndexes.length) return undefined;

  await sweepStaleCopies(diagnostics, scratchBase);
  const procRoot = path.join(scratchBase, `pid-${process.pid}`);
  const batchRoot = path.join(procRoot, randomUUID());
  const workers = new Map<number, ScratchWorker>();
  const translated = [...tasks];
  // One drift window per distinct Git-backed source root in this phase.
  const drifts = new Map<string, ScratchDrift>();
  const noDriftWarned = new Set<string>();

  try {
    for (const taskIndex of scratchIndexes) {
      const task = tasks[taskIndex]!;
      const { root, cwd, gitRoot } = await copySourceOf(task.cwd, signal);
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
      workers.set(taskIndex, { taskIndex, sourceRoot: root, copyRoot, retained: false });
      // #62: open the drift window for the first Git-backed copy of this
      // root. Best-effort — evidence that cannot be gathered logs and
      // skips; containment never depended on it.
      if (gitRoot) {
        if (!drifts.has(root)) {
          const indexPath = path.join(
            batchRoot,
            `drift-${createHash("sha256").update(root).digest("hex").slice(0, 12)}.index`,
          );
          try {
            drifts.set(
              root,
              await openDriftWindow(
                diagnostics,
                root,
                phase,
                scratchBase,
                batchRoot,
                excludedPaths,
                indexPath,
                signal,
              ),
            );
          } catch (error) {
            if (signal?.aborted) throw error;
            log(diagnostics, `scratch drift evidence unavailable for '${root}'`, error);
          }
        }
      } else if (!noDriftWarned.has(root)) {
        noDriftWarned.add(root);
        diagnostics.log("warn", "scratch drift evidence unavailable: not a usable Git repository", { path: root });
      }
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
        log(diagnostics, "failed to remove scratch copies after preparation error", cleanupError),
      );
    throw error;
  }

  const discard = async (worker: ScratchWorker): Promise<boolean> => {
    try {
      await stopWorkspaceProcesses(diagnostics, worker.copyRoot);
    } catch (error) {
      // A straggler keeps writing into an unlinked tree harmlessly; the
      // removal still proceeds — litter is worse than a wedged child.
      log(diagnostics,
        `could not stop leftover processes in scratch copy '${worker.copyRoot}'; removing it anyway`,
        error,
      );
    }
    try {
      await fs.promises.rm(worker.copyRoot, { recursive: true, force: true });
      return true;
    } catch (error) {
      log(diagnostics, `failed to remove scratch copy '${worker.copyRoot}'`, error);
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
    async captureDrift(): Promise<void> {
      for (const drift of drifts.values()) {
        try {
          // Deliberately NOT on the batch signal, mirroring the isolated
          // check: a cancelled batch still owes the drift report — the
          // surviving shell edits are exactly what the caller needs to
          // see. The end snapshot reuses the start index path (each
          // snapshotTree call removes it first).
          const endTree = await snapshotTree(
            diagnostics,
            drift.sourceRoot,
            drift.startTree,
            drift.indexPath,
            undefined,
            drift.excluded,
          );
          drift.drift = (
            await changedFiles(drift.sourceRoot, drift.startTree, endTree)
          )
            .sort()
            .slice(0, SOURCE_DRIFT_LIMIT);
        } catch (error) {
          log(diagnostics, `scratch drift check failed for '${drift.sourceRoot}'`, error);
        }
      }
    },
    async finalize(outcomes: TaskOutcome[]): Promise<readonly TaskOutcome[]> {
      for (const worker of workers.values()) {
        const outcome = outcomes[worker.taskIndex];
        if (!outcome || outcome.quarantined) {
          worker.retained = true;
          continue;
        }
        await discard(worker);
      }
      // #62: attach drift evidence to the shell-capable workers of each
      // drifted source — the same attribution rule as isolated: a worker
      // without a shell cannot have escaped, and drift beside no
      // shell-capable worker is the caller's own editing, not ours to pin.
      // Scratch outcomes carry no proposal integration, so a minimal one
      // ("discarded", nothing proposed or applied) grounds the evidence.
      for (const drift of drifts.values()) {
        if (drift.drift === undefined || drift.drift.length === 0) continue;
        // Review carve-out: a same-phase shared sibling writes the source
        // legitimately — admission seats it beside scratch on purpose —
        // so its attributed files are not escapes. Subtract those; but a
        // shell sibling with no Git coverage makes attribution for this
        // root impossible (its bash writes are unobservable), so pinning
        // is de-scoped for the whole root and says so once, like the
        // non-Git case. Only same-phase siblings matter: earlier phases
        // finished before this window opened, later ones write after it
        // closed.
        const rootCanon = canonicalPath(drift.sourceRoot);
        const underRoot = (candidate: string): boolean =>
          isWithin(rootCanon, canonicalPath(candidate));
        const siblingAttributed = new Set<string>();
        let unattributable = false;
        for (const [index, sibling] of tasks.entries()) {
          if (
            sibling.workspace !== "shared" ||
            sibling.phase !== drift.phase
          ) {
            continue;
          }
          const siblingOutcome = outcomes[index];
          if (!siblingOutcome) continue;
          // Same trust basis as overlap reporting: a sibling whose
          // window named concurrent writers can carry their changes in
          // its Git diff — subtracting those would hide real escapes,
          // so only its directly-observed paths count then.
          const attributed =
            (siblingOutcome.concurrentWriters?.length ?? 0) > 0
              ? (siblingOutcome.observedFiles ?? [])
              : (siblingOutcome.attributedFiles ?? []);
          const overlapsRoot =
            underRoot(sibling.cwd) || attributed.some(underRoot);
          if (!overlapsRoot) continue;
          // An uncovered-shell sibling is the only de-scoping case: a
          // Git-covered one's changes are already in its attributed set
          // and get subtracted by the loop below.
          if (siblingOutcome.uncertainFiles === true) {
            unattributable = true;
            break;
          }
          for (const file of attributed) {
            if (underRoot(file)) {
              siblingAttributed.add(path.relative(rootCanon, canonicalPath(file)));
            }
          }
        }
        if (unattributable) {
          diagnostics.log("warn", "scratch drift evidence suppressed: same-batch shared worker ran a shell in this tree", { path: drift.sourceRoot });
          continue;
        }
        if (siblingAttributed.size > 0) {
          const remaining = drift.drift.filter(
            (changed) => !siblingAttributed.has(changed),
          );
          if (remaining.length === 0) continue;
          if (remaining.length !== drift.drift.length) {
            diagnostics.log("info", "scratch drift: excluded files attributed to same-batch shared workers", { path: drift.sourceRoot, count: drift.drift.length - remaining.length });
          }
          drift.drift = remaining;
        }
        for (const worker of workers.values()) {
          if (worker.sourceRoot !== drift.sourceRoot) continue;
          const outcome = outcomes[worker.taskIndex];
          // Pin on "ran a shell", not on `uncertainFiles`: a Git-covered
          // copy's window cannot see writes that escaped to the source.
          if (!outcome || outcome.shellObserved !== true) continue;
          outcomes[worker.taskIndex] = {
            ...outcome,
            integration: {
              ...(outcome.integration ?? {
                status: "discarded",
                proposedFiles: [],
                appliedFiles: [],
              }),
              sourceDrift: drift.drift,
            },
          };
        }
      }
      await Promise.all(
        [...drifts.values()].map((drift) =>
          fs.promises.rm(drift.indexPath, { force: true }).catch((error) => {
            log(diagnostics, `failed to remove scratch drift index '${drift.indexPath}'`, error);
          }),
        ),
      );
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
          log(diagnostics, "failed to remove unused scratch copies", error),
        );
      await pruneEmpty(procRoot);
      await pruneEmpty(scratchBase);
    },
  };
}

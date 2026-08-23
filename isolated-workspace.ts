import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mapConcurrent } from "./concurrency.ts";
import { revalidateFileAttribution } from "./file-tracking.ts";
import {
  observeQuarantineSafety,
  sessionQuarantineOf,
} from "./session-quarantine.ts";
import type {
  FileAttribution,
  ResolvedTask,
  TaskIntegration,
  TaskResult,
} from "./types.ts";

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const PATH_CLASSIFICATION_CONCURRENCY = 16;
const PROCESS_GRACE_MS = 500;
let artifactBaseOverrideForTesting: string | undefined;
let removeWorktreeHookForTesting:
  | ((
      destination: string,
    ) => boolean | undefined | Promise<boolean | undefined>)
  | undefined;

/** @internal Keep tests out of the developer's real ~/.pi directory. */
export function _setIsolatedArtifactRootForTesting(
  root: string | undefined,
): void {
  artifactBaseOverrideForTesting = root;
}

/** @internal Deterministic failure/order seam for worktree cleanup tests. */
export function _setRemoveWorktreeHookForTesting(
  hook:
    | ((
        destination: string,
      ) => boolean | undefined | Promise<boolean | undefined>)
    | undefined,
): void {
  removeWorktreeHookForTesting = hook;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  return { ...env, ...extra };
}

function run(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    input?: string;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GitCommandError(
              `${file} ${args.join(" ")} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
              stderr,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function git(
  args: string[],
  options: Parameters<typeof run>[2] = {},
): Promise<CommandResult> {
  return run("git", args, {
    ...options,
    env: gitEnv(options.env),
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function errnoOf(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "UNKNOWN")
    : "UNKNOWN";
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    console.error(
      `[delegate] could not verify isolated recovery path ${JSON.stringify(candidate)} (errno=${code}); treating it as retained`,
    );
    return true;
  }
}

function logPathCanonicalizationFailure(
  candidate: string,
  error: unknown,
): void {
  const safeCandidate = JSON.stringify(
    candidate.length > 1_024
      ? `${candidate.slice(0, 1_024)}…[truncated ${candidate.length - 1_024} chars]`
      : candidate,
  )
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  console.error(
    `[delegate] could not canonicalize reported path ${safeCandidate} (errno=${errnoOf(error)}); retaining uncertain attribution`,
  );
}

interface PhysicalReportedPath {
  path: string;
  /** The path crossed a symlink that could not be fully resolved, or path
   * resolution itself failed. Such attribution must be retained rather than
   * assumed to be an ordinary path inside the disposable worktree. */
  uncertain: boolean;
}

/** Resolve symlinked ancestors even when the reported leaf no longer exists.
 * The final component is followed only for explicit edit/write attribution:
 * Git may instead be reporting a symlink node that was itself added or changed.
 * Resolution failures are data, not reconciliation failures; callers retain
 * uncertain attribution conservatively. */
async function physicalReportedPath(
  candidate: string,
  followFinalSymlink: boolean,
): Promise<PhysicalReportedPath> {
  let cursor = followFinalSymlink ? candidate : path.dirname(candidate);
  const suffix = followFinalSymlink ? [] : [path.basename(candidate)];

  for (;;) {
    try {
      const physical = await fs.promises.realpath(cursor);
      return { path: path.resolve(physical, ...suffix), uncertain: false };
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        logPathCanonicalizationFailure(candidate, error);
        return { path: candidate, uncertain: true };
      }

      // realpath reports ENOENT for a dangling symlink. Before walking up to
      // an existing parent (which would incorrectly make it look internal),
      // preserve the symlink's intended target and mark it uncertain.
      let stat: fs.Stats | undefined;
      try {
        stat = await fs.promises.lstat(cursor);
      } catch (lstatError) {
        const lstatCode =
          lstatError instanceof Error && "code" in lstatError
            ? (lstatError as NodeJS.ErrnoException).code
            : undefined;
        if (lstatCode !== "ENOENT" && lstatCode !== "ENOTDIR") {
          logPathCanonicalizationFailure(candidate, lstatError);
          return { path: candidate, uncertain: true };
        }
      }
      if (stat?.isSymbolicLink()) {
        try {
          const target = await fs.promises.readlink(cursor);
          const intended = path.resolve(
            path.dirname(cursor),
            target,
            ...suffix,
          );
          const resolved = await physicalReportedPath(intended, true);
          return { path: resolved.path, uncertain: true };
        } catch (error) {
          const code = errnoOf(error);
          if (code !== "ENOENT" && code !== "ENOTDIR") {
            logPathCanonicalizationFailure(candidate, error);
          }
          return { path: candidate, uncertain: true };
        }
      }

      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return { path: candidate, uncertain: true };
      }
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function mapReportedPathToSource(
  group: IsolatedGroup,
  physicalWorkerRoot: string,
  candidate: string,
): string {
  return isWithin(physicalWorkerRoot, candidate)
    ? path.join(group.sourceRoot, path.relative(physicalWorkerRoot, candidate))
    : candidate;
}

async function changedWorkerPaths(
  workerRoot: string,
  baselineCommit: string,
): Promise<Set<string> | undefined> {
  try {
    const [tracked, untracked] = await Promise.all([
      git(["diff", "--name-only", "-z", "--no-renames", baselineCommit, "--"], {
        cwd: workerRoot,
      }),
      git(["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: workerRoot,
      }),
    ]);
    return new Set(
      `${tracked.stdout}${untracked.stdout}`
        .split("\0")
        .filter(Boolean)
        .map((relative) => path.resolve(workerRoot, relative)),
    );
  } catch (error) {
    // Reporting is conservative when Git evidence cannot be reconstructed, but
    // the missing evidence must be visible and attributable to its worker.
    console.error(
      `[delegate] failed to collect isolated Git change evidence for worker '${workerRoot}'`,
      error,
    );
    return undefined;
  }
}

async function classifyReportedFiles(
  group: IsolatedGroup,
  worker: IsolatedWorker,
  result: TaskResult,
): Promise<void> {
  const physicalWorkerRoot = await fs.promises.realpath(worker.workerRoot);
  const gitChanged = await changedWorkerPaths(
    worker.workerRoot,
    group.baselineCommit,
  );
  const structured = (result.fileAttributions ?? []).map(
    revalidateFileAttribution,
  );
  const legacyCandidates = structured.length
    ? []
    : [
        ...new Set(
          (result.attributedFiles ?? []).map((candidate) =>
            path.resolve(worker.cwd, candidate),
          ),
        ),
      ];
  const attributionByLexical = new Map(
    structured.map((entry) => [path.resolve(entry.lexicalPath), entry]),
  );
  const legacySet = new Set(legacyCandidates);
  const distinctPhysicalSnapshots = new Set(
    structured
      .filter(
        (entry) =>
          entry.preExecutionPhysicalPath !== undefined &&
          path.resolve(entry.preExecutionPhysicalPath) !==
            path.resolve(entry.lexicalPath),
      )
      .map((entry) => path.resolve(entry.preExecutionPhysicalPath!)),
  );

  // Trusted physical snapshots are immutable evidence: never resolve them
  // against the final worker tree. The associated lexical path is used only to
  // decide whether a symlink node itself changed. Legacy string-only evidence
  // retains the older conservative final-view classification.
  const candidates = [
    ...result.touchedFiles.map((candidate) => ({
      kind: "touched" as const,
      candidate,
    })),
    ...structured.map((attribution) => ({
      kind: "structured" as const,
      attribution,
    })),
    ...legacyCandidates.map((candidate) => ({
      kind: "legacy" as const,
      candidate,
    })),
  ];
  const classified = await mapConcurrent(
    candidates,
    PATH_CLASSIFICATION_CONCURRENCY,
    async (entry) => {
      if (entry.kind === "touched") {
        const absolute = path.resolve(worker.cwd, entry.candidate);
        if (distinctPhysicalSnapshots.has(absolute)) {
          return {
            kind: "touched" as const,
            path: mapReportedPathToSource(group, physicalWorkerRoot, absolute),
          };
        }
        const associated =
          attributionByLexical.get(absolute) ??
          (legacySet.has(absolute) ? true : undefined);
        const finalStat = await fs.promises.lstat(absolute).catch(() => null);
        if (
          associated &&
          finalStat?.isSymbolicLink() &&
          gitChanged !== undefined &&
          !gitChanged.has(absolute)
        ) {
          return { kind: "touched" as const, path: undefined };
        }
        const resolved = await physicalReportedPath(absolute, false);
        return {
          kind: "touched" as const,
          path: mapReportedPathToSource(
            group,
            physicalWorkerRoot,
            resolved.path,
          ),
        };
      }

      if (entry.kind === "structured") {
        const evidence = entry.attribution;
        const physical = evidence.preExecutionPhysicalPath;
        const resolved = {
          path: physical
            ? path.resolve(physical)
            : path.resolve(evidence.lexicalPath),
          uncertain: evidence.uncertain || physical === undefined,
        };
        return {
          kind: "attributed" as const,
          value: {
            ...resolved,
            evidence,
            reportedPath: mapReportedPathToSource(
              group,
              physicalWorkerRoot,
              resolved.path,
            ),
          },
        };
      }

      const resolved = await physicalReportedPath(entry.candidate, true);
      return {
        kind: "attributed" as const,
        value: {
          ...resolved,
          evidence: undefined,
          reportedPath: mapReportedPathToSource(
            group,
            physicalWorkerRoot,
            resolved.path,
          ),
        },
      };
    },
  );
  const touched = classified
    .filter(
      (
        entry,
      ): entry is Extract<(typeof classified)[number], { kind: "touched" }> =>
        entry.kind === "touched",
    )
    .map((entry) => entry.path)
    .filter((candidate): candidate is string => candidate !== undefined);
  const attributed = classified
    .filter(
      (
        entry,
      ): entry is Extract<
        (typeof classified)[number],
        { kind: "attributed" }
      > => entry.kind === "attributed",
    )
    .map((entry) => entry.value);
  const escapedOrUncertain = attributed.filter(
    (candidate) =>
      candidate.uncertain || !isWithin(physicalWorkerRoot, candidate.path),
  );

  result.fileAttributions = escapedOrUncertain
    .filter(
      (
        candidate,
      ): candidate is typeof candidate & { evidence: FileAttribution } =>
        candidate.evidence !== undefined,
    )
    .map((candidate) => ({
      ...candidate.evidence,
      lexicalPath: mapReportedPathToSource(
        group,
        physicalWorkerRoot,
        path.resolve(candidate.evidence.lexicalPath),
      ),
      preExecutionPhysicalPath:
        candidate.evidence.preExecutionPhysicalPath === undefined
          ? undefined
          : candidate.reportedPath,
      uncertain: candidate.uncertain,
    }));
  result.attributedFiles = [
    ...new Set(escapedOrUncertain.map((candidate) => candidate.reportedPath)),
  ];
  result.touchedFiles = [
    ...new Set([
      ...touched,
      ...escapedOrUncertain.map((candidate) => candidate.reportedPath),
    ]),
  ];
}

async function repositoryRoot(cwd: string): Promise<string> {
  const physicalCwd = await fs.promises.realpath(cwd);
  let root: string;
  try {
    root = (
      await git(["rev-parse", "--show-toplevel"], { cwd: physicalCwd })
    ).stdout.trim();
  } catch (error) {
    throw new Error(
      `workspace "isolated" requires a Git repository: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const physicalRoot = await fs.promises.realpath(root);
  if (!isWithin(physicalRoot, physicalCwd)) {
    throw new Error("Could not map the isolated task cwd into its Git root.");
  }
  await git(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: physicalRoot });
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

async function snapshotTree(
  root: string,
  baseCommit: string,
  indexPath: string,
  signal?: AbortSignal,
): Promise<string> {
  await fs.promises.rm(indexPath, { force: true });
  const env = {
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: root,
  };
  await git(["read-tree", baseCommit], { cwd: root, env, signal });
  await git(["add", "-A", "--", "."], { cwd: root, env, signal });
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

async function removeWorktree(
  root: string,
  destination: string,
): Promise<boolean> {
  const override = await removeWorktreeHookForTesting?.(destination);
  if (override !== undefined) return override;
  try {
    await git(["worktree", "remove", "--force", destination], { cwd: root });
    if (!pathEntryExists(destination)) return true;
    console.error(
      `[delegate] Git reported isolated worktree removal success but the recovery path remains at ${JSON.stringify(destination)}`,
    );
    return false;
  } catch (error) {
    // The command can report failure after completing removal. Only treat that
    // as success when the recovery path itself is definitely gone.
    if (!pathEntryExists(destination)) return true;
    // An unregistered directory is still recovery evidence. Do not silently
    // call it removed or recursively delete it after Git declined the cleanup.
    console.error(
      `[delegate] failed to remove isolated worktree '${destination}'`,
      error,
    );
    return false;
  }
}

async function requireWorktreeRemoved(
  root: string,
  destination: string,
): Promise<void> {
  if (await removeWorktree(root, destination)) return;
  throw new Error(
    `Could not remove isolated worktree; recovery workspace retained at ${JSON.stringify(destination)}.`,
  );
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

async function writePatch(
  root: string,
  from: string,
  to: string,
  destination: string,
): Promise<void> {
  const output = await git(
    ["diff", "--binary", "--full-index", "--no-renames", from, to],
    { cwd: root },
  );
  await fs.promises.writeFile(destination, output.stdout, { mode: 0o600 });
}

async function processesIn(root: string): Promise<number[]> {
  if (process.platform !== "linux" || !fs.existsSync("/proc")) return [];
  const pids: number[] = [];
  for (const entry of await fs.promises.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cwd = await fs.promises.realpath(path.join("/proc", entry, "cwd"));
      if (isWithin(root, cwd)) pids.push(pid);
    } catch {
      // Processes can exit or become unreadable while /proc is scanned.
    }
  }
  return pids;
}

function signalProcesses(
  pids: readonly number[],
  signal: NodeJS.Signals,
): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ESRCH"
      )) {
        console.error(
          `[delegate] failed to signal isolated process ${pid}`,
          error,
        );
      }
    }
  }
}

async function stopWorkspaceProcesses(root: string): Promise<void> {
  let pids = await processesIn(root);
  if (!pids.length) return;
  console.error(
    `[delegate] terminating ${pids.length} process(es) left in isolated workspace '${root}'`,
  );
  signalProcesses(pids, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, PROCESS_GRACE_MS));
  pids = await processesIn(root);
  signalProcesses(pids, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const survivors = await processesIn(root);
  if (survivors.length) {
    throw new Error(
      `Could not quiesce isolated workspace; process(es) ${survivors.join(", ")} remain.`,
    );
  }
}

interface IsolatedGroup {
  sourceRoot: string;
  sourceHead: string;
  artifactRoot: string;
  baselineCommit: string;
  baselineRef: string;
  taskIndexes: number[];
  /** Deferred quarantine cleanup must not run Git worktree operations while the
   * group is still reconciling candidates/source state. */
  reconciliationDone: Promise<void>;
  finishReconciliation: () => void;
  deferredCleanupTail: Promise<void>;
}

function enqueueDeferredGroupCleanup(
  group: IsolatedGroup,
  cleanup: () => Promise<void>,
): Promise<void> {
  const run = async () => {
    await group.reconciliationDone;
    await cleanup();
  };
  const queued = group.deferredCleanupTail.then(run, run);
  // Keep the serialization chain usable after a surfaced callback failure.
  group.deferredCleanupTail = queued.catch(() => {});
  return queued;
}

interface IsolatedWorker {
  group: IsolatedGroup;
  workerRoot: string;
  cwd: string;
  proposalRef: string;
  patchPath: string;
}

export interface PreparedIsolatedBatch {
  resolved: ResolvedTask[];
  reconcile(results: TaskResult[]): Promise<TaskResult[]>;
}

async function restoreAfterFailedApply(
  sourceRoot: string,
  baselineRoot: string,
  changed: readonly string[],
  recoveryRoot: string,
): Promise<void> {
  for (const relative of changed) {
    const source = path.join(sourceRoot, relative);
    const baseline = path.join(baselineRoot, relative);
    const recovery = path.join(recoveryRoot, relative);
    if (
      fs.existsSync(source) ||
      (await fs.promises.lstat(source).catch(() => null))
    ) {
      await fs.promises.mkdir(path.dirname(recovery), { recursive: true });
      await fs.promises.rename(source, recovery);
    }
    const baselineStat = await fs.promises.lstat(baseline).catch(() => null);
    if (baselineStat) {
      await fs.promises.mkdir(path.dirname(source), { recursive: true });
      await fs.promises.cp(baseline, source, {
        recursive: baselineStat.isDirectory(),
        dereference: false,
        preserveTimestamps: true,
      });
    }
  }
}

async function reconcileGroup(
  group: IsolatedGroup,
  workers: Map<number, IsolatedWorker>,
  results: TaskResult[],
): Promise<void> {
  let integratedCommit = group.baselineCommit;
  const accepted = new Map<number, string[]>();
  const pristineRoot = path.join(group.artifactRoot, "pristine");
  await addWorktree(group.sourceRoot, pristineRoot, group.baselineCommit);

  for (const taskIndex of group.taskIndexes) {
    const worker = workers.get(taskIndex)!;
    const result = results[taskIndex]!;
    result.workspace = "isolated";

    const quarantine = sessionQuarantineOf(result);
    if (quarantine) {
      result.error ??=
        "AgentSession quiescence was abandoned; the isolated proposal was not applied.";
      result.integration = {
        status: "discarded",
        proposedFiles: [],
        appliedFiles: [],
      };
      console.error(
        `[delegate] retaining abandoned isolated worker '${worker.workerRoot}' until its AgentSession is confirmed quiescent; proposal will not be snapshotted or applied`,
      );
      observeQuarantineSafety(
        quarantine,
        "deferred isolated worker cleanup",
        async () =>
          enqueueDeferredGroupCleanup(group, async () => {
            try {
              await stopWorkspaceProcesses(worker.workerRoot);
              const removed = await removeWorktree(
                group.sourceRoot,
                worker.workerRoot,
              );
              if (removed) {
                console.error(
                  `[delegate] safely cleaned deferred isolated worker '${worker.workerRoot}'`,
                );
              } else {
                result.integration = {
                  status: "apply_failed",
                  proposedFiles: [],
                  appliedFiles: [],
                  conflicts: [
                    {
                      path: "(workspace cleanup)",
                      reason:
                        "Deferred isolated worker removal failed; recovery workspace retained.",
                    },
                  ],
                  worktreePath: worker.workerRoot,
                };
                console.error(
                  `[delegate] deferred isolated worker cleanup could not remove '${worker.workerRoot}'; retaining it as recovery evidence`,
                );
              }
            } catch (error) {
              result.integration = {
                status: "apply_failed",
                proposedFiles: [],
                appliedFiles: [],
                conflicts: [
                  {
                    path: "(workspace cleanup)",
                    reason:
                      error instanceof Error ? error.message : String(error),
                  },
                ],
                worktreePath: worker.workerRoot,
              };
              console.error(
                `[delegate] deferred isolated worker cleanup failed for '${worker.workerRoot}'; retaining it`,
                error,
              );
            }
          }),
        (error) => {
          console.error(
            `[delegate] isolated AgentSession safety monitor failed; retaining worker '${worker.workerRoot}' indefinitely`,
            error,
          );
        },
      );
      continue;
    }

    let proposedFiles: string[] = [];
    try {
      // A child that outlived prompt quiescence can still race symlink
      // inspection. Stop it before reporting paths even when its task failed.
      await stopWorkspaceProcesses(worker.workerRoot);

      if (result.error) {
        let classificationIssues:
          Array<{ path: string; reason: string }> | undefined;
        try {
          await classifyReportedFiles(group, worker, result);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          classificationIssues = [{ path: "(attribution)", reason }];
          console.error(
            `[delegate] failed to classify paths for already-failed isolated worker '${worker.workerRoot}'; discarding and removing it without changing the task failure`,
            error,
          );
        }
        if (classificationIssues) {
          // The original lists may contain worker-relative paths that become
          // dangling as soon as the disposable worktree is removed. Never
          // publish those stale paths after classification failed.
          result.touchedFiles = [];
          result.attributedFiles = [];
          result.fileAttributions = [];
        }
        result.integration = {
          status: "discarded",
          proposedFiles: [],
          appliedFiles: [],
          ...(classificationIssues ? { classificationIssues } : {}),
        };
        await requireWorktreeRemoved(group.sourceRoot, worker.workerRoot);
        continue;
      }

      await classifyReportedFiles(group, worker, result);
      const proposalTree = await snapshotTree(
        worker.workerRoot,
        group.baselineCommit,
        path.join(group.artifactRoot, `proposal-${taskIndex}.index`),
      );
      const proposalCommit = await commitTree(
        group.sourceRoot,
        proposalTree,
        group.baselineCommit,
        `pi-delegate isolated proposal ${taskIndex + 1}`,
      );
      await git(["update-ref", worker.proposalRef, proposalCommit], {
        cwd: group.sourceRoot,
      });
      await writePatch(
        group.sourceRoot,
        group.baselineCommit,
        proposalCommit,
        worker.patchPath,
      );
      proposedFiles = await changedFiles(
        group.sourceRoot,
        group.baselineCommit,
        proposalCommit,
      );
      await requireWorktreeRemoved(group.sourceRoot, worker.workerRoot);

      if (!proposedFiles.length) {
        result.integration = {
          status: "no_changes",
          proposedFiles,
          appliedFiles: [],
        };
        continue;
      }

      const candidateRoot = path.join(
        group.artifactRoot,
        `candidate-${taskIndex}`,
      );
      await addWorktree(group.sourceRoot, candidateRoot, integratedCommit);
      try {
        await git(["apply", "--3way", "--index", worker.patchPath], {
          cwd: candidateRoot,
        });
        const tree = (
          await git(["write-tree"], { cwd: candidateRoot })
        ).stdout.trim();
        integratedCommit = await commitTree(
          group.sourceRoot,
          tree,
          integratedCommit,
          `pi-delegate integrate proposal ${taskIndex + 1}`,
        );
        accepted.set(taskIndex, proposedFiles);
        result.integration = {
          status: "applied_unverified",
          proposedFiles,
          appliedFiles: proposedFiles,
        };
        await requireWorktreeRemoved(group.sourceRoot, candidateRoot);
      } catch (error) {
        const reason =
          error instanceof GitCommandError
            ? error.stderr.trim() || error.message
            : error instanceof Error
              ? error.message
              : String(error);
        result.integration = {
          status: "conflict",
          proposedFiles,
          appliedFiles: [],
          conflicts: [{ path: "(proposal)", reason }],
          baselineRef: group.baselineRef,
          proposalRef: worker.proposalRef,
          patchPath: worker.patchPath,
          worktreePath: candidateRoot,
        };
      }
    } catch (error) {
      const proposalExists = await privateRefExists(
        group.sourceRoot,
        worker.proposalRef,
      );
      const patchExists = fs.existsSync(worker.patchPath);
      const worktreeExists = pathEntryExists(worker.workerRoot);
      result.integration = {
        status: "apply_failed",
        proposedFiles,
        appliedFiles: [],
        conflicts: [
          {
            path: "(workspace)",
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
        baselineRef: group.baselineRef,
        ...(proposalExists ? { proposalRef: worker.proposalRef } : {}),
        ...(patchExists ? { patchPath: worker.patchPath } : {}),
        ...(worktreeExists ? { worktreePath: worker.workerRoot } : {}),
      };
    }
  }

  if (integratedCommit === group.baselineCommit) {
    await requireWorktreeRemoved(group.sourceRoot, pristineRoot);
    return;
  }

  const currentTree = await snapshotTree(
    group.sourceRoot,
    group.sourceHead,
    path.join(group.artifactRoot, "revalidate.index"),
  );
  const baselineTree = (
    await git(["rev-parse", `${group.baselineCommit}^{tree}`], {
      cwd: group.sourceRoot,
    })
  ).stdout.trim();
  if (currentTree !== baselineTree) {
    for (const [taskIndex] of accepted) {
      const integration = results[taskIndex]!.integration!;
      const worker = workers.get(taskIndex)!;
      results[taskIndex]!.integration = {
        status: "apply_failed",
        proposedFiles: integration.proposedFiles,
        appliedFiles: [],
        conflicts: [
          {
            path: "(source tree)",
            reason:
              "The source tree changed during isolated execution; no proposal was applied.",
          },
        ],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
      };
    }
    await requireWorktreeRemoved(group.sourceRoot, pristineRoot);
    return;
  }

  const finalPatch = path.join(group.artifactRoot, "integrated.patch");
  await writePatch(
    group.sourceRoot,
    group.baselineCommit,
    integratedCommit,
    finalPatch,
  );
  const allChanged = await changedFiles(
    group.sourceRoot,
    group.baselineCommit,
    integratedCommit,
  );
  const applyIndex = path.join(group.artifactRoot, "apply.index");
  await fs.promises.rm(applyIndex, { force: true });
  const env = {
    GIT_INDEX_FILE: applyIndex,
    GIT_WORK_TREE: group.sourceRoot,
  };
  try {
    await git(["read-tree", group.baselineCommit], {
      cwd: group.sourceRoot,
      env,
    });
    await git(["update-index", "--refresh"], {
      cwd: group.sourceRoot,
      env,
    });
    await git(["apply", "--binary", "--index", finalPatch], {
      cwd: group.sourceRoot,
      env,
    });
  } catch (error) {
    const recoveryRoot = path.join(group.artifactRoot, "failed-apply-files");
    try {
      await restoreAfterFailedApply(
        group.sourceRoot,
        pristineRoot,
        allChanged,
        recoveryRoot,
      );
    } catch (rollbackError) {
      console.error(
        "[delegate] isolated apply rollback failed; recovery artifacts retained",
        rollbackError,
      );
    }
    for (const [taskIndex] of accepted) {
      const integration = results[taskIndex]!.integration!;
      const worker = workers.get(taskIndex)!;
      results[taskIndex]!.integration = {
        status: "apply_failed",
        proposedFiles: integration.proposedFiles,
        appliedFiles: [],
        conflicts: [
          {
            path: "(source tree)",
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
        baselineRef: group.baselineRef,
        proposalRef: worker.proposalRef,
        patchPath: worker.patchPath,
        worktreePath: pristineRoot,
      };
    }
    return;
  }

  await requireWorktreeRemoved(group.sourceRoot, pristineRoot);
}

async function deletePrivateRefs(
  sourceRoot: string,
  refs: readonly string[],
): Promise<void> {
  for (const ref of refs) {
    await git(["update-ref", "-d", ref], { cwd: sourceRoot });
  }
}

async function privateRefExists(
  sourceRoot: string,
  ref: string,
): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: sourceRoot,
    });
    return true;
  } catch {
    return false;
  }
}

async function markGroupReconciliationFailure(
  group: IsolatedGroup,
  workers: Map<number, IsolatedWorker>,
  results: TaskResult[],
  error: unknown,
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  const baselineExists = await privateRefExists(
    group.sourceRoot,
    group.baselineRef,
  );
  const pristineRoot = path.join(group.artifactRoot, "pristine");

  for (const taskIndex of group.taskIndexes) {
    const result = results[taskIndex]!;
    const current = result.integration;
    if (current?.status === "conflict") continue;

    const worker = workers.get(taskIndex)!;
    const proposalExists = await privateRefExists(
      group.sourceRoot,
      worker.proposalRef,
    );
    const patchExists = fs.existsSync(worker.patchPath);
    const recoveryWorktree = pathEntryExists(worker.workerRoot)
      ? worker.workerRoot
      : pathEntryExists(pristineRoot)
        ? pristineRoot
        : undefined;
    result.workspace = "isolated";
    result.integration = {
      status: "apply_failed",
      proposedFiles: current?.proposedFiles ?? [],
      appliedFiles: [],
      conflicts: [{ path: "(batch)", reason }],
      ...(baselineExists ? { baselineRef: group.baselineRef } : {}),
      ...(proposalExists ? { proposalRef: worker.proposalRef } : {}),
      ...(patchExists ? { patchPath: worker.patchPath } : {}),
      ...(recoveryWorktree ? { worktreePath: recoveryWorktree } : {}),
    };
  }
}

async function cleanupCompletedGroupRefs(
  group: IsolatedGroup,
  workers: Map<number, IsolatedWorker>,
  results: readonly TaskResult[],
): Promise<void> {
  const disposableProposalRefs: string[] = [];
  let retainsRecoveryArtifacts = false;

  for (const taskIndex of group.taskIndexes) {
    const status = results[taskIndex]?.integration?.status;
    if (status === "conflict" || status === "apply_failed") {
      retainsRecoveryArtifacts = true;
    } else if (
      status === "applied_unverified" ||
      status === "no_changes" ||
      status === "discarded"
    ) {
      disposableProposalRefs.push(workers.get(taskIndex)!.proposalRef);
    }
  }

  const refs = retainsRecoveryArtifacts
    ? disposableProposalRefs
    : [...disposableProposalRefs, group.baselineRef];
  try {
    await deletePrivateRefs(group.sourceRoot, refs);
  } catch (error) {
    // Integration already completed. Ref cleanup must be visible, but must not
    // turn a successfully applied source change into a reported failure.
    console.error("[delegate] failed to clean completed isolated refs", error);
  }
}

/** Prepare detached worktrees from one synthetic commit per Git root. The
 * user's index and branch are never touched. */
export async function prepareIsolatedBatch(
  resolved: ResolvedTask[],
  signal?: AbortSignal,
): Promise<PreparedIsolatedBatch | undefined> {
  const isolatedIndexes = resolved
    .map((task, index) => (task.workspace === "isolated" ? index : -1))
    .filter((index) => index >= 0);
  if (!isolatedIndexes.length) return undefined;

  const batchId = crypto.randomUUID();
  const batchArtifactRoot = path.join(
    artifactBaseOverrideForTesting ??
      path.join(os.homedir(), ".pi", "agent", "delegate-isolated"),
    batchId,
  );
  const groupsByRoot = new Map<string, IsolatedGroup>();
  const workers = new Map<number, IsolatedWorker>();
  const translated = [...resolved];

  try {
    for (const taskIndex of isolatedIndexes) {
      const task = resolved[taskIndex]!;
      const sourceRoot = await repositoryRoot(task.cwd);
      let group = groupsByRoot.get(sourceRoot);
      if (!group) {
        const sourceHead = (
          await git(["rev-parse", "HEAD"], { cwd: sourceRoot, signal })
        ).stdout.trim();
        const artifactRoot = path.join(
          batchArtifactRoot,
          crypto
            .createHash("sha256")
            .update(sourceRoot)
            .digest("hex")
            .slice(0, 12),
        );
        await fs.promises.mkdir(artifactRoot, {
          recursive: true,
          mode: 0o700,
        });
        const baselineTree = await snapshotTree(
          sourceRoot,
          sourceHead,
          path.join(artifactRoot, "baseline.index"),
          signal,
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
        let finishReconciliation!: () => void;
        const reconciliationDone = new Promise<void>((resolve) => {
          finishReconciliation = resolve;
        });
        group = {
          sourceRoot,
          sourceHead,
          artifactRoot,
          baselineCommit,
          baselineRef,
          taskIndexes: [],
          reconciliationDone,
          finishReconciliation,
          deferredCleanupTail: Promise.resolve(),
        };
        groupsByRoot.set(sourceRoot, group);
      }

      const sourceCwd = await fs.promises.realpath(task.cwd);
      const workerRoot = path.join(group.artifactRoot, `worker-${taskIndex}`);
      const cwd = path.join(workerRoot, path.relative(sourceRoot, sourceCwd));
      const proposalRef = privateRef(batchId, `${taskIndex}/proposal`);
      const patchPath = path.join(
        group.artifactRoot,
        `proposal-${taskIndex}.patch`,
      );
      workers.set(taskIndex, {
        group,
        workerRoot,
        cwd,
        proposalRef,
        patchPath,
      });
      await addWorktree(sourceRoot, workerRoot, group.baselineCommit, signal);
      group.taskIndexes.push(taskIndex);
      translated[taskIndex] = { ...task, cwd };
    }
  } catch (error) {
    let worktreeCleanupFailed = false;
    for (const worker of workers.values()) {
      const removed = await removeWorktree(
        worker.group.sourceRoot,
        worker.workerRoot,
      );
      if (!removed) {
        worktreeCleanupFailed = true;
      }
    }
    await Promise.all(
      [...groupsByRoot.values()].map(async (group) => {
        try {
          await deletePrivateRefs(group.sourceRoot, [group.baselineRef]);
        } catch (cleanupError) {
          console.error(
            "[delegate] failed to clean isolated baseline ref after preparation error",
            cleanupError,
          );
        }
      }),
    );
    if (!worktreeCleanupFailed) {
      try {
        await fs.promises.rm(batchArtifactRoot, {
          recursive: true,
          force: true,
        });
      } catch (cleanupError) {
        console.error(
          "[delegate] failed to remove isolated artifacts after preparation error",
          cleanupError,
        );
      }
    }
    throw error;
  }

  return {
    resolved: translated,
    async reconcile(results: TaskResult[]): Promise<TaskResult[]> {
      for (const group of groupsByRoot.values()) {
        try {
          try {
            await reconcileGroup(group, workers, results);
          } catch (error) {
            console.error(
              "[delegate] isolated group reconciliation failed",
              error,
            );
            await markGroupReconciliationFailure(
              group,
              workers,
              results,
              error,
            );
          }
          await cleanupCompletedGroupRefs(group, workers, results);
        } finally {
          // Unblocks and serializes any safety-confirmed quarantine cleanups
          // only after all candidate/source/ref work for this group is done.
          group.finishReconciliation();
        }
      }
      return results;
    },
  };
}

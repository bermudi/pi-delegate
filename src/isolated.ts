import { DiagnosticSink, isDiagnosticPath } from "./diagnostics.ts";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalPath,
  DELEGATE_TREES,
  diagnosticExclusions,
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

function log(diagnostics: DiagnosticSink, context: string, error: unknown): void {
  diagnostics.log("error", "isolated workspace cleanup/evidence", { operation: context }, error);
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
 *
 * `base` seeds the temporary index; `undefined` starts from an empty index
 * (`read-tree --empty`) for repositories with no commits. Shared with the
 * scratch drift check (#62), which has no baseline commit to grow from:
 * its end snapshot passes the start tree as `base`, so both snapshots see
 * the same content set regardless of how the first was seeded.
 */
export async function snapshotTree(
  diagnostics: DiagnosticSink,
  root: string,
  base: string | undefined,
  indexPath: string,
  signal?: AbortSignal,
  excludePaths: readonly string[] = [],
): Promise<string> {
  await fs.promises.rm(indexPath, { force: true });
  const env = {
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: root,
  };
  await git(
    ["read-tree", ...(base === undefined ? ["--empty"] : [base])],
    { cwd: root, env, signal },
  );
  // Remove seeded runtime entries as well as preventing new blobs: an
  // excluded git-add path alone would leave tracked logs in read-tree's index.
  const runtimeExcludes = await diagnosticExclusions(diagnostics, root);
  const indexed = (await git(["ls-files", "-z"], { cwd: root, env, signal })).stdout
    .split("\0").filter((name) => name !== "" && isDiagnosticPath(path.join(root, name)));
  if (indexed.length > 0) await git(["update-index", "--force-remove", "-z", "--stdin"], {
    cwd: root, env, signal, input: indexed.join("\0") + "\0",
  });
  // Never broadly stage the tree: a different process can create a runtime
  // directory after exclusion discovery. Enumerate visible FILE names first,
  // preserving tracked deletions and Git's ignore/clean-filter semantics, then
  // give add only literal NUL-separated names (no recursive directory pathspec).
  const visible = (await git([
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".",
    ...excludePaths.map((exclude) => `:(exclude)${exclude}`),
    ...runtimeExcludes.map((exclude) => `:(exclude,literal)${exclude}`),
  ], { cwd: root, env, signal })).stdout.split("\0");
  const files = new Set<string>();
  const replacedDirectories: string[] = [];
  for (const name of visible) {
    if (name === "" || isDiagnosticPath(path.join(root, name))) continue;
    const stat = await fs.promises.lstat(path.join(root, name)).catch((error: unknown) => {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    });
    if (stat?.isDirectory()) replacedDirectories.push(name);
    else files.add(name);
  }
  // A tracked file replaced by a directory must be removed explicitly; staging
  // its old name would recurse into newly appearing, unlisted runtime files.
  if (replacedDirectories.length > 0) await git(["update-index", "--force-remove", "-z", "--stdin"], {
    cwd: root, env, signal, input: replacedDirectories.join("\0") + "\0",
  });
  if (files.size > 0) await git(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    cwd: root, env: { ...env, GIT_LITERAL_PATHSPECS: "1" }, signal,
    input: [...files].join("\0") + "\0",
  });
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

/**
 * The source root's Git-ignored entries, repository-relative and collapsed
 * (an ignored directory lists once, trailing slash included — plain
 * `--ignored`, never `=matching`). Delegate-owned diagnostic paths are
 * skipped: they are runtime records, not source dependencies. Porcelain v1
 * `-z` records are `XY <path>`; only `!! ` records are ignored state.
 * `excludes` are absolute delegate-owned roots (artifact base, batch root,
 * agent-dir delegate trees): an agent dir living inside the source repo
 * under a gitignore would otherwise be provisioned into the very workers
 * it sits beside — and the artifact base holds the destination worktree
 * itself, which fs.cp refuses outright (ERR_FS_CP_EINVAL, #120 review).
 * An entry is skipped when it overlaps an excluded root in either
 * direction: a descendant is a slice of runtime state, and an ancestor
 * (the collapsed `.agent-dir/` a gitignore lists) would copy the whole
 * artifact tree inside it.
 */
async function ignoredEntries(
  root: string,
  signal: AbortSignal | undefined,
  excludes: readonly string[],
): Promise<string[]> {
  const output = await git(
    ["status", "--porcelain", "-z", "--ignored"],
    { cwd: root, signal },
  );
  const overlaps = (a: string, b: string): boolean =>
    isWithin(a, b) || isWithin(b, a);
  return output.stdout
    .split("\0")
    .filter((record) => record.startsWith("!! "))
    .map((record) => record.slice(3))
    .filter((entry) => {
      if (isDiagnosticPath(path.join(root, entry))) return false;
      // Both spellings (the diagnosticExclusions discipline): an entry
      // path may traverse a symlinked alias of an excluded root.
      const resolved = path.resolve(root, entry);
      return !excludes.some(
        (exclude) =>
          overlaps(exclude, resolved) ||
          overlaps(exclude, canonicalPath(resolved)),
      );
    });
}

/**
 * Materialize ignored entries (e.g. `node_modules/`) into a fresh worker
 * worktree (#120): a worktree holds only tracked state, so suite-running
 * tasks had a broken environment. Port-of-idea from xai-org/grok-build's
 * `xai-fast-worktree` copy arm, second pass (execute.rs:832-871,
 * copy/skip.rs:19-40) — pass 1 is `git worktree add` at the baseline commit,
 * this fills the ignored remainder. Copy discipline mirrors `src/scratch.ts`
 * `copyTree`: reflink/Copy-on-Write where the filesystem supports it
 * (silent plain-copy fallback — v1's probe/fail-loud reflink requirement is
 * deliberately not adopted, provisioning must not brick ext4/tmpfs
 * machines), timestamps preserved, symlinks verbatim. Source entries are
 * read-only inputs and are never written back. An entry that vanished
 * between listing and copying is skipped — a racy source is not worth
 * failing a batch — while any other failure throws, failing the group prep
 * loud (the caller's undo path cleans up).
 */
async function provisionIgnoredEntries(
  sourceRoot: string,
  workerRoot: string,
  entries: readonly string[],
): Promise<void> {
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry);
    const destination = path.join(workerRoot, entry);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.promises.cp(source, destination, {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        `isolated worktree provisioning could not copy ignored entry '${entry}' from '${source}' into '${destination}': ${error instanceof Error ? error.message : String(error)}. The source tree's ignored files are read-only inputs; fix the underlying error (e.g. disk space or permissions) and retry the dispatch.`,
      );
    }
  }
}

/** True only when the worktree path is verifiably gone. */
async function removeWorktree(
  diagnostics: DiagnosticSink,
  root: string,
  destination: string,
): Promise<boolean> {
  try {
    await git(["worktree", "remove", "--force", destination], { cwd: root });
    if (!pathEntryExists(destination)) return true;
    log(diagnostics,
      `Git reported isolated worktree removal success but the path remains at ${JSON.stringify(destination)}`,
      "",
    );
    return false;
  } catch (error) {
    if (!pathEntryExists(destination)) return true;
    log(diagnostics, `failed to remove isolated worktree '${destination}'`, error);
    return false;
  }
}

/**
 * Repository-relative paths that differ between two trees — raw
 * NUL-separated names (no C-quoting corruption) and a rename reports both
 * its deleted and created paths. Shared with the scratch drift check
 * (#62).
 */
export async function changedFiles(
  root: string,
  from: string,
  to: string,
): Promise<string[]> {
  const output = await git(
    ["diff", "--name-only", "-z", "--no-renames", from, to],
    { cwd: root },
  );
  return output.stdout.split("\0").filter((name) => name !== "" && !isDiagnosticPath(path.join(root, name)));
}

/**
 * Blob shas for each repository-relative path in `paths`, as of `commit`.
 * Only the proposal's files are looked up — never the whole tree — and
 * one pathspec per call keeps every command's argument list small
 * regardless of proposal size. Used to verify a proposal's expected
 * post-apply state before the source is touched: only paths whose
 * current content matches the recorded expectation may be overwritten.
 */
async function trackedBlobs(
  root: string,
  commit: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  for (const filePath of paths) {
    const entry = (
      await git(["ls-tree", commit, "--", filePath], { cwd: root })
    ).stdout.trim();
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
    if (match?.[2] === "blob") blobs.set(filePath, match[3]!);
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
    if (stat.isSymbolicLink()) {
      // Git stores the link text as a blob, not the contents of its target.
      const target = await fs.promises.readlink(path.join(root, relative), { encoding: "buffer" });
      // Repositories can use SHA-256 object IDs; hard-coded SHA-1 would
      // falsely treat an unchanged symlink as source drift.
      const format = (await git(["rev-parse", "--show-object-format"], { cwd: root })).stdout.trim();
      if (format !== "sha1" && format !== "sha256") {
        throw new Error(`Unsupported Git object format '${format}'`);
      }
      return createHash(format)
        .update(Buffer.concat([Buffer.from(`blob ${target.length}\0`), target]))
        .digest("hex");
    }
    return (await git(["hash-object", "--", relative], { cwd: root })).stdout.trim();
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
  readonly diagnostics: DiagnosticSink;
  readonly sourceRoot: string;
  readonly artifactRoot: string;
  readonly baselineCommit: string;
  readonly baselineRef: string;
  /**
   * The same repository-relative exclude pathspecs the baseline snapshot
   * used (artifact roots, agent-dir delegate trees, excludedPaths). The
   * reconcile-time drift check re-snapshots with them so artifact
   * directories and delegate-owned churn can never masquerade as source
   * drift (#62).
   */
  readonly snapshotExcludes: readonly string[];
  /**
   * The same delegate-owned roots in absolute form, both symlink
   * spellings: provisioning's on-disk match for paths that must never be
   * materialized into a worker (#120). The baseline keeps them out via
   * pathspec; provisioning keeps them out via overlap, because the
   * artifact base can sit inside a gitignored source tree — and a
   * collapsed ignored ancestor of it would copy it whole.
   */
  readonly provisionExcludes: readonly string[];
  readonly taskIndexes: number[];
  /**
   * Provisioning observability fires once per group prep, not once per
   * worker (#120): the count line must not scale with fan-out.
   */
  provisionLogged: boolean;
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
   * writing; rollback instead uses the actual pre-apply working-tree state.
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

type SourceEntry =
  | { readonly kind: "absent" }
  | { readonly kind: "dir"; readonly mode: number }
  | { readonly kind: "file" | "link"; readonly content: Buffer; readonly mode: number };

async function sourceEntry(root: string, relative: string): Promise<SourceEntry> {
  const name = path.join(root, relative);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(name);
  } catch (error) {
    // ENOTDIR is absence too when a proposal replaces a tracked file with
    // a directory: before applying, a/new cannot be inspected under file a.
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return { kind: "absent" };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { kind: "link", content: await fs.promises.readlink(name, { encoding: "buffer" }), mode: stat.mode & 0o777 };
  }
  if (stat.isDirectory()) return { kind: "dir", mode: stat.mode & 0o777 };
  if (stat.isFile()) {
    return { kind: "file", content: await fs.promises.readFile(name), mode: stat.mode & 0o777 };
  }
  throw new Error(`Cannot safely snapshot isolated source path '${relative}'`);
}

function sameEntry(a: SourceEntry, b: SourceEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "absent" || b.kind === "absent") return true;
  if (a.mode !== b.mode) return false;
  if (a.kind === "dir" || b.kind === "dir") return true;
  return a.content.equals(b.content);
}

/**
 * `sameEntry` under Git's tracked semantics instead of exact filesystem
 * modes: directories carry no recorded mode, links only their text, and
 * files their content plus the user-execute bit (a working-tree 0o664
 * records the same entry as a normalized 0o644). Compares a live source
 * path against a `commitEntry`, whose mode is already normalized.
 */
function sameTrackedEntry(a: SourceEntry, b: SourceEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "absent" || b.kind === "absent") return true;
  if (a.kind === "dir" || b.kind === "dir") return true;
  if (!a.content.equals(b.content)) return false;
  return a.kind === "link" || (a.mode & 0o100) === (b.mode & 0o100);
}

async function commitEntry(root: string, commit: string, relative: string): Promise<SourceEntry> {
  const entry = (await git(["ls-tree", commit, "--", relative], { cwd: root })).stdout.trim();
  if (/^040000 tree [0-9a-f]+\t/.test(entry)) return { kind: "dir", mode: 0o755 };
  const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t/.exec(entry);
  if (!match) return { kind: "absent" };
  const content = (await git(["cat-file", "blob", match[2]!], { cwd: root, buffer: true })).stdoutBuffer;
  return match[1] === "120000"
    ? { kind: "link", content, mode: 0o777 }
    : { kind: "file", content, mode: match[1] === "100755" ? 0o755 : 0o644 };
}

/** A no-op chain edge or reverse-applicable patch proves only its delta;
 * verify every effect in the original proposal before calling it applied. */
async function missingProposalEffects(
  group: IsolatedGroup,
  proposal: AcceptedProposal,
): Promise<string[]> {
  const missing: string[] = [];
  for (const relative of proposal.files) {
    const current = await sourceEntry(group.sourceRoot, relative);
    const expected = await commitEntry(group.sourceRoot, proposal.commit, relative);
    if (!sameTrackedEntry(current, expected)) missing.push(relative);
  }
  return missing;
}

/** Restore only files still holding the captured pre-state or the complete
 * proposed post-state. An intervening edit is left in the source, not moved
 * into recovery; the recovery copy remains available for diagnosis. */
async function restorePreApplyState(
  group: IsolatedGroup,
  proposal: AcceptedProposal,
  paths: readonly string[],
  before: ReadonlyMap<string, SourceEntry>,
  recoveryDir: string,
): Promise<string[]> {
  const skipped: string[] = [];
  let firstError: unknown;
  // For directory→file, restore the parent first so old children become
  // reachable. For file→directory, remove proposed children first so the
  // created directory can be safely removed without touching extra files.
  for (const relative of [...paths].sort((a, b) => {
    const aWasDir = before.get(a)?.kind === "dir";
    const bWasDir = before.get(b)?.kind === "dir";
    if (aWasDir !== bWasDir) return aWasDir ? -1 : 1;
    return b.split("/").length - a.split("/").length;
  })) {
    try {
      const original = before.get(relative)!;
      const current = await sourceEntry(group.sourceRoot, relative);
      const proposed = await commitEntry(group.sourceRoot, proposal.commit, relative);
      const source = path.join(group.sourceRoot, relative);
      // Keep the failed apply's actual output, including links, for inspection.
      if (current.kind !== "absent" && current.kind !== "dir") {
        const recovered = path.join(recoveryDir, relative);
        await fs.promises.mkdir(path.dirname(recovered), { recursive: true });
        await fs.promises.cp(source, recovered, { dereference: false });
      }
      // A patch can replace bytes while leaving the working-tree mode as it
      // was before application (e.g. a user chmod not recorded in Git).
      const wroteProposedBytes = current.kind === proposed.kind &&
        (current.kind === "file" || current.kind === "link") &&
        (proposed.kind === "file" || proposed.kind === "link") &&
        current.content.equals(proposed.content) &&
        (sameTrackedEntry(current, proposed) ||
          (original.kind !== "absent" && current.mode === original.mode));
      // A partial git apply may already have removed a file that this
      // proposal deletes. Restore its captured pre-apply contents too:
      // absence is the complete proposed post-state for a deletion.
      const wroteProposedDeletion =
        current.kind === "absent" &&
        proposed.kind === "absent" &&
        original.kind !== "absent";
      const replacedDirectory =
        original.kind === "dir" &&
        (current.kind === "absent" || wroteProposedBytes);
      const createdDirectory =
        original.kind !== "dir" && original.kind !== "absent" &&
        current.kind === "dir" && proposed.kind === "dir" &&
        // A leftover human file must never be recursively removed to
        // restore the original file. Only remove an empty proposal dir.
        (await fs.promises.readdir(source)).length === 0;
      if (!sameEntry(current, original) && !wroteProposedBytes &&
          !wroteProposedDeletion && !replacedDirectory && !createdDirectory) {
        skipped.push(relative);
        continue;
      }
      if (sameEntry(current, original)) continue;
      if (createdDirectory) await fs.promises.rmdir(source);
      else await fs.promises.rm(source, { force: true });
      if (original.kind !== "absent") {
        await fs.promises.mkdir(path.dirname(source), { recursive: true });
        if (original.kind === "dir") {
          await fs.promises.mkdir(source, { mode: original.mode });
          await fs.promises.chmod(source, original.mode);
        } else if (original.kind === "link") {
          await fs.promises.symlink(original.content.toString("utf8"), source);
        } else {
          await fs.promises.writeFile(source, original.content, { mode: original.mode });
          await fs.promises.chmod(source, original.mode);
        }
      }
    } catch (error) {
      firstError ??= error;
      skipped.push(relative);
    }
  }
  if (firstError !== undefined) log(group.diagnostics, "isolated rollback could not restore every path", firstError);
  return skipped;
}

/**
 * Source drift evidence (#62): shell commands are not confined to the
 * worker copy, so an isolated worker's bash can write the original tree
 * without leaving a proposal. Re-snapshot the source with the same
 * excludes the baseline used and diff it against the baseline commit —
 * the paths that moved while the group ran, source-relative and sorted,
 * bounded so a repo-scale spill stays one bounded field. A failure here
 * is logged and skipped: drift reporting must never fail reconciliation.
 */
export const SOURCE_DRIFT_LIMIT = 20;

async function detectSourceDrift(
  group: IsolatedGroup,
): Promise<readonly string[] | undefined> {
  try {
    // Deliberately NOT on the dispatch abort signal: a cancelled batch
    // still owes the drift report — the surviving shell edits are exactly
    // what the caller needs to see. The check is read-only and bounded
    // by the git exec timeout.
    const currentTree = await snapshotTree(
      group.diagnostics,
      group.sourceRoot,
      group.baselineCommit,
      path.join(group.artifactRoot, "drift.index"),
      undefined,
      group.snapshotExcludes,
    );
    // -z + --no-renames (same as proposal diffs): raw NUL-separated
    // names — no C-quoting corruption — and a rename reports both its
    // deleted and created paths.
    const drift = await changedFiles(
      group.sourceRoot,
      group.baselineCommit,
      currentTree,
    );
    return drift.sort().slice(0, SOURCE_DRIFT_LIMIT);
  } catch (error) {
    log(group.diagnostics, `isolated source-drift check failed for '${group.sourceRoot}'`, error);
    return undefined;
  }
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
      await stopWorkspaceProcesses(group.diagnostics, worker.workerRoot);
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
      const removed = await removeWorktree(group.diagnostics, group.sourceRoot, worker.workerRoot);
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
        group.diagnostics,
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
        const removed = await removeWorktree(group.diagnostics,
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
      const workerRemoved = await removeWorktree(group.diagnostics,
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
      await removeWorktree(group.diagnostics, group.sourceRoot, candidateRoot);
      accepted.push({
        taskIndex,
        parent: integratedCommit,
        commit: chainCommit,
        files: proposedFiles,
        // Retain the expected blobs even after the worker is removed, for
        // verify-before-write during source application.
        expectedBlobs: await trackedBlobs(
          group.sourceRoot,
          chainCommit,
          proposedFiles,
        ),
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
  // Every read-only verification call below can throw. A failure must not
  // escape the loop and leave later proposals without an integration
  // status: record apply_failed honestly, or retained when the failure is
  // really cancellation.
  const recordApplyFailure = (
    proposal: AcceptedProposal,
    worker: IsolatedWorker,
    outcome: TaskOutcome,
    error: unknown,
  ): void => {
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
      return;
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
      ],
      baselineRef: group.baselineRef,
      proposalRef: worker.proposalRef,
      patchPath: worker.patchPath,
      ...(proposal.workerRemoved ? {} : { worktreePath: worker.workerRoot }),
    });
  };

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
      // A chain edge may be empty because an earlier proposal was identical.
      // That earlier proposal can still have conflicted with source drift.
      let missing: string[];
      try {
        missing = await missingProposalEffects(group, proposal);
      } catch (error) {
        recordApplyFailure(proposal, worker, outcome, error);
        continue;
      }
      if (missing.length) {
        results[proposal.taskIndex] = withIntegration(outcome, {
          status: "conflict", proposedFiles: proposal.files, appliedFiles: [],
          conflicts: missing.map((relative) => ({ path: relative, reason: "The proposal's effects are not present in the source tree; retained instead of claiming an apply." })),
          baselineRef: group.baselineRef, proposalRef: worker.proposalRef, patchPath: worker.patchPath,
        });
        continue;
      }
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
      // The reverse check only diagnoses a forward failure: when the
      // delta already landed, only part of the proposal may be present
      // (a partial duplicate). The later full-proposal checks after a
      // successful forward check and after a successful reverse check
      // below establish that without depending on this probe, so no
      // check is needed here before running it.
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
        let missing: string[];
        try {
          missing = await missingProposalEffects(group, proposal);
        } catch (error) {
          recordApplyFailure(proposal, worker, outcome, error);
          continue;
        }
        if (missing.length) {
          results[proposal.taskIndex] = withIntegration(outcome, {
            status: "conflict", proposedFiles: proposal.files, appliedFiles: [],
            conflicts: missing.map((relative) => ({ path: relative, reason: "Only part of the proposal is present in the source tree; retained instead of claiming an apply." })),
            baselineRef: group.baselineRef, proposalRef: worker.proposalRef, patchPath: worker.patchPath,
          });
          continue;
        }
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

    // A forward check that SUCCEEDS still proves only the delta: a
    // partial duplicate's edge can apply cleanly while a sibling file
    // the merge dropped (identical to an earlier, since-conflicted
    // proposal) never landed. Files outside this edge must therefore
    // already match the proposal — a fresh proposal touches everything,
    // so this is vacuous for it and only fires on partial duplicates.
    let missingAfterForward: string[];
    try {
      missingAfterForward = await missingProposalEffects(group, proposal);
    } catch (error) {
      recordApplyFailure(proposal, worker, outcome, error);
      continue;
    }
    const missingOutsideEdge = missingAfterForward.filter(
      (relative) => !deltaPaths.includes(relative),
    );
    if (missingOutsideEdge.length) {
      results[proposal.taskIndex] = withIntegration(outcome, {
        status: "conflict", proposedFiles: proposal.files, appliedFiles: [],
        conflicts: missingOutsideEdge.map((relative) => ({ path: relative, reason: "Only part of the proposal is present in the source tree; retained instead of claiming an apply." })),
        baselineRef: group.baselineRef, proposalRef: worker.proposalRef, patchPath: worker.patchPath,
      });
      continue;
    }

    // Verify-before-write: every path this delta touches must still hold
    // its expected pre-apply content (the chain-parent blob). A path the
    // user or another process changed after the check is left alone and
    // the proposal becomes a conflict — overwriting it would silently
    // erase unrelated working-tree edits, and restoring it from an older
    // snapshot would do the same.
    const before = new Map<string, SourceEntry>();
    try {
      const stalePaths: string[] = [];
      const createdPaths = new Set<string>();
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
        if (parentSha === undefined) createdPaths.add(relative);
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
        // Creating or deleting a path needs a writable containing
        // directory, not a writable file — unlink and create are directory
        // operations. A created path's leading directories may not exist
        // yet, or may currently be a file the same delta replaces with a
        // directory; the apply makes them, so the writable directory it
        // needs is the nearest existing ancestor directory. Other paths
        // must be writable themselves.
        const directoryTarget =
          createdPaths.has(relative) || !proposal.expectedBlobs.has(relative);
        let target = path.join(group.sourceRoot, relative);
        if (directoryTarget) {
          target = path.dirname(target);
          for (;;) {
            try {
              if (fs.statSync(target).isDirectory()) break;
            } catch {
              // Missing — keep walking upward.
            }
            const up = path.dirname(target);
            if (up === target) break;
            target = up;
          }
        }
        try {
          await fs.promises.access(
            target,
            directoryTarget
              ? fs.constants.W_OK | fs.constants.X_OK
              : fs.constants.W_OK,
          );
        } catch {
          unwritable.push(relative);
        }
      }
      if (unwritable.length > 0) {
        results[proposal.taskIndex] = withIntegration(outcome, {
          status: "conflict",
          proposedFiles: proposal.files,
          appliedFiles: [],
          conflicts: unwritable.map((relative) => ({
            path: relative,
            reason:
              "The file or its containing directory is not writable; the proposal was retained instead of applied.",
          })),
          baselineRef: group.baselineRef,
          proposalRef: worker.proposalRef,
          patchPath: worker.patchPath,
        });
        continue;
      }

      // Capture the actual working tree, not the synthetic chain parent: it
      // can contain user edits or modes that Git's patch leaves untouched.
      for (const relative of deltaPaths) before.set(relative, await sourceEntry(group.sourceRoot, relative));
    } catch (error) {
      recordApplyFailure(proposal, worker, outcome, error);
      continue;
    }
    try {
      await git(["apply", "--binary"], {
        cwd: group.sourceRoot,
        input: delta,
        signal: options.signal,
      });
    } catch (error) {
      // Preserve failed-apply output in recovery artifacts. Restore captured
      // pre-apply bytes and modes only where the source still holds those
      // bytes or the complete proposed bytes; leave intervening edits alone.
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
          before,
          recoveryDir,
        );
        rollbackSucceeded = unrestored.length === 0;
        if (!rollbackSucceeded) {
          log(group.diagnostics,
            `isolated apply rollback left ${unrestored.join(", ")} unrestored for task ${proposal.taskIndex}; unrelated edits preserved, recovery artifacts retained`,
            "",
          );
        }
      } catch (rollbackError) {
        rollbackSucceeded = false;
        log(group.diagnostics,
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
      log(group.diagnostics, `failed to clean isolated ref ${ref}`, error);
    }
  }
  if (retainsArtifacts) return;
  try {
    await fs.promises.rm(group.artifactRoot, { recursive: true, force: true });
  } catch (error) {
    log(group.diagnostics, `failed to remove isolated artifacts '${group.artifactRoot}'`, error);
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
  diagnostics: DiagnosticSink,
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
      if (!(await removeWorktree(diagnostics, worker.group.sourceRoot, worker.workerRoot))) {
        worktreeCleanupFailed = true;
      }
    }
    for (const group of groupsByRoot.values()) {
      try {
        await git(["update-ref", "-d", group.baselineRef], {
          cwd: group.sourceRoot,
        });
      } catch (cleanupError) {
        log(diagnostics, "failed to clean isolated baseline ref after preparation error", cleanupError);
      }
      group.finishReconcile();
    }
    if (!worktreeCleanupFailed) {
      await fs.promises
        .rm(batchRoot, { recursive: true, force: true })
        .catch((cleanupError: unknown) =>
          log(diagnostics, "failed to remove isolated artifacts after preparation error", cleanupError),
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
        // into a proposal. Every delegate-owned tree under the agent
        // directory is excluded by name via DELEGATE_TREES so a future
        // tree cannot reintroduce the leak — and the ticket journal's
        // per-outcome rewrites, which land mid-run, cannot masquerade as
        // source drift (#62). The batch root is excluded separately for
        // the pathological case where the artifact base IS the source
        // root.
        const delegateDir = path.dirname(artifactBase);
        const excluded: string[] = [];
        const provisionExcludes: string[] = [];
        for (const base of [
          artifactBase,
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
          // Provisioning matches on-disk ignored entries, which Git spells
          // through any symlinked alias: keep the delegate-owned roots in
          // absolute form, both spellings, so the #120 filter cannot miss
          // one. Roots outside the source tree never appear in
          // `git status --ignored` output and are dropped here.
          for (const candidate of new Set([path.resolve(base), resolved])) {
            const candidateRelative = path.relative(sourceRoot, candidate);
            if (candidateRelative !== "" && isWithin(sourceRoot, candidate)) {
              provisionExcludes.push(candidate);
            }
          }
        }
        const baselineTree = await snapshotTree(
          diagnostics,
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
          diagnostics,
          snapshotExcludes: excluded,
          provisionExcludes,
          taskIndexes: [],
          provisionLogged: false,
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
      // #120: dependencies live in ignored state Git never materializes into
      // a worktree; without them suite-running tasks (bun test, tsc) see a
      // broken environment. Each worker gets its own copy — the CoW design,
      // never a shared symlink into the source — so worker-local installs
      // stay worker-local and writes can never reach the source through the
      // provisioned path. Observability stays bounded: one count-only line
      // per group prep, never the entry list.
      const provisionedEntries = await ignoredEntries(
        sourceRoot,
        signal,
        group.provisionExcludes,
      );
      await provisionIgnoredEntries(
        sourceRoot,
        workerRoot,
        provisionedEntries,
      );
      if (!group.provisionLogged) {
        group.provisionLogged = true;
        // Allowlisted metadata only (path/count) — count stays bounded by
        // construction, the entry list itself is never logged.
        diagnostics.log("info", "isolated worktree provisioning", {
          path: sourceRoot,
          count: provisionedEntries.length,
        });
      }
      group.taskIndexes.push(taskIndex);
      translated[taskIndex] = {
        ...task,
        cwd: workerCwd,
        // #62: prompts routinely name absolute source paths; the note
        // teaches the copy mapping, the inline workspace guard refuses
        // what the note does not catch.
        appendSystemPrompt: [
          ...task.appendSystemPrompt,
          `Workspace: you are working in an isolated Git worktree copy of ${group.sourceRoot} at ${workerRoot}. Your working directory is ${workerCwd}. Paths under ${group.sourceRoot} in your instructions mean the same files in your copy: use ${workerRoot}/<same relative path>. Do not modify anything under ${group.sourceRoot} directly — write and edit calls there are refused. Your changes merge back into the original automatically when you finish.`,
        ],
        workspaceGuard: {
          kind: "isolated",
          sourceRoot: group.sourceRoot,
          copyRoot: workerRoot,
        },
      };
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
        // Shell escapes (#62): the drift snapshot must observe the source
        // before applyToSource mutates it — afterwards worker bash writes
        // are indistinguishable from legitimate applies. It overlaps
        // proposal collection (worker trees and refs only, never the
        // source working tree) so annotation latency is unchanged; the
        // promise self-catches and can never reject.
        const driftPromise = detectSourceDrift(group);
        let drift: readonly string[] | undefined;
        try {
          const accepted = await collectProposals(
            group,
            workers,
            results,
            options,
          );
          drift = await driftPromise;
          await applyToSource(group, workers, results, accepted, options);
        } catch (error) {
          // A group failure still owes the drift report: a worker's shell
          // may have written the source whether or not its proposal
          // applied. The promise self-catches, so this never throws.
          drift = await driftPromise;
          log(diagnostics, "isolated group reconciliation failed", error);
          await markGroupFailure(group, workers, results, error);
        }
        // Drift is only attributable to a worker that ran a shell: a task
        // without bash cannot have written the source. `shellObserved`,
        // not `uncertainFiles` — a Git-covered shell still escapes its
        // worktree unseen by that window (the drift IS the proof).
        // Source changes with no shell-capable worker are the caller's
        // own edits — already reported by the per-proposal conflict
        // machinery — and must not be pinned on an innocent outcome.
        if (drift !== undefined && drift.length > 0) {
          for (const taskIndex of group.taskIndexes) {
            const outcome = results[taskIndex];
            if (
              outcome?.shellObserved === true &&
              outcome.integration !== undefined
            ) {
              results[taskIndex] = withIntegration(outcome, {
                ...outcome.integration,
                sourceDrift: drift,
              });
            }
          }
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
      if (!worker) return;
      // Late worker truth may arrive before this group has even collected its
      // proposal. Reconciliation can still remove source Git metadata, and
      // retention is not decided yet. Do not authorize reservation release
      // merely because the worktree has not been marked retained.
      await worker.group.reconcileDone;
      if (!worker.retained) return;
      try {
        await stopWorkspaceProcesses(diagnostics, worker.workerRoot);
      } catch (error) {
        log(diagnostics, `deferred isolated worker cleanup could not stop processes in '${worker.workerRoot}'; retaining it`, error);
        return;
      }
      if (await removeWorktree(diagnostics, worker.group.sourceRoot, worker.workerRoot)) {
        worker.retained = false;
        await fs.promises
          .rmdir(worker.group.artifactRoot)
          .catch(() => undefined);
      }
    },
    dispose: undoPreparation,
  };
}

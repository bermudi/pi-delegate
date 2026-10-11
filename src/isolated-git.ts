import { DiagnosticSink, isDiagnosticPath } from "./diagnostics.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalPath,
  diagnosticExclusions,
  discoverGitRoot,
  exec,
  type ExecOptions,
  type ExecResult,
  gitEnv,
  isWithin,
} from "./fsx.ts";

// Snapshot traffic is real tree data; Git over big trees legitimately runs
// long and emits large output. Deliberately larger than the scratch/probe
// exec limits — the divergence is per use case, stated here at the call site.
const GIT_EXEC = { timeoutMs: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 } as const;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function git(
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

export function log(diagnostics: DiagnosticSink, context: string, error: unknown): void {
  diagnostics.log("error", "isolated workspace cleanup/evidence", { operation: context }, error);
}

export function pathEntryExists(candidate: string): boolean {
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
export async function repositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const { physicalCwd, top, error } = await discoverGitRoot(cwd, signal);
  if (top === undefined) {
    throw new Error(
      `workspace "isolated" requires a Git repository: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isWithin(top, physicalCwd)) {
    throw new Error(
      `Could not map the isolated task cwd '${physicalCwd}' into its Git root '${top}'.`,
    );
  }
  try {
    await git(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: top,
      signal,
    });
  } catch (verifyError) {
    if (signal?.aborted) throw verifyError;
    throw new Error(
      `workspace "isolated" requires a repository with at least one commit; '${top}' has none.`,
    );
  }
  if (fs.existsSync(path.join(top, ".gitmodules"))) {
    throw new Error(
      'workspace "isolated" does not yet support repositories with submodules.',
    );
  }
  return top;
}

export function privateRef(batchId: string, suffix: string): string {
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

export async function commitTree(
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

export async function addWorktree(
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
export async function ignoredEntries(
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
export async function provisionIgnoredEntries(
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
export async function removeWorktree(
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
export async function trackedBlobs(
  root: string,
  commit: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  for (const filePath of paths) {
    const entry = (
      // Proposal-derived names are data, not pathspec magic: a leading
      // `:` (e.g. a file literally named ':evil.txt') must still resolve
      // to itself or the lookup misclassifies it as absent.
      await git(
        ["--literal-pathspecs", "ls-tree", commit, "--", filePath],
        { cwd: root },
      )
    ).stdout.trim();
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
    if (match?.[2] === "blob") blobs.set(filePath, match[3]!);
  }
  return blobs;
}

/** Blob sha of one worktree file, or undefined when absent/unreadable. */
export async function worktreeBlob(
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

/**
 * Full binary patch bytes for `from → to`, suitable for `git apply` on
 * stdin. Must stay a Buffer end to end: Git classifies NUL-free content
 * as text even when it is not valid UTF-8 and emits a raw-byte text
 * patch — decoding that to a string would silently rewrite the bytes to
 * U+FFFD while the result still reports a clean apply.
 */
export async function diffPatch(
  root: string,
  from: string,
  to: string,
): Promise<Buffer> {
  return (
    await git(
      ["diff", "--binary", "--full-index", "--no-renames", from, to],
      { cwd: root, buffer: true },
    )
  ).stdoutBuffer;
}

export async function writePatch(
  root: string,
  from: string,
  to: string,
  destination: string,
): Promise<void> {
  await fs.promises.writeFile(destination, await diffPatch(root, from, to), {
    mode: 0o600,
  });
}

export type SourceEntry =
  | { readonly kind: "absent" }
  | { readonly kind: "dir"; readonly mode: number }
  | { readonly kind: "file" | "link"; readonly content: Buffer; readonly mode: number };

export async function sourceEntry(root: string, relative: string): Promise<SourceEntry> {
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

export function sameEntry(a: SourceEntry, b: SourceEntry): boolean {
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
export function sameTrackedEntry(a: SourceEntry, b: SourceEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "absent" || b.kind === "absent") return true;
  if (a.kind === "dir" || b.kind === "dir") return true;
  if (!a.content.equals(b.content)) return false;
  return a.kind === "link" || (a.mode & 0o100) === (b.mode & 0o100);
}

export async function commitEntry(root: string, commit: string, relative: string): Promise<SourceEntry> {
  const entry = (
    await git(
      ["--literal-pathspecs", "ls-tree", commit, "--", relative],
      { cwd: root },
    )
  ).stdout.trim();
  if (/^040000 tree [0-9a-f]+\t/.test(entry)) return { kind: "dir", mode: 0o755 };
  const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t/.exec(entry);
  if (!match) return { kind: "absent" };
  const content = (await git(["cat-file", "blob", match[2]!], { cwd: root, buffer: true })).stdoutBuffer;
  return match[1] === "120000"
    ? { kind: "link", content, mode: 0o777 }
    : { kind: "file", content, mode: match[1] === "100755" ? 0o755 : 0o644 };
}

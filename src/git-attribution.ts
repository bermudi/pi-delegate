/**
 * Git before/after completion evidence (SPEC v3 "Observability —
 * Completion evidence"; user decision 2026-10-02, live session 01a0fdba —
 * every bash-using worker reported only `files: uncertain (bash)`, which
 * told the caller nothing usable). For each task, the coordinator opens
 * an evidence window on the worker's actual cwd before its first attempt
 * and settles it after the final one: two Git snapshots (HEAD plus
 * porcelain status with per-path lstat) diff into the paths that changed
 * inside the window — committed work included. The snapshot helpers are
 * stateless; the registry below is the owned, per-session state.
 *
 * Evidence, not confinement — and a deliberately honest window: a shared
 * folder can carry another writer's changes during it, so concurrent
 * writers are named beside the files line rather than pretending the
 * window was exclusive.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { canonicalPath, exec, gitProbeEnv } from "./fsx.ts";
import { isWriter } from "./profiles.ts";
import type { ResolvedTask, TaskOutcome } from "./types.ts";

const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024;

/** A read-only Git probe through the repo's argv-array execFile wrapper. */
async function gitProbe(args: readonly string[]): Promise<string> {
  const result = await exec("git", args, {
    env: gitProbeEnv(),
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: SNAPSHOT_MAX_BUFFER,
  });
  return result.stdout;
}

/** The failure text the fail-closed probes inspect: stderr first. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = stderr === undefined || stderr === null ? "" : String(stderr).trim();
    return text === "" ? error.message : `${error.message}\n${text}`;
  }
  return String(error);
}

/**
 * The universal empty-tree hash: diffing it against a new HEAD reports
 * the files a first commit introduced — the window where a repo had no
 * HEAD before and has one after.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** lstat facts compared between snapshots; a missing path carries undefined. */
interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

interface StatusEntry {
  /** Porcelain XY code as emitted (`??`, ` M`, `R `, …). */
  readonly status: string;
  readonly stat: FileStat | undefined;
}

export interface RepoSnapshot {
  /** Repository top-level, canonicalized like ResolvedTask cwd/writeRoots. */
  readonly root: string;
  /** HEAD commit id; undefined on an unborn branch. */
  readonly head: string | undefined;
  /**
   * Repo-relative path → porcelain entry (`status --porcelain=v1 -z
   * --untracked-files=all`). Gitignored paths never appear — they are
   * simply not covered by a snapshot.
   */
  readonly files: ReadonlyMap<string, StatusEntry>;
}

function statOf(candidate: string): FileStat | undefined {
  try {
    const stat = fs.lstatSync(candidate);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
  } catch {
    // Vanished between the status listing and the lstat — still
    // evidence of change; the entry stands with no stat.
    return undefined;
  }
}

/**
 * `-z` porcelain output is NUL-terminated `XY <path>` records; a rename
 * or copy emits a second bare path (no XY prefix) as the next record,
 * and quoting is off so paths arrive verbatim.
 */
function parsePorcelain(stdout: string): Map<string, StatusEntry> {
  const files = new Map<string, StatusEntry>();
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record === "") continue;
    const status = record.slice(0, 2);
    const entry: StatusEntry = { status, stat: undefined };
    files.set(record.slice(3), entry);
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      const origin = records[++i];
      if (origin !== undefined && origin !== "") files.set(origin, entry);
    }
  }
  return files;
}

/**
 * Snapshot a task cwd's repository: top-level, HEAD, status entries with
 * lstats. `undefined` when the cwd is not inside a repository — an
 * ordinary "no coverage" answer, not a failure. Git's own errors (broken
 * `.git`, missing binary, timeouts) throw; the caller logs and degrades.
 */
export async function snapshotRepo(cwd: string): Promise<RepoSnapshot | undefined> {
  let topOut: string;
  try {
    topOut = await gitProbe(["-C", cwd, "rev-parse", "--show-toplevel"]);
  } catch (error) {
    // Mirrors writeRootsOf's fail-closed rule: only Git's explicit
    // "not a repository" permits the no-coverage answer.
    if (/not a git repository/i.test(errorText(error))) return undefined;
    throw error;
  }
  const root = topOut.trim();
  if (root === "") return undefined;
  let head: string | undefined;
  try {
    head = (await gitProbe(["-C", root, "rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    // An unborn branch has no HEAD; the status listing still covers
    // the tree and committed-diff coverage is simply absent.
    head = undefined;
  }
  const status = await gitProbe([
    "-C",
    root,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const canonical = canonicalPath(root);
  const files = new Map<string, StatusEntry>();
  for (const [rel, entry] of parsePorcelain(status)) {
    files.set(rel, { status: entry.status, stat: statOf(join(canonical, rel)) });
  }
  return { root: canonical, head, files };
}

function sameStat(a: FileStat | undefined, b: FileStat | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * Repo-relative paths whose observable state differs between snapshots:
 * every path whose status entry or lstat changed, every S0 path the S1
 * listing no longer carries (reverted or committed away), plus — when
 * HEAD moved inside the window — `git diff --name-only` between the two
 * commits so work the task committed is still reported.
 */
export async function changedRelPaths(
  before: RepoSnapshot,
  after: RepoSnapshot,
): Promise<string[]> {
  const changed = new Set<string>();
  for (const [rel, entry] of after.files) {
    const prior = before.files.get(rel);
    if (prior === undefined || prior.status !== entry.status || !sameStat(prior.stat, entry.stat)) {
      changed.add(rel);
    }
  }
  for (const rel of before.files.keys()) {
    if (!after.files.has(rel)) changed.add(rel);
  }
  if (before.head !== after.head) {
    const base = before.head ?? EMPTY_TREE;
    const tip = after.head ?? EMPTY_TREE;
    if (base !== tip) {
      const committed = await gitProbe([
        "-C",
        after.root,
        "diff",
        "--name-only",
        base,
        tip,
      ]);
      for (const rel of committed.split("\n")) {
        if (rel !== "") changed.add(rel);
      }
    }
  }
  return [...changed].sort();
}

/**
 * One task's settled window: absolute changed paths inside it (empty
 * when the tree stayed put), `covered: false` when a Git failure kept
 * the window from closing — the caller falls back to the unknown-shell
 * mark — and the names of concurrent writers that overlapped the window
 * on the same repository root.
 */
export interface WindowEvidence {
  readonly files: readonly string[];
  readonly covered: boolean;
  readonly concurrentWriters: readonly string[];
}

interface WindowRecord {
  /** `<ticket>#<task>` for ticket work, the bare task id for inline runs. */
  readonly name: string;
  readonly root: string;
  readonly startedAt: number;
  endedAt: number | undefined;
  parentMutated: boolean;
  /**
   * The pre-window snapshot — kept only while the window is open or its
   * settle is in flight; dropped the moment the window closes so the
   * registry's memory doesn't grow with every task it has ever seen.
   */
  before: RepoSnapshot | undefined;
}

function windowsOverlap(record: WindowRecord, other: WindowRecord): boolean {
  const end = record.endedAt ?? Date.now();
  const otherEnd = other.endedAt ?? Date.now();
  return other.startedAt <= end && otherEnd >= record.startedAt;
}

/**
 * The session's evidence-window registry — owned by the extension
 * closure, one instance across dispatches so overlapping tickets still
 * see each other's windows. A closed record is kept only while a
 * still-open window could have overlapped it; once every open window
 * started after it ended, no future window can overlap it either, so it
 * is pruned.
 */
export class AttributionWindows {
  private records: WindowRecord[] = [];

  /**
   * Open a task's evidence window: snapshot the worker's actual cwd
   * right before its first attempt. `undefined` when the cwd is outside
   * Git (shell changes there stay unknowable), after a Git failure —
   * logged, degrading to the unknown-shell mark without failing the
   * task — and for a task whose toolset cannot mutate at all: a
   * read-only run opens no window, so it pays no snapshot cost and can
   * never wear a sibling's or the parent's concurrent edits.
   */
  async open(task: ResolvedTask, ticketId?: string): Promise<WindowRecord | undefined> {
    if (!isWriter(task.tools)) return undefined;
    let before: RepoSnapshot | undefined;
    try {
      before = await snapshotRepo(task.cwd);
    } catch (error) {
      console.error(
        `[delegate] git snapshot failed for ${task.id} in ${task.cwd}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    if (before === undefined) return undefined;
    const record: WindowRecord = {
      name: ticketId !== undefined ? `${ticketId}#${task.id}` : task.id,
      root: before.root,
      startedAt: Date.now(),
      endedAt: undefined,
      parentMutated: false,
      before,
    };
    this.records.push(record);
    return record;
  }

  /**
   * Flag every open window after a parent write/edit/bash/exec tool
   * event. Content-free by design — the parent's tool arguments are
   * never inspected, so the fact is not scoped to the window's root; the
   * `may include` wording carries that breadth honestly.
   */
  noteParentMutation(): void {
    for (const record of this.records) {
      if (record.endedAt === undefined) record.parentMutated = true;
    }
  }

  /**
   * Close a window after the task's final attempt (before workspace
   * reconciliation): snapshot again, diff the pair, and name the
   * concurrent writers — parent included — that overlapped it on the
   * same repository root.
   */
  async settle(record: WindowRecord): Promise<WindowEvidence> {
    const before = record.before;
    if (before === undefined) {
      // Already closed (settle raced an abandon) — nothing to diff.
      return { files: [], covered: false, concurrentWriters: [] };
    }
    try {
      const after = await snapshotRepo(record.root);
      record.endedAt = Date.now();
      if (after === undefined) {
        // The tree stopped being a repository mid-task — no coverage;
        // the window still closes fully.
        record.before = undefined;
        this.prune();
        return { files: [], covered: false, concurrentWriters: [] };
      }
      const files = (await changedRelPaths(before, after)).map((rel) =>
        join(record.root, rel),
      );
      const writers = this.records
        .filter(
          (other) =>
            other !== record &&
            other.root === record.root &&
            windowsOverlap(record, other),
        )
        .map((other) => other.name);
      const concurrentWriters = [
        ...(record.parentMutated ? ["parent"] : []),
        ...writers,
      ];
      record.before = undefined;
      this.prune();
      return { files, covered: true, concurrentWriters };
    } catch (error) {
      record.endedAt = Date.now();
      record.before = undefined;
      this.prune();
      console.error(
        `[delegate] git snapshot failed for ${record.name} in ${record.root}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { files: [], covered: false, concurrentWriters: [] };
    }
  }

  /** End a window whose task died between open and settle. */
  abandon(record: WindowRecord): void {
    record.endedAt ??= Date.now();
    record.before = undefined;
    this.prune();
  }

  /**
   * Drop closed records that can no longer overlap any still-open
   * window — a window that ended before the earliest open window
   * started can overlap nothing now running and nothing that opens
   * later. With no open windows, every closed record goes.
   */
  private prune(): void {
    let earliestOpen = Number.POSITIVE_INFINITY;
    for (const record of this.records) {
      if (record.endedAt === undefined && record.startedAt < earliestOpen) {
        earliestOpen = record.startedAt;
      }
    }
    this.records = this.records.filter(
      (record) =>
        record.endedAt === undefined || record.endedAt >= earliestOpen,
    );
  }
}

/**
 * Fold settled-window evidence into a recorded outcome (and re-fold a
 * late worker-truth outcome over the same window): attributed files are
 * the write/edit-observed set union the window's changed paths, kept in
 * observed order then sorted additions, deduplicated. The bash
 * uncertainty mark survives only when the window never covered the task;
 * when it did, the diff IS the shell evidence and the mark lifts.
 * `observedFiles` is recorded alongside `concurrentWriters` so overlap
 * reporting can still fall back to directly-observed paths for a task
 * whose window other writers may have dirtied.
 */
export function withGitEvidence(
  outcome: TaskOutcome,
  evidence: WindowEvidence,
): TaskOutcome {
  const observed = outcome.attributedFiles ?? [];
  const merged =
    evidence.covered && evidence.files.length > 0
      ? [...new Set([...observed, ...evidence.files])]
      : observed;
  return {
    ...outcome,
    ...(merged.length > 0 ? { attributedFiles: merged } : { attributedFiles: undefined }),
    uncertainFiles: outcome.uncertainFiles === true && !evidence.covered ? true : undefined,
    ...(evidence.concurrentWriters.length > 0
      ? {
          concurrentWriters: evidence.concurrentWriters,
          ...(observed.length > 0 ? { observedFiles: observed } : {}),
        }
      : {}),
  };
}

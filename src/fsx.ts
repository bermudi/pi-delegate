import { DIAGNOSTIC_TREE, DiagnosticSink, diagnosticRoots, isDiagnosticPath } from "./diagnostics.ts";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";

/**
 * Directory names delegate owns directly under the agent directory. Single
 * source of truth: workspace bases derive from these, and every list that
 * must exclude a sibling tree (e.g. Git baseline snapshots) names it from
 * here — a future workspace tree added in one place cannot be forgotten in
 * another, which is exactly the artifact-leak bug class this prevents.
 */
export const DELEGATE_TREES = Object.freeze({
  /** Durable subagent session transcripts. */
  sessions: "delegate-sessions",
  /** Disposable full-tree copies for scratch tasks. */
  scratch: "delegate-scratch",
  /** Git worktrees and artifacts for isolated tasks. */
  isolated: "delegate-isolated",
  /** Durable ticket journal — rewritten on every recorded outcome. */
  tickets: "delegate-tickets",
  /** Owner-only operational diagnostics (never part of worker copies). */
  diagnostics: DIAGNOSTIC_TREE,
} as const);

/** Canonical path for admission comparisons (resolves symlinks). */
export function canonicalPath(path: string): string {
  try {
    return fs.realpathSync.native(path);
  } catch {
    return resolvePath(path);
  }
}

/** True when `candidate` is `root` itself or lies underneath it. */
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Discover reserved runtime trees (including aliases and previous-process
 * fallbacks) without reading records. Actual roots cover not-yet-created logs.
 * Used by every private Git snapshot, not just initial workspace preparation. */
export async function diagnosticExclusions(diagnostics: DiagnosticSink, root: string): Promise<string[]> {
  const excluded = new Set<string>();
  for (const destination of diagnosticRoots(diagnostics)) {
    for (const candidate of [resolvePath(destination), canonicalPath(destination)]) {
      if (isWithin(root, candidate)) excluded.add(relative(root, candidate) || ".");
    }
  }
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (isDiagnosticPath(candidate)) excluded.add(relative(root, candidate));
      else if (entry.isDirectory() && entry.name !== ".git") await walk(candidate);
    }
  };
  await walk(root);
  return [...excluded];
}

/**
 * Process env with every inherited `GIT_*` variable removed — the one scrub
 * every Git invocation goes through. Git always runs with inherited `GIT_*`
 * redirects scrubbed: a polluted environment (GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, …) must never redirect delegate's
 * repository access. Explicit per-command overrides are the only way a
 * `GIT_*` name reappears, and they are applied after the scrub, on top of it.
 */
function gitEnvScrubbed(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}

/**
 * Probe env for scope discovery (write roots, copy sources): scrubbed, plus
 * a fixed deterministic posture — C locale output, no optional locks, and
 * cross-filesystem discovery — so inherited redirects cannot shrink or
 * localize what the probe reports.
 */
export function gitProbeEnv(): NodeJS.ProcessEnv {
  return {
    ...gitEnvScrubbed(),
    LC_ALL: "C",
    LANG: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
  };
}

/**
 * Env for delegate-driven Git commands: scrubbed, then explicit
 * per-command overrides merged on top (e.g. the temporary index/worktree
 * used for index-only operations). Overrides win over anything inherited —
 * after the scrub there is nothing inherited left to win against.
 */
export function gitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...gitEnvScrubbed(), ...overrides };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** stdout as raw bytes, regardless of the decoding requested. */
  stdoutBuffer: Buffer;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Stdin payload; the child's stdin is closed after writing it. */
  input?: string;
  /** Collect stdout as raw bytes instead of eager UTF-8 decoding. */
  buffer?: boolean;
  /**
   * Kill the child when it runs longer than this. Deliberately required:
   * the right limit differs per use case (fast probes vs snapshot-sized
   * traffic), so every call site names its own preset.
   */
  timeoutMs: number;
  /** Kill the child when a piped stream exceeds this many bytes. */
  maxBuffer: number;
  /**
   * Error class used to reject failures, constructed as (message, stderr).
   * Call sites whose control flow inspects the failure payload (merge
   * conflict detection) pass a stderr-carrying class; the default is a
   * plain Error.
   */
  errorClass?: new (message: string, stderr: string) => Error;
}

/**
 * The one child-process wrapper: everything delegate runs externally goes
 * through here, so encoding, failure payload, and stream limits are uniform.
 * Timeouts and buffer ceilings are passed in per call site as named presets.
 */
export function exec(
  file: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: options.buffer ? "buffer" : "utf8",
      },
      (error, stdout, stderr) => {
        const out = options.buffer
          ? (stdout as Buffer)
          : Buffer.from((stdout as string) ?? "");
        if (error) {
          const stderrText = String(stderr);
          const trimmed = stderrText.trim();
          const message = `${file} ${args.join(" ")} failed${trimmed ? `: ${trimmed}` : ""}`;
          if (options.errorClass) {
            reject(new options.errorClass(message, stderrText));
          } else {
            reject(new Error(message));
          }
          return;
        }
        resolve({
          stdout: out.toString("utf8"),
          stderr: String(stderr),
          stdoutBuffer: out,
        });
      },
    );
    if (options.input !== undefined && child.stdin) {
      // The child may exit before it drains stdin (EPIPE); the execFile
      // callback already reports that failure.
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });
}

/** Grace window between SIGTERM and SIGKILL when draining a workspace. */
const PROCESS_GRACE_MS = 500;

function log(diagnostics: DiagnosticSink, context: string, error: unknown): void {
  diagnostics.log("error", "workspace process cleanup", { operation: context }, error);
}

/**
 * Processes still rooted in a workspace — leftover bash children can keep
 * mutating files after the model run ends, so output must not be accepted
 * while any survive. Linux-only evidence; elsewhere there is nothing to kill.
 */
async function processesIn(root: string): Promise<number[]> {
  if (process.platform !== "linux" || !fs.existsSync("/proc")) return [];
  const pids: number[] = [];
  for (const entry of await fs.promises.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cwd = await fs.promises.realpath(join("/proc", entry, "cwd"));
      if (isWithin(root, cwd)) pids.push(pid);
    } catch {
      // Processes exit or become unreadable while /proc is scanned.
    }
  }
  return pids;
}

/**
 * Terminate every process still running inside a workspace tree: SIGTERM,
 * a grace window, then SIGKILL. Throws when anything survives — scratch
 * removal treats that as litter-to-log; isolated reconciliation refuses to
 * accept output while a straggler lives.
 */
export async function stopWorkspaceProcesses(diagnostics: DiagnosticSink, root: string): Promise<void> {
  let pids = await processesIn(root);
  if (!pids.length) return;
  log(diagnostics, `terminating ${pids.length} process(es) left in delegated workspace '${root}'`, "");
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, PROCESS_GRACE_MS));
  pids = await processesIn(root);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const survivors = await processesIn(root);
  if (survivors.length) {
    throw new Error(
      `Could not quiesce isolated workspace; process(es) ${survivors.join(", ")} remain.`,
    );
  }
}

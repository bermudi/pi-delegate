import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Kept independent of fsx: fsx itself reports diagnostics. */
export const DIAGNOSTIC_TREE = "delegate-diagnostics";

/**
 * The parent model's bug-report spool (SPEC v3 "Report surface"): another
 * owner-only runtime tree under the same agent directory, with the same
 * privacy and exclusion rules. Declared here so the reserved-namespace
 * predicate below owns every Delegate runtime tree in one place.
 */
export const REPORT_TREE = "delegate-reports";

/** Every Delegate-owned runtime directory name. A tree listed here is never
 * source: it cannot be copied into a scratch/isolated workspace, hashed into
 * a source Git snapshot, or attributed as completion evidence. */
const RUNTIME_TREES: readonly string[] = Object.freeze([
  DIAGNOSTIC_TREE,
  REPORT_TREE,
]);

/** Reserved runtime namespaces, independent of engine agentDir and environment.
 * Match whole components only: ordinary names such as diagnostics.md remain
 * source. Resolve existing aliases too, without opening any record contents. */
export function isDiagnosticPath(path: string): boolean {
  const separator = process.platform === "win32" ? /[\\/]/ : "/";
  const reserved = (candidate: string): boolean =>
    candidate
      .split(separator)
      .some(
        (component) =>
          RUNTIME_TREES.includes(component) ||
          /^pi-delegate-diagnostics-\d+-\d+$/.test(component),
      );
  if (reserved(path)) return true;
  // Deleted leaves still inherit a surviving alias directory's namespace.
  // No file contents are opened, and absent paths cannot force a helper error.
  let candidate = resolve(path);
  for (;;) {
    try {
      return reserved(realpathSync.native(candidate));
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

/**
 * Actual destinations for every reserved runtime tree — both cover
 * directories not yet created by this process, and the namespace predicate
 * above covers existing other-process fallback trees. Named for the surfaces
 * it serves rather than for diagnostics alone: a tree added to
 * `RUNTIME_TREES` without a root here would be copied into private Git
 * baselines, which is exactly the leak class this function exists to close.
 */
export function runtimeRoots(
  diagnostics: DiagnosticSink,
): readonly string[] {
  const roots: string[] = [];
  try {
    const base = process.env.DELEGATE_AGENT_DIR?.trim() || getAgentDir();
    for (const tree of RUNTIME_TREES) roots.push(join(base, tree));
  } catch (error) {
    diagnostics.log(
      "warn",
      "diagnostic destination discovery failed",
      { operation: "discover primary runtime root" },
      error,
    );
  }
  try {
    const owner = process.getuid?.();
    if (owner !== undefined)
      roots.push(
        join(tmpdir(), `pi-delegate-diagnostics-${owner}-${process.pid}`),
      );
  } catch (error) {
    diagnostics.log(
      "warn",
      "diagnostic destination discovery failed",
      { operation: "discover fallback runtime root" },
      error,
    );
  }
  return roots;
}

type Level = "error" | "warn" | "info";
/** Only operational metadata belongs here, never request/profile/provider bodies. */
const CONTEXT_KEYS = Object.freeze([
  "taskId",
  "ticketId",
  "questionId",
  "sessionId",
  "path",
  "phase",
  "count",
  "attempt",
  "maxAttempts",
  "budgetMs",
  "reach",
  "status",
  "by",
  "operation",
  "index",
  "steerId",
  "orphaned",
  "bytes",
  "signal",
  "pid",
  "code",
  "category",
  "keys",
  "recognized",
] as const);
type Context = Readonly<
  Partial<
    Record<(typeof CONTEXT_KEYS)[number], string | number | boolean | undefined>
  >
>;

function bounded(value: string, limit = 512): string {
  // JSON escapes C0 controls; also escape DEL/C1 and Unicode line separators.
  return value
    .slice(0, limit)
    .replace(
      /[\x7f-\x9f\u2028\u2029]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .slice(0, limit);
}

/** Data descriptors only: provider-controlled getters must never run. Follow only
 * bounded Error.cause links, retaining the first allowlisted operational code. */
function safeError(error: unknown): {
  class: string;
  code?: string;
  errcode?: number;
} {
  const classes = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "URIError",
    "EvalError",
    "AggregateError",
    "AbortError",
  ];
  const codes = [
    "EACCES",
    "EPERM",
    "ENOENT",
    "EEXIST",
    "ENOTDIR",
    "EISDIR",
    "ELOOP",
    "ENOSPC",
    "EDQUOT",
    "EROFS",
    "EMFILE",
    "ENFILE",
    "EIO",
    "EBADF",
    "EINVAL",
    "EPIPE",
    "ECONNRESET",
    "ETIMEDOUT",
    "ABORT_ERR",
    "SQLITE_BUSY",
    "SQLITE_LOCKED",
    "DIAGNOSTIC_UNSAFE_PATH",
    "DIAGNOSTIC_UNSUPPORTED",
  ];
  const data = (value: object, key: string): unknown => {
    for (let depth = 0; depth < 4; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor)
        return "value" in descriptor ? descriptor.value : undefined;
      const parent = Object.getPrototypeOf(value);
      if (!parent) break;
      value = parent;
    }
  };
  let name = "unknown";
  let code: string | undefined;
  // node:sqlite failures carry a numeric SQLite result code (errcode 5 =
  // SQLITE_BUSY) alongside a generic "ERR_SQLITE_ERROR" code — the number is
  // the diagnostic fact, the generic string is not. Bounded integers only.
  let errcode: number | undefined;
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < 4 && error !== null && typeof error === "object";
    depth++
  ) {
    if (seen.has(error)) break;
    seen.add(error);
    try {
      const candidate = data(error, "code");
      if (
        code === undefined &&
        typeof candidate === "string" &&
        codes.includes(candidate)
      )
        code = candidate;
      const numeric = data(error, "errcode");
      if (
        errcode === undefined &&
        typeof numeric === "number" &&
        Number.isInteger(numeric) &&
        numeric >= 0 &&
        numeric <= 0xffffffff
      )
        errcode = numeric;
      if (!(error instanceof Error)) break;
      if (depth === 0) {
        const candidateName = data(error, "name");
        name =
          typeof candidateName === "string" && classes.includes(candidateName)
            ? candidateName
            : "Error";
      }
      error = data(error, "cause");
    } catch {
      break;
    } // Revoked proxies/accessors are never serialized.
  }
  return {
    class: name,
    ...(code === undefined ? {} : { code }),
    ...(errcode === undefined ? {} : { errcode }),
  };
}

interface DiagnosticRoutingDetails {
  readonly event: string;
  readonly primaryFailure: {
    readonly operation: string;
    readonly path: string;
    readonly class: string;
    readonly code?: string;
  };
  readonly fallbackFailure: {
    readonly operation: string;
    readonly class: string;
    readonly code?: string;
  };
}

/** Backend error carries ONLY already-sanitized routing facts, never payloads. */
class DiagnosticRoutingError extends Error {
  constructor(readonly details: DiagnosticRoutingDetails) {
    super("Delegate diagnostic routing failed");
  }
}

/** Explicitly owned by the extension (or standalone worker supervisor).
 * Routing and even notice failures are observations, never lifecycle failures.
 * No raw error payloads or unbounded queues are retained. */
export class DiagnosticSink {
  private failures = 0;
  private noticeFailed = false;
  private unsupported = false;
  private routing: DiagnosticRoutingDetails | undefined;
  private notify: ((warning: string) => void) | undefined;

  setNotice(notify: ((warning: string) => void) | undefined): void {
    this.notify = notify;
    if (this.failures > 0) this.reportNotice();
  }

  readonly log = (
    level: Level,
    event: string,
    context: Context = {},
    error?: unknown,
  ): void => {
    try {
      appendDiagnostic(level, event, context, error);
    } catch (failure) {
      this.reportFailure(failure);
    }
  };

  /** Also supervises legacy diagnostic observers (e.g. a worker log callback). */
  reportFailure(failure: unknown): void {
    this.failures = Math.min(9999, this.failures + 1);
    let details: DiagnosticRoutingDetails | undefined;
    try {
      if (failure instanceof DiagnosticRoutingError) details = failure.details;
    } catch {
      /* Revoked proxies are reported as unknown, never allowed to throw. */
    }
    if (details) {
      this.routing = details;
      if (
        details.primaryFailure.code === "DIAGNOSTIC_UNSUPPORTED" ||
        details.fallbackFailure.code === "DIAGNOSTIC_UNSUPPORTED"
      )
        this.unsupported = true;
    } else {
      this.routing = {
        event: "diagnostic output/observer failed",
        primaryFailure: {
          operation: "write diagnostic output/observer",
          path: "stderr or owned observer",
          ...safeError(failure),
        },
        fallbackFailure: {
          operation: "no attached-terminal fallback",
          class: "unknown",
        },
      };
    }
    if (this.failures === 1) this.reportNotice();
  }

  private reportNotice(): void {
    if (!this.notify) return;
    try {
      this.notify(this.warning()!);
    } catch {
      this.noticeFailed = true;
    }
  }

  warning(): string | undefined {
    if (!this.failures) return undefined;
    return `Warning: Delegate diagnostic ${this.unsupported ? "secure routing is unsupported" : "routing failed"}; ${this.failures} record(s) could not be written. Work and cleanup are unaffected; no attached-terminal fallback was used. Safe routing context: ${JSON.stringify(this.routing)}.${this.noticeFailed ? " The Pi notice also failed." : ""}`;
  }

  takeWarning(): string | undefined {
    const warning = this.warning();
    this.failures = 0;
    this.noticeFailed = false;
    this.unsupported = false;
    this.routing = undefined;
    return warning;
  }
}

function unsafe(): never {
  throw Object.assign(new Error("Unsafe diagnostic path"), {
    code: "DIAGNOSTIC_UNSAFE_PATH",
  });
}

function uid(): number {
  if (
    process.platform !== "linux" ||
    !process.getuid ||
    constants.O_NOFOLLOW === undefined ||
    constants.O_DIRECTORY === undefined
  ) {
    throw Object.assign(new Error("Secure diagnostics unsupported"), {
      code: "DIAGNOSTIC_UNSUPPORTED",
    });
  }
  return process.getuid();
}

/** Descriptor-relative traversal pins every ancestor; no symlink is followed. */
function fdPath(fd: number, name: string): string {
  return join(`/proc/self/fd/${fd}`, name);
}

function checkDirectory(stat: Stats, owner: number, privateDir: boolean): void {
  if (!stat.isDirectory()) unsafe();
  if (privateDir) {
    if (stat.uid !== owner || (stat.mode & 0o7777) !== 0o700) unsafe();
  } else {
    // Ancestors can be root-owned; the sole writable exception is root's sticky tmp.
    if (stat.uid !== owner && stat.uid !== 0) unsafe();
    if (
      (stat.mode & 0o022) !== 0 &&
      !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)
    )
      unsafe();
  }
}

function openDirectory(path: string, create: boolean): number {
  const owner = uid();
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let fd = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    checkDirectory(fstatSync(fd), owner, false);
    for (const name of absolute.slice(root.length).split(sep).filter(Boolean)) {
      const nextPath = fdPath(fd, name);
      if (create) {
        try {
          mkdirSync(nextPath, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const next = openSync(
        nextPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        checkDirectory(fstatSync(next), owner, false);
      } catch (error) {
        closeSync(next);
        throw error;
      }
      closeSync(fd);
      fd = next;
    }
    // The chosen base itself must belong to the current user (tmp is checked separately).
    if (create && fstatSync(fd).uid !== owner) unsafe();
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function append(directory: number, record: string): void {
  const owner = uid();
  checkDirectory(fstatSync(directory), owner, true);
  const path = fdPath(directory, `${process.pid}.jsonl`);
  let file: number;
  try {
    file = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    file = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
  }
  try {
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.uid !== owner ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.nlink !== 1
    )
      unsafe();
    const bytes = Buffer.from(record + "\n");
    // No persistent handles. A short write is completed rather than dropping the remainder.
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(file, bytes, offset, bytes.length - offset);
      if (written === 0)
        throw Object.assign(new Error("Diagnostic write made no progress"), {
          code: "EIO",
        });
      offset += written;
    }
  } finally {
    closeSync(file);
  }
}

/**
 * Open one reserved runtime tree under an already-open base, optionally
 * creating it. The tree itself carries the strict privacy checks (owner-only
 * 0700, no symlink anywhere on the path): a tree that already exists with any
 * other shape is unsafe, never adopted.
 */
function openPrivateTree(base: number, tree: string, create: boolean): number {
  const owner = uid();
  const path = fdPath(base, tree);
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const dir = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    checkDirectory(fstatSync(dir), owner, true);
  } catch (error) {
    closeSync(dir);
    throw error;
  }
  return dir;
}

function appendPrimary(agentDir: string, record: string): void {
  const base = openDirectory(agentDir, true);
  try {
    const dir = openPrivateTree(base, DIAGNOSTIC_TREE, true);
    try {
      append(dir, record);
    } finally {
      closeSync(dir);
    }
  } finally {
    closeSync(base);
  }
}

function appendFallback(record: string): void {
  const base = openDirectory(tmpdir(), false);
  try {
    const path = fdPath(
      base,
      `pi-delegate-diagnostics-${uid()}-${process.pid}`,
    );
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const dir = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      append(dir, record);
    } finally {
      closeSync(dir);
    }
  } finally {
    closeSync(base);
  }
}

/**
 * One owner-only record create under a reserved tree. `exists` is the
 * content-addressed dedup signal: the name was already taken by a record of
 * exactly the shape this process writes.
 */
type PrivateRecordWrite = "created" | "exists";

function isMissingEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * An existing entry counts as a record only when it is exactly the shape
 * written below: a regular, single-link, owner-owned 0600 file reached
 * without following a symlink. Anything else — a planted link, a foreign
 * file, a writable copy — is unsafe, never silently read as "already filed".
 */
function verifyPrivateRecord(directory: number, name: string): void {
  const owner = uid();
  let file: number;
  try {
    file = openSync(
      fdPath(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    // A symlink at the record's own name is an attack, not a missing file.
    if ((error as NodeJS.ErrnoException).code === "ELOOP") unsafe();
    throw error;
  }
  try {
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.uid !== owner ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.nlink !== 1
    )
      unsafe();
  } finally {
    closeSync(file);
  }
}

/**
 * True when a conforming record already occupies `<base>/<tree>/<name>`.
 * A missing base, tree, or entry is `false` (nothing has been filed yet);
 * an entry that exists with any other shape throws `DIAGNOSTIC_UNSAFE_PATH`.
 * Ownership and capability gaps throw like every other secure route — the
 * caller reports the gap instead of guessing.
 */
export function privateRecordExists(
  base: string,
  tree: string,
  name: string,
): boolean {
  let root: number;
  try {
    root = openDirectory(base, false);
  } catch (error) {
    if (isMissingEntry(error)) return false;
    throw error;
  }
  try {
    let directory: number;
    try {
      directory = openPrivateTree(root, tree, false);
    } catch (error) {
      if (isMissingEntry(error)) return false;
      throw error;
    }
    try {
      try {
        verifyPrivateRecord(directory, name);
        return true;
      } catch (error) {
        if (isMissingEntry(error)) return false;
        throw error;
      }
    } finally {
      closeSync(directory);
    }
  } finally {
    closeSync(root);
  }
}

/**
 * Create one owner-only record at `<base>/<tree>/<name>` with the diagnostic
 * routing rules: descriptor-relative traversal, `O_NOFOLLOW` on every
 * component, owner/mode checks on the base and the 0700 tree, an exclusive
 * 0600 single-link create, a completed write, and no persistent handle.
 * Throws `DIAGNOSTIC_UNSUPPORTED` where secure routing is unavailable
 * (non-Linux, or a missing getuid/O_NOFOLLOW/O_DIRECTORY capability) — the
 * caller reports that gracefully; there is deliberately no terminal or
 * temporary-directory fallback for records the model authored.
 */
export function writePrivateRecord(
  base: string,
  tree: string,
  name: string,
  contents: string,
): PrivateRecordWrite {
  const root = openDirectory(base, true);
  try {
    const directory = openPrivateTree(root, tree, true);
    try {
      const owner = uid();
      let file: number;
      try {
        file = openSync(
          fdPath(directory, name),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          verifyPrivateRecord(directory, name);
          return "exists";
        }
        throw error;
      }
      try {
        const stat = fstatSync(file);
        if (
          !stat.isFile() ||
          stat.uid !== owner ||
          (stat.mode & 0o7777) !== 0o600 ||
          stat.nlink !== 1
        )
          unsafe();
        // No persistent handles. A short write is completed rather than
        // dropping the remainder.
        const bytes = Buffer.from(contents);
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(file, bytes, offset, bytes.length - offset);
          if (written === 0)
            throw Object.assign(new Error("Report write made no progress"), {
              code: "EIO",
            });
          offset += written;
        }
      } finally {
        closeSync(file);
      }
      return "created";
    } finally {
      closeSync(directory);
    }
  } finally {
    closeSync(root);
  }
}

/** Stateless backend. Only the owned nonthrowing sink may call it. */
function appendDiagnostic(
  level: Level,
  event: string,
  context: Context = {},
  error?: unknown,
): void {
  const safeContext = Object.fromEntries(
    Object.entries(context)
      .filter(
        ([key, value]) =>
          (CONTEXT_KEYS as readonly string[]).includes(key) &&
          (typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value))),
      )
      .slice(0, 16)
      .map(([key, value]) => [
        key,
        typeof value === "string" ? bounded(value) : value,
      ]),
  );
  const record = {
    time: new Date().toISOString(),
    pid: process.pid,
    level,
    event: bounded(event, 192),
    context: safeContext,
    ...(error === undefined ? {} : { error: safeError(error) }),
  };
  const line = JSON.stringify(record);
  if (process.stderr.isTTY !== true) {
    if (level === "warn") console.warn(`[delegate] ${line}`);
    else console.error(`[delegate] ${line}`);
    return;
  }
  let agentDir: string | undefined;
  try {
    agentDir = process.env.DELEGATE_AGENT_DIR?.trim() || getAgentDir();
    appendPrimary(agentDir, line);
  } catch (primaryError) {
    const primaryFailure = {
      ...safeError(primaryError),
      operation: "append primary diagnostic",
      path:
        agentDir === undefined
          ? "agent-directory resolution"
          : bounded(join(agentDir, DIAGNOSTIC_TREE, `${process.pid}.jsonl`)),
    };
    try {
      appendFallback(JSON.stringify({ ...record, primaryFailure }));
    } catch (fallbackError) {
      throw new DiagnosticRoutingError({
        event: record.event,
        primaryFailure,
        fallbackFailure: {
          operation: "append fallback diagnostic",
          ...safeError(fallbackError),
        },
      });
    }
  }
}

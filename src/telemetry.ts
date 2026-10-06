import { DiagnosticSink } from "./diagnostics.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { TelemetryConfig } from "./config.ts";
import type { DispatchOutcome } from "./coordinator.ts";
import type { ResolvedTask, TaskOutcome, TicketStatus } from "./types.ts";

const require = createRequire(import.meta.url);
// The extension's own package.json — npm always ships it in the tarball
// even unlisted in `files`, so this resolves both in-tree and installed
// under ~/.pi/agent/npm/.
const pkg = require("../package.json") as { version?: unknown };
const EXTENSION_VERSION =
  typeof pkg.version === "string" && pkg.version !== ""
    ? pkg.version
    : "unknown";

const SCHEMA_VERSION = 6;
const BUSY_TIMEOUT_MS = 100;
const BUSY_WINDOW_MS = 500;
const BUSY_RETRY_BASE_MS = 10;
const BUSY_RETRY_MAX_MS = 50;
const TELEMETRY_DB_ENV_VAR = "DELEGATE_TELEMETRY_DB";
const BUSY_WINDOW_ENV_VAR = "DELEGATE_TELEMETRY_BUSY_MS";

/**
 * The busy-retry window bounds how long telemetry waits on a contended
 * database before giving up loudly — telemetry must never stall a
 * dispatch unboundedly, but a fixed 500ms loses under first-open WAL
 * contention on slow hosts (#53: 8 simultaneous openers each doing
 * schema work exhausted it in CI). `DELEGATE_TELEMETRY_BUSY_MS` widens
 * it where contention is expected.
 */
function busyWindowMs(): number {
  const raw = process.env[BUSY_WINDOW_ENV_VAR];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BUSY_WINDOW_MS;
}

const TABLES = [
  {
    name: "calls",
    create: `CREATE TABLE IF NOT EXISTS calls(
      id TEXT PRIMARY KEY, ts INTEGER, version TEXT, pi_version TEXT,
      mode TEXT, parent_model TEXT, task_count INTEGER, wall_ms INTEGER,
      status TEXT, total_tokens INTEGER, total_cost REAL,
      parent_session_file TEXT, parent_cwd TEXT,
      budget_limit INTEGER, budget_consumed INTEGER,
      budget_exhausted_at INTEGER)`,
    columns: [
      ["id", "TEXT PRIMARY KEY"],
      ["ts", "INTEGER"],
      ["version", "TEXT"],
      ["pi_version", "TEXT"],
      ["mode", "TEXT"],
      ["parent_model", "TEXT"],
      ["task_count", "INTEGER"],
      ["wall_ms", "INTEGER"],
      ["status", "TEXT"],
      ["total_tokens", "INTEGER"],
      ["total_cost", "REAL"],
      ["parent_session_file", "TEXT"],
      ["parent_cwd", "TEXT"],
      // SPEC v3 "Batch token budget" — the call's final budget account;
      // all NULL on budgetless dispatches (schema v6).
      ["budget_limit", "INTEGER"],
      ["budget_consumed", "INTEGER"],
      ["budget_exhausted_at", "INTEGER"],
    ],
  },
  {
    name: "tasks",
    create: `CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY, call_id TEXT, ts INTEGER, version TEXT,
      pi_version TEXT, idx INTEGER, agent TEXT, model TEXT, thinking TEXT,
      tools TEXT, workspace TEXT, outcome TEXT, failure_kind TEXT,
      duration_ms INTEGER, tokens INTEGER, cost REAL, tool_uses INTEGER,
      retries INTEGER, prompt_chars INTEGER, output_chars INTEGER,
      session_file TEXT, async INTEGER, error_snippet TEXT,
      integration TEXT, provisional INTEGER)`,
    columns: [
      ["id", "TEXT PRIMARY KEY"],
      ["call_id", "TEXT"],
      ["ts", "INTEGER"],
      ["version", "TEXT"],
      ["pi_version", "TEXT"],
      ["idx", "INTEGER"],
      ["agent", "TEXT"],
      ["model", "TEXT"],
      ["thinking", "TEXT"],
      ["tools", "TEXT"],
      ["workspace", "TEXT"],
      ["outcome", "TEXT"],
      ["failure_kind", "TEXT"],
      ["duration_ms", "INTEGER"],
      ["tokens", "INTEGER"],
      ["cost", "REAL"],
      ["tool_uses", "INTEGER"],
      ["retries", "INTEGER"],
      ["prompt_chars", "INTEGER"],
      ["output_chars", "INTEGER"],
      ["session_file", "TEXT"],
      ["async", "INTEGER"],
      ["error_snippet", "TEXT"],
      ["integration", "TEXT"],
      ["provisional", "INTEGER"],
    ],
  },
  {
    // SPEC v3 "Observability" — one row per dispatch that ends before
    // execution (validation, config-load, or admission rejection).
    // Misfires are the only feedback channel against trained-reflex
    // collisions; they ride the same store, destination, and retention
    // as completed dispatch rows.
    name: "misfires",
    create: `CREATE TABLE IF NOT EXISTS misfires(
      id TEXT PRIMARY KEY, ts INTEGER, version TEXT, pi_version TEXT,
      phase TEXT, message TEXT, task_count INTEGER,
      agents TEXT, workspaces TEXT, async INTEGER, parent_cwd TEXT)`,
    columns: [
      ["id", "TEXT PRIMARY KEY"],
      ["ts", "INTEGER"],
      ["version", "TEXT"],
      ["pi_version", "TEXT"],
      ["phase", "TEXT"],
      ["message", "TEXT"],
      ["task_count", "INTEGER"],
      ["agents", "TEXT"],
      ["workspaces", "TEXT"],
      ["async", "INTEGER"],
      ["parent_cwd", "TEXT"],
    ],
  },
] as const;

/** The batch shape a misfire row carries — what the caller asked for. */
export interface MisfireShape {
  readonly phase: "config" | "validation" | "admission";
  /** The caller-visible rejection message, verbatim. */
  readonly message: string;
  readonly taskCount: number;
  /** Requested agents, post-alias canonical names ("inline" when omitted). */
  readonly agents: readonly string[];
  /** Effective workspace per requested task. */
  readonly workspaces: readonly string[];
  /** The effective sync/async mode the rejected call resolved to. */
  readonly async: boolean;
  readonly parentCwd: string;
}

function report(diagnostics: DiagnosticSink, operation: string, destination: string, error: unknown): void {
  diagnostics.log("error", "telemetry failed", { operation, path: destination }, error);
}

function isBusy(error: unknown): boolean {
  const { code, errcode } = (error ?? {}) as {
    code?: unknown;
    errcode?: unknown;
  };
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    errcode === 5 ||
    errcode === 6
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|SQLITE_LOCKED|database(?: table)? is locked/i.test(message);
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function withBusyRetry<T>(fn: () => T): T {
  const deadline = Date.now() + busyWindowMs();
  let delay = BUSY_RETRY_BASE_MS;
  for (;;) {
    try {
      return fn();
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !isBusy(error)) throw error;
      sleepSync(Math.min(delay, remaining));
      delay = Math.min(delay * 2, BUSY_RETRY_MAX_MS);
    }
  }
}

function transact(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function destinationOf(config: TelemetryConfig, agentDir: string): string {
  if (config.dbPath !== undefined) return resolve(config.dbPath);
  const fromEnv = process.env[TELEMETRY_DB_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return resolve(fromEnv.trim());
  }
  return join(agentDir, "delegate-usage.db");
}

function tightenPermissions(destination: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(destination + suffix, 0o600);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "ENOENT") throw error;
    }
  }
}

function existingColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(
    rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

function ensureSchema(db: DatabaseSync): void {
  transact(db, () => {
    const versionRow = db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const version = versionRow?.user_version ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `unsupported telemetry schema version ${version}; expected at most ${SCHEMA_VERSION}`,
      );
    }
    for (const table of TABLES) {
      const object = db
        .prepare("SELECT type FROM sqlite_master WHERE name = ?")
        .get(table.name) as { type?: string } | undefined;
      if (object !== undefined && object.type !== "table") {
        throw new Error(
          `telemetry object ${table.name} is ${object.type}, not a table`,
        );
      }
      db.exec(table.create);
      const existing = existingColumns(db, table.name);
      for (const [name, definition] of table.columns) {
        if (existing.has(name)) continue;
        db.exec(`ALTER TABLE ${table.name} ADD COLUMN ${name} ${definition}`);
      }
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

function batchStatus(outcomes: readonly TaskOutcome[]): TicketStatus {
  if (outcomes.every((outcome) => outcome.status === "ok")) return "completed";
  if (outcomes.every((outcome) => outcome.status === "cancelled")) {
    return "cancelled";
  }
  // Interrupt is terminal first-class, like cancelled — a batch whose
  // tasks were all interrupted settles interrupted, same as the store.
  if (outcomes.every((outcome) => outcome.status === "interrupted")) {
    return "interrupted";
  }
  if (outcomes.some((outcome) => outcome.status === "ok")) return "partial";
  return "failed";
}

export interface DispatchTelemetrySpan {
  readonly ownedPaths: readonly string[];
  finish(result: DispatchOutcome, ticketStatus?: TicketStatus): void;
}

export class TelemetryStore {
  constructor(private readonly diagnostics: DiagnosticSink) {}

  private db: DatabaseSync | undefined;
  private destination: string | undefined;
  private generation = 0;
  private closed = false;
  private failedDestination: string | undefined;

  beginDispatch(
    config: TelemetryConfig,
    agentDir: string,
    input: {
      readonly async: boolean;
      readonly startedAt: number;
      readonly tasks: readonly ResolvedTask[];
    },
  ): DispatchTelemetrySpan {
    const destination = config.enabled
      ? destinationOf(config, agentDir)
      : undefined;
    const ownedPaths =
      destination === undefined
        ? []
        : [destination, `${destination}-wal`, `${destination}-shm`];
    if (destination !== this.destination) {
      this.closeBackend();
      this.destination = destination;
      this.failedDestination = undefined;
      this.generation += 1;
    }
    if (
      destination === undefined ||
      this.closed ||
      destination === this.failedDestination ||
      this.backend(destination) === undefined
    ) {
      return { ownedPaths, finish() {} };
    }
    const generation = this.generation;
    const callId = randomUUID();
    return {
      ownedPaths,
      finish: (result: DispatchOutcome, ticketStatus?: TicketStatus) => {
        if (
          this.closed ||
          generation !== this.generation ||
          destination !== this.destination ||
          this.db === undefined
        ) {
          return;
        }
        this.writeSpan(destination, callId, input, result, ticketStatus);
      },
    };
  }

  /**
   * Record one misfire row (SPEC v3 "Observability"): a dispatch that
   * ended before execution. Telemetry config may come from the loaded
   * config, or — when the load itself is what failed — a defensive raw
   * read of delegate.json's `telemetry` block; when the file is
   * unparseable, telemetry status is unknowable and nothing is written
   * (identical to disabled).
   */
  recordMisfire(
    config: TelemetryConfig,
    agentDir: string,
    row: MisfireShape,
  ): void {
    // Disabled — or unknowable on the config-load path, where the hint
    // degrades to the disabled default — is a pure no-op: there is no
    // row to write, and running the destination diff would close a live
    // backend and bump the generation out from under in-flight dispatch
    // spans, silently dropping their rows.
    if (!config.enabled) return;
    const destination = destinationOf(config, agentDir);
    if (destination !== this.destination) {
      this.closeBackend();
      this.destination = destination;
      this.failedDestination = undefined;
      this.generation += 1;
    }
    if (this.closed || destination === this.failedDestination) {
      return;
    }
    const db = this.backend(destination);
    if (db === undefined) return;
    const generation = this.generation;
    try {
      withBusyRetry(() => {
        transact(db, () => {
          db.prepare(
            `INSERT INTO misfires(id, ts, version, pi_version, phase,
               message, task_count, agents, workspaces, async, parent_cwd)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            randomUUID(),
            Date.now(),
            EXTENSION_VERSION,
            PI_VERSION,
            row.phase,
            row.message,
            row.taskCount,
            JSON.stringify(row.agents),
            JSON.stringify(row.workspaces),
            row.async ? 1 : 0,
            row.parentCwd,
          );
        });
      });
    } catch (error) {
      this.fail(destination, "write", error);
      return;
    }
    // Same owner-only hardening as dispatch rows — best-effort after the
    // rows already landed.
    if (generation === this.generation) {
      try {
        tightenPermissions(destination);
      } catch (error) {
        report(this.diagnostics, "chmod", destination, error);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeBackend();
  }

  private backend(destination: string): DatabaseSync | undefined {
    if (this.db !== undefined) return this.db;
    try {
      this.db = withBusyRetry(() => {
        const { DatabaseSync: Database } = require("node:sqlite") as {
          DatabaseSync: new (path: string) => DatabaseSync;
        };
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        const fd = openSync(destination, "a", 0o600);
        try {
          chmodSync(destination, 0o600);
        } finally {
          closeSync(fd);
        }
        const handle = new Database(destination);
        try {
          handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
          // journal_mode = WAL needs an exclusive lock (no readers), unlike
          // BEGIN IMMEDIATE which only waits on the active writer — under
          // simultaneous first opens it is the contention point (#47). When
          // the database is already WAL a read confirms it under a shared
          // lock and the exclusive transition is skipped entirely.
          const mode = handle.prepare("PRAGMA journal_mode").get() as
            | { journal_mode?: unknown }
            | undefined;
          if (mode?.journal_mode !== "wal") {
            handle.exec("PRAGMA journal_mode = WAL");
          }
          ensureSchema(handle);
        } catch (error) {
          try {
            handle.close();
          } catch {}
          throw error;
        }
        tightenPermissions(destination);
        return handle;
      });
      return this.db;
    } catch (error) {
      this.fail(destination, "open", error);
      return undefined;
    }
  }

  private writeSpan(
    destination: string,
    callId: string,
    input: {
      readonly async: boolean;
      readonly startedAt: number;
      readonly tasks: readonly ResolvedTask[];
    },
    result: DispatchOutcome,
    ticketStatus: TicketStatus | undefined,
  ): void {
    const db = this.db;
    if (db === undefined) return;
    try {
      withBusyRetry(() => {
        transact(db, () => {
          const insertCall = db.prepare(
            `INSERT INTO calls(id, ts, version, pi_version, mode, parent_model,
               task_count, wall_ms, status, total_tokens, total_cost,
               parent_session_file, parent_cwd,
               budget_limit, budget_consumed, budget_exhausted_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          );
          const insertTask = db.prepare(
            `INSERT INTO tasks(id, call_id, ts, version, pi_version, idx,
               agent, model, thinking, tools, workspace, outcome,
               failure_kind, duration_ms, tokens, cost, tool_uses, retries,
               prompt_chars, output_chars, session_file, async,
               error_snippet, integration, provisional)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          );
          for (const outcome of result.outcomes) {
            const task = input.tasks.find(
              (candidate) => candidate.index === outcome.index,
            );
            insertTask.run(
              `${callId}:${outcome.index}`,
              callId,
              input.startedAt,
              EXTENSION_VERSION,
              PI_VERSION,
              outcome.index,
              task?.agent ?? null,
              task ? `${task.model.provider}/${task.model.id}` : null,
              task?.thinking ?? null,
              task ? JSON.stringify(task.tools) : null,
              task?.workspace ?? null,
              outcome.status,
              null,
              null,
              outcome.usage?.totalTokens ?? null,
              outcome.usage?.cost.total ?? null,
              null,
              outcome.retries,
              null,
              null,
              null,
              input.async ? 1 : 0,
              null,
              outcome.integration?.status ?? null,
              outcome.quarantined ? 1 : 0,
            );
          }
          insertCall.run(
            callId,
            input.startedAt,
            EXTENSION_VERSION,
            PI_VERSION,
            input.async ? "async" : "sync",
            null,
            input.tasks.length,
            Date.now() - input.startedAt,
            ticketStatus !== undefined && ticketStatus !== "running"
              ? ticketStatus
              : batchStatus(result.outcomes),
            result.usage?.totalTokens ?? null,
            result.usage?.cost.total ?? null,
            null,
            null,
            result.tokenBudget?.limit ?? null,
            result.tokenBudget?.consumed ?? null,
            result.tokenBudget?.exhaustedAt ?? null,
          );
        });
      });
    } catch (error) {
      this.fail(destination, "write", error);
      return;
    }
    // Owner-only hardening is best-effort: a chmod hiccup must not disable
    // telemetry permanently when the rows already landed.
    try {
      tightenPermissions(destination);
    } catch (error) {
      report(this.diagnostics, "chmod", destination, error);
    }
  }

  private fail(destination: string, operation: string, error: unknown): void {
    report(this.diagnostics, operation, destination, error);
    this.failedDestination = destination;
    if (destination === this.destination) this.closeBackend();
  }

  private closeBackend(): void {
    const db = this.db;
    const destination = this.destination;
    this.db = undefined;
    if (db === undefined) return;
    try {
      db.close();
    } catch (error) {
      report(this.diagnostics, "close", destination ?? "unknown destination", error);
    }
  }
}

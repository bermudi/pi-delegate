import { DiagnosticSink } from "./diagnostics.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { TelemetryConfig } from "./config.ts";
import type { DispatchOutcome } from "./coordinator.ts";
import type { ResolvedTask, TaskStatus, TicketStatus } from "./types.ts";

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
const BUSY_WINDOW_MS = 500;
const BUSY_RETRY_BASE_MS = 10;
const BUSY_RETRY_MAX_MS = 50;
const MAX_PENDING_JOBS = 256;
const DRAIN_PASS_BUDGET_MS = 8;
const TELEMETRY_DB_ENV_VAR = "DELEGATE_TELEMETRY_DB";
const BUSY_WINDOW_ENV_VAR = "DELEGATE_TELEMETRY_BUSY_MS";

/**
 * The busy window bounds how long one deferred write job may keep retrying
 * a contended database before giving up loudly. It is a per-job deadline on
 * owned timers — the calling thread never waits on the lock (#142).
 * `DELEGATE_TELEMETRY_BUSY_MS` widens it where contention is expected
 * (#53: 8 simultaneous openers each doing schema work need longer than
 * the default on slow hosts).
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

/**
 * One task row's content, frozen at finish() time. Outcomes may be
 * enriched after settle (worker truth folding attribution over a
 * provisional record), so no live references may ride the queue.
 */
interface TaskRowSnapshot {
  readonly index: number;
  readonly status: TaskStatus;
  readonly totalTokens: number | null;
  readonly costTotal: number | null;
  readonly retries: number;
  readonly integrationStatus: string | null;
  readonly quarantined: boolean;
  readonly agent: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly toolsJson: string | null;
  readonly workspace: string | null;
}

interface SpanJobData {
  readonly op: "span";
  readonly callId: string;
  readonly async: boolean;
  readonly startedAt: number;
  readonly taskCount: number;
  /** Captured before any write attempt so queue backlog never inflates wall_ms. */
  readonly finishedAt: number;
  readonly status: TicketStatus;
  readonly totalTokens: number | null;
  readonly costTotal: number | null;
  readonly taskRows: readonly TaskRowSnapshot[];
}

interface MisfireJobData {
  readonly op: "misfire";
  readonly id: string;
  /** Captured at recordMisfire call time, not at drain. */
  readonly ts: number;
  readonly phase: MisfireShape["phase"];
  readonly message: string;
  readonly taskCount: number;
  readonly agentsJson: string;
  readonly workspacesJson: string;
  readonly async: boolean;
  readonly parentCwd: string;
}

/**
 * One unit of deferred telemetry work. The payload is immutable; only the
 * scheduling fields (nextAttemptAt, backoffMs) move as retries elapse.
 */
interface WriteJob {
  readonly destination: string;
  readonly generation: number;
  /** Enqueue time + busy window: past it a busy error is final, not retried. */
  readonly deadline: number;
  nextAttemptAt: number;
  backoffMs: number;
  readonly data: SpanJobData | MisfireJobData;
}

type AttemptOutcome = "done" | "busy" | "failed";

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

function transact(db: DatabaseSync, fn: () => void): void {
  // Outside the try: a failed BEGIN owns no transaction, so a ROLLBACK
  // there would be meaningless noise.
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      // The rollback failure must surface too — attach it to the primary
      // error already propagating rather than swallowing it.
      if (error instanceof Error && error.cause === undefined) {
        error.cause = rollbackError;
      } else {
        throw new AggregateError(
          [error, rollbackError],
          "transaction failed and rollback failed",
        );
      }
    }
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

function batchStatus(
  outcomes: readonly { readonly status: TaskStatus }[],
): TicketStatus {
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
  // The deferred-write queue: FIFO, capped, drained on owned (ref'd)
  // timers. Jobs are attempted inline only when the queue is empty, so a
  // contended database never stalls the calling thread — a busy attempt
  // defers instead of sleeping (#142).
  private pendingJobs: WriteJob[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private overflowWarned = false;

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
    this.selectDestination(destination);
    // Deliberately no open attempt: the dispatch path must not even touch
    // the database. The backend opens lazily inside the first job's write
    // attempt, where a failure defers instead of stalling preparation.
    if (
      destination === undefined ||
      this.closed ||
      destination === this.failedDestination
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
          destination === this.failedDestination
        ) {
          return;
        }
        // Wall time ends at settle — a queued writer's backlog must never
        // inflate the recorded duration.
        const finishedAt = Date.now();
        this.submit(destination, this.spanData(
          callId, input, result, ticketStatus, finishedAt,
        ));
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
    this.selectDestination(destination);
    if (this.closed || destination === this.failedDestination) {
      return;
    }
    this.submit(destination, {
      op: "misfire",
      id: randomUUID(),
      ts: Date.now(),
      phase: row.phase,
      message: row.message,
      taskCount: row.taskCount,
      agentsJson: JSON.stringify(row.agents),
      workspacesJson: JSON.stringify(row.workspaces),
      async: row.async,
      parentCwd: row.parentCwd,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Pending jobs are never dropped at close: a child that finished a
    // dispatch under contention has a queued write the busy-window policy
    // promised to persist. The drain keeps its timers and writes each job
    // out to its own deadline; only an already-empty queue closes the
    // backend now. close() itself stays non-blocking.
    if (this.pendingJobs.length === 0) this.closeBackend();
  }

  /**
   * One destination-selection rule for both entry points: on a change the
   * live backend closes, the failed latch resets, and the generation bumps
   * so in-flight spans and queued jobs pinned to the old destination are
   * dropped rather than written to it.
   */
  private selectDestination(destination: string | undefined): void {
    // A closed store never retargets: a generation bump here would orphan
    // the pending jobs close() promised to drain to their deadlines.
    if (this.closed || destination === this.destination) return;
    this.closeBackend();
    this.destination = destination;
    this.failedDestination = undefined;
    this.generation += 1;
  }

  /**
   * The fast path attempts once inline — settled dispatches keep their
   * "rows durable before settle is visible" property on an uncontended
   * database. A busy attempt defers onto the queue's timers; anything
   * behind a non-empty queue simply joins the tail (FIFO, no jumping).
   */
  private submit(
    destination: string,
    data: SpanJobData | MisfireJobData,
  ): void {
    const job: WriteJob = {
      destination,
      generation: this.generation,
      deadline: Date.now() + busyWindowMs(),
      nextAttemptAt: 0,
      backoffMs: BUSY_RETRY_BASE_MS,
      data,
    };
    if (this.pendingJobs.length === 0 && this.attempt(job) !== "busy") {
      return;
    }
    this.enqueue(job);
  }

  private enqueue(job: WriteJob): void {
    if (this.pendingJobs.length >= MAX_PENDING_JOBS) {
      // Bounded loss, said once per overflow stretch — the flag clears
      // when the queue drains below the cap.
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.diagnostics.log("warn", "telemetry write queue overflow", {
          count: this.pendingJobs.length,
          path: job.destination,
        });
      }
      return;
    }
    this.pendingJobs.push(job);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== undefined || this.pendingJobs.length === 0) {
      return;
    }
    const delay = Math.max(
      0,
      this.pendingJobs[0]!.nextAttemptAt - Date.now(),
    );
    // Deliberately ref'd: a dispatched child may dispose the session and
    // exit while writes are still deferred — pending rows must keep the
    // process alive until they land or their deadlines pass, or the
    // exactly-once persistence contract loses them.
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drain();
    }, delay);
  }

  /**
   * Head-of-line order only: the head job is attempted when due; a busy
   * outcome halts the pass behind it (never reordered), successes shift
   * and continue until the pass budget runs out. Stale-generation and
   * failed-destination jobs are dropped with one counted diagnostic per
   * pass. An emptied queue closes the backend when the store is closed.
   */
  private drain(): void {
    const passEnds = Date.now() + DRAIN_PASS_BUDGET_MS;
    let dropped = 0;
    let lastDroppedDestination: string | undefined;
    for (;;) {
      const head = this.pendingJobs[0];
      if (head === undefined) break;
      if (
        head.destination !== this.destination ||
        head.generation !== this.generation ||
        head.destination === this.failedDestination
      ) {
        this.pendingJobs.shift();
        dropped += 1;
        lastDroppedDestination = head.destination;
        continue;
      }
      if (Date.now() < head.nextAttemptAt) break;
      if (this.attempt(head) === "busy") break;
      this.pendingJobs.shift();
      if (Date.now() >= passEnds) break;
    }
    if (dropped > 0) {
      this.diagnostics.log("warn", "telemetry writes dropped (obsolete destination)", {
        count: dropped,
        ...(lastDroppedDestination === undefined
          ? {}
          : { path: lastDroppedDestination }),
      });
    }
    if (this.pendingJobs.length < MAX_PENDING_JOBS) {
      this.overflowWarned = false;
    }
    if (this.pendingJobs.length > 0) {
      this.scheduleDrain();
    } else if (this.closed) {
      this.closeBackend();
    }
  }

  /**
   * One write attempt: ensure the backend (lazy open), transact the job's
   * rows, then the best-effort post-write chmod. A busy error inside the
   * job's deadline arms the next timer retry; anything else — or a busy
   * error past the deadline — reports and latches the destination failed.
   */
  private attempt(job: WriteJob): AttemptOutcome {
    let operation = "open";
    try {
      const db = this.ensureBackend(job.destination);
      operation = "write";
      this.writeJob(db, job.data);
    } catch (error) {
      if (isBusy(error) && Date.now() < job.deadline) {
        job.nextAttemptAt = Date.now() + job.backoffMs;
        job.backoffMs = Math.min(job.backoffMs * 2, BUSY_RETRY_MAX_MS);
        return "busy";
      }
      this.fail(job.destination, operation, error);
      return "failed";
    }
    // Owner-only hardening is best-effort: a chmod hiccup must not disable
    // telemetry permanently when the rows already landed.
    try {
      tightenPermissions(job.destination);
    } catch (error) {
      report(this.diagnostics, "chmod", job.destination, error);
    }
    return "done";
  }

  private writeJob(db: DatabaseSync, data: SpanJobData | MisfireJobData): void {
    if (data.op === "misfire") {
      transact(db, () => {
        db.prepare(
          `INSERT INTO misfires(id, ts, version, pi_version, phase,
             message, task_count, agents, workspaces, async, parent_cwd)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          data.id,
          data.ts,
          EXTENSION_VERSION,
          PI_VERSION,
          data.phase,
          data.message,
          data.taskCount,
          data.agentsJson,
          data.workspacesJson,
          data.async ? 1 : 0,
          data.parentCwd,
        );
      });
      return;
    }
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
      for (const row of data.taskRows) {
        insertTask.run(
          `${data.callId}:${row.index}`,
          data.callId,
          data.startedAt,
          EXTENSION_VERSION,
          PI_VERSION,
          row.index,
          row.agent,
          row.model,
          row.thinking,
          row.toolsJson,
          row.workspace,
          row.status,
          null,
          null,
          row.totalTokens,
          row.costTotal,
          null,
          row.retries,
          null,
          null,
          null,
          data.async ? 1 : 0,
          null,
          row.integrationStatus,
          row.quarantined ? 1 : 0,
        );
      }
      insertCall.run(
        data.callId,
        data.startedAt,
        EXTENSION_VERSION,
        PI_VERSION,
        data.async ? "async" : "sync",
        null,
        data.taskCount,
        data.finishedAt - data.startedAt,
        data.status,
        data.totalTokens,
        data.costTotal,
        null,
        null,
        null,
        null,
        null,
      );
    });
  }

  /**
   * Freeze everything the rows need at finish() time: per-outcome status/
   * usage/retries/integration/quarantine, batch usage totals, the settled
   * ticket status, and per-task agent/model/thinking/tools/workspace.
   * Outcomes are enriched after settle, so no live references may ride
   * the queue.
   */
  private spanData(
    callId: string,
    input: {
      readonly async: boolean;
      readonly startedAt: number;
      readonly tasks: readonly ResolvedTask[];
    },
    result: DispatchOutcome,
    ticketStatus: TicketStatus | undefined,
    finishedAt: number,
  ): SpanJobData {
    const taskRows = result.outcomes.map((outcome): TaskRowSnapshot => {
      const task = input.tasks.find(
        (candidate) => candidate.index === outcome.index,
      );
      return {
        index: outcome.index,
        status: outcome.status,
        totalTokens: outcome.usage?.totalTokens ?? null,
        costTotal: outcome.usage?.cost.total ?? null,
        retries: outcome.retries,
        integrationStatus: outcome.integration?.status ?? null,
        quarantined: outcome.quarantined === true,
        agent: task?.agent ?? null,
        model: task ? `${task.model.provider}/${task.model.id}` : null,
        thinking: task?.thinking ?? null,
        toolsJson: task ? JSON.stringify(task.tools) : null,
        workspace: task?.workspace ?? null,
      };
    });
    return {
      op: "span",
      callId,
      async: input.async,
      startedAt: input.startedAt,
      taskCount: input.tasks.length,
      finishedAt,
      status:
        ticketStatus !== undefined && ticketStatus !== "running"
          ? ticketStatus
          : batchStatus(taskRows),
      totalTokens: result.usage?.totalTokens ?? null,
      costTotal: result.usage?.cost.total ?? null,
      taskRows,
    };
  }

  /**
   * Open the destination lazily — same sequence the eager opener used,
   * minus the synchronous busy retry: mkdir, owner-only create+chmod, the
   * DatabaseSync handle, `busy_timeout = 0` (the caller thread never waits
   * on the lock — contention defers to the queue), the WAL transition
   * when needed, schema ensure, and sidecar permission tightening.
   */
  private ensureBackend(destination: string): DatabaseSync {
    const existing = this.db;
    if (existing !== undefined) return existing;
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
      handle.exec("PRAGMA busy_timeout = 0");
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
    this.db = handle;
    return handle;
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

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { getTelemetryConfig } from "./config.ts";
import type {
  ResolvedTask,
  TaskProgress,
  TaskResult,
  WorkspaceMode,
} from "./types.ts";

export interface CallRecord {
  id: string;
  ts: number;
  version: string | undefined;
  pi_version: string | undefined;
  mode: string;
  parent_model: string | undefined;
  task_count: number;
  wall_ms: number;
  status: string;
  total_tokens: number;
  total_cost: number;
  parent_session_file: string | undefined;
}

export interface TaskRecord {
  id: string;
  call_id: string;
  ts: number;
  version: string | undefined;
  pi_version: string | undefined;
  idx: number;
  agent: string;
  model: string | undefined;
  thinking: string | undefined;
  tools: string;
  workspace: WorkspaceMode | undefined;
  outcome: string;
  failure_kind: string | undefined;
  duration_ms: number;
  tokens: number;
  cost: number;
  tool_uses: number;
  retries: number;
  prompt_chars: number;
  output_chars: number;
  session_file: string | undefined;
  async: number;
}

export interface TelemetryRecorder {
  recordCall(record: CallRecord): void;
  recordTask(record: TaskRecord): void;
}

let DatabaseSyncCtor: typeof DatabaseSync | undefined;

try {
  const req = createRequire(import.meta.url);
  const sqlite = req("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
  DatabaseSyncCtor = sqlite.DatabaseSync;
} catch {
  DatabaseSyncCtor = undefined;
}

interface TelemetryBackend {
  recordCall(record: CallRecord): void;
  recordTask(record: TaskRecord): void;
  close(): void;
}

/** One backend follows the live config. A call captures its config, but if the
 * path changes before a later row is written that row is deliberately dropped
 * rather than retaining/reopening a stale database. Telemetry is best-effort;
 * this small policy avoids a generation-keyed resource manager. */
let activeBackend: TelemetryBackend | undefined;
let activeBackendIdentity: string | undefined;
/** Prevent repeated open/write logs for the current live config. Reset when
 * the config identity changes. */
let failedBackendIdentity: string | undefined;

/** Monotonic runtime identity. A late worker from a previous runtime may not
 * write into the next runtime's backend after a bounded shutdown drain. */
let telemetryGeneration = 0;
/** A closed runtime must not lazily reopen SQLite for stale work that is still
 * unwinding. The next extension registration explicitly reopens the lifecycle. */
let telemetryClosed = false;
let testingRecorder: TelemetryRecorder | undefined;

const TELEMETRY_SCHEMA_VERSION = 2;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

function defaultDbPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "delegate-usage.db");
}

/**
 * Telemetry database path resolution: explicit config wins, then the
 * DELEGATE_TELEMETRY_DB environment variable, then the default user path.
 * The env var exists so test runs can redirect the default destination away
 * from the production database without touching user config — the pi test
 * harness builds real sessions in-process, so process.env is the extension's
 * environment (see test-preload.ts). Config beats env on purpose: telemetry
 * tests drive backends through explicit config dbPath values, including
 * spawned Node children that inherit this variable.
 */
function resolveTelemetryDbPath(
  config: import("./config.ts").TelemetryConfig,
): string {
  if (config.dbPath) return config.dbPath;
  const fromEnv = process.env.DELEGATE_TELEMETRY_DB;
  if (fromEnv) return fromEnv;
  return defaultDbPath();
}

function findPackageJson(startFile: string): string | undefined {
  const candidates = [
    path.join(path.dirname(startFile), "package.json"),
    path.join(path.dirname(startFile), "..", "package.json"),
    path.join(process.cwd(), "package.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readPackageVersion(packageJsonPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
      ? (parsed as { version: string }).version
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveDelegatePackageJson(): string | undefined {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return findPackageJson(thisFile);
  } catch {
    return findPackageJson(process.cwd());
  }
}

let delegateVersion: string | undefined;
let piVersion: string | undefined;

function getDelegateVersion(): string | undefined {
  if (delegateVersion === undefined) {
    const packageJson = resolveDelegatePackageJson();
    delegateVersion = packageJson ? readPackageVersion(packageJson) : undefined;
  }
  return delegateVersion;
}

function getPiVersion(): string | undefined {
  if (piVersion === undefined) {
    const candidate = (piCodingAgent as Record<string, unknown>).VERSION;
    piVersion =
      typeof candidate === "string" && candidate.length > 0
        ? candidate
        : undefined;
  }
  return piVersion;
}

type TelemetryColumn = readonly [name: string, definition: string];
type TelemetryTable = {
  name: "calls" | "tasks";
  columns: readonly TelemetryColumn[];
  createSql: string;
};

const TELEMETRY_TABLES: readonly TelemetryTable[] = [
  {
    name: "calls",
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
    ],
    createSql: `
      CREATE TABLE IF NOT EXISTS calls(
        id TEXT PRIMARY KEY,
        ts INTEGER,
        version TEXT,
        pi_version TEXT,
        mode TEXT,
        parent_model TEXT,
        task_count INTEGER,
        wall_ms INTEGER,
        status TEXT,
        total_tokens INTEGER,
        total_cost REAL,
        parent_session_file TEXT
      );
    `,
  },
  {
    name: "tasks",
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
    ],
    createSql: `
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY,
        call_id TEXT,
        ts INTEGER,
        version TEXT,
        pi_version TEXT,
        idx INTEGER,
        agent TEXT,
        model TEXT,
        thinking TEXT,
        tools TEXT,
        workspace TEXT,
        outcome TEXT,
        failure_kind TEXT,
        duration_ms INTEGER,
        tokens INTEGER,
        cost REAL,
        tool_uses INTEGER,
        retries INTEGER,
        prompt_chars INTEGER,
        output_chars INTEGER,
        session_file TEXT,
        async INTEGER
      );
    `,
  },
];

function existingTableType(
  db: DatabaseSync,
  tableName: TelemetryTable["name"],
): string | undefined {
  const row = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get(tableName) as { type?: unknown } | undefined;
  return typeof row?.type === "string" ? row.type : undefined;
}

function existingTableColumns(
  db: DatabaseSync,
  tableName: TelemetryTable["name"],
): Set<string> {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as unknown as Array<{ name?: unknown }>;
  return new Set(
    rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

/**
 * Create or repair the small telemetry schema as one transaction. The version
 * marker is deliberately written last: an interrupted migration must leave a
 * version-0 database that can be retried, not a version-1 database whose
 * tables are only half present. Existing version-1 databases still pass
 * through the same ensure/repair path so a process killed during an older
 * migration can recover missing tables or columns.
 */
function initSchema(db: DatabaseSync): void {
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;

    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    const currentVersion = row?.user_version ?? 0;
    if (currentVersion > TELEMETRY_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported telemetry schema version ${currentVersion}; expected at most ${TELEMETRY_SCHEMA_VERSION}`,
      );
    }

    for (const table of TELEMETRY_TABLES) {
      const type = existingTableType(db, table.name);
      if (type !== undefined && type !== "table") {
        throw new Error(
          `Telemetry object ${table.name} is ${type}, not a table`,
        );
      }
      db.exec(table.createSql);

      const columns = existingTableColumns(db, table.name);
      for (const [name, definition] of table.columns) {
        if (columns.has(name)) continue;
        if (name === "id") {
          throw new Error(
            `Telemetry table ${table.name} is missing its id column`,
          );
        }
        db.exec(`ALTER TABLE ${table.name} ADD COLUMN ${name} ${definition}`);
      }
    }

    // Backfill legacy rows that predate the workspace column. New rows store
    // 'shared' explicitly, but ALTER TABLE leaves existing rows as NULL. Without
    // this, GROUP BY workspace splits NULL vs 'shared' for the same semantics.
    // Reviewer defaults to scratch, so preserve that heuristic for historical
    // rows; everything else was shared by default. This is idempotent and runs
    // inside the same transaction as the schema changes so a crash before COMMIT
    // retries cleanly.
    try {
      db.exec(
        "UPDATE tasks SET workspace='scratch' WHERE workspace IS NULL AND agent='reviewer'",
      );
      db.exec("UPDATE tasks SET workspace='shared' WHERE workspace IS NULL");
    } catch {
      // tasks may not exist on first run (fresh DB) or workspace column may
      // have just been created via CREATE TABLE — UPDATE affecting 0 rows is fine.
      // Any real error will surface on the next write and disable telemetry
      // via the existing fail-open path, so swallowing here preserves the
      // repair-loop's best-effort nature.
    }

    // Set the marker only after every table/column operation succeeded.
    db.exec(`PRAGMA user_version = ${TELEMETRY_SCHEMA_VERSION}`);
    db.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "[delegate] telemetry schema rollback failed",
          rollbackError,
        );
      }
    }
    throw error;
  }
}

class SqliteTelemetryBackend implements TelemetryBackend {
  private db: DatabaseSync;
  private insertCall: StatementSync;
  private insertTask: StatementSync;
  private readonly onFailure: (operation: string, error: unknown) => void;

  constructor(
    db: DatabaseSync,
    onFailure: (operation: string, error: unknown) => void,
  ) {
    this.db = db;
    this.onFailure = onFailure;
    this.insertCall = db.prepare(
      `INSERT OR REPLACE INTO calls(
        id, ts, version, pi_version, mode, parent_model, task_count,
        wall_ms, status, total_tokens, total_cost, parent_session_file
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertTask = db.prepare(
      `INSERT OR REPLACE INTO tasks(
        id, call_id, ts, version, pi_version, idx, agent, model, thinking,
        tools, workspace, outcome, failure_kind, duration_ms, tokens, cost, tool_uses,
        retries, prompt_chars, output_chars, session_file, async
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  recordCall(record: CallRecord): void {
    try {
      this.insertCall.run(
        record.id,
        record.ts,
        record.version ?? null,
        record.pi_version ?? null,
        record.mode,
        record.parent_model ?? null,
        record.task_count,
        record.wall_ms,
        record.status,
        record.total_tokens,
        record.total_cost,
        record.parent_session_file ?? null,
      );
    } catch (error) {
      this.onFailure("recordCall", error);
    }
  }

  recordTask(record: TaskRecord): void {
    try {
      this.insertTask.run(
        record.id,
        record.call_id,
        record.ts,
        record.version ?? null,
        record.pi_version ?? null,
        record.idx,
        record.agent,
        record.model ?? null,
        record.thinking ?? null,
        record.tools,
        record.workspace ?? null,
        record.outcome,
        record.failure_kind ?? null,
        record.duration_ms,
        record.tokens,
        record.cost,
        record.tool_uses,
        record.retries,
        record.prompt_chars,
        record.output_chars,
        record.session_file ?? null,
        record.async,
      );
    } catch (error) {
      this.onFailure("recordTask", error);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      console.error("[delegate] telemetry database close failed", error);
    }
  }
}

class RecorderBackend implements TelemetryBackend {
  private readonly recorder: TelemetryRecorder;
  private readonly onFailure: (operation: string, error: unknown) => void;

  constructor(
    recorder: TelemetryRecorder,
    onFailure: (operation: string, error: unknown) => void,
  ) {
    this.recorder = recorder;
    this.onFailure = onFailure;
  }

  recordCall(record: CallRecord): void {
    try {
      this.recorder.recordCall(record);
    } catch (error) {
      this.onFailure("recordCall", error);
    }
  }

  recordTask(record: TaskRecord): void {
    try {
      this.recorder.recordTask(record);
    } catch (error) {
      this.onFailure("recordTask", error);
    }
  }

  close(): void {}
}

function backendIdentity(
  config: import("./config.ts").TelemetryConfig,
): string | undefined {
  if (config.enabled === false) return undefined;
  return resolveTelemetryDbPath(config);
}

function disableActiveBackend(
  identity: string,
  operation: string,
  error: unknown,
): void {
  if (activeBackendIdentity !== identity) return;
  const failedBackend = activeBackend;
  activeBackend = undefined;
  activeBackendIdentity = undefined;
  failedBackendIdentity = identity;
  try {
    failedBackend?.close();
  } catch (closeError) {
    console.error("[delegate] telemetry backend close failed", closeError);
  }
  console.error(
    `[delegate] telemetry ${operation} failed; disabling telemetry until its config changes`,
    error,
  );
}

function closeTelemetryBackend(): void {
  try {
    activeBackend?.close();
  } catch (error) {
    console.error("[delegate] telemetry backend close failed", error);
  }
  activeBackend = undefined;
  activeBackendIdentity = undefined;
  failedBackendIdentity = undefined;
}

function openSqliteBackend(
  config: import("./config.ts").TelemetryConfig,
  onFailure: (operation: string, error: unknown) => void,
): TelemetryBackend | undefined {
  if (config.enabled === false || telemetryClosed) return undefined;
  if (!DatabaseSyncCtor) return undefined;

  const dbPath = resolveTelemetryDbPath(config);
  let db: DatabaseSync | undefined;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSyncCtor(dbPath, {
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    // Set the timeout before any operation that can contend with another
    // process. The constructor option covers the initial open; this pragma
    // also makes the configured value observable and explicit.
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    db.exec("PRAGMA journal_mode = WAL;");
    initSchema(db);
    return new SqliteTelemetryBackend(db, onFailure);
  } catch (error) {
    try {
      db?.close();
    } catch (closeError) {
      console.error("[delegate] telemetry database close failed", closeError);
    }
    console.error("[delegate] telemetry database failed to open", error);
    return undefined;
  }
}

function getBackendForConfig(
  generation: number,
  config: import("./config.ts").TelemetryConfig,
): TelemetryBackend | undefined {
  if (telemetryClosed) return undefined;
  if (generation !== telemetryGeneration) return undefined;
  const capturedIdentity = backendIdentity(config);
  const liveConfig = getTelemetryConfig();
  const liveIdentity = backendIdentity(liveConfig);

  // A hot reload changed the destination. Drop every old-identity span's
  // remaining rows, including concurrent spans, and release the one live
  // handle; the next call opens the new destination. Telemetry is best-effort,
  // so retaining/refcounting obsolete backends is deliberately out of scope.
  if (capturedIdentity !== liveIdentity) {
    if (activeBackend && activeBackendIdentity !== liveIdentity) {
      closeTelemetryBackend();
    } else if (failedBackendIdentity !== liveIdentity) {
      failedBackendIdentity = undefined;
    }
    return undefined;
  }
  if (liveIdentity === undefined) {
    if (activeBackend || failedBackendIdentity) closeTelemetryBackend();
    return undefined;
  }

  if (activeBackend && activeBackendIdentity !== liveIdentity) {
    closeTelemetryBackend();
  }
  if (failedBackendIdentity !== liveIdentity) failedBackendIdentity = undefined;
  if (failedBackendIdentity === liveIdentity) return undefined;
  if (activeBackend) return activeBackend;

  activeBackendIdentity = liveIdentity;
  activeBackend = testingRecorder
    ? new RecorderBackend(testingRecorder, (operation, error) =>
        disableActiveBackend(liveIdentity, operation, error),
      )
    : openSqliteBackend(liveConfig, (operation, error) =>
        disableActiveBackend(liveIdentity, operation, error),
      );
  if (!activeBackend) {
    // This includes Bun's intentional no-node:sqlite path. No log is needed
    // there; real SQLite open failures were already logged at the boundary.
    activeBackendIdentity = undefined;
    failedBackendIdentity = liveIdentity;
  }
  return activeBackend;
}

/** Legacy unpinned backend lookup: uses the *live* telemetry config. Callers
 *  that need a stable backend for the lifetime of a span/task should use
 *  `getBackendForConfig` with the config captured at creation. */
function getBackend(generation?: number): TelemetryBackend | undefined {
  if (telemetryClosed) return undefined;
  return getBackendForConfig(
    generation ?? telemetryGeneration,
    getTelemetryConfig(),
  );
}

export interface CallSpanInput {
  parentModel?: string;
  mode: string;
  taskCount: number;
  parentSessionFile?: string;
}

export interface CallSpanFinish {
  status: string;
  totalTokens: number;
  totalCost: number;
  wallMs: number;
}

export interface CallSpan {
  readonly id: string;
  readonly startedAt: number;
  /** Runtime generation captured at call creation; stale calls cannot write. */
  readonly generation: number;
  /** Telemetry config captured at call creation; binds the span to one backend. */
  readonly telemetryConfig: import("./config.ts").TelemetryConfig;
  /** Snapshot of the call row as it would be written at spawn. */
  baseRecord(): CallRecord;
  spawn(): void;
  finish(finish: CallSpanFinish): void;
}

class CallSpanImpl implements CallSpan {
  readonly id: string;
  readonly startedAt: number;
  readonly generation = telemetryGeneration;
  readonly telemetryConfig = getTelemetryConfig();
  private readonly input: CallSpanInput;
  private finished = false;

  constructor(input: CallSpanInput) {
    this.id = crypto.randomUUID();
    this.startedAt = Date.now();
    this.input = input;
  }

  baseRecord(): CallRecord {
    return {
      id: this.id,
      ts: this.startedAt,
      version: getDelegateVersion(),
      pi_version: getPiVersion(),
      mode: this.input.mode,
      parent_model: this.input.parentModel,
      task_count: this.input.taskCount,
      wall_ms: 0,
      status: "running",
      total_tokens: 0,
      total_cost: 0,
      parent_session_file: this.input.parentSessionFile,
    };
  }

  spawn(): void {
    const b = getBackendForConfig(this.generation, this.telemetryConfig);
    if (!b) return;
    b.recordCall(this.baseRecord());
  }

  finish(finish: CallSpanFinish): void {
    if (this.finished) return;
    this.finished = true;
    const b = getBackendForConfig(this.generation, this.telemetryConfig);
    if (!b) return;
    const record = this.baseRecord();
    record.wall_ms = finish.wallMs;
    record.status = finish.status;
    record.total_tokens = finish.totalTokens;
    record.total_cost = finish.totalCost;
    b.recordCall(record);
  }
}

export function beginCall(input: CallSpanInput): CallSpan {
  return new CallSpanImpl(input);
}

export function recordCall(
  record: CallRecord,
  generation?: number,
  config?: import("./config.ts").TelemetryConfig,
): void {
  const b = config
    ? getBackendForConfig(generation ?? telemetryGeneration, config)
    : getBackend(generation);
  if (!b) return;
  b.recordCall(record);
}

export interface TaskSpanInput {
  /** Stable identity for correction writes of the same logical task row. */
  id?: string;
  callId: string;
  /** Runtime generation captured by the dispatch that owns this task. */
  generation?: number;
  /** Telemetry config captured at dispatch; binds the task row to the same
   *  backend as the call span. */
  telemetryConfig?: import("./config.ts").TelemetryConfig;
  async: boolean;
  taskIndex: number;
  task: ResolvedTask;
  progress: TaskProgress;
  result: TaskResult;
  retries: number;
}

function outcomeFromResult(result: TaskResult): string {
  if (result.error) {
    return result.failureKind === "cancelled" ? "cancelled" : "failed";
  }
  return "success";
}

export function recordTask(input: TaskSpanInput): string | undefined {
  const b = input.telemetryConfig
    ? getBackendForConfig(
        input.generation ?? telemetryGeneration,
        input.telemetryConfig,
      )
    : getBackend(input.generation);
  if (!b) return undefined;

  const { callId, async, taskIndex, task, progress, result, retries } = input;
  const record: TaskRecord = {
    // Correction writes must reuse the provisional row's primary key. A fresh
    // UUID here would make INSERT OR REPLACE append a second task row.
    id: input.id ?? crypto.randomUUID(),
    call_id: callId,
    ts: Date.now(),
    version: getDelegateVersion(),
    pi_version: getPiVersion(),
    idx: taskIndex,
    agent: task.agentName,
    model: task.model?.id,
    thinking: task.thinking,
    tools: JSON.stringify(task.tools),
    workspace: task.workspace ?? "shared",
    outcome: outcomeFromResult(result),
    failure_kind: result.failureKind,
    duration_ms: result.durationMs,
    tokens: result.tokens,
    cost: result.usage.cost.total,
    tool_uses: progress.toolUses,
    retries,
    prompt_chars: task.prompt?.length ?? 0,
    output_chars: result.output?.length ?? 0,
    session_file: result.sessionFile,
    async: async ? 1 : 0,
  };
  b.recordTask(record);
  return record.id;
}

/** Prevent this runtime's late workers from writing after a bounded shutdown
 * drain. Invalidate the generation and close the old handle immediately: a
 * later runtime must never inherit a backend that stale workers can reach.
 * Returns false when a newer runtime already owns the lifecycle. */
export function sealTelemetryWrites(expectedGeneration?: number): boolean {
  if (
    expectedGeneration !== undefined &&
    expectedGeneration !== telemetryGeneration
  ) {
    return false;
  }
  telemetryGeneration++;
  telemetryClosed = true;
  closeTelemetryBackend();
  return true;
}

/** Close the current telemetry backend and prevent stale work from reopening
 * it after the parent runtime starts shutting down. `expectedGeneration`
 * prevents an old shutdown handler from closing a newer runtime's handle. */
export function closeTelemetry(expectedGeneration?: number): void {
  if (
    expectedGeneration !== undefined &&
    expectedGeneration !== telemetryGeneration
  ) {
    return;
  }
  telemetryClosed = true;
  closeTelemetryBackend();
}

/** Current runtime identity for lifecycle owners such as session_shutdown. */
export function getTelemetryGeneration(): number {
  return telemetryGeneration;
}

/** Mark the start of a fresh extension runtime after a reload. */
export function prepareTelemetryForSession(): void {
  if (!telemetryClosed) return;

  // A timed-out old runtime may have left its handle open. Close it before
  // advancing the generation so the old shutdown handler cannot close the new
  // runtime's backend later.
  closeTelemetryBackend();

  telemetryGeneration++;
  telemetryClosed = false;
}

export function _setTelemetryForTesting(
  recorder: TelemetryRecorder | undefined,
): void {
  closeTelemetryBackend();
  testingRecorder = recorder;
  telemetryGeneration++;
  telemetryClosed = false;
}

export function _resetTelemetryForTesting(): void {
  testingRecorder = undefined;
  closeTelemetryBackend();
  telemetryGeneration++;
  telemetryClosed = false;
}

/** @internal Test seam exposing the single live backend path, never handles. */
export function _getTelemetryBackendPathsForTesting(): string[] {
  return activeBackendIdentity === undefined ? [] : [activeBackendIdentity];
}

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { getTelemetryConfig } from "./config.ts";
import type { ResolvedTask, TaskProgress, TaskResult } from "./types.ts";

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

/** Active telemetry backends keyed by their (generation, config) pair. Call
 *  spans and task rows are bound to the backend that was live when they
 *  started, so a hot-reloaded `enabled`/`dbPath` change cannot split one
 *  logical call across databases. A backend is retained only while it is the
 *  live config or a span is still bound to it. The cache also isolates
 *  failures per config: a bad `dbPath` is marked failed under its own key and
 *  does not block a different path from opening. */
const backendCache = new Map<string, TelemetryBackend | undefined>();
/** Number of unfinished call spans bound to each backend cache key. */
const backendBindings = new Map<string, number>();
const testBackendKey = "test";

/** Monotonic runtime identity. A late worker from a previous runtime may not
 * write into the next runtime's backend after a bounded shutdown drain. */
let telemetryGeneration = 0;
/** A closed runtime must not lazily reopen SQLite for stale work that is still
 * unwinding. The next extension registration explicitly reopens the lifecycle. */
let telemetryClosed = false;
let testingRecorder: TelemetryRecorder | undefined;

const TELEMETRY_SCHEMA_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

function defaultDbPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "delegate-usage.db");
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
        tools, outcome, failure_kind, duration_ms, tokens, cost, tool_uses,
        retries, prompt_chars, output_chars, session_file, async
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

function cacheKey(
  generation: number,
  config: import("./config.ts").TelemetryConfig,
): string {
  return JSON.stringify([generation, config.enabled, config.dbPath]);
}

function backendKeyForConfig(
  generation: number,
  config: import("./config.ts").TelemetryConfig,
): string | undefined {
  if (config.enabled === false) return undefined;
  return testingRecorder ? testBackendKey : cacheKey(generation, config);
}

/** Close and forget backends that no active span needs. Any key in
 * `preserveKeys` stays open for cheap subsequent writes (and keeps its
 * failure sentinel intact); pass the live-config key so a finishing stale
 * span cannot evict the backend the next write needs.
 */
function evictUnusedBackends(...preserveKeys: (string | undefined)[]): void {
  const preserve = new Set(
    preserveKeys.filter((k): k is string => k !== undefined),
  );
  for (const [key, backend] of backendCache) {
    if (preserve.has(key) || (backendBindings.get(key) ?? 0) > 0) continue;
    try {
      backend?.close();
    } catch (error) {
      console.error("[delegate] telemetry backend close failed", error);
    }
    backendCache.delete(key);
    backendBindings.delete(key);
  }
}

function retainBackendBinding(
  generation: number,
  config: import("./config.ts").TelemetryConfig,
): string | undefined {
  if (telemetryClosed || generation !== telemetryGeneration) return undefined;
  const key = backendKeyForConfig(generation, config);
  if (key !== undefined) {
    backendBindings.set(key, (backendBindings.get(key) ?? 0) + 1);
  }
  evictUnusedBackends(key);
  return key;
}

function releaseBackendBinding(key: string | undefined): void {
  if (key !== undefined) {
    const remaining = (backendBindings.get(key) ?? 1) - 1;
    if (remaining > 0) backendBindings.set(key, remaining);
    else backendBindings.delete(key);
  }
  const config = getTelemetryConfig();
  evictUnusedBackends(
    telemetryClosed
      ? undefined
      : backendKeyForConfig(telemetryGeneration, config),
  );
}

function disableBackendForKey(
  key: string,
  operation: string,
  error: unknown,
): void {
  const failedBackend = backendCache.get(key);
  // Mark this (generation, config) as failed so subsequent writes for the
  // same span do not reopen a broken backend on every call.
  backendCache.set(key, undefined);
  try {
    failedBackend?.close();
  } catch (closeError) {
    console.error("[delegate] telemetry backend close failed", closeError);
  }
  console.error(
    `[delegate] telemetry ${operation} failed; disabling telemetry for this config`,
    error,
  );
}

function closeAllBackends(): void {
  for (const entry of backendCache.values()) {
    if (entry === undefined) continue;
    try {
      entry.close();
    } catch (error) {
      console.error("[delegate] telemetry backend close failed", error);
    }
  }
  backendCache.clear();
  backendBindings.clear();
}

function openSqliteBackend(
  config: import("./config.ts").TelemetryConfig,
  onFailure: (operation: string, error: unknown) => void,
): TelemetryBackend | undefined {
  if (config.enabled === false || telemetryClosed) return undefined;
  if (!DatabaseSyncCtor) return undefined;

  const dbPath = config.dbPath ?? defaultDbPath();
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
  const key = backendKeyForConfig(generation, config);
  // Preserve both the pinned (historical) key for this span AND the live-config
  // key. Without the live key, finishing an in-flight span whose config was
  // superseded mid-flight would evict the live backend (and discard its failure
  // sentinel), forcing the next write to reopen SQLite and re-fail in a loop.
  const liveKey = backendKeyForConfig(
    telemetryGeneration,
    getTelemetryConfig(),
  );
  evictUnusedBackends(key, liveKey);
  if (key === undefined) return undefined;

  if (testingRecorder) {
    const existing = backendCache.get(testBackendKey);
    if (existing) return existing;
    if (existing === undefined && backendCache.has(testBackendKey)) {
      return undefined;
    }
    const backend = new RecorderBackend(testingRecorder, (operation, error) =>
      disableBackendForKey(testBackendKey, operation, error),
    );
    backendCache.set(testBackendKey, backend);
    return backend;
  }

  const existing = backendCache.get(key);
  if (existing) return existing;
  if (existing === undefined && backendCache.has(key)) {
    // This exact (generation, config) pair already failed to open; do not
    // retry and spam logs every task write.
    return undefined;
  }

  const backend = openSqliteBackend(config, (operation, error) =>
    disableBackendForKey(key, operation, error),
  );
  backendCache.set(key, backend);
  return backend;
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
  private readonly backendBinding: string | undefined;
  private finished = false;

  constructor(input: CallSpanInput) {
    this.id = crypto.randomUUID();
    this.startedAt = Date.now();
    this.input = input;
    this.backendBinding = retainBackendBinding(
      this.generation,
      this.telemetryConfig,
    );
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
    try {
      const b = getBackendForConfig(this.generation, this.telemetryConfig);
      if (!b) return;
      const record = this.baseRecord();
      record.wall_ms = finish.wallMs;
      record.status = finish.status;
      record.total_tokens = finish.totalTokens;
      record.total_cost = finish.totalCost;
      b.recordCall(record);
    } finally {
      // Once the final call row is written, any task rows for this call have
      // already been recorded. A superseded database can now release its
      // SQLite handle (and its WAL sidecars) immediately.
      releaseBackendBinding(this.backendBinding);
    }
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
    return result.error === "Aborted" ? "cancelled" : "failed";
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
  closeAllBackends();
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
  closeAllBackends();
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
  closeAllBackends();

  telemetryGeneration++;
  telemetryClosed = false;
}

export function _setTelemetryForTesting(
  recorder: TelemetryRecorder | undefined,
): void {
  closeAllBackends();
  testingRecorder = recorder;
  telemetryGeneration++;
  telemetryClosed = false;
}

export function _resetTelemetryForTesting(): void {
  testingRecorder = undefined;
  closeAllBackends();
  telemetryGeneration++;
  telemetryClosed = false;
}

/** @internal Test seam for asserting hot-reload eviction without exposing
 * SQLite handles themselves. */
export function _getTelemetryBackendCacheKeysForTesting(): string[] {
  return [...backendCache.keys()];
}

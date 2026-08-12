import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
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

let backend: TelemetryBackend | undefined;
let backendFailed = false;
let testingRecorder: TelemetryRecorder | undefined;

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

function resolvePiPackageJson(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    return req.resolve("@earendil-works/pi-coding-agent/package.json");
  } catch {
    return undefined;
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
    const packageJson = resolvePiPackageJson();
    piVersion = packageJson ? readPackageVersion(packageJson) : undefined;
  }
  return piVersion;
}

function initSchema(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as
    { user_version?: number } | undefined;
  const currentVersion = row?.user_version ?? 0;
  if (currentVersion >= 1) return;

  db.exec(`
    PRAGMA user_version = 1;

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
  `);
}

class SqliteTelemetryBackend implements TelemetryBackend {
  private db: DatabaseSync;
  private insertCall: StatementSync;
  private insertTask: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
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
      console.error("[delegate] telemetry recordCall failed", error);
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
      console.error("[delegate] telemetry recordTask failed", error);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // close is best-effort
    }
  }
}

class RecorderBackend implements TelemetryBackend {
  constructor(private recorder: TelemetryRecorder) {}

  recordCall(record: CallRecord): void {
    try {
      this.recorder.recordCall(record);
    } catch (error) {
      console.error("[delegate] telemetry recorder recordCall failed", error);
    }
  }

  recordTask(record: TaskRecord): void {
    try {
      this.recorder.recordTask(record);
    } catch (error) {
      console.error("[delegate] telemetry recorder recordTask failed", error);
    }
  }

  close(): void {}
}

function openBackend(): TelemetryBackend | undefined {
  const config = getTelemetryConfig();
  if (config.enabled === false) return undefined;
  if (testingRecorder) {
    return new RecorderBackend(testingRecorder);
  }
  if (backendFailed) return undefined;
  if (!DatabaseSyncCtor) {
    backendFailed = true;
    return undefined;
  }

  const dbPath = config.dbPath ?? defaultDbPath();
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSyncCtor(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    initSchema(db);
    return new SqliteTelemetryBackend(db);
  } catch (error) {
    backendFailed = true;
    console.error("[delegate] telemetry database failed to open", error);
    return undefined;
  }
}

function getBackend(): TelemetryBackend | undefined {
  if (backend) return backend;
  backend = openBackend();
  return backend;
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
  /** Snapshot of the call row as it would be written at spawn. */
  baseRecord(): CallRecord;
  spawn(): void;
  finish(finish: CallSpanFinish): void;
}

class CallSpanImpl implements CallSpan {
  readonly id: string;
  readonly startedAt: number;
  private readonly input: CallSpanInput;

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
    const b = getBackend();
    if (!b) return;
    b.recordCall(this.baseRecord());
  }

  finish(finish: CallSpanFinish): void {
    const b = getBackend();
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

export function recordCall(record: CallRecord): void {
  const b = getBackend();
  if (!b) return;
  b.recordCall(record);
}

export interface TaskSpanInput {
  callId: string;
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

export function recordTask(input: TaskSpanInput): void {
  const b = getBackend();
  if (!b) return;

  const { callId, async, taskIndex, task, progress, result, retries } = input;
  const record: TaskRecord = {
    id: crypto.randomUUID(),
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
}

export function _setTelemetryForTesting(
  recorder: TelemetryRecorder | undefined,
): void {
  testingRecorder = recorder;
  backend = undefined;
  backendFailed = false;
}

export function _resetTelemetryForTesting(): void {
  testingRecorder = undefined;
  if (backend) {
    backend.close();
    backend = undefined;
  }
  backendFailed = false;
}

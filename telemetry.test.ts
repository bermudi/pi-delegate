import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
  _setTelemetryForTesting,
  _resetTelemetryForTesting,
  beginCall,
  sealTelemetryWrites,
  recordCall,
  recordTask,
  type CallRecord,
  type TaskRecord,
  type TelemetryRecorder,
} from "./telemetry.ts";
import {
  _setDelegateConfigForTesting,
  _resetDelegateConfigForTesting,
} from "./config.ts";
import type { ResolvedTask, TaskProgress, TaskResult } from "./types.ts";

function makeRecorder(): {
  calls: CallRecord[];
  tasks: TaskRecord[];
  recorder: TelemetryRecorder;
} {
  const calls: CallRecord[] = [];
  const tasks: TaskRecord[] = [];
  return {
    calls,
    tasks,
    recorder: {
      recordCall: (r) => calls.push(r),
      recordTask: (r) => {
        const existing = tasks.findIndex((task) => task.id === r.id);
        if (existing === -1) tasks.push(r);
        else tasks[existing] = r;
      },
    },
  };
}

function loadRepoVersion(): string {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  return pkg.version as string;
}

const configModule = pathToFileURL(
  path.join(import.meta.dir, "config.ts"),
).href;
const telemetryModule = pathToFileURL(
  path.join(import.meta.dir, "telemetry.ts"),
).href;

function runNodeScript(
  source: string,
  dbPath: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PI_DELEGATE_NODE_BINARY ?? "node",
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      {
        env: { ...process.env, PI_DELEGATE_TEST_DB: dbPath },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Node telemetry worker exited with ${code}: ${stderr}`),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function telemetryWorkerSource(): string {
  return `
    import { _setDelegateConfigForTesting } from ${JSON.stringify(configModule)};
    import { _resetTelemetryForTesting, beginCall } from ${JSON.stringify(telemetryModule)};
    const dbPath = process.env.PI_DELEGATE_TEST_DB;
    if (!dbPath) throw new Error("missing test database path");
    _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath } });
    _resetTelemetryForTesting();
    const span = beginCall({ mode: "sync", taskCount: 1 });
    span.spawn();
    span.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
  `;
}

async function readNodeDatabase(dbPath: string): Promise<{
  calls: number;
  tasks: number;
  userVersion: number;
  journalMode: string;
  piVersion: string | null;
}> {
  const result = await runNodeScript(
    `
      import { DatabaseSync } from "node:sqlite";
      const dbPath = process.env.PI_DELEGATE_TEST_DB;
      const db = new DatabaseSync(dbPath);
      const one = (sql) => db.prepare(sql).get();
      console.log(JSON.stringify({
        calls: one("SELECT count(*) AS n FROM calls").n,
        tasks: one("SELECT count(*) AS n FROM tasks").n,
        userVersion: one("PRAGMA user_version").user_version,
        journalMode: one("PRAGMA journal_mode").journal_mode,
        piVersion: one("SELECT pi_version FROM calls LIMIT 1").pi_version,
      }));
      db.close();
    `,
    dbPath,
  );
  return JSON.parse(result.stdout.trim()) as {
    calls: number;
    tasks: number;
    userVersion: number;
    journalMode: string;
    piVersion: string | null;
  };
}

describe("telemetry", () => {
  beforeEach(() => {
    _resetDelegateConfigForTesting();
    _resetTelemetryForTesting();
  });
  afterEach(() => {
    _resetDelegateConfigForTesting();
    _resetTelemetryForTesting();
  });

  test("records a sync-style call spawn and finish", () => {
    const { calls, recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);

    const span = beginCall({
      parentModel: "test/parent",
      mode: "sync",
      taskCount: 2,
      parentSessionFile: "/tmp/parent.jsonl",
    });
    expect(span.id).toBeString();
    expect(span.startedAt).toBeGreaterThan(0);

    span.spawn();
    expect(calls).toHaveLength(1);
    const spawn = calls[0]!;
    expect(spawn.status).toBe("running");
    expect(spawn.wall_ms).toBe(0);
    expect(spawn.total_tokens).toBe(0);
    expect(spawn.total_cost).toBe(0);
    expect(spawn.mode).toBe("sync");
    expect(spawn.task_count).toBe(2);
    expect(spawn.parent_session_file).toBe("/tmp/parent.jsonl");

    span.finish({
      status: "success",
      totalTokens: 100,
      totalCost: 0.05,
      wallMs: 42,
    });
    expect(calls).toHaveLength(2);
    const finish = calls[1]!;
    expect(finish.status).toBe("success");
    expect(finish.total_tokens).toBe(100);
    expect(finish.total_cost).toBe(0.05);
    expect(finish.wall_ms).toBe(42);
    expect(finish.id).toBe(spawn.id);
    expect(finish.ts).toBe(spawn.ts);
    expect(finish.version).toBe(spawn.version);
    expect(finish.pi_version).toBe(spawn.pi_version);
  });

  test("finish is idempotent and preserves the first terminal row", () => {
    const { calls, recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);
    const span = beginCall({ mode: "sync", taskCount: 1 });
    span.spawn();

    span.finish({
      status: "success",
      totalTokens: 10,
      totalCost: 0.1,
      wallMs: 20,
    });
    span.finish({
      status: "failed",
      totalTokens: 999,
      totalCost: 999,
      wallMs: 999,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      status: "success",
      total_tokens: 10,
      total_cost: 0.1,
      wall_ms: 20,
    });
  });

  test("baseRecord returns the row that would be written at spawn", () => {
    const { recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);

    const span = beginCall({
      parentModel: "m",
      mode: "async",
      taskCount: 1,
    });
    const base = span.baseRecord();
    expect(base.status).toBe("running");
    expect(base.wall_ms).toBe(0);
    expect(base.mode).toBe("async");
  });

  test("recordTask captures per-task fields and outcome", () => {
    const { tasks, recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);

    const task: ResolvedTask = {
      id: "t1",
      prompt: "hello world",
      agentName: "ad-hoc",
      model: { id: "test/model" } as any,
      tools: ["read", "bash"],
      thinking: "low",
      systemPrompt: "",
      cwd: "/tmp",
      warnings: [],
    };
    const progress: TaskProgress = {
      index: 0,
      agent: "ad-hoc",
      task: "hello world",
      status: "done",
      durationMs: 10,
      tokens: 50,
      toolUses: 3,
      activities: [],
    };
    const result: TaskResult = {
      agent: "ad-hoc",
      output: "ok",
      durationMs: 10,
      tokens: 50,
      usage: {
        input: 20,
        output: 30,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 50,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.01,
        },
      },
      touchedFiles: [],
    };

    recordTask({
      id: "stable-task-row",
      callId: "call-1",
      async: false,
      taskIndex: 0,
      task,
      progress,
      result,
      retries: 2,
    });

    recordTask({
      id: "stable-task-row",
      callId: "call-1",
      async: false,
      taskIndex: 0,
      task,
      progress: {
        ...progress,
        status: "failed",
        durationMs: 20,
        tokens: 75,
        toolUses: 4,
      },
      result: {
        ...result,
        output: "updated",
        error: "failed",
        durationMs: 20,
        tokens: 75,
        usage: {
          ...result.usage,
          totalTokens: 75,
          cost: { ...result.usage.cost, total: 0.02 },
        },
      },
      retries: 3,
    });

    expect(tasks).toHaveLength(1);
    const row = tasks[0]!;
    expect(row.id).toBe("stable-task-row");
    expect(row.call_id).toBe("call-1");
    expect(row.idx).toBe(0);
    expect(row.agent).toBe("ad-hoc");
    expect(row.model).toBe("test/model");
    expect(row.thinking).toBe("low");
    expect(row.tools).toBe(JSON.stringify(["read", "bash"]));
    expect(row.tokens).toBe(75);
    expect(row.cost).toBe(0.02);
    expect(row.tool_uses).toBe(4);
    expect(row.retries).toBe(3);
    expect(row.prompt_chars).toBe(11);
    expect(row.output_chars).toBe(7);
    expect(row.async).toBe(0);
    expect(row.outcome).toBe("failed");
    expect(row.failure_kind).toBeUndefined();
  });

  test("outcome is failed for errors and cancelled for abort", () => {
    const { tasks, recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);

    function run(error?: string): TaskRecord {
      recordTask({
        callId: "call-2",
        async: true,
        taskIndex: 1,
        task: {
          id: "t2",
          prompt: "p",
          agentName: "a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          warnings: [],
        } as ResolvedTask,
        progress: {
          index: 1,
          agent: "a",
          task: "p",
          status: "failed",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        } as TaskProgress,
        result: {
          agent: "a",
          output: "",
          error,
          durationMs: 0,
          tokens: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          touchedFiles: [],
        } as TaskResult,
        retries: 0,
      });
      return tasks[tasks.length - 1]!;
    }

    expect(run("something went wrong").outcome).toBe("failed");
    expect(run("Aborted").outcome).toBe("cancelled");
    expect(run(undefined).outcome).toBe("success");
  });

  test("recordCall writes a call directly", () => {
    const { calls, recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);

    recordCall({
      id: "c1",
      ts: 1,
      version: "0.1.2",
      pi_version: "0.80.9",
      mode: "manual",
      parent_model: undefined,
      task_count: 0,
      wall_ms: 5,
      status: "success",
      total_tokens: 0,
      total_cost: 0,
      parent_session_file: undefined,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.mode).toBe("manual");
  });

  test("disabled telemetry is a no-op", () => {
    const { calls, tasks, recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);
    _setDelegateConfigForTesting({ telemetry: { enabled: false } });

    beginCall({ mode: "sync", taskCount: 1 }).finish({
      status: "success",
      totalTokens: 0,
      totalCost: 0,
      wallMs: 0,
    });
    recordTask({
      callId: "x",
      async: false,
      taskIndex: 0,
      task: {} as ResolvedTask,
      progress: {} as TaskProgress,
      result: {
        agent: "a",
        output: "",
        durationMs: 0,
        tokens: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        touchedFiles: [],
      } as TaskResult,
      retries: 0,
    });

    expect(calls).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });

  test("disables the open backend when telemetry.enabled becomes false", () => {
    const { calls, recorder } = makeRecorder();
    _setDelegateConfigForTesting({ telemetry: { enabled: true } });
    _setTelemetryForTesting(recorder);

    const span1 = beginCall({ mode: "sync", taskCount: 1 });
    span1.spawn();
    span1.finish({
      status: "success",
      totalTokens: 1,
      totalCost: 0,
      wallMs: 1,
    });
    expect(calls).toHaveLength(2);

    // Hot reload disables telemetry.
    _setDelegateConfigForTesting({ telemetry: { enabled: false } });
    const span2 = beginCall({ mode: "sync", taskCount: 1 });
    span2.spawn();
    span2.finish({
      status: "success",
      totalTokens: 1,
      totalCost: 0,
      wallMs: 1,
    });
    expect(calls).toHaveLength(2);

    // Re-enabling should reopen telemetry for the next call.
    _setDelegateConfigForTesting({ telemetry: { enabled: true } });
    const span3 = beginCall({ mode: "sync", taskCount: 1 });
    span3.spawn();
    span3.finish({
      status: "success",
      totalTokens: 1,
      totalCost: 0,
      wallMs: 1,
    });
    expect(calls).toHaveLength(4);
  });

  test("includes the installed Pi version on rows", () => {
    const { calls, recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);

    beginCall({ mode: "sync", taskCount: 1 }).spawn();
    expect(calls[0]!.pi_version).toBe(piCodingAgent.VERSION);
  });

  test(
    "Node SQLite backend records rows and repairs an incomplete v1 schema",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "delegate-telemetry-node-"),
      );
      const dbPath = path.join(dir, "usage.db");
      try {
        await runNodeScript(
          `
          import { DatabaseSync } from "node:sqlite";
          const db = new DatabaseSync(process.env.PI_DELEGATE_TEST_DB, { timeout: 5000 });
          db.exec("PRAGMA user_version = 1; CREATE TABLE calls(id TEXT PRIMARY KEY);");
          db.close();
        `,
          dbPath,
        );
        await runNodeScript(telemetryWorkerSource(), dbPath);
        await expect(readNodeDatabase(dbPath)).resolves.toEqual({
          calls: 1,
          tasks: 0,
          userVersion: 1,
          journalMode: "wal",
          piVersion: piCodingAgent.VERSION,
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    "Node SQLite backend survives simultaneous first opens",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "delegate-telemetry-race-"),
      );
      const dbPath = path.join(dir, "usage.db");
      try {
        await Promise.all(
          Array.from({ length: 8 }, () =>
            runNodeScript(telemetryWorkerSource(), dbPath),
          ),
        );
        await expect(readNodeDatabase(dbPath)).resolves.toEqual({
          calls: 8,
          tasks: 0,
          userVersion: 1,
          journalMode: "wal",
          piVersion: piCodingAgent.VERSION,
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    "Node SQLite backend rotates to a new database path when dbPath changes",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "delegate-telemetry-rotate-"),
      );
      const firstDb = path.join(dir, "first.db");
      const secondDb = path.join(dir, "second.db");
      try {
        await runNodeScript(
          `
          import { _setDelegateConfigForTesting } from ${JSON.stringify(configModule)};
          import { _resetTelemetryForTesting, beginCall } from ${JSON.stringify(telemetryModule)};
          const [firstDb, secondDb] = [${JSON.stringify(firstDb)}, ${JSON.stringify(secondDb)}];
          _resetTelemetryForTesting();
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: firstDb } });
          const span1 = beginCall({ mode: "sync", taskCount: 1 });
          span1.spawn();
          span1.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
          // Hot reload changes the database path.
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: secondDb } });
          const span2 = beginCall({ mode: "sync", taskCount: 1 });
          span2.spawn();
          span2.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
        `,
          firstDb,
        );
        const first = await readNodeDatabase(firstDb);
        const second = await readNodeDatabase(secondDb);
        expect(first.calls).toBe(1);
        expect(second.calls).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    "Node SQLite backend evicts a superseded database after its bound span finishes",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "delegate-telemetry-evict-"),
      );
      const firstDb = path.join(dir, "first.db");
      const secondDb = path.join(dir, "second.db");
      try {
        const result = await runNodeScript(
          `
          import { _setDelegateConfigForTesting } from ${JSON.stringify(configModule)};
          import {
            _resetTelemetryForTesting,
            _getTelemetryBackendCacheKeysForTesting,
            beginCall,
          } from ${JSON.stringify(telemetryModule)};
          const [firstDb, secondDb] = [${JSON.stringify(firstDb)}, ${JSON.stringify(secondDb)}];
          _resetTelemetryForTesting();
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: firstDb } });
          const first = beginCall({ mode: "sync", taskCount: 1 });
          first.spawn();
          first.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: secondDb } });
          const second = beginCall({ mode: "sync", taskCount: 1 });
          second.spawn();
          console.log(JSON.stringify(_getTelemetryBackendCacheKeysForTesting()));
          second.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
        `,
          secondDb,
        );
        const keys = JSON.parse(result.stdout.trim()) as string[];
        expect(keys).toHaveLength(1);
        expect(keys[0]).toContain(secondDb);
        expect(keys[0]).not.toContain(firstDb);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    "Node SQLite backend preserves the live-config backend when a stale span finishes",
    { timeout: 15_000 },
    async () => {
      // Bug: getBackendForConfig evicted with only the pinned (historical) key
      // as the preserve key. When an in-flight span whose config was superseded
      // mid-flight finished, it evicted the now-live backend (which had no
      // binding left after the newer span finished), forcing the next write to
      // reopen SQLite — and discarding the live backend's failure sentinel so
      // failed opens retried and logged in a loop.
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "delegate-telemetry-live-"),
      );
      const firstDb = path.join(dir, "first.db");
      const secondDb = path.join(dir, "second.db");
      try {
        const result = await runNodeScript(
          `
          import { _setDelegateConfigForTesting } from ${JSON.stringify(configModule)};
          import {
            _resetTelemetryForTesting,
            _getTelemetryBackendCacheKeysForTesting,
            beginCall,
          } from ${JSON.stringify(telemetryModule)};
          const [firstDb, secondDb] = [${JSON.stringify(firstDb)}, ${JSON.stringify(secondDb)}];
          _resetTelemetryForTesting();
          // span1 starts under config A (firstDb).
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: firstDb } });
          const span1 = beginCall({ mode: "sync", taskCount: 1 });
          span1.spawn();
          // Config switches to B (secondDb) while span1 is still in-flight.
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: secondDb } });
          // span2 starts and finishes under B — releasing B's binding but
          // keeping B cached (releaseBackendBinding preserves the live key).
          const span2 = beginCall({ mode: "sync", taskCount: 1 });
          span2.spawn();
          span2.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
          // Now finish the stale span1. Before the fix, getBackendForConfig
          // evicted B (no binding, not the pinned key A). After the fix, the
          // live-config key B is preserved alongside the pinned key A.
          span1.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
          console.log(JSON.stringify(_getTelemetryBackendCacheKeysForTesting()));
        `,
          secondDb,
        );
        const keys = JSON.parse(result.stdout.trim()) as string[];
        // The live-config backend (secondDb) must survive span1 finishing.
        // span1's own backend (firstDb) is evicted by releaseBackendBinding
        // (no binding, not live). Before the fix, keys was [].
        expect(keys).toHaveLength(1);
        expect(keys[0]).toContain(secondDb);
        expect(keys.some((k) => k.includes(firstDb))).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    "Node SQLite backend binds an in-flight span to its original database across hot reloads",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "delegate-telemetry-bind-"),
      );
      const firstDb = path.join(dir, "first.db");
      const secondDb = path.join(dir, "second.db");
      try {
        await runNodeScript(
          `
          import { _setDelegateConfigForTesting } from ${JSON.stringify(configModule)};
          import { _resetTelemetryForTesting, beginCall } from ${JSON.stringify(telemetryModule)};
          const [firstDb, secondDb] = [${JSON.stringify(firstDb)}, ${JSON.stringify(secondDb)}];
          _resetTelemetryForTesting();
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: firstDb } });
          const span1 = beginCall({ mode: "sync", taskCount: 1 });
          span1.spawn();
          // Hot reload changes the database path while span1 is still running.
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: secondDb } });
          span1.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
          // A new span after the reload writes to the new database.
          const span2 = beginCall({ mode: "sync", taskCount: 1 });
          span2.spawn();
          span2.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
        `,
          firstDb,
        );
        const first = await readNodeDatabase(firstDb);
        const second = await readNodeDatabase(secondDb);
        // spawn and finish share the same call id, so the table has one row
        // per call. The key assertion is that span1's final row did not land
        // in the second database after the hot reload.
        expect(first.calls).toBe(1);
        expect(second.calls).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    "Node SQLite backend retains a superseded binding until every in-flight span finishes",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "delegate-telemetry-multi-bind-"),
      );
      const firstDb = path.join(dir, "first.db");
      const secondDb = path.join(dir, "second.db");
      try {
        const result = await runNodeScript(
          `
          import { _setDelegateConfigForTesting } from ${JSON.stringify(configModule)};
          import {
            _resetTelemetryForTesting,
            _getTelemetryBackendCacheKeysForTesting,
            beginCall,
          } from ${JSON.stringify(telemetryModule)};
          const [firstDb, secondDb] = [${JSON.stringify(firstDb)}, ${JSON.stringify(secondDb)}];
          _resetTelemetryForTesting();
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: firstDb } });
          const old1 = beginCall({ mode: "async", taskCount: 1 });
          const old2 = beginCall({ mode: "async", taskCount: 1 });
          old1.spawn();
          old2.spawn();

          // Both old spans remain live while hot reload moves new calls to B.
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: secondDb } });
          const current = beginCall({ mode: "sync", taskCount: 1 });
          current.spawn();

          old1.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
          const keysWhileOld2Lives = _getTelemetryBackendCacheKeysForTesting();
          old2.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
          current.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
          console.log(JSON.stringify(keysWhileOld2Lives));
        `,
          secondDb,
        );
        const keys = JSON.parse(result.stdout.trim()) as string[];
        expect(keys.some((key) => key.includes(firstDb))).toBe(true);
        expect(keys.some((key) => key.includes(secondDb))).toBe(true);
        expect((await readNodeDatabase(firstDb)).calls).toBe(2);
        expect((await readNodeDatabase(secondDb)).calls).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    "Node SQLite backend recovers after an initial open failure when dbPath is corrected",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "delegate-telemetry-recover-"),
      );
      const badParent = path.join(dir, "notadir");
      fs.writeFileSync(badParent, "not a directory");
      const badDb = path.join(badParent, "test.db");
      const goodDb = path.join(dir, "good.db");
      try {
        await runNodeScript(
          `
          import { _setDelegateConfigForTesting } from ${JSON.stringify(configModule)};
          import { _resetTelemetryForTesting, beginCall } from ${JSON.stringify(telemetryModule)};
          const [badDb, goodDb] = [${JSON.stringify(badDb)}, ${JSON.stringify(goodDb)}];
          _resetTelemetryForTesting();
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: badDb } });
          const span1 = beginCall({ mode: "sync", taskCount: 1 });
          span1.spawn(); // opens nothing; the bad parent cannot be created
          // Correct the path and start a fresh span.
          _setDelegateConfigForTesting({ telemetry: { enabled: true, dbPath: goodDb } });
          const span2 = beginCall({ mode: "sync", taskCount: 1 });
          span2.spawn();
          span2.finish({ status: "success", totalTokens: 1, totalCost: 0, wallMs: 1 });
        `,
          goodDb,
        );
        const good = await readNodeDatabase(goodDb);
        expect(good.calls).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("a recorder write failure disables telemetry after the first attempt", () => {
    let attempts = 0;
    _setTelemetryForTesting({
      recordCall: () => {
        attempts += 1;
        throw new Error("test telemetry write failure");
      },
      recordTask: () => {},
    });

    const span = beginCall({ mode: "sync", taskCount: 1 });
    expect(() => span.spawn()).not.toThrow();
    expect(() =>
      span.finish({
        status: "success",
        totalTokens: 1,
        totalCost: 0,
        wallMs: 1,
      }),
    ).not.toThrow();
    expect(attempts).toBe(1);
  });

  test("stale call spans cannot write after a new runtime starts", () => {
    const old = makeRecorder();
    _setTelemetryForTesting(old.recorder);
    const oldSpan = beginCall({ mode: "async", taskCount: 1 });
    oldSpan.spawn();
    expect(old.calls).toHaveLength(1);

    sealTelemetryWrites();
    const current = makeRecorder();
    _setTelemetryForTesting(current.recorder);
    oldSpan.finish({
      status: "cancelled",
      totalTokens: 99,
      totalCost: 0.99,
      wallMs: 10,
    });
    expect(current.calls).toHaveLength(0);

    beginCall({ mode: "sync", taskCount: 0 }).spawn();
    expect(current.calls).toHaveLength(1);
  });

  test("includes delegate package version on rows", () => {
    const { calls, tasks, recorder } = makeRecorder();
    _setTelemetryForTesting(recorder);

    const span = beginCall({ mode: "sync", taskCount: 1 });
    span.spawn();
    expect(calls[0]!.version).toBe(loadRepoVersion());

    recordTask({
      callId: span.id,
      async: false,
      taskIndex: 0,
      task: {
        id: "t",
        prompt: "p",
        agentName: "a",
        model: {} as any,
        tools: [],
        thinking: "off",
        systemPrompt: "",
        cwd: "/tmp",
        warnings: [],
      } as ResolvedTask,
      progress: {
        index: 0,
        agent: "a",
        task: "p",
        status: "done",
        durationMs: 0,
        tokens: 0,
        toolUses: 0,
        activities: [],
      } as TaskProgress,
      result: {
        agent: "a",
        output: "",
        durationMs: 0,
        tokens: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        touchedFiles: [],
      } as TaskResult,
      retries: 0,
    });

    expect(tasks[0]!.version).toBe(loadRepoVersion());
  });
});

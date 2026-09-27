import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "delegate-v2-telemetry-"));
}

function rowsOf(db: DatabaseSync, table: string): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as Record<
    string,
    unknown
  >[];
}

function userVersionOf(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return row?.user_version ?? -1;
}

function journalModeOf(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA journal_mode").get() as
    | { journal_mode?: string }
    | undefined;
  return row?.journal_mode ?? "";
}

const CALLS_LEGACY_COLUMNS = [
  "version",
  "pi_version",
  "parent_model",
  "parent_session_file",
  "parent_cwd",
];

const TASKS_LEGACY_COLUMNS = [
  "version",
  "pi_version",
  "failure_kind",
  "duration_ms",
  "tool_uses",
  "prompt_chars",
  "output_chars",
  "session_file",
  "error_snippet",
];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage("OUTPUT-RELEASED");
  };
  return { release, step };
}

function gitInit(dir: string): void {
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir },
  );
}

describe("delegate telemetry contract", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];

  function trackedTempDir(): string {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    session?.dispose();
    session = undefined;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "telemetry is disabled by default and creates no database",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("DONE")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x" }],
      });

      expect(result.isError).toBe(false);
      const destination = join(session.cwd, "delegate-usage.db");
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(`${destination}-wal`)).toBe(false);
      expect(existsSync(`${destination}-shm`)).toBe(false);
    },
  );

  test(
    "explicit opt-in records one call row and one task row per task with content-free metadata",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([
        fauxAssistantMessage("OUT-ALPHA"),
        fauxAssistantMessage("OUT-BETA"),
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          { id: "corr-alpha", prompt: "first", tools: ["read"] },
          { prompt: "second" },
        ],
        operationId: "op-private-1",
      });

      expect(result.isError).toBe(false);
      const db = new DatabaseSync(dbPath);
      try {
        expect(userVersionOf(db)).toBe(5);
        const calls = rowsOf(db, "calls");
        const tasks = rowsOf(db, "tasks").sort(
          (a, b) => Number(a.idx) - Number(b.idx),
        );
        expect(calls).toHaveLength(1);
        expect(tasks).toHaveLength(2);
        expect(JSON.stringify(calls)).not.toContain("op-private-1");
        expect(JSON.stringify(tasks)).not.toContain("op-private-1");

        const call = calls[0];
        const firstTask = tasks[0];
        if (call === undefined || firstTask === undefined) {
          throw new Error("expected one call row and task rows");
        }
        expect(call.mode).toBe("sync");
        expect(call.task_count).toBe(2);
        expect(call.status).toBe("completed");
        expect(typeof call.ts).toBe("number");
        expect(call.ts as number).toBeGreaterThan(0);
        expect(typeof call.wall_ms).toBe("number");
        expect(call.wall_ms as number).toBeGreaterThanOrEqual(0);
        expect(typeof call.total_tokens).toBe("number");
        for (const column of CALLS_LEGACY_COLUMNS) {
          expect(call[column]).toBeNull();
        }

        for (const [index, task] of tasks.entries()) {
          expect(task.id).toBe(`${call.id}:${index}`);
          expect(String(task.id)).not.toContain("corr-alpha");
          expect(task.call_id).toBe(call.id);
          expect(task.ts).toBe(call.ts);
          expect(task.idx).toBe(index);
          expect(task.agent).toBe("inline");
          expect(task.model).toBe("delegate-faux/faux-1");
          expect(task.outcome).toBe("ok");
          expect(task.workspace).toBe("shared");
          expect(task.async).toBe(0);
          expect(task.provisional).toBe(0);
          expect(typeof task.retries).toBe("number");
          expect(JSON.parse(String(task.tools))).toBeInstanceOf(Array);
          for (const column of TASKS_LEGACY_COLUMNS) {
            expect(task[column]).toBeNull();
          }
        }
        expect(JSON.parse(String(firstTask.tools))).toEqual(["read"]);
      } finally {
        db.close();
      }

      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = dbPath + suffix;
        if (!existsSync(candidate)) continue;
        expect(statSync(candidate).mode & 0o077).toBe(0);
      }
    },
  );

  test(
    "telemetry.dbPath wins over DELEGATE_TELEMETRY_DB, which wins over the agent-dir default",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const configPath = join(trackedTempDir(), "config.db");
      const envPath = join(trackedTempDir(), "env.db");
      const previous = process.env.DELEGATE_TELEMETRY_DB;
      try {
        configureDelegate(session, {
          telemetry: { enabled: true, dbPath: configPath },
        });
        process.env.DELEGATE_TELEMETRY_DB = envPath;
        subagents.respond([fauxAssistantMessage("FIRST")]);
        const first = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });
        expect(first.isError).toBe(false);
        expect(existsSync(configPath)).toBe(true);
        expect(existsSync(envPath)).toBe(false);

        configureDelegate(session, { telemetry: { enabled: true } });
        subagents.respond([fauxAssistantMessage("SECOND")]);
        const second = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });
        expect(second.isError).toBe(false);
        expect(existsSync(envPath)).toBe(true);
        expect(existsSync(join(session.cwd, "delegate-usage.db"))).toBe(false);

        delete process.env.DELEGATE_TELEMETRY_DB;
        subagents.respond([fauxAssistantMessage("THIRD")]);
        const third = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });
        expect(third.isError).toBe(false);
        const defaultDb = new DatabaseSync(
          join(session.cwd, "delegate-usage.db"),
        );
        try {
          expect(rowsOf(defaultDb, "calls")).toHaveLength(1);
          expect(rowsOf(defaultDb, "tasks")).toHaveLength(1);
        } finally {
          defaultDb.close();
        }
      } finally {
        if (previous === undefined) {
          delete process.env.DELEGATE_TELEMETRY_DB;
        } else {
          process.env.DELEGATE_TELEMETRY_DB = previous;
        }
      }
    },
  );

  test(
    "an unwritable telemetry destination logs and never fails the dispatch",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const blocker = join(trackedTempDir(), "blocker");
      const dbPath = join(blocker, "usage.db");
      writeFileSync(blocker, "not a directory");
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        configureDelegate(session, {
          telemetry: { enabled: true, dbPath },
        });
        subagents.respond([fauxAssistantMessage("STILL-DONE")]);

        const result = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });

        expect(result.isError).toBe(false);
        expect(result.text).toContain("STILL-DONE");
        expect(
          errors.mock.calls.some((arguments_) =>
            String(arguments_[0]).includes("[delegate] telemetry"),
          ),
        ).toBe(true);
      } finally {
        errors.mockRestore();
      }
    },
  );

  test(
    "a corrupt telemetry database fails open and never fails the dispatch",
    async () => {
      // Fail-open pin: garbage bytes at the destination must log and disable
      // telemetry for that destination, not fail delegation. A refactor that
      // flips fail-open to fail-closed would surface here as isError true.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "corrupt.db");
      writeFileSync(dbPath, "not a sqlite database — just garbage bytes");
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        configureDelegate(session, {
          telemetry: { enabled: true, dbPath },
        });
        subagents.respond([fauxAssistantMessage("CORRUPT-OK")]);

        const result = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });

        expect(result.isError).toBe(false);
        expect(result.text).toContain("CORRUPT-OK");
        expect(
          errors.mock.calls.some((arguments_) =>
            String(arguments_[0]).includes("[delegate] telemetry"),
          ),
        ).toBe(true);
      } finally {
        errors.mockRestore();
      }
    },
  );

  test(
    "a future-schema telemetry database fails open and never fails the dispatch",
    async () => {
      // Fail-open pin: user_version beyond SCHEMA_VERSION must log and
      // disable telemetry, never migrate down or fail the call. The version
      // stays untouched so a newer writer's data is not clobbered.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "future.db");
      const seed = new DatabaseSync(dbPath);
      try {
        seed.exec("PRAGMA user_version = 999");
      } finally {
        seed.close();
      }
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        configureDelegate(session, {
          telemetry: { enabled: true, dbPath },
        });
        subagents.respond([fauxAssistantMessage("FUTURE-OK")]);

        const result = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });

        expect(result.isError).toBe(false);
        expect(result.text).toContain("FUTURE-OK");
        expect(
          errors.mock.calls.some((arguments_) =>
            String(arguments_[0]).includes("[delegate] telemetry"),
          ),
        ).toBe(true);
        const check = new DatabaseSync(dbPath);
        try {
          expect(userVersionOf(check)).toBe(999);
        } finally {
          check.close();
        }
      } finally {
        errors.mockRestore();
      }
    },
  );

  test(
    "a v1 database migrates in place preserving legacy rows and sensitive values",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "v1.db");
      const seed = new DatabaseSync(dbPath);
      seed.exec(`CREATE TABLE calls(
        id TEXT PRIMARY KEY, ts INTEGER, version TEXT, pi_version TEXT,
        mode TEXT, parent_model TEXT, task_count INTEGER, wall_ms INTEGER,
        status TEXT, total_tokens INTEGER, total_cost REAL,
        parent_session_file TEXT, parent_cwd TEXT)`);
      seed.exec(`CREATE TABLE tasks(
        id TEXT PRIMARY KEY, call_id TEXT, ts INTEGER, version TEXT,
        pi_version TEXT, idx INTEGER, agent TEXT, model TEXT, thinking TEXT,
        tools TEXT, workspace TEXT, outcome TEXT, failure_kind TEXT,
        duration_ms INTEGER, tokens INTEGER, cost REAL, tool_uses INTEGER,
        retries INTEGER, prompt_chars INTEGER, output_chars INTEGER,
        session_file TEXT, async INTEGER, error_snippet TEXT)`);
      seed
        .prepare(
          `INSERT INTO calls(id, ts, version, pi_version, mode, parent_model,
             task_count, wall_ms, status, total_tokens, total_cost,
             parent_session_file, parent_cwd)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "v1-call",
          1000,
          "v1.0",
          "pi-1",
          "sync",
          "parent/model",
          1,
          50,
          "completed",
          10,
          0.01,
          "/v1/parent-session.jsonl",
          "/v1/parent-cwd",
        );
      seed
        .prepare(
          `INSERT INTO tasks(id, call_id, ts, version, pi_version, idx, agent,
             model, thinking, tools, workspace, outcome, failure_kind,
             duration_ms, tokens, cost, tool_uses, retries, prompt_chars,
             output_chars, session_file, async, error_snippet)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "v1-task",
          "v1-call",
          1000,
          "v1.0",
          "pi-1",
          0,
          "inline",
          "m/m",
          "high",
          '["read"]',
          "shared",
          "ok",
          "crash",
          42,
          10,
          0.01,
          3,
          0,
          11,
          22,
          "/v1/child-session.jsonl",
          0,
          "v1 error snippet",
        );
      seed.exec("PRAGMA user_version = 3");
      seed.close();

      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([fauxAssistantMessage("MIGRATED-OK")]);
      const result = await callDelegate(session, {
        tasks: [{ prompt: "x" }],
      });
      expect(result.isError).toBe(false);

      const db = new DatabaseSync(dbPath);
      try {
        expect(userVersionOf(db)).toBe(5);
        const columns = (db.prepare("PRAGMA table_info(tasks)").all() as {
          name?: unknown;
        }[]).map((row) => row.name);
        expect(columns).toContain("integration");
        expect(columns).toContain("provisional");

        const calls = rowsOf(db, "calls");
        const tasks = rowsOf(db, "tasks");
        expect(calls).toHaveLength(2);
        expect(tasks).toHaveLength(2);

        const legacyCall = calls.find((row) => row.id === "v1-call");
        expect(legacyCall?.parent_cwd).toBe("/v1/parent-cwd");
        expect(legacyCall?.parent_session_file).toBe(
          "/v1/parent-session.jsonl",
        );
        const legacyTask = tasks.find((row) => row.id === "v1-task");
        expect(legacyTask?.session_file).toBe("/v1/child-session.jsonl");
        expect(legacyTask?.error_snippet).toBe("v1 error snippet");
        expect(legacyTask?.prompt_chars).toBe(11);
        expect(legacyTask?.provisional).toBeNull();

        const newCall = calls.find((row) => row.id !== "v1-call");
        expect(newCall).toBeDefined();
        for (const column of CALLS_LEGACY_COLUMNS) {
          expect(newCall?.[column]).toBeNull();
        }
        const newTask = tasks.find((row) => row.id !== "v1-task");
        expect(newTask).toBeDefined();
        for (const column of TASKS_LEGACY_COLUMNS) {
          expect(newTask?.[column]).toBeNull();
        }
        expect(newTask?.call_id).toBe(newCall?.id);
      } finally {
        db.close();
      }
    },
  );

  test(
    "eight simultaneous first opens each persist exactly one batch",
    async () => {
      const dbPath = join(trackedTempDir(), "race.db");
      const childScript = resolve(
        import.meta.dirname,
        "../support/telemetry-dispatch-child.ts",
      );
      const childEnv = { ...process.env };
      delete childEnv.DELEGATE_AGENT_DIR;
      childEnv.DELEGATE_TELEMETRY_DB = dbPath;
      const children = Array.from({ length: 8 }, () => {
        const process_ = Bun.spawn([process.execPath, childScript], {
          env: childEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        return Promise.all([
          process_.exited,
          new Response(process_.stdout).text(),
          new Response(process_.stderr).text(),
        ]);
      });

      const outcomes = await Promise.all(children);
      for (const [index, [exitCode, stdout, stderr]] of outcomes.entries()) {
        if (exitCode !== 0) {
          console.error(
            `telemetry child ${index} exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
          );
        }
        expect(exitCode).toBe(0);
      }

      const db = new DatabaseSync(dbPath);
      let callCount = -1;
      let taskCount = -1;
      let version = -1;
      let journal = "";
      try {
        callCount = rowsOf(db, "calls").length;
        taskCount = rowsOf(db, "tasks").length;
        version = userVersionOf(db);
        journal = journalModeOf(db);
      } finally {
        db.close();
      }
      if (callCount !== 8 || taskCount !== 8) {
        for (const [index, [exitCode, stdout, stderr]] of outcomes.entries()) {
          console.error(
            `telemetry child ${index} exit=${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
          );
        }
      }
      expect(callCount).toBe(8);
      expect(taskCount).toBe(8);
      expect(version).toBe(5);
      expect(journal).toBe("wal");
    },
    120_000,
  );

  test(
    "disabled telemetry leaves an existing database unopened and untouched",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(session.cwd, "delegate-usage.db");
      const seed = new DatabaseSync(dbPath);
      seed.exec("CREATE TABLE marker(value TEXT)");
      seed.prepare("INSERT INTO marker(value) VALUES (?)").run("keep");
      seed.close();
      const bytesBefore = readFileSync(dbPath);
      const mtimeBefore = statSync(dbPath).mtimeMs;
      configureDelegate(session, { telemetry: { enabled: false } });
      subagents.respond([fauxAssistantMessage("DONE")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x" }],
      });

      expect(result.isError).toBe(false);
      expect(readFileSync(dbPath)).toEqual(bytesBefore);
      expect(statSync(dbPath).mtimeMs).toBe(mtimeBefore);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    },
  );

  test(
    "a force-cancelled async batch records cancelled as the call status",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      const { release, step } = gate();
      subagents.respond([fauxAssistantMessage("EARLY-OK"), step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "quick" }, { prompt: "slow" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const cancelled = await callDelegateTicket(session, {
        action: "cancel",
        ticket,
        force: true,
      });
      expect(cancelled.isError).toBe(false);
      expect(cancelled.text).toMatch(/cancel/i);
      release();

      let calls: Record<string, unknown>[] = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(dbPath)) {
          const db = new DatabaseSync(dbPath);
          try {
            calls = rowsOf(db, "calls");
          } catch {
            calls = [];
          } finally {
            db.close();
          }
          if (calls.length === 1) break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]?.status).toBe("cancelled");
      expect(calls[0]?.mode).toBe("async");
    },
  );

  test(
    "a failed destination retries after the destination identity changes",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const root = trackedTempDir();
      const blocker = join(root, "blocker");
      const pathA = join(blocker, "a.db");
      const pathB = join(root, "b.db");
      writeFileSync(blocker, "occupied");
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        configureDelegate(session, {
          telemetry: { enabled: true, dbPath: pathA },
        });
        subagents.respond([fauxAssistantMessage("A-FAILED")]);
        const first = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });
        expect(first.isError).toBe(false);
        expect(
          errors.mock.calls.some((arguments_) =>
            String(arguments_[0]).includes("[delegate] telemetry"),
          ),
        ).toBe(true);

        configureDelegate(session, {
          telemetry: { enabled: true, dbPath: pathB },
        });
        subagents.respond([fauxAssistantMessage("B-WORKS")]);
        const second = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });
        expect(second.isError).toBe(false);
        const dbB = new DatabaseSync(pathB);
        try {
          expect(rowsOf(dbB, "calls")).toHaveLength(1);
        } finally {
          dbB.close();
        }

        rmSync(blocker);
        configureDelegate(session, {
          telemetry: { enabled: true, dbPath: pathA },
        });
        subagents.respond([fauxAssistantMessage("A-RECOVERED")]);
        const third = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });
        expect(third.isError).toBe(false);
        const dbA = new DatabaseSync(pathA);
        try {
          expect(rowsOf(dbA, "calls")).toHaveLength(1);
          expect(rowsOf(dbA, "tasks")).toHaveLength(1);
        } finally {
          dbA.close();
        }
      } finally {
        errors.mockRestore();
      }
    },
  );

  test(
    "malformed telemetry config fails the call before any provider request",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      for (const patch of [
        { telemetry: "yes" },
        { telemetry: null },
        { telemetry: { enabled: "true" } },
        { telemetry: { enabled: true, dbPath: "relative/usage.db" } },
        { telemetry: { enabled: true, dbPath: "   " } },
        { telemetry: { enabled: true, unknown: 1 } },
      ]) {
        configureDelegate(session, patch);
        const result = await callDelegate(session, {
          tasks: [{ prompt: "x" }],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/telemetry/i);
        expect(result.text).toMatch(/delegate\.json|config/i);
      }
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a destination change drops an unfinished span instead of reopening the old database",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const pathA = join(trackedTempDir(), "a.db");
      const pathB = join(trackedTempDir(), "b.db");
      let markStarted!: () => void;
      const started = new Promise<void>((r) => (markStarted = r));
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const gated: FauxResponseFactory = async () => {
        markStarted();
        await hold;
        return fauxAssistantMessage("STALE-SPAN-RELEASED");
      };
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath: pathA },
      });
      subagents.respond([gated]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "slow" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await started;

      configureDelegate(session, {
        telemetry: { enabled: true, dbPath: pathB },
      });
      subagents.respond([fauxAssistantMessage("SECOND-BATCH")]);
      const second = await callDelegate(session, {
        tasks: [{ prompt: "fast", tools: ["read"] }],
      });
      expect(second.isError).toBe(false);

      release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 10_000,
      });
      expect(waited.isError).toBe(false);

      expect(existsSync(pathA)).toBe(true);
      const dbA = new DatabaseSync(pathA);
      try {
        expect(rowsOf(dbA, "calls")).toHaveLength(0);
        expect(rowsOf(dbA, "tasks")).toHaveLength(0);
      } finally {
        dbA.close();
      }
      const dbB = new DatabaseSync(pathB);
      try {
        const calls = rowsOf(dbB, "calls");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.mode).toBe("sync");
        expect(rowsOf(dbB, "tasks")).toHaveLength(1);
      } finally {
        dbB.close();
      }
    },
  );

  test(
    "isolated integration status is recorded after reconciliation",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const repo = trackedTempDir();
      gitInit(repo);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      const writeThenDone: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("ISOLATED-DONE");
        }
        return fauxAssistantMessage([
          fauxToolCall("write", { path: "made.txt", content: "made" }),
        ]);
      };
      subagents.respond([writeThenDone, writeThenDone]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "make a change",
            cwd: repo,
            tools: ["write"],
            workspace: "isolated",
          },
        ],
      });

      expect(result.isError).toBe(false);
      expect(readFileSync(join(repo, "made.txt"), "utf8")).toBe("made");
      const db = new DatabaseSync(dbPath);
      try {
        const tasks = rowsOf(db, "tasks");
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.integration).toBe("applied_unverified");
        expect(tasks[0]?.workspace).toBe("isolated");
      } finally {
        db.close();
      }
    },
  );

  test(
    "an unconfirmed worker outcome is marked provisional",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const gated: FauxResponseFactory = async () => {
        await hold;
        return fauxAssistantMessage("TOO-LATE");
      };
      subagents.respond([gated, fauxAssistantMessage("CLEANUP")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "hang", tools: ["write"], deadlineMs: 500 }],
      });
      expect(result.text).toMatch(/deadline|cancel/i);
      expect(subagents.state.callCount).toBe(1);

      const db = new DatabaseSync(dbPath);
      try {
        const tasks = rowsOf(db, "tasks");
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.provisional).toBe(1);
      } finally {
        db.close();
      }
      release();
    },
  );

  test(
    "isolated baselines exclude the active telemetry database and sidecars",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const repo = trackedTempDir();
      gitInit(repo);
      const dbPath = join(repo, "telemetry-state", "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([
        fauxAssistantMessage([
          fauxToolCall("bash", {
            command:
              "if [ ! -e telemetry-state/usage.db ] && [ ! -e telemetry-state/usage.db-wal ] && [ ! -e telemetry-state/usage.db-shm ]; then printf absent > telemetry-owned-check.txt; else printf present > telemetry-owned-check.txt; fi",
          }),
        ]),
        fauxAssistantMessage("CHECK-DONE"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "check telemetry files",
            cwd: repo,
            tools: ["bash"],
            workspace: "isolated",
          },
        ],
      });

      expect(result.isError).toBe(false);
      expect(
        readFileSync(join(repo, "telemetry-owned-check.txt"), "utf8"),
      ).toBe("absent");
      expect(existsSync(dbPath)).toBe(true);
      const db = new DatabaseSync(dbPath);
      try {
        const tasks = rowsOf(db, "tasks");
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.integration).toBe("applied_unverified");
      } finally {
        db.close();
      }
    },
  );

  test(
    "a validation rejection records a misfire row with the verbatim message and post-alias batch shape",
    async () => {
      // SPEC v3 "Observability": a dispatch ending before execution
      // leaves a misfire row — phase, the caller-visible message, and the
      // requested batch shape. The unknown agent lands after alias
      // expansion, so the row's agents are the canonical names the
      // caller's names resolved to ("explore" → "scout").
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "misfires.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "x", agent: "explore", tools: ["read"] },
          { prompt: "y", agent: "bogus-agent" },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("unknown agent 'bogus-agent'");
      expect(subagents.state.callCount).toBe(0);

      const db = new DatabaseSync(dbPath);
      try {
        const misfires = rowsOf(db, "misfires");
        expect(misfires).toHaveLength(1);
        const row = misfires[0];
        expect(row?.phase).toBe("validation");
        expect(row?.message).toContain("unknown agent 'bogus-agent'");
        expect(row?.task_count).toBe(2);
        expect(JSON.parse(String(row?.agents))).toEqual([
          "scout",
          "bogus-agent",
        ]);
        expect(JSON.parse(String(row?.workspaces))).toEqual([
          "shared",
          "shared",
        ]);
        // Two tasks → the v3 cardinality default made this call async.
        expect(row?.async).toBe(1);
        expect(row?.parent_cwd).toBe(session.cwd);
        expect(typeof row?.ts).toBe("number");
        // Nothing ran: no dispatch rows accompany the misfire.
        expect(rowsOf(db, "calls")).toHaveLength(0);
        expect(rowsOf(db, "tasks")).toHaveLength(0);
      } finally {
        db.close();
      }
    },
  );

  test(
    "an admission rejection records a misfire row",
    async () => {
      // SPEC v3 "Observability": a mixed shared/isolated same-repo batch
      // rejects at admission — the row carries both workspace selections.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const repo = trackedTempDir();
      gitInit(repo);
      const dbPath = join(trackedTempDir(), "misfires.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "shared writer",
            cwd: repo,
            tools: ["write"],
            workspace: "shared",
          },
          {
            prompt: "isolated writer",
            cwd: repo,
            tools: ["write"],
            workspace: "isolated",
          },
        ],
      });

      expect(result.isError).toBe(true);
      expect(subagents.state.callCount).toBe(0);

      const db = new DatabaseSync(dbPath);
      try {
        const misfires = rowsOf(db, "misfires");
        expect(misfires).toHaveLength(1);
        const row = misfires[0];
        expect(row?.phase).toBe("admission");
        expect(String(row?.message)).toBe(result.text);
        expect(JSON.parse(String(row?.workspaces))).toEqual([
          "shared",
          "isolated",
        ]);
        expect(row?.async).toBe(1);
      } finally {
        db.close();
      }
    },
  );

  test(
    "a config-load failure records a misfire row through the raw-file telemetry salvage",
    async () => {
      // SPEC v3 "Observability": the config load is itself the failure,
      // so the telemetry block is read defensively from the file — a
      // malformed maxConcurrent beside a well-formed telemetry block
      // still records its row.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "misfires.db");
      configureDelegate(session, {
        maxConcurrent: 0,
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("maxConcurrent");
      expect(subagents.state.callCount).toBe(0);

      const db = new DatabaseSync(dbPath);
      try {
        const misfires = rowsOf(db, "misfires");
        expect(misfires).toHaveLength(1);
        const row = misfires[0];
        expect(row?.phase).toBe("config");
        expect(row?.message).toContain("maxConcurrent");
        expect(row?.task_count).toBe(1);
        expect(JSON.parse(String(row?.agents))).toEqual(["inline"]);
        expect(row?.async).toBe(0);
      } finally {
        db.close();
      }
    },
  );

  test(
    "a call-shape rejection records a misfire row through the same store",
    async () => {
      // SPEC v3 "Observability": call-shape validation rejects in
      // execute's synchronous prefix — before any config load — so this
      // exercises the salvaged-hint path with a well-formed config.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "misfires.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", deadlineMs: -5 }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/deadlineMs must be positive/);
      expect(subagents.state.callCount).toBe(0);

      const db = new DatabaseSync(dbPath);
      try {
        const misfires = rowsOf(db, "misfires");
        expect(misfires).toHaveLength(1);
        const row = misfires[0];
        expect(row?.phase).toBe("validation");
        expect(row?.message).toContain("deadlineMs must be positive");
        expect(row?.task_count).toBe(1);
      } finally {
        db.close();
      }
    },
  );

  test(
    "a successful dispatch records no misfire row",
    async () => {
      // SPEC v3 "Observability": misfires exist only for dispatches that
      // end before execution — a completed call writes its normal rows
      // and nothing else.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([fauxAssistantMessage("CLEAN-RUN")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x" }],
      });
      expect(result.isError).toBe(false);

      const db = new DatabaseSync(dbPath);
      try {
        expect(rowsOf(db, "misfires")).toHaveLength(0);
        expect(rowsOf(db, "calls")).toHaveLength(1);
        expect(rowsOf(db, "tasks")).toHaveLength(1);
      } finally {
        db.close();
      }
    },
  );
});

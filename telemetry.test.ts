import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  _setTelemetryForTesting,
  _resetTelemetryForTesting,
  beginCall,
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
      recordTask: (r) => tasks.push(r),
    },
  };
}

function loadRepoVersion(): string {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  return pkg.version as string;
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
      callId: "call-1",
      async: false,
      taskIndex: 0,
      task,
      progress,
      result,
      retries: 2,
    });

    expect(tasks).toHaveLength(1);
    const row = tasks[0]!;
    expect(row.call_id).toBe("call-1");
    expect(row.idx).toBe(0);
    expect(row.agent).toBe("ad-hoc");
    expect(row.model).toBe("test/model");
    expect(row.thinking).toBe("low");
    expect(row.tools).toBe(JSON.stringify(["read", "bash"]));
    expect(row.tokens).toBe(50);
    expect(row.cost).toBe(0.01);
    expect(row.tool_uses).toBe(3);
    expect(row.retries).toBe(2);
    expect(row.prompt_chars).toBe(11);
    expect(row.output_chars).toBe(2);
    expect(row.async).toBe(0);
    expect(row.outcome).toBe("success");
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

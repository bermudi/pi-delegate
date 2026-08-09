import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _setGlobalConcurrencyLimitForTesting,
  _resetGlobalConcurrencyForTesting,
} from "./concurrency.ts";
import { _setRunAgentSessionForTesting } from "./lifecycle.ts";
import { _resetPoolForTesting, commit } from "./pool.ts";
import { emptyUsage } from "./usage.ts";
import { dispatchSync } from "./dispatch.ts";
import type { ResolvedTask, TaskDef, TaskProgress } from "./types.ts";

interface FakeSession {
  touchedFiles: string[];
  attributedFiles: string[];
  subscribe: () => () => void;
  prompt: () => Promise<void>;
  abort: () => Promise<void>;
  isIdle: boolean;
  isCompacting: boolean;
  messages: unknown[];
  state: Record<string, unknown>;
  getSessionStats: () => {
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
    cost: number;
  };
}

function makeFakeSession(
  touchedFiles: string[],
  attributedFiles = touchedFiles,
): FakeSession {
  return {
    touchedFiles,
    attributedFiles,
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    isIdle: true,
    isCompacting: false,
    messages: [],
    state: {},
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
  };
}

function makeFakeSessionManager(file: string) {
  return { getSessionFile: () => file } as any;
}

describe("dispatchSync touched-file overlap warning", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetPoolForTesting();
    _setGlobalConcurrencyLimitForTesting(10);
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "delegate-dispatch-"));
    _setRunAgentSessionForTesting(
      async (session: any, _prompt, _config, _signal, _onProgress) => {
        return {
          output: "done",
          durationMs: 1,
          tokens: 1,
          usage: emptyUsage(),
          touchedFiles: session.touchedFiles ?? [],
          attributedFiles: session.attributedFiles ?? [],
        } as any;
      },
    );
  });

  afterEach(() => {
    _setRunAgentSessionForTesting(undefined);
    _resetGlobalConcurrencyForTesting();
    _resetPoolForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupTask(
    sessionId: string,
    agentName: string,
    touchedFiles: string[],
    taskId?: string,
    attributedFiles = touchedFiles,
  ): { resolved: ResolvedTask; progress: TaskProgress } {
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, '{"type":"session"}\n');
    const session = makeFakeSession(touchedFiles, attributedFiles);
    const manager = makeFakeSessionManager(sessionFile);
    commit(sessionId, {
      session,
      sessionManager: manager,
      sessionFile,
      frozen: {
        systemPrompt: "",
        model: { provider: "test", id: "m" } as any,
        thinking: "off",
        tools: [],
        cwd: tmpDir,
      },
      tokens: 1,
    });

    return {
      resolved: {
        id: taskId,
        sessionId,
        agentName,
        prompt: `${agentName} work`,
        cwd: tmpDir,
        thinking: "off",
        tools: [],
        systemPrompt: "",
        model: { provider: "test", id: "m" } as any,
      } as ResolvedTask,
      progress: {
        id: taskId,
        index: 0,
        agent: agentName,
        task: `${agentName} work`,
        status: "running",
        durationMs: 0,
        tokens: 0,
        toolUses: 0,
        activities: [],
      } as TaskProgress,
    };
  }

  test("emits overlap warning when two tasks touch the same path", async () => {
    const shared = path.join(tmpDir, "shared.txt");
    const a = setupTask("s1", "a", [shared]);
    const b = setupTask("s2", "b", [shared]);

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }, { prompt: "b" }] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      signal: undefined,
      fire: () => {},
    });

    const text = result.content[0]!.text;
    expect(text).toContain("touched (best-effort): shared.txt");
    expect(text).toContain(shared);
    expect(text).toContain("does not isolate or serialize file access");
    expect(text).toContain("does not roll back completed writes");
  });

  test("omits overlap warning when tasks touch distinct paths", async () => {
    const a = setupTask("s1", "a", [path.join(tmpDir, "a.txt")]);
    const b = setupTask("s2", "b", [path.join(tmpDir, "b.txt")]);

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }, { prompt: "b" }] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      signal: undefined,
      fire: () => {},
    });

    const text = result.content[0]!.text;
    expect(text).not.toContain("does not isolate or serialize file access");
    expect(text).not.toContain("does not roll back completed writes");
  });

  test("omits overlap warning when git-derived touchedFiles overlap but attributedFiles do not", async () => {
    const aFile = path.join(tmpDir, "a.txt");
    const bFile = path.join(tmpDir, "b.txt");
    // Each task's post-run git snapshot sees both files, but only one was
    // directly written by each subagent.
    const a = setupTask("s1", "a", [aFile, bFile], undefined, [aFile]);
    const b = setupTask("s2", "b", [aFile, bFile], undefined, [bFile]);

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }, { prompt: "b" }] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      signal: undefined,
      fire: () => {},
    });

    const text = result.content[0]!.text;
    // Display still reports the best-effort union for each task.
    expect(text).toContain("touched (best-effort): a.txt, b.txt");
    // Overlap is computed only from directly attributable files.
    expect(text).not.toContain("does not isolate or serialize file access");
    expect(text).not.toContain("does not roll back completed writes");
  });

  test("carries caller-provided task id onto result and progress", async () => {
    const a = setupTask("s1", "a", [], "task-a");
    const b = setupTask("s2", "b", [], "task-b");

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [
        { id: "task-a", prompt: "a" },
        { id: "task-b", prompt: "b" },
      ] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      signal: undefined,
      fire: () => {},
    });

    expect(result.details.results[0]!.id).toBe("task-a");
    expect(result.details.results[1]!.id).toBe("task-b");
    expect(result.details.progress[0]!.id).toBe("task-a");
    expect(result.details.progress[1]!.id).toBe("task-b");
    // Result arrays stay index-aligned; ids are per-entry, not keys.
    expect(result.details.results).toHaveLength(2);
  });

  test("deadlineMs is measured from run start, not dispatch time", async () => {
    _setGlobalConcurrencyLimitForTesting(1);
    _setRunAgentSessionForTesting(
      async (
        _session,
        _prompt,
        _config,
        _signal,
        _onProgress,
        _gitBaseline,
        _start,
        deadlineAt,
      ) => {
        if (deadlineAt === undefined) {
          await new Promise((r) => setTimeout(r, 80));
          return {
            output: "a done",
            durationMs: 80,
            tokens: 1,
            usage: emptyUsage(),
            touchedFiles: [],
            attributedFiles: [],
          } as any;
        }
        await new Promise((r) => setTimeout(r, 10));
        return {
          output: "b done",
          durationMs: 10,
          tokens: 1,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
        } as any;
      },
    );

    const a = setupTask("s1", "a", []);
    const b = setupTask("s2", "b", []);
    (b.resolved as any).deadlineMs = 50;

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }, { prompt: "b", deadlineMs: 50 }] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      signal: undefined,
      fire: () => {},
    });

    expect(result.details.results[0]!.error).toBeUndefined();
    expect(result.details.results[1]!.error).toBeUndefined();
    expect(result.details.results[1]!.output).toBe("b done");
  });
});

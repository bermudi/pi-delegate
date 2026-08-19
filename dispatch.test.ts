import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
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
import { dispatchAsync, dispatchSync } from "./dispatch.ts";
import { recordTreeNavigation, resetLeafTracking } from "./leaf.ts";
import {
  _resetDelegateStatusForTesting,
  syncDelegateStatus,
} from "./status.ts";
import { cancelTicketForShutdown, ticketRegistry } from "./tickets.ts";
import {
  _resetTelemetryForTesting,
  _setTelemetryForTesting,
  beginCall,
  type CallRecord,
  type TaskRecord,
} from "./telemetry.ts";
import {
  _setDelegateConfigForTesting,
  _resetDelegateConfigForTesting,
  getDelegateConfigSnapshot,
  type DelegateConfig,
} from "./config.ts";
import type { ResolvedTask, TaskDef, TaskProgress } from "./types.ts";

interface FakeSession {
  touchedFiles: string[];
  attributedFiles: string[];
  subscribe: () => () => void;
  prompt: () => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
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
    dispose: () => {},
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
    _resetTelemetryForTesting();
    _resetDelegateConfigForTesting();
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

  test("shutdown records usage from a worker that settles after cancellation", async () => {
    const calls: CallRecord[] = [];
    const tasks: TaskRecord[] = [];
    _setTelemetryForTesting({
      recordCall: (record) => calls.push(record),
      recordTask: (record) => tasks.push(record),
    });

    let workerEntered!: () => void;
    let releaseWorker!: () => void;
    const entered = new Promise<void>((resolve) => {
      workerEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    _setRunAgentSessionForTesting(async () => {
      workerEntered();
      await release;
      return {
        output: "late result",
        durationMs: 10,
        tokens: 23,
        usage: {
          input: 10,
          output: 13,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 23,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.23,
          },
        },
        touchedFiles: [],
        attributedFiles: [],
      } as any;
    });

    const task = setupTask("late-shutdown", "late", []);
    const callSpan = beginCall({
      parentModel: "model",
      mode: "async",
      taskCount: 1,
    });
    let deliveries = 0;
    const acknowledgment = dispatchAsync({
      pi: {
        sendMessage: () => {
          deliveries++;
        },
      } as any,
      ctx: {
        cwd: tmpDir,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "late work" }] as TaskDef[],
      resolved: [task.resolved],
      progress: [task.progress],
      parentModelId: "model",
      callSpan,
    });
    const ticket = ticketRegistry.get(acknowledgment.details.ticketId!);
    if (!ticket) throw new Error("async ticket was not registered");
    const completion = ticket.completion;
    if (!completion) throw new Error("async ticket has no completion promise");

    // Ensure shutdown happens while the worker is inside the delayed run.
    await entered;
    cancelTicketForShutdown(ticket);
    expect(calls.at(-1)?.status).toBe("cancelled");
    expect(calls.at(-1)?.total_tokens).toBe(0);

    // The completion handler must wait for this late result and rewrite the
    // cancelled call row, but must not send a stale follow-up UI message.
    releaseWorker();
    await completion;

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.tokens).toBe(23);
    expect(calls.at(-1)?.status).toBe("cancelled");
    expect(calls.at(-1)?.total_tokens).toBe(23);
    expect(calls.at(-1)?.total_cost).toBe(0.23);
    expect(deliveries).toBe(0);
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

  test("async ticket and runner capture a dispatch-scoped config snapshot", async () => {
    const a = setupTask("s1", "a", []);
    let capturedConfig: DelegateConfig | undefined;
    let releaseWorker!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      const original = _setRunAgentSessionForTesting(
        async (...args: unknown[]) => {
          capturedConfig = args[8] as DelegateConfig;
          resolve();
          await new Promise<void>((r) => (releaseWorker = r));
          return {
            output: "done",
            durationMs: 1,
            tokens: 1,
            usage: emptyUsage(),
            touchedFiles: [],
            attributedFiles: [],
            prompted: true,
          } as any;
        },
      );
      // Preserve the original for cleanup; the mock just needs to capture.
      original;
    });

    _setDelegateConfigForTesting({
      retry: { wholeTaskMaxRetries: 7, wholeTaskBaseDelayMs: 250 },
      stallTimeoutMs: 12345,
    });
    const dispatchConfig = getDelegateConfigSnapshot();

    const callSpan = beginCall({
      parentModel: "m",
      mode: "async",
      taskCount: 1,
    });
    const ack = dispatchAsync({
      pi: { sendMessage: () => {} } as any,
      ctx: {
        cwd: tmpDir,
        modelRegistry: {} as any,
        sessionManager: undefined,
      } as any,
      tasks: [{ prompt: "a" }] as any,
      resolved: [a.resolved],
      progress: [a.progress],
      parentModelId: "m",
      callSpan,
      dispatchConfig,
    });

    const ticket = ticketRegistry.get(ack.details.ticketId!);
    expect(ticket?.config?.retry?.wholeTaskMaxRetries).toBe(7);
    expect(ticket?.config?.stallTimeoutMs).toBe(12345);

    await workerStarted;

    // Mutate the global singleton while the worker is still inside runAgentSession.
    _setDelegateConfigForTesting({
      retry: { wholeTaskMaxRetries: 1, wholeTaskBaseDelayMs: 0 },
      stallTimeoutMs: 999,
    });

    releaseWorker();
    await ticket?.completion;

    // The runner must have used the snapshot captured at dispatch, not the
    // new global values.
    expect(capturedConfig?.retry?.wholeTaskMaxRetries).toBe(7);
    expect(capturedConfig?.stallTimeoutMs).toBe(12345);
  });
});

// Issue #30: an async ticket must remember the session-tree leaf it was
// spawned on, so a result that arrives after /tree navigation does not wake
// the parent agent on a branch the task was never part of.
describe("dispatchAsync leaf affinity", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetPoolForTesting();
    _setGlobalConcurrencyLimitForTesting(10);
    resetLeafTracking();
    _resetDelegateStatusForTesting();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "delegate-leaf-"));
    _setRunAgentSessionForTesting(
      async () =>
        ({
          output: "done",
          durationMs: 1,
          tokens: 1,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
        }) as any,
    );
  });

  afterEach(() => {
    _setRunAgentSessionForTesting(undefined);
    _resetGlobalConcurrencyForTesting();
    _resetPoolForTesting();
    ticketRegistry.clear();
    resetLeafTracking();
    _resetDelegateStatusForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(sendMessage?: (message: any, options: any) => void): {
    sent: { message: any; options: any }[];
    notified: string[];
    ticketId: string;
  } {
    const sent: { message: any; options: any }[] = [];
    const notified: string[] = [];
    const uiCtx = {
      hasUI: true,
      ui: {
        setStatus: () => {},
        notify: (message: string) => notified.push(message),
      },
    } as any;
    // Prime the ctx status.ts caches for its event-driven notifications;
    // dispatchAsync itself only calls syncDelegateStatus() without a ctx.
    syncDelegateStatus(uiCtx);

    const result = dispatchAsync({
      pi: {
        sendMessage:
          sendMessage ??
          ((message: any, options: any) => sent.push({ message, options })),
      } as any,
      ctx: { cwd: tmpDir, modelRegistry: {} as any, sessionManager: undefined },
      tasks: [{ prompt: "a" }] as TaskDef[],
      resolved: [
        {
          agentName: "a",
          prompt: "a work",
          cwd: tmpDir,
          thinking: "off",
          tools: [],
          systemPrompt: "",
          model: { provider: "test", id: "m" } as any,
        } as ResolvedTask,
      ],
      progress: [
        {
          index: 0,
          agent: "a",
          task: "a work",
          status: "running",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        } as TaskProgress,
      ],
      parentModelId: "m",
    });
    const ticketId = result.details.ticketId!;
    return { sent, notified, ticketId };
  }

  async function settled(ticketId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (ticketRegistry.get(ticketId)?.completedAt) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`ticket ${ticketId} never settled`);
  }

  test("stamps the current leaf and delivers normally when it has not changed", async () => {
    recordTreeNavigation("leaf-1");
    const { sent, notified, ticketId } = run();
    expect(ticketRegistry.get(ticketId)!.spawnLeafId).toBe("leaf-1");

    await settled(ticketId);
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(notified).toEqual([]);
  });

  test("navigating away before completion defers delivery and warns the human", async () => {
    recordTreeNavigation("leaf-1");
    const { sent, notified, ticketId } = run();

    // The user opens /tree and moves while the subagent is still working.
    recordTreeNavigation("leaf-2");
    await settled(ticketId);

    expect(sent[0]!.options).toEqual({ deliverAs: "nextTurn" });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain(ticketId);
  });

  test("sendMessage failure is logged without changing worker settlement", async () => {
    const deliveryError = new Error("parent session unavailable");
    const logged = mock((..._args: unknown[]) => {});
    const originalError = console.error;
    console.error = logged as unknown as typeof console.error;

    try {
      const { ticketId } = run(() => {
        throw deliveryError;
      });
      const ticket = ticketRegistry.get(ticketId);
      if (!ticket?.completion)
        throw new Error("async ticket has no completion promise");

      await ticket.completion;

      // The worker settled normally; failed unsolicited delivery leaves the
      // completed result available to poll rather than re-entering .catch().
      expect(ticket.status).toBe("done");
      expect(ticket.completedAt).toBeDefined();
      expect(ticket.results[0]!.output).toBe("done");
      expect(logged).toHaveBeenCalledWith(
        `[delegate] failed to deliver results for ticket '${ticketId}'; it remains pollable`,
        deliveryError,
      );
    } finally {
      console.error = originalError;
    }
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getModelKey,
  mapConcurrentByModel,
  _setGlobalConcurrencyLimitForTesting,
  _resetGlobalConcurrencyForTesting,
  reconfigureGlobalConcurrency,
} from "./concurrency.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await delay(5);
  }
}

interface ModelStub {
  provider: string;
  id: string;
}

interface Task {
  id: number;
  model: ModelStub;
}

function makeTask(id: number, provider: string, modelId: string): Task {
  return { id, model: { provider, id: modelId } };
}

describe("mapConcurrentByModel", () => {
  beforeEach(() => {
    _resetGlobalConcurrencyForTesting();
  });

  afterEach(() => {
    _resetGlobalConcurrencyForTesting();
  });

  test("enforces the global concurrency cap across multiple invocations", async () => {
    _setGlobalConcurrencyLimitForTesting(2);

    const events: string[] = [];
    let maxConcurrent = 0;
    let running = 0;

    const runTask = async (task: Task): Promise<number> => {
      events.push(`${task.id}-start`);
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(20);
      running--;
      events.push(`${task.id}-end`);
      return task.id;
    };

    const items = Array.from({ length: 6 }, (_, i) =>
      makeTask(i, "openai", "gpt-4"),
    );

    // Two parallel invocations simulate two concurrent `delegate` calls.
    const [r1, r2] = await Promise.all([
      mapConcurrentByModel(
        items.slice(0, 3),
        (t) => getModelKey(t.model as any),
        () => 10,
        runTask,
      ),
      mapConcurrentByModel(
        items.slice(3, 6),
        (t) => getModelKey(t.model as any),
        () => 10,
        runTask,
      ),
    ]);

    expect([...r1, ...r2].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxConcurrent).toBe(2);
  });

  test("per-model concurrency limit is respected", async () => {
    _setGlobalConcurrencyLimitForTesting(10);

    const events: string[] = [];
    let maxConcurrent = 0;
    let running = 0;

    const runTask = async (task: Task): Promise<number> => {
      events.push(`${task.id}-start`);
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(10);
      running--;
      events.push(`${task.id}-end`);
      return task.id;
    };

    const items = [
      makeTask(0, "openai", "gpt-4"),
      makeTask(1, "openai", "gpt-4"),
      makeTask(2, "openai", "gpt-4"),
      makeTask(3, "anthropic", "claude-3"),
      makeTask(4, "anthropic", "claude-3"),
    ];

    const results = await mapConcurrentByModel(
      items,
      (t) => getModelKey(t.model as any),
      (key) => (key === "openai/gpt-4" ? 1 : 10),
      runTask,
    );

    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    // gpt-4 group limited to 1, claude group limited to 10, global 10.
    // Max concurrent observed should be 3 (1 gpt-4 + 2 claude).
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  test("combines per-model and global caps", async () => {
    _setGlobalConcurrencyLimitForTesting(2);

    let maxConcurrent = 0;
    let running = 0;

    const runTask = async (task: Task): Promise<number> => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(10);
      running--;
      return task.id;
    };

    const items = [
      makeTask(0, "openai", "gpt-4"),
      makeTask(1, "openai", "gpt-4"),
      makeTask(2, "anthropic", "claude-3"),
      makeTask(3, "anthropic", "claude-3"),
    ];

    await mapConcurrentByModel(
      items,
      (t) => getModelKey(t.model as any),
      () => 10,
      runTask,
    );

    expect(maxConcurrent).toBe(2);
  });

  test("abort wakes queued tasks without waiting for a slot release", async () => {
    _setGlobalConcurrencyLimitForTesting(1);

    const controller = new AbortController();
    const started: number[] = [];
    const settledAfterAbort: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));

    const runTask = async (task: Task): Promise<string> => {
      started.push(task.id);
      if (controller.signal.aborted) {
        // Reached only via the abort-aware acquireGlobal wakeup: the slot is
        // still held by task 0, so these tasks must NOT have been released.
        settledAfterAbort.push(task.id);
        return `aborted-${task.id}`;
      }
      if (task.id === 0) await firstGate; // holds the only slot while 1,2 queue
      return `done-${task.id}`;
    };

    const items = [
      makeTask(0, "openai", "gpt-4"),
      makeTask(1, "openai", "gpt-4"),
      makeTask(2, "openai", "gpt-4"),
    ];

    const runPromise = mapConcurrentByModel(
      items,
      (t) => getModelKey(t.model as any),
      () => 10,
      runTask,
      controller.signal,
    );

    // Task 0 holds the slot; 1 and 2 must be queued behind it.
    await waitFor(() => started.length === 1);
    await delay(5); // let waiters register

    const abortedAt = Date.now();
    controller.abort();
    // Both queued tasks settle via the abort wakeup, with the slot still held.
    await waitFor(() => settledAfterAbort.length === 2);
    expect(Date.now() - abortedAt).toBeLessThan(100);

    releaseFirst();
    const results = await runPromise;

    expect(started).toEqual([0, 1, 2]);
    expect(results[0]).toBe("done-0");
    expect(results[1]).toBe("aborted-1");
    expect(results[2]).toBe("aborted-2");
  });

  test("already-aborted signal settles promptly without consuming a slot", async () => {
    _setGlobalConcurrencyLimitForTesting(1);

    const controller = new AbortController();
    controller.abort();

    const started: string[] = [];
    const runPromise = mapConcurrentByModel(
      [makeTask(0, "openai", "gpt-4"), makeTask(1, "openai", "gpt-4")],
      (t) => getModelKey(t.model as any),
      () => 10,
      async (task) => {
        started.push(String(task.id));
        return `aborted-${task.id}`;
      },
      controller.signal,
    );

    const results = await Promise.race([
      runPromise,
      delay(100).then(() => "TIMEOUT" as const),
    ]);
    expect(results).not.toBe("TIMEOUT");
    expect(started).toEqual(["0", "1"]);
    expect(results).toEqual(["aborted-0", "aborted-1"]);
  });
});

describe("reconfigureGlobalConcurrency", () => {
  beforeEach(() => _resetGlobalConcurrencyForTesting());
  afterEach(() => _resetGlobalConcurrencyForTesting());

  test("lowering the limit does not interrupt running tasks", async () => {
    _setGlobalConcurrencyLimitForTesting(2);

    let running = 0;
    let maxRunning = 0;
    const release = new Map<number, () => void>();

    const items = Array.from({ length: 3 }, (_, i) =>
      makeTask(i, "openai", "gpt-4"),
    );
    const runPromise = mapConcurrentByModel(
      items,
      (t) => getModelKey(t.model as any),
      () => 10,
      async (task) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        let releaseTask!: () => void;
        const promise = new Promise<void>((r) => (releaseTask = r));
        release.set(task.id, releaseTask);
        await promise;
        running--;
        return `done-${task.id}`;
      },
    );

    // Let two tasks start, then lower the cap.
    await waitFor(() => running === 2);
    reconfigureGlobalConcurrency(1);
    // The already-running task keeps its slot.
    expect(running).toBe(2);
    expect(maxRunning).toBe(2);

    // Finish one, then the next queued task can acquire the (now 1) slot.
    release.get(0)!();
    await waitFor(() => running === 1);
    await delay(5);
    release.get(1)!();
    await waitFor(() => running === 1);
    await delay(5);
    release.get(2)!();

    const results = await runPromise;
    expect(results).toEqual(["done-0", "done-1", "done-2"]);
    expect(maxRunning).toBe(2);
  });

  test("raising the limit wakes queued waiters", async () => {
    _setGlobalConcurrencyLimitForTesting(1);

    const started: number[] = [];
    const release = new Map<number, () => void>();

    const items = Array.from({ length: 3 }, (_, i) =>
      makeTask(i, "openai", "gpt-4"),
    );
    const runPromise = mapConcurrentByModel(
      items,
      (t) => getModelKey(t.model as any),
      () => 10,
      async (task) => {
        started.push(task.id);
        let releaseTask!: () => void;
        const promise = new Promise<void>((r) => (releaseTask = r));
        release.set(task.id, releaseTask);
        await promise;
        return `done-${task.id}`;
      },
    );

    await waitFor(() => started.length === 1);
    await delay(5);
    expect(started).toEqual([0]);

    // Raise cap to 3: all remaining queued tasks should start.
    reconfigureGlobalConcurrency(3);
    await waitFor(() => started.length === 3);
    expect(started.sort((a, b) => a - b)).toEqual([0, 1, 2]);

    for (const [_, resolve] of release) resolve();
    const results = await runPromise;
    expect(results.length).toBe(3);
  });
});

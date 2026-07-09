import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getModelKey,
  mapConcurrentByModel,
  _setGlobalConcurrencyLimitForTesting,
  _resetGlobalConcurrencyForTesting,
} from "./concurrency.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

    const items = Array.from({ length: 6 }, (_, i) => makeTask(i, "openai", "gpt-4"));

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
});

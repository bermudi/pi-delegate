import type { Api, Model } from "@earendil-works/pi-ai";
import { getMaxConcurrent } from "./config.ts";

// ── Module-level global concurrency cap ───────────────────────────────────
//
// `maxConcurrent` is a hard ceiling on the *total* number of subagent tasks
// that may run at once across the entire extension, not per `delegate` call.
// A single shared semaphore makes that guarantee real: multiple concurrent
// sync/async `delegate` invocations contend for the same pool of slots.

let globalConcurrencyLimit = Math.max(1, getMaxConcurrent());
let globalConcurrencyRunning = 0;
const globalConcurrencyWaiters: Array<() => void> = [];

function acquireGlobal(): Promise<void> {
  if (globalConcurrencyRunning < globalConcurrencyLimit) {
    globalConcurrencyRunning++;
    return Promise.resolve();
  }
  return new Promise<void>((r) => globalConcurrencyWaiters.push(r));
}

function releaseGlobal(): void {
  globalConcurrencyRunning--;
  if (globalConcurrencyWaiters.length > 0) {
    globalConcurrencyRunning++;
    globalConcurrencyWaiters.shift()!();
  }
}

/** Test-only hook: override the global concurrency cap. */
export function _setGlobalConcurrencyLimitForTesting(limit: number): void {
  globalConcurrencyLimit = Math.max(1, limit);
}

/** Test-only hook: reset the global semaphore to the configured cap. */
export function _resetGlobalConcurrencyForTesting(): void {
  globalConcurrencyLimit = Math.max(1, getMaxConcurrent());
  globalConcurrencyRunning = 0;
  globalConcurrencyWaiters.length = 0;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      // Deliberately do NOT check signal?.aborted here — the caller
      // (runResolvedTask) handles abort at entry and returns a proper
      // TaskResult. Early-returning here would leave results[i] as
      // undefined, causing a crash in the sync result-dereference path.
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/** Extract a model key string for concurrency grouping. Falls back to "_no_model" for actions without a model. */
export function getModelKey(model: Model<Api> | undefined): string {
  // provider/id — e.g. "openrouter/deepseek/deepseek-v4-pro"
  return model ? `${model.provider}/${model.id}` : "_no_model";
}

/**
 * Like mapConcurrent but with per-model concurrency limits.
 * Groups items by model key, runs each group with its own limit.
 * All groups run in parallel (Promise.all across groups).
 *
 * The total number of concurrently running tasks is also capped by the
 * configured `maxConcurrent` value, shared across all `delegate` invocations.
 */
export async function mapConcurrentByModel<T, R>(
  items: T[],
  getModelKey: (item: T, index: number) => string,
  getConcurrency: (modelKey: string) => number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);

  // Group items by model key, preserving original indices
  const groups = new Map<string, { indices: number[]; limit: number }>();
  for (let i = 0; i < items.length; i++) {
    const key = getModelKey(items[i]!, i);
    let group = groups.get(key);
    if (!group) {
      group = { indices: [], limit: getConcurrency(key) };
      groups.set(key, group);
    }
    group.indices.push(i);
  }

  // Run all groups in parallel, each with its own concurrency limit + global cap
  await Promise.all(
    [...groups.entries()].map(([, group]) => {
      const groupItems = group.indices.map((i) => items[i]!);
      return mapConcurrent(
        groupItems,
        group.limit,
        async (_item, localIdx) => {
          await acquireGlobal();
          try {
            const globalIdx = group.indices[localIdx]!;
            results[globalIdx] = await fn(_item, globalIdx);
            return results[globalIdx];
          } finally {
            releaseGlobal();
          }
        },
        signal,
      );
    }),
  );
  return results;
}

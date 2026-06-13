import type { Api, Model } from "@mariozechner/pi-ai";

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
 */
export async function mapConcurrentByModel<T, R>(
  items: T[],
  getModelKey: (item: T, index: number) => string,
  getConcurrency: (modelKey: string) => number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
  maxTotal?: number,
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

  // Global semaphore — caps total concurrent tasks across all model groups
  let totalRunning = 0;
  const totalWaiters: Array<() => void> = [];
  const acquireTotal = async () => {
    if (!maxTotal || totalRunning < maxTotal) {
      totalRunning++;
      return;
    }
    await new Promise<void>((r) => totalWaiters.push(r));
  };
  const releaseTotal = () => {
    totalRunning--;
    if (totalWaiters.length > 0) {
      totalRunning++;
      totalWaiters.shift()!();
    }
  };

  // Run all groups in parallel, each with its own concurrency limit + global cap
  await Promise.all(
    [...groups.entries()].map(([, group]) => {
      const groupItems = group.indices.map((i) => items[i]!);
      return mapConcurrent(
        groupItems,
        group.limit,
        async (_item, localIdx) => {
          await acquireTotal();
          try {
            const globalIdx = group.indices[localIdx]!;
            results[globalIdx] = await fn(_item, globalIdx);
            return results[globalIdx];
          } finally {
            releaseTotal();
          }
        },
        signal,
      );
    }),
  );
  return results;
}

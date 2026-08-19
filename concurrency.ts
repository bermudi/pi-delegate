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

interface GlobalWaiter {
  /** Resolve with `true` when a slot was acquired, `false` when the signal
   *  aborted while queued (the caller must not release a slot it never held). */
  resolve: (acquired: boolean) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

const globalConcurrencyWaiters: GlobalWaiter[] = [];

/**
 * Acquire a global concurrency slot.
 *
 * Resolves `true` when a slot is held (caller must pair with `releaseGlobal`),
 * or `false` when `signal` aborted before a slot could be acquired. Waiters are
 * abort-aware: an abort removes the queued waiter immediately and resolves
 * `false`, so a cancelled ticket is not stranded in "cancelling" until some
 * unrelated task happens to release capacity. The caller still invokes its fn
 * on `false` — the production fn (runResolvedTask) observes the aborted signal
 * at entry and returns an "Aborted" TaskResult without consuming a slot.
 */
function acquireGlobal(signal?: AbortSignal): Promise<boolean> {
  // Already aborted: never queue (a slot would be wasted on a task that can
  // only report Aborted) and never increment — nothing to release later.
  if (signal?.aborted) return Promise.resolve(false);
  if (globalConcurrencyRunning < globalConcurrencyLimit) {
    globalConcurrencyRunning++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const waiter: GlobalWaiter = {
      resolve,
      signal,
      onAbort: () => {
        // Remove ourselves from the queue without taking a slot. The caller's
        // fn sees the aborted signal at entry and settles promptly.
        const index = globalConcurrencyWaiters.indexOf(waiter);
        if (index === -1) return; // already woken by releaseGlobal
        globalConcurrencyWaiters.splice(index, 1);
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        resolve(false);
      },
    };
    if (signal) {
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    globalConcurrencyWaiters.push(waiter);
  });
}

function removeAbortedWaiters(): void {
  while (
    globalConcurrencyWaiters.length > 0 &&
    globalConcurrencyWaiters[0]!.signal?.aborted
  ) {
    const w = globalConcurrencyWaiters.shift()!;
    w.signal?.removeEventListener("abort", w.onAbort);
    w.resolve(false);
  }
}

/** Wake the next eligible waiter if capacity allows. Returns true if a slot was
 *  handed out (and `globalConcurrencyRunning` already incremented). */
function wakeNextWaiter(): boolean {
  removeAbortedWaiters();
  if (
    globalConcurrencyWaiters.length === 0 ||
    globalConcurrencyRunning >= globalConcurrencyLimit
  ) {
    return false;
  }
  const w = globalConcurrencyWaiters.shift()!;
  globalConcurrencyRunning++;
  w.signal?.removeEventListener("abort", w.onAbort);
  w.resolve(true);
  return true;
}

function releaseGlobal(): void {
  globalConcurrencyRunning--;
  wakeNextWaiter();
}

/** Safely change the global concurrency cap at runtime.
 *
 *  Newly queued tasks observe the new limit immediately; already-running tasks
 *  keep their slots. If the limit was raised, this wakes as many eligible
 *  queued waiters as the new cap allows. Malformed limits fall back to 1. */
export function reconfigureGlobalConcurrency(limit: number): void {
  const safe =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? limit
      : 1;
  globalConcurrencyLimit = Math.max(1, safe);
  while (wakeNextWaiter()) {
    // Wake up to the new limit.
  }
}

/** Test-only hook: override the global concurrency cap. */
export function _setGlobalConcurrencyLimitForTesting(limit: number): void {
  reconfigureGlobalConcurrency(limit);
}

/** Test-only hook: reset the global semaphore to the configured cap. */
export function _resetGlobalConcurrencyForTesting(): void {
  reconfigureGlobalConcurrency(getMaxConcurrent());
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
  const safeConcurrency =
    typeof concurrency === "number" &&
    Number.isFinite(concurrency) &&
    concurrency > 0
      ? concurrency
      : 1;
  const limit = Math.max(1, Math.min(safeConcurrency, items.length));
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
  // Promise.all would reject as soon as one task throws while sibling workers
  // are still unwinding. Wait for every worker first so callers can safely use
  // this promise as the batch-settled barrier (notably shutdown telemetry).
  const outcomes = await Promise.allSettled(
    Array.from({ length: limit }, () => worker()),
  );
  const rejection = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (rejection) throw rejection.reason;
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

  // Run all groups in parallel, each with its own concurrency limit + global cap.
  // As above, wait for every group before surfacing an unexpected rejection so
  // a late sibling cannot mutate a ticket after its completion barrier resolves.
  const outcomes = await Promise.allSettled(
    [...groups.entries()].map(([, group]) => {
      const groupItems = group.indices.map((i) => items[i]!);
      return mapConcurrent(
        groupItems,
        group.limit,
        async (_item, localIdx) => {
          const globalIdx = group.indices[localIdx]!;
          const acquired = await acquireGlobal(signal);
          if (!acquired) {
            // Aborted while queued for a global slot: we hold no slot, so we
            // must NOT release one. Still invoke fn — runResolvedTask observes
            // the aborted signal at entry and returns an "Aborted" TaskResult,
            // keeping the results array dense for the sync dereference path
            // (the same contract as mapConcurrent's worker loop).
            results[globalIdx] = await fn(_item, globalIdx);
            return results[globalIdx];
          }
          try {
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
  const rejection = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (rejection) throw rejection.reason;
  return results;
}

import { describe, expect, test } from "bun:test";
import { GenerationCache } from "./host-cache.ts";

/**
 * The generation guard is the whole reason this is a class rather than a Map.
 * Its job is to make an invalidation that lands *mid-build* safe, which is not
 * a hypothetical: a delegate dispatch invalidates the cache while previous
 * background work may still be building deps for the same key.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("GenerationCache", () => {
  test("caches by key and only builds once", async () => {
    const cache = new GenerationCache<string>();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return "value";
    };

    expect(await cache.resolve("k", true, build)).toBe("value");
    expect(await cache.resolve("k", true, build)).toBe("value");
    expect(builds).toBe(1);
  });

  test("concurrent callers share one in-flight build", async () => {
    const cache = new GenerationCache<string>();
    const gate = deferred<void>();
    let builds = 0;
    const build = async () => {
      builds += 1;
      await gate.promise;
      return "value";
    };

    const first = cache.resolve("k", true, build);
    const second = cache.resolve("k", true, build);
    gate.resolve();
    expect(await first).toBe("value");
    expect(await second).toBe("value");
    expect(builds).toBe(1);
  });

  test("an uncacheable call is never stored or shared", async () => {
    const cache = new GenerationCache<number>();
    let builds = 0;
    const build = async () => ++builds;

    expect(await cache.resolve("k", false, build)).toBe(1);
    expect(await cache.resolve("k", false, build)).toBe(2);
    // Nothing was published, so a later cacheable call still has to build.
    expect(await cache.resolve("k", true, build)).toBe(3);
    expect(await cache.resolve("k", true, build)).toBe(3);
  });

  test("a build invalidated mid-flight returns to its caller but is not published", async () => {
    const cache = new GenerationCache<string>();
    const gate = deferred<void>();
    const stale = cache.resolve("k", true, async () => {
      await gate.promise;
      return "stale";
    });

    cache.invalidate();
    gate.resolve();
    // The caller that asked for it still gets it — cancelling an in-flight
    // build is not this class's job.
    expect(await stale).toBe("stale");
    // But it must not have poisoned the cache for the next dispatch.
    expect(await cache.resolve("k", true, async () => "fresh")).toBe("fresh");
  });

  test("a stale build settling late does not delete a newer in-flight marker", async () => {
    const cache = new GenerationCache<string>();
    const staleGate = deferred<void>();
    const freshGate = deferred<void>();

    const stale = cache.resolve("k", true, async () => {
      await staleGate.promise;
      return "stale";
    });
    cache.invalidate();

    let freshBuilds = 0;
    const fresh = cache.resolve("k", true, async () => {
      freshBuilds += 1;
      await freshGate.promise;
      return "fresh";
    });

    // Stale settles first, which is exactly the ordering that used to let the
    // older promise clear the newer generation's in-flight marker.
    staleGate.resolve();
    expect(await stale).toBe("stale");

    const joined = cache.resolve("k", true, async () => {
      freshBuilds += 1;
      return "second-fresh-build";
    });
    freshGate.resolve();

    expect(await fresh).toBe("fresh");
    expect(await joined).toBe("fresh");
    expect(freshBuilds).toBe(1);
  });

  test("values() exposes cached entries only", async () => {
    const cache = new GenerationCache<string>();
    const gate = deferred<void>();
    await cache.resolve("settled", true, async () => "a");
    const pending = cache.resolve("pending", true, async () => {
      await gate.promise;
      return "b";
    });

    expect([...cache.values()]).toEqual(["a"]);
    gate.resolve();
    await pending;
    expect([...cache.values()].sort()).toEqual(["a", "b"]);

    cache.invalidate();
    expect([...cache.values()]).toEqual([]);
  });

  test("a falsy cached value is returned as a valid cache hit", async () => {
    const cache = new GenerationCache<number>();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return 0;
    };

    expect(await cache.resolve("k", true, build)).toBe(0);
    // A truthiness check would miss the cached 0 and rebuild.
    expect(await cache.resolve("k", true, build)).toBe(0);
    expect(builds).toBe(1);
  });
});

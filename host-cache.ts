/**
 * A generation-guarded async memo.
 *
 * Host deps are expensive (`ResourceLoader.reload()` is ~1.2s cold) and are
 * shared across the parallel tasks of a single delegate dispatch, then thrown
 * away so the next dispatch observes edits to auth, models, settings, and
 * context files. That gives three requirements the plain
 * `Map<string, Promise<T>>` pattern does not meet:
 *
 *   - **in-flight dedup** — concurrent tasks with the same key must await one
 *     build, not start N reloads;
 *   - **generation guard** — an invalidation during a build must not let that
 *     older build install its now-stale value, nor let it delete the in-flight
 *     marker a newer build has since installed for the same key;
 *   - **one invalidation path** — every reset goes through `invalidate()`.
 *     Before this was factored out, two test-only helpers cleared the maps
 *     directly without bumping the generation, leaving exactly the stale-write
 *     window the guard exists to close.
 */
export class GenerationCache<T> {
  private entries = new Map<string, T>();
  private inflight = new Map<string, Promise<T>>();
  private generation = 0;

  /**
   * Return the cached value for `key`, joining an in-flight build or starting
   * one. When `cacheable` is false the value is built and returned without ever
   * being stored or shared.
   */
  async resolve(
    key: string,
    cacheable: boolean,
    build: () => Promise<T>,
  ): Promise<T> {
    if (!cacheable) return build();

    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const generation = this.generation;
    const promise = build().then((value) => {
      // A build that outlived its generation is stale by definition; return it
      // to its own caller but never publish it.
      if (this.generation === generation) this.entries.set(key, value);
      return value;
    });
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      // An invalidation can let a newer generation install its own in-flight
      // build for this key. Never let the older promise delete that marker.
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }

  /** Drop every cached and in-flight value, invalidating builds already running. */
  invalidate(): void {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
  }

  /** Cached values only — in-flight builds are not observable here. */
  values(): Iterable<T> {
    return this.entries.values();
  }
}

/**
 * Shared, lazily-cached construction of the heavy pi-coding-agent deps that
 * `createAgentSession` needs but the extension's `ExtensionContext` does not
 * expose directly.
 *
 * `DefaultResourceLoader.reload()` is the one expensive step (~1.2s cold — it
 * scans for skills, prompts, agents.md files, system prompts). It is a
 * read-only cache: `_buildRuntime` only reads `resourceLoader.getExtensions()`
 * and the prompt/skill getters, none of which mutate. We benchmarked this as
 * safe to share across concurrent subagent sessions, so we build the deps
 * exactly once per (cwd + systemPrompt) and hand the same instances to every
 * subagent with that combo.
 *
 * The `authStorage` / `settingsManager` / `resourceLoader` are pi-delegate-
 * owned siblings reading the same on-disk files under `~/.pi/agent` as the
 * parent. The `modelRegistry` is *not* built here — it is the extension's
 * `ctx.modelRegistry` (shared with the parent), threaded through to
 * `createAgentSession` directly by the caller.
 */
import {
  AuthStorage,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";

export interface HostDeps {
  authStorage: AuthStorage;
  settingsManager: SettingsManager;
  resourceLoader: ResourceLoader;
}

export interface HostDepsOptions {
  /** Working directory for project-local resource discovery. */
  cwd: string;
  /** Global config directory. Defaults to `~/.pi/agent`. */
  agentDir?: string;
  /**
   * Custom system prompt for a named agent. When set, it overrides the default
   * system prompt the resource loader would otherwise discover. The resource
   * loader is cached per (cwd + systemPrompt): the expensive `reload()` (skills,
   * AGENTS.md discovery) runs once per distinct combo, then is reused across all
   * concurrent subagents with the same cwd + prompt. For ad-hoc tasks (no
   * named agent) pass undefined to share the per-cwd default-prompt loader.
   */
  systemPrompt?: string;
}

const hostDepsCache = new Map<string, HostDeps>();
/** In-flight builds, so concurrent calls for the same key share one reload(). */
const hostDepsInflight = new Map<string, Promise<HostDeps>>();

/**
 * Test-only flag: when set, every newly-built settingsManager reports a small
 * retry base delay so retry integration tests don't sleep real seconds. Set
 * via `_setHostRetryBaseMsForTesting`. Module-scoped so it also covers hosts
 * built after the flag is set (the first run in a test).
 */
let testRetryBaseMs: number | undefined;

/**
 * Lazily build and cache the shared host deps for a (cwd + systemPrompt) combo.
 * The first call pays the `resourceLoader.reload()` cost (~1.2s). Concurrent
 * calls for the same key await the same in-flight promise rather than racing a
 * duplicate reload. Subsequent calls return the cached result.
 */
export async function getHostDeps(options: HostDepsOptions): Promise<HostDeps> {
  const key = `${options.cwd}\0${options.systemPrompt ?? ""}`;
  const cached = hostDepsCache.get(key);
  if (cached) return cached;

  // Another call is already building this key — await its promise.
  const inflight = hostDepsInflight.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<HostDeps> => {
    const agentDir = options.agentDir ?? getAgentDir();
    const authStorage = AuthStorage.create();
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    if (testRetryBaseMs !== undefined) {
      installFastRetry(settingsManager, testRetryBaseMs);
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      // When a named agent supplies a custom prompt, it becomes the loader's
      // customPrompt — overriding the default system prompt AgentSession would
      // otherwise build. `systemPrompt` (the source) wins over file discovery.
      ...(options.systemPrompt !== undefined
        ? { systemPrompt: options.systemPrompt }
        : {}),
    });
    await resourceLoader.reload();

    const deps: HostDeps = { authStorage, settingsManager, resourceLoader };
    hostDepsCache.set(key, deps);
    return deps;
  })();

  hostDepsInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    // Clear the in-flight marker whether it succeeded or threw; the cache holds
    // the result on success, and a failure leaves nothing for a retry to reuse.
    hostDepsInflight.delete(key);
  }
}

/** Patch a settingsManager to report a fixed (small) retry base delay. */
function installFastRetry(sm: SettingsManager, baseDelayMs: number): void {
  sm.getRetrySettings = (() => ({
    enabled: true,
    maxRetries: 3,
    baseDelayMs,
  })) as never;
}

/** Test-only: clear the cache so a fresh (cwd, prompt) gets re-built. */
export function _resetHostDepsCacheForTesting(): void {
  hostDepsCache.clear();
  hostDepsInflight.clear();
}

/**
 * Test-only: shrink the retry backoff on every cached + future settingsManager
 * so retry integration tests don't sleep real seconds. AgentSession owns retry
 * (strip-and-continue with exponential backoff), and the only knob is the
 * shared settingsManager that `createAgentSession` reads — so this is the
 * single chokepoint for making retry fast in tests.
 *
 * Pass `undefined` to restore: this clears the cache (existing patched managers
 * can't be un-patched in place, so they're dropped and rebuilt fresh on next
 * use). Tests that reuse a cwd across beforeEach/afterEach cycles must pair
 * this with `_resetHostDepsCacheForTesting()` to guarantee an unpatched rebuild.
 */
export function _setHostRetryBaseMsForTesting(
  baseDelayMs: number | undefined,
): void {
  testRetryBaseMs = baseDelayMs;
  if (baseDelayMs === undefined) {
    // Restore: drop patched managers. The `testRetryBaseMs` flag (cleared above)
    // ensures newly-built ones come back unpatched.
    hostDepsCache.clear();
    hostDepsInflight.clear();
    return;
  }
  for (const deps of hostDepsCache.values()) {
    installFastRetry(deps.settingsManager, baseDelayMs);
  }
}

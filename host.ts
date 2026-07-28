/**
 * Shared, lazily-cached construction of the heavy pi-coding-agent deps that
 * `createAgentSession` needs but the extension's `ExtensionContext` does not
 * expose directly.
 *
 * `DefaultResourceLoader.reload()` is the one expensive step (~1.2s cold — it
 * scans for skills, prompts, agents.md files, system prompts). It is a
 * read-only cache for the parts we care about: skills, AGENTS.md/context files,
 * and the system prompt. `_buildRuntime` reads `resourceLoader.getExtensions()`
 * and the prompt/skill getters.
 *
 * **Extensions are disabled for subagents** (`noExtensions: true`). Subagents
 * are headless workers spawned by the parent's delegate tool — they must not
 * run the parent's interactive extensions (custom UI, slash commands, hooks
 * that call `pi.appendEntry()`/`pi.sendMessage()`). This also closes the
 * cross-wiring risk flagged in review: `AgentSession._buildRuntime` hands the
 * loader's shared `extensionsResult.runtime` to a new `ExtensionRunner`, whose
 * `bindCore()` overwrites mutable methods on that runtime (`sendMessage`,
 * `appendEntry`, `setSessionName`, …). With no extensions loaded there are no
 * handlers bound to those methods, so sharing the cached loader across live
 * sessions is safe — the runtime is mutated but never read by extension code.
 * `extendResourcesFromExtensions()` also early-returns when there are no
 * `resources_discover` handlers, so extension-discovered skills/prompts cannot
 * leak across sessions. We therefore build the deps exactly once per
 * (cwd + systemPrompt) and hand the same instances to every subagent with
 * that combo.
 *
 * The `modelRuntime` / `settingsManager` / `resourceLoader` are pi-delegate-
 * owned siblings reading the same on-disk files under `~/.pi/agent` as the
 * parent. Since pi 0.80.8, `createAgentSession` takes a single `modelRuntime`
 * (the unified model + auth runtime) in place of the removed `authStorage` /
 * `modelRegistry` options, so the runtime is built and cached here from
 * `~/.pi/agent/{auth,models}.json`. The parent's `ctx.modelRegistry` is still
 * threaded by the caller, but only for *model selection* in task-resolution —
 * not for `createAgentSession`.
 */
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

export interface HostDeps {
  modelRuntime: ModelRuntime;
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
 * Test-only override for the ModelRuntime factory. When set, `getHostDeps`
 * uses it instead of `ModelRuntime.create` — so integration tests can feed
 * subagents a pre-authenticated runtime (e.g. the parent session's
 * `modelRuntime`) and stub auth. Since pi 0.80.8, subagents build their own
 * `modelRuntime` rather than sharing the parent's registry, so without this
 * seam a test can't reach the subagent's auth path.
 */
let testModelRuntimeFactory: (() => Promise<ModelRuntime>) | undefined;

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
    // Canonical model/auth runtime — the 0.80.8+ successor to the separate
    // `authStorage` + `modelRegistry` options. Built once per (cwd + systemPrompt)
    // and shared across concurrent subagents, exactly like the resource loader.
    // Reads the same ~/.pi/agent/{auth,models}.json the parent uses, so auth
    // resolution stays consistent without threading the parent's registry.
    // In tests, `_setModelRuntimeFactoryForTesting` can substitute a runtime.
    const modelRuntime = testModelRuntimeFactory
      ? await testModelRuntimeFactory()
      : await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
          // Subagents receive an explicit model (resolved by the parent), so they
          // never need remote model-catalog discovery. Skipping the network
          // availability refresh makes the first call per cwd faster and
          // offline-safe; auth (getAuth) still reads auth.json directly.
          allowModelNetwork: false,
        });
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    if (testRetryBaseMs !== undefined) {
      installFastRetry(settingsManager, testRetryBaseMs);
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      // Subagents are headless workers — they must not load the parent's
      // interactive extensions. This also neutralizes the shared-runtime
      // cross-wiring risk (see module doc): with no extensions, no handlers
      // bind to the mutated runtime methods, so the cached loader is safe to
      // share across live sessions.
      noExtensions: true,
      // When a named agent supplies a custom prompt, it becomes the loader's
      // customPrompt — overriding the default system prompt AgentSession would
      // otherwise build. `systemPrompt` (the source) wins over file discovery.
      ...(options.systemPrompt !== undefined
        ? { systemPrompt: options.systemPrompt }
        : {}),
    });
    await resourceLoader.reload();

    const deps: HostDeps = { modelRuntime, settingsManager, resourceLoader };
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
 * Test-only: substitute the ModelRuntime factory. Pass a factory returning a
 * pre-authenticated runtime (e.g. the parent session's `modelRuntime`) so
 * subagents reuse it and a test can stub auth; pass `undefined` to restore the
 * real `ModelRuntime.create` path. Clears the deps cache either way so the
 * next build respects the change.
 */
export function _setModelRuntimeFactoryForTesting(
  factory: (() => Promise<ModelRuntime>) | undefined,
): void {
  testModelRuntimeFactory = factory;
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

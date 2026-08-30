/**
 * Shared, lazily-cached construction of the heavy pi-coding-agent deps that
 * `createAgentSession` needs but the extension's `ExtensionContext` does not
 * expose directly.
 *
 * `DefaultResourceLoader.reload()` is the one expensive step (~1.2s cold — it
 * scans for skills, prompts, agents.md files, system prompts). It is a
 * read-only cache for the parts we care about: skills, project AGENTS.md/context
 * files, and the system prompt. Global context is filtered at this seam so a
 * child cannot inherit the parent's user-global instructions. `_buildRuntime`
 * reads `resourceLoader.getExtensions()`
 * and the prompt/skill getters.
 *
 * **Extensions are disabled for subagents by default** (`noExtensions: true`).
 * Subagents are headless workers spawned by the parent's delegate tool — they
 * must not run the parent's interactive extensions (custom UI, slash commands,
 * hooks that call `pi.appendEntry()`/`pi.sendMessage()`). A narrow,
 * provider-scoped allowlist is injected as `additionalExtensionPaths` for
 * provider-specific integrations (best-effort for shipped defaults); resolving
 * and verifying that allowlist lives in `provider-extensions.ts`. Those
 * extension-bearing dependencies are
 * deliberately built per session: `AgentSession._buildRuntime` hands the
 * loader's `extensionsResult.runtime` to a new `ExtensionRunner`, whose
 * `bindCore()` overwrites mutable methods on that runtime (`sendMessage`,
 * `appendEntry`, `setSessionName`, …). Sharing that loader would redirect one
 * session's extension calls into another session. Only extension-free deps are
 * cached and shared.
 *
 * The `modelRuntime` / `settingsManager` / `resourceLoader` are pi-delegate-
 * owned siblings reading the same on-disk files under `~/.pi/agent` as the
 * parent. Since pi 0.80.8, `createAgentSession` takes a single `modelRuntime`
 * (the unified model + auth runtime) in place of the removed `authStorage` /
 * `modelRegistry` options, so the runtime is built here from
 * `~/.pi/agent/{auth,models}.json`. Runtime-only providers are then copied from
 * the parent's registry into this child runtime; extensions remain disabled
 * unless explicitly allowlisted. The parent's `ctx.modelRegistry` is also
 * threaded by the caller for model selection in task-resolution.
 */
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
  type ProviderConfig,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { getSubagentProviderExtensionMap } from "./config.ts";
import { GenerationCache } from "./host-cache.ts";
import {
  clearMissingProviderExtensionCache,
  getProviderExtensionPaths,
  noticeProviderExtensionLoaded,
  partitionExtensionLoadFailures,
} from "./provider-extensions.ts";

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
   * Provider registrations owned by the parent extension runtime. Subagents
   * intentionally load no extensions, so runtime-only providers (for example
   * Kilo) must be registered explicitly for their auth/config to resolve.
   */
  providerConfigs?: ReadonlyArray<readonly [string, ProviderConfig]>;
  /**
   * Model provider of the current task (e.g. `openai-codex`). Used to apply
   * provider-scoped extension loading for subagents. The default behavior still
   * keeps extension loading disabled for safety. Allowlisted extensions must be
   * installed in the user scope; project-local installations are rejected.
   */
  modelProvider?: string;
  /**
   * Custom system prompt for a named agent. When set, it overrides the default
   * system prompt the resource loader would otherwise discover. Extension-free
   * host deps are cached per (agentDir + cwd + systemPrompt): the expensive
   * `reload()` (skills, project AGENTS.md discovery) runs once per distinct combo, then
   * is reused across concurrent subagents. Provider-configured or
   * allowlisted-extension tasks always receive fresh host deps. For inline
   * tasks (no named agent) pass undefined to use the discovered prompt.
   */
  systemPrompt?: string;
  /** Dispatch-scoped delegate.json snapshot for the provider-extension allowlist. */
  delegateConfig?: import("./config.ts").DelegateConfig;
}

const hostDepsCache = new GenerationCache<HostDeps>();

const CONTEXT_FILE_NAMES = new Set([
  "agents.override.md",
  "agents.md",
  "claude.override.md",
  "claude.md",
]);

/**
 * Delegate workers deliberately do not inherit user-global context files.
 * Pi's standard global file lives under `agentDir`; `.agents/AGENTS.md` is a
 * legacy convention used by other coding-agent harnesses. Compare lexical
 * paths here rather than canonical paths: a user's global file is commonly a
 * symlink, and the ResourceLoader reports the path it discovered, not its
 * symlink target.
 */
function isExcludedGlobalContextFile(
  filePath: string,
  agentDir: string,
): boolean {
  const resolvedFilePath = resolve(filePath);
  const roots = [resolve(agentDir), resolve(homedir(), ".agents")];
  return roots.some((root) => {
    const relativePath = relative(root, resolvedFilePath);
    return CONTEXT_FILE_NAMES.has(relativePath.toLowerCase());
  });
}

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
 * `modelRuntime`; the explicit provider-config seam keeps runtime-only
 * providers available without loading extensions in the child.
 */
let testModelRuntimeFactory: (() => Promise<ModelRuntime>) | undefined;

/**
 * Lazily build the host deps for a task. Extension-free, provider-independent
 * deps are cached by (agentDir, cwd, systemPrompt) within one delegate dispatch;
 * the extension invalidates the generation before the next dispatch so file
 * edits become visible. Provider registrations and allowlisted extensions get
 * a private dependency graph for every session.
 *
 * The first cached call pays the `resourceLoader.reload()` cost (~1.2s). An
 * extension-bearing call intentionally pays that cost again: sharing its
 * ResourceLoader would share Pi's mutable extension runtime and let
 * `ExtensionRunner.bindCore()` redirect one session's extension callbacks into
 * another session.
 */
export async function getHostDeps(options: HostDepsOptions): Promise<HostDeps> {
  const agentDir = options.agentDir ?? getAgentDir();
  const providerConfigs = options.providerConfigs ?? [];

  // Resolve provider extensions before deciding whether to use the cache: the
  // answer determines cacheability. User-configured sources fail closed when
  // missing; shipped defaults silently drop instead.
  const { paths: extensionRoots, bestEffortPaths: bestEffortRoots } =
    await getProviderExtensionPaths(
      options.modelProvider,
      options.cwd,
      agentDir,
      options.delegateConfig,
    );

  // Provider configs may contain functions (custom stream/OAuth handlers), so a
  // stringified value cannot safely identify them. Do not cache any call that
  // registers one; each call gets the exact config object supplied by its
  // caller. The same rule is used for extension-bearing calls because their
  // extension runtime is mutable and session-owned.
  const cacheable = providerConfigs.length === 0 && extensionRoots.length === 0;

  return hostDepsCache.resolve(
    hostDepsCacheKey(options, agentDir),
    cacheable,
    async () => {
      const modelRuntime = await buildModelRuntime(agentDir, providerConfigs);
      const settingsManager = SettingsManager.create(options.cwd, agentDir, {
        projectTrusted: false,
      });
      if (testRetryBaseMs !== undefined) {
        installFastRetry(settingsManager, testRetryBaseMs);
      }
      const resourceLoader = await loadChildResources(options, agentDir, {
        settingsManager,
        extensionRoots,
        bestEffortRoots,
      });
      return { modelRuntime, settingsManager, resourceLoader };
    },
  );
}

/**
 * Cache identity for a set of host deps. Everything that changes what
 * `reload()` discovers must appear here — including the configured extension
 * allowlist, since editing it changes what a subsequent build would inject.
 */
function hostDepsCacheKey(options: HostDepsOptions, agentDir: string): string {
  const providerExtensions = getSubagentProviderExtensionMap(
    options.delegateConfig,
  );
  return JSON.stringify({
    agentDir,
    cwd: options.cwd,
    systemPrompt:
      options.systemPrompt === undefined
        ? { source: "discovered" }
        : { source: "explicit", value: options.systemPrompt },
    modelProvider: options.modelProvider ?? "",
    providerExtensionSignature: Object.entries(providerExtensions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => [provider, [...entries]] as const),
  });
}

/**
 * Canonical model/auth runtime — the 0.80.8+ successor to the separate
 * `authStorage` + `modelRegistry` options. It is shared only on the cacheable,
 * extension-free path; provider-specific sessions get their own runtime so all
 * stateful host dependencies have the same ownership. Reads the same
 * `~/.pi/agent/{auth,models}.json` the parent uses, so stored credentials stay
 * consistent.
 */
async function buildModelRuntime(
  agentDir: string,
  providerConfigs: ReadonlyArray<readonly [string, ProviderConfig]>,
): Promise<ModelRuntime> {
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
  for (const [providerId, config] of providerConfigs) {
    modelRuntime.registerProvider(providerId, config);
  }
  return modelRuntime;
}

/**
 * Build the child ResourceLoader, retrying without any best-effort extension
 * root that failed to load.
 *
 * A dropped default leaves the subagent extension-free on Pi's native
 * compaction — silently, per the drop-site rationale in `provider-extensions`.
 * User-configured roots still fail closed.
 *
 * Loop invariant: pi's `ResourceLoader.reload()` never *throws* for an
 * extension's own failure — its loader wraps module import AND factory
 * invocation in try/catch and returns them as `extensionsResult.errors`
 * (verified in pi 0.80.x, core/extensions/loader.ts). A reload() throw is
 * therefore environmental (settings reload, package resolution) and not
 * attributable to any supplied root; letting it propagate is correct even when
 * best-effort roots are present.
 */
async function loadChildResources(
  options: HostDepsOptions,
  agentDir: string,
  deps: {
    settingsManager: SettingsManager;
    extensionRoots: readonly string[];
    bestEffortRoots: ReadonlySet<string>;
  },
): Promise<ResourceLoader> {
  let extensionPaths = [...deps.extensionRoots];
  for (;;) {
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager: deps.settingsManager,
      // Subagents are headless workers — they must not load the parent's
      // interactive extension inventory. The only paths supplied here are
      // the explicitly allowlisted, user-scoped provider extensions.
      noExtensions: true,
      // Global AGENTS.md files describe the parent harness, not the
      // delegated task. Keep cwd/ancestor project context discovery, but
      // remove Pi's global file and the legacy ~/.agents equivalent. This
      // override also handles symlinked global files because it compares
      // discovered paths.
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: agentsFiles.filter(
          ({ path: contextPath }) =>
            !isExcludedGlobalContextFile(contextPath, agentDir),
        ),
      }),
      ...(extensionPaths.length
        ? { additionalExtensionPaths: extensionPaths }
        : {}),
      // When a named agent supplies a custom prompt, it becomes the loader's
      // customPrompt — overriding the default system prompt AgentSession
      // would otherwise build. `systemPrompt` (the source) wins over file
      // discovery.
      ...(options.systemPrompt !== undefined
        ? { systemPrompt: options.systemPrompt }
        : {}),
    });
    await resourceLoader.reload();

    const extensionsResult = resourceLoader.getExtensions();
    const { fatalCount, droppableRoots } = partitionExtensionLoadFailures({
      extensionPaths,
      loadedExtensionPaths: extensionsResult.extensions.map(
        (extension) => extension.resolvedPath || extension.path,
      ),
      extensionErrors: extensionsResult.errors,
      bestEffortRoots: deps.bestEffortRoots,
    });
    if (fatalCount > 0) {
      const providerName =
        options.modelProvider?.trim() || "the selected provider";
      throw new Error(
        `Failed to load ${fatalCount} allowlisted provider extension(s) for ${providerName}; delegation stopped instead of running without the required integration.`,
      );
    }

    if (droppableRoots.length > 0) {
      extensionPaths = extensionPaths.filter(
        (root) => !droppableRoots.includes(root),
      );
      continue;
    }

    // Positive visibility for the invisible-by-design path: surviving
    // best-effort roots each produced at least one loaded extension, and that
    // changes subagent behavior without any user action — the one state worth
    // a notice. Once per process per provider+root.
    for (const root of extensionPaths) {
      if (deps.bestEffortRoots.has(root)) {
        noticeProviderExtensionLoaded(options.modelProvider, root);
      }
    }
    return resourceLoader;
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

/**
 * Invalidate cached host dependencies before a new delegate dispatch.
 *
 * A dispatch may still share one expensive resource reload across its parallel
 * tasks, but the next dispatch observes auth, model, settings, and context-file
 * edits made while Pi remains open. Existing sessions retain their already-built
 * dependencies; clearing the maps never mutates live AgentSessions.
 */
export function invalidateHostDepsCache(): void {
  hostDepsCache.invalidate();
  clearMissingProviderExtensionCache();
}

/** Test-only alias retained for existing test setup. */
export function _resetHostDepsCacheForTesting(): void {
  invalidateHostDepsCache();
}

/**
 * Test-only: substitute the ModelRuntime factory. Pass a factory returning a
 * pre-authenticated runtime (e.g. the parent session's `modelRuntime`) so
 * subagents reuse it and a test can stub auth; pass `undefined` to restore the
 * real `ModelRuntime.create` path. Invalidates the deps cache either way so the
 * next build respects the change.
 */
export function _setModelRuntimeFactoryForTesting(
  factory: (() => Promise<ModelRuntime>) | undefined,
): void {
  testModelRuntimeFactory = factory;
  invalidateHostDepsCache();
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
    invalidateHostDepsCache();
    return;
  }
  for (const deps of hostDepsCache.values()) {
    installFastRetry(deps.settingsManager, baseDelayMs);
  }
}

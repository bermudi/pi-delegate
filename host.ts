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
 * provider-specific integrations (best-effort for shipped defaults). Those
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
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
  type ProviderConfig,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  getSubagentProviderExtensionMap,
  getSubagentProviderExtensionSourcesForProvider,
} from "./config.ts";

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
   * allowlisted-extension tasks always receive fresh host deps. For ad-hoc
   * tasks (no named agent) pass undefined to use the discovered prompt.
   */
  systemPrompt?: string;
}

const hostDepsCache = new Map<string, HostDeps>();
/** In-flight builds, so concurrent calls for the same key share one reload(). */
const hostDepsInflight = new Map<string, Promise<HostDeps>>();
/** Prevent a pre-invalidation build from repopulating or clearing newer state. */
let hostDepsCacheGeneration = 0;

function canonicalPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    // The caller normally passes an existing installed path. Keep a lexical
    // fallback for a race where it disappears between lookup and validation.
    return resolve(candidate);
  }
}

function isPathWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(
    canonicalPath(directory),
    canonicalPath(candidate),
  );
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

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
 * Whether a managed package's canonical target remains in a user install root.
 *
 * Pi's managed user installs live below `agentDir`; its legacy npm fallback
 * lives below a global `node_modules` directory. Deriving the latter from the
 * returned lexical path avoids invoking npm merely to validate a path, while
 * still rejecting a package-directory symlink whose canonical target escapes
 * that install root.
 */
function isTrustedManagedTarget(agentDir: string, userPath: string): boolean {
  const resolvedUserPath = canonicalPath(userPath);
  if (isPathWithinDirectory(agentDir, resolvedUserPath)) return true;

  const lexicalPath = resolve(userPath);
  const nodeModulesMarker = `${sep}node_modules${sep}`;
  const markerIndex = lexicalPath.lastIndexOf(nodeModulesMarker);
  if (markerIndex < 0) return false;
  const nodeModulesEnd = markerIndex + nodeModulesMarker.length - 1;
  const installRoot = lexicalPath.slice(0, nodeModulesEnd);
  return isPathWithinDirectory(installRoot, resolvedUserPath);
}

/**
 * Find the project boundary used by the extension trust check.
 *
 * `cwd` is allowed to be a package directory inside a larger checkout. Checking
 * only that exact directory makes a user-scope symlink into a sibling project
 * directory look safe. Git is the authoritative boundary when available;
 * marker directories provide a conservative fallback for projects that are not
 * Git worktrees. Returning undefined is intentional: callers then require a
 * canonical managed target to remain under the trusted user agent directory.
 */
function findExtensionProjectRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return canonicalPath(root);
  } catch {
    // Not every task cwd belongs to a Git worktree. Use project markers below.
  }

  let directory = canonicalPath(cwd);
  while (true) {
    if (
      existsSync(join(directory, ".pi", "settings.json")) ||
      existsSync(join(directory, ".pi", "agents")) ||
      (directory !== homedir() &&
        existsSync(join(directory, ".claude", "agents")))
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** Match the package-manager prefixes that are not local filesystem paths. */
function isLocalExtensionSource(source: string): boolean {
  const trimmed = source.trim().toLowerCase();
  return !["npm:", "git:", "github:", "http:", "https:", "ssh:"].some(
    (prefix) => trimmed.startsWith(prefix),
  );
}

/** Whether an npm source carries a version, range, or tag after its package name. */
function hasNpmVersionSpecifier(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed.toLowerCase().startsWith("npm:")) return false;
  const spec = trimmed.slice("npm:".length).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  return Boolean(match?.[2]?.trim());
}

/** Normalize the host/path identity emitted by Pi or read from Git. */
function normalizeGitRepositoryIdentity(
  host: string,
  repoPath: string,
): { host: string; path: string } | undefined {
  const path = repoPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !path) return undefined;
  return { host: host.toLowerCase(), path };
}

/** Parse the repository identity used by Pi's Git source parser. */
function parseGitRepositoryIdentity(
  source: string,
): { host: string; path: string } | undefined {
  let candidate = source.trim();
  if (candidate.toLowerCase().startsWith("git:")) {
    candidate = candidate.slice("git:".length).trim();
  }

  let host: string;
  let repoPath: string;
  if (candidate.startsWith("git@")) {
    const colon = candidate.indexOf(":");
    if (colon < 0) return undefined;
    host = candidate.slice("git@".length, colon);
    repoPath = candidate.slice(colon + 1);
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      host = url.host;
      repoPath = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    const slash = candidate.indexOf("/");
    if (slash < 0) return undefined;
    host = candidate.slice(0, slash);
    repoPath = candidate.slice(slash + 1);
  }

  // `@` is Pi's ref separator for the source forms that can also appear in
  // an origin URL. Do not treat `#` as a ref separator here: Pi can preserve
  // it as a literal path in generic/SCP forms, while URL parsing above already
  // removes a real URL fragment from `pathname`. Configured-source ref
  // semantics come from Pi's parsed source below.
  const refSeparator = repoPath.indexOf("@");
  if (refSeparator >= 0) repoPath = repoPath.slice(0, refSeparator);
  return normalizeGitRepositoryIdentity(host, repoPath);
}

function getGitRepositoryIdentity(
  source: string,
): { host: string; path: string } | undefined {
  const trimmed = source.trim();
  if (
    isLocalExtensionSource(trimmed) ||
    trimmed.toLowerCase().startsWith("npm:")
  ) {
    return undefined;
  }
  return parseGitRepositoryIdentity(trimmed);
}

/**
 * Read the configured Git identity and ref from Pi's own parsed package
 * source. The package manager's parser is private upstream, but
 * getInstalledPath() uses that same parser; keeping this call on the same seam
 * prevents validation from inventing a second (and subtly different) Git URL
 * grammar.
 *
 * In particular, Pi leaves `#release` in the parsed path for generic and SCP
 * sources, while hosted providers may interpret it as a ref. The parsed
 * host/path is therefore authoritative; never normalize the configured source
 * with a blanket `#` rule.
 */
function getConfiguredGitSource(
  packageManager: DefaultPackageManager,
  source: string,
): { host: string; path: string; ref?: string } | undefined {
  if (getGitRepositoryIdentity(source) === undefined) return undefined;

  const internals =
    packageManager as unknown as Partial<PackageManagerConstraintInternals>;
  if (typeof internals.parseSource !== "function") {
    throw new Error(
      "This Pi version cannot verify a configured Git provider extension ref; delegation stopped.",
    );
  }

  let parsed: unknown;
  try {
    parsed = internals.parseSource.call(packageManager, source);
  } catch (error) {
    throw new Error(
      "A configured provider extension Git source could not be parsed; delegation stopped.",
      { cause: error },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      "A configured provider extension Git source could not be verified; delegation stopped.",
    );
  }
  const parsedSource = parsed as {
    type?: unknown;
    host?: unknown;
    path?: unknown;
    ref?: unknown;
    pinned?: unknown;
  };
  if (parsedSource.type !== "git") {
    throw new Error(
      "A configured provider extension was not parsed as a Git source; delegation stopped.",
    );
  }
  if (
    typeof parsedSource.host !== "string" ||
    typeof parsedSource.path !== "string"
  ) {
    throw new Error(
      "A configured provider extension Git identity could not be verified; delegation stopped.",
    );
  }
  const repository = normalizeGitRepositoryIdentity(
    parsedSource.host,
    parsedSource.path,
  );
  if (!repository) {
    throw new Error(
      "A configured provider extension Git identity could not be verified; delegation stopped.",
    );
  }
  // `ref` and `pinned` are a security contract from Pi's private parser. If a
  // host upgrade drops either field, never reinterpret a pinned source as an
  // unpinned checkout and silently skip commit validation.
  if (typeof parsedSource.pinned !== "boolean") {
    throw new Error(
      "A configured provider extension Git pin state could not be verified; delegation stopped.",
    );
  }
  if (!parsedSource.pinned) {
    if (parsedSource.ref !== undefined) {
      throw new Error(
        "A configured provider extension Git ref could not be verified; delegation stopped.",
      );
    }
    return repository;
  }
  if (typeof parsedSource.ref !== "string" || parsedSource.ref.length === 0) {
    throw new Error(
      "A configured provider extension Git ref could not be verified; delegation stopped.",
    );
  }
  return { ...repository, ref: parsedSource.ref };
}

function gitOutput(installedPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: installedPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Reject a user installation whose checkout or ref differs from the source. */
function assertConfiguredGitInstallation(
  packageManager: DefaultPackageManager,
  source: string,
  installedPath: string,
): void {
  try {
    const configuredRepository = getConfiguredGitSource(packageManager, source);
    if (!configuredRepository) return;

    const installedRepository = parseGitRepositoryIdentity(
      gitOutput(installedPath, ["config", "--get", "remote.origin.url"]),
    );
    if (
      !installedRepository ||
      installedRepository.host !== configuredRepository.host ||
      installedRepository.path !== configuredRepository.path
    ) {
      throw new Error("checkout has a different origin");
    }

    const ref = configuredRepository.ref;
    if (!ref) return;
    const head = gitOutput(installedPath, ["rev-parse", "--verify", "HEAD"]);
    const target = gitOutput(installedPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    if (!head || head !== target) {
      throw new Error("checkout is at a different commit");
    }
  } catch (error) {
    throw new Error(
      "A configured provider extension is not checked out at its configured Git source or ref; delegation stopped.",
      { cause: error },
    );
  }
}

type PackageManagerConstraintInternals = {
  parseSource(source: string): unknown;
  installedNpmMatchesConfiguredVersion(
    source: unknown,
    installedPath: string,
  ): Promise<boolean>;
};

type ParsedNpmSource = {
  type?: unknown;
  range?: unknown;
};

/**
 * Ask Pi's package manager to apply its own npm range semantics without
 * duplicating semver logic or installing/updating anything during delegation.
 * These methods are private upstream implementation details, so fail closed if
 * a future Pi release removes or renames them rather than executing an
 * unverified installation.
 */
async function assertConfiguredNpmVersion(
  packageManager: DefaultPackageManager,
  source: string,
  installedPath: string,
): Promise<void> {
  const internals =
    packageManager as unknown as Partial<PackageManagerConstraintInternals>;
  if (
    typeof internals.parseSource !== "function" ||
    typeof internals.installedNpmMatchesConfiguredVersion !== "function"
  ) {
    throw new Error(
      "This Pi version cannot verify a configured provider extension version; delegation stopped.",
    );
  }

  let parsed: unknown;
  try {
    parsed = internals.parseSource.call(packageManager, source);
  } catch (error) {
    throw new Error(
      "A configured provider extension version could not be parsed; delegation stopped.",
      { cause: error },
    );
  }

  const parsedNpm =
    typeof parsed === "object" && parsed !== null
      ? (parsed as ParsedNpmSource)
      : undefined;
  if (parsedNpm?.type !== "npm" || typeof parsedNpm.range !== "string") {
    // Pi treats npm tags such as `@latest` as an unconstrained source when
    // checking an installed package. They are registry aliases, not
    // verifiable local version constraints, so fail closed instead of
    // accepting any stale package at the same install path.
    throw new Error(
      "A configured provider extension uses an npm tag rather than a verifiable semver range; delegation stopped.",
    );
  }

  try {
    const matches = await internals.installedNpmMatchesConfiguredVersion.call(
      packageManager,
      parsed,
      installedPath,
    );
    if (!matches) {
      throw new Error(
        "installed package does not satisfy the configured version",
      );
    }
  } catch (error) {
    throw new Error(
      "A configured provider extension version does not match the installed user-scope package; delegation stopped.",
      { cause: error },
    );
  }
}

/** Result of resolving a provider's allowlisted extension sources. */
interface ProviderExtensionResolution {
  /** User-scope package roots to inject as subagent extension paths. */
  paths: string[];
  /** Roots originating from shipped best-effort defaults; these may degrade
   * silently — see the drop-site comments for why silence is the design. */
  bestEffortPaths: Set<string>;
}

/**
 * UI notifier for the provider-extension-loaded notice, primed from
 * extension.ts `execute` (the only place the real, ui-bearing ctx exists —
 * host-dep construction itself has no UI context). Consumed defensively:
 * a throw means the ctx went stale (headless run, torn-down TUI) and simply
 * un-primes the notifier so the next live execute re-primes it.
 */
let providerExtensionNotifier: ((message: string) => void) | undefined;

/**
 * Prime the UI notifier used for the best-effort extension-loaded notice.
 * Idempotent and cheap; called at the top of every delegate execute. Pass
 * `undefined` to un-prime (tests) — an un-primed notifier makes the notice a
 * no-op, which is also the default state in headless/test runs.
 */
export function registerProviderExtensionNotifier(
  notify: ((message: string) => void) | undefined,
): void {
  providerExtensionNotifier = notify;
}

/** provider+root pairs already noticed this process. */
const noticedProviderExtensionRoots = new Set<string>();

/**
 * Announce that a shipped best-effort provider integration actually loaded
 * for delegated subagents. This is the deliberate inverse of the silent
 * drop: absence of an optional integration is normal and never mentioned,
 * but a default that IS active changes subagent behavior (remote compaction
 * on codex models) invisibly — so it gets one info notice per process per
 * provider+root, not one per dispatch. User-configured sources never get
 * here: the user installed them knowingly and they fail closed.
 */
function noticeProviderExtensionLoaded(
  provider: string | undefined,
  root: string,
): void {
  const providerName = provider?.trim() || "provider";
  const key = `${providerName.toLowerCase()}\0${root}`;
  if (noticedProviderExtensionRoots.has(key)) return;
  const notify = providerExtensionNotifier;
  if (!notify) return;
  const label = basename(root) || root;
  try {
    notify(`⚡ ${label} integration active for ${providerName} subagents`);
    noticedProviderExtensionRoots.add(key);
  } catch {
    // Cosmetic notice on a stale ctx — fail open (status.ts precedent for
    // cached-ctx notify): drop the notifier, keep the key un-noticed so a
    // live ctx can still surface it later. Delegation is unaffected.
    providerExtensionNotifier = undefined;
  }
}

async function getProviderExtensionPaths(
  provider: string | undefined,
  cwd: string,
  agentDir: string,
  packageLookupSettingsManager: SettingsManager,
): Promise<ProviderExtensionResolution> {
  // Provider-key normalization (trim + lowercase) lives in `config.ts` — the
  // sources getter is the single owner of that logic, so this module never
  // re-implements it. Provenance (required vs best-effort) is decided there
  // too, by config presence: user-listed sources fail closed; shipped
  // defaults degrade silently — the extension-free path is Pi's normal
  // operation, not a warning condition.
  const requested = getSubagentProviderExtensionSourcesForProvider(provider);
  if (!requested.length)
    return { paths: [], bestEffortPaths: new Set<string>() };

  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: packageLookupSettingsManager,
  });
  const projectRoot = findExtensionProjectRoot(cwd);

  const validateInstalledPath = (source: string, userPath: string): void => {
    const resolvedUserPath = canonicalPath(userPath);
    const localSource = isLocalExtensionSource(source);

    // A local source is allowed only when it resolves under the user agent
    // directory. This closes the absolute/`..` path escape that a package
    // manager's user-scope lookup otherwise permits.
    if (localSource && !isPathWithinDirectory(agentDir, resolvedUserPath)) {
      throw new Error(
        "A configured provider extension resolves outside the user agent directory; project-local extension paths are not allowed.",
      );
    }

    // `cwd` may be a nested package directory. Validate against the repository
    // (or project-marker) root, not just that exact directory, so a symlink from
    // a user-scope managed package into a sibling such as /repo/extensions is
    // never turned into executable subagent code. This check deliberately runs
    // for local sources too: placing the user agent directory inside a project
    // must not turn project code into a trusted extension.
    if (projectRoot && isPathWithinDirectory(projectRoot, resolvedUserPath)) {
      throw new Error(
        "A configured provider extension resolves inside the project directory; project-local extension paths are not allowed.",
      );
    }

    // Managed sources must remain inside a canonical user install root as well.
    // This is the conservative fallback when no project boundary is
    // discoverable, and it also protects legacy global npm installs from a
    // package-directory symlink that escapes their node_modules root.
    if (!localSource && !isTrustedManagedTarget(agentDir, userPath)) {
      throw new Error(
        "A configured provider extension cannot be verified as a trusted user installation; project-local extension paths are not allowed.",
      );
    }

    assertConfiguredGitInstallation(packageManager, source, userPath);
  };

  const installedPaths = new Map<string, string>();
  const missing: string[] = [];
  for (const { source, required } of requested) {
    // Deliberately resolve only the user scope. Project-local packages are
    // untrusted input and must never become executable subagent extensions.
    const userPath = packageManager.getInstalledPath(source, "user");
    if (!userPath) {
      if (required) missing.push(source);
      // A best-effort default that is not installed is skipped silently: for
      // most users the package was never installed at all, and its absence is
      // the normal, correct state — not something to warn about.
      continue;
    }
    installedPaths.set(source, userPath);
  }

  if (missing.length > 0) {
    const providerName = provider?.trim() || "the selected provider";
    const sourceLabel = missing.length === 1 ? "source" : "sources";
    throw new Error(
      `Provider extension(s) for ${providerName} are not installed in the user scope (${missing.length} configured ${sourceLabel}). Install the configured sources with Pi before delegating; project-local installations are not allowed.`,
    );
  }

  const paths = new Set<string>();
  const bestEffortPaths = new Set<string>();
  for (const { source, required } of requested) {
    const userPath = installedPaths.get(source);
    // Best-effort defaults that were not installed never reached the map.
    if (!userPath) continue;
    try {
      validateInstalledPath(source, userPath);
      if (hasNpmVersionSpecifier(source)) {
        await assertConfiguredNpmVersion(packageManager, source, userPath);
      }
    } catch (error) {
      if (required) throw error;
      // A best-effort default that cannot be verified is skipped, not loaded
      // and not fatal. Silent by design: an installed-but-broken package also
      // fails in the parent's own extension inventory, where Pi surfaces it;
      // this path only mirrors a signal the user has already seen.
      continue;
    }
    paths.add(userPath);
    if (!required) bestEffortPaths.add(userPath);
  }

  return { paths: [...paths], bestEffortPaths };
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
  const providerExtensions = getSubagentProviderExtensionMap();
  const providerExtensionSignature = JSON.stringify(
    Object.entries(providerExtensions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => [provider, [...entries]] as const),
  );
  const providerConfigs = options.providerConfigs ?? [];
  const requestedExtensions = getSubagentProviderExtensionSourcesForProvider(
    options.modelProvider,
  );

  // Resolve provider extensions before deciding whether to use the cache.
  // User-configured sources fail closed when missing; shipped defaults are
  // best-effort and silently drop instead. Both package lookup and child
  // resource loading stay isolated from executable project settings.
  let additionalExtensionPaths: string[] = [];
  let bestEffortExtensionRoots = new Set<string>();
  if (requestedExtensions.length > 0) {
    // Package lookup is a user-scope trust boundary. Pi's legacy npm fallback
    // may execute the configured npmCommand to discover the global npm root,
    // so project settings must never participate.
    const packageLookupSettingsManager = SettingsManager.create(
      options.cwd,
      agentDir,
      { projectTrusted: false },
    );
    const resolution = await getProviderExtensionPaths(
      options.modelProvider,
      options.cwd,
      agentDir,
      packageLookupSettingsManager,
    );
    additionalExtensionPaths = resolution.paths;
    bestEffortExtensionRoots = resolution.bestEffortPaths;
  }

  // Provider configs may contain functions (custom stream/OAuth handlers), so a
  // stringified value cannot safely identify them. Do not cache any call that
  // registers one; each call gets the exact config object supplied by its
  // caller. The same rule is used for extension-bearing calls because their
  // extension runtime is mutable and session-owned.
  const cacheable =
    providerConfigs.length === 0 && additionalExtensionPaths.length === 0;
  const cacheGeneration = hostDepsCacheGeneration;
  const key = JSON.stringify({
    agentDir,
    cwd: options.cwd,
    systemPrompt:
      options.systemPrompt === undefined
        ? { source: "discovered" }
        : { source: "explicit", value: options.systemPrompt },
    modelProvider: options.modelProvider ?? "",
    providerExtensionSignature,
  });

  if (cacheable) {
    const cached = hostDepsCache.get(key);
    if (cached) return cached;

    // Another call is already building this key — await its promise.
    const inflight = hostDepsInflight.get(key);
    if (inflight) return inflight;
  }

  const build = async (): Promise<HostDeps> => {
    // Canonical model/auth runtime — the 0.80.8+ successor to the separate
    // `authStorage` + `modelRegistry` options. It is shared only for the
    // cacheable, extension-free path; provider-specific sessions get their own
    // runtime so all stateful host dependencies have the same ownership.
    // Reads the same ~/.pi/agent/{auth,models}.json the parent uses, so stored
    // credentials stay consistent. Runtime-only provider registrations are
    // layered on just below.
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

    const resolvedSettingsManager = SettingsManager.create(
      options.cwd,
      agentDir,
      { projectTrusted: false },
    );
    if (testRetryBaseMs !== undefined) {
      installFastRetry(resolvedSettingsManager, testRetryBaseMs);
    }
    // Best-effort default sources that fail to load are dropped and the loader
    // is rebuilt without them, so the subagent runs extension-free on Pi's
    // native compaction — silently, per the drop-site rationale above.
    // User-configured sources still fail closed below.
    //
    // Loop invariant: pi's ResourceLoader.reload() never *throws* for an
    // extension's own failure — its loader wraps module import AND factory
    // invocation in try/catch and returns them as `extensionsResult.errors`
    // (verified in pi 0.80.x, core/extensions/loader.ts). A reload() throw is
    // therefore environmental (settings reload, package resolution) and not
    // attributable to any supplied root; letting it propagate is correct even
    // when best-effort roots are present.
    let extensionPaths = additionalExtensionPaths;
    let resourceLoader: DefaultResourceLoader;
    for (;;) {
      resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir,
        settingsManager: resolvedSettingsManager,
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
      const extensionErrors = extensionsResult.errors;
      const loadedExtensionPaths = extensionsResult.extensions.map(
        (extension) => extension.resolvedPath || extension.path,
      );
      // A package can resolve successfully while exposing only skills/prompts,
      // or a malformed manifest can expose no loadable extension at all.
      const missingExtensionRoots = extensionPaths.filter(
        (root) =>
          !loadedExtensionPaths.some((extensionPath) =>
            isPathWithinDirectory(root, extensionPath),
          ),
      );
      const failedRoots = new Set(
        missingExtensionRoots.concat(
          extensionPaths.filter((root) =>
            extensionErrors.some((error) =>
              isPathWithinDirectory(root, error.path),
            ),
          ),
        ),
      );
      // An error inside a best-effort root is attributable to that root; any
      // other error (including one no supplied root claims) stays fatal.
      const fatalErrors = extensionErrors.filter(
        (error) =>
          ![...bestEffortExtensionRoots].some((root) =>
            isPathWithinDirectory(root, error.path),
          ),
      );
      const fatalRoots = [...failedRoots].filter(
        (root) => !bestEffortExtensionRoots.has(root),
      );
      if (fatalErrors.length > 0 || fatalRoots.length > 0) {
        const failureCount = Math.max(fatalRoots.length, fatalErrors.length);
        const providerName =
          options.modelProvider?.trim() || "the selected provider";
        throw new Error(
          `Failed to load ${failureCount} allowlisted provider extension(s) for ${providerName}; delegation stopped instead of running without the required integration.`,
        );
      }
      const droppableRoots = [...failedRoots].filter((root) =>
        bestEffortExtensionRoots.has(root),
      );
      if (droppableRoots.length === 0) break;
      extensionPaths = extensionPaths.filter(
        (root) => !droppableRoots.includes(root),
      );
    }

    // Positive visibility for the invisible-by-design path: surviving
    // best-effort roots each produced at least one loaded extension, and
    // that changes subagent behavior without any user action — the one
    // state worth a notice. Once per process per provider+root.
    for (const root of extensionPaths) {
      if (bestEffortExtensionRoots.has(root)) {
        noticeProviderExtensionLoaded(options.modelProvider, root);
      }
    }

    return {
      modelRuntime,
      settingsManager: resolvedSettingsManager,
      resourceLoader,
    };
  };

  if (!cacheable) return build();

  const promise = build().then((deps) => {
    if (hostDepsCacheGeneration === cacheGeneration) {
      hostDepsCache.set(key, deps);
    }
    return deps;
  });
  hostDepsInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    // An invalidation can let a newer generation install its own in-flight
    // build for the same key. Never let the older promise delete that marker.
    if (hostDepsInflight.get(key) === promise) {
      hostDepsInflight.delete(key);
    }
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
  hostDepsCacheGeneration++;
  hostDepsCache.clear();
  hostDepsInflight.clear();
}

/** Test-only alias retained for existing test setup. */
export function _resetHostDepsCacheForTesting(): void {
  invalidateHostDepsCache();
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

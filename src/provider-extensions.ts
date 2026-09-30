/**
 * Resolution and verification of the provider-scoped subagent extension
 * allowlist (#59; ported from v1 provider-extensions.ts).
 *
 * Subagents run with `noExtensions: true`. This module owns the single,
 * narrow exception: a per-provider list of user-scope packages that may be
 * injected as `additionalExtensionPaths` (today, remote compaction and
 * tool swaps for `openai-codex`). Because those packages become executable
 * code inside a subagent, every source goes through the same gauntlet
 * before it is handed to the resource loader:
 *
 *   1. resolved in the **user scope only** — a project-local package is
 *      untrusted input and never becomes a subagent extension;
 *   2. its canonical target must stay inside a trusted install root and
 *      outside the project;
 *   3. a Git source must be checked out at the configured repository and,
 *      if pinned, at the configured commit;
 *   4. an npm source with a version specifier must satisfy that range.
 *
 * **Provenance decides failure semantics.** A source the user listed in
 * `delegate.json` is required and fails closed. A shipped default the
 * user never mentioned is best-effort: missing, unverifiable, or broken,
 * it is dropped *silently* and the subagent runs extension-free — absence
 * of an optional integration is Pi's normal operation.
 *
 * All parsing of source strings goes through `./pi-package-source.ts`,
 * which wraps Pi's own parser. This module deliberately contains no Git
 * URL grammar, no npm spec regex, and no `npm:`/`git:` prefix matching of
 * its own.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getProviderExtensionSignature,
  getSubagentProviderExtensionSourcesForProvider,
  type DelegateConfig,
} from "./config.ts";
import { gitProbeEnv } from "./fsx.ts";
import {
  parseGitOriginIdentity,
  parsePackageSource,
  PiPackageSourceError,
  sameRepository,
  type GitPackageSource,
  type NpmPackageSource,
} from "./pi-package-source.ts";

/**
 * Path containment primitives for the subagent trust boundary (v1
 * trusted-paths.ts). Trust checks compare **canonical** paths: a symlink
 * whose target escapes an install root must not launder itself through a
 * lexically-innocent path, so canonicalization failure is closed (false),
 * never a lexical fallback.
 */
function trustedCanonicalPath(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/** Whether `candidate` is `directory` itself or beneath it, canonicalized. */
function isPathWithinDirectory(
  directory: string | undefined,
  candidate: string | undefined,
): boolean {
  if (directory === undefined || candidate === undefined) return false;
  const canonicalDirectory = trustedCanonicalPath(directory);
  const canonicalCandidate = trustedCanonicalPath(candidate);
  if (canonicalDirectory === undefined || canonicalCandidate === undefined) {
    return false;
  }
  return isPathWithinDirectoryLexical(canonicalDirectory, canonicalCandidate);
}

/**
 * Whether `candidate` is `directory` itself or beneath it, lexically (no
 * symlink resolution — for already-trusted paths and load-failure
 * classification, where the path need not exist).
 */
export function isPathWithinDirectoryLexical(
  directory: string,
  candidate: string,
): boolean {
  const relativePath = relative(resolve(directory), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

/** The verified allowlist one task's provider resolved to. */
export interface ProviderExtensionResolution {
  /** Verified user-scope package roots to inject as child extension paths. */
  readonly paths: ReadonlySet<string>;
  /**
   * Resolved roots originating from shipped best-effort defaults; these
   * may drop silently when they fail to load — see
   * `partitionExtensionLoadFailures`.
   */
  readonly bestEffortPaths: ReadonlySet<string>;
  /** The pool-freeze signature of the applicable allowlist. */
  readonly signature: string;
}

/**
 * Dispatch-scoped resolution cache (v1 provider-extensions.ts:61-73):
 * `getInstalledPath` can synchronously spawn `npm root -g` for Pi's legacy
 * global fallback, so a fan-out would otherwise block the event loop once
 * per task. The map's owner is the dispatch (`resolveTasks`): absence is
 * stable within a dispatch because nothing here ever installs.
 */
export type ProviderExtensionCache = Map<
  string,
  Promise<ProviderExtensionResolution | undefined>
>;

/**
 * Whether a managed package's canonical target remains in a user install
 * root (v1 provider-extensions.ts:75-97).
 *
 * Pi's managed user installs live below `agentDir`; its legacy npm
 * fallback lives below a global `node_modules` directory. Deriving the
 * latter from the returned lexical path avoids invoking npm merely to
 * validate a path, while still rejecting a package-directory symlink
 * whose canonical target escapes that install root.
 */
function isTrustedManagedTarget(agentDir: string, userPath: string): boolean {
  if (isPathWithinDirectory(agentDir, userPath)) return true;

  const resolvedUserPath = trustedCanonicalPath(userPath);
  if (resolvedUserPath === undefined) return false;
  const lexicalPath = resolve(userPath);
  const nodeModulesMarker = `${sep}node_modules${sep}`;
  const markerIndex = lexicalPath.lastIndexOf(nodeModulesMarker);
  if (markerIndex < 0) return false;
  const installRoot = lexicalPath.slice(
    0,
    markerIndex + nodeModulesMarker.length - 1,
  );
  return isPathWithinDirectoryLexical(installRoot, resolvedUserPath);
}

/**
 * Find the project boundary used by the extension trust check (v1
 * provider-extensions.ts:99-129).
 *
 * `cwd` is allowed to be a package directory inside a larger checkout.
 * Checking only that exact directory makes a user-scope symlink into a
 * sibling project directory look safe. Git is the authoritative boundary
 * when available; marker directories provide a conservative fallback for
 * projects that are not Git worktrees. Returning undefined is
 * intentional: callers then require a canonical managed target to remain
 * under the trusted user agent directory.
 */
function findExtensionProjectRoot(cwd: string): string | undefined {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (root) return trustedCanonicalPath(root);

  let directory = trustedCanonicalPath(cwd);
  if (directory === undefined) return undefined;
  for (;;) {
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

/**
 * Run git in `cwd`, returning trimmed stdout or "" if the command fails
 * (v1 provider-extensions.ts:132-147; inherited `GIT_*` redirects are
 * scrubbed per this repo's Git convention so a polluted environment
 * cannot redirect the probe).
 */
function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      env: gitProbeEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    // Not every path is a Git worktree, and a missing ref is a normal
    // answer here. A timeout or non-zero exit is also treated as "no
    // answer" so an unresponsive git never hangs delegation. Callers
    // treat "" as "no answer" and fail closed where that matters.
    return "";
  }
}

/**
 * Reject a user installation whose checkout or ref differs from the
 * configured source (v1 provider-extensions.ts:149-190).
 *
 * Pi derives a Git package's install directory from the source's
 * host/path, so a matching directory alone proves nothing about the
 * checkout inside it: a source pinned to a tag and the same source
 * unpinned share one directory. Reading the checkout's own origin and
 * HEAD is what makes the pin mean something.
 */
function verifyGitCheckout(
  packageManager: DefaultPackageManager,
  configured: GitPackageSource,
  installedPath: string,
): void {
  try {
    const origin = parseGitOriginIdentity(
      packageManager,
      gitOutput(installedPath, ["config", "--get", "remote.origin.url"]),
    );
    if (!origin || !sameRepository(origin, configured)) {
      throw new Error("checkout has a different origin");
    }

    if (!configured.ref) return;
    const head = gitOutput(installedPath, ["rev-parse", "--verify", "HEAD"]);
    const target = gitOutput(installedPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${configured.ref}^{commit}`,
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

/**
 * Apply Pi's own npm range semantics to the installed package, without
 * duplicating semver logic and without installing or updating anything
 * during delegation (v1 provider-extensions.ts:192-228).
 */
async function verifyNpmVersion(
  configured: NpmPackageSource,
  installedPath: string,
): Promise<void> {
  // An unconstrained source (`npm:pkg`) pins nothing, so there is nothing
  // to verify beyond the path checks every source already passed.
  if (configured.version === undefined) return;
  if (configured.range === undefined) {
    // Pi treats npm tags such as `@latest` as unconstrained when checking
    // an installed package. They are registry aliases, not verifiable
    // local version constraints, so fail closed instead of accepting any
    // stale package that happens to sit at the same install path.
    throw new Error(
      "A configured provider extension uses an npm tag rather than a verifiable semver range; delegation stopped.",
    );
  }

  let matches: boolean;
  try {
    matches = await configured.satisfiedBy(installedPath);
  } catch (error) {
    throw new Error(
      "A configured provider extension version does not match the installed user-scope package; delegation stopped.",
      { cause: error },
    );
  }
  if (!matches) {
    throw new Error(
      "A configured provider extension version does not match the installed user-scope package; delegation stopped.",
    );
  }
}

/**
 * Full verification of one resolved source (v1
 * provider-extensions.ts:230-290). Throws on any failure; the caller
 * decides whether that is fatal (user-configured) or a silent drop
 * (best-effort default).
 */
async function verifyInstalledSource(
  packageManager: DefaultPackageManager,
  source: string,
  installedPath: string,
  trust: { agentDir: string; projectRoot: string | undefined },
): Promise<void> {
  const configured = parseSourceForVerification(packageManager, source);
  const resolvedUserPath = trustedCanonicalPath(installedPath);

  // A local source is allowed only when it resolves under the user agent
  // directory. This closes the absolute/`..` path escape that a package
  // manager's user-scope lookup otherwise permits.
  if (
    configured.type === "local" &&
    !isPathWithinDirectory(trust.agentDir, resolvedUserPath)
  ) {
    throw new Error(
      "A configured provider extension resolves outside the user agent directory; project-local extension paths are not allowed.",
    );
  }

  // `cwd` may be a nested package directory. Validate against the
  // repository (or project-marker) root, not just that exact directory,
  // so a symlink from a user-scope managed package into a sibling such as
  // /repo/extensions is never turned into executable subagent code. This
  // check deliberately runs for local sources too: placing the user agent
  // directory inside a project must not turn project code into a trusted
  // extension.
  if (
    trust.projectRoot &&
    isPathWithinDirectory(trust.projectRoot, resolvedUserPath)
  ) {
    throw new Error(
      "A configured provider extension resolves inside the project directory; project-local extension paths are not allowed.",
    );
  }

  // Managed sources must remain inside a canonical user install root as
  // well. This is the conservative fallback when no project boundary is
  // discoverable, and it also protects legacy global npm installs from a
  // package-directory symlink that escapes their node_modules root.
  if (
    configured.type !== "local" &&
    !isTrustedManagedTarget(trust.agentDir, installedPath)
  ) {
    throw new Error(
      "A configured provider extension cannot be verified as a trusted user installation; project-local extension paths are not allowed.",
    );
  }

  if (configured.type === "git") {
    verifyGitCheckout(packageManager, configured, installedPath);
  }
  if (configured.type === "npm") {
    await verifyNpmVersion(configured, installedPath);
  }
}

/**
 * Parse a configured source, re-reporting a broken parser contract in
 * terms of the verification it defeated (v1
 * provider-extensions.ts:292-322).
 *
 * An unverifiable source is treated exactly like a failed verification,
 * but the user should read the failure as "this Git source could not be
 * verified", not as an unrelated internal error. The original diagnosis
 * survives as `cause`, so a Pi-version mismatch stays distinguishable
 * from a bad checkout.
 */
function parseSourceForVerification(
  packageManager: DefaultPackageManager,
  source: string,
) {
  try {
    return parsePackageSource(packageManager, source);
  } catch (error) {
    if (error instanceof PiPackageSourceError && error.sourceType === "git") {
      throw new Error(
        "A configured provider extension is not checked out at its configured Git source or ref; delegation stopped.",
        { cause: error },
      );
    }
    if (error instanceof PiPackageSourceError && error.sourceType === "npm") {
      throw new Error(
        "A configured provider extension version does not match the installed user-scope package; delegation stopped.",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Resolve and verify every allowlisted extension source for `provider`
 * (v1 provider-extensions.ts:324-409). Runs at dispatch time: a
 * required-source failure rejects the whole dispatch before any child
 * starts.
 *
 * The `cache` argument is the dispatch-scoped absence/verification store —
 * its owner is `resolveTasks`, so nothing module-level mutates.
 */
export function resolveProviderExtensionPaths(
  provider: string,
  cwd: string,
  agentDir: string,
  config: DelegateConfig,
  cache: ProviderExtensionCache,
): Promise<ProviderExtensionResolution | undefined> {
  // Provider names never contain whitespace, so a space separator keeps
  // the composite key collision-free between (provider, cwd) pairs.
  const key = `${provider.toLowerCase()} ${cwd}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const resolved = resolveProviderExtensionPathsUncached(
    provider,
    cwd,
    agentDir,
    config,
  );
  cache.set(key, resolved);
  return resolved;
}

async function resolveProviderExtensionPathsUncached(
  provider: string,
  cwd: string,
  agentDir: string,
  config: DelegateConfig,
): Promise<ProviderExtensionResolution | undefined> {
  const requested = getSubagentProviderExtensionSourcesForProvider(
    provider,
    config,
  );
  const signature = getProviderExtensionSignature(provider, config);
  if (requested.length === 0) return undefined;

  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    // Package lookup is a user-scope trust boundary. Pi's legacy npm
    // fallback may execute the configured npmCommand to discover the
    // global npm root, so project settings must never participate.
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: false,
    }),
  });
  const trust = { agentDir, projectRoot: findExtensionProjectRoot(cwd) };

  const installedPaths = new Map<string, string>();
  const missing: string[] = [];
  for (const { source, required } of requested) {
    const userPath = packageManager.getInstalledPath(source, "user");
    if (!userPath) {
      if (required) missing.push(source);
      // A best-effort default that is not installed is skipped silently:
      // for most users the package was never installed at all, and its
      // absence is the normal, correct state — not something to warn
      // about (v1 provider-extensions.ts:370-375).
      continue;
    }
    installedPaths.set(source, userPath);
  }

  if (missing.length > 0) {
    const providerName = provider.trim() || "the selected provider";
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
      await verifyInstalledSource(packageManager, source, userPath, trust);
    } catch (error) {
      if (required) throw error;
      // A best-effort default that cannot be verified is skipped, not
      // loaded and not fatal. Silent by design: an installed-but-broken
      // package also fails in the parent's own extension inventory,
      // where Pi surfaces it; this path only mirrors a signal the user
      // has already seen (v1 provider-extensions.ts:394-402).
      continue;
    }
    paths.add(userPath);
    if (!required) bestEffortPaths.add(userPath);
  }

  // Positive visibility for the invisible-by-design path (v1
  // provider-extensions.ts:506-534): a surviving best-effort default
  // changes subagent behavior without any user action — worth one line
  // per provider per dispatch. User-configured sources never announce
  // themselves; the user installed them knowingly.
  if (bestEffortPaths.size > 0) {
    const providerName = provider.trim() || "provider";
    console.error(
      `[delegate] provider extension integration active for ${providerName} subagents: ${[...bestEffortPaths].map((root) => basename(root) || root).join(", ")}`,
    );
  }

  return { paths, bestEffortPaths, signature };
}

/**
 * Split allowlisted extension roots into the ones that must abort
 * delegation and the ones that may be dropped and retried without
 * (v1 provider-extensions.ts:436-483).
 *
 * A root "failed" if it produced a load error or produced no loaded
 * extension at all — a package can resolve successfully while exposing
 * only skills or prompts, and a malformed manifest can expose nothing
 * loadable. An error that no best-effort root claims stays fatal,
 * including one that no supplied root claims at all.
 *
 * Pure, so the classification is testable without a resource loader.
 */
export function partitionExtensionLoadFailures(input: {
  extensionPaths: readonly string[];
  loadedExtensionPaths: readonly string[];
  extensionErrors: ReadonlyArray<{ path: string }>;
  bestEffortRoots: ReadonlySet<string>;
}): { fatalCount: number; droppableRoots: string[] } {
  const { extensionPaths, loadedExtensionPaths, extensionErrors } = input;
  const bestEffortRoots = [...input.bestEffortRoots];

  const failedRoots = new Set(
    extensionPaths.filter(
      (root) =>
        !loadedExtensionPaths.some((extensionPath) =>
          isPathWithinDirectoryLexical(root, extensionPath),
        ) ||
        extensionErrors.some((error) =>
          isPathWithinDirectoryLexical(root, error.path),
        ),
    ),
  );
  const fatalErrors = extensionErrors.filter(
    (error) =>
      !bestEffortRoots.some((root) =>
        isPathWithinDirectoryLexical(root, error.path),
      ),
  );
  const fatalRoots = [...failedRoots].filter(
    (root) => !input.bestEffortRoots.has(root),
  );

  return {
    fatalCount: Math.max(fatalRoots.length, fatalErrors.length),
    droppableRoots: [...failedRoots].filter((root) =>
      input.bestEffortRoots.has(root),
    ),
  };
}

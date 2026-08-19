/**
 * Resolution and verification of the provider-scoped subagent extension
 * allowlist.
 *
 * Subagents run with `noExtensions: true`. This module owns the single, narrow
 * exception: a per-provider list of user-scope packages that may be injected as
 * `additionalExtensionPaths` (today, remote compaction for `openai-codex`).
 * Because those packages become executable code inside a subagent, every source
 * is put through the same gauntlet before it is handed to the resource loader:
 *
 *   1. resolved in the **user scope only** — a project-local package is
 *      untrusted input and never becomes a subagent extension;
 *   2. its canonical target must stay inside a trusted install root and outside
 *      the project;
 *   3. a Git source must be checked out at the configured repository and, if
 *      pinned, at the configured commit;
 *   4. an npm source with a version specifier must satisfy that range.
 *
 * **Provenance decides failure semantics.** A source the user listed in
 * `delegate.json` is required and fails closed. A shipped default the user
 * never mentioned is best-effort: missing, unverifiable, or broken, it is
 * dropped *silently* and the subagent runs extension-free on Pi's native
 * compaction. Silence there is deliberate — see `getProviderExtensionPaths`.
 *
 * All parsing of source strings goes through `pi-package-source.ts`, which
 * wraps Pi's own parser. This module deliberately contains no Git URL grammar,
 * no npm spec regex, and no `npm:`/`git:` prefix matching of its own.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSubagentProviderExtensionSourcesForProvider } from "./config.ts";
import {
  canonicalPath,
  isPathWithinDirectory,
  isPathWithinDirectoryLexical,
} from "./trusted-paths.ts";
import {
  parseGitOriginIdentity,
  parsePackageSource,
  PiPackageSourceError,
  sameRepository,
  type GitPackageSource,
  type NpmPackageSource,
} from "./pi-package-source.ts";

/** Result of resolving a provider's allowlisted extension sources. */
export interface ProviderExtensionResolution {
  /** User-scope package roots to inject as subagent extension paths. */
  paths: string[];
  /** Roots originating from shipped best-effort defaults; these may degrade
   * silently — see the drop-site comments for why silence is the design. */
  bestEffortPaths: Set<string>;
}

// When a shipped best-effort default (today npm:@bermudi/pi-codex) is absent —
// the normal state for most users — Pi's getInstalledPath can synchronously
// spawn `npm root -g` to check its legacy global fallback. Doing that once per
// task in a fan-out blocks the event loop N times and serializes the fan-out.
// Cache the *absence* per dispatch so only the first task pays the cost; the
// rest skip the lookup entirely. Absence is stable within a dispatch because
// nothing here ever installs.
const missingBestEffortSourceCache = new Set<string>();

/** Drop the per-dispatch absence cache. Called from host-deps invalidation. */
export function clearMissingProviderExtensionCache(): void {
  missingBestEffortSourceCache.clear();
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
  const installRoot = lexicalPath.slice(
    0,
    markerIndex + nodeModulesMarker.length - 1,
  );
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
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (root) return canonicalPath(root);

  let directory = canonicalPath(cwd);
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

/** Run git in `cwd`, returning trimmed stdout or "" if the command fails. */
function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    // Not every path is a Git worktree, and a missing ref is a normal answer
    // here. A timeout or non-zero exit is also treated as "no answer" so an
    // unresponsive git never hangs delegation. Callers treat "" as "no
    // answer" and fail closed where that matters.
    return "";
  }
}

/**
 * Reject a user installation whose checkout or ref differs from the configured
 * source.
 *
 * Pi derives a Git package's install directory from the source's host/path, so
 * a matching directory alone proves nothing about the checkout inside it: a
 * source pinned to a tag and the same source unpinned share one directory.
 * Reading the checkout's own origin and HEAD is what makes the pin mean
 * something.
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
 * duplicating semver logic and without installing or updating anything during
 * delegation.
 */
async function verifyNpmVersion(
  configured: NpmPackageSource,
  installedPath: string,
): Promise<void> {
  // An unconstrained source (`npm:pkg`) pins nothing, so there is nothing to
  // verify beyond the path checks every source already passed.
  if (configured.version === undefined) return;
  if (configured.range === undefined) {
    // Pi treats npm tags such as `@latest` as unconstrained when checking an
    // installed package. They are registry aliases, not verifiable local
    // version constraints, so fail closed instead of accepting any stale
    // package that happens to sit at the same install path.
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
 * Full verification of one resolved source. Throws on any failure; the caller
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
  const resolvedUserPath = canonicalPath(installedPath);

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

  // `cwd` may be a nested package directory. Validate against the repository
  // (or project-marker) root, not just that exact directory, so a symlink from
  // a user-scope managed package into a sibling such as /repo/extensions is
  // never turned into executable subagent code. This check deliberately runs
  // for local sources too: placing the user agent directory inside a project
  // must not turn project code into a trusted extension.
  if (
    trust.projectRoot &&
    isPathWithinDirectory(trust.projectRoot, resolvedUserPath)
  ) {
    throw new Error(
      "A configured provider extension resolves inside the project directory; project-local extension paths are not allowed.",
    );
  }

  // Managed sources must remain inside a canonical user install root as well.
  // This is the conservative fallback when no project boundary is
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
 * Parse a configured source, re-reporting a broken parser contract in terms of
 * the verification it defeated.
 *
 * An unverifiable source is treated exactly like a failed verification, but the
 * user should read the failure as "this Git source could not be verified", not
 * as an unrelated internal error. The original diagnosis survives as `cause`,
 * so a Pi-version mismatch stays distinguishable from a bad checkout.
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
 * Resolve and verify every allowlisted extension source for `provider`.
 *
 * Provider-key normalization (trim + lowercase) lives in `config.ts` — the
 * sources getter is the single owner of that logic, so this module never
 * re-implements it. Provenance (required vs best-effort) is decided there too,
 * by config presence: user-listed sources fail closed; shipped defaults degrade
 * silently, because the extension-free path is Pi's normal operation, not a
 * warning condition.
 */
export async function getProviderExtensionPaths(
  provider: string | undefined,
  cwd: string,
  agentDir: string,
  /** Dispatch-scoped snapshot for the provider-extension allowlist. */
  config?: import("./config.ts").DelegateConfig,
): Promise<ProviderExtensionResolution> {
  const requested = getSubagentProviderExtensionSourcesForProvider(
    provider,
    config,
  );
  if (!requested.length) {
    return { paths: [], bestEffortPaths: new Set<string>() };
  }

  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    // Package lookup is a user-scope trust boundary. Pi's legacy npm fallback
    // may execute the configured npmCommand to discover the global npm root,
    // so project settings must never participate.
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: false,
    }),
  });
  const trust = { agentDir, projectRoot: findExtensionProjectRoot(cwd) };

  const installedPaths = new Map<string, string>();
  const missing: string[] = [];
  for (const { source, required } of requested) {
    const userPath = resolveUserScopePath(
      packageManager,
      source,
      required,
      agentDir,
    );
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
      await verifyInstalledSource(packageManager, source, userPath, trust);
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
 * Look up a source in the user scope, short-circuiting the repeated cost of
 * discovering that an optional default is simply not installed.
 *
 * Deliberately resolves only the user scope: project-local packages are
 * untrusted input and must never become executable subagent extensions.
 */
function resolveUserScopePath(
  packageManager: DefaultPackageManager,
  source: string,
  required: boolean,
  agentDir: string,
): string | undefined {
  // A required source is always looked up: its absence is fatal, so paying the
  // lookup once per task is irrelevant next to stopping the dispatch.
  if (required) return packageManager.getInstalledPath(source, "user");

  const missingKey = `${agentDir}\0${source}`;
  if (missingBestEffortSourceCache.has(missingKey)) return undefined;
  const userPath = packageManager.getInstalledPath(source, "user");
  if (!userPath) missingBestEffortSourceCache.add(missingKey);
  return userPath;
}

/**
 * Split allowlisted extension roots into the ones that must abort delegation
 * and the ones that may be dropped and retried without.
 *
 * A root "failed" if it produced a load error or produced no loaded extension
 * at all — a package can resolve successfully while exposing only skills or
 * prompts, and a malformed manifest can expose nothing loadable. An error that
 * no best-effort root claims stays fatal, including one that no supplied root
 * claims at all.
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
export function noticeProviderExtensionLoaded(
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

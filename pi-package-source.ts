/**
 * The single seam onto Pi's package-source grammar.
 *
 * Provider-extension verification needs three facts about a configured source:
 * whether it is a local path, which Git repository and ref it pins, and which
 * npm version range it requires. All three come from
 * `DefaultPackageManager.parseSource`, which is private upstream.
 *
 * Reaching into that private is not the hazard — *duplicating* it is. This
 * module exists because the previous implementation hand-rolled its own
 * `isLocalPath`, its own npm-spec regex, and its own Git URL grammar in order
 * to avoid the cast, and all three drifted from the originals:
 *
 *   - the local check lowercased its input, so `NPM:pkg` was "managed" to us
 *     and "local" to Pi;
 *   - the npm regex was a verbatim copy of Pi's private `parseNpmSpec`, kept in
 *     sync by hand;
 *   - the Git parser knew nothing of `hosted-git-info`, which Pi's real parser
 *     uses for every hosted provider.
 *
 * A second grammar that must track a private one on every upgrade is strictly
 * worse than one narrow cast that fails loudly. It is also not buying any
 * independence: `getInstalledPath` — a *public* method the resolution path
 * already depends on — calls this same private parser internally, so if
 * `parseSource` disappears, path resolution is broken with or without this
 * module.
 *
 * Hence: one cast, one module, one error type. Callers deal in the parsed
 * result and never see Pi's raw shape.
 */
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";

/**
 * Pi's private parser is missing, threw, or returned a shape this version of
 * delegate cannot trust.
 *
 * Callers fail closed on this rather than falling back to a guess: an
 * unverifiable source is treated exactly like a source that failed
 * verification. Callers that wrap it in a friendlier message must preserve it
 * as `cause`, so a Pi-version mismatch stays distinguishable from a genuinely
 * mismatched checkout.
 */
export class PiPackageSourceError extends Error {
  /**
   * Which kind of source Pi had already classified when the contract broke, if
   * it got that far. Callers use it to report the failure in terms of the
   * verification the user configured ("this Git source could not be verified")
   * rather than as an unrelated internal error.
   */
  readonly sourceType?: "git" | "npm";

  constructor(
    message: string,
    options?: { cause?: unknown; sourceType?: "git" | "npm" },
  ) {
    super(message, { cause: options?.cause });
    this.name = "PiPackageSourceError";
    this.sourceType = options?.sourceType;
  }
}

/** A Git repository identity, normalized for comparison. */
export interface GitRepositoryIdentity {
  /** Lowercased host, e.g. `github.com`. */
  host: string;
  /** Repository path, e.g. `example/extension`. */
  path: string;
}

export interface GitPackageSource extends GitRepositoryIdentity {
  type: "git";
  /** Configured ref. Present exactly when Pi reports the source as pinned. */
  ref?: string;
}

export interface NpmPackageSource {
  type: "npm";
  /** Version, range, or dist-tag text after the package name, if any. */
  version?: string;
  /** Semver range. Undefined when `version` is a dist-tag such as `latest`. */
  range?: string;
  /**
   * Whether the package installed at `installedPath` satisfies this source,
   * using Pi's own semver comparison rather than a reimplementation. Resolves
   * `true` for an unconstrained source, matching Pi's install-time behavior.
   */
  satisfiedBy(installedPath: string): Promise<boolean>;
}

export interface LocalPackageSource {
  type: "local";
}

export type PiPackageSource =
  GitPackageSource | NpmPackageSource | LocalPackageSource;

type PackageManagerInternals = {
  parseSource(source: string): unknown;
  installedNpmMatchesConfiguredVersion(
    parsed: unknown,
    installedPath: string,
  ): Promise<boolean>;
};

function internalsOf(
  packageManager: DefaultPackageManager,
): Partial<PackageManagerInternals> {
  return packageManager as unknown as Partial<PackageManagerInternals>;
}

/**
 * Normalize a Pi-parsed Git identity for equality comparison.
 *
 * This is comparison hygiene, not a grammar: both sides of every comparison
 * are produced by Pi's parser, and this only removes differences Pi is
 * indifferent to (host case, a trailing slash or `.git` that Pi strips in some
 * source forms but not others). It never decides what a source *is*.
 */
function normalizeIdentity(
  host: string,
  repoPath: string,
): GitRepositoryIdentity | undefined {
  const path = repoPath.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!host || !path) return undefined;
  return { host: host.toLowerCase(), path };
}

/**
 * Parse a configured package source with Pi's own parser.
 *
 * Throws `PiPackageSourceError` when the parser is unavailable or returns a
 * result whose security-relevant fields (Git pin state, npm range) cannot be
 * trusted. Unrecognized sources come back as `local`, which is exactly how Pi
 * itself resolves them.
 */
export function parsePackageSource(
  packageManager: DefaultPackageManager,
  source: string,
): PiPackageSource {
  const internals = internalsOf(packageManager);
  if (typeof internals.parseSource !== "function") {
    throw new PiPackageSourceError(
      "This Pi version no longer exposes the package-source parser that delegate uses to verify provider extensions.",
    );
  }

  let parsed: unknown;
  try {
    parsed = internals.parseSource.call(packageManager, source);
  } catch (error) {
    throw new PiPackageSourceError(
      "Pi could not parse a configured provider extension source.",
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PiPackageSourceError(
      "Pi's package-source parser returned an unusable result for a configured provider extension.",
    );
  }

  const record = parsed as {
    type?: unknown;
    host?: unknown;
    path?: unknown;
    ref?: unknown;
    pinned?: unknown;
    version?: unknown;
    range?: unknown;
  };

  if (record.type === "git") return toGitSource(record);
  if (record.type === "npm") {
    return toNpmSource(record, parsed, packageManager);
  }
  return { type: "local" };
}

function toGitSource(record: {
  host?: unknown;
  path?: unknown;
  ref?: unknown;
  pinned?: unknown;
}): GitPackageSource {
  if (typeof record.host !== "string" || typeof record.path !== "string") {
    throw new PiPackageSourceError(
      "Pi's package-source parser reported a Git source without a usable repository identity.",
      { sourceType: "git" },
    );
  }
  const identity = normalizeIdentity(record.host, record.path);
  if (!identity) {
    throw new PiPackageSourceError(
      "Pi's package-source parser reported an empty Git repository identity.",
      { sourceType: "git" },
    );
  }

  // `pinned` and `ref` are a security contract, not decoration. If a Pi
  // upgrade drops either, never reinterpret a pinned source as an unpinned
  // checkout and silently skip commit validation.
  if (typeof record.pinned !== "boolean") {
    throw new PiPackageSourceError(
      "Pi's package-source parser no longer reports Git pin state.",
      { sourceType: "git" },
    );
  }
  if (!record.pinned) {
    if (record.ref !== undefined) {
      throw new PiPackageSourceError(
        "Pi's package-source parser reported an unpinned Git source that still carries a ref.",
        { sourceType: "git" },
      );
    }
    return { type: "git", ...identity };
  }
  if (typeof record.ref !== "string" || record.ref.length === 0) {
    throw new PiPackageSourceError(
      "Pi's package-source parser reported a pinned Git source without a ref.",
      { sourceType: "git" },
    );
  }
  return { type: "git", ...identity, ref: record.ref };
}

function toNpmSource(
  record: { version?: unknown; range?: unknown },
  parsed: unknown,
  packageManager: DefaultPackageManager,
): NpmPackageSource {
  if (record.version !== undefined && typeof record.version !== "string") {
    throw new PiPackageSourceError(
      "Pi's package-source parser reported an unusable npm version specifier.",
      { sourceType: "npm" },
    );
  }
  if (record.range !== undefined && typeof record.range !== "string") {
    throw new PiPackageSourceError(
      "Pi's package-source parser reported an unusable npm version range.",
      { sourceType: "npm" },
    );
  }

  return {
    type: "npm",
    version: record.version,
    range: record.range,
    async satisfiedBy(installedPath: string): Promise<boolean> {
      const compare =
        internalsOf(packageManager).installedNpmMatchesConfiguredVersion;
      if (typeof compare !== "function") {
        throw new PiPackageSourceError(
          "This Pi version no longer exposes the npm version check that delegate uses to verify provider extensions.",
          { sourceType: "npm" },
        );
      }
      // Pi's own parsed object is handed back untouched: it owns the contract
      // between its parser and its comparison, and a reconstructed stand-in
      // would silently change meaning if that contract grew a field.
      return compare.call(packageManager, parsed, installedPath);
    },
  };
}

/**
 * Read the repository identity of an installed checkout from its origin URL,
 * using the same parser the configured source went through.
 *
 * The `git:` prefix is what makes that possible: without it Pi only accepts
 * explicit protocol URLs, while with it Pi accepts every shorthand it accepts
 * in a configured source (SCP `git@host:path`, bare `host/path`). Prefixing a
 * URL that already carries a scheme is harmless — Pi strips the prefix before
 * parsing. Returns undefined for an origin Pi does not recognize as Git, which
 * callers treat as a failed identity match.
 */
export function parseGitOriginIdentity(
  packageManager: DefaultPackageManager,
  originUrl: string,
): GitRepositoryIdentity | undefined {
  const trimmed = originUrl.trim();
  if (!trimmed) return undefined;
  const parsed = parsePackageSource(packageManager, `git:${trimmed}`);
  if (parsed.type !== "git") return undefined;
  return { host: parsed.host, path: parsed.path };
}

/** Whether two Pi-parsed Git identities name the same repository. */
export function sameRepository(
  a: GitRepositoryIdentity,
  b: GitRepositoryIdentity,
): boolean {
  return a.host === b.host && a.path === b.path;
}

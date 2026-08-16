import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  parseGitOriginIdentity,
  parsePackageSource,
  PiPackageSourceError,
  sameRepository,
} from "./pi-package-source.ts";

/**
 * Tests for the seam onto Pi's package-source grammar.
 *
 * The point of this module is that delegate owns **no** source grammar of its
 * own: no Git URL parser, no npm spec regex, no `npm:`/`git:` prefix matching.
 * These tests therefore run against a real `DefaultPackageManager` and the real
 * installed Pi — a stub parser would test the stub, not the seam. They double as
 * a canary: if a Pi upgrade changes how a source form is classified, these fail
 * here rather than as a mysterious "checkout has a different origin" during a
 * delegation.
 */

function makePackageManager(): DefaultPackageManager {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-delegate-seam-cwd-"));
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-delegate-seam-agent-"));
  return new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: false,
    }),
  });
}

const packageManager = makePackageManager();

describe("parsePackageSource classification", () => {
  test("classifies npm, git, and local sources the way Pi does", () => {
    expect(parsePackageSource(packageManager, "npm:pkg").type).toBe("npm");
    expect(
      parsePackageSource(packageManager, "git:github.com/example/repo").type,
    ).toBe("git");
    expect(parsePackageSource(packageManager, "./local-thing").type).toBe(
      "local",
    );
  });

  test("prefix matching is case-sensitive, as in Pi's own isLocalPath", () => {
    // Regression: a hand-rolled local check lowercased its input, so `NPM:pkg`
    // was "managed" to delegate and "local" to Pi — the two then disagreed
    // about which trust check applied. Deferring to Pi removes the question.
    expect(parsePackageSource(packageManager, "NPM:pkg").type).toBe("local");
  });

  test("an unrecognized git-ish source degrades to local, as in Pi", () => {
    expect(parsePackageSource(packageManager, "git:nonsense").type).toBe(
      "local",
    );
  });
});

describe("parsePackageSource npm constraints", () => {
  test("an unconstrained source reports no version and no range", () => {
    const parsed = parsePackageSource(packageManager, "npm:@scope/pkg");
    expect(parsed.type).toBe("npm");
    if (parsed.type !== "npm") return;
    expect(parsed.version).toBeUndefined();
    expect(parsed.range).toBeUndefined();
  });

  test("a scoped name with a version is split by Pi, not by a local regex", () => {
    const parsed = parsePackageSource(packageManager, "npm:@scope/pkg@1.2.3");
    expect(parsed.type).toBe("npm");
    if (parsed.type !== "npm") return;
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.range).toBe("1.2.3");
  });

  test("a dist-tag yields a version with no verifiable range", () => {
    const parsed = parsePackageSource(packageManager, "npm:pkg@latest");
    expect(parsed.type).toBe("npm");
    if (parsed.type !== "npm") return;
    expect(parsed.version).toBe("latest");
    expect(parsed.range).toBeUndefined();
  });
});

describe("parsePackageSource git identity", () => {
  test("hosted shorthand, HTTPS, and SCP forms share one identity", () => {
    const identities = [
      "git:github.com/example/repo",
      "git:https://github.com/example/repo",
      "git:https://github.com/example/repo.git",
      "git:git@github.com:example/repo.git",
    ].map((source) => parsePackageSource(packageManager, source));

    for (const parsed of identities) {
      expect(parsed.type).toBe("git");
      if (parsed.type !== "git") continue;
      expect(parsed.host).toBe("github.com");
      expect(parsed.path).toBe("example/repo");
      expect(parsed.ref).toBeUndefined();
    }
  });

  test("a ref is reported only when Pi considers the source pinned", () => {
    const pinned = parsePackageSource(
      packageManager,
      "git:github.com/example/repo@v1.0.0",
    );
    expect(pinned.type).toBe("git");
    if (pinned.type !== "git") return;
    expect(pinned.ref).toBe("v1.0.0");

    const unpinned = parsePackageSource(
      packageManager,
      "git:github.com/example/repo",
    );
    expect(unpinned.type === "git" && unpinned.ref).toBeUndefined();
  });

  test("a generic host keeps a literal # in the path rather than reading it as a ref", () => {
    // Pi does not treat `#` as a ref separator for generic/SCP forms. Delegate
    // must not "helpfully" strip it: doing so would compare a configured source
    // against the wrong repository.
    const parsed = parsePackageSource(
      packageManager,
      "git:code.example.com/example/repo#release",
    );
    expect(parsed.type).toBe("git");
    if (parsed.type !== "git") return;
    expect(parsed.path).toBe("example/repo#release");
    expect(parsed.ref).toBeUndefined();
  });
});

describe("parsePackageSource fails closed", () => {
  test("throws when Pi no longer exposes the parser", () => {
    const withoutParser = {} as DefaultPackageManager;
    expect(() => parsePackageSource(withoutParser, "npm:pkg")).toThrow(
      PiPackageSourceError,
    );
  });

  test("a pinned source without a ref is a broken contract, tagged as git", () => {
    // If a Pi upgrade reports `pinned: true` but drops `ref`, never reinterpret
    // the source as unpinned and skip commit validation.
    const stub = {
      parseSource: () => ({
        type: "git",
        host: "github.com",
        path: "example/repo",
        pinned: true,
      }),
    } as unknown as DefaultPackageManager;

    try {
      parsePackageSource(stub, "git:github.com/example/repo@v1");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PiPackageSourceError);
      expect((error as PiPackageSourceError).sourceType).toBe("git");
    }
  });

  test("a non-boolean pin state is a broken contract", () => {
    const stub = {
      parseSource: () => ({
        type: "git",
        host: "github.com",
        path: "example/repo",
      }),
    } as unknown as DefaultPackageManager;
    expect(() =>
      parsePackageSource(stub, "git:github.com/example/repo"),
    ).toThrow(PiPackageSourceError);
  });

  test("a parser throw is reported as a seam failure, preserving the cause", () => {
    const boom = new Error("parser exploded");
    const stub = {
      parseSource: () => {
        throw boom;
      },
    } as unknown as DefaultPackageManager;

    try {
      parsePackageSource(stub, "npm:pkg");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PiPackageSourceError);
      expect((error as PiPackageSourceError).cause).toBe(boom);
    }
  });
});

describe("parseGitOriginIdentity", () => {
  test("reads an SCP origin, which Pi rejects without the git: prefix", () => {
    // The prefix is the whole trick: `git@host:path` is not an explicit
    // protocol URL, so Pi only accepts it as a Git source when prefixed. This
    // is what lets a checkout's origin be read with the exact grammar its
    // configured source was read with.
    expect(
      parsePackageSource(packageManager, "git@code.example.com:org/repo").type,
    ).toBe("local");

    const identity = parseGitOriginIdentity(
      packageManager,
      "git@code.example.com:org/repo",
    );
    expect(identity).toEqual({ host: "code.example.com", path: "org/repo" });
  });

  test("an HTTPS origin matches its shorthand configured source", () => {
    const configured = parsePackageSource(
      packageManager,
      "git:github.com/example/repo@v1.0.0",
    );
    const origin = parseGitOriginIdentity(
      packageManager,
      "https://github.com/example/repo.git",
    );
    expect(configured.type).toBe("git");
    expect(origin).toBeDefined();
    if (configured.type !== "git" || !origin) return;
    expect(sameRepository(origin, configured)).toBe(true);
  });

  test("host case and a trailing slash do not defeat a match", () => {
    const a = parseGitOriginIdentity(
      packageManager,
      "git@Code.Example.com:org/repo/",
    );
    const b = parseGitOriginIdentity(
      packageManager,
      "git@code.example.com:org/repo",
    );
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;
    expect(sameRepository(a, b)).toBe(true);
  });

  test("a different repository does not match", () => {
    const a = parseGitOriginIdentity(
      packageManager,
      "https://github.com/example/repo",
    );
    const b = parseGitOriginIdentity(
      packageManager,
      "https://github.com/example/other",
    );
    expect(a && b && sameRepository(a, b)).toBe(false);
  });

  test("an empty or unusable origin yields no identity", () => {
    expect(parseGitOriginIdentity(packageManager, "")).toBeUndefined();
    expect(parseGitOriginIdentity(packageManager, "   ")).toBeUndefined();
    // A bare local clone path is not a repository identity — callers treat this
    // as a failed match and fail closed.
    expect(
      parseGitOriginIdentity(packageManager, "/srv/mirrors/repo"),
    ).toBeUndefined();
  });
});

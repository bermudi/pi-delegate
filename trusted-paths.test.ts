import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  canonicalPath,
  isPathWithinDirectory,
  isPathWithinDirectoryLexical,
} from "./trusted-paths.ts";

describe("trusted-paths", () => {
  let tempRoot: string;
  let outsideRoot: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "trusted-paths-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "trusted-paths-out-"));
    await mkdir(join(tempRoot, "subdir"), { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  describe("canonicalPath", () => {
    test("resolves an existing path through symlinks", () => {
      const result = canonicalPath(join(tempRoot, "subdir"));
      expect(result).toBeDefined();
      expect(result).toBe(realpathSync(join(tempRoot, "subdir")));
    });

    test("returns undefined for a nonexistent path", () => {
      const result = canonicalPath(join(tempRoot, "does-not-exist"));
      expect(result).toBeUndefined();
    });
  });

  describe("isPathWithinDirectory", () => {
    test("accepts a child path that exists", () => {
      expect(isPathWithinDirectory(tempRoot, join(tempRoot, "subdir"))).toBe(
        true,
      );
    });

    test("rejects a nonexistent child path (fail closed)", () => {
      // A path that cannot be canonicalized must not be authorized — even
      // though its lexical form is inside the directory.
      expect(
        isPathWithinDirectory(tempRoot, join(tempRoot, "does-not-exist")),
      ).toBe(false);
    });

    test("rejects when the directory itself cannot be canonicalized", () => {
      expect(
        isPathWithinDirectory(
          join(tempRoot, "no-such-dir"),
          join(tempRoot, "subdir"),
        ),
      ).toBe(false);
    });

    test("rejects a path outside the directory", () => {
      expect(isPathWithinDirectory(tempRoot, tmpdir())).toBe(false);
    });

    test("rejects a symlink whose target escapes the directory", async () => {
      // The core security property: a symlink that looks like it lives inside
      // tempRoot but points outside must not launder itself through.
      const linkPath = join(tempRoot, "escape-link");
      await symlink(outsideRoot, linkPath);
      expect(isPathWithinDirectory(tempRoot, linkPath)).toBe(false);
    });
  });

  describe("isPathWithinDirectoryLexical", () => {
    test("accepts a child path", () => {
      expect(
        isPathWithinDirectoryLexical(tempRoot, join(tempRoot, "subdir")),
      ).toBe(true);
    });

    test("accepts the directory itself", () => {
      expect(isPathWithinDirectoryLexical(tempRoot, tempRoot)).toBe(true);
    });

    test("accepts a nonexistent child path (no canonicalization)", () => {
      // Unlike isPathWithinDirectory, the lexical variant does not require the
      // path to exist on disk — it is for already-trusted or loader-reported
      // paths that may not have a realpath.
      expect(
        isPathWithinDirectoryLexical(tempRoot, join(tempRoot, "no-such-file")),
      ).toBe(true);
    });

    test("rejects a parent escape via ..", () => {
      expect(
        isPathWithinDirectoryLexical(tempRoot, join(tempRoot, "..", "outside")),
      ).toBe(false);
    });

    test("rejects an absolute path outside the directory", () => {
      expect(isPathWithinDirectoryLexical(tempRoot, outsideRoot)).toBe(false);
    });
  });
});

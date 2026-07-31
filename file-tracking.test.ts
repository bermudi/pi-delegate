import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGitChangedFiles } from "./file-tracking.ts";

describe("getGitChangedFiles", () => {
  test("records filenames containing an arrow literally", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-file-tracking-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd });
      const filename = "before -> after.txt";
      writeFileSync(path.join(cwd, filename), "changed");

      const files = await getGitChangedFiles(cwd);

      expect(files).toEqual(new Set([path.join(cwd, filename)]));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resolves Git paths from the repository root for a nested cwd", async () => {
    const repoRoot = mkdtempSync(
      path.join(os.tmpdir(), "delegate-file-tracking-"),
    );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
      const cwd = path.join(repoRoot, "packages", "app");
      mkdirSync(cwd, { recursive: true });
      const changedFile = path.join(cwd, "changed.txt");
      writeFileSync(changedFile, "changed");

      const files = await getGitChangedFiles(cwd);

      expect(files).toEqual(new Set([changedFile]));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

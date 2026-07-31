import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});

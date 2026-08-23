import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findTouchedOverlaps } from "./format.ts";
import {
  extractTouchedFromActivities,
  getGitChangedFiles,
} from "./file-tracking.ts";

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

  test("returns undefined for a non-git directory", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-file-tracking-"));
    try {
      writeFileSync(path.join(cwd, "changed.txt"), "changed");

      const files = await getGitChangedFiles(cwd);

      expect(files).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("extractTouchedFromActivities", () => {
  const cwd = "/home/user/project";

  test("includes successful edit/write calls in touched/attributed files", () => {
    const activities = [
      {
        id: "1",
        name: "write",
        args: { path: "src/foo.ts", content: "..." },
        startTime: 0,
        result: { content: [], isError: false },
      },
      {
        id: "2",
        name: "edit",
        args: { path: "src/bar.ts" },
        startTime: 0,
        result: { content: [], isError: false },
      },
    ];

    const result = extractTouchedFromActivities(activities as any, cwd);

    expect(result).toEqual([
      path.resolve(cwd, "src/foo.ts"),
      path.resolve(cwd, "src/bar.ts"),
    ]);
  });

  test("conservatively includes failed edit/write calls", () => {
    const activities = [
      {
        id: "1",
        name: "write",
        args: { path: "ok.ts", content: "..." },
        startTime: 0,
        result: { content: [], isError: false },
      },
      {
        id: "2",
        name: "edit",
        args: { path: "bad.ts" },
        startTime: 0,
        result: {
          content: [{ type: "text", text: "validation error" }],
          isError: true,
        },
      },
    ];

    expect(extractTouchedFromActivities(activities as any, cwd)).toEqual([
      path.resolve(cwd, "ok.ts"),
      path.resolve(cwd, "bad.ts"),
    ]);
  });

  test("conservatively includes interrupted edit/write calls", () => {
    const activities = [
      {
        id: "1",
        name: "write",
        args: { path: "src/ok.ts", content: "..." },
        startTime: 0,
        result: { content: [], isError: false },
      },
      {
        id: "2",
        name: "edit",
        args: { path: "src/interrupted.ts" },
        startTime: 0,
      },
    ];

    expect(extractTouchedFromActivities(activities as any, cwd)).toEqual([
      path.resolve(cwd, "src/ok.ts"),
      path.resolve(cwd, "src/interrupted.ts"),
    ]);
  });

  test("failed and interrupted calls conservatively trigger overlap warnings", () => {
    const shared = path.resolve(cwd, "shared.ts");
    const successful = extractTouchedFromActivities(
      [
        {
          id: "1",
          name: "write",
          args: { path: "shared.ts", content: "..." },
          startTime: 0,
          result: { content: [], isError: false },
        },
      ] as any,
      cwd,
    );
    const failed = extractTouchedFromActivities(
      [
        {
          id: "2",
          name: "edit",
          args: { path: "shared.ts" },
          startTime: 0,
          result: { content: [], isError: true },
        },
      ] as any,
      cwd,
    );
    const interrupted = extractTouchedFromActivities(
      [
        {
          id: "3",
          name: "write",
          args: { path: "shared.ts", content: "..." },
          startTime: 0,
        },
      ] as any,
      cwd,
    );

    expect(failed).toEqual([shared]);
    expect(interrupted).toEqual([shared]);
    expect(
      findTouchedOverlaps([
        { attributedFiles: successful },
        { attributedFiles: failed },
        { attributedFiles: interrupted },
      ]),
    ).toEqual([shared]);
  });
});

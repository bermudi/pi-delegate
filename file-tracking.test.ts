import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findTouchedOverlaps } from "./format.ts";
import {
  extractTouchedFromActivities,
  getGitChangedFiles,
  revalidateFileAttribution,
  snapshotPhysicalToolTarget,
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

describe("snapshotPhysicalToolTarget", () => {
  test("marks EACCES canonicalization uncertain and logs candidate plus errno", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-attribution-"));
    const candidate = path.join(cwd, "blocked.txt");
    const original = fs.lstatSync;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((
      value: fs.PathLike,
      options?: Parameters<typeof fs.lstatSync>[1],
    ) => {
      if (path.resolve(String(value)) === candidate) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return original(value, options as never);
    }) as typeof fs.lstatSync);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const attribution = snapshotPhysicalToolTarget(
        { name: "write", args: { path: candidate } },
        cwd,
      );
      expect(attribution?.lexicalPath).toBe(candidate);
      expect(attribution?.preExecutionPhysicalPath).toBeUndefined();
      expect(attribution?.uncertain).toBe(true);
      expect(String(log.mock.calls[0]?.[0])).toContain(candidate);
      expect(String(log.mock.calls[0]?.[0])).toContain("errno=EACCES");
    } finally {
      lstat.mockRestore();
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not count ordinary path components toward the symlink expansion limit", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-attribution-"));
    const deepDirectory = path.join(cwd, ...Array(300).fill("d"));
    const candidate = path.join(deepDirectory, "target.txt");
    mkdirSync(deepDirectory, { recursive: true });
    writeFileSync(candidate, "target");
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const attribution = snapshotPhysicalToolTarget(
        { name: "edit", args: { path: candidate } },
        cwd,
      );
      expect(attribution?.preExecutionPhysicalPath).toBe(candidate);
      expect(attribution?.uncertain).toBe(false);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("marks an existing leaf replaced by a symlink uncertain", () => {
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-attribution-"));
    const candidate = path.join(cwd, "target.txt");
    const external = path.join(cwd, "external.txt");
    writeFileSync(candidate, "target");
    writeFileSync(external, "external");
    try {
      const attribution = snapshotPhysicalToolTarget(
        { name: "write", args: { path: candidate } },
        cwd,
      )!;
      expect(
        attribution.preExecutionPathSignatures?.some(
          (signature) => signature.path === candidate,
        ),
      ).toBe(true);
      expect(attribution.uncertain).toBe(false);

      fs.unlinkSync(candidate);
      fs.symlinkSync(external, candidate);

      expect(revalidateFileAttribution(attribution).uncertain).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("keeps a missing leaf uncertain when it is created as a symlink", () => {
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-attribution-"));
    const candidate = path.join(cwd, "missing.txt");
    const external = path.join(cwd, "external.txt");
    writeFileSync(external, "external");
    try {
      const attribution = snapshotPhysicalToolTarget(
        { name: "write", args: { path: candidate } },
        cwd,
      )!;
      expect(attribution.preExecutionPhysicalPath).toBe(candidate);
      expect(attribution.uncertain).toBe(true);

      fs.symlinkSync(external, candidate);

      expect(revalidateFileAttribution(attribution).uncertain).toBe(true);
      expect(
        revalidateFileAttribution(attribution).preExecutionPhysicalPath,
      ).toBe(candidate);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("revalidates every pre-execution symlink-chain identity", () => {
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-attribution-"));
    const first = path.join(cwd, "first");
    const second = path.join(cwd, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "target.txt"), "first");
    fs.writeFileSync(path.join(second, "target.txt"), "second");
    const alias = path.join(cwd, "alias");
    fs.symlinkSync(first, alias);
    try {
      const attribution = snapshotPhysicalToolTarget(
        { name: "edit", args: { path: path.join(alias, "target.txt") } },
        cwd,
      )!;
      expect(attribution.preExecutionPhysicalPath).toBe(
        path.join(first, "target.txt"),
      );
      expect(
        attribution.preExecutionPathSignatures?.some(
          (signature) => signature.path === alias,
        ),
      ).toBe(true);
      expect(attribution.uncertain).toBe(false);

      fs.unlinkSync(alias);
      fs.symlinkSync(second, alias);
      const revalidated = revalidateFileAttribution(attribution);
      expect(revalidated.preExecutionPhysicalPath).toBe(
        path.join(first, "target.txt"),
      );
      expect(revalidated.uncertain).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("JSON-escapes model-supplied candidates in canonicalization logs", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-attribution-"));
    const candidate = path.join(cwd, "bad\n\u001b[31m.txt");
    const original = fs.lstatSync;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((
      value: fs.PathLike,
      options?: Parameters<typeof fs.lstatSync>[1],
    ) => {
      if (path.resolve(String(value)) === candidate) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return original(value, options as never);
    }) as typeof fs.lstatSync);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      snapshotPhysicalToolTarget(
        { name: "write", args: { path: candidate } },
        cwd,
      );
      const message = String(log.mock.calls[0]?.[0]);
      expect(message).toContain("bad\\n\\u001b[31m.txt");
      expect(message).not.toContain("bad\n");
      expect(message).not.toContain("\u001b");
    } finally {
      lstat.mockRestore();
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("marks ELOOP canonicalization uncertain and logs candidate plus errno", () => {
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(path.join(os.tmpdir(), "delegate-attribution-"));
    const candidate = path.join(cwd, "loop-a");
    fs.symlinkSync("loop-b", candidate);
    fs.symlinkSync("loop-a", path.join(cwd, "loop-b"));
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const attribution = snapshotPhysicalToolTarget(
        { name: "edit", args: { path: candidate } },
        cwd,
      );
      expect(attribution?.lexicalPath).toBe(candidate);
      expect(attribution?.preExecutionPhysicalPath).toBeUndefined();
      expect(attribution?.uncertain).toBe(true);
      expect(String(log.mock.calls[0]?.[0])).toContain(candidate);
      expect(String(log.mock.calls[0]?.[0])).toContain("errno=ELOOP");
    } finally {
      log.mockRestore();
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

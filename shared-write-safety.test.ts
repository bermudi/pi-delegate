import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findSharedWriteConflicts,
  resolveSharedWriteScope,
  SharedWriteSafetyError,
} from "./shared-write-safety.ts";
import type { ResolvedTask } from "./types.ts";

function initRepository(directory: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
}

function task(
  cwd: string,
  tools: string[],
  workspace: "shared" | "scratch" = "shared",
): ResolvedTask {
  return {
    prompt: "work",
    model: { provider: "test", id: "model" } as never,
    tools,
    thinking: "off",
    systemPrompt: "",
    cwd,
    workspace,
    agentName: "test",
    warnings: [],
  };
}

describe("shared-write safety", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "delegate-write-safety-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("groups nested directories in the same Git repository", async () => {
    initRepository(root);
    const left = path.join(root, "packages", "left");
    const right = path.join(root, "packages", "right");
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });

    const conflicts = await findSharedWriteConflicts([
      task(left, ["write"]),
      task(right, ["bash"]),
    ]);

    expect(conflicts).toEqual([
      {
        scope: { kind: "git", root },
        taskIndexes: [0, 1],
      },
    ]);
  });

  test("canonicalizes symlink aliases before grouping", async () => {
    initRepository(root);
    const nested = path.join(root, "nested");
    const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
    mkdirSync(nested);
    symlinkSync(nested, alias);
    try {
      const conflicts = await findSharedWriteConflicts([
        task(nested, ["edit"]),
        task(alias, ["write"]),
      ]);
      expect(conflicts[0]?.taskIndexes).toEqual([0, 1]);
      expect(conflicts[0]?.scope).toEqual({ kind: "git", root });
    } finally {
      rmSync(alias, { force: true });
    }
  });

  test("ignores ambient Git discovery limits when resolving physical scopes", async () => {
    initRepository(root);
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    try {
      const conflicts = await findSharedWriteConflicts([
        task(left, ["write"]),
        task(right, ["bash"]),
      ]);
      expect(conflicts[0]?.scope).toEqual({ kind: "git", root });
      expect(conflicts[0]?.taskIndexes).toEqual([0, 1]);
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
    }
  });

  test("fails closed when inherited Git variables redirect bash execution", async () => {
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    const previousGitDir = process.env.GIT_DIR;
    const previousWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = "/credential-free/test/repository.git";
    process.env.GIT_WORK_TREE = "/credential-free/test/worktree";
    try {
      await expect(
        findSharedWriteConflicts([
          task(left, ["write"]),
          task(right, ["bash"]),
        ]),
      ).rejects.toThrow("GIT_DIR, GIT_WORK_TREE");
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
      if (previousWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = previousWorkTree;
      }
    }
  });

  test("allows writers in separate Git repositories", async () => {
    const left = path.join(root, "left");
    const other = path.join(root, "other");
    mkdirSync(left);
    mkdirSync(other);
    initRepository(left);
    initRepository(other);

    expect(
      await findSharedWriteConflicts([
        task(left, ["write"]),
        task(other, ["bash"]),
      ]),
    ).toEqual([]);
  });

  test("rejects an outer repository and a nested repository", async () => {
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    initRepository(root);
    initRepository(nested);

    expect(
      await findSharedWriteConflicts([
        task(root, ["edit"]),
        task(nested, ["edit"]),
      ]),
    ).toEqual([
      {
        scope: { kind: "git", root },
        taskIndexes: [0, 1],
      },
    ]);
  });

  test("groups an external Git worktree with its physical directory", async () => {
    const gitDirectory = path.join(root, "repository.git");
    const worktree = path.join(root, "external-worktree");
    mkdirSync(worktree);
    execFileSync("git", ["init", "--bare", "--quiet", gitDirectory]);
    execFileSync("git", ["config", "core.bare", "false"], {
      cwd: gitDirectory,
    });
    execFileSync("git", ["config", "core.worktree", "../external-worktree"], {
      cwd: gitDirectory,
    });

    const conflicts = await findSharedWriteConflicts([
      task(gitDirectory, ["bash"]),
      task(worktree, ["write"]),
    ]);

    expect(conflicts).toEqual([
      {
        scope: { kind: "git", root: worktree },
        taskIndexes: [0, 1],
      },
    ]);
  });

  test("rejects a Git directory whose external worktree escapes its parent", async () => {
    // A bare repository.git lives under /outer and points its core.worktree at
    // a sibling directory outside /outer. Git's --show-toplevel reports the
    // external worktree, but a bash writer in repository.git can still reach
    // /outer/repository.git and below — so a second writer scoped to /outer
    // must be rejected, with the collision reported at the /outer directory.
    const outer = path.join(root, "outer");
    const gitDirectory = path.join(outer, "repository.git");
    const worktree = path.join(root, "external-worktree");
    mkdirSync(gitDirectory, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    execFileSync("git", ["init", "--bare", "--quiet", gitDirectory]);
    execFileSync("git", ["config", "core.bare", "false"], {
      cwd: gitDirectory,
    });
    execFileSync("git", ["config", "core.worktree", worktree], {
      cwd: gitDirectory,
    });

    const conflicts = await findSharedWriteConflicts([
      task(outer, ["write"]),
      task(gitDirectory, ["bash"]),
    ]);

    expect(conflicts).toEqual([
      {
        scope: { kind: "directory", root: outer },
        taskIndexes: [0, 1],
      },
    ]);
  });

  test("groups the same physical non-Git directory", async () => {
    const conflicts = await findSharedWriteConflicts([
      task(root, ["write"]),
      task(root, ["bash"]),
    ]);
    expect(conflicts).toEqual([
      {
        scope: { kind: "directory", root },
        taskIndexes: [0, 1],
      },
    ]);
  });

  test("allows distinct non-Git directories", async () => {
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    expect(
      await findSharedWriteConflicts([
        task(left, ["write"]),
        task(right, ["write"]),
      ]),
    ).toEqual([]);
  });

  test("rejects nested non-Git directories in either task order", async () => {
    const nested = path.join(root, "nested");
    mkdirSync(nested);

    expect(
      await findSharedWriteConflicts([
        task(root, ["write"]),
        task(nested, ["bash"]),
      ]),
    ).toEqual([
      {
        scope: { kind: "directory", root },
        taskIndexes: [0, 1],
      },
    ]);
    expect(
      await findSharedWriteConflicts([
        task(nested, ["bash"]),
        task(root, ["write"]),
      ]),
    ).toEqual([
      {
        scope: { kind: "directory", root },
        taskIndexes: [0, 1],
      },
    ]);
  });

  test("does not confuse path-prefix siblings with nested directories", async () => {
    const left = path.join(root, "work");
    const right = path.join(root, "work-other");
    mkdirSync(left);
    mkdirSync(right);

    expect(
      await findSharedWriteConflicts([
        task(left, ["write"]),
        task(right, ["bash"]),
      ]),
    ).toEqual([]);
  });

  test("ignores read-only and scratch tasks", async () => {
    initRepository(root);
    expect(
      await findSharedWriteConflicts([
        task(root, ["read", "grep"]),
        task(root, ["bash"], "scratch"),
        task(root, ["write"]),
      ]),
    ).toEqual([]);
  });

  test("fails closed by treating unknown tools as mutating", async () => {
    initRepository(root);
    expect(
      await findSharedWriteConflicts([
        task(root, ["future_extension_tool"]),
        task(root, ["write"]),
      ]),
    ).toEqual([
      {
        scope: { kind: "git", root },
        taskIndexes: [0, 1],
      },
    ]);
  });

  test("does not inspect Git or cwd for a single shared writer", async () => {
    expect(
      await findSharedWriteConflicts([
        task(path.join(root, "does-not-exist"), ["write"]),
      ]),
    ).toEqual([]);
  });

  test("preserves task-array order in conflict groups", async () => {
    initRepository(root);
    const conflicts = await findSharedWriteConflicts([
      task(root, ["write"]),
      task(root, ["read"]),
      task(root, ["bash"]),
      task(root, ["edit"]),
    ]);
    expect(conflicts[0]?.taskIndexes).toEqual([0, 2, 3]);
  });

  test("fails closed when a task directory cannot be resolved", async () => {
    const missing = path.join(root, "missing");
    await expect(resolveSharedWriteScope(missing)).rejects.toBeInstanceOf(
      SharedWriteSafetyError,
    );
  });
});

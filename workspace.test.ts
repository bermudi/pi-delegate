import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createScratchWorkspace } from "./workspace.ts";

function reflinkCapableTestDir(): string | undefined {
  // Put the fixture beside this checkout rather than in /tmp: CI and developer
  // systems commonly mount /tmp as tmpfs even when the project is on Btrfs.
  const root = fs.mkdtempSync(
    path.join(process.cwd(), ".delegate-scratch-test-"),
  );
  try {
    fs.writeFileSync(path.join(root, "source"), "probe");
    execFileSync(
      "cp",
      ["--reflink=always", path.join(root, "source"), path.join(root, "copy")],
      { stdio: "ignore" },
    );
    return root;
  } catch {
    fs.rmSync(root, { recursive: true, force: true });
    return undefined;
  }
}

function scratchWorkspaceAvailable(): boolean {
  if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) {
    return false;
  }
  const probe = reflinkCapableTestDir();
  if (!probe) return false;
  fs.rmSync(probe, { recursive: true, force: true });
  return true;
}

const scratchTest = test.skipIf(!scratchWorkspaceAvailable());

function testParent(): string {
  const parent = reflinkCapableTestDir();
  if (!parent) {
    throw new Error("Scratch reflink capability disappeared after test probe.");
  }
  return parent;
}

const SCRATCH_PREFIX = ".pi-delegate-scratch-";
const DEAD_PID = 2_000_000_000;

function testRepo(parent: string): string {
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  return repo;
}

function testLease(
  parent: string,
  name: string,
  options: {
    owner?: string;
    project?: boolean;
    unexpectedFile?: boolean;
  } = {},
): string {
  const lease = path.join(parent, `${SCRATCH_PREFIX}${name}`);
  fs.mkdirSync(lease, { mode: 0o700 });
  if (options.owner !== undefined) {
    fs.writeFileSync(path.join(lease, ".owner"), options.owner, {
      mode: 0o600,
    });
  }
  if (options.project) fs.mkdirSync(path.join(lease, "project"));
  if (options.unexpectedFile) {
    fs.writeFileSync(path.join(lease, "unexpected"), "not a project");
  }
  return lease;
}

describe("scratch workspace", () => {
  scratchTest("removes leases owned by dead processes", async () => {
    const parent = testParent();
    const repo = testRepo(parent);
    const staleLease = testLease(parent, "dead", {
      owner: `${DEAD_PID}\n`,
      project: true,
    });
    try {
      const workspace = await createScratchWorkspace(repo);
      await workspace.cleanup();
      expect(fs.existsSync(staleLease)).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  scratchTest("preserves leases owned by live processes", async () => {
    const parent = testParent();
    const repo = testRepo(parent);
    const liveLease = testLease(parent, "live", {
      owner: `${process.pid}\n`,
      project: true,
    });
    try {
      const workspace = await createScratchWorkspace(repo);
      await workspace.cleanup();
      expect(fs.existsSync(liveLease)).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  scratchTest(
    "preserves leases with missing or malformed owner markers",
    async () => {
      const parent = testParent();
      const repo = testRepo(parent);
      const missingOwner = testLease(parent, "missing-owner");
      const malformedOwner = testLease(parent, "malformed-owner", {
        owner: "not-a-pid\n",
        project: true,
      });
      try {
        const workspace = await createScratchWorkspace(repo);
        await workspace.cleanup();
        expect(fs.existsSync(missingOwner)).toBe(true);
        expect(fs.existsSync(malformedOwner)).toBe(true);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest("preserves leases containing unexpected files", async () => {
    const parent = testParent();
    const repo = testRepo(parent);
    const unexpectedLease = testLease(parent, "unexpected", {
      owner: `${DEAD_PID}\n`,
      project: true,
      unexpectedFile: true,
    });
    try {
      const workspace = await createScratchWorkspace(repo);
      await workspace.cleanup();
      expect(fs.existsSync(unexpectedLease)).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  scratchTest(
    "does not remove a lease directory replaced during the sweep",
    async () => {
      const parent = testParent();
      const repo = testRepo(parent);
      const replacedLease = testLease(parent, "replaced", {
        owner: `${DEAD_PID}\n`,
        project: true,
      });
      const originalOpen = fs.promises.open;
      let replaced = false;
      fs.promises.open = async (
        ...args: Parameters<typeof originalOpen>
      ): ReturnType<typeof originalOpen> => {
        const handle = await originalOpen(...args);
        if (!replaced && args[0] === parent) {
          replaced = true;
          fs.rmSync(replacedLease, { recursive: true, force: true });
          fs.mkdirSync(replacedLease, { mode: 0o700 });
          fs.writeFileSync(path.join(replacedLease, "replacement"), "keep");
        }
        return handle;
      };
      try {
        const workspace = await createScratchWorkspace(repo);
        await workspace.cleanup();
        expect(fs.existsSync(path.join(replacedLease, "replacement"))).toBe(
          true,
        );
      } finally {
        fs.promises.open = originalOpen;
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "copies the full Git tree, maps a nested cwd, and discards mutations",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const nested = path.join(repo, "packages", "widget");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(repo, "root.txt"), "original");
      fs.writeFileSync(path.join(nested, "file.txt"), "nested");
      execFileSync("git", ["init", "--quiet"], { cwd: repo });

      let scratchRoot: string | undefined;
      try {
        const workspace = await createScratchWorkspace(nested);
        scratchRoot = workspace.scratchRoot;
        expect(workspace.cwd).toBe(
          path.join(scratchRoot, "packages", "widget"),
        );
        expect(
          fs.readFileSync(path.join(scratchRoot, "root.txt"), "utf8"),
        ).toBe("original");

        const changed = path.join(workspace.cwd, "file.txt");
        fs.writeFileSync(changed, "changed");
        expect(fs.readFileSync(path.join(nested, "file.txt"), "utf8")).toBe(
          "nested",
        );
        expect(workspace.mapPathToSource(changed)).toBe(
          path.join(nested, "file.txt"),
        );

        await workspace.cleanup();
        await workspace.cleanup();
        expect(fs.existsSync(scratchRoot)).toBe(false);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "resolves external aliases to the physical host path",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const outside = path.join(parent, "outside");
      fs.mkdirSync(repo);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "host.txt"), "host");
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        const workspace = await createScratchWorkspace(repo);
        const alias = path.join(workspace.cwd, "host-link");
        fs.symlinkSync(outside, alias);

        expect(
          await workspace.resolveAttributedPath(path.join(alias, "host.txt")),
        ).toBe(path.join(outside, "host.txt"));
        expect(
          await workspace.resolveReportedPath(
            path.join(workspace.scratchRoot, "host-link", "host.txt"),
          ),
        ).toBe(path.join(outside, "host.txt"));
        expect(
          await workspace.resolveAttributedPath(
            path.join(workspace.scratchRoot, "inside.txt"),
          ),
        ).toBeUndefined();
        await workspace.cleanup();
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "rejects symlinks that let relative writes escape the copied tree",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const outside = path.join(parent, "shared");
      fs.mkdirSync(repo);
      fs.mkdirSync(outside);
      fs.symlinkSync("../shared", path.join(repo, "shared"));
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        await expect(createScratchWorkspace(repo)).rejects.toThrow(
          "points outside the project",
        );
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "rejects a .git symlink even when its target is inside the copy",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      fs.mkdirSync(repo);
      fs.writeFileSync(
        path.join(repo, "git-pointer"),
        "gitdir: /external/shared/metadata\n",
      );
      fs.symlinkSync("git-pointer", path.join(repo, ".git"));
      try {
        await expect(createScratchWorkspace(repo)).rejects.toThrow(
          "linked Git metadata",
        );
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "rejects nested Git repositories with an explicit unsupported message",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const nested = path.join(repo, "vendor", "fixture");
      fs.mkdirSync(nested, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      execFileSync("git", ["init", "--quiet"], { cwd: nested });
      try {
        await expect(createScratchWorkspace(repo)).rejects.toThrow(
          "does not support nested Git repositories",
        );
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "accepts valid descendants whose names begin with two dots",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      fs.mkdirSync(path.join(repo, "..cache"), { recursive: true });
      fs.writeFileSync(path.join(repo, "..cache", "file"), "ok");
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        const workspace = await createScratchWorkspace(repo);
        expect(
          workspace.mapPathToSource(
            path.join(workspace.scratchRoot, "..cache", "file"),
          ),
        ).toBe(path.join(repo, "..cache", "file"));
        await workspace.cleanup();
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "restores mode 0700 after archive copying source metadata",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      fs.mkdirSync(repo, { mode: 0o755 });
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        const workspace = await createScratchWorkspace(repo);
        expect(fs.statSync(workspace.scratchRoot).mode & 0o777).toBe(0o700);
        await workspace.cleanup();
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "rejects Git core.worktree redirects in an otherwise normal .git directory",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      execFileSync("git", ["config", "core.worktree", repo], { cwd: repo });
      try {
        await expect(createScratchWorkspace(repo)).rejects.toThrow(
          "redirects its worktree or metadata",
        );
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest(
    "prevents an ordinary rename of the exposed project root",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        const workspace = await createScratchWorkspace(repo);
        expect(() =>
          fs.renameSync(
            workspace.scratchRoot,
            path.join(path.dirname(workspace.scratchRoot), "renamed"),
          ),
        ).toThrow();
        await workspace.cleanup();
        expect(fs.existsSync(workspace.scratchRoot)).toBe(false);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  scratchTest("fails closed when Git metadata is malformed", async () => {
    const parent = testParent();
    const repo = path.join(parent, "repo");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, ".git"), "not valid git metadata\n");
    try {
      await expect(createScratchWorkspace(repo)).rejects.toThrow(
        "safely determine the scratch project root",
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  scratchTest(
    "rejects linked Git worktrees whose metadata would remain shared",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const linked = path.join(parent, "linked");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: repo,
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "file.txt"), "x");
      execFileSync("git", ["add", "file.txt"], { cwd: repo });
      execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
        cwd: repo,
      });
      execFileSync("git", ["worktree", "add", "--quiet", linked], {
        cwd: repo,
      });
      try {
        await expect(createScratchWorkspace(linked)).rejects.toThrow(
          "linked Git metadata",
        );
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );
});

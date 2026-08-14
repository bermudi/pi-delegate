import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createScratchWorkspace, _testHooks } from "./workspace.ts";

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
const fdTest = test.skipIf(
  process.platform !== "linux" ||
    !fs.existsSync("/proc/self/fd") ||
    process.getuid?.() === undefined,
);

function cleanTestDir(root: string): void {
  try {
    const makeWritable = (dir: string) => {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {}
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            makeWritable(child);
          }
        }
      } catch {}
    };
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
}

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

describe("scratch workspace stale cleanup", () => {
  fdTest(
    "ensureScratchContainer creates container directory with mode 0700",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(process.cwd(), ".delegate-scratch-test-"),
      );
      try {
        const container = path.join(tempDir, _testHooks.SCRATCH_CONTAINER_NAME);
        const uid = process.getuid!();
        await _testHooks.ensureScratchContainer(container, uid);

        expect(fs.existsSync(container)).toBe(true);
        const stat = fs.statSync(container);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o700);

        // Calling again is idempotent
        await _testHooks.ensureScratchContainer(container, uid);
        expect(fs.existsSync(container)).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  fdTest(
    "repairs an existing restrictive container to exactly mode 0700",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(process.cwd(), ".delegate-scratch-test-"),
      );
      try {
        const container = path.join(tempDir, _testHooks.SCRATCH_CONTAINER_NAME);
        fs.mkdirSync(container, { mode: 0o500 });
        fs.chmodSync(container, 0o500);

        await _testHooks.ensureScratchContainer(container, process.getuid!());

        expect(fs.statSync(container).mode & 0o777).toBe(0o700);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  fdTest(
    "sweep policy table: removes dead leases, preserves live/malformed/unexpected",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(process.cwd(), ".delegate-scratch-test-"),
      );
      try {
        const container = path.join(tempDir, _testHooks.SCRATCH_CONTAINER_NAME);
        fs.mkdirSync(container, { mode: 0o700 });

        const cases = [
          {
            name: "lease-dead",
            pid: `${DEAD_PID}\n`,
            mode: 0o600,
            project: true,
            shouldSurvive: false,
          },
          {
            name: "lease-live",
            pid: `${process.pid}\n`,
            mode: 0o600,
            project: true,
            shouldSurvive: true,
          },
          {
            name: "lease-no-owner",
            pid: undefined,
            mode: 0o600,
            project: true,
            shouldSurvive: true,
          },
          {
            name: "lease-bad-pid",
            pid: "not-a-pid\n",
            mode: 0o600,
            project: true,
            shouldSurvive: true,
          },
          {
            name: "lease-trailing-garbage",
            pid: `${DEAD_PID}oops\n`,
            mode: 0o600,
            project: true,
            shouldSurvive: true,
          },
          {
            name: "lease-zero-pid",
            pid: "0\n",
            mode: 0o600,
            project: true,
            shouldSurvive: true,
          },
          {
            name: "lease-negative-pid",
            pid: "-2\n",
            mode: 0o600,
            project: true,
            shouldSurvive: true,
          },
          {
            name: "lease-loose-mode",
            pid: `${DEAD_PID}\n`,
            mode: 0o666,
            project: true,
            shouldSurvive: true,
          },
          {
            name: "lease-unexpected-file",
            pid: `${DEAD_PID}\n`,
            mode: 0o600,
            project: true,
            extraFile: true,
            shouldSurvive: true,
          },
          {
            name: "lease-project-file",
            pid: `${DEAD_PID}\n`,
            mode: 0o600,
            projectFile: true,
            shouldSurvive: true,
          },
          {
            name: "lease-project-symlink",
            pid: `${DEAD_PID}\n`,
            mode: 0o600,
            projectSymlink: true,
            shouldSurvive: true,
          },
        ];

        for (const c of cases) {
          const leasePath = path.join(container, c.name);
          fs.mkdirSync(leasePath, { mode: 0o700 });
          if (c.pid !== undefined) {
            fs.writeFileSync(path.join(leasePath, ".owner"), c.pid, {
              mode: c.mode,
            });
          }
          if (c.project) {
            fs.mkdirSync(path.join(leasePath, "project"));
          }
          if (c.projectFile) {
            fs.writeFileSync(path.join(leasePath, "project"), "regular file");
          }
          if (c.projectSymlink) {
            fs.symlinkSync(tempDir, path.join(leasePath, "project"));
          }
          if (c.extraFile) {
            fs.writeFileSync(path.join(leasePath, "extra.txt"), "unexpected");
          }
        }

        await _testHooks.sweepStaleScratchLeases(container);

        for (const c of cases) {
          const leasePath = path.join(container, c.name);
          expect(fs.existsSync(leasePath)).toBe(c.shouldSurvive);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  fdTest(
    "sweeps legacy .pi-delegate-scratch-* leases in parent directory",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(process.cwd(), ".delegate-scratch-test-"),
      );
      try {
        const legacyDead = path.join(tempDir, ".pi-delegate-scratch-dead");
        fs.mkdirSync(legacyDead, { mode: 0o700 });
        fs.writeFileSync(path.join(legacyDead, ".owner"), `${DEAD_PID}\n`, {
          mode: 0o600,
        });
        fs.mkdirSync(path.join(legacyDead, "project"));

        const legacyLive = path.join(tempDir, ".pi-delegate-scratch-live");
        fs.mkdirSync(legacyLive, { mode: 0o700 });
        fs.writeFileSync(path.join(legacyLive, ".owner"), `${process.pid}\n`, {
          mode: 0o600,
        });
        fs.mkdirSync(path.join(legacyLive, "project"));

        await _testHooks.sweepStaleScratchLeases(tempDir, {
          prefix: _testHooks.SCRATCH_LEGACY_PREFIX,
        });

        expect(fs.existsSync(legacyDead)).toBe(false);
        expect(fs.existsSync(legacyLive)).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  fdTest(
    "race: sweep does not remove a lease directory replaced after open",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(process.cwd(), ".delegate-scratch-test-"),
      );
      try {
        const container = path.join(tempDir, _testHooks.SCRATCH_CONTAINER_NAME);
        fs.mkdirSync(container, { mode: 0o700 });
        const leaseName = "lease-race";
        const leasePath = path.join(container, leaseName);
        fs.mkdirSync(leasePath, { mode: 0o700 });
        fs.writeFileSync(path.join(leasePath, ".owner"), `${DEAD_PID}\n`, {
          mode: 0o600,
        });
        fs.mkdirSync(path.join(leasePath, "project"));

        let hookFired = false;
        await _testHooks.sweepStaleScratchLeases(container, {
          onLeaseOpened: async (openedName) => {
            if (openedName === leaseName) {
              hookFired = true;
              fs.rmSync(leasePath, { recursive: true, force: true });
              fs.mkdirSync(leasePath, { mode: 0o700 });
              fs.writeFileSync(path.join(leasePath, "replacement.txt"), "keep");
            }
          },
        });

        expect(hookFired).toBe(true);
        expect(fs.existsSync(path.join(leasePath, "replacement.txt"))).toBe(
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  fdTest(
    "race: sweep preserves a lease renamed after it is opened",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(process.cwd(), ".delegate-scratch-test-"),
      );
      try {
        const container = path.join(tempDir, _testHooks.SCRATCH_CONTAINER_NAME);
        fs.mkdirSync(container, { mode: 0o700 });
        const leasePath = path.join(container, "lease-renamed");
        const movedPath = path.join(container, "lease-moved");
        fs.mkdirSync(path.join(leasePath, "project"), { recursive: true });
        fs.writeFileSync(path.join(leasePath, "project", "keep.txt"), "keep");
        fs.writeFileSync(path.join(leasePath, ".owner"), `${DEAD_PID}\n`, {
          mode: 0o600,
        });

        await _testHooks.sweepStaleScratchLeases(container, {
          onLeaseOpened: (openedName) => {
            if (openedName === "lease-renamed")
              fs.renameSync(leasePath, movedPath);
          },
        });

        expect(fs.existsSync(leasePath)).toBe(false);
        expect(
          fs.readFileSync(path.join(movedPath, "project", "keep.txt"), "utf8"),
        ).toBe("keep");
        expect(fs.existsSync(path.join(movedPath, ".owner"))).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  fdTest(
    "race: sweep preserves a project replaced before removal",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(process.cwd(), ".delegate-scratch-test-"),
      );
      try {
        const container = path.join(tempDir, _testHooks.SCRATCH_CONTAINER_NAME);
        fs.mkdirSync(container, { mode: 0o700 });
        const leasePath = path.join(container, "lease-project-race");
        const projectPath = path.join(leasePath, "project");
        fs.mkdirSync(projectPath, { recursive: true });
        fs.writeFileSync(path.join(leasePath, ".owner"), `${DEAD_PID}\n`, {
          mode: 0o600,
        });

        await _testHooks.sweepStaleScratchLeases(container, {
          onLeaseValidated: () => {
            fs.rmSync(projectPath, { recursive: true, force: true });
            fs.mkdirSync(projectPath, { mode: 0o700 });
            fs.writeFileSync(path.join(projectPath, "replacement.txt"), "keep");
          },
        });

        expect(fs.existsSync(leasePath)).toBe(true);
        expect(
          fs.readFileSync(path.join(projectPath, "replacement.txt"), "utf8"),
        ).toBe("keep");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  fdTest(
    "race: concurrent sweeps converge safely without throwing or corrupting live leases",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(process.cwd(), ".delegate-scratch-test-"),
      );
      try {
        const container = path.join(tempDir, _testHooks.SCRATCH_CONTAINER_NAME);
        fs.mkdirSync(container, { mode: 0o700 });

        const dead1 = path.join(container, "lease-dead1");
        const dead2 = path.join(container, "lease-dead2");
        const dead3 = path.join(container, "lease-dead3");
        const live = path.join(container, "lease-live");

        for (const d of [dead1, dead2, dead3]) {
          fs.mkdirSync(d, { mode: 0o700 });
          fs.writeFileSync(path.join(d, ".owner"), `${DEAD_PID}\n`, {
            mode: 0o600,
          });
          fs.mkdirSync(path.join(d, "project"));
        }

        fs.mkdirSync(live, { mode: 0o700 });
        fs.writeFileSync(path.join(live, ".owner"), `${process.pid}\n`, {
          mode: 0o600,
        });
        fs.mkdirSync(path.join(live, "project"));

        await Promise.all([
          _testHooks.sweepStaleScratchLeases(container),
          _testHooks.sweepStaleScratchLeases(container),
          _testHooks.sweepStaleScratchLeases(container),
          _testHooks.sweepStaleScratchLeases(container),
          _testHooks.sweepStaleScratchLeases(container),
        ]);

        expect(fs.existsSync(dead1)).toBe(false);
        expect(fs.existsSync(dead2)).toBe(false);
        expect(fs.existsSync(dead3)).toBe(false);
        expect(fs.existsSync(live)).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

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
      cleanTestDir(parent);
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
      cleanTestDir(parent);
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
        cleanTestDir(parent);
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
      cleanTestDir(parent);
    }
  });

  scratchTest(
    "identity: cleanup refuses to remove a lease directory whose inode changed",
    async () => {
      const parent = testParent();
      const repo = testRepo(parent);
      try {
        const workspace = await createScratchWorkspace(repo);
        const leaseRoot = path.dirname(workspace.scratchRoot);

        fs.chmodSync(leaseRoot, 0o700);
        fs.rmSync(leaseRoot, { recursive: true, force: true });
        fs.mkdirSync(leaseRoot, { mode: 0o700 });
        fs.mkdirSync(path.join(leaseRoot, "project"), { mode: 0o700 });
        fs.writeFileSync(path.join(leaseRoot, "keep.txt"), "survive");

        await expect(workspace.cleanup()).rejects.toThrow("moved or replaced");
        expect(fs.existsSync(path.join(leaseRoot, "keep.txt"))).toBe(true);
      } finally {
        cleanTestDir(parent);
      }
    },
  );

  scratchTest(
    "identity: cleanup refuses to remove a project directory whose inode changed",
    async () => {
      const parent = testParent();
      const repo = testRepo(parent);
      try {
        const workspace = await createScratchWorkspace(repo);
        const leaseRoot = path.dirname(workspace.scratchRoot);
        const projectRoot = workspace.scratchRoot;

        fs.chmodSync(leaseRoot, 0o700);
        fs.rmSync(projectRoot, { recursive: true, force: true });
        fs.mkdirSync(projectRoot, { mode: 0o700 });
        fs.writeFileSync(path.join(projectRoot, "keep.txt"), "survive");
        fs.chmodSync(leaseRoot, 0o500);

        await expect(workspace.cleanup()).rejects.toThrow("moved or replaced");
        expect(fs.existsSync(path.join(projectRoot, "keep.txt"))).toBe(true);
      } finally {
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
        cleanTestDir(parent);
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
      cleanTestDir(parent);
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
        cleanTestDir(parent);
      }
    },
  );
});

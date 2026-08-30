import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { snapshotPhysicalToolTarget } from "./file-tracking.ts";
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
    return;
  } catch (error) {
    // 0500 lease roots make chmod/rm failures an expected recoverable case,
    // so teardown stays non-fatal — but it must leave a visible signal.
    console.warn(`[delegate] test teardown failed for '${root}':`, error);
  }
  if (fs.existsSync(root)) {
    console.warn(
      `[delegate] test teardown left '${root}' behind; remove it manually`,
    );
  }
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

  test("creates the container when uid lookup is unavailable", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(process.cwd(), ".delegate-scratch-test-"),
    );
    try {
      const container = path.join(tempDir, _testHooks.SCRATCH_CONTAINER_NAME);
      await _testHooks.ensureScratchContainer(container, undefined);

      expect(fs.existsSync(container)).toBe(true);
      expect(fs.statSync(container).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

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
            const ownerPath = path.join(leasePath, ".owner");
            fs.writeFileSync(ownerPath, c.pid, {
              mode: c.mode,
            });
            fs.chmodSync(ownerPath, c.mode);
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

        // Markerless leases (pre-owner-marker versions, or a crash between
        // mkdtemp and the marker write): only the empty one is reclaimed.
        const legacyMarkerlessEmpty = path.join(
          tempDir,
          ".pi-delegate-scratch-markerless-empty",
        );
        fs.mkdirSync(legacyMarkerlessEmpty, { mode: 0o700 });
        const legacyMarkerlessFull = path.join(
          tempDir,
          ".pi-delegate-scratch-markerless-full",
        );
        fs.mkdirSync(legacyMarkerlessFull, { mode: 0o700 });
        fs.mkdirSync(path.join(legacyMarkerlessFull, "project"));

        await _testHooks.sweepStaleScratchLeases(tempDir, {
          prefix: _testHooks.SCRATCH_LEGACY_PREFIX,
        });

        expect(fs.existsSync(legacyDead)).toBe(false);
        expect(fs.existsSync(legacyLive)).toBe(true);
        expect(fs.existsSync(legacyMarkerlessEmpty)).toBe(false);
        expect(fs.existsSync(legacyMarkerlessFull)).toBe(true);
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
    "reclaims empty markerless leases, preserves non-empty or malformed ones",
    async () => {
      const parent = testParent();
      const repo = testRepo(parent);
      // Empty and markerless: a pre-owner-marker legacy lease or a crash
      // between mkdtemp and the marker write — unambiguously ours, reclaimed.
      const emptyMarkerless = testLease(parent, "empty-markerless");
      // Markerless but non-empty: may be an unrelated directory, preserved.
      const markerlessFull = testLease(parent, "markerless-full", {
        project: true,
      });
      const malformedOwner = testLease(parent, "malformed-owner", {
        owner: "not-a-pid\n",
        project: true,
      });
      try {
        const workspace = await createScratchWorkspace(repo);
        await workspace.cleanup();
        expect(fs.existsSync(emptyMarkerless)).toBe(false);
        expect(fs.existsSync(markerlessFull)).toBe(true);
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
    "identity: cleanup refuses to remove a replaced owner marker",
    async () => {
      const parent = testParent();
      const repo = testRepo(parent);
      try {
        const workspace = await createScratchWorkspace(repo);
        const leaseRoot = path.dirname(workspace.scratchRoot);
        const ownerPath = path.join(leaseRoot, ".owner");

        fs.chmodSync(leaseRoot, 0o700);
        fs.renameSync(ownerPath, path.join(leaseRoot, ".owner-old"));
        fs.writeFileSync(ownerPath, `${process.pid}\n`, { mode: 0o600 });
        fs.chmodSync(leaseRoot, 0o500);

        await expect(workspace.cleanup()).rejects.toThrow(
          "owner marker was replaced",
        );
        expect(fs.existsSync(workspace.scratchRoot)).toBe(true);
        expect(fs.existsSync(ownerPath)).toBe(true);
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
    "retains leaf races while suppressing only certain unchanged symlinks",
    async () => {
      if (process.platform === "win32") return;
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const outside = path.join(parent, "outside.txt");
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, "node.txt"), "baseline");
      fs.writeFileSync(path.join(repo, "target.txt"), "target");
      fs.symlinkSync("target.txt", path.join(repo, "link.txt"));
      fs.writeFileSync(outside, "outside");
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        const workspace = await createScratchWorkspace(repo);
        const node = path.join(workspace.cwd, "node.txt");
        const nodeAttribution = snapshotPhysicalToolTarget(
          { name: "write", args: { path: node } },
          workspace.cwd,
        )!;
        fs.unlinkSync(node);
        fs.symlinkSync(outside, node);

        const replacedNode =
          await workspace.resolveFileAttribution?.(nodeAttribution);
        expect(replacedNode?.lexicalPath).toBe(path.join(repo, "node.txt"));
        expect(replacedNode?.preExecutionPhysicalPath).toBe(
          path.join(repo, "node.txt"),
        );
        expect(replacedNode?.uncertain).toBe(true);

        const missing = path.join(workspace.cwd, "missing.txt");
        const missingAttribution = snapshotPhysicalToolTarget(
          { name: "write", args: { path: missing } },
          workspace.cwd,
        )!;
        fs.symlinkSync(outside, missing);
        const createdNode =
          await workspace.resolveFileAttribution?.(missingAttribution);
        expect(createdNode?.lexicalPath).toBe(path.join(repo, "missing.txt"));
        expect(createdNode?.preExecutionPhysicalPath).toBe(
          path.join(repo, "missing.txt"),
        );
        expect(createdNode?.uncertain).toBe(true);

        expect(
          await workspace.resolveAttributedLexicalTouch?.({
            lexicalPath: path.join(workspace.cwd, "link.txt"),
            preExecutionPhysicalPath: path.join(workspace.cwd, "target.txt"),
            provenance: "edit",
            uncertain: false,
          }),
        ).toBeUndefined();
        expect(
          await workspace.resolveAttributedLexicalTouch?.({
            lexicalPath: path.join(workspace.cwd, "link.txt"),
            preExecutionPhysicalPath: path.join(workspace.cwd, "target.txt"),
            provenance: "edit",
            uncertain: true,
          }),
        ).toBe(path.join(repo, "link.txt"));
        expect(
          await workspace.resolveFileAttribution?.({
            lexicalPath: path.join(workspace.cwd, "uncertain.txt"),
            provenance: "write",
            uncertain: true,
          }),
        ).toEqual({
          lexicalPath: path.join(repo, "uncertain.txt"),
          preExecutionPhysicalPath: undefined,
          provenance: "write",
          uncertain: true,
        });
        await workspace.cleanup();
      } finally {
        cleanTestDir(parent);
      }
    },
  );

  scratchTest(
    "retains lexical source evidence across readlink races and logs unexpected failures",
    async () => {
      if (process.platform === "win32") return;
      const parent = testParent();
      const repo = path.join(parent, "repo");
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, "target.txt"), "target");
      fs.symlinkSync("target.txt", path.join(repo, "link.txt"));
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        const workspace = await createScratchWorkspace(repo);
        const scratchLink = path.join(workspace.cwd, "link.txt");
        const sourceLink = path.join(repo, "link.txt");
        const original = fs.promises.readlink;
        let failureCode = "ENOENT";
        const readlink = spyOn(fs.promises, "readlink").mockImplementation(
          async (candidate, options) => {
            if (path.resolve(String(candidate)) === scratchLink) {
              throw Object.assign(new Error("simulated readlink race"), {
                code: failureCode,
              });
            }
            return original(candidate, options as never) as Promise<string>;
          },
        );
        const attribution = {
          lexicalPath: scratchLink,
          preExecutionPhysicalPath: path.join(workspace.cwd, "target.txt"),
          provenance: "write" as const,
          uncertain: false,
        };
        try {
          expect(
            await workspace.resolveAttributedLexicalTouch?.(attribution),
          ).toBe(sourceLink);
          expect(log).not.toHaveBeenCalled();

          failureCode = "EACCES";
          expect(
            await workspace.resolveAttributedLexicalTouch?.(attribution),
          ).toBe(sourceLink);
          expect(String(log.mock.calls.at(-1)?.[0])).toContain(
            "scratch attribution readlink failed",
          );
          expect(String(log.mock.calls.at(-1)?.[0])).toContain("errno=EACCES");
        } finally {
          readlink.mockRestore();
          await workspace.cleanup();
        }
      } finally {
        log.mockRestore();
        cleanTestDir(parent);
      }
    },
  );

  scratchTest(
    "retains lexical source evidence when a symlink changes during readlink",
    async () => {
      if (process.platform === "win32") return;
      const parent = testParent();
      const repo = path.join(parent, "repo");
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, "target.txt"), "target");
      fs.symlinkSync("target.txt", path.join(repo, "link.txt"));
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        const workspace = await createScratchWorkspace(repo);
        const scratchLink = path.join(workspace.cwd, "link.txt");
        const sourceLink = path.join(repo, "link.txt");
        const original = fs.promises.readlink;
        let replaced = false;
        const readlink = spyOn(fs.promises, "readlink").mockImplementation(
          async (candidate, options) => {
            const target = (await original(
              candidate,
              options as never,
            )) as string;
            if (!replaced && path.resolve(String(candidate)) === scratchLink) {
              replaced = true;
              fs.unlinkSync(scratchLink);
              fs.writeFileSync(scratchLink, "replacement");
            }
            return target;
          },
        );
        try {
          expect(
            await workspace.resolveAttributedLexicalTouch?.({
              lexicalPath: scratchLink,
              preExecutionPhysicalPath: path.join(workspace.cwd, "target.txt"),
              provenance: "write",
              uncertain: false,
            }),
          ).toBe(sourceLink);
        } finally {
          readlink.mockRestore();
          await workspace.cleanup();
        }
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
          "resolves outside the disposable copy",
        );
      } finally {
        cleanTestDir(parent);
      }
    },
  );

  scratchTest(
    "retargets in-project absolute symlinks at their copied counterparts",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const nested = path.join(repo, "packages", "consumer");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(repo, "target.txt"), "target");
      fs.mkdirSync(path.join(repo, "packages", "provider"));
      fs.writeFileSync(
        path.join(repo, "packages", "provider", "index.ts"),
        "provider",
      );
      // The shape bun/pnpm local package installs leave behind: link text is
      // absolute and inside the repository.
      fs.symlinkSync(path.join(repo, "target.txt"), path.join(repo, "abs.txt"));
      fs.symlinkSync(
        path.join(repo, "packages", "provider", "index.ts"),
        path.join(nested, "index.ts"),
      );
      // A symlinked directory is never traversed as a directory, so it must be
      // retargeted as a link; the project root itself projects onto ".".
      fs.symlinkSync(
        path.join(repo, "packages", "provider"),
        path.join(repo, "provider-link"),
      );
      fs.symlinkSync(repo, path.join(repo, "self"));
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        const workspace = await createScratchWorkspace(repo);
        const copiedRootLink = path.join(workspace.scratchRoot, "abs.txt");
        const copiedNestedLink = path.join(
          workspace.scratchRoot,
          "packages",
          "consumer",
          "index.ts",
        );

        expect(fs.readlinkSync(copiedRootLink)).toBe("target.txt");
        expect(fs.readlinkSync(copiedNestedLink)).toBe(
          path.join("..", "provider", "index.ts"),
        );
        expect(fs.realpathSync(copiedRootLink)).toBe(
          path.join(workspace.scratchRoot, "target.txt"),
        );
        expect(fs.readFileSync(copiedNestedLink, "utf8")).toBe("provider");
        expect(
          fs.readlinkSync(path.join(workspace.scratchRoot, "provider-link")),
        ).toBe(path.join("packages", "provider"));
        expect(fs.readlinkSync(path.join(workspace.scratchRoot, "self"))).toBe(
          ".",
        );

        // A retargeted link is still an unchanged copied node, so reading
        // through it must not be reported as a touched source path.
        const touchArguments = {
          lexicalPath: copiedRootLink,
          preExecutionPhysicalPath: path.join(
            workspace.scratchRoot,
            "target.txt",
          ),
          provenance: "edit" as const,
          uncertain: false,
        };
        expect(
          await workspace.resolveAttributedLexicalTouch?.(touchArguments),
        ).toBeUndefined();

        // Replacing the retargeted link is a change to the node itself, so its
        // source path must still be reported.
        fs.unlinkSync(copiedRootLink);
        fs.symlinkSync("other.txt", copiedRootLink);
        expect(
          await workspace.resolveAttributedLexicalTouch?.(touchArguments),
        ).toBe(path.join(repo, "abs.txt"));
        await workspace.cleanup();
      } finally {
        cleanTestDir(parent);
      }
    },
  );

  scratchTest(
    "rejects absolute symlinks whose targets are outside the project",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const outside = path.join(parent, "shared");
      fs.mkdirSync(repo);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "file.txt"), "host");
      fs.symlinkSync(
        path.join(outside, "file.txt"),
        path.join(repo, "host.txt"),
      );
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        await expect(createScratchWorkspace(repo)).rejects.toThrow(
          "resolves outside the disposable copy",
        );
      } finally {
        cleanTestDir(parent);
      }
    },
  );

  scratchTest(
    "rejects absolute symlinks into a directory sharing the project prefix",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      // 'repo-other' shares the source root's string prefix without being a
      // descendant: retargeting it would project a host path into the copy.
      const sibling = path.join(parent, "repo-other");
      fs.mkdirSync(repo);
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, "file.txt"), "host");
      fs.symlinkSync(
        path.join(sibling, "file.txt"),
        path.join(repo, "sibling.txt"),
      );
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        await expect(createScratchWorkspace(repo)).rejects.toThrow(
          "resolves outside the disposable copy",
        );
      } finally {
        cleanTestDir(parent);
      }
    },
  );

  scratchTest(
    "fails closed when a retarget cannot be written into the copy",
    async () => {
      if (process.getuid?.() === 0) return;
      const parent = testParent();
      const repo = path.join(parent, "repo");
      const locked = path.join(repo, "locked");
      fs.mkdirSync(locked, { recursive: true });
      fs.writeFileSync(path.join(repo, "target.txt"), "target");
      fs.symlinkSync(path.join(repo, "target.txt"), path.join(locked, "link"));
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      // --archive reproduces the source mode, so the copied directory refuses
      // the staging entry the retarget needs.
      fs.chmodSync(locked, 0o500);
      try {
        await expect(createScratchWorkspace(repo)).rejects.toThrow(
          "could not retarget in-project symlink",
        );
        // The read-only copied directory must not leave a lease behind.
        expect(
          fs.readdirSync(path.join(parent, _testHooks.SCRATCH_CONTAINER_NAME)),
        ).toEqual([]);
      } finally {
        fs.chmodSync(locked, 0o700);
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

  scratchTest(
    "pre-check rejects a blocked tree before creating any container or lease",
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
          "resolves outside the disposable copy",
        );
        // The pre-check runs before the container/lease machinery, so a
        // rejected tree leaves nothing behind next to the source.
        expect(
          fs.existsSync(path.join(parent, ".pi-delegate-scratch")),
        ).toBe(false);
      } finally {
        cleanTestDir(parent);
      }
    },
  );

  scratchTest(
    "surfaces the real cp stderr when the reflink copy fails",
    async () => {
      const parent = testParent();
      const repo = path.join(parent, "repo");
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, "secret.txt"), "secret");
      // Unreadable regular file: invisible to the tree walk (which only
      // classifies dirent types) but fatal to cp, which must open the source.
      fs.chmodSync(path.join(repo, "secret.txt"), 0o000);
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      try {
        const error = await createScratchWorkspace(repo).then(
          () => {
            throw new Error("expected createScratchWorkspace to reject");
          },
          (e: unknown) => e as Error,
        );
        expect(error.message).toContain("reflink-capable filesystem");
        expect(error.message).toMatch(/cp failed: cp: /);
      } finally {
        cleanTestDir(parent);
      }
    },
  );
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _setIsolatedArtifactRootForTesting,
  prepareIsolatedBatch,
} from "./isolated-workspace.ts";
import { emptyUsage } from "./usage.ts";
import type { ResolvedTask, TaskResult } from "./types.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function privateRefs(cwd: string): string[] {
  const output = git(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/pi-delegate/batches",
  ]);
  return output ? output.split("\n") : [];
}

function task(cwd: string, prompt: string): ResolvedTask {
  return {
    id: prompt,
    prompt,
    agentName: "coder",
    model: { provider: "test", id: "model" } as never,
    tools: ["read", "write", "edit", "bash"],
    thinking: "off",
    systemPrompt: "test",
    cwd,
    workspace: "isolated",
    warnings: [],
  };
}

function success(agent = "coder"): TaskResult {
  return {
    agent,
    output: "done",
    durationMs: 1,
    tokens: 0,
    usage: emptyUsage(),
    touchedFiles: [],
    attributedFiles: [],
  };
}

describe("Git-native isolated workspace", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-isolated-"));
    repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(repo, "shared.txt"), "baseline\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "initial"]);
    _setIsolatedArtifactRootForTesting(path.join(root, "artifacts"));
  });

  afterEach(() => {
    _setIsolatedArtifactRootForTesting(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("captures dirty and untracked source state, then applies proposals in task order", async () => {
    fs.writeFileSync(path.join(repo, "shared.txt"), "dirty baseline\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");
    const beforeIndex = git(repo, ["diff", "--cached"]);

    const batch = await prepareIsolatedBatch([
      task(repo, "one"),
      task(repo, "two"),
    ]);
    expect(batch).toBeDefined();
    const [one, two] = batch!.resolved;
    expect(fs.readFileSync(path.join(one!.cwd, "shared.txt"), "utf8")).toBe(
      "dirty baseline\n",
    );
    expect(fs.readFileSync(path.join(two!.cwd, "untracked.txt"), "utf8")).toBe(
      "untracked\n",
    );

    fs.writeFileSync(path.join(one!.cwd, "shared.txt"), "task one\n");
    fs.writeFileSync(path.join(two!.cwd, "other.txt"), "task two\n");
    const results = await batch!.reconcile([success(), success()]);

    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(
      "task one\n",
    );
    expect(fs.readFileSync(path.join(repo, "other.txt"), "utf8")).toBe(
      "task two\n",
    );
    expect(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(git(repo, ["diff", "--cached"])).toBe(beforeIndex);
    expect(results.map((result) => result.integration?.status)).toEqual([
      "applied_unverified",
      "applied_unverified",
    ]);
    expect(privateRefs(repo)).toEqual([]);
  });

  test("keeps a conflicting proposal as a ref, full patch, and worktree", async () => {
    const batch = await prepareIsolatedBatch([
      task(repo, "one"),
      task(repo, "two"),
    ]);
    const [one, two] = batch!.resolved;
    fs.writeFileSync(path.join(one!.cwd, "shared.txt"), "first\n");
    fs.writeFileSync(path.join(two!.cwd, "shared.txt"), "second\n");

    const results = await batch!.reconcile([success(), success()]);
    expect(results[0]!.integration?.status).toBe("applied_unverified");
    expect(results[1]!.integration?.status).toBe("conflict");
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(
      "first\n",
    );
    const conflict = results[1]!.integration!;
    expect(fs.existsSync(conflict.patchPath!)).toBe(true);
    expect(fs.existsSync(conflict.worktreePath!)).toBe(true);
    expect(
      git(repo, ["rev-parse", "--verify", `${conflict.proposalRef}^{commit}`]),
    ).toBeTruthy();
    expect(privateRefs(repo)).toEqual([
      conflict.baselineRef,
      conflict.proposalRef,
    ]);
  });

  test("reconciles additions, deletions, binary data, symlinks, and executable bits", async () => {
    if (process.platform === "win32") return;
    const batch = await prepareIsolatedBatch([task(repo, "one")]);
    const [one] = batch!.resolved;
    fs.rmSync(path.join(one!.cwd, "other.txt"));
    fs.writeFileSync(
      path.join(one!.cwd, "binary.bin"),
      Buffer.from([0, 1, 2, 255]),
    );
    fs.writeFileSync(path.join(one!.cwd, "run.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    fs.symlinkSync("shared.txt", path.join(one!.cwd, "link.txt"));

    const [result] = await batch!.reconcile([success()]);
    expect(result!.integration?.status).toBe("applied_unverified");
    expect(fs.existsSync(path.join(repo, "other.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "binary.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(fs.statSync(path.join(repo, "run.sh")).mode & 0o111).not.toBe(0);
    expect(fs.readlinkSync(path.join(repo, "link.txt"))).toBe("shared.txt");
  });

  test("revalidation refuses to overwrite a source tree changed during execution", async () => {
    const batch = await prepareIsolatedBatch([task(repo, "one")]);
    const [one] = batch!.resolved;
    fs.writeFileSync(path.join(one!.cwd, "shared.txt"), "proposal\n");
    fs.writeFileSync(path.join(repo, "shared.txt"), "external change\n");

    const [result] = await batch!.reconcile([success()]);
    expect(result!.integration?.status).toBe("apply_failed");
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(
      "external change\n",
    );
    expect(privateRefs(repo)).toEqual([
      result!.integration!.baselineRef!,
      result!.integration!.proposalRef!,
    ]);
  });

  test("preserves proposed files when candidate worktree creation fails", async () => {
    const batch = await prepareIsolatedBatch([task(repo, "one")]);
    const [one] = batch!.resolved;
    fs.writeFileSync(path.join(one!.cwd, "shared.txt"), "proposal\n");
    fs.writeFileSync(
      path.join(path.dirname(one!.cwd), "candidate-0"),
      "block worktree creation",
    );

    const [result] = await batch!.reconcile([success()]);

    expect(result!.integration?.status).toBe("apply_failed");
    expect(result!.integration?.proposedFiles).toEqual(["shared.txt"]);
    expect(result!.integration?.proposalRef).toBeString();
    expect(result!.integration?.patchPath).toBeString();
  });

  test("failed workers are discarded without changing the source", async () => {
    const batch = await prepareIsolatedBatch([task(repo, "one")]);
    const [one] = batch!.resolved;
    fs.writeFileSync(path.join(one!.cwd, "shared.txt"), "must not apply\n");
    const failed = { ...success(), error: "worker failed" };

    const [result] = await batch!.reconcile([failed]);
    expect(result!.integration?.status).toBe("discarded");
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(
      "baseline\n",
    );
    expect(privateRefs(repo)).toEqual([]);
  });

  test("removes private refs when a proposal has no changes", async () => {
    const batch = await prepareIsolatedBatch([task(repo, "one")]);

    const [result] = await batch!.reconcile([success()]);

    expect(result!.integration?.status).toBe("no_changes");
    expect(privateRefs(repo)).toEqual([]);
  });

  test("removes an earlier baseline ref when batch preparation fails", async () => {
    const notARepository = path.join(root, "not-a-repository");
    fs.mkdirSync(notARepository);

    await expect(
      prepareIsolatedBatch([task(repo, "one"), task(notARepository, "two")]),
    ).rejects.toThrow();

    expect(privateRefs(repo)).toEqual([]);
    expect(fs.readdirSync(path.join(root, "artifacts"))).toEqual([]);
  });

  test("terminates a background process before snapshotting", async () => {
    if (process.platform !== "linux") return;
    const batch = await prepareIsolatedBatch([task(repo, "one")]);
    const [one] = batch!.resolved;
    fs.writeFileSync(path.join(one!.cwd, "shared.txt"), "proposal\n");
    const child = spawn("sleep", ["30"], {
      cwd: one!.cwd,
      detached: true,
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    try {
      await once(child, "spawn");
      expect(child.pid).toBeNumber();

      const [result] = await batch!.reconcile([success()]);
      await exited;
      expect(result!.integration?.status).toBe("applied_unverified");
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
});

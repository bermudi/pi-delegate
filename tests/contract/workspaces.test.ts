import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

function gitInit(dir: string): void {
  // An initial commit is required: isolated baselines are built on HEAD.
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir },
  );
}

describe("delegate workspace and shared-write contract", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "delegate-v2-ws-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    session?.dispose();
    session = undefined;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "overlapping shared writers in one call serialize in task order",
    async () => {
      // v1 evidence: dispatch.test.ts "serialized successor still runs after a
      // failed predecessor" and ordering chain tests; INVARIANTS: same-call
      // overlapping shared writers serialize in task order.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();

      const timeline: string[] = [];
      const timed = (tag: string, text: string): FauxResponseFactory =>
        async () => {
          timeline.push(`start:${tag}`);
          await new Promise((r) => setTimeout(r, 30));
          timeline.push(`end:${tag}`);
          return fauxAssistantMessage(text);
        };
      subagents.respond([
        timed("first", "W1-DONE"),
        timed("second", "W2-DONE"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "w1", cwd: dir,  tools: ["write"] },
          { prompt: "w2", cwd: dir,  tools: ["write"] },
        ],
      });
      expect(result.isError).toBe(false);

      // Serialized: the second writer's interval starts only after the first
      // ends, and the order follows the task array.
      expect(timeline).toEqual([
        "start:first",
        "end:first",
        "start:second",
        "end:second",
      ]);
      // The result surfaces the serialization and the parallel alternative:
      // silent hour-long serial batches are the failure mode this prevents.
      expect(result.text).toMatch(/serialized/i);
      expect(result.text).toMatch(/isolated/);
    },
  );

  test(
    "a batch-level workspace applies to every task without its own",
    async () => {
      // Top-level workspace is the ergonomic path to parallel same-repo
      // edits: set once, every task runs isolated.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      let active = 0;
      let maxActive = 0;
      // A barrier, not a timing sample: each worker's first provider call
      // blocks until both arrive, so maxActive === 2 proves the calls were
      // actually concurrent rather than merely observed overlapping.
      let releaseBoth!: () => void;
      const both = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      // Responses are a global FIFO across parallel workers, so dispatch on
      // the prompt instead of assuming call order: the first turn writes the
      // file its task named; the turn after a tool result finishes.
      const writeForPrompt: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("DONE");
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 2) releaseBoth();
        // Bounded: a serialization regression fails the assertion below
        // instead of deadlocking the test.
        await Promise.race([both, new Promise((r) => setTimeout(r, 3000))]);
        active -= 1;
        const file = JSON.stringify(context.messages).includes("x.txt")
          ? "x.txt"
          : "y.txt";
        return fauxAssistantMessage([
          fauxToolCall("write", { path: file, content: file }),
        ]);
      };
      subagents.respond([
        writeForPrompt,
        writeForPrompt,
        writeForPrompt,
        writeForPrompt,
      ]);

      const result = await callDelegate(session, {
        workspace: "isolated",
        tasks: [
          {
            prompt: "write x.txt",
            cwd: dir,
            tools: ["write"],
          },
          {
            prompt: "write y.txt",
            cwd: dir,
            tools: ["write"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      // Isolated tasks run in parallel and reconcile into the source.
      expect(maxActive).toBe(2);
      expect(result.text).toMatch(/applied_unverified/);
      expect(readFileSync(join(dir, "x.txt"), "utf8")).toBe("x.txt");
      expect(readFileSync(join(dir, "y.txt"), "utf8")).toBe("y.txt");
    },
  );

  test(
    "a task-level workspace overrides the batch default",
    async () => {
      // Batch default is isolated; the task that names shared keeps it —
      // so the same-repo overlap is a mixed-workspace rejection.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const result = await callDelegate(session, {
        workspace: "isolated",
        tasks: [
          {
            prompt: "shared task",
            cwd: dir,
            tools: ["write"],
            workspace: "shared",
          },
          {
            prompt: "defaulted task",
            cwd: dir,
            tools: ["write"],
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/isolated|shared|overlap|conflict/i);
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a writer overlapping a still-running async ticket rejects the whole call",
    async () => {
      // v1 evidence: dispatch.test.ts "rejects a writer that overlaps a
      // still-running async ticket"; INVARIANTS: overlap with active work
      // rejects, not queues.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();

      let release!: () => void;
      const gatePromise = new Promise<void>((r) => (release = r));
      const hanging: FauxResponseFactory = async () => {
        await gatePromise;
        return fauxAssistantMessage("bg done");
      };
      subagents.respond([hanging]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { prompt: "bg", cwd: dir,  tools: ["write"] },
        ],
        async: true,
      });
      ticketIdOf(dispatched.text); // ticket exists
      const callsBefore = subagents.state.callCount;

      const rejected = await callDelegate(session, {
        tasks: [
          { prompt: "now", cwd: dir,  tools: ["write"] },
        ],
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toMatch(/overlap|running|conflict|active/i);
      // No task started: the rejected call consumed no subagent work.
      expect(subagents.state.callCount).toBe(callsBefore);

      release();
    },
  );

  test(
    "shared and isolated work overlapping in one call rejects before execution",
    async () => {
      // v1 evidence: dispatch.test.ts "mixed isolated and shared same-call
      // overlap still rejects"; INVARIANTS: shared/isolated overlap rejects.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "shared",
            cwd: dir,
            tools: ["write"],
            workspace: "shared",
          },
          {
            prompt: "isolated",
            cwd: dir,
            tools: ["write"],
            workspace: "isolated",
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/isolated|shared|overlap|conflict/i);
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a read-only task cannot use scratch — the copy buys nothing",
    async () => {
      // SPEC: a task whose resolved tools are all read-only is rejected;
      // paying for a copy to contain writes a reader cannot make is the
      // v1 waste this prevents.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      for (const task of [
        {
          prompt: "look around",
          cwd: dir,
          tools: ["read"],
          workspace: "scratch",
        },
        {
          prompt: "look around",
          cwd: dir,
          agent: "scout",
          workspace: "scratch",
        },
      ]) {
        const result = await callDelegate(session, { tasks: [task] });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/scratch/i);
        expect(result.text).toMatch(/read.only/i);
      }
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "scratch rejects a linked worktree before copying, with the remedy",
    async () => {
      // v1 evidence: a scratch retry on a linked worktree paid for a copy
      // before failing. A `.git` file at the root redirects Git into the
      // real repository — the one write that escapes a plain copy — so the
      // rejection is a stat, not a failed copy.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      const linked = join(dir, "linked");
      execSync("git worktree add --detach linked HEAD", { cwd: dir });

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "write a file",
            cwd: linked,
            tools: ["write"],
            workspace: "scratch",
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/worktree|submodule|\.git/i);
      expect(result.text).toMatch(/shared|isolated/);
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "inherited GIT_DIR redirect fails closed for a bash-capable multi-writer batch",
    async () => {
      // INVARIANTS: admission must fail closed when inherited Git redirects
      // could make a bash-capable writer escape the reserved scope.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const previous = process.env.GIT_DIR;
      process.env.GIT_DIR = join(dir, "bogus-git-dir");
      try {
        const result = await callDelegate(session, {
          tasks: [
            {
              prompt: "first",
              cwd: dir,
              tools: ["write", "bash"],
            },
            {
              prompt: "second",
              cwd: dir,
              tools: ["write"],
            },
          ],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/git|redirect|scope|unsafe/i);
      } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
      }
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "inherited GIT_DIR does not shrink reserved scope for non-bash writers",
    async () => {
      // The Git probe must run with GIT_* scrubbed; otherwise a bogus
      // redirect makes scope discovery fail and admission would either fall
      // back to per-task cwds (missing the same-repo overlap) or reject
      // everything.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      const left = join(dir, "left");
      const right = join(dir, "right");
      mkdirSync(left, { recursive: true });
      mkdirSync(right, { recursive: true });

      let active = 0;
      let maxActive = 0;
      const gated: FauxResponseFactory = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        return fauxAssistantMessage("done");
      };
      subagents.respond([gated, gated]);

      const previous = process.env.GIT_DIR;
      process.env.GIT_DIR = join(dir, "bogus-git-dir");
      let result: Awaited<ReturnType<typeof callDelegate>> | undefined;
      try {
        result = await callDelegate(session, {
          tasks: [
            {
              prompt: "write left",
              cwd: left,
              tools: ["write"],
            },
            {
              prompt: "write right",
              cwd: right,
              tools: ["write"],
            },
          ],
        });
      } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
      }

      // Same repository scope → the writers serialize despite disjoint cwds.
      expect(result?.isError).toBe(false);
      expect(maxActive).toBe(1);
      expect(subagents.state.callCount).toBe(2);
    },
  );

  test(
    "scratch changes are discarded and never reach the source tree",
    async () => {
      // v1 evidence: workspace.test.ts "copies the full Git tree, maps a
      // nested cwd, and discards mutations"; SPEC: scratch runs once in a
      // disposable copy and discards its changes.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      mkdirSync(join(dir, "sub"));

      // Responses are a global FIFO across parallel workers: dispatch on
      // the prompt. A relative write must land inside the task's own copy
      // — the second task's nested cwd maps into its copy's sub/.
      const writeThenDone: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("SCRATCH-DONE");
        }
        const file = JSON.stringify(context.messages).includes("nested")
          ? "nested-marker.txt"
          : "scratch-marker.txt";
        return fauxAssistantMessage([
          fauxToolCall("write", { path: file, content: "scratch" }),
        ]);
      };
      subagents.respond([
        writeThenDone,
        writeThenDone,
        writeThenDone,
        writeThenDone,
      ]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "write scratch-marker.txt",
            cwd: dir,
            workspace: "scratch",
            tools: ["write"],
          },
          {
            prompt: "write nested-marker.txt",
            cwd: join(dir, "sub"),
            workspace: "scratch",
            tools: ["write"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("SCRATCH-DONE");
      expect(existsSync(join(dir, "scratch-marker.txt"))).toBe(false);
      expect(existsSync(join(dir, "sub", "nested-marker.txt"))).toBe(false);
      // No litter: the copies are gone and the agent-dir scratch area is
      // pruned — the test session's agentDir is its cwd.
      expect(existsSync(join(session.cwd, "delegate-scratch"))).toBe(false);
    },
  );

  test(
    "a scratch task holds no source reservation — it runs beside a shared writer",
    async () => {
      // SPEC: scratch holds no write reservation on the source tree. A
      // shared writer and a scratch task on one scope proceed together;
      // the shared write lands, the scratch write does not.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();

      const writeForPrompt: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("DONE");
        }
        const file = JSON.stringify(context.messages).includes("shared-file")
          ? "shared-file.txt"
          : "scratch-file.txt";
        return fauxAssistantMessage([
          fauxToolCall("write", { path: file, content: file }),
        ]);
      };
      subagents.respond([
        writeForPrompt,
        writeForPrompt,
        writeForPrompt,
        writeForPrompt,
      ]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "write shared-file.txt",
            cwd: dir,
            tools: ["write"],
          },
          {
            prompt: "write scratch-file.txt",
            cwd: dir,
            tools: ["write"],
            workspace: "scratch",
          },
        ],
      });
      // No overlap rejection, no serialization — and the scratch write
      // never reached the source.
      expect(result.isError).toBe(false);
      expect(readFileSync(join(dir, "shared-file.txt"), "utf8")).toBe(
        "shared-file.txt",
      );
      expect(existsSync(join(dir, "scratch-file.txt"))).toBe(false);
    },
  );

  test(
    "scratch sweeps copies left behind by a dead process",
    async () => {
      // Copies live under <agentDir>/delegate-scratch/pid-<pid>/ so a later
      // call can remove a dead owner's leftovers. The test session's
      // agentDir is its cwd.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();

      const dead = spawnSync("true");
      const stale = join(
        session.cwd,
        "delegate-scratch",
        `pid-${dead.pid}`,
        "batch",
        "worker-0",
      );
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(stale, "junk.txt"), "junk");

      subagents.respond([fauxAssistantMessage("OK")]);
      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "hi",
            cwd: dir,
            tools: ["write"],
            workspace: "scratch",
          },
        ],
      });
      expect(result.isError).toBe(false);
      expect(
        existsSync(join(session.cwd, "delegate-scratch", `pid-${dead.pid}`)),
      ).toBe(false);
    },
  );

  test(
    "isolated proposals reconcile into the source in task order",
    async () => {
      // v1 evidence: isolated-workspace.test.ts "captures dirty and untracked
      // source state, then applies proposals in task order"; SPEC: isolated
      // reconciles successful proposals in task order.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      // Pre-dispatch source state the baseline must carry without touching
      // the user's index: a dirty tracked edit, an untracked file, and a
      // staged-but-uncommitted index entry.
      writeFileSync(join(dir, "tracked.txt"), "committed");
      execSync("git add -A && git commit -qm add-tracked", { cwd: dir });
      writeFileSync(join(dir, "tracked.txt"), "dirty-edit");
      writeFileSync(join(dir, "untracked.txt"), "untracked");
      writeFileSync(join(dir, "staged.txt"), "staged");
      execSync("git add staged.txt", { cwd: dir });

      const fileA = join(dir, "a.txt");
      const fileB = join(dir, "b.txt");
      // Responses are a global FIFO across parallel workers: dispatch on the
      // prompt so either worker can win either step.
      const writeForPrompt: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("DONE");
        }
        const file = JSON.stringify(context.messages).includes("a.txt")
          ? "a.txt"
          : "b.txt";
        return fauxAssistantMessage([
          fauxToolCall("write", { path: file, content: file }),
        ]);
      };
      subagents.respond([
        writeForPrompt,
        writeForPrompt,
        writeForPrompt,
        writeForPrompt,
      ]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "write a.txt",
            cwd: dir,
            workspace: "isolated",
            tools: ["write"],
          },
          {
            prompt: "write b.txt",
            cwd: dir,
            workspace: "isolated",
            tools: ["write"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      // A clean application is applied_unverified, never a correctness claim.
      expect(result.text).toMatch(/applied_unverified/);
      expect(readFileSync(fileA, "utf8")).toBe("a.txt");
      expect(readFileSync(fileB, "utf8")).toBe("b.txt");
      // The dirty edit and untracked file survive reconciliation, and the
      // user's index still holds exactly what they staged — the baseline
      // machinery never touched it.
      expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe(
        "dirty-edit",
      );
      expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe(
        "untracked",
      );
      expect(
        execSync("git diff --cached --name-only", { cwd: dir })
          .toString()
          .trim(),
      ).toBe("staged.txt");
    },
  );

  test(
    "a failed apply preserves unrelated working-tree changes made after the check",
    async () => {
      // Bug 1: restoring a failed apply from an older snapshot erases
      // unrelated edits. The apply path verifies each touched file against
      // its expected pre-apply content before writing: a file the user
      // changed after the check becomes a per-path conflict instead of
      // being overwritten or rolled back to a stale version.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      // victim.txt has enough context lines that appending an unrelated
      // line does not disturb the worker hunk's --check, so the apply
      // reaches verify-before-write rather than the drift check.
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
      writeFileSync(join(dir, "victim.txt"), lines.join("\n") + "\n");
      execSync("git add -A && git commit -qm base", { cwd: dir });

      let workerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        workerStarted = resolve;
      });
      let releaseWorker!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseWorker = resolve;
      });
      const gatedWorkerWrite: FauxResponseFactory = async () => {
        workerStarted();
        await gate;
        return fauxAssistantMessage([
          fauxToolCall("write", {
            path: "victim.txt",
            content: ["WORKER", ...lines.slice(1)].join("\n") + "\n",
          }),
        ]);
      };
      subagents.respond([
        gatedWorkerWrite,
        fauxAssistantMessage("DONE"),
      ]);

      const dispatched = callDelegate(session, {
        tasks: [
          {
            prompt: "change victim.txt first line",
            cwd: dir,
            workspace: "isolated",
            tools: ["write"],
          },
        ],
      });
      await started;
      // Unrelated change after the baseline: appended line far from the
      // worker's hunk, so the forward --check still passes.
      writeFileSync(join(dir, "victim.txt"), lines.join("\n") + "\nEXTRA\n");
      releaseWorker();
      const result = await dispatched;

      // The unrelated edit survives verbatim and the proposal is retained
      // as a conflict — never applied over it, never rolled back.
      expect(readFileSync(join(dir, "victim.txt"), "utf8")).toBe(
        lines.join("\n") + "\nEXTRA\n",
      );
      expect(result.text).toMatch(/conflict/i);
      expect(result.text).toMatch(/victim\.txt/);
    },
  );

  test(
    "an identical second proposal is already present, not a fresh apply",
    async () => {
      // Bug 2: two isolated workers proposing identical changes — the
      // first conflicts (or applies), the second must never report applied
      // success with a non-empty appliedFiles list for changes it did not
      // write. Both workers write the same new line to same.txt; whichever
      // proposal lands second finds its delta already present via the
      // reverse --check (or an empty chain edge) and reports
      // applied_unverified with EMPTY appliedFiles, without a second write.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      const target = join(dir, "same.txt");
      writeFileSync(target, "base\n");
      execSync("git add -A && git commit -qm base", { cwd: dir });

      const identicalWrite: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("DONE");
        }
        return fauxAssistantMessage([
          fauxToolCall("write", {
            path: "same.txt",
            content: "base\nSAME\n",
          }),
        ]);
      };
      subagents.respond([
        identicalWrite,
        identicalWrite,
        identicalWrite,
        identicalWrite,
      ]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "append SAME to same.txt (worker one)",
            cwd: dir,
            workspace: "isolated",
            tools: ["write"],
          },
          {
            prompt: "append SAME to same.txt (worker two)",
            cwd: dir,
            workspace: "isolated",
            tools: ["write"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      // Exactly one copy of the line: no double-apply, no duplicate lines.
      expect(readFileSync(target, "utf8")).toBe("base\nSAME\n");
      // The second proposal never claims a fresh apply: at most one task
      // reports applied files, and the already-present wording names it.
      const appliedSections = result.text.match(/applied 1 file\(s\)/g) ?? [];
      expect(appliedSections.length).toBeLessThanOrEqual(1);
      expect(result.text).toMatch(/already present/i);
    },
  );

  test("failed git apply restores actual pre-apply mode and content without erasing a concurrent edit", async () => {
    // Regression: an injected source apply failure after a partial write must
    // restore actual working-tree bytes/mode, not the synthetic Git parent.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    gitInit(dir);
    writeFileSync(join(dir, "a.txt"), "base\n");
    writeFileSync(join(dir, "b.txt"), "base\n");
    execSync("git add -A && git commit -qm base", { cwd: dir });
    chmodSync(join(dir, "a.txt"), 0o600);
    const shimDir = tempDir();
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    // Only the source write is faulted; preparation, merge, checks and
    // recovery still use the real Git executable.
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
if [ "$PWD" = '${dir}' ] && [ "$1" = apply ] && [ "$2" = --binary ]; then
  printf 'worker\n' > a.txt
  printf 'human-mid-apply\n' > b.txt
  exit 1
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${shimDir}:${previousPath}`;
      const write: FauxResponseFactory = async (context) =>
        context.messages.some((m) => m.role === "toolResult")
          ? fauxAssistantMessage("DONE")
          : fauxAssistantMessage([
              fauxToolCall("write", { path: "a.txt", content: "worker\n" }),
              fauxToolCall("write", { path: "b.txt", content: "worker\n" }),
            ]);
      subagents.respond([write, write, write]);
      const result = await callDelegate(session, { tasks: [{ prompt: "edit both", cwd: dir, workspace: "isolated", tools: ["write"] }] });
      expect(result.text).toMatch(/apply_failed/);
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("base\n");
      expect(statSync(join(dir, "a.txt")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("human-mid-apply\n");
      expect(result.text).toMatch(/b\.txt/);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("a partial source apply that deleted a file restores it on failure", async () => {
    // A completed deletion is absent, not a modified blob. A later failing
    // path in the same patch must not leave that deletion in the source.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    gitInit(dir);
    writeFileSync(join(dir, "a.txt"), "original\n");
    writeFileSync(join(dir, "b.txt"), "original\n");
    execSync("git add -A && git commit -qm base", { cwd: dir });
    const shimDir = tempDir();
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
if [ "$PWD" = '${dir}' ] && [ "$1" = apply ] && [ "$2" = --binary ]; then
  rm a.txt
  exit 1
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${shimDir}:${previousPath}`;
      const write: FauxResponseFactory = async (context) =>
        context.messages.some((m) => m.role === "toolResult")
          ? fauxAssistantMessage("DONE")
          : fauxAssistantMessage([
              fauxToolCall("bash", { command: "rm a.txt" }),
              fauxToolCall("write", { path: "b.txt", content: "worker\n" }),
            ]);
      subagents.respond([write, write]);
      const result = await callDelegate(session, {
        tasks: [{ prompt: "delete and edit", cwd: dir, workspace: "isolated", tools: ["bash", "write"] }],
      });
      expect(result.text).toMatch(/apply_failed/);
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("original\n");
      expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("original\n");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("an empty duplicate edge cannot unblock a dependent when the source lacks its effects", async () => {
    // Regression of v1 isolated-workspace identical proposal scenario:
    // even an empty chain edge needs verification against the live source.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    gitInit(dir);
    writeFileSync(join(dir, "same.txt"), "base\n");
    execSync("git add -A && git commit -qm base", { cwd: dir });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let dependentRan = false;
    const write: FauxResponseFactory = async (context) => {
      if (context.messages.some((m) => m.role === "toolResult")) return fauxAssistantMessage("DONE");
      if (JSON.stringify(context.messages).includes("dependent marker")) {
        dependentRan = true;
        return fauxAssistantMessage("dependent ran");
      }
      started();
      await gate;
      return fauxAssistantMessage([fauxToolCall("write", { path: "same.txt", content: "worker\n" })]);
    };
    subagents.respond(Array(6).fill(write));
    const otherDir = tempDir();
    const dispatched = callDelegate(session, { tasks: [
      { id: "first", prompt: "edit same", cwd: dir, workspace: "isolated", tools: ["write"] },
      { id: "second", prompt: "edit same again", cwd: dir, workspace: "isolated", tools: ["write"] },
      { id: "after", prompt: "dependent marker", cwd: otherDir, dependsOn: ["second"], tools: ["write"] },
    ] });
    await ready;
    writeFileSync(join(dir, "same.txt"), "human\n");
    release();
    const result = await dispatched;
    expect(result.text).toMatch(/conflict/);
    expect(result.text).toMatch(/blocked/);
    expect(dependentRan).toBe(false);
    expect(readFileSync(join(dir, "same.txt"), "utf8")).toBe("human\n");
  });

  test("a partially duplicate proposal cannot claim a reverse-check success", async () => {
    // Regression: the second worker repeats a conflicting A edit and adds B.
    // B is already present in source, but A never applied; reverse --check on
    // the nonempty chain edge B alone cannot establish full success.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    gitInit(dir);
    writeFileSync(join(dir, "a.txt"), "base\n");
    writeFileSync(join(dir, "b.txt"), "base\n");
    execSync("git add -A && git commit -qm base", { cwd: dir });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const respond: FauxResponseFactory = async (context) => {
      if (context.messages.some((m) => m.role === "toolResult")) return fauxAssistantMessage("DONE");
      started();
      await gate;
      const second = JSON.stringify(context.messages).includes("second proposal");
      return fauxAssistantMessage([
        fauxToolCall("write", { path: "a.txt", content: "worker\n" }),
        ...(second ? [fauxToolCall("write", { path: "b.txt", content: "worker-b\n" })] : []),
      ]);
    };
    subagents.respond(Array(6).fill(respond));
    const dispatched = callDelegate(session, { tasks: [
      { prompt: "first proposal", cwd: dir, workspace: "isolated", tools: ["write"] },
      { prompt: "second proposal", cwd: dir, workspace: "isolated", tools: ["write"] },
    ] });
    await ready;
    writeFileSync(join(dir, "a.txt"), "human\n");
    writeFileSync(join(dir, "b.txt"), "worker-b\n");
    release();
    const result = await dispatched;
    expect(result.text).toMatch(/conflict/);
    expect(result.text).not.toMatch(/applied_unverified/);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("human\n");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("worker-b\n");
  });

  test("symlink source comparisons hash link text rather than its target", async () => {
    // Regression: Git's symlink blob is the link text, not the file it names.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    gitInit(dir);
    writeFileSync(join(dir, "target.txt"), "target bytes\n");
    symlinkSync("target.txt", join(dir, "link.txt"));
    execSync("git add -A && git commit -qm links", { cwd: dir });
    const write: FauxResponseFactory = async (context) =>
      context.messages.some((m) => m.role === "toolResult")
        ? fauxAssistantMessage("DONE")
        : fauxAssistantMessage([fauxToolCall("bash", { command: "ln -sfn next.txt link.txt" })]);
    subagents.respond([write, write]);
    const result = await callDelegate(session, { tasks: [{ prompt: "update symlink", cwd: dir, workspace: "isolated", tools: ["bash"] }] });
    expect(result.text).toMatch(/applied_unverified/);
    expect(readlinkSync(join(dir, "link.txt"))).toBe("next.txt");
  });

  test("a file can be replaced by a directory in an isolated proposal", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    gitInit(dir);
    writeFileSync(join(dir, "a"), "old file\n");
    execSync("git add -A && git commit -qm base", { cwd: dir });
    const step: FauxResponseFactory = async (context) =>
      context.messages.some((m) => m.role === "toolResult")
        ? fauxAssistantMessage("DONE")
        : fauxAssistantMessage([
            fauxToolCall("bash", { command: "rm a && mkdir a && printf 'new file\\n' > a/new" }),
          ]);
    subagents.respond([step, step]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "replace file with directory", cwd: dir, workspace: "isolated", tools: ["bash"] }],
    });
    expect(result.text).toContain("applied_unverified");
    expect(readFileSync(join(dir, "a/new"), "utf8")).toBe("new file\n");
  });

  test("a directory can be replaced by a file in an isolated proposal", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    gitInit(dir);
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a/old"), "old file\n");
    execSync("git add -A && git commit -qm base", { cwd: dir });
    const step: FauxResponseFactory = async (context) =>
      context.messages.some((m) => m.role === "toolResult")
        ? fauxAssistantMessage("DONE")
        : fauxAssistantMessage([
            fauxToolCall("bash", { command: "rm -r a && printf 'new file\\n' > a" }),
          ]);
    subagents.respond([step, step]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "replace directory with file", cwd: dir, workspace: "isolated", tools: ["bash"] }],
    });
    expect(result.text).toContain("applied_unverified");
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("new file\n");
  });

  test("a failed file-to-directory apply restores the original file", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    gitInit(dir);
    writeFileSync(join(dir, "a"), "original\n");
    execSync("git add -A && git commit -qm base", { cwd: dir });
    const shimDir = tempDir();
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
if [ "$PWD" = '${dir}' ] && [ "$1" = apply ] && [ "$2" = --binary ]; then
  rm a
  mkdir a
  printf 'new file\\n' > a/new
  exit 1
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${shimDir}:${previousPath}`;
      const step: FauxResponseFactory = async (context) =>
        context.messages.some((m) => m.role === "toolResult")
          ? fauxAssistantMessage("DONE")
          : fauxAssistantMessage([
              fauxToolCall("bash", { command: "rm a && mkdir a && printf 'new file\\n' > a/new" }),
            ]);
      subagents.respond([step, step]);
      const result = await callDelegate(session, {
        tasks: [{ prompt: "replace file with directory", cwd: dir, workspace: "isolated", tools: ["bash"] }],
      });
      expect(result.text).toContain("apply_failed");
      expect(readFileSync(join(dir, "a"), "utf8")).toBe("original\n");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("symlink proposals work in a SHA-256 Git repository", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    execSync("git init -q --object-format=sha256 && git config user.email t@t && git config user.name t", { cwd: dir });
    writeFileSync(join(dir, "old.txt"), "old\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    symlinkSync("old.txt", join(dir, "link"));
    execSync("git add -A && git commit -qm base", { cwd: dir });
    const step: FauxResponseFactory = async (context) =>
      context.messages.some((m) => m.role === "toolResult")
        ? fauxAssistantMessage("DONE")
        : fauxAssistantMessage([fauxToolCall("bash", { command: "ln -sfn new.txt link" })]);
    subagents.respond([step, step]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "retarget link", cwd: dir, workspace: "isolated", tools: ["bash"] }],
    });
    expect(result.text).toContain("applied_unverified");
    expect(readlinkSync(join(dir, "link"))).toBe("new.txt");
  });

  test(
    "a conflicting isolated proposal is retained, not silently applied or lost",
    async () => {
      // v1 evidence: isolated-workspace.test.ts "keeps a conflicting proposal
      // as a ref, full patch, and worktree"; INVARIANTS: conflicts retain
      // discoverable, recoverable artifacts; each proposal is all-or-nothing.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      const target = join(dir, "conflict.txt");
      writeFileSync(target, "original");
      execSync("git add -A && git commit -qm init", { cwd: dir });

      // The first provider call is gated: once it is streaming, preparation
      // has finished and the baseline is captured, so the human edit below
      // is a genuine mid-flight drift. Whichever worker calls first gets the
      // gated response — the file outcomes are identical either way.
      let workerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        workerStarted = resolve;
      });
      let releaseWorker!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseWorker = resolve;
      });
      const gatedConflictWrite: FauxResponseFactory = async () => {
        workerStarted();
        await gate;
        return fauxAssistantMessage([
          fauxToolCall("write", {
            path: "conflict.txt",
            content: "worker-change",
          }),
        ]);
      };
      subagents.respond([
        gatedConflictWrite,
        fauxAssistantMessage([
          fauxToolCall("write", { path: "ok.txt", content: "ok" }),
        ]),
        fauxAssistantMessage("DONE"),
        fauxAssistantMessage("DONE"),
      ]);

      const dispatched = callDelegate(session, {
        tasks: [
          {
            prompt: "change conflict.txt",
            cwd: dir,
            workspace: "isolated",
            tools: ["write"],
          },
          {
            prompt: "write ok.txt",
            cwd: dir,
            workspace: "isolated",
            tools: ["write"],
          },
        ],
      });
      await started;
      // The human edits the same file mid-flight — the baseline moved.
      writeFileSync(target, "human-change");
      releaseWorker();
      const result = await dispatched;

      // The independent proposal still applied; the conflicting one did not
      // clobber the human edit, and the result explains what was retained.
      expect(readFileSync(target, "utf8")).toBe("human-change");
      expect(result.text).toMatch(/conflict|retained|recover/i);
      expect(readFileSync(join(dir, "ok.txt"), "utf8")).toBe("ok");
    },
  );

  test(
    "isolated baselines never contain delegate-owned workspace trees",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      gitInit(session.cwd);
      const agentDir = join(tempDir(), "agent-link");
      symlinkSync(session.cwd, agentDir, "dir");
      mkdirSync(join(agentDir, "delegate-sessions"), { recursive: true });
      writeFileSync(
        join(agentDir, "delegate-sessions", "private.txt"),
        "private",
      );
      const scratchSource = tempDir();

      const forPrompt: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("DONE");
        }
        if (
          JSON.stringify(context.messages).includes("probe owned roots")
        ) {
          return fauxAssistantMessage([
            fauxToolCall("bash", {
              command:
                "if [ ! -e delegate-scratch ] && [ ! -e delegate-sessions ]; then printf absent > owned-check.txt; else printf present > owned-check.txt; fi",
            }),
          ]);
        }
        return fauxAssistantMessage("SCRATCH-DONE");
      };
      subagents.respond([forPrompt, forPrompt, forPrompt, forPrompt]);

      const previous = process.env.DELEGATE_AGENT_DIR;
      process.env.DELEGATE_AGENT_DIR = agentDir;
      let result: Awaited<ReturnType<typeof callDelegate>> | undefined;
      try {
        result = await callDelegate(session, {
          tasks: [
            {
              prompt: "scratch work",
              cwd: scratchSource,
              tools: ["write"],
              workspace: "scratch",
            },
            {
              prompt: "probe owned roots",
              cwd: session.cwd,
              tools: ["bash"],
              workspace: "isolated",
            },
          ],
        });
      } finally {
        if (previous === undefined) delete process.env.DELEGATE_AGENT_DIR;
        else process.env.DELEGATE_AGENT_DIR = previous;
      }
      expect(result?.isError).toBe(false);
      expect(
        readFileSync(join(session.cwd, "owned-check.txt"), "utf8"),
      ).toBe("absent");
    },
  );
});

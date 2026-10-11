import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";
import { diagnosticRecords } from "../support/diagnostic-records.ts";
import { gitEnv } from "../../src/fsx.ts";

// Workspace process cleanup's /proc scan is Linux-only; the stray-process
// tests are gated on it. The retained-artifact recovery test is plain git
// and runs everywhere.
const linuxTest = process.platform === "linux" ? test : test.skip;

function gitInit(dir: string): void {
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir, env: gitEnv() },
  );
}

/**
 * The state letter from /proc/<pid>/stat; undefined when the pid is gone.
 * 'Z' (zombie) counts as dead: the process is terminated, only unreaped.
 */
function processAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(
      stat.lastIndexOf(")") + 2,
      stat.lastIndexOf(")") + 3,
    );
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/** True while /proc reports the pid ignoring SIGTERM (SigIgn bit 15). */
function sigtermIgnored(pid: number): boolean {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const mask = /SigIgn:\s*([0-9a-fA-F]+)/.exec(status)?.[1];
    if (mask === undefined) return false;
    return (BigInt(`0x${mask}`) & (1n << 14n)) !== 0n;
  } catch {
    return false;
  }
}

async function until(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  budgetMs = 5000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${description}`);
    await Bun.sleep(10);
  }
}

interface TaskIntegrationView {
  status?: string;
  reason?: string;
  worktreePath?: string;
  patchPath?: string;
  proposalRef?: string;
  baselineRef?: string;
}

function integrationOf(
  details: unknown,
  index = 0,
): TaskIntegrationView | undefined {
  const results = (details as { results?: ({ integration?: TaskIntegrationView } | null)[] })
    .results;
  return results?.[index]?.integration;
}

describe("delegate workspace process cleanup contract", () => {
  // D4 boundary hardening — no v1 evidence; these pin workspace cleanup
  // semantics through the registered tools only: a stray leftover is
  // terminated without deciding the outcome, a retained/discarded
  // integration's pointers are honest and recoverable.
  let session: TestSession | undefined;
  const dirs: string[] = [];
  const strays: number[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "delegate-v2-wsclean-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    session?.dispose();
    session = undefined;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A worker whose first turn runs `command` through its real bash tool
   * (which leaves a background process and echoes a STRAY:<pid> marker)
   * and whose second turn is gated behind `release`: `onStray` fires once
   * the second turn has captured the stray's pid from the tool result, so
   * the test can inspect the live stray while the worker is still mid-run.
   */
  function strayWorker(options: {
    command: string;
    onStray: (pid: number) => void;
    release: Promise<void>;
    finalMessage: string;
  }): FauxResponseFactory {
    return async (context) => {
      const results = context.messages.filter((m) => m.role === "toolResult");
      if (results.length === 0) {
        return fauxAssistantMessage([
          fauxToolCall("bash", { command: options.command }),
        ]);
      }
      const pid = Number(
        /STRAY:(\d+)/.exec(JSON.stringify(results))?.[1] ?? 0,
      );
      expect(pid).toBeGreaterThan(0);
      options.onStray(pid);
      await options.release;
      return fauxAssistantMessage(options.finalMessage);
    };
  }

  function terminatingRecord(
    calls: readonly (readonly unknown[])[],
    tree: string,
  ): boolean {
    return diagnosticRecords(calls).some(
      (record) =>
        record.event === "workspace process cleanup" &&
        typeof record.context.operation === "string" &&
        /terminating \d+ process\(es\) left in delegated workspace/.test(
          record.context.operation,
        ) &&
        record.context.operation.includes(tree),
    );
  }

  linuxTest(
    "a leftover background process in an isolated worktree is terminated while its proposal still applies",
    async () => {
      // A worker's bash tool can leave a detached child cwd'd inside its
      // worktree; reconcile must kill it through the real /proc scan
      // (SIGTERM suffices for a plain sleep) and still decide integration
      // on the proposal's own merits — the stray's presence is not an
      // outcome.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      let strayPid = 0;
      let straySeen!: () => void;
      const strayReady = new Promise<void>((r) => (straySeen = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const worker = strayWorker({
        command:
          "printf 'work\\n' > stray-file.txt; nohup sleep 600 >/dev/null 2>&1 & echo STRAY:$!",
        onStray: (pid) => {
          strayPid = pid;
          strays.push(pid);
          straySeen();
        },
        release: gate,
        finalMessage: "STRAY-DONE",
      });
      subagents.respond([worker, worker]);

      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        const dispatched = callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "write a file and linger", cwd: dir, workspace: "isolated" },
          ],
        });
        await strayReady;
        try {
          // The stray is genuinely alive and rooted inside the delegated
          // worktree while the worker is still mid-run — its later death is
          // delegate's cleanup, not natural exit.
          expect(processAlive(strayPid)).toBe(true);
          expect(realpathSync(`/proc/${strayPid}/cwd`)).toContain(
            "delegate-isolated",
          );
        } finally {
          release();
        }
        const result = await dispatched;

        expect(result.isError).toBe(false);
        expect(result.text).toContain("STRAY-DONE");
        // Integration decided on the proposal's own merits.
        expect(result.text).toMatch(/INTEGRATION: applied_unverified/);
        expect(readFileSync(join(dir, "stray-file.txt"), "utf8")).toBe("work\n");

        await until("stray terminated by workspace cleanup", () =>
          !processAlive(strayPid),
        );
        expect(terminatingRecord(errors.mock.calls, "delegate-isolated")).toBe(true);
      } finally {
        errors.mockRestore();
      }
    },
    15_000,
  );

  linuxTest(
    "a leftover background process in a scratch copy is terminated while the copy is still discarded",
    async () => {
      // Same cleanup seam on the disposable-copy path: scratch discards
      // the copy after stopping leftovers; the stray is dead and nothing
      // reaches the source.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      let strayPid = 0;
      let straySeen!: () => void;
      const strayReady = new Promise<void>((r) => (straySeen = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const worker = strayWorker({
        command: "nohup sleep 600 >/dev/null 2>&1 & echo STRAY:$!",
        onStray: (pid) => {
          strayPid = pid;
          strays.push(pid);
          straySeen();
        },
        release: gate,
        finalMessage: "SCRATCH-DONE",
      });
      subagents.respond([worker, worker]);

      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        const dispatched = callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "linger in the copy", cwd: dir, workspace: "scratch" },
          ],
        });
        await strayReady;
        try {
          expect(processAlive(strayPid)).toBe(true);
          expect(realpathSync(`/proc/${strayPid}/cwd`)).toContain(
            "delegate-scratch",
          );
        } finally {
          release();
        }
        const result = await dispatched;

        expect(result.isError).toBe(false);
        expect(result.text).toContain("SCRATCH-DONE");
        await until("stray terminated by workspace cleanup", () =>
          !processAlive(strayPid),
        );
        expect(terminatingRecord(errors.mock.calls, "delegate-scratch")).toBe(true);
        // The copy itself is gone, as for any settled scratch task.
        expect(existsSync(join(session.cwd, "delegate-scratch"))).toBe(false);
      } finally {
        errors.mockRestore();
      }
    },
    15_000,
  );

  linuxTest(
    "a SIGTERM-ignoring leftover survives the grace window only until SIGKILL, and reconciliation still proceeds",
    async () => {
      // `trap '' TERM` leaves the stray with an inherited SIG_IGN
      // disposition — SIGTERM cannot kill it, so cleanup pays the grace
      // window and finishes with SIGKILL. Verified honestly: the stray is
      // observed SIGTERM-immune while live, dead after settle.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      let strayPid = 0;
      let straySeen!: () => void;
      const strayReady = new Promise<void>((r) => (straySeen = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const worker = strayWorker({
        command:
          "printf 'work\\n' > stray-file.txt; bash -c 'trap \"\" TERM; exec sleep 600' >/dev/null 2>&1 & echo STRAY:$!",
        onStray: (pid) => {
          strayPid = pid;
          strays.push(pid);
          straySeen();
        },
        release: gate,
        finalMessage: "TRAP-DONE",
      });
      subagents.respond([worker, worker]);

      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        const dispatched = callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "write a file and linger", cwd: dir, workspace: "isolated" },
          ],
        });
        await strayReady;
        try {
          // The inducement really worked: the stray cannot be killed by
          // SIGTERM, so its later death required the post-grace SIGKILL.
          // `trap` runs a moment after the marker echoes — poll for the
          // disposition rather than sampling once.
          expect(processAlive(strayPid)).toBe(true);
          await until("stray SIGTERM disposition installed", () =>
            sigtermIgnored(strayPid),
          );
        } finally {
          release();
        }
        const result = await dispatched;

        expect(result.isError).toBe(false);
        expect(result.text).toContain("TRAP-DONE");
        expect(result.text).toMatch(/INTEGRATION: applied_unverified/);
        expect(readFileSync(join(dir, "stray-file.txt"), "utf8")).toBe("work\n");
        await until("SIGTERM-immune stray killed", () =>
          !processAlive(strayPid),
        );
        expect(terminatingRecord(errors.mock.calls, "delegate-isolated")).toBe(true);
      } finally {
        errors.mockRestore();
      }
    },
    15_000,
  );

  linuxTest(
    "a quarantined worker's recovery worktree stays honest until deferred cleanup stops its leftover processes",
    async () => {
      // Two cleanup semantics pinned together: (1) a discarded-retained
      // integration's worktreePath is honest while quiescence is
      // unconfirmed — it names a real directory on disk; (2) the deferred
      // cleanup tail stops the abandoned worker's strays before removing
      // the worktree, so no process is left writing into an unlinked tree.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      let strayPid = 0;
      let straySeen!: () => void;
      const strayReady = new Promise<void>((r) => (straySeen = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const worker = strayWorker({
        command:
          "printf 'must never land\\n' > ghost.txt; nohup sleep 600 >/dev/null 2>&1 & echo STRAY:$!",
        onStray: (pid) => {
          strayPid = pid;
          strays.push(pid);
          straySeen();
        },
        release: gate,
        finalMessage: "LATE-OUTPUT",
      });
      subagents.respond([worker, worker, worker]);

      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        const dispatched = await callDelegate(session, {
          async: true,
          tasks: [
            {
              id: "ghost",
              prompt: "write then go silent",
              cwd: dir,
              workspace: "isolated",
            },
          ],
        });
        const ticket = ticketIdOf(dispatched.text);
        await strayReady;
        // The discarded-retained integration annotates during wind-down;
        // poll until it lands while the worker is still gated — the
        // worktreePath pointer must name a real retained directory. The
        // single finally releases the gate on every exit: quiescence
        // confirms only after the gated turn settles, and a failure here
        // must not leave the worker's stream parked past afterEach.
        let worktreePath: string | undefined;
        try {
          expect(processAlive(strayPid)).toBe(true);
          expect(realpathSync(`/proc/${strayPid}/cwd`)).toContain(
            "delegate-isolated",
          );

          await callDelegateTicket(session, {
            action: "cancel",
            ticket,
            force: true,
          });

          const annotate = Date.now() + 5000;
          for (;;) {
            const view = await callDelegateTicket(session, {
              action: "poll",
              ticket,
            });
            const integration = integrationOf(view.details);
            if (
              integration?.status === "discarded" &&
              integration.worktreePath !== undefined
            ) {
              worktreePath = integration.worktreePath;
              expect(view.text).toMatch(/INTEGRATION: discarded/);
              expect(view.text).toContain(
                `recovery worktree: ${worktreePath}`,
              );
              break;
            }
            if (Date.now() > annotate) {
              throw new Error(`discarded integration never appeared: ${view.text}`);
            }
            await Bun.sleep(10);
          }
          expect(existsSync(worktreePath!)).toBe(true);
        } finally {
          release();
        }
        const settled = await callDelegateTicket(session, {
          action: "wait",
          ticket,
        });
        expect(settled.text).toContain(`Ticket "${ticket}": cancelled`);
        await until(
          "deferred cleanup removed the worktree",
          () => !existsSync(worktreePath!),
        );
        // Stop precedes removal in the deferred tail: once the tree is
        // gone its stray must already be dead — a stray outliving its
        // worktree would still be writing into an unlinked directory.
        expect(processAlive(strayPid)).toBe(false);
        expect(terminatingRecord(errors.mock.calls, worktreePath!)).toBe(true);
        // The abandoned worker's edit never reached the source.
        expect(existsSync(join(dir, "ghost.txt"))).toBe(false);
        expect(
          execSync("git status --porcelain", {
            cwd: dir,
            encoding: "utf8",
            env: gitEnv(),
          }),
        ).toBe("");
      } finally {
        errors.mockRestore();
      }
    },
    15_000,
  );

  test(
    "a conflicting proposal's recovery pointers are durable: the patch parses and recovers the proposal at its baseline",
    async () => {
      // Retained-artifact honesty: a conflicted integration's pointers are
      // not decorative. The patch file exists and parses, the refs resolve
      // in the source repository, and applying the patch onto the recorded
      // baseline reproduces the worker's proposal — while the source's
      // conflicting edit is untouched.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      const target = join(dir, "conflict.txt");
      writeFileSync(target, "original\n");
      execSync("git add -A && git commit -qm init", { cwd: dir, env: gitEnv() });

      // First provider call gated: once it is streaming, preparation has
      // finished and the baseline is captured — the edit below is genuine
      // mid-flight drift.
      let workerStarted!: () => void;
      const started = new Promise<void>((r) => (workerStarted = r));
      let releaseWorker!: () => void;
      const gate = new Promise<void>((r) => (releaseWorker = r));
      const gatedConflictWrite: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("DONE");
        }
        workerStarted();
        await gate;
        return fauxAssistantMessage([
          fauxToolCall("write", {
            path: "conflict.txt",
            content: "worker-change\n",
          }),
        ]);
      };
      subagents.respond([gatedConflictWrite, gatedConflictWrite]);

      const dispatched = callDelegate(session, {
        async: false,
        tasks: [
          {
            prompt: "change conflict.txt",
            cwd: dir,
            workspace: "isolated",
          },
        ],
      });
      await started;
      writeFileSync(target, "human-change\n");
      releaseWorker();
      const result = await dispatched;

      expect(result.isError).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("human-change\n");
      const integration = integrationOf(result.details);
      expect(integration?.status).toBe("conflict");
      // A worktree pointer, when present, must name something real.
      if (integration?.worktreePath !== undefined) {
        expect(existsSync(integration.worktreePath)).toBe(true);
      }
      // The durable pointers: refs resolve in the source repo and the
      // patch file exists and parses.
      expect(integration?.baselineRef).toBeDefined();
      expect(integration?.proposalRef).toBeDefined();
      expect(integration?.patchPath).toBeDefined();
      expect(existsSync(integration!.patchPath!)).toBe(true);
      execSync(`git rev-parse --verify "${integration!.baselineRef}"`, {
        cwd: dir,
        env: gitEnv(),
      });
      execSync(`git rev-parse --verify "${integration!.proposalRef}"`, {
        cwd: dir,
        env: gitEnv(),
      });
      execSync(`git apply --stat "${integration!.patchPath}"`, {
        cwd: dir,
        env: gitEnv(),
      });
      // Full recovery proof: a detached worktree at the recorded baseline
      // accepts the retained patch and yields exactly the proposal.
      const recovery = join(tempDir(), "recover");
      try {
        execSync(
          `git worktree add --detach "${recovery}" "${integration!.baselineRef}"`,
          { cwd: dir, env: gitEnv() },
        );
        execSync(`git apply --check "${integration!.patchPath}"`, {
          cwd: recovery,
          env: gitEnv(),
        });
        execSync(`git apply "${integration!.patchPath}"`, {
          cwd: recovery,
          env: gitEnv(),
        });
        expect(readFileSync(join(recovery, "conflict.txt"), "utf8")).toBe(
          "worker-change\n",
        );
      } finally {
        if (existsSync(recovery)) {
          execSync(`git worktree remove --force "${recovery}"`, {
            cwd: dir,
            env: gitEnv(),
          });
        }
      }
    },
    15_000,
  );
});

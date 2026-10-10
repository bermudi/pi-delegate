import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  callDelegate, callDelegateTicket, configureDelegate, delegateTool,
  installSubagentModel, openDelegateBoundary, ticketIdOf,
} from "../support/pi-boundary.ts";

// Literal repository #50: public copying/read-vs-write regression scenarios.
// Registered-execute engine boundary: concurrent calls on one extension
// instance bypass Pi host preparation/schema validation, tool-call handlers,
// and execution events. Delegate's execute-level validation/admission still run.
// callDelegate/callDelegateTicket scenarios below use the full session.run path.
// No production admission/workspace internals are imported.
interface Result {
  content: readonly { text?: string }[];
  isError?: boolean;
}
interface Tool {
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal,
    update: (value: unknown) => void, ctx: unknown): Promise<Result>;
}
function dispatchFrom(session: TestSession) {
  const tool = delegateTool(session) as unknown as Tool;
  const ctx = (session.session as AgentSession).extensionRunner.createContext();
  let id = 0;
  return (params: Record<string, unknown>, signal = new AbortController().signal) =>
    tool.execute(`scratch-copy-${++id}`, params, signal, () => {}, ctx)
      // Mirror thrown-error presentation only, not host preparation/validation,
      // when invoking registered tools concurrently without a parent turn.
      .catch((error: unknown) => ({ isError: true, content: [{ text: error instanceof Error ? error.message : String(error) }] }));
}
function textOf(result: Result) {
  return result.content.map((block) => block.text ?? "").join("\n");
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("copy admission test barrier timed out")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
function gitFixtureEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
}
function gitInit(root: string) {
  execSync("git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty", { cwd: root, env: gitFixtureEnv() });
}

/** Pause the REAL fs.cp inside its asynchronous filter. Node's copy promise
 * remains unsettled, including after caller cancellation. No fake copy shape. */
function holdCopy(source: string, failure = false) {
  const entered = gate();
  const resume = gate();
  const original = fs.promises.cp;
  const spy = spyOn(fs.promises, "cp").mockImplementation(async (src, dst, options) => {
    if (String(src) !== source) return original(src, dst, options);
    return original(src, dst, {
      ...options,
      filter: async (candidate, destination) => {
        if (candidate === source) {
          entered.release();
          await resume.promise;
          if (failure) throw new Error("injected actual cp filter failure");
        }
        return options?.filter ? await options.filter(candidate, destination) : true;
      },
    });
  });
  return { entered: entered.promise, release: resume.release, restore: () => spy.mockRestore() };
}

describe("scratch source copying admission (#50)", () => {
  let session: TestSession | undefined;
  const roots: string[] = [];
  function tempDir() {
    const root = fs.mkdtempSync(join(tmpdir(), "delegate-copy-admission-"));
    roots.push(root);
    return root;
  }
  afterEach(() => {
    session?.dispose();
    session = undefined;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  for (const workspace of ["shared", "isolated"] as const) {
    test(`an active ${workspace} writer rejects scratch copying of the canonical Git top-level`, async () => {
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      const root = tempDir();
      gitInit(root);
      // The writer has its own nested repository, disjoint from scratch's
      // cwd. Only reserving the OUTER top-level actually being copied catches it.
      const writerRoot = join(root, "writer-repo");
      fs.mkdirSync(writerRoot); gitInit(writerRoot);
      fs.mkdirSync(join(root, "nested"));
      const aliases = tempDir();
      fs.symlinkSync(join(root, "nested"), join(aliases, "cwd"));
      const started = gate(), worker = gate();
      model.respond([async () => {
        started.release();
        await worker.promise;
        return fauxAssistantMessage("writer done");
      }, fauxAssistantMessage("copy after writer")]);
      const dispatch = dispatchFrom(session);
      const holder = await dispatch({ async: true, tasks: [{ id: "holder", prompt: "writer", cwd: writerRoot, workspace, tools: ["write"] }] });
      const ticket = ticketIdOf(textOf(holder));
      try {
        await bounded(started.promise);
        const rejected = await dispatch({ async: false, tasks: [{ prompt: "copy", cwd: join(aliases, "cwd"), workspace: "scratch", tools: ["write"] }] });
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain(root);
        expect(textOf(rejected)).toMatch(/copy.*source|cannot copy source/i);
        expect(textOf(rejected)).toContain("holder");
        expect(textOf(rejected)).toMatch(/quiescence.*retry/i);
        expect(model.state.callCount).toBe(1);
      } finally { worker.release(); }
      await callDelegateTicket(session, { action: "wait", ticket });
      const admitted = await dispatch({ async: false, tasks: [{ prompt: "copy", cwd: join(aliases, "cwd"), workspace: "scratch", tools: ["write"] }] });
      expect(admitted.isError).not.toBe(true);
      expect(textOf(admitted)).toContain("copy after writer");
    });
  }

  test("copy readers coexist, block ancestor/descendant writers, and release before scratch workers execute", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    const outer = tempDir(), source = join(outer, "source");
    fs.mkdirSync(join(source, "child"), { recursive: true });
    fs.writeFileSync(join(source, "data.txt"), "real copied bytes");
    const alias = join(tempDir(), "alias");
    fs.symlinkSync(source, alias);
    const copies = gate(), resume = gate(), workers = gate(), finishWorkers = gate();
    const original = fs.promises.cp;
    let copying = 0, running = 0;
    const copySpy = spyOn(fs.promises, "cp").mockImplementation(async (src, dst, options) => original(src, dst, {
      ...options,
      filter: async (candidate, destination) => {
        if (candidate === source) {
          if (++copying === 2) copies.release();
          await resume.promise;
        }
        return options?.filter ? await options.filter(candidate, destination) : true;
      },
    }));
    const response: FauxResponseFactory = async (context) => {
      if (JSON.stringify(context.messages).includes("scratch reader")) {
        if (++running === 2) workers.release();
        await finishWorkers.promise;
        return fauxAssistantMessage("scratch worker done");
      }
      return fauxAssistantMessage("writer admitted");
    };
    model.respond([response, response, response, response]);
    const dispatch = dispatchFrom(session);
    const args = (cwd: string) => ({ async: false, tasks: [{ prompt: "scratch reader", cwd, workspace: "scratch", tools: ["write"] }] });
    const first = dispatch(args(alias)), second = dispatch(args(source));
    try {
      await bounded(copies.promise);
      expect(copying).toBe(2);
      expect(model.state.callCount).toBe(0);
      for (const { cwd, workspace } of [
        { cwd: outer, workspace: "shared" },
        { cwd: join(alias, "child"), workspace: "shared" },
        { cwd: source, workspace: "isolated" },
      ]) {
        const rejected = await dispatch({ async: false, tasks: [{ prompt: "writer", cwd, workspace, tools: ["write"] }] });
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toMatch(/scratch source copying/);
        expect(textOf(rejected)).toContain(source);
        expect(textOf(rejected)).toMatch(/copy.*finish.*retry/);
      }
      const unrelated = await dispatch({ async: false, tasks: [{ prompt: "writer unrelated", cwd: tempDir(), tools: ["write"] }] });
      expect(unrelated.isError).not.toBe(true);
      resume.release();
      await bounded(workers.promise);
      // Both copies finished, but their workers are STILL held in the provider.
      const admitted = await dispatch({ async: false, tasks: [{ prompt: "writer", cwd: source, tools: ["write"] }] });
      expect(admitted.isError).not.toBe(true);
      expect(textOf(admitted)).toContain("writer admitted");
      expect(running).toBe(2);
    } finally {
      resume.release(); finishWorkers.release();
      await Promise.all([first, second]); copySpy.mockRestore();
    }
  });

  for (const ending of ["failure", "cancel"] as const) {
    test(`copy claim survives ${ending} until real cp settles, then releases`, async () => {
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      const source = tempDir();
      fs.writeFileSync(join(source, "data.txt"), "source bytes");
      model.respond([fauxAssistantMessage("writer after failed copy")]);
      const hold = holdCopy(source, ending === "failure");
      const controller = new AbortController();
      const dispatch = dispatchFrom(session);
      const pending = dispatch({ async: false, tasks: [{ prompt: "copy", cwd: source, workspace: "scratch", tools: ["write"] }] }, controller.signal);
      try {
        await bounded(hold.entered);
        if (ending === "cancel") controller.abort();
        const rejected = await dispatch({ async: false, tasks: [{ prompt: "writer", cwd: source, tools: ["write"] }] });
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain("scratch source copying");
        expect(model.state.callCount).toBe(0);
        hold.release();
        const result = await bounded(pending);
        expect(textOf(result)).toMatch(ending === "failure" ? /cp filter failure/ : /abort|cancel/i);
        expect(model.state.callCount).toBe(0);
        const admitted = await dispatch({ async: false, tasks: [{ prompt: "writer", cwd: source, tools: ["write"] }] });
        expect(admitted.isError).not.toBe(true);
        expect(textOf(admitted)).toContain("writer after failed copy");
      } finally {
        hold.release();
        try { await pending; } finally { hold.restore(); }
      }
    });
  }

  test("same-phase shared and scratch tasks copy before any workers start", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    const source = tempDir();
    fs.writeFileSync(join(source, "data.txt"), "source bytes");
    const hold = holdCopy(source);
    model.respond([fauxAssistantMessage("shared done"), fauxAssistantMessage("scratch done")]);
    const pending = callDelegate(session, { async: false, tasks: [
      { prompt: "shared", cwd: source, tools: ["write"] },
      { prompt: "scratch", cwd: source, tools: ["write"], workspace: "scratch" },
    ] });
    try {
      await bounded(hold.entered);
      expect(model.state.callCount).toBe(0);
      hold.release();
      const result = await bounded(pending);
      expect(result.isError).toBe(false);
      expect(result.text).toContain("shared done");
      expect(result.text).toContain("scratch done");
      expect(model.state.callCount).toBe(2);
    } finally {
      hold.release();
      try { await pending; } finally { hold.restore(); }
    }
  }, 10_000);

  for (const workspace of ["shared", "isolated"] as const) {
    test(`dependent scratch copies see a confirmed-quiescent prior ${workspace} writer`, async () => {
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      const source = tempDir(); gitInit(source);
      const readResults: string[] = [];
      const response: FauxResponseFactory = async (context) => {
        for (const message of context.messages) {
          if (message.role === "toolResult" && message.toolName === "read") {
            readResults.push(JSON.stringify(message.content));
          }
        }
        if (context.messages.some((message) => message.role === "toolResult")) return fauxAssistantMessage("phase done");
        const ownPrompt = context.messages.find((message) => message.role === "user");
        return JSON.stringify(ownPrompt).includes("prior writer")
          ? fauxAssistantMessage([fauxToolCall("write", { path: "phase.txt", content: "prior phase bytes" })])
          : fauxAssistantMessage([fauxToolCall("read", { path: "phase.txt" })]);
      };
      model.respond([response, response, response, response]);
      const result = await callDelegate(session, { async: false, tasks: [
        { id: "writer", prompt: "prior writer", cwd: source, workspace, tools: ["write"] },
        { prompt: "read copied phase bytes", cwd: source, workspace: "scratch", tools: ["read", "write"], dependsOn: ["writer"] },
      ] });
      expect(result.isError).toBe(false);
      expect(model.state.callCount).toBe(4);
      // Actual child tool results, not just the model's summary.
      expect(readResults.join("\n")).toContain("prior phase bytes");
      expect(fs.readFileSync(join(source, "phase.txt"), "utf8")).toBe("prior phase bytes");
    });
  }

  for (const workspace of ["shared", "isolated"] as const) {
    test(`an earlier quarantined ${workspace} phase writer is not exempted by same-call ownership`, async () => {
      session = await openDelegateBoundary();
      configureDelegate(session, { stallTimeoutMs: 500 });
      const model = await installSubagentModel(session);
      const source = tempDir(); gitInit(source);
      const worker = gate();
      const response: FauxResponseFactory = async (context) => {
        if (JSON.stringify(context.messages).includes("stuck writer")) {
          await worker.promise;
          return fauxAssistantMessage("too late");
        }
        return fauxAssistantMessage("prerequisite done");
      };
      model.respond([response, response, response]);
      try {
        const result = await callDelegate(session, { async: false, tasks: [
          { id: "stuck", prompt: "stuck writer", cwd: source, workspace, tools: ["write"] },
          { id: "ready", prompt: "quick prerequisite", cwd: source, tools: ["read"] },
          { id: "copy", prompt: "scratch must not run", cwd: source, workspace: "scratch", tools: ["write"], dependsOn: ["ready"] },
        ] });
        expect(model.state.callCount).toBe(2);
        expect(result.text).toMatch(/cannot copy source/);
        expect(result.text).toMatch(/writer stuck.*active or quarantined/);
        const rejected = await callDelegate(session, { async: false, tasks: [{ prompt: "new scratch", cwd: source, workspace: "scratch", tools: ["write"] }] });
        expect(rejected.isError).toBe(true);
        expect(model.state.callCount).toBe(2);
      } finally { worker.release(); }
      // Wait for confirmed late quiescence, with admission itself as the signal.
      let after;
      const end = Date.now() + 5000;
      do {
        after = await callDelegate(session, { async: false, tasks: [{ prompt: "copy after quiescence", cwd: source, workspace: "scratch", tools: ["write"] }] });
        if (!after.isError) break;
        await Bun.sleep(5);
      } while (Date.now() < end);
      expect(after.isError).toBe(false);
      expect(model.state.callCount).toBe(3);
    });
  }

  for (const workspace of ["shared", "isolated"] as const) {
    test(`scratch copying exempts a planned future-phase ${workspace} writer`, async () => {
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      const source = tempDir(); gitInit(source);
      model.respond([fauxAssistantMessage("copy finished"), fauxAssistantMessage("future writer finished")]);
      const result = await callDelegate(session, { async: false, tasks: [
        { id: "copy", prompt: "scratch now", cwd: source, workspace: "scratch", tools: ["write"] },
        { prompt: "writer later", cwd: source, workspace, tools: ["write"], dependsOn: ["copy"] },
      ] });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("copy finished");
      expect(result.text).toContain("future writer finished");
      expect(model.state.callCount).toBe(2);
    });
  }

  // Fresh P1 review of #50: late worker truth can lose its quarantine flag
  // before deferred Git cleanup stops mutating the source. Exercise both
  // same-call phase exemption and reservation retention after the call ends.
  // Linux /proc scanning is the real filesystem boundary before worktree remove.
  (process.platform === "linux" ? test : test.skip)("late isolated settlement does not exempt scratch copying while source Git cleanup is pending", async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, { stallTimeoutMs: 500 });
    const model = await installSubagentModel(session);
    const source = tempDir(); gitInit(source);
    const metadata = join(source, ".git", "worktrees", "worker-0");
    const worker = gate(), reconcileEntered = gate(), finishReconcile = gate();
    const cleanupEntered = gate(), finishCleanup = gate();
    let batchRoot: string | undefined;
    let cleanupArmed = false, cleanupHeld = false, copyCalls = 0;
    const response: FauxResponseFactory = async (context) => {
      if (JSON.stringify(context.messages).includes("late isolated writer")) {
        // Discover the actual detached worktree through Git's source metadata,
        // rather than importing a production workspace plan or private state.
        const gitFile = fs.readFileSync(join(metadata, "gitdir"), "utf8").trim();
        batchRoot = dirname(dirname(dirname(gitFile)));
        await worker.promise;
        return fauxAssistantMessage("late worker truth");
      }
      return fauxAssistantMessage("scratch retry allowed");
    };
    model.respond([response, response, response, response]);

    const originalRmdir = fs.promises.rmdir;
    const rmdirSpy = spyOn(fs.promises, "rmdir").mockImplementation(async (path, options) => {
      if (String(path) === batchRoot && !cleanupArmed) {
        // Proposal discard and group reconciliation have finished, but the
        // phase has not returned. Now let the REAL stalled worker settle.
        cleanupArmed = true;
        reconcileEntered.release();
        await finishReconcile.promise;
      }
      return originalRmdir(path, options);
    });
    const originalReaddir = fs.promises.readdir;
    const readdirSpy = spyOn(fs.promises, "readdir").mockImplementation((async (...args: Parameters<typeof originalReaddir>) => {
      if (String(args[0]) === "/proc" && cleanupArmed && !cleanupHeld) {
        // onWorkerSettled has recorded nonquarantined late truth before
        // entering this real scan. Hold cleanup BEFORE git worktree remove.
        cleanupHeld = true;
        cleanupEntered.release();
        await finishCleanup.promise;
      }
      return originalReaddir(...args);
    }) as typeof originalReaddir);
    const originalCp = fs.promises.cp;
    const cpSpy = spyOn(fs.promises, "cp").mockImplementation(async (src, dst, options) => {
      if (String(src) === source) copyCalls++;
      return originalCp(src, dst, options);
    });
    const pending = callDelegate(session, { async: false, tasks: [
      { id: "late", prompt: "late isolated writer", cwd: source, workspace: "isolated", tools: ["write"] },
      { id: "ready", prompt: "quick prerequisite", cwd: source, tools: ["read"] },
      { id: "copy", prompt: "later-phase scratch must not run", cwd: source, workspace: "scratch", tools: ["write"], dependsOn: ["ready"] },
    ] });
    try {
      await bounded(reconcileEntered.promise);
      expect(fs.existsSync(metadata)).toBe(true);
      expect(model.state.callCount).toBe(2);
      worker.release();
      await bounded(cleanupEntered.promise);
      expect(fs.existsSync(metadata)).toBe(true);
      finishReconcile.release();
      // Reject, not wait: the batch must finish with cleanup still held.
      const result = await bounded(pending);
      const details = result.details as { results: { id: string; quarantined?: boolean; integration?: { status: string; reason?: string } }[] };
      const late = details.results.find((outcome) => outcome.id === "late")!;
      expect(late.quarantined).not.toBe(true);
      expect(late.integration?.status).toBe("discarded");
      expect(late.integration?.reason).toMatch(/termination was never confirmed/);
      expect(result.text).toMatch(/cannot copy source/);
      expect(result.text).toMatch(/writer late.*active or quarantined/);
      expect(copyCalls).toBe(0);
      expect(model.state.callCount).toBe(2);
      expect(fs.existsSync(metadata)).toBe(true);

      // A separate public call must also reject after the original dispatch
      // returned: replacing quarantine truth must not release its reservation.
      const rejected = await bounded(callDelegate(session, { async: false, tasks: [
        { prompt: "cross-call scratch must not run", cwd: source, workspace: "scratch", tools: ["write"] },
      ] }));
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toMatch(/cannot copy source/);
      expect(copyCalls).toBe(0);
      expect(model.state.callCount).toBe(2);
      expect(fs.existsSync(metadata)).toBe(true);

      finishCleanup.release();
      // Admission itself proves release; no production-internal quiescence
      // probe. Real Git removal must also have changed the source metadata.
      let retry;
      const end = Date.now() + 5000;
      do {
        retry = await callDelegate(session, { async: false, tasks: [
          { prompt: "scratch after cleanup", cwd: source, workspace: "scratch", tools: ["write"] },
        ] });
        if (!retry.isError) break;
        await Bun.sleep(5);
      } while (Date.now() < end);
      expect(retry.isError).toBe(false);
      expect(retry.text).toContain("scratch retry allowed");
      expect(fs.existsSync(metadata)).toBe(false);
      expect(execSync("git worktree list --porcelain", { cwd: source, encoding: "utf8", env: gitFixtureEnv() })).not.toContain("worker-0");
      expect(copyCalls).toBe(1);
      expect(model.state.callCount).toBe(3);
    } finally {
      worker.release(); finishReconcile.release(); finishCleanup.release();
      try { await bounded(pending); } finally {
        rmdirSpy.mockRestore(); readdirSpy.mockRestore(); cpSpy.mockRestore();
      }
    }
  }, 15_000);

  // Second independently reproduced #50 P1: another repository reconciles
  // first, so late truth arrives BEFORE the target group's proposal collection
  // has decided retention. Source reservations must cover that future Git tail.
  (process.platform === "linux" ? test : test.skip)("late isolated settlement before target-group reconciliation still rejects scratch copying", async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, { stallTimeoutMs: 500 });
    const model = await installSubagentModel(session);
    const firstSource = tempDir(), secondSource = tempDir();
    gitInit(firstSource); gitInit(secondSource);
    const firstMetadata = join(firstSource, ".git", "worktrees", "worker-0");
    const secondMetadata = join(secondSource, ".git", "worktrees", "worker-1");
    const worker = gate(), reconcileEntered = gate(), finishReconcile = gate();
    let scans = 0, armed = false;
    const response: FauxResponseFactory = async (context) => {
      if (JSON.stringify(context.messages).includes("second gated writer")) {
        await worker.promise;
        return fauxAssistantMessage("late second worker truth");
      }
      armed = true;
      return fauxAssistantMessage("first worker finished");
    };
    model.respond([response, response, fauxAssistantMessage("scratch retry allowed")]);

    const originalReaddir = fs.promises.readdir;
    const readdirSpy = spyOn(fs.promises, "readdir").mockImplementation((async (...args: Parameters<typeof originalReaddir>) => {
      if (String(args[0]) === "/proc" && armed && ++scans === 1) {
        // The actual first group's process scan precedes proposal snapshotting
        // and Git removal. Sequential repository reconciliation has not yet
        // reached the second group; no retention decision exists there.
        reconcileEntered.release();
        await finishReconcile.promise;
      }
      return originalReaddir(...args);
    }) as typeof originalReaddir);
    const copy = holdCopy(secondSource);
    let copyEntered = false;
    const copyStarted = copy.entered.then(() => { copyEntered = true; });
    let ticket: string | undefined;
    let scratch: ReturnType<typeof callDelegate> | undefined;
    type Outcomes = { results: { id: string; quarantined?: boolean; integration?: { status: string } }[] };
    try {
      const receipt = await bounded(callDelegate(session, { async: true, tasks: [
        { id: "first", prompt: "first normal writer", cwd: firstSource, workspace: "isolated", tools: ["write"] },
        { id: "late", prompt: "second gated writer", cwd: secondSource, workspace: "isolated", tools: ["write"] },
      ] }));
      expect(receipt.isError).toBe(false);
      ticket = ticketIdOf(receipt.text);
      await bounded(reconcileEntered.promise);
      expect(model.state.callCount).toBe(2);
      expect(fs.existsSync(firstMetadata)).toBe(true);
      expect(fs.existsSync(secondMetadata)).toBe(true);
      const provisional = await bounded(callDelegateTicket(session, { action: "poll", ticket }));
      const before = (provisional.details as Outcomes).results.find((outcome) => outcome.id === "late")!;
      expect(before.quarantined).toBe(true);
      expect(before.integration).toBeUndefined();

      worker.release();
      // Provider return alone is not worker truth. Observe the public ticket's
      // replacement outcome (no longer quarantined) before probing
      // admission, while the first group's real reconciliation is still held.
      await bounded((async () => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const polled = await callDelegateTicket(session!, { action: "poll", ticket });
          const late = (polled.details as Outcomes).results.find((outcome) => outcome.id === "late");
          if (late && !late.quarantined) {
            expect(late.integration).toBeUndefined();
            return;
          }
          await Bun.sleep(5);
        }
        throw new Error("late worker truth never reached the public ticket");
      })());
      expect(scans).toBe(1);
      expect(fs.existsSync(secondMetadata)).toBe(true);
      scratch = callDelegate(session, { async: false, tasks: [
        { prompt: "scratch must reject before second reconciliation", cwd: secondSource, workspace: "scratch", tools: ["write"] },
      ] });
      // A broken guard admits REAL cp; stop its filter instead of letting it
      // race Git removal or hang this test. The negative control must fail on
      // this observable copy start, not on an incidental copy/Git exception.
      const rejected = await bounded(Promise.race([scratch, copyStarted.then(() => undefined)]));
      expect(fs.promises.cp).not.toHaveBeenCalled();
      expect(copyEntered).toBe(false);
      expect(rejected?.isError).toBe(true);
      expect(rejected?.text).toMatch(/cannot copy source/);
      expect(rejected?.text).toMatch(/writer late.*active or quarantined/);
      expect(model.state.callCount).toBe(2);
      expect(scans).toBe(1);
      expect(fs.existsSync(secondMetadata)).toBe(true);

      finishReconcile.release();
      const completed = await bounded(callDelegateTicket(session, { action: "wait", ticket }));
      expect(completed.isError).toBe(false);
      expect(completed.text).toMatch(/done|complet/i);
      expect(fs.existsSync(firstMetadata)).toBe(false);
      expect(fs.existsSync(secondMetadata)).toBe(false);
      expect(execSync("git worktree list --porcelain", { cwd: secondSource, encoding: "utf8", env: gitFixtureEnv() })).not.toContain("worker-1");
      copy.release();
      const retry = await bounded(callDelegate(session, { async: false, tasks: [
        { prompt: "scratch after both repositories reconcile", cwd: secondSource, workspace: "scratch", tools: ["write"] },
      ] }));
      expect(retry.isError).toBe(false);
      expect(retry.text).toContain("scratch retry allowed");
      expect(fs.promises.cp).toHaveBeenCalledTimes(1);
      expect(copyEntered).toBe(true);
      expect(model.state.callCount).toBe(3);
    } finally {
      worker.release(); finishReconcile.release(); copy.release();
      try {
        if (scratch) await bounded(scratch);
        if (ticket) await bounded(callDelegateTicket(session, { action: "wait", ticket }));
      } finally {
        readdirSpy.mockRestore(); copy.restore();
      }
    }
  }, 15_000);
});

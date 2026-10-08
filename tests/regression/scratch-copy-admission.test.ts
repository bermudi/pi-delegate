import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function gitInit(root: string) {
  execSync("git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty", { cwd: root });
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
      await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
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
});

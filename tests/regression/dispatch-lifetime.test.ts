/**
 * #131: a failure before any worker exists must not leave a dispatch holding
 * admission or shutdown forever. A child-creation failure is narrower: it must
 * preserve an independent sibling's success. These are public lifecycle
 * regressions, not assertions about the lifetime's internal implementation.
 */
import { expect, spyOn, test } from "bun:test";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  TestSession,
  ToolResultRecord,
} from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  callDelegateTicket,
  configureDelegate,
  delegateTool,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

const setupCause = "ISSUE-131-BATCH-SETUP-FAULT";
const loaderCause = "ISSUE-131-CHILD-LOADER-FAULT";

/** Keep the deliberately red shutdown checks quick, without changing defaults. */
async function withBoundary(
  run: (session: TestSession) => Promise<void>,
): Promise<void> {
  const previous = process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS;
  process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS = "300";
  let session: TestSession | undefined;
  try {
    session = await openDelegateBoundary();
    await run(session);
  } finally {
    session?.dispose();
    if (previous === undefined) delete process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS;
    else process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS = previous;
  }
}

function independentTasks(session: TestSession) {
  // Default agents are writers: sibling directories outside Git give each
  // task a distinct physical write scope, without making admission read-only.
  return ["first", "second"].map((id) => {
    const cwd = join(session.cwd, id);
    mkdirSync(cwd);
    return { id, cwd, prompt: `lifetime regression ${id}` };
  });
}

/** A receipt is not an outcome: async assertions must inspect the ticket. */
async function settledView(
  session: TestSession,
  dispatched: ToolResultRecord,
  async: boolean,
): Promise<ToolResultRecord> {
  if (!async || dispatched.isError) return dispatched;
  return callDelegateTicket(session, {
    action: "wait",
    ticket: ticketIdOf(dispatched.text),
  });
}

async function setupFault(
  session: TestSession,
  args: Record<string, unknown>,
  async: boolean,
) {
  // Install only after the boundary is open: constructor/default Math.floor
  // calls must remain untouched. 37 is the user-global concurrency fixture,
  // and all unrelated values (including host formatting) keep native behavior.
  configureDelegate(session, { maxConcurrent: 37 });
  const floor = Math.floor;
  let hits = 0;
  const fault = spyOn(Math, "floor").mockImplementation((value) => {
    if (value === 37 && hits === 0) {
      hits += 1;
      throw new Error(setupCause);
    }
    return floor(value);
  });
  try {
    const dispatched = await callDelegate(session, args);
    const view = await settledView(session, dispatched, async);
    return { hits, dispatched, view };
  } finally {
    fault.mockRestore();
  }
}

/**
 * A resolved shutdown is NOT by itself evidence of quiescence: the host is
 * allowed to stop waiting at its budget. Observe the real UI warning as well.
 */
async function shutdownWarnings(session: TestSession): Promise<string[]> {
  const host = session.session as AgentSession;
  const notify = spyOn(host.extensionRunner.createContext().ui, "notify");
  try {
    await host.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    return notify.mock.calls
      .filter(([, kind]) => kind === "warning")
      .map(([text]) => text);
  } finally {
    notify.mockRestore();
  }
}

function expectCleanShutdown(warnings: readonly string[]): void {
  expect(
    warnings.filter((text) => /still stopping|still.*mutat|quiescence.*expir/i.test(text)),
    "shutdown must confirm quiescence, not exit by exhausting its 300ms budget",
  ).toEqual([]);
}

function expectSetupFailure(
  fault: Awaited<ReturnType<typeof setupFault>>,
  async: boolean,
): void {
  expect(fault.hits).toBe(1);
  expect(fault.view.text).toContain(setupCause);
  if (!async) {
    expect(fault.view.isError).toBe(true);
    return;
  }
  expect(fault.dispatched.isError).toBe(false);
  const receipt = objectOf(fault.dispatched.details);
  expect(receipt.async).toBe(true);
  expect(receipt.tasks).toEqual(["first", "second"]);
  const ticket = ticketIdOf(fault.dispatched.text);
  expect(receipt.ticket).toBe(ticket);
  expect(fault.view.text).toContain(`Ticket "${ticket}": failed`);
  const details = objectOf(fault.view.details);
  expect(details.ticket).toBe(ticket);
  expect(details.results).toBeArray();
  const outcomes = details.results as unknown[];
  expect(outcomes).toHaveLength(2);
  for (const [index, id] of ["first", "second"].entries()) {
    const outcome = objectOf(outcomes[index], `failed task ${id}`);
    expect(outcome.id).toBe(id);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain(setupCause);
    expect(outcome.quarantined).not.toBe(true);
  }
}

for (const async of [false, true]) {
  const mode = async ? "async" : "sync";

  test(`${mode} batch setup failure releases admission for an immediate same-scope retry`, async () => {
    await withBoundary(async (session) => {
      const model = await installSubagentModel(session);
      const tasks = independentTasks(session);
      const args = { async, tasks };
      const fault = await setupFault(session, args, async);
      const callsAfterFault = model.state.callCount;

      // setupFault has restored Math.floor. A single retry, not a polling
      // loop, witnesses release of both writer claims after this no-worker
      // failure. It cannot consume a script unless it was actually admitted.
      model.respond([
        fauxAssistantMessage("RETRY-FIRST"),
        fauxAssistantMessage("RETRY-SECOND"),
      ]);
      const retryDispatch = await callDelegate(session, args);
      const retry = await settledView(session, retryDispatch, async);
      const warnings = await shutdownWarnings(session);

      expect(fault.hits).toBe(1);
      expect(callsAfterFault).toBe(0);
      expect(retryDispatch.isError, retryDispatch.text).toBe(false);
      expect(retry.isError, retry.text).toBe(false);
      expect(retry.text).toContain("RETRY-FIRST");
      expect(retry.text).toContain("RETRY-SECOND");
      expect(model.state.callCount).toBe(2);
      expectSetupFailure(fault, async);
      expectCleanShutdown(warnings);
    });
  });

  test(`${mode} batch setup failure permits clean shutdown before any retry`, async () => {
    await withBoundary(async (session) => {
      const model = await installSubagentModel(session);
      const fault = await setupFault(session, { async, tasks: independentTasks(session) }, async);
      // No succeeding run can clear or conceal the failed dispatch's leftover
      // shutdown obligation in this separate scenario.
      const warnings = await shutdownWarnings(session);
      expect(fault.hits).toBe(1);
      expect(model.state.callCount).toBe(0);
      expectCleanShutdown(warnings);
      expectSetupFailure(fault, async);
    });
  });
}

test("batch setup failure discards the prepared scratch copy before releasing its lifetime", async () => {
  await withBoundary(async (session) => {
    const model = await installSubagentModel(session);
    const source = join(session.cwd, "scratch-source");
    mkdirSync(source);
    const marker = join(source, "untouched.txt");
    writeFileSync(marker, "original source");
    const copies: string[] = [];
    const original = fs.promises.cp;
    const copy = spyOn(fs.promises, "cp").mockImplementation(async (from, to, options) => {
      if (String(from) === source) copies.push(String(to));
      return original(from, to, options);
    });
    let fault: Awaited<ReturnType<typeof setupFault>>;
    try {
      fault = await setupFault(session, {
        async: false,
        tasks: [{ prompt: "never starts in the copy", cwd: source, workspace: "scratch" }],
      }, false);
    } finally {
      copy.mockRestore();
    }
    expect(fault.hits).toBe(1);
    expect(fault.view.text).toContain(setupCause);
    expect(model.state.callCount).toBe(0);
    expect(copies).toHaveLength(1);
    expect(existsSync(copies[0]!)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("original source");
    model.respond([fauxAssistantMessage("AFTER-SCRATCH-SETUP-FAILURE")]);
    const retry = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "reuse the source scope", cwd: source }],
    });
    expect(retry.isError, retry.text).toBe(false);
    expect(retry.text).toContain("AFTER-SCRATCH-SETUP-FAILURE");
    expectCleanShutdown(await shutdownWarnings(session));
  });
});

for (const async of [false, true]) {
  const mode = async ? "async" : "sync";
  test(`${mode} child loader rejection preserves an independent sibling and releases both scopes`, async () => {
    await withBoundary(async (session) => {
      const model = await installSubagentModel(session);
      const tasks = independentTasks(session);
      const args = { async, tasks };
      const original = DefaultResourceLoader.prototype.reload;
      let hits = 0;
      // Host-boundary fault injection only. The host keeps cwd private in its
      // TypeScript declarations; identify this ONE loader by its distinct cwd,
      // never inspect Delegate's worker, lifetime, or admission internals.
      const reload = spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(
        async function (
          this: DefaultResourceLoader,
          ...options: Parameters<DefaultResourceLoader["reload"]>
        ) {
          const { cwd } = this as unknown as { cwd: string };
          if (cwd === tasks[0]!.cwd && hits === 0) {
            hits += 1;
            throw new Error(loaderCause);
          }
          return original.apply(this, options);
        },
      );
      let dispatched: ToolResultRecord;
      let view: ToolResultRecord;
      try {
        model.respond([fauxAssistantMessage("INDEPENDENT-SIBLING-SUCCEEDED")]);
        dispatched = await callDelegate(session, args);
        view = await settledView(session, dispatched, async);
      } finally {
        reload.mockRestore();
      }
      const callsAfterFault = model.state.callCount;
      model.respond([
        fauxAssistantMessage("LOADER-RETRY-FIRST"),
        fauxAssistantMessage("LOADER-RETRY-SECOND"),
      ]);
      const retryDispatch = await callDelegate(session, args);
      const retry = await settledView(session, retryDispatch, async);
      const warnings = await shutdownWarnings(session);

      expect(hits).toBe(1);
      expect(callsAfterFault).toBe(1);
      expect(dispatched.isError, dispatched.text).toBe(false);
      expect(view.isError, view.text).toBe(false);
      expect(view.text).toContain(loaderCause);
      expect(view.text).toContain("INDEPENDENT-SIBLING-SUCCEEDED");
      if (async) expect(view.text).toMatch(/Ticket ".+": partial/);
      const details = objectOf(view.details);
      expect(details.results).toBeArray();
      const outcomes = details.results as unknown[];
      expect(outcomes).toHaveLength(2);
      const failed = objectOf(outcomes[0]);
      const succeeded = objectOf(outcomes[1]);
      expect(failed.id).toBe("first");
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain(loaderCause);
      expect(failed.quarantined).not.toBe(true);
      expect(succeeded.id).toBe("second");
      expect(succeeded.status).toBe("ok");
      expect(succeeded.output).toContain("INDEPENDENT-SIBLING-SUCCEEDED");
      expect(retryDispatch.isError, retryDispatch.text).toBe(false);
      expect(retry.isError, retry.text).toBe(false);
      expect(retry.text).toContain("LOADER-RETRY-FIRST");
      expect(retry.text).toContain("LOADER-RETRY-SECOND");
      expect(model.state.callCount).toBe(3);
      expectCleanShutdown(warnings);
    });
  });
}

interface DirectResult {
  readonly content: readonly { readonly text?: string }[];
  readonly isError?: boolean;
  readonly details?: unknown;
}

interface DirectDelegate {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (value: unknown) => void,
    ctx: unknown,
  ): Promise<DirectResult>;
}

test("task signal setup failure records an aligned pre-worker outcome and releases its scope", async () => {
  await withBoundary(async (session) => {
    const cause = "ISSUE-131-TASK-SIGNAL-SETUP-FAULT";
    const model = await installSubagentModel(session);
    const host = session.session as AgentSession;
    const tool = delegateTool(session) as unknown as DirectDelegate;
    const controller = new AbortController();
    const signal = controller.signal;
    const original = signal.addEventListener.bind(signal);
    const args = {
      async: false,
      tasks: [{ id: "signal-task", prompt: "never reaches the provider", cwd: session.cwd }],
    };
    let hits = 0;
    let callsAtInjection: number | undefined;
    // Only this explicitly supplied signal is faulty. Other host/worker
    // signals and their listeners retain their native behavior.
    const listener = spyOn(signal, "addEventListener").mockImplementation(
      (type, callback, options) => {
        if (type === "abort" && hits === 0) {
          hits += 1;
          callsAtInjection = model.state.callCount;
          throw new Error(cause);
        }
        return original(type, callback, options);
      },
    );
    let result: DirectResult | undefined;
    let rejection: unknown;
    try {
      result = await tool.execute(
        "signal-setup-fault",
        args,
        signal,
        () => {},
        host.extensionRunner.createContext(),
      );
    } catch (error) {
      // Baseline throws before recording an outcome. Still restore the spy,
      // probe admission, and exercise bounded shutdown before asserting.
      rejection = error;
    } finally {
      listener.mockRestore();
    }
    const callsAfterFault = model.state.callCount;
    model.respond([fauxAssistantMessage("SIGNAL-SETUP-RETRY-SUCCEEDED")]);
    const retry = await callDelegate(session, args);
    const warnings = await shutdownWarnings(session);

    expect(hits).toBe(1);
    expect(callsAtInjection).toBe(0);
    expect(callsAfterFault).toBe(0);
    expect(rejection, "task signal setup must settle a failed outcome, not reject the batch").toBeUndefined();
    expect(result?.isError).toBe(true);
    expect(result?.content.map(({ text }) => text ?? "").join("\n")).toContain(cause);
    const details = objectOf(result?.details);
    expect(details.results).toBeArray();
    const outcomes = details.results as unknown[];
    expect(outcomes).toHaveLength(1);
    const failed = objectOf(outcomes[0]);
    expect(failed.index).toBe(0);
    expect(failed.id).toBe("signal-task");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain(cause);
    expect(failed.quarantined).not.toBe(true);
    expect(retry.isError, retry.text).toBe(false);
    expect(retry.text).toContain("SIGNAL-SETUP-RETRY-SUCCEEDED");
    expect(model.state.callCount).toBe(1);
    expectCleanShutdown(warnings);
  });
});

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  delegateTool,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
  callDelegateSession,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

interface DirectResult {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
  readonly isError?: boolean;
  readonly details?: unknown;
}

interface DirectTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: unknown,
  ): Promise<DirectResult>;
}

function gate() {
  let release!: () => void;
  let markStarted!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const step: FauxResponseFactory = async () => {
    markStarted();
    await pending;
    return fauxAssistantMessage("OUTPUT-RELEASED");
  };
  return { release, started, step };
}

function directDispatcher(session: TestSession) {
  const tool = delegateTool(session) as unknown as DirectTool;
  const ctx = (session.session as AgentSession).extensionRunner.createContext();
  const fallback = new AbortController();
  let sequence = 0;
  return (
    params: Record<string, unknown>,
    options: {
      readonly onUpdate?: (update: unknown) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<DirectResult> => {
    sequence += 1;
    return tool.execute(
      `direct-${sequence}`,
      params,
      options.signal ?? fallback.signal,
      options.onUpdate ?? (() => {}),
      ctx,
    );
  };
}

function textOf(result: DirectResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

describe("delegate explicit operation identity", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "identical unkeyed dispatches always execute independently",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("UNKEYED-FIRST"),
        fauxAssistantMessage("UNKEYED-SECOND"),
      ]);
      const args = { tasks: [{ prompt: "same work", tools: ["read"] }] };

      const first = await callDelegate(session, args);
      const second = await callDelegate(session, args);

      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      expect(first.text).toContain("UNKEYED-FIRST");
      expect(second.text).toContain("UNKEYED-SECOND");
      expect(subagents.state.callCount).toBe(2);
    },
  );

  test(
    "concurrent same-key calls share one execution and one result",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, started, step } = gate();
      subagents.respond([step]);
      const direct = directDispatcher(session);
      const args = {
        tasks: [{ prompt: "shared work", tools: ["read"] }],
        operationId: "op-race",
      };

      const first = direct(args);
      await started;
      const duplicateController = new AbortController();
      const duplicateUpdates: unknown[] = [];
      const second = direct(args, {
        onUpdate: (update) => duplicateUpdates.push(update),
        signal: duplicateController.signal,
      });
      duplicateController.abort();
      release();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toBe(secondResult);
      expect(textOf(firstResult)).toContain("OUTPUT-RELEASED");
      expect(duplicateUpdates).toHaveLength(0);
      expect(subagents.state.callCount).toBe(1);
    },
  );

  test(
    "an async operation retries while running and after settlement to the same ticket",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step]);
      const args = {
        tasks: [{ prompt: "bg", tools: ["read"] }],
        async: true,
        operationId: "op-async",
      };

      const dispatched = await callDelegate(session, args);
      const ticket = ticketIdOf(dispatched.text);

      const retryWhileRunning = await callDelegate(session, args);
      expect(ticketIdOf(retryWhileRunning.text)).toBe(ticket);

      release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.isError).toBe(false);

      const retryAfterSettlement = await callDelegate(session, args);
      expect(ticketIdOf(retryAfterSettlement.text)).toBe(ticket);
      expect(subagents.state.callCount).toBe(1);
    },
  );

  test(
    "the same key with a changed request conflicts while running and after settlement",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, started, step } = gate();
      subagents.respond([step]);
      const direct = directDispatcher(session);
      const original = {
        tasks: [{ prompt: "alpha", tools: ["read"] }],
        operationId: "op-conflict",
      };
      const changed = {
        tasks: [{ prompt: "beta", tools: ["read"] }],
        operationId: "op-conflict",
      };

      const first = direct(original);
      await started;
      const runningConflict = await direct(changed).then(
        () => {
          throw new Error("a changed request must not execute");
        },
        (error: unknown) => error,
      );
      expect(String((runningConflict as Error).message)).toContain(
        "op-conflict",
      );
      expect(String((runningConflict as Error).message)).toMatch(
        /original request|new operationId/i,
      );
      expect(subagents.state.callCount).toBe(1);

      release();
      await first;

      const settledConflict = await callDelegate(session, changed);
      expect(settledConflict.isError).toBe(true);
      expect(settledConflict.text).toContain("op-conflict");
      expect(settledConflict.text).toMatch(
        /original request|new operationId/i,
      );

      const reuse = await callDelegate(session, original);
      expect(reuse.isError).toBe(false);
      expect(reuse.text).toContain("OUTPUT-RELEASED");
      expect(subagents.state.callCount).toBe(1);
    },
  );

  test(
    "equivalent normalized requests reuse the original operation",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("NORM-FLAT"),
        fauxAssistantMessage("NORM-WS"),
      ]);

      const flat = await callDelegate(session, {
        prompt: "norm task",
        tools: ["read"],
        operationId: "op-flat",
      });
      const wrapped = await callDelegate(session, {
        tasks: [{ prompt: "norm task", tools: ["read"] }],
        operationId: "op-flat",
      });
      expect(flat.isError).toBe(false);
      expect(wrapped.text).toBe(flat.text);
      expect(wrapped.text).toContain("NORM-FLAT");

      const batchDefault = await callDelegate(session, {
        tasks: [{ prompt: "ws task", tools: ["read"] }],
        workspace: "shared",
        operationId: "op-ws",
      });
      const taskLevel = await callDelegate(session, {
        tasks: [{ prompt: "ws task", tools: ["read"], workspace: "shared" }],
        operationId: "op-ws",
      });
      expect(batchDefault.isError).toBe(false);
      expect(taskLevel.text).toBe(batchDefault.text);
      expect(taskLevel.text).toContain("NORM-WS");
      expect(subagents.state.callCount).toBe(2);
    },
  );

  test(
    "a force-cancelled operation is reused and never restarted",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([fauxAssistantMessage("EARLY-OK"), step]);
      const args = {
        tasks: [{ prompt: "quick" }, { prompt: "slow" }],
        async: true,
        operationId: "op-cancel",
      };

      const dispatched = await callDelegate(session, args);
      const ticket = ticketIdOf(dispatched.text);
      const cancelled = await callDelegateTicket(session, {
        action: "cancel",
        ticket,
        force: true,
      });
      expect(cancelled.isError).toBe(false);
      release();

      const polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(polled.text).toMatch(/cancelled/i);
      const callsAfterCancel = subagents.state.callCount;

      const retry = await callDelegate(session, args);
      expect(ticketIdOf(retry.text)).toBe(ticket);
      const repolled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(repolled.text).toMatch(/cancelled/i);
      expect(subagents.state.callCount).toBe(callsAfterCancel);
    },
  );

  test(
    "a settled record expires one hour after settlement",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("EXPIRE-FIRST"),
        fauxAssistantMessage("EXPIRE-SECOND"),
      ]);
      const args = {
        tasks: [{ prompt: "timed", tools: ["read"] }],
        operationId: "op-expire",
      };

      const first = await callDelegate(session, args);
      expect(first.text).toContain("EXPIRE-FIRST");
      const reused = await callDelegate(session, args);
      expect(reused.text).toBe(first.text);
      expect(subagents.state.callCount).toBe(1);

      const realNow = Date.now;
      const clock = spyOn(Date, "now").mockImplementation(
        () => realNow() + 60 * 60 * 1000,
      );
      try {
        const fresh = await callDelegate(session, args);
        expect(fresh.text).toContain("EXPIRE-SECOND");
        expect(subagents.state.callCount).toBe(2);
      } finally {
        clock.mockRestore();
      }
    },
  );

  test(
    "an in-flight async operation survives settled-record cap pressure",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        models: { scout: "ghost-provider/model-x" },
      });
      const direct = directDispatcher(session);
      const { release, started, step } = gate();
      subagents.respond([step]);
      const args = {
        tasks: [{ prompt: "bg", tools: ["read"] }],
        async: true,
        operationId: "op-live",
      };

      const dispatched = await callDelegate(session, args);
      const ticket = ticketIdOf(dispatched.text);
      await started;

      for (let n = 0; n <= 256; n += 1) {
        const outcome = await direct({
          tasks: [{ prompt: `filler ${n}`, agent: "scout", tools: ["read"] }],
          operationId: `press-${String(n).padStart(4, "0")}`,
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(outcome).toBeInstanceOf(Error);
      }

      const retry = await callDelegate(session, args);
      expect(ticketIdOf(retry.text)).toBe(ticket);
      expect(subagents.state.callCount).toBe(1);

      release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.isError).toBe(false);
      expect(subagents.state.callCount).toBe(1);
    },
    60_000,
  );

  test(
    "the 257th settled record evicts the oldest and keeps the newest reusable",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        models: { scout: "ghost-provider/model-x" },
      });
      const direct = directDispatcher(session);
      subagents.respond([
        fauxAssistantMessage("CAP-ZERO-FIRST"),
        fauxAssistantMessage("CAP-NEWEST"),
        fauxAssistantMessage("CAP-ZERO-SECOND"),
      ]);

      const oldest = await direct({
        tasks: [{ prompt: "zero", tools: ["read"] }],
        operationId: "cap-0000",
      });
      expect(textOf(oldest)).toContain("CAP-ZERO-FIRST");

      for (let n = 1; n <= 255; n += 1) {
        const outcome = await direct({
          tasks: [{ prompt: `filler ${n}`, agent: "scout", tools: ["read"] }],
          operationId: `cap-${String(n).padStart(4, "0")}`,
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(outcome).toBeInstanceOf(Error);
      }

      const newest = await callDelegate(session, {
        tasks: [{ prompt: "newest", tools: ["read"] }],
        operationId: "cap-0256",
      });
      expect(newest.text).toContain("CAP-NEWEST");
      expect(subagents.state.callCount).toBe(2);

      const newestRetry = await callDelegate(session, {
        tasks: [{ prompt: "newest", tools: ["read"] }],
        operationId: "cap-0256",
      });
      expect(newestRetry.text).toBe(newest.text);
      expect(subagents.state.callCount).toBe(2);

      const oldestRetry = await callDelegate(session, {
        tasks: [{ prompt: "zero", tools: ["read"] }],
        operationId: "cap-0000",
      });
      expect(oldestRetry.text).toContain("CAP-ZERO-SECOND");
      expect(subagents.state.callCount).toBe(3);
    },
    60_000,
  );

  // Root bypasses file permissions, so chmodSync(dir, 0o500) cannot make
  // the journal write fail and the fixture would pin nothing.
  test.skipIf(process.getuid?.() === 0)(
    "an async operationId retry after a storage failure returns the original failure, never a new execution",
    async () => {
      // Bug 7 regression (INVARIANTS "Dispatch identity": failure is
      // retained and never restarted). create() registers before its
      // journal write so the operationId duplicate-protection fingerprint
      // binds the storage failure itself: a retry after fixing storage
      // returns the same failure without starting workers.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("STORAGE-RETRY-NEVER")]);
      const dir = join(session.cwd, "delegate-tickets");
      mkdirSync(dir, { mode: 0o700, recursive: true });
      chmodSync(dir, 0o500);
      const args = {
        tasks: [{ prompt: "storage fails first", tools: ["read"] }],
        async: true,
        operationId: "op-storage-failure",
      };
      let failed;
      try {
        failed = await callDelegate(session, args);
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(failed.isError).toBe(true);
      expect(failed.text).toMatch(/ticket|storage|journal|permission|denied/i);
      expect(subagents.state.callCount).toBe(0);
      const retry = await callDelegate(session, args);
      expect(retry.isError).toBe(true);
      expect(retry.text).toBe(failed.text);
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a failed operation is reused even after configuration is fixed",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        models: { scout: "ghost-provider/model-x" },
      });
      const args = {
        tasks: [{ prompt: "x", agent: "scout", tools: ["read"] }],
        operationId: "op-failed",
      };

      const failed = await callDelegate(session, args);
      expect(failed.isError).toBe(true);
      expect(subagents.state.callCount).toBe(0);

      configureDelegate(session, { models: { scout: subagents.spec } });
      const retry = await callDelegate(session, args);
      expect(retry.isError).toBe(true);
      expect(retry.text).toBe(failed.text);
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "invalid operationId shapes and non-dispatch combinations reject before provider work",
    async () => {
      for (const arguments_ of [
        {
          tasks: [{ prompt: "x", tools: ["read"] }],
          operationId: "bad id!",
        },
        // `operationId: ""` is absent by the blank rule and covered by the
        // unkeyed dispatch path, not by this invalid-shapes loop.
        {
          tasks: [{ prompt: "x", tools: ["read"] }],
          operationId: "k".repeat(65),
        },
        { tasks: [{ prompt: "x", tools: ["read"] }], operationId: 123 },
        { tasks: [{ prompt: "x", tools: ["read"] }], operationId: true },
        { tasks: [{ prompt: "x", tools: ["read"] }], operationId: ["k"] },
      ]) {
        session?.dispose();
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);
        const result = await callDelegate(session, arguments_);
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/operationId/i);
        expect(subagents.state.callCount).toBe(0);
      }

      session?.dispose();
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const ticketConflict = await callDelegateTicket(session, {
        action: "poll",
        operationId: "k",
      });
      expect(ticketConflict.isError).toBe(true);
      expect(ticketConflict.text).toContain("operationId");

      const sessionConflict = await callDelegateSession(session, {
        action: "list",
        operationId: "k",
      });
      expect(sessionConflict.isError).toBe(true);
      expect(sessionConflict.text).toContain("operationId");

      const helpConflict = await callDelegate(session, { operationId: "k" });
      expect(helpConflict.isError).toBe(true);
      expect(helpConflict.text).toContain(
        "operationId requires a non-empty dispatch task list",
      );

      const emptyTasks = await callDelegate(session, {
        tasks: [],
        operationId: "k",
      });
      expect(emptyTasks.isError).toBe(true);
      expect(emptyTasks.text).toContain(
        "operationId requires a non-empty dispatch task list",
      );

      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "an operationId does not survive a restart — the same key re-runs the work",
    async () => {
      // INVARIANTS "Dispatch identity": operation identity lives only as
      // long as the host extension/session; saved tickets MUST NOT
      // deduplicate a new dispatch by operationId. A fresh extension
      // instance over the same agent directory must execute the keyed
      // request again, not hand back the settled record.
      const sessions: TestSession[] = [];
      try {
        const first = await openDelegateBoundary();
        sessions.push(first);
        const firstModel = await installSubagentModel(first);
        firstModel.respond([fauxAssistantMessage("ORIGINAL-RUN")]);
        const args = {
          tasks: [{ prompt: "once per session", tools: ["read"] }],
          async: true,
          operationId: "op-restart",
        } as const;
        const dispatched = await callDelegate(first, args);
        const originalTicket = ticketIdOf(dispatched.text);
        const waited = await callDelegateTicket(first, {
          action: "wait",
          ticket: originalTicket,
          timeoutMs: 5000,
        });
        expect(waited.text).toContain("ORIGINAL-RUN");
        // The first instance stays alive: its temp cwd IS the shared agent
        // directory, and disposing it would remove the journal underneath
        // the next instance (same discipline as the recovery tests).

        // Same agent directory (the harness session cwd), new instance:
        // the saved journal knows the ticket, but operation identity is
        // host-lifetime only.
        const next = await openDelegateBoundary();
        sessions.push(next);
        (next.session as AgentSession).sessionManager.getSessionDir = () =>
          join(first.cwd, "sessions", "--test--");
        const nextModel = await installSubagentModel(next);
        nextModel.respond([fauxAssistantMessage("RERUN-AFTER-RESTART")]);

        const redispatched = await callDelegate(next, args);
        const newTicket = ticketIdOf(redispatched.text);
        expect(newTicket).not.toBe(originalTicket);
        expect(nextModel.state.callCount).toBe(1);

        const settled = await callDelegateTicket(next, {
          action: "wait",
          ticket: newTicket,
          timeoutMs: 5000,
        });
        expect(settled.text).toContain("RERUN-AFTER-RESTART");
        // The old ticket stays pollable from the saved journal — the rerun
        // replaced nothing.
        const oldPolled = await callDelegateTicket(next, {
          action: "poll",
          ticket: originalTicket,
        });
        expect(oldPolled.text).toContain("ORIGINAL-RUN");
      } finally {
        for (const s of sessions.splice(0)) s.dispose();
      }
    },
  );
});

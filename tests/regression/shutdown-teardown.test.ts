/**
 * Session teardown hardening regressions (C2, under #138): the shutdown
 * sequence is a cascade of independent attempts — one throwing step is
 * logged by name and every later step still runs — and the quiescence
 * barrier names what it waits on and fires its budget-expiry signals
 * without hanging the host.
 *
 * The scoped budget timer (unref'd, cleared when the race resolves) is
 * review-verified: a test cannot observe a cleared timer through the
 * public boundary and is deliberately not attempted.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  callDelegateTicket,
  delegateTool,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";
import { diagnosticRecords } from "../support/diagnostic-records.ts";

let session: TestSession | undefined;

afterEach(() => {
  session?.dispose();
  session = undefined;
});

/** Keep the deliberately red shutdown checks quick, without changing defaults. */
function withShortShutdownBudget(): () => void {
  const previous = process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS;
  process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS = "300";
  return () => {
    if (previous === undefined) delete process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS;
    else process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS = previous;
  };
}

/** Fail a wedged teardown instead of hanging the file. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("shutdown teardown test barrier timed out")), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

function gatedWorker(): {
  readonly gated: FauxResponseFactory;
  readonly release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const gated: FauxResponseFactory = async () => {
    await gate;
    return fauxAssistantMessage("TOO-LATE");
  };
  return { gated, release };
}

type NotifyCall = readonly [string, ("error" | "info" | "warning")?];

interface ShutdownObservation {
  readonly records: ReturnType<typeof diagnosticRecords>;
  readonly notifies: readonly NotifyCall[];
}

/** Emit session_shutdown, collecting stderr diagnostics and UI notifies. */
async function emitShutdown(session: TestSession): Promise<ShutdownObservation> {
  const host = session.session as AgentSession;
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const warns = spyOn(console, "warn").mockImplementation(() => {});
  const notify = spyOn(host.extensionRunner.createContext().ui, "notify");
  try {
    await bounded(host.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    }));
    return {
      records: diagnosticRecords([...errors.mock.calls, ...warns.mock.calls]),
      notifies: notify.mock.calls,
    };
  } finally {
    notify.mockRestore();
    warns.mockRestore();
    errors.mockRestore();
  }
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

test(
  "a throwing teardown step is logged by name and the sequence still reaches the barrier, the drain, and the latch",
  async () => {
    const restoreBudget = withShortShutdownBudget();
    try {
      await throwingStepTeardownContinues();
    } finally {
      restoreBudget();
    }
  },
);

async function throwingStepTeardownContinues(): Promise<void> {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { gated, release } = gatedWorker();

    // Prime the pool: a sessionId task only enters the pool's entries at
    // settle, so the checked-out entry the pool-shutdown step aborts has
    // to come from a second task reusing the resident session.
    subagents.respond([fauxAssistantMessage("POOLED")]);
    const primed = await callDelegate(session, {
      tasks: [{ prompt: "prime the pool", sessionId: "held" }],
      async: true,
    });
    expect(primed.isError).toBe(false);
    await callDelegateTicket(session, {
      action: "wait",
      ticket: ticketIdOf(primed.text),
    });
    subagents.respond([gated]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "hold the pooled session", sessionId: "held" }],
      async: true,
    });
    expect(dispatched.isError).toBe(false);
    const ticket = ticketIdOf(dispatched.text);
    const deadline = Date.now() + 5000;
    while (subagents.state.callCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(2);

    // Two independent sabotages. The journal stops accepting writes so the
    // cancel step's settle save fails; the host abort throws synchronously
    // so the session-pool step fails for real — an unguarded sequence
    // would skip the barrier and telemetry close behind it.
    const ticketsDir = join(session.cwd, "delegate-tickets");
    chmodSync(ticketsDir, 0o500);
    const abortFault = "SHUTDOWN-ABORT-FAULT";
    const abort = spyOn(AgentSession.prototype, "abort").mockImplementation(
      () => {
        throw new Error(abortFault);
      },
    );
    let observed: ShutdownObservation | undefined;
    try {
      observed = await emitShutdown(session);
    } finally {
      abort.mockRestore();
      chmodSync(ticketsDir, 0o700);
      release();
    }
    const { records, notifies } = observed;
    const notifyTexts = notifies.map(([text]) => text);

    // The journal save failure inside the cancel step surfaced as a
    // record rather than aborting the sequence.
    expect(
      records.some(
        (record) =>
          record.event === "ticket recovery save failed" &&
          record.context.ticketId === ticket,
      ),
    ).toBe(true);
    // The thrown pool-shutdown step named itself — and teardown continued:
    // the barrier still ran and still reported its budget expiry.
    expect(
      records.some(
        (record) =>
          record.event ===
          "shutdown step 'session pool shutdown' failed; continuing teardown",
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.event ===
          "shutdown waiting for dispatches to reach quiescence",
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.event ===
          "shutdown quiescence budget expired; workers may still be mutating",
      ),
    ).toBe(true);
    expect(notifyTexts.some((text) => /waiting for 1 dispatch\(es\) to stop/.test(text))).toBe(true);
    expect(notifyTexts.some((text) => /still stopping/.test(text))).toBe(true);

    // The latch landed first: a post-shutdown dispatch rejects outright.
    const tool = delegateTool(session) as unknown as DirectDelegate;
    const host = session.session as AgentSession;
    let rejection: unknown;
    try {
      await tool.execute(
        "post-shutdown-dispatch",
        { async: false, tasks: [{ prompt: "too late" }] },
        new AbortController().signal,
        () => {},
        host.extensionRunner.createContext(),
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/shutting down/);
}

test(
  "the quiescence barrier names the wedged dispatch and fires its budget-expiry signals without hanging",
  async () => {
    const restoreBudget = withShortShutdownBudget();
    try {
      await barrierNamesWedgedDispatch();
    } finally {
      restoreBudget();
    }
  },
);

async function barrierNamesWedgedDispatch(): Promise<void> {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { gated, release } = gatedWorker();
    subagents.respond([gated]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "ignore the abort" }],
      async: true,
    });
    expect(dispatched.isError).toBe(false);
    const ticket = ticketIdOf(dispatched.text);
    const deadline = Date.now() + 5000;
    while (subagents.state.callCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(1);

    // The abort-ignoring worker never confirms quiescence: the awaited
    // emit resolves on the 300ms budget, not on the worker.
    let observed: ShutdownObservation | undefined;
    try {
      observed = await emitShutdown(session);
    } finally {
      release();
    }
    const { records, notifies } = observed;

    expect(
      records.some(
        (record) =>
          record.event ===
          "shutdown waiting for dispatches to reach quiescence" &&
          record.context.count === 1,
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.event ===
          "shutdown quiescence budget expired; workers may still be mutating",
      ),
    ).toBe(true);
    // The pending dispatch is named by its durable ticket label in both
    // the waiting and the expiry notices.
    expect(notifies).toContainEqual([
      `Delegate: waiting for 1 dispatch(es) to stop before shutdown (ticket "${ticket}")…`,
      "info",
    ]);
    expect(notifies).toContainEqual([
      `Delegate: exiting with 1 dispatch(es) still stopping (ticket "${ticket}"); they may still be mutating.`,
      "warning",
    ]);
}

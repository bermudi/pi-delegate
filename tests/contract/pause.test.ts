import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateTicket,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

// Provenance (TEST-MIGRATION): migrates the surviving core of v1's
// pause.test.ts that #46's fresh-context review (M1/m1/m3) found missing —
// domain rejections as results, the pausing/paused display distinction the
// v3 merge collapsed, machine-readable parked state, and resume continuing
// the same live session. Park mechanics themselves (watchdog suspension,
// silent-turn stalling) already live in tests/regression/cancellation.test.ts.

let session: TestSession | undefined;

afterEach(() => {
  session?.dispose();
  session = undefined;
});

async function parkedTicketFixture(): Promise<{
  ticket: string;
  release: () => void;
  marker: string;
  subagents: ReturnType<typeof installSubagentModel> extends Promise<infer T>
    ? T
    : never;
}> {
  // Determinism: pause lands while turn one's provider call is still
  // gated, so the ticket is provably pausing mid-turn; the marker file
  // proves the in-flight turn's tool call ran to completion before the
  // between-turns park was reached.
  session = await openDelegateBoundary();
  const subagents = await installSubagentModel(session);
  configureDelegate(session, { stallTimeoutMs: 60_000 });

  const marker = join(session.cwd, "parked");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const turnOne: FauxResponseFactory = async () => {
    await gate;
    return fauxAssistantMessage([
      fauxToolCall("bash", { command: `printf parked > "${marker}"` }),
    ]);
  };
  subagents.respond([turnOne, fauxAssistantMessage("RESUMED-DONE")]);

  const dispatched = await callDelegate(session, {
    tasks: [{ prompt: "park me", tools: ["bash"] }],
    async: true,
  });
  const ticket = ticketIdOf(dispatched.text);
  return { ticket, release, marker, subagents };
}

describe("delegate_ticket pause/resume", () => {
  test("pause/resume on a settled ticket return error results, never throws", async () => {
    // #46 m1: domain rejections ride the store convention — returned
    // results with isError, like `answer` — not throws rendered as errors.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SETTLED")]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "finish first" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.isError).toBe(false);

    const paused = await callDelegateTicket(session, {
      action: "pause",
      ticket,
    });
    expect(paused.isError).toBe(true);
    expect(paused.text).toMatch(/already .*; it cannot be paused/);

    const resumed = await callDelegateTicket(session, {
      action: "resume",
      ticket,
    });
    expect(resumed.isError).toBe(true);
    expect(resumed.text).toMatch(/already .*; it cannot be resumed/);
  });

  test("resume on a running, non-paused ticket reports already-running", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("GATED");
    };
    subagents.respond([gated, fauxAssistantMessage("AFTER")]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "keep running" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const resumed = await callDelegateTicket(session, {
      action: "resume",
      ticket,
    });
    expect(resumed.isError).toBe(false);
    expect(resumed.text).toMatch(/already running/);
    release();
    await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
  });

  test("pausing mid-turn: finish current turn → paused between turns → same session resumes", async () => {
    // The M1 distinction: a requested-but-still-streaming task shows
    // "pausing — finishing current turn"; only a genuinely parked task
    // shows "paused between turns" and reports tail taskState "paused".
    // callCount === 2 after settle proves resume continued the same live
    // session — a respawn or replay would re-request turn one.
    const { ticket, release, marker, subagents } = await parkedTicketFixture();

    const requested = await callDelegateTicket(session!, {
      action: "pause",
      ticket,
    });
    expect(requested.isError).toBe(false);

    // Turn one is still gated: the request is visible, the task has not
    // parked, so the line must say pausing — not paused.
    const pausing = await callDelegateTicket(session!, {
      action: "poll",
      ticket,
    });
    expect(pausing.text).toMatch(/pausing — finishing current turn/);
    expect(pausing.text).not.toMatch(/paused between turns/);

    release();
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(existsSync(marker)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));

    // Parked: the label flips, and the machine-readable tail agrees.
    const parkedPoll = await callDelegateTicket(session!, {
      action: "poll",
      ticket,
    });
    expect(parkedPoll.text).toMatch(/paused between turns/);

    const tail = await callDelegateTicket(session!, {
      action: "tail",
      ticket,
      taskId: "task-1",
      offset: 0,
    });
    const details = tail.details as
      | { tail?: { taskState?: string } }
      | undefined;
    expect(details?.tail?.taskState).toBe("paused");

    const resumed = await callDelegateTicket(session!, {
      action: "resume",
      ticket,
    });
    expect(resumed.isError).toBe(false);

    const settled = await callDelegateTicket(session!, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.isError).toBe(false);
    expect(settled.text).toContain("RESUMED-DONE");
    expect(settled.text).not.toContain("GATED");
    expect(subagents.state.callCount).toBe(2);
  });
});

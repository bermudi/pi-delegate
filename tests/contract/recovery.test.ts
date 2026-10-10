import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { callDelegate, installSubagentModel, openDelegateBoundary, ticketIdOf,
  callDelegateSession,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

describe("saved async ticket results (new v2 restart contract, issue #26)", () => {
  const sessions: TestSession[] = [];
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });

  async function openAt(agentDir?: string): Promise<TestSession> {
    const session = await openDelegateBoundary();
    sessions.push(session);
    if (agentDir) {
      (session.session as AgentSession).sessionManager.getSessionDir =
        () => join(agentDir, "sessions", "--test--");
    }
    return session;
  }

  /**
   * A second boundary in the SAME process shares the recorded owner's pid
   * and boot id — issue #54's liveness check correctly keeps a live-owner
   * `running` ticket untouched, so modeling a cold start means the
   * journal's owner must die first: rewrite its pid to a process that
   * existed and already exited.
   */
  async function orphanTicket(agentDir: string, ticket: string): Promise<void> {
    const gone = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    const path = join(agentDir, "delegate-tickets", `${ticket}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      owner?: { pid: number; bootId?: string; sessionId?: string };
    };
    if (saved.owner === undefined) {
      throw new Error(`ticket ${ticket}'s journal row carries no owner to orphan`);
    }
    saved.owner = { ...saved.owner, pid: gone.pid };
    writeFileSync(path, JSON.stringify(saved));
  }

  test("a new instance can poll and wait on a settled result without replay or delivery", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    provider.respond([fauxAssistantMessage("SAVED-OUTPUT")]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "provide a report" }], async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegateTicket(first, { action: "wait", ticket });

    const next = await openAt(first.cwd);
    const polled = await callDelegateTicket(next, { action: "poll", ticket });
    expect(polled.isError).toBe(false);
    expect(polled.text).toContain("completed");
    expect(polled.text).toContain("SAVED-OUTPUT");
    expect((await callDelegateTicket(next, { action: "wait", ticket })).text)
      .toContain("SAVED-OUTPUT");
    // #64: the record belongs to the dispatching session — the bare roster
    // hides it behind the count line; explicit-id poll above still reads it.
    const roster = await callDelegateTicket(next, { action: "poll" });
    expect(roster.text).not.toContain(ticket);
    expect(roster.text).toContain("(1 ticket(s) from other sessions not shown");
    expect((await callDelegateTicket(next, { action: "resume", ticket })).isError).toBe(true);
    expect((await callDelegateTicket(next, { action: "answer", ticket, taskId: "task-1", questionId: "q-1", answer: "x" })).isError).toBe(true);
    const disk = statSync(join(first.cwd, "delegate-tickets", `${ticket}.json`));
    expect(disk.mode & 0o077).toBe(0);
    expect(statSync(join(first.cwd, "delegate-tickets")).mode & 0o077).toBe(0);
  });

  test("historical saved deadline failures remain readable without restarting work (#118)", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    provider.respond([fauxAssistantMessage("HISTORICAL-PARTIAL-OUTPUT")]);
    const ticket = ticketIdOf((await callDelegate(first, {
      tasks: [{ prompt: "report" }], async: true,
    })).text);
    await callDelegateTicket(first, { action: "wait", ticket });
    const path = join(first.cwd, "delegate-tickets", `${ticket}.json`);
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(saved) || !Array.isArray(saved.outcomes)) {
      throw new Error("saved ticket must be a record with an outcomes array");
    }
    const outcome: unknown = saved.outcomes[0];
    if (!isRecord(outcome)) {
      throw new Error("saved ticket must contain a first outcome record");
    }
    saved.status = "failed";
    outcome.status = "failed";
    outcome.error = "deadline exceeded after 250ms";
    writeFileSync(path, JSON.stringify(saved));

    const next = await openAt(first.cwd);
    const nextProvider = await installSubagentModel(next);
    for (const action of ["poll", "wait"] as const) {
      const view = await callDelegateTicket(next, { action, ticket });
      expect(view.text).toContain("deadline exceeded after 250ms");
      expect(view.text).toContain("HISTORICAL-PARTIAL-OUTPUT");
    }
    expect(nextProvider.state.callCount).toBe(0);
  });

  test("unfinished work reappears interrupted, never restarted by poll", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const blocked: FauxResponseFactory = async () => {
      started();
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    };
    provider.respond([fauxAssistantMessage("COMPLETED-FIRST"), blocked]);
    try {
      const dispatched = await callDelegate(first, {
        // #126 vehicle: dependsOn keeps the pinned split deterministic —
        // first must be recorded completed before later is in flight.
        tasks: [
          { id: "first", prompt: "completed task" },
          { id: "later", prompt: "long task", dependsOn: ["first"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await entered;
      // A fresh extension reading the on-disk snapshot models a cold start.
      // It cannot adopt the old instance's live worker — and with #54's
      // owner liveness, the recorded owner must be dead for the snapshot
      // to settle interrupted at all.
      await orphanTicket(first.cwd, ticket);
      const next = await openAt(first.cwd);
      const poll = await callDelegateTicket(next, { action: "poll", ticket });
      expect(poll.text).toContain("interrupted");
      expect(poll.text).toContain("COMPLETED-FIRST");
      expect(poll.text).not.toContain("LATE-OUTPUT");
      expect(poll.text).toMatch(/unknown|may have changed/i);
      const again = await callDelegateTicket(next, { action: "wait", ticket });
      expect(again.text).toContain("interrupted");
      const cancel = await callDelegateTicket(next, { action: "cancel", ticket, force: true });
      expect(cancel.isError).toBe(true);
      expect(cancel.text).toMatch(/recovered interrupted/i);
    } finally {
      release?.();
    }
  });

  test("steering a cold-recovered ticket receipts not-applied — recovery never resumes", async () => {
    // SPEC v3 "Steering": a recovered ticket is terminal evidence; steer
    // answers a not-applied receipt rather than reviving dead work.
    const first = await openAt();
    const provider = await installSubagentModel(first);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    provider.respond([async () => {
      started();
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    }]);
    try {
      const dispatched = await callDelegate(first, {
        tasks: [{ prompt: "long task" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await entered;

      await orphanTicket(first.cwd, ticket);
      const next = await openAt(first.cwd);
      const steered = await callDelegateTicket(next, {
        action: "steer",
        ticket,
        message: "wake up",
      });
      expect(steered.isError).toBe(false);
      expect(steered.text).toContain("not-applied");
      expect(steered.text).toMatch(/recovered|interrupted/);
      const steer = (steered.details as { steer?: { status?: string } }).steer;
      expect(steer?.status).toBe("not-applied");
    } finally {
      release?.();
    }
  });

  test("insecure or malformed storage fails visibly before workers start", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    provider.respond([fauxAssistantMessage("SHOULD-NOT-RUN")]);
    const dir = join(first.cwd, "delegate-tickets");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o755);
    try {
      expect((await callDelegateSession(first, { action: "list" })).isError).toBe(false);
      const sync = await callDelegate(first, { async: false, tasks: [{ prompt: "sync works" }] });
      expect(sync.isError).toBe(false);
      expect(sync.text).toContain("SHOULD-NOT-RUN");
      expect(provider.state.callCount).toBe(1);
      const denied = await callDelegate(first, { tasks: [{ prompt: "do not start" }], async: true });
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/owner-only|ticket/i);
      expect(provider.state.callCount).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
    }
    writeFileSync(join(dir, "t-00000000-0000-4000-8000-000000000000.json"), "{}", { mode: 0o600 });
    const next = await openAt(first.cwd);
    const nextModel = await installSubagentModel(next);
    nextModel.respond([fauxAssistantMessage("SYNC-AFTER-CORRUPTION")]);
    expect((await callDelegateSession(next, { action: "list" })).isError).toBe(false);
    const sync = await callDelegate(next, { async: false, tasks: [{ prompt: "sync despite corrupt journal" }] });
    expect(sync.isError).toBe(false);
    expect(sync.text).toContain("SYNC-AFTER-CORRUPTION");
    const corrupt = await callDelegateTicket(next, { action: "poll" });
    expect(corrupt.isError).toBe(true);
    expect(corrupt.text).toMatch(/recover ticket|invalid or unsupported/i);
    const asyncCall = await callDelegate(next, { tasks: [{ prompt: "do not run" }], async: true });
    expect(asyncCall.isError).toBe(true);
    expect(nextModel.state.callCount).toBe(1);
  });

  test("cold terminal cancellation with missing outcomes warns of unknown effects", async () => {
    const first = await openAt();
    const model = await installSubagentModel(first);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    const gate = new Promise<void>((r) => { release = r; });
    model.respond([async () => {
      started();
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    }]);
    try {
      const dispatched = await callDelegate(first, {
        tasks: [{ prompt: "possibly change files" }], async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await entered;
      const cancelled = await callDelegateTicket(first, { action: "cancel", ticket, force: true });
      expect(cancelled.isError).toBe(false);
      // Model a crash after the terminal status was saved but before the
      // provisional outcome: the live coordinator can race to record it.
      const path = join(first.cwd, "delegate-tickets", `${ticket}.json`);
      const saved = JSON.parse(readFileSync(path, "utf8")) as { status: string; outcomes: unknown[] };
      expect(saved.status).toBe("cancelled");
      saved.outcomes[0] = null;
      writeFileSync(path, JSON.stringify(saved));
      const next = await openAt(first.cwd);
      const polled = await callDelegateTicket(next, { action: "poll", ticket });
      expect(polled.text).toContain(`Ticket "${ticket}": cancelled`);
      expect(polled.text).toMatch(/effects are unknown|may have changed/i);
      expect((await callDelegateTicket(next, { action: "wait", ticket })).text)
        .toMatch(/effects are unknown|may have changed/i);
      // #64: the bare roster scopes to this session — the record hides
      // behind the count line while its warning stays on the explicit
      // poll and wait above.
      expect((await callDelegateTicket(next, { action: "poll" })).text)
        .toContain("(1 ticket(s) from other sessions not shown");
    } finally {
      release?.();
    }
  });

  test("a recovered failed task names its transcript; a header-only one is not advertised as resumable", async () => {
    // v1 evidence: v1's failure output carried `session: <path>` and a
    // `→ To retry:` resume hint, but header-only transcripts — flushed so
    // the planned path was real — were never offered as resume targets
    // (an empty conversation would pretend continuity). The saved
    // outcome's sessionFile renders the same live or cold; this exercises
    // the cold poll both ways through the public boundary.
    const first = await openAt();
    const model = await installSubagentModel(first);
    model.respond([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider blew up",
      }),
    ]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "fail in the background" }], async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const settled = await callDelegateTicket(first, { action: "wait", ticket });
    const sessionLine = /^session: (\S+\.jsonl)$/m.exec(settled.text)?.[1];
    expect(sessionLine).toBeDefined();
    expect(settled.text).toContain("→ To retry:");

    // Cold reader: the saved outcome renders the same session path and
    // retry hint — the transcript has real messages, so it IS resumable.
    const next = await openAt(first.cwd);
    const polled = await callDelegateTicket(next, { action: "poll", ticket });
    expect(polled.text).toContain(`session: ${sessionLine}`);
    expect(polled.text).toContain("→ To retry:");

    // Rewrite the outcome's sessionFile to a header-only transcript —
    // the on-disk shape a never-prompted failure leaves (header flushed,
    // no message entries). The poll must not advertise it as resumable.
    const headerOnly = join(first.cwd, "sess_headeronly1234.jsonl");
    writeFileSync(
      headerOnly,
      JSON.stringify({
        type: "session", version: 3, id: "header-only",
        timestamp: new Date().toISOString(), cwd: first.cwd,
      }) + "\n",
    );
    const path = join(first.cwd, "delegate-tickets", `${ticket}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      outcomes: ({ sessionFile?: string } | null)[];
    };
    saved.outcomes[0] = { ...saved.outcomes[0]!, sessionFile: headerOnly };
    writeFileSync(path, JSON.stringify(saved));

    const cold = await openAt(first.cwd);
    const headerPoll = await callDelegateTicket(cold, { action: "poll", ticket });
    expect(headerPoll.text).toContain(`session: ${headerOnly}`);
    expect(headerPoll.text).toContain("no prior messages");
    expect(headerPoll.text).not.toContain("→ To retry:");
  });

  test("a fully recorded quarantined cancellation warns on the recovered view", async () => {
    const first = await openAt();
    const model = await installSubagentModel(first);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    const gate = new Promise<void>((r) => { release = r; });
    model.respond([async () => {
      started();
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    }]);
    try {
      const dispatched = await callDelegate(first, {
        tasks: [{ prompt: "possibly change files" }], async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await entered;
      await callDelegateTicket(first, { action: "cancel", ticket, force: true });
      // The caller-visible provisional outcome is saved before the worker
      // necessarily stops. Read the snapshot through a cold public boundary.
      const path = join(first.cwd, "delegate-tickets", `${ticket}.json`);
      let saved: { outcomes: ({ quarantined?: boolean } | null)[] } | undefined;
      for (let i = 0; i < 100; i++) {
        saved = JSON.parse(readFileSync(path, "utf8"));
        if (saved?.outcomes[0]?.quarantined) break;
        await Bun.sleep(10);
      }
      expect(saved?.outcomes[0]?.quarantined).toBe(true);
      const next = await openAt(first.cwd);
      // #64: the warning lives on the explicit view — the bare roster
      // scopes to this session and hides the record behind the count line.
      const polled = await callDelegateTicket(next, { action: "poll", ticket });
      expect(polled.text).toMatch(/termination was unconfirmed|may still have changed/i);
      expect(polled.text).toMatch(/inspect the workspace before new writes/i);
      expect((await callDelegateTicket(next, { action: "poll" })).text)
        .toContain("(1 ticket(s) from other sessions not shown");
    } finally {
      release?.();
    }
  });

  test("a save failure after launch is disclosed; a cold reader never invents completion", async () => {
    const first = await openAt();
    const model = await installSubagentModel(first);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    model.respond([async () => { await gate; return fauxAssistantMessage("LIVE-ONLY-OUTPUT"); }]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "finish after the disk stops accepting writes" }], async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const dir = join(first.cwd, "delegate-tickets");
    chmodSync(dir, 0o500);
    try {
      release();
      const live = await callDelegateTicket(first, { action: "wait", ticket });
      expect(live.text).toContain("LIVE-ONLY-OUTPUT");
      expect(live.text).toMatch(/recovery save failed/i);
    } finally {
      chmodSync(dir, 0o700);
    }
    // The journal still shows the creation write (status running, live
    // owner): the cold reader must see the owner die before it interrupts.
    await orphanTicket(first.cwd, ticket);
    const next = await openAt(first.cwd);
    const recovered = await callDelegateTicket(next, { action: "poll", ticket });
    expect(recovered.text).toContain("interrupted");
    expect(recovered.text).not.toContain("LIVE-ONLY-OUTPUT");
  });

  test("orderly shutdown saves cancellation rather than an interrupted snapshot", async () => {
    const first = await openAt();
    const model = await installSubagentModel(first);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    model.respond([async () => { await gate; return fauxAssistantMessage("TOO-LATE"); }]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "cancel on shutdown" }], async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      const shutdown = (first.session as AgentSession).extensionRunner.emit({
        type: "session_shutdown", reason: "quit",
      });
      release();
      await shutdown;
      const next = await openAt(first.cwd);
      const poll = await callDelegateTicket(next, { action: "poll", ticket });
      expect(poll.text).toContain(`Ticket "${ticket}": cancelled`);
      expect(poll.text).not.toContain(`Ticket "${ticket}": interrupted`);
    } finally {
      release?.();
    }
  });
});

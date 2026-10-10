import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
  type SubagentModel,
} from "../support/pi-boundary.ts";

/**
 * Issue #54 — owner-liveness startup recovery. Dispatch journals the
 * owning host {pid, bootId, sessionId}; a later startup scans `running`
 * records and settles them `interrupted` — "owning session ended before
 * settlement" — exactly once and journal-durable, but only when that
 * owner is provably dead (different boot id, or a dead pid). Live-owner,
 * ownerless, and already-settled records stay untouched; recovery never
 * restarts work.
 */
describe("owner-liveness startup recovery (issue #54)", () => {
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

  interface SavedRow {
    status: string;
    owner?: { pid: number; bootId?: string; sessionId?: string };
    outcomes: ({ status?: string; error?: string } | null)[];
    notices: string[];
  }

  function journalPath(agentDir: string, ticket: string): string {
    return join(agentDir, "delegate-tickets", `${ticket}.json`);
  }
  function journalOf(agentDir: string, ticket: string): SavedRow {
    return JSON.parse(readFileSync(journalPath(agentDir, ticket), "utf8")) as SavedRow;
  }
  function rewriteJournal(agentDir: string, ticket: string, edit: (row: SavedRow) => void): void {
    const row = journalOf(agentDir, ticket);
    edit(row);
    writeFileSync(journalPath(agentDir, ticket), JSON.stringify(row));
  }

  /** A pid that existed and already exited — safely dead for kill(pid, 0). */
  async function deadPid(): Promise<number> {
    const gone = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    return gone.pid;
  }

  /**
   * Dispatch one async task that stays `running` until the returned gate
   * releases. The caller must release it so the owning worker can drain.
   */
  async function dispatchRunning(
    session: TestSession,
    provider: SubagentModel,
    cwd?: string,
  ): Promise<{ ticket: string; release: () => void }> {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    provider.respond([async () => {
      started();
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    }]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "long task", ...(cwd !== undefined ? { cwd } : {}) }],
      async: true,
    });
    expect(dispatched.isError).toBe(false);
    await entered;
    return { ticket: ticketIdOf(dispatched.text), release };
  }

  test("dispatch journals the owner; a dead owner interrupts once and durably", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    const { ticket, release } = await dispatchRunning(first, provider);
    try {
      // The owner identity lands on the journal row at dispatch.
      const saved = journalOf(first.cwd, ticket);
      expect(saved.status).toBe("running");
      expect(saved.owner?.pid).toBe(process.pid);
      expect(typeof saved.owner?.sessionId).toBe("string");
      expect(saved.owner?.sessionId).not.toBe("");

      // The owning process dies; a fresh boundary's startup scan settles
      // the ticket interrupted before any view can report otherwise.
      const dead = await deadPid();
      rewriteJournal(first.cwd, ticket, (row) => {
        row.owner = { ...row.owner!, pid: dead };
      });
      const next = await openAt(first.cwd);
      const poll = await callDelegateTicket(next, { action: "poll", ticket });
      expect(poll.isError).toBe(false);
      expect(poll.text).toContain("interrupted");
      expect(poll.text).toContain("owning session ended before settlement");
      const settled = journalOf(first.cwd, ticket);
      expect(settled.status).toBe("interrupted");
      expect(settled.outcomes[0]?.status).toBe("interrupted");
      expect(settled.outcomes[0]?.error).toBe("owning session ended before settlement");
      expect(
        settled.notices.filter((n) => n.includes("owning session ended before settlement")),
      ).toHaveLength(1);

      // Exactly once: a second startup sees the settled state machine and
      // rewrites nothing — the journal row is byte-identical.
      const third = await openAt(first.cwd);
      const repoll = await callDelegateTicket(third, { action: "poll", ticket });
      expect(repoll.text).toContain("interrupted");
      expect(journalOf(first.cwd, ticket)).toEqual(settled);
    } finally {
      release();
    }
  });

  test("a live owner's running ticket is left untouched", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    const { ticket, release } = await dispatchRunning(first, provider);
    try {
      // No patch: the recorded pid IS this process — a live sibling's
      // ticket is sacred even though this boundary cannot reach its
      // workers.
      const next = await openAt(first.cwd);
      const poll = await callDelegateTicket(next, { action: "poll", ticket });
      expect(poll.isError).toBe(false);
      expect(poll.text).toContain("running");
      expect(poll.text).not.toContain("interrupted");
      expect(poll.text).not.toContain("owning session ended before settlement");
      expect(journalOf(first.cwd, ticket).status).toBe("running");
    } finally {
      release();
    }
  });

  test("a live owner's running ticket is read-only for the recovering host", async () => {
    // The recovering boundary sees the sibling's ticket as recovered
    // `running`: wait never parks (no activity can arrive here), cancel
    // refuses rather than overwriting the sibling's journal row, steer and
    // interrupt receipt not-applied, and this host's shutdown skips it.
    const first = await openAt();
    const provider = await installSubagentModel(first);
    const { ticket, release } = await dispatchRunning(first, provider);
    try {
      const next = await openAt(first.cwd);
      const before = journalOf(first.cwd, ticket);
      expect(before.status).toBe("running");

      const waited = await callDelegateTicket(next, {
        action: "wait",
        ticket,
      });
      expect(waited.isError).toBe(false);
      expect(waited.text).toContain("running");
      expect(waited.text).not.toContain("timed out");

      const cancel = await callDelegateTicket(next, {
        action: "cancel",
        ticket,
        force: true,
      });
      expect(cancel.isError).toBe(true);
      expect(cancel.text).toMatch(/recovered/i);
      expect(journalOf(first.cwd, ticket)).toEqual(before);
      const stillRunning = await callDelegateTicket(next, {
        action: "poll",
        ticket,
      });
      expect(stillRunning.text).toContain("running");

      const steered = await callDelegateTicket(next, {
        action: "steer",
        ticket,
        message: "wake up",
        steerId: "s-sibling",
      });
      expect(steered.text).toContain("not-applied");
      expect(
        (steered.details as { steer?: { status?: string } }).steer?.status,
      ).toBe("not-applied");
      const interrupted = await callDelegateTicket(next, {
        action: "interrupt",
        ticket,
      });
      expect(interrupted.text).toContain("not-applied");

      // Shutdown must not stamp over the sibling's journal entry.
      await (next.session as AgentSession).extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      expect(journalOf(first.cwd, ticket)).toEqual(before);
    } finally {
      release();
    }
  });

  test("a cross-boot owner counts as dead even while its pid lives", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    const { ticket, release } = await dispatchRunning(first, provider);
    try {
      // Keep the recorded live pid but stamp a boot id that cannot be this
      // machine's — the mismatch alone proves the owner is gone.
      rewriteJournal(first.cwd, ticket, (row) => {
        row.owner = { ...row.owner!, bootId: "00000000-0000-4000-8000-000000000000" };
      });
      const next = await openAt(first.cwd);
      const poll = await callDelegateTicket(next, { action: "poll", ticket });
      expect(poll.text).toContain("interrupted");
      expect(poll.text).toContain("owning session ended before settlement");
      expect(journalOf(first.cwd, ticket).status).toBe("interrupted");
    } finally {
      release();
    }
  });

  test("a record without a boot id is judged on pid liveness alone", async () => {
    // The Windows fallback (#54): platforms without a boot id degrade to
    // pid evidence, never interrupting a possibly-live owner.
    const first = await openAt();
    const provider = await installSubagentModel(first);
    // Distinct cwds: two gated shared-cwd writers would trip the
    // admission conflict on the second dispatch.
    mkdirSync(join(first.cwd, "w-a"));
    mkdirSync(join(first.cwd, "w-b"));
    const live = await dispatchRunning(first, provider, join(first.cwd, "w-a"));
    const dead = await dispatchRunning(first, provider, join(first.cwd, "w-b"));
    try {
      rewriteJournal(first.cwd, live.ticket, (row) => {
        row.owner = { pid: process.pid, sessionId: row.owner?.sessionId };
      });
      const deadOwner = await deadPid();
      rewriteJournal(first.cwd, dead.ticket, (row) => {
        row.owner = { pid: deadOwner, sessionId: row.owner?.sessionId };
      });
      const next = await openAt(first.cwd);
      const untouched = await callDelegateTicket(next, { action: "poll", ticket: live.ticket });
      expect(untouched.text).toContain("running");
      expect(untouched.text).not.toContain("interrupted");
      const settled = await callDelegateTicket(next, { action: "poll", ticket: dead.ticket });
      expect(settled.text).toContain("interrupted");
      expect(settled.text).toContain("owning session ended before settlement");
    } finally {
      live.release();
      dead.release();
    }
  });

  test("settled records are never touched by owner liveness", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    provider.respond([fauxAssistantMessage("SETTLED-OUTPUT")]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "finish quickly" }], async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegateTicket(first, { action: "wait", ticket });

    // Even a dead owner must not reopen a settled record.
    const dead = await deadPid();
    rewriteJournal(first.cwd, ticket, (row) => {
      row.owner = { ...row.owner!, pid: dead };
    });
    const before = journalOf(first.cwd, ticket);
    const next = await openAt(first.cwd);
    const poll = await callDelegateTicket(next, { action: "poll", ticket });
    expect(poll.text).toContain("completed");
    expect(poll.text).toContain("SETTLED-OUTPUT");
    expect(poll.text).not.toContain("interrupted");
    expect(journalOf(first.cwd, ticket)).toEqual(before);
  });

  test("a record with no owner is left alone — no owner proof, no interruption", async () => {
    // Backward compatibility (#54): rows written before owner tracking
    // carry none, and a startup scan cannot prove their owner died.
    const first = await openAt();
    const provider = await installSubagentModel(first);
    const { ticket, release } = await dispatchRunning(first, provider);
    try {
      rewriteJournal(first.cwd, ticket, (row) => {
        delete row.owner;
      });
      const next = await openAt(first.cwd);
      const poll = await callDelegateTicket(next, { action: "poll", ticket });
      expect(poll.isError).toBe(false);
      expect(poll.text).toContain("running");
      expect(poll.text).not.toContain("interrupted");
      expect(journalOf(first.cwd, ticket).status).toBe("running");
    } finally {
      release();
    }
  });

  test("the bare roster lists only this session's tickets; explicit ids still reach others", async () => {
    // #64: a recovered record belongs to the Pi session that dispatched it —
    // the roster and unknown-ticket hints scope to the calling session's id,
    // while any ticket stays readable by explicit id.
    const first = await openAt();
    const provider = await installSubagentModel(first);
    // Distinct cwds: two gated shared writers would otherwise trip the
    // same-repo admission conflict on the second dispatch.
    mkdirSync(join(first.cwd, "w-a"));
    mkdirSync(join(first.cwd, "w-b"));
    const sibling = await dispatchRunning(first, provider, join(first.cwd, "w-a"));
    const ownerless = await dispatchRunning(first, provider, join(first.cwd, "w-b"));
    try {
      // A row whose owner carries no session id cannot be attributed to the
      // calling session either — it hides the same way.
      rewriteJournal(first.cwd, ownerless.ticket, (row) => {
        delete row.owner!.sessionId;
      });
      const next = await openAt(first.cwd);
      const nextProvider = await installSubagentModel(next);
      nextProvider.respond([fauxAssistantMessage("OWN-OUTPUT")]);
      const dispatched = await callDelegate(next, {
        tasks: [{ prompt: "own ticket" }],
        async: true,
      });
      const own = ticketIdOf(dispatched.text);
      const settled = await callDelegateTicket(next, {
        action: "wait",
        ticket: own,
      });
      expect(settled.isError).toBe(false);

      const roster = await callDelegateTicket(next, { action: "poll" });
      expect(roster.isError).toBe(false);
      expect(roster.text).toContain(own);
      expect(roster.text).not.toContain(sibling.ticket);
      expect(roster.text).not.toContain(ownerless.ticket);
      expect(roster.text).toContain(
        "(2 ticket(s) from other sessions not shown; poll one by id to read it.)",
      );

      // Explicit id still reaches a ticket this session does not own.
      const explicit = await callDelegateTicket(next, {
        action: "poll",
        ticket: sibling.ticket,
      });
      expect(explicit.isError).toBe(false);
      expect(explicit.text).toContain("running");

      // Unknown-ticket hints never suggest another session's ids.
      const unknown = await callDelegateTicket(next, {
        action: "poll",
        ticket: "nope-64",
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain(own);
      expect(unknown.text).not.toContain(sibling.ticket);
      expect(unknown.text).not.toContain(ownerless.ticket);
    } finally {
      sibling.release();
      ownerless.release();
    }
  });
});

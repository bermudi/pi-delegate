import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
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
 * Issue #123 — recovered interruptions name the durable transcript.
 * The journal records each worker's claimed `sessionFile`/
 * `transcriptStart` at claim time (before the first turn writes), so an
 * unclean restart's recovery copies them into the interrupted outcome:
 * the settled view renders the `session:` line and the resumeFrom retry
 * recipe, exactly like a live interrupt's hint. Records written before
 * #123 (no task-level pointer) render without them — byte-compat.
 */
describe("recovery resume hints (issue #123)", () => {
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
    tasks: ({ sessionFile?: string; transcriptStart?: number })[];
    outcomes: ({ status?: string; error?: string; sessionFile?: string } | null)[];
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
   * Dispatch one async task whose first turn completes (persisting the
   * transcript) and whose second turn stays in-flight until released.
   * The crash window under test is mid-second-turn: journal already
   * carries the claim, transcript already has content.
   */
  async function dispatchTwoTurn(
    session: TestSession,
    provider: SubagentModel,
  ): Promise<{ ticket: string; release: () => void; entered: Promise<void> }> {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    provider.respond([
      // Turn 1 must continue the agent loop — a tool call executes and
      // persists before turn 2's model call, giving the transcript
      // content ahead of the crash window.
      fauxAssistantMessage([
        fauxText("FIRST-TURN-DONE"),
        fauxToolCall("bash", { command: "echo turn-one-tool" }),
      ]),
      async () => {
        started();
        await gate;
        return fauxAssistantMessage("SECOND-TURN-NEVER-SEEN");
      },
    ]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "two-turn task" }],
      async: true,
    });
    expect(dispatched.isError).toBe(false);
    await entered;
    return { ticket: ticketIdOf(dispatched.text), release, entered };
  }

  test("the transcript claim is journaled before settlement — mid-run", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    const { ticket, release } = await dispatchTwoTurn(first, provider);
    try {
      // Mid-second-turn: no outcome exists, yet the claim is already on
      // disk — the crash window is worker start, not settlement.
      const saved = journalOf(first.cwd, ticket);
      expect(saved.status).toBe("running");
      expect(saved.outcomes[0]).toBeNull();
      const claimed = saved.tasks[0]?.sessionFile;
      expect(typeof claimed).toBe("string");
      expect(saved.tasks[0]?.transcriptStart).toBeGreaterThanOrEqual(0);
      // The claimed file exists and already carries the first turn.
      expect(claimed).toBeDefined();
      expect(existsSync(claimed!)).toBe(true);
      expect(readFileSync(claimed!, "utf8")).toContain("FIRST-TURN-DONE");
    } finally {
      release();
    }
  });

  test("recovery names the transcript: session line, resumeFrom recipe, journal round-trip", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    const { ticket, release } = await dispatchTwoTurn(first, provider);
    try {
      const claimed = journalOf(first.cwd, ticket).tasks[0]?.sessionFile;
      expect(typeof claimed).toBe("string");

      // The owning process dies; a fresh boundary settles the ticket
      // interrupted and the outcome carries the claimed pointer.
      const dead = await deadPid();
      rewriteJournal(first.cwd, ticket, (row) => {
        row.owner = { ...row.owner!, pid: dead };
      });
      const next = await openAt(first.cwd);
      const poll = await callDelegateTicket(next, { action: "poll", ticket });
      expect(poll.isError).toBe(false);
      expect(poll.text).toContain("interrupted");
      expect(poll.text).toContain("owning session ended before settlement");
      // The resume affordance: the session line and the retry recipe —
      // full surface renders the verbatim resumeFrom re-dispatch.
      expect(poll.text).toContain(`session: ${claimed}`);
      expect(poll.text).toContain("To retry: delegate({ tasks: [{ resumeFrom:");
      expect(poll.text).toContain(JSON.stringify(claimed!));

      // The interrupted outcome round-trips the pointer through the
      // journal — a third startup sees the same view.
      const settled = journalOf(first.cwd, ticket);
      expect(settled.outcomes[0]?.sessionFile).toBe(claimed);
      const third = await openAt(first.cwd);
      const repoll = await callDelegateTicket(third, { action: "poll", ticket });
      expect(repoll.text).toContain(`session: ${claimed}`);
    } finally {
      release();
    }
  });

  test("pre-#123 records without a task-level pointer never hint", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    const { ticket, release } = await dispatchTwoTurn(first, provider);
    try {
      // Simulate a record written before claim-time journaling: strip the
      // task pointer, kill the owner, recover.
      const dead = await deadPid();
      rewriteJournal(first.cwd, ticket, (row) => {
        row.owner = { ...row.owner!, pid: dead };
        delete row.tasks[0]!.sessionFile;
        delete row.tasks[0]!.transcriptStart;
      });
      const next = await openAt(first.cwd);
      const poll = await callDelegateTicket(next, { action: "poll", ticket });
      expect(poll.isError).toBe(false);
      expect(poll.text).toContain("interrupted");
      expect(poll.text).not.toContain("session: ");
      expect(poll.text).not.toContain("resumeFrom");
      expect(journalOf(first.cwd, ticket).outcomes[0]?.sessionFile).toBeUndefined();
    } finally {
      release();
    }
  });
});

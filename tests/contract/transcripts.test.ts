import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/** A minimal valid Pi session transcript usable as a `resumeFrom` target. */
function writeTranscript(dir: string, name: string): string {
  const file = join(dir, name);
  const now = new Date().toISOString();
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: name,
        timestamp: now,
        cwd: dir,
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: now,
        message: {
          role: "user",
          content: [{ type: "text", text: "PRIOR-INSTRUCTION" }],
          timestamp: Date.now(),
        },
      }),
    ].join("\n") + "\n",
  );
  return file;
}

/** Poll until true, bounded — keeps in-flight ordering assertions stable. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250 && !probe(); i++) await Bun.sleep(20);
  expect(probe(), `${what} (timed out waiting)`).toBeTrue();
}

describe("transcript exclusivity contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "two tasks resuming the same transcript in one call reject the whole call",
    async () => {
      // v1 evidence: task-resolution.test.ts "rejects a canonical alias of a
      // quarantined resumeFrom transcript" — one transcript, one owner at a
      // time. SPEC "Sessions, retries, and cancellation": a transcript in
      // use by a live worker rejects; two same-call resumes are concurrent
      // owners by definition.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const transcript = writeTranscript(session.cwd, "shared-prior.jsonl");

      const result = await callDelegate(session, {
        tasks: [
          { id: "a", prompt: "continue", tools: ["read"], resumeFrom: transcript },
          { id: "b", prompt: "continue too", tools: ["read"], resumeFrom: transcript },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("same transcript");
      expect(result.text).toContain("'a'");
      expect(result.text).toContain("'b'");
      // Rejected before any child started.
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a running worker's transcript rejects cross-call resume until it settles",
    async () => {
      // v1 evidence: session-quarantine.ts — v1 refused to resume a
      // transcript whose worker was still live, because the old worker
      // keeps mutating the file. The reservation is released when the
      // worker is confirmed quiescent, not at caller settlement.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const transcript = writeTranscript(session.cwd, "live-prior.jsonl");

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const gated: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("GATED-DONE");
      };
      subagents.respond([gated, fauxAssistantMessage("RESUMED-AFTER")]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "hold the transcript", tools: ["read"], resumeFrom: transcript }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount >= 1,
        "gated provider call in flight",
      );

      // While the worker is live, resuming its transcript rejects and
      // names the owning work — before any second child starts.
      const busy = await callDelegate(session, {
        tasks: [{ prompt: "resume mid-flight", tools: ["read"], resumeFrom: transcript }],
      });
      expect(busy.isError).toBe(true);
      expect(busy.text).toContain("still in use");
      expect(busy.text).toContain(ticket);
      expect(subagents.state.callCount).toBe(1);

      release();
      await callDelegateTicket(session, { action: "wait", ticket });

      // Settled and quiesced: the transcript is resumable again.
      const after = await callDelegate(session, {
        tasks: [{ prompt: "resume now", tools: ["read"], resumeFrom: transcript }],
      });
      expect(after.isError).toBe(false);
      expect(after.text).toContain("RESUMED-AFTER");
    },
  );

  test(
    "a symlink alias of a busy transcript rejects too (canonicalization)",
    async () => {
      // v1 evidence: task-resolution.test.ts — v1 rejected the quarantine
      // through canonical aliases, so a symlink must not smuggle a second
      // owner onto a live transcript.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const transcript = writeTranscript(session.cwd, "aliased-prior.jsonl");
      const alias = join(session.cwd, "alias-to-prior.jsonl");
      symlinkSync(transcript, alias);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const gated: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("ALIAS-GATED-DONE");
      };
      subagents.respond([gated]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "hold via the real path", tools: ["read"], resumeFrom: transcript }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount >= 1,
        "gated provider call in flight",
      );

      const busy = await callDelegate(session, {
        tasks: [{ prompt: "resume via alias", tools: ["read"], resumeFrom: alias }],
      });
      expect(busy.isError).toBe(true);
      // The rejection names the canonical (real) path, proving the alias
      // resolved to the busy transcript rather than passing as distinct.
      expect(busy.text).toContain(transcript);
      expect(subagents.state.callCount).toBe(1);

      release();
      await callDelegateTicket(session, { action: "wait", ticket });
    },
  );

  test(
    "a pooled session's transcript file rejects resumeFrom while checked out",
    async () => {
      // The pooled half of transcript exclusivity: a live pooled run owns
      // its durable session file, so a resumeFrom pointing at that file
      // must reject until the run settles — discovered at admission via
      // the pool (and at execution via holdTranscript on first runs).
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      let releasePoolGate!: () => void;
      const poolGate = new Promise<void>((resolve) => (releasePoolGate = resolve));
      const gated: FauxResponseFactory = async () => {
        await poolGate;
        return fauxAssistantMessage("POOLED-SECOND");
      };
      subagents.respond([
        fauxAssistantMessage("POOLED-FIRST"),
        gated,
        fauxAssistantMessage("RESUMED-POOL-FILE"),
      ]);

      // Create the pooled session: a successful run persists its file.
      const first = await callDelegate(session, {
        tasks: [{ prompt: "seed the pool", tools: ["read"], sessionId: "pool-1" }],
      });
      expect(first.isError).toBe(false);

      // Locate the durable file delegate created for the pooled session.
      const sessionsDir = join(session.cwd, "delegate-sessions");
      await waitFor(
        () => readdirSync(sessionsDir).some((f) => f.endsWith(".jsonl")),
        "pooled session file on disk",
      );
      const pooledFile = join(
        sessionsDir,
        readdirSync(sessionsDir).find((f) => f.endsWith(".jsonl"))!,
      );

      // Check the pooled session out on a gated async run.
      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "hold the pooled session", tools: ["read"], sessionId: "pool-1" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount >= 2,
        "second (gated) provider call in flight",
      );

      const busy = await callDelegate(session, {
        tasks: [{ prompt: "resume the pooled file", tools: ["read"], resumeFrom: pooledFile }],
      });
      expect(busy.isError).toBe(true);
      expect(busy.text).toContain("still in use");
      expect(subagents.state.callCount).toBe(2);

      releasePoolGate();
      await callDelegateTicket(session, { action: "wait", ticket });

      const after = await callDelegate(session, {
        tasks: [{ prompt: "resume the settled pool file", tools: ["read"], resumeFrom: pooledFile }],
      });
      expect(after.isError).toBe(false);
      expect(after.text).toContain("RESUMED-POOL-FILE");
    },
  );
});

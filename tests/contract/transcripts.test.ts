import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

/** A minimal Git repository — scratch workspaces require one to copy. */
function gitInit(dir: string): void {
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir },
  );
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
        async: false,
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
        async: false,
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
        async: false,
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
        async: false,
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
        async: false,
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
        async: false,
        tasks: [{ prompt: "resume the pooled file", tools: ["read"], resumeFrom: pooledFile }],
      });
      expect(busy.isError).toBe(true);
      expect(busy.text).toContain("still in use");
      expect(subagents.state.callCount).toBe(2);

      releasePoolGate();
      await callDelegateTicket(session, { action: "wait", ticket });

      const after = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "resume the settled pool file", tools: ["read"], resumeFrom: pooledFile }],
      });
      expect(after.isError).toBe(false);
      expect(after.text).toContain("RESUMED-POOL-FILE");
    },
  );

  test(
    "a failed fresh shared-workspace task leaves its transcript and names a resume path",
    async () => {
      // v1 evidence: fresh non-scratch sessions were file-backed under
      // delegate-sessions, and v1's failed-task output carried
      // `session: <path>` plus a copy-pasteable
      // `→ To retry: delegate({ tasks: [{ resumeFrom: ... }] })` hint.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "provider blew up",
        }),
        fauxAssistantMessage("RESUMED-AND-DONE"),
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "die on the first call", tools: ["read"] }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("provider blew up");

      // The reported path is absolute, lives under delegate-sessions,
      // exists on disk, and is the same file the retry hint names.
      const sessionLine = /^session: (\S+\.jsonl)$/m.exec(result.text)?.[1];
      expect(sessionLine).toBeDefined();
      expect(sessionLine!).toStartWith(join(session.cwd, "delegate-sessions"));
      expect(existsSync(sessionLine!)).toBe(true);
      expect(result.text).toContain("→ To retry:");
      expect(result.text).toContain(`resumeFrom: ${JSON.stringify(sessionLine!)}`);

      // Round-trip: the advertised path is a real transcript
      // SessionManager.open can continue — not a dead pointer.
      const resumed = await callDelegate(session, {
        async: false,
        tasks: [
          { prompt: "continue", tools: ["read"], resumeFrom: sessionLine! },
        ],
      });
      expect(resumed.isError).toBe(false);
      expect(resumed.text).toContain("RESUMED-AND-DONE");
    },
  );

  test(
    "a scratch task's failure prints no session transcript (memory-only)",
    async () => {
      // v1 evidence: scratch/isolated runs were memory-only — a discarded
      // filesystem cannot host a resumable transcript, so no `session:`
      // line may be advertised.
      session = await openDelegateBoundary();
      const dir = mkdtempSync(join(tmpdir(), "delegate-scratch-repo-"));
      gitInit(dir);
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "scratch provider boom",
        }),
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          {
            prompt: "die in scratch",
            cwd: dir,
            tools: ["write"],
            workspace: "scratch",
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("scratch provider boom");
      expect(result.text).not.toContain("session:");
      expect(result.text).not.toContain("→ To retry:");
      const sessionsDir = join(session.cwd, "delegate-sessions");
      expect(
        existsSync(sessionsDir) &&
          readdirSync(sessionsDir).some((f) => f.endsWith(".jsonl")),
      ).toBe(false);
    },
  );

  test(
    "a resumed task carries the ↻ tag in results, running polls, and cancel previews",
    async () => {
      // v1 evidence: format.ts formatResumeTag/resumeMarker — completed
      // sections and ticket rows rendered `↻<tag>`; an omitted-agent resume
      // labels `resume:<tag>` and must not double-mark.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const transcript = writeTranscript(session.cwd, "sess_ab12cd34ef.jsonl");

      // Sync result section head.
      subagents.respond([fauxAssistantMessage("RESUMED-SYNC")]);
      const sync = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "continue", tools: ["read"], resumeFrom: transcript }],
      });
      expect(sync.isError).toBe(false);
      expect(sync.text).toContain("### Task task-1 ↻ab12cd34");

      // Running ticket row: the omitted-agent label is `resume:<tag>` —
      // the marker must not repeat the same identity.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const gated: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("RESUMED-ASYNC");
      };
      subagents.respond([gated]);
      const dispatched = await callDelegate(session, {
        tasks: [
          { prompt: "continue", tools: ["read"], resumeFrom: transcript },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount >= 2,
        "resumed provider call in flight",
      );

      const running = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(running.text).toContain("resume:ab12cd34 #task-1");
      expect(running.text).not.toContain("resume:ab12cd34 ↻");

      // The cancel preview names the same task identity.
      const preview = await callDelegateTicket(session, {
        action: "cancel",
        ticket,
      });
      expect(preview.text).toContain("resume:ab12cd34 #task-1");
      expect(preview.text).not.toContain("↻ab12cd34");

      release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("### Task task-1 ↻ab12cd34");

      // An explicit agent keeps its name; the marker carries the identity.
      const second = writeTranscript(session.cwd, "sess_bb22cc33dd.jsonl");
      let release2!: () => void;
      const gate2 = new Promise<void>((resolve) => (release2 = resolve));
      const gated2: FauxResponseFactory = async () => {
        await gate2;
        return fauxAssistantMessage("SECOND-RESUME");
      };
      subagents.respond([gated2]);
      const dispatched2 = await callDelegate(session, {
        tasks: [
          {
            agent: "default",
            prompt: "continue",
            tools: ["read"],
            resumeFrom: second,
          },
        ],
        async: true,
      });
      const ticket2 = ticketIdOf(dispatched2.text);
      await waitFor(
        () => subagents.state.callCount >= 3,
        "second resumed provider call in flight",
      );
      const running2 = await callDelegateTicket(session, {
        action: "poll",
        ticket: ticket2,
      });
      expect(running2.text).toContain("default ↻bb22cc33 #task-1");
      release2();
      await callDelegateTicket(session, {
        action: "wait",
        ticket: ticket2,
        timeoutMs: 5000,
      });
    },
  );
});

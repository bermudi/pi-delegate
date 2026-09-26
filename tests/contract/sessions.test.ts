import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
  callDelegateSession,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

describe("delegate session contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a sessionId task pools a live session, lists it, and continues it on reuse",
    async () => {
      // v1 evidence: lifecycle.test.ts "task with sessionId creates pooled
      // session on first use" / "reuses pooled session on second call";
      // SPEC: a successful task with sessionId keeps a live conversation.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("FIRST-TURN")]);
      const first = await callDelegate(session, {
        tasks: [
          { prompt: "remember ALPHA-MARKER", sessionId: "conv" },
        ],
      });
      expect(first.isError).toBe(false);

      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.isError).toBe(false);
      expect(listed.text).toContain("conv");

      // On reuse the subagent sees the prior conversation: its context
      // contains the first prompt and reply.
      const sawHistory: FauxResponseFactory = (context) => {
        const transcript = JSON.stringify(context);
        const saw = transcript.includes("ALPHA-MARKER");
        return fauxAssistantMessage(saw ? "CONTINUED" : "FRESH-SESSION");
      };
      subagents.respond([sawHistory]);
      const second = await callDelegate(session, {
        tasks: [{ prompt: "again", sessionId: "conv" }],
      });
      expect(second.isError).toBe(false);
      expect(second.text).toContain("CONTINUED");
    },
  );

  test(
    "close removes the named session and a later call starts fresh",
    async () => {
      // v1 evidence: lifecycle.test.ts "close action tears down pooled
      // session"; SPEC: close aborts, disposes, and removes the session.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("SESQUIPEDALIAN")]);
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "conv" }],
      });

      const closed = await callDelegateSession(session, {
        action: "close",
        sessionId: "conv",
      });
      expect(closed.isError).toBe(false);

      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.text).not.toContain("conv");

      const fresh: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          JSON.stringify(context).includes("SESQUIPEDALIAN")
            ? "CONTINUED"
            : "FRESH",
        );
      subagents.respond([fresh]);
      const reopened = await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "conv" }],
      });
      expect(reopened.text).toContain("FRESH");
    },
  );

  test(
    "reusing a sessionId with incompatible frozen configuration is rejected",
    async () => {
      // v1 evidence: lifecycle.test.ts "session config mismatch rejects with
      // actionable message"; pool.test checkout frozen-field rejections;
      // INVARIANTS: cwd, tools, thinking, model, base prompt are frozen.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("hi")]);
      await callDelegate(session, {
        tasks: [
          { prompt: "x", sessionId: "conv",  tools: ["read"] },
        ],
      });

      const mismatched = await callDelegate(session, {
        tasks: [
          {
            prompt: "x",
            sessionId: "conv",
            tools: ["read", "bash"],
          },
        ],
      });
      // The incompatible reuse must fail with an actionable explanation
      // naming what froze; whether the call or only the task is marked as the
      // error is a v2 formatting choice.
      expect(mismatched.text).toMatch(/conv|session/i);
      expect(mismatched.text).toMatch(/frozen|mismatch|incompatible|tools/i);
    },
  );

  test(
    "reusing a sessionId after its agent's configured model changed is rejected",
    async () => {
      // INVARIANTS: a pooled session's model is frozen. Models come from
      // delegate.json now, so the freeze must compare the *resolved* model:
      // editing an agent's entry between calls is an incompatible reuse,
      // the same as any other frozen-field mismatch.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("hi")]);
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "conv", agent: "scout" }],
      });

      configureDelegate(session, {
        models: { scout: subagents.alt.spec },
      });
      const mismatched = await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "conv", agent: "scout" }],
      });
      expect(mismatched.isError).toBe(true);
      expect(mismatched.text).toMatch(/conv|session/i);
      expect(mismatched.text).toMatch(/model/i);
    },
  );

  test(
    "a cancelled run evicts the pooled session and a later call starts fresh",
    async () => {
      // INVARIANTS: a pooled session cancelled after prompting MUST be
      // evicted; reuse must not observe its conversation. v1 evidence:
      // pool.test eviction after cancelled runs.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("POOLED")]);
      const first = await callDelegate(session, {
        tasks: [
          {
            prompt: "remember EVICT-MARKER",
            sessionId: "conv",
          },
        ],
      });
      expect(first.isError).toBe(false);

      // Reuse the pooled session with a gated provider; cancel only once the
      // second stream has demonstrably started (callCount is incremented at
      // stream entry), so the eviction under test is a prompted run.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      subagents.respond([
        async () => {
          await gate;
          return fauxAssistantMessage("never");
        },
      ]);
      const created = await callDelegate(session, {
        tasks: [
          { prompt: "more work", sessionId: "conv" },
        ],
        async: true,
      });
      for (let i = 0; i < 200 && subagents.state.callCount < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(subagents.state.callCount).toBe(2);

      // A live session mid-run is busy: close must refuse to race it.
      const closedBusy = await callDelegateSession(session, {
        action: "close",
        sessionId: "conv",
      });
      expect(closedBusy.isError).toBe(true);
      expect(closedBusy.text).toMatch(/conv|running|busy/i);

      const ticket = ticketIdOf(created.text);
      const cancelled = await callDelegateTicket(session, {
        action: "cancel",
        ticket,
        force: true,
      });
      expect(cancelled.text).toMatch(/cancel/i);

      // Let the gated worker wind down; the busy mark frees and the pool
      // entry clears only on confirmed quiescence (the provisional outcome
      // is replaced once "unconfirmed" disappears from the ticket view).
      release();
      for (let i = 0; i < 200; i++) {
        const view = await callDelegateTicket(session, {
          action: "poll",
          ticket,
        });
        if (view.text.includes("### Task") && !view.text.includes("unconfirmed")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.text).not.toContain("conv");

      const inspect: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          JSON.stringify(context).includes("EVICT-MARKER")
            ? "CONTINUED"
            : "FRESH",
        );
      subagents.respond([inspect]);
      const reused = await callDelegate(session, {
        tasks: [
          { prompt: "again", sessionId: "conv" },
        ],
      });
      expect(reused.isError).toBe(false);
      expect(reused.text).toContain("FRESH");
    },
  );

  test(
    "close on an unknown session reports the miss",
    async () => {
      // SPEC: close removes the named session; a nonexistent one is an
      // actionable error, not a silent no-op.
      session = await openDelegateBoundary();
      const result = await callDelegateSession(session, {
        action: "close",
        sessionId: "ghost",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/ghost|no live session/i);
    },
  );

  test(
    "resumeFrom with a nonexistent transcript fails with an actionable error",
    async () => {
      // v1 evidence: lifecycle.test.ts "resumeFrom with nonexistent file
      // returns error" and "placeholder string returns invalid path error".
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "continue",
            resumeFrom: "/nonexistent/definitely-missing.jsonl",
          },
        ],
      });
      expect(result.text).toMatch(/resume|transcript|jsonl|exist/i);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  test(
    "resumeFrom without a prompt continues the transcript with a default instruction",
    async () => {
      // SPEC: prompt is optional only with resumeFrom; a bare resumeFrom must
      // not send an empty message — it continues with a default prompt.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const transcript = join(session.cwd, "prior-session.jsonl");
      const now = new Date().toISOString();
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "fixture-1",
            timestamp: now,
            cwd: session.cwd,
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

      let sawPrior = false;
      let sawDefaultPrompt = false;
      const inspect: FauxResponseFactory = (context) => {
        const serialized = JSON.stringify(context);
        sawPrior = serialized.includes("PRIOR-INSTRUCTION");
        const users = context.messages.filter((m) => m.role === "user");
        sawDefaultPrompt = JSON.stringify(users.at(-1)).includes(
          "Continue from where you left off",
        );
        return fauxAssistantMessage("RESUMED");
      };
      subagents.respond([inspect]);

      const result = await callDelegate(session, {
        tasks: [{ resumeFrom: transcript }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("RESUMED");
      expect(sawPrior).toBe(true);
      expect(sawDefaultPrompt).toBe(true);
    },
  );

  test(
    "a sessionId held by a running ticket rejects conflicting reuse",
    async () => {
      // v1 evidence: delegate.test.ts isSessionBusy tests (cancelling tickets
      // count as busy); task-resolution validateTasks busy conflicts.
      // SPEC: busy sessions fail the whole call with an actionable error.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hanging: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("done");
      };
      subagents.respond([hanging, fauxAssistantMessage("later")]);

      await callDelegate(session, {
        tasks: [{ prompt: "bg", sessionId: "busy-one" }],
        async: true,
      });

      const conflict = await callDelegate(session, {
        tasks: [
          { prompt: "now", sessionId: "busy-one" },
        ],
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.text).toMatch(/busy-one|busy|running/i);

      release();
    },
  );

  test(
    "a stalled run evicts the pooled session and a later call starts fresh",
    async () => {
      // INVARIANTS "Session reuse": a pooled session stalled after
      // prompting MUST be evicted. Only cancellation-eviction was covered;
      // the watchdog eviction follows the same pool decision but its own
      // path (a failed outcome with a watchdog cause).
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("STALL-POOL-MARKER")]);
      const first = await callDelegate(session, {
        tasks: [{ prompt: "remember STALL-POOL-MARKER", sessionId: "conv" }],
      });
      expect(first.isError).toBe(false);

      // The watchdog applies only to the second dispatch's config read.
      configureDelegate(session, { stallTimeoutMs: 150 });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hanging: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("TOO-LATE");
      };
      subagents.respond([hanging]);
      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "go silent", sessionId: "conv" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const stalled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(stalled.text).toMatch(/stall/i);

      // Eviction is decided when the worker's true settlement reaches the
      // pool; poll until the unconfirmed note clears, then require the
      // session to be gone.
      release();
      const budget = Date.now() + 5000;
      for (;;) {
        const view = await callDelegateTicket(session, {
          action: "poll",
          ticket,
        });
        if (!view.text.includes("unconfirmed")) break;
        if (Date.now() > budget) throw new Error("worker never confirmed stopped");
        await new Promise((r) => setTimeout(r, 25));
      }
      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.text).not.toContain("conv");

      const inspect: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          JSON.stringify(context).includes("STALL-POOL-MARKER")
            ? "CONTINUED"
            : "FRESH",
        );
      subagents.respond([inspect]);
      const reused = await callDelegate(session, {
        tasks: [{ prompt: "again", sessionId: "conv" }],
      });
      expect(reused.isError).toBe(false);
      expect(reused.text).toContain("FRESH");
    },
  );

  test(
    "a deadline that hits before the model is called leaves the pooled session intact and records no usage",
    async () => {
      // INVARIANTS "Session reuse": a deadline before prompting MAY leave
      // the session intact and MUST record no usage. Usage without a
      // provider call is impossible, so the unchanged callCount is the
      // boundary witness for "no usage".
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("DEADLINE-POOL-MARKER")]);
      const first = await callDelegate(session, {
        tasks: [{ prompt: "remember DEADLINE-POOL-MARKER", sessionId: "conv" }],
      });
      expect(first.isError).toBe(false);
      expect(subagents.state.callCount).toBe(1);

      // 1ms expires during the dispatch's own resource loading — before a
      // TaskExecution exists, so the checkout is never taken and no prompt
      // is attempted.
      const expired = await callDelegate(session, {
        tasks: [{ prompt: "work", sessionId: "conv", deadlineMs: 1 }],
      });
      expect(expired.text).toMatch(/deadline exceeded/i);
      expect(subagents.state.callCount).toBe(1);

      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.text).toContain("conv");

      const inspect: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          JSON.stringify(context).includes("DEADLINE-POOL-MARKER")
            ? "CONTINUED"
            : "FRESH",
        );
      subagents.respond([inspect]);
      const reused = await callDelegate(session, {
        tasks: [{ prompt: "again", sessionId: "conv" }],
      });
      expect(reused.isError).toBe(false);
      expect(reused.text).toContain("CONTINUED");
    },
  );

  test(
    "an ordinary failure keeps the pooled session reusable and records its attempt",
    async () => {
      // INVARIANTS "Session reuse": ordinary provider/task failure on an
      // existing pooled session remains reusable.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("KEEP-POOL-MARKER")]);
      const first = await callDelegate(session, {
        tasks: [{ prompt: "remember KEEP-POOL-MARKER", sessionId: "conv" }],
      });
      expect(first.isError).toBe(false);

      subagents.respond([
        fauxAssistantMessage("attempt failed", {
          stopReason: "error",
          errorMessage: "the provider returned a malformed response",
        }),
      ]);
      const failed = await callDelegate(session, {
        tasks: [{ prompt: "fail once", sessionId: "conv" }],
      });
      expect(failed.isError).toBe(true);
      expect(failed.text).toContain("malformed response");
      // Non-transient: no whole-task retry, exactly one provider call.
      expect(subagents.state.callCount).toBe(2);

      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.text).toContain("conv");

      const inspect: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          JSON.stringify(context).includes("KEEP-POOL-MARKER")
            ? "CONTINUED"
            : "FRESH",
        );
      subagents.respond([inspect]);
      const reused = await callDelegate(session, {
        tasks: [{ prompt: "again", sessionId: "conv" }],
      });
      expect(reused.isError).toBe(false);
      expect(reused.text).toContain("CONTINUED");
    },
  );

  test(
    "same-session calls run one at a time: busy while running, reusable after settlement",
    async () => {
      // INVARIANTS "Session reuse": same-ID calls serialize across
      // acquisition, execution, and final state update. The busy rejection
      // while a ticket owns the session is covered above; the missing half
      // is that the busy mark clears at settlement and the next call
      // actually continues the conversation.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("SERIAL-POOL-MARKER")]);
      const first = await callDelegate(session, {
        tasks: [{ prompt: "remember SERIAL-POOL-MARKER", sessionId: "conv" }],
      });
      expect(first.isError).toBe(false);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hanging: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("BG-DONE");
      };
      subagents.respond([hanging]);
      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg", sessionId: "conv" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const busy = await callDelegate(session, {
        tasks: [{ prompt: "now", sessionId: "conv" }],
      });
      expect(busy.isError).toBe(true);
      expect(busy.text).toMatch(/conv|busy|running/i);

      release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("BG-DONE");

      // The busy mark releases with the reservation; absorb the
      // settle→release ordering, then require the continuation to run.
      const inspect: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          JSON.stringify(context).includes("SERIAL-POOL-MARKER")
            ? "CONTINUED"
            : "FRESH",
        );
      subagents.respond([inspect]);
      const budget = Date.now() + 3000;
      let reused = await callDelegate(session, {
        tasks: [{ prompt: "again", sessionId: "conv" }],
      });
      while (reused.isError && Date.now() < budget) {
        await new Promise((r) => setTimeout(r, 25));
        reused = await callDelegate(session, {
          tasks: [{ prompt: "again", sessionId: "conv" }],
        });
      }
      expect(reused.isError).toBe(false);
      expect(reused.text).toContain("CONTINUED");
    },
  );

  test(
    "session shutdown disposes every pooled session, running ones after quiescence",
    async () => {
      // INVARIANTS "Session reuse": shutdown MUST reject new reusable
      // sessions, request termination of active ones, avoid racing their
      // state updates, and attempt every cleanup. The pool is empty
      // afterwards and later sessionId dispatches refuse. (Cleanup
      // FAILURE REPORTING is a log path: AgentSession.dispose is built
      // not to throw, so it has no boundary-observable failure mode.)
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([
        fauxAssistantMessage("IDLE-A"),
        fauxAssistantMessage("IDLE-B"),
      ]);
      await callDelegate(session, {
        tasks: [{ prompt: "pool a", sessionId: "idle-a" }],
      });
      await callDelegate(session, {
        tasks: [{ prompt: "pool b", sessionId: "idle-b" }],
      });

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hanging: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("BUSY-C-DONE");
      };
      subagents.respond([hanging]);
      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "busy", sessionId: "busy-c" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const running = Date.now() + 5000;
      while (subagents.state.callCount < 3 && Date.now() < running) {
        await new Promise((r) => setImmediate(r));
      }
      expect(subagents.state.callCount).toBe(3);

      const shutdown = (
        session.session as AgentSession
      ).extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      release();
      await Promise.race([
        shutdown,
        Bun.sleep(15_000).then(() => {
          throw new Error("shutdown never settled after the busy session quiesced");
        }),
      ]);

      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.isError).toBe(false);
      expect(listed.text).not.toContain("idle-a");
      expect(listed.text).not.toContain("idle-b");
      expect(listed.text).not.toContain("busy-c");
      const cancelled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(cancelled.text).toContain("cancelled");
      // New reusable-session dispatches are refused after shutdown.
      const refused = await callDelegate(session, {
        tasks: [{ prompt: "nope", sessionId: "fresh-after-shutdown" }],
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/shut(ting)? down/i);
    },
    20_000,
  );
});

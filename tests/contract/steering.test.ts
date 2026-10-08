import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateTicket,
  configureDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/** A scripted subagent stream that blocks until `release` is invoked. */
function gate(output = "OUTPUT-RELEASED") {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage(output);
  };
  return { release, step };
}

/** Poll until true, bounded — keeps in-flight ordering assertions stable. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250 && !probe(); i++) await Bun.sleep(20);
  expect(probe(), `${what} (timed out waiting)`).toBeTrue();
}

/** Count user messages in the child's provider-visible transcript carrying `text`. */
function steerCopies(context: TranscriptContext, text: string): number {
  return context.messages.filter((message) => {
    if (message.role !== "user") return false;
    const content = message.content;
    if (typeof content === "string") return content.includes(text);
    return content.some(
      (part) => part.type === "text" && part.text.includes(text),
    );
  }).length;
}

function steerDetails(result: { details?: unknown }): Record<string, unknown> {
  return objectOf(objectOf(result.details, "result.details").steer, "details.steer");
}

describe("ticket steering with delivery receipts (SPEC v3, issue #37)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "steer on a live run receipts steered and the child sees the message at its next turn boundary",
    async () => {
      // SPEC v3 "Interaction grammar — Steering": `steered` = queued on
      // the live child run, merged as a user message at the next turn
      // boundary. Pi drains the steering queue at turn_end, so a steer
      // queued during the final turn forces one more provider turn.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const first = gate("TURN-ONE");
      let copies = -1;
      const second: FauxResponseFactory = (context) => {
        copies = steerCopies(context, "STEER-NOTE-ALPHA");
        return fauxAssistantMessage("TURN-TWO-SAW-IT");
      };
      subagents.respond([first.step, second]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "work" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "child parked inside its first provider call",
      );

      const receipt = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        message: "STEER-NOTE-ALPHA",
        steerId: "s-1",
      });
      expect(receipt.isError).toBe(false);
      expect(receipt.text).toContain("steered");
      expect(receipt.text).toContain("task-1");
      const steer = steerDetails(receipt);
      expect(steer.status).toBe("steered");
      expect(steer.steerId).toBe("s-1");
      expect(steer.taskId).toBe("task-1");

      // SPEC: `duplicate` replays the original receipt, nothing re-injects.
      const replay = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        message: "STEER-NOTE-ALPHA",
        steerId: "s-1",
      });
      expect(replay.isError).toBe(false);
      const replayed = steerDetails(replay);
      expect(replayed.status).toBe("duplicate");
      expect(replayed.replayed).toBe("steered");
      expect(replay.text).toBe(receipt.text);

      first.release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.text).toContain("TURN-TWO-SAW-IT");
      // The child observed the steer exactly once — one user message,
      // injected between the two provider calls.
      expect(copies).toBe(1);
    },
  );

  test(
    "a steer for a queued task receipts activated and opens its first turn",
    async () => {
      // SPEC: `activated` = no turn in flight; the parked message opens
      // the task's next turn. A task queued behind the concurrency slot
      // has no live run; its parked steer drains into turn one.
      session = await openDelegateBoundary();
      configureDelegate(session, { maxConcurrent: 1 });
      const subagents = await installSubagentModel(session);
      const first = gate("TASK-ONE-OUT");
      let copies = -1;
      const queued: FauxResponseFactory = (context) => {
        copies = steerCopies(context, "PARKED-STEER");
        return fauxAssistantMessage("TASK-TWO-OUT");
      };
      subagents.respond([first.step, queued]);

      const dispatched = await callDelegate(session, {
        // #126 vehicle: read-only tasks admit; maxConcurrent 1 still
        // queues task-2 behind the slot — the activated shape under test.
        tasks: [
          { prompt: "holds the slot", tools: ["read"] },
          { prompt: "waits behind", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "task-1 parked in the provider with task-2 queued",
      );

      const receipt = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "task-2",
        message: "PARKED-STEER",
        steerId: "s-2",
      });
      expect(receipt.isError).toBe(false);
      expect(receipt.text).toContain("activated");
      expect(steerDetails(receipt).status).toBe("activated");

      first.release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.text).toContain("TASK-TWO-OUT");
      expect(copies).toBe(1);
    },
  );

  test(
    "steer on a settled task or ticket receipts not-applied with teaching",
    async () => {
      // SPEC: `not-applied` = the target settled, is unknown, or is a
      // recovered ticket — the receipt names what to do instead.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const held = gate("LATE-OUT");
      subagents.respond([held.step]);
      const running = await callDelegate(session, {
        tasks: [{ prompt: "still running" }],
        async: true,
      });
      const runningTicket = ticketIdOf(running.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "child parked inside its provider call",
      );

      // An unknown taskId on a live ticket is not-applied and lists the
      // ticket's real task ids.
      const bogusTask = await callDelegateTicket(session, {
        action: "steer",
        ticket: runningTicket,
        taskId: "task-99",
        message: "missing",
        steerId: "s-5",
      });
      expect(bogusTask.isError).toBe(false);
      expect(bogusTask.text).toContain("not-applied");
      expect(bogusTask.text).toContain("task-99");
      expect(bogusTask.text).toContain("task-1");
      expect(steerDetails(bogusTask).status).toBe("not-applied");

      held.release();
      await callDelegateTicket(session, {
        action: "wait",
        ticket: runningTicket,
        timeoutMs: 5000,
      });

      const settled = await callDelegateTicket(session, {
        action: "steer",
        ticket: runningTicket,
        message: "too late",
        steerId: "s-3",
      });
      expect(settled.isError).toBe(false);
      expect(settled.text).toContain("not-applied");
      expect(settled.text).toMatch(/poll/i);
      expect(steerDetails(settled).status).toBe("not-applied");

      const unknown = await callDelegateTicket(session, {
        action: "steer",
        ticket: "t-does-not-exist",
        message: "nowhere",
        steerId: "s-4",
      });
      expect(unknown.isError).toBe(false);
      expect(unknown.text).toContain("not-applied");
      expect(unknown.text).toContain("t-does-not-exist");
      expect(steerDetails(unknown).status).toBe("not-applied");
    },
  );

  test(
    "an ambiguous steer errors naming the running task ids; steerId reuse with a different attempt conflicts",
    async () => {
      // SPEC: omitting taskId with several running tasks errors and
      // lists the ids; reusing a steerId on a different message or
      // target is a conflict naming both attempts.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const a = gate("A-OUT");
      const b = gate("B-OUT");
      subagents.respond([a.step, b.step]);
      const dispatched = await callDelegate(session, {
        // Read-only tasks hold no write claims — both run in parallel.
        tasks: [
          { prompt: "one", tools: ["read"] },
          { prompt: "two", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 2,
        "both children parked in provider calls",
      );

      const ambiguous = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        message: "which one",
        steerId: "s-6",
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.text).toContain("task-1");
      expect(ambiguous.text).toContain("task-2");
      // The failed ambiguity did not consume the steerId.
      const retried = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "task-1",
        message: "which one",
        steerId: "s-6",
      });
      expect(retried.isError).toBe(false);
      expect(steerDetails(retried).status).toBe("steered");

      const conflict = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "task-1",
        message: "a different message",
        steerId: "s-6",
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.text).toContain("s-6");
      expect(conflict.text).toMatch(/different/);
      const targetConflict = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "task-2",
        message: "which one",
        steerId: "s-6",
      });
      expect(targetConflict.isError).toBe(true);
      expect(targetConflict.text).toContain("s-6");

      a.release();
      b.release();
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
    },
  );

  test(
    "a parked steer whose task settles first voids to not-applied on retry and never reaches a dead session",
    async () => {
      // SPEC: nothing delivers into a dead session — a steer parked for a
      // task that never starts (cancelled while queued) replays as
      // not-applied, and the child transcript stays empty.
      session = await openDelegateBoundary();
      configureDelegate(session, { maxConcurrent: 1 });
      const subagents = await installSubagentModel(session);
      const first = gate("TASK-ONE-OUT");
      let taskTwoPrompts = -1;
      const queued: FauxResponseFactory = (context) => {
        taskTwoPrompts = context.messages.length;
        return fauxAssistantMessage("TASK-TWO-OUT");
      };
      subagents.respond([first.step, queued]);

      const dispatched = await callDelegate(session, {
        // #126 vehicle: read-only tasks admit; maxConcurrent 1 still
        // queues task-2 — cancel must catch it queued, never started.
        tasks: [
          { prompt: "one", tools: ["read"] },
          { prompt: "two", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "task-1 parked with task-2 queued",
      );

      const receipt = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "task-2",
        message: "VOIDED-STEER",
        steerId: "s-7",
      });
      expect(steerDetails(receipt).status).toBe("activated");

      const cancelled = await callDelegateTicket(session, {
        action: "cancel",
        ticket,
        force: true,
      });
      expect(cancelled.isError).toBe(false);

      // Retrying the same steer replays the corrected receipt: the task
      // settled before delivery, so the recorded outcome is not-applied.
      const retry = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "task-2",
        message: "VOIDED-STEER",
        steerId: "s-7",
      });
      expect(retry.isError).toBe(false);
      const steer = steerDetails(retry);
      expect(steer.status).toBe("duplicate");
      expect(steer.replayed).toBe("not-applied");
      expect(retry.text).toContain("not-applied");

      first.release();
      // Task-2 never ran — nothing was written into a dead session.
      await Bun.sleep(50);
      expect(subagents.state.callCount).toBe(1);
      expect(taskTwoPrompts).toBe(-1);
    },
  );

  test(
    "a whole-task retry re-supplies a live-steered message the failed attempt took with it",
    async () => {
      // SPEC v3 "Steering": a transient failure retries the task, not
      // the settled state — steers already injected into the failed
      // attempt's session ride the next attempt's drain. A live steer
      // merged before the error must appear in the retried run's
      // transcript, not die with the dead session.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const turnOne = gate("TURN-ONE");
      let failingTurnCopies = -1;
      const transient: FauxResponseFactory = (context) => {
        failingTurnCopies = steerCopies(context, "CARRIED-STEER");
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "503 temporarily overloaded",
        });
      };
      let retriedCopies = -1;
      const retriedTurn: FauxResponseFactory = (context) => {
        retriedCopies = steerCopies(context, "CARRIED-STEER");
        return fauxAssistantMessage("RETRY-OUT");
      };
      subagents.respond([turnOne.step, transient, retriedTurn]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "work" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "child parked inside its first provider call",
      );

      const receipt = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        message: "CARRIED-STEER",
        steerId: "s-retry-1",
      });
      expect(steerDetails(receipt).status).toBe("steered");

      turnOne.release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.text).toContain("RETRY-OUT");
      // Call sequence: attempt 1 turn 1 (gated), attempt 1 turn 2
      // (steer merged, transient error), attempt 2 turn 1 (retry).
      expect(subagents.state.callCount).toBe(3);
      // The steer really did land in the failed attempt...
      expect(failingTurnCopies).toBe(1);
      // ...and the retry re-supplied it exactly once.
      expect(retriedCopies).toBe(1);
    },
  );

  test(
    "a whole-task retry re-supplies a parked steer the failed attempt already drained",
    async () => {
      // Same contract through the parked path: the steer is drained into
      // attempt 1's first turn (marked delivered, queue emptied), so the
      // retry can only see it if the execution retained it.
      session = await openDelegateBoundary();
      configureDelegate(session, { maxConcurrent: 1 });
      const subagents = await installSubagentModel(session);
      const first = gate("TASK-ONE-OUT");
      let attemptOneCopies = -1;
      const failedAttempt: FauxResponseFactory = (context) => {
        attemptOneCopies = steerCopies(context, "PARKED-CARRIED");
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "429 too many requests",
        });
      };
      let retriedCopies = -1;
      const retriedAttempt: FauxResponseFactory = (context) => {
        retriedCopies = steerCopies(context, "PARKED-CARRIED");
        return fauxAssistantMessage("TASK-TWO-OUT");
      };
      subagents.respond([first.step, failedAttempt, retriedAttempt]);

      const dispatched = await callDelegate(session, {
        // #126 vehicle: read-only tasks admit; maxConcurrent 1 still
        // queues task-2 behind the slot — the parked-drain shape under test.
        tasks: [
          { prompt: "holds the slot", tools: ["read"] },
          { prompt: "waits behind", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "task-1 parked with task-2 queued",
      );

      const receipt = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "task-2",
        message: "PARKED-CARRIED",
        steerId: "s-retry-2",
      });
      expect(steerDetails(receipt).status).toBe("activated");

      first.release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.text).toContain("TASK-TWO-OUT");
      // call 1: task-1 gated; call 2: task-2 attempt 1 (drained steer,
      // transient error); call 3: task-2 attempt 2 (re-supplied steer).
      expect(subagents.state.callCount).toBe(3);
      expect(attemptOneCopies).toBe(1);
      expect(retriedCopies).toBe(1);
    },
  );

  test(
    "steer requires message; steerId is optional (#44), and steer fields belong to steer alone",
    async () => {
      // SPEC: `message` (nonempty) is required; `steerId` is a caller
      // charset rule (≤64) only when sent — omitted, the boundary derives
      // `steer:<toolCallId>` (#44). Both reject on every other action.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("OUT")]);
      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "one" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });

      for (const [arguments_, pattern] of [
        [{ action: "steer", ticket, steerId: "s-8" }, /requires a nonempty message/],
        [
          { action: "steer", ticket, message: "m", steerId: "bad id!" },
          /id charset/,
        ],
        [
          { action: "poll", ticket, message: "stray" },
          /message is valid only with action "steer"/,
        ],
        [
          { action: "poll", ticket, steerId: "s-9" },
          /steerId is valid only with action "steer"/,
        ],
        [
          { action: "steer", ticket, message: "m", steerId: "s-10", answer: "a" },
          /answer is valid only with action "answer"/,
        ],
      ] as const) {
        const result = await callDelegateTicket(session, arguments_);
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(pattern);
      }

      // An omitted steerId on a settled ticket receipts not-applied with
      // the derived key — validation no longer requires the field.
      const derived = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        message: "m",
      });
      expect(derived.isError).toBe(false);
      expect(derived.text).toContain("not-applied");
      expect(derived.text).toContain(`steer:${derived.toolCallId}`);
    },
  );

  test(
    "a not-applied steer on a settled pooled task teaches the sessionId continuation (#57)",
    async () => {
      // Issue #57 (third codex comparison): an unapplied steer must not
      // dead-end on "nothing is running" — a task that ran on a pooled
      // session still owns that conversation, so the receipt teaches
      // re-dispatch with its sessionId and the follow-up prompt.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      // The pooled task answers immediately; the sibling stays gated so
      // the ticket is still running when the settled task is steered.
      const held = gate("HELD-OUT");
      const forPrompt: FauxResponseFactory = (context, options, state, model) =>
        JSON.stringify(context.messages).includes("stays gated")
          ? held.step(context, options, state, model)
          : fauxAssistantMessage("POOLED-ONE");
      subagents.respond([forPrompt, forPrompt]);
      const dispatched = await callDelegate(session, {
        tasks: [
          { id: "pooled", prompt: "pooled work", sessionId: "conv" },
          { id: "holder", prompt: "stays gated", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      // Wait until the pooled task's outcome is on the record — the
      // ticket itself is still running behind the gated sibling.
      for (let i = 0; i < 250; i++) {
        const view = await callDelegateTicket(session, { action: "poll", ticket });
        if (view.text.includes("POOLED-ONE")) break;
        await Bun.sleep(20);
      }

      // Named settled task on a still-running ticket: the not-applied
      // receipt carries the sessionId continuation.
      const named = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "pooled",
        message: "keep going",
        steerId: "s-pool-1",
      });
      expect(named.isError).toBe(false);
      expect(steerDetails(named).status).toBe("not-applied");
      expect(named.text).toContain("not-applied");
      expect(named.text).toContain('sessionId "conv"');
      expect(named.text).toContain("re-dispatch");

      // Once the ticket is terminal, the named-task form still resolves
      // it — the terminal-ticket receipt teaches the same hint.
      held.release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("HELD-OUT");
      const terminal = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "pooled",
        message: "keep going",
        steerId: "s-pool-2",
      });
      expect(terminal.isError).toBe(false);
      expect(terminal.text).toContain("not-applied");
      expect(terminal.text).toContain('sessionId "conv"');
    },
  );

  test(
    "a not-applied steer on a settled fresh task teaches resumeFrom; a task that never ran keeps the plain text (#57)",
    async () => {
      // Issue #57: the continuation hint prefers the pooled sessionId;
      // a fresh task's durable transcript points at `resumeFrom` instead
      // (the same pointer failure views render), and a task that never
      // ran — no transcript exists to continue — gets today's text.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("FRESH-DONE"),
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "provider blew up",
        }),
      ]);
      const dispatched = await callDelegate(session, {
        // #126 vehicle: dependsOn keeps the pinned assignment
        // deterministic — doomed must consume the error so blocked
        // never runs (the plain-text branch under test).
        tasks: [
          { id: "done", prompt: "fresh one" },
          { id: "doomed", prompt: "dies on the provider", dependsOn: ["done"] },
          { id: "blocked", prompt: "never ran", dependsOn: ["doomed"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.isError).toBe(false);

      const fresh = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "done",
        message: "keep going",
        steerId: "s-fresh",
      });
      expect(fresh.isError).toBe(false);
      expect(steerDetails(fresh).status).toBe("not-applied");
      expect(fresh.text).toContain("not-applied");
      expect(fresh.text).toContain("resumeFrom");
      expect(fresh.text).toContain("re-dispatch");

      const blocked = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "blocked",
        message: "keep going",
        steerId: "s-blocked",
      });
      expect(blocked.isError).toBe(false);
      expect(steerDetails(blocked).status).toBe("not-applied");
      expect(blocked.text).toContain("not-applied");
      expect(blocked.text).not.toContain("re-dispatch");
      expect(blocked.text).not.toContain("resumeFrom");
    },
  );
});

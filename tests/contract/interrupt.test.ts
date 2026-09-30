import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateSession,
  callDelegateTicket,
  configureDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";
import { join } from "node:path";

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

function interruptDetails(result: { details?: unknown }): Record<string, unknown> {
  return objectOf(objectOf(result.details, "result.details").interrupt, "details.interrupt");
}

/** Poll one ticket until its view contains `text` — the worker-truth
 * settlement (transcript path, unquarantined) lands a beat after the
 * caller-visible outcome. */
async function waitForTicketText(
  session: TestSession,
  ticket: string,
  text: string,
  what: string,
): Promise<string> {
  for (let i = 0; i < 250; i++) {
    const view = await callDelegateTicket(session, { action: "poll", ticket });
    if (view.text.includes(text)) return view.text;
    await Bun.sleep(20);
  }
  const last = await callDelegateTicket(session, { action: "poll", ticket });
  expect(last.text, `${what} (timed out waiting)`).toContain(text);
  return last.text;
}

/** True when the child's provider-visible transcript carried `text`. */
function transcriptSaw(context: TranscriptContext, text: string): boolean {
  return context.messages.some((message) => {
    const content = message.content;
    if (typeof content === "string") return content.includes(text);
    return content.some(
      (part) => part.type === "text" && part.text.includes(text),
    );
  });
}

describe("ticket interrupt — abort the turn, keep the worker (SPEC v3, issue #42)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "interrupting a fresh task settles it interrupted — transcript kept, resume hint shown — distinct from cancelled",
    async () => {
      // SPEC v3 "Interaction grammar — Interrupt": the abort rides the
      // cancellation machinery but settles `interrupted`; the fresh
      // task's transcript persists and the view names the resume path.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const held = gate("NEVER-SEEN");
      subagents.respond([held.step]);

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
        action: "interrupt",
        ticket,
      });
      expect(receipt.isError).toBe(false);
      expect(receipt.text).toContain("interrupted");
      const interrupt = interruptDetails(receipt);
      expect(interrupt.status).toBe("interrupted");
      expect(interrupt.taskId).toBe("task-1");

      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 3000,
      });
      // The whole ticket settles interrupted — first-class, not cancelled.
      expect(waited.text).toContain("interrupted");
      expect(waited.text).toContain("### Task task-1 — interrupted");
      expect(waited.text).not.toContain("### Task task-1 — cancelled");
      // The resume hint + persisted transcript path ride the section
      // once worker truth lands — release the parked provider call so
      // the aborted run can unwind and flush it.
      held.release();
      const settledText = await waitForTicketText(
        session, ticket, "session:", "the persisted transcript path in the settled view",
      );
      expect(settledText).toContain("Ticket \"t-");
      expect(settledText).toContain("interrupted");
      expect(settledText).toContain("resumeFrom");
      expect(settledText).toContain("turn was aborted on request");

      // Interrupting the settled task again is a not-applied receipt —
      // and (#57) it teaches continuation: the fresh task's durable
      // transcript points at resumeFrom.
      const again = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
      });
      expect(again.isError).toBe(false);
      expect(again.text).toContain("not-applied");
      expect(interruptDetails(again).status).toBe("not-applied");
      expect(again.text).toContain("resumeFrom");
    },
  );

  test(
    "a not-applied interrupt on a settled pooled task teaches the sessionId continuation (#57)",
    async () => {
      // Issue #57: interrupt shares the steer receipt discipline — an
      // unapplied interrupt on a task that ran pooled names the sessionId
      // to re-dispatch rather than dead-ending on "nothing is running".
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("POOLED-ONE"),
        fauxAssistantMessage("POOLED-TWO"),
      ]);
      const first = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "seed", sessionId: "conv" }],
      });
      expect(first.isError).toBe(false);
      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "more", sessionId: "conv" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("POOLED-TWO");

      const receipt = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
        taskId: "task-1",
      });
      expect(receipt.isError).toBe(false);
      expect(interruptDetails(receipt).status).toBe("not-applied");
      expect(receipt.text).toContain("not-applied");
      expect(receipt.text).toContain('sessionId "conv"');
      expect(receipt.text).toContain("re-dispatch");
    },
  );

  test(
    "interrupting a pooled-session task returns the session to the pool, reusable",
    async () => {
      // SPEC: a pooled-session interrupt releases the session back —
      // keeping the worker alive is the point (codex interrupt_agent).
      // Pooling is insert-on-success, so a first task pools it and the
      // interrupt lands on a run that checked it out.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("FIRST-TURN")]);
      const first = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "remember ALPHA-MARKER", sessionId: "conv" }],
      });
      expect(first.isError).toBe(false);

      const held = gate("NEVER-SEEN");
      subagents.respond([held.step]);
      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "second turn", sessionId: "conv" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 2,
        "pooled child parked in its second provider call",
      );

      const receipt = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
        taskId: "task-1",
      });
      expect(receipt.isError).toBe(false);
      expect(interruptDetails(receipt).status).toBe("interrupted");

      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 3000,
      });
      expect(waited.text).toContain("interrupted");

      // The session was kept, not evicted — it still lists pooled…
      held.release();
      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.text).toContain("conv");

      // …and a later task continues the same conversation (its context
      // carries the first prompt). The pool re-opens it once the aborted
      // run's quiescence lands, so retry past the checkout window.
      const sawHistory: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          transcriptSaw(context, "ALPHA-MARKER") ? "CONTINUED" : "FRESH-SESSION",
        );
      subagents.respond([sawHistory]);
      let second;
      for (let i = 0; i < 100; i++) {
        second = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "again", sessionId: "conv" }],
        });
        if (second.isError && second.text.includes("already running")) {
          await Bun.sleep(20);
          continue;
        }
        break;
      }
      expect(second!.isError).toBe(false);
      expect(second!.text).toContain("CONTINUED");
    },
  );

  test(
    "not-applied paths: unknown ticket, unknown task, settled ticket, queued task, ambiguous omission",
    async () => {
      // SPEC: receipts share the steer vocabulary — anything the abort
      // cannot reach reports not-applied rather than erroring.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const unknown = await callDelegateTicket(session, {
        action: "interrupt",
        ticket: "t-00000000-0000-4000-8000-000000000000",
      });
      expect(unknown.isError).toBe(false);
      expect(unknown.text).toContain("not-applied");
      expect(interruptDetails(unknown).status).toBe("not-applied");

      // Queued task: maxConcurrent 1 parks task-2 with no live turn.
      configureDelegate(session, { maxConcurrent: 1 });
      const held = gate("TASK-ONE");
      subagents.respond([held.step, fauxAssistantMessage("TASK-TWO")]);
      const dispatched = await callDelegate(session, {
        async: true,
        tasks: [{ prompt: "one" }, { id: "second", prompt: "two" }],
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "task one parked inside its provider call",
      );

      const queued = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
        taskId: "second",
      });
      expect(queued.isError).toBe(false);
      expect(queued.text).toContain("not-applied");
      expect(queued.text).toContain("second");

      const bogus = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
        taskId: "nope",
      });
      expect(bogus.isError).toBe(false);
      expect(bogus.text).toContain("not-applied");
      expect(bogus.text).toContain(`"${ticket}#task-1"`);
      expect(bogus.text).toContain(`"${ticket}#second"`);

      const ambiguous = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.text).toContain(`"${ticket}#task-1"`);
      expect(ambiguous.text).toContain(`"${ticket}#second"`);

      held.release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.isError).toBe(false);
      const terminal = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
        taskId: "task-1",
      });
      expect(terminal.isError).toBe(false);
      expect(terminal.text).toContain("not-applied");
      expect(interruptDetails(terminal).status).toBe("not-applied");
    },
  );

  test(
    "dependents of an interrupted task block with the interruption named",
    async () => {
      // SPEC: interrupted counts as not-succeeded — the dependent
      // records blocked and names the reason, same as a cancellation.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const held = gate("NEVER-FINISHES");
      subagents.respond([held.step]);
      const dispatched = await callDelegate(session, {
        async: true,
        tasks: [
          { id: "a", prompt: "first" },
          { id: "b", prompt: "second", dependsOn: ["a"] },
        ],
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "task a parked inside its provider call",
      );

      const receipt = await callDelegateTicket(session, {
        action: "interrupt",
        ticket,
        taskId: "a",
      });
      expect(interruptDetails(receipt).status).toBe("interrupted");

      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      held.release();
      expect(waited.text).toContain("### Task a — interrupted");
      expect(waited.text).toContain("### Task b — blocked");
      expect(waited.text).toMatch(/'a' — (it )?.*interrupt/i);
    },
  );

  test(
    "telemetry records the interrupted outcome and the interrupted call status",
    async () => {
      // SPEC "Observability": interrupted is a first-class terminal
      // state in telemetry — the task row's outcome and the call row's
      // status both report it.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(session.cwd, "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
      });
      const held = gate();
      subagents.respond([held.step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "work" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "child parked inside its first provider call",
      );
      await callDelegateTicket(session, { action: "interrupt", ticket });
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      held.release();

      const db = new DatabaseSync(dbPath);
      try {
        const tasks = db.prepare("SELECT outcome FROM tasks").all() as { outcome: string }[];
        const calls = db.prepare("SELECT status FROM calls").all() as { status: string }[];
        expect(tasks.some((row) => row.outcome === "interrupted")).toBe(true);
        expect(calls.some((row) => row.status === "interrupted")).toBe(true);
      } finally {
        db.close();
      }
    },
  );
});

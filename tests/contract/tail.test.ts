import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { Check } from "typebox/value";
import { tailDetailsSchema } from "../../src/details.ts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
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

// Issue #52 (new contract, no v1 precedent): delegate_ticket action "tail"
// returns {text, nextOffset, done, taskState} — an incremental, bounded
// read of a task's clean assistant output. File-backed tasks are read
// from their durable transcript (the caller never parses .jsonl);
// scratch/in-memory tasks read the activity store's captured text.

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

/** A parked worker's question id, scraped from the ticket's poll view. */
async function untilQuestion(session: TestSession, ticket: string): Promise<string> {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const view = await callDelegateTicket(session, { action: "poll", ticket });
    const match = view.text.match(/Waiting for parent answer: task \S+, question (q-\d+):/);
    if (match) return match[1]!;
    await Bun.sleep(10);
  }
  throw new Error(`Worker did not ask a question on ticket ${ticket}`);
}

/** Bounded poll until every named task has a pending question on the ticket. */
async function untilQuestions(
  session: TestSession,
  ticket: string,
  tasks: readonly string[],
): Promise<void> {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const view = await callDelegateTicket(session, { action: "poll", ticket });
    if (
      tasks.every((task) =>
        view.text.includes(`Waiting for parent answer: task ${ticket}#${task},`),
      )
    ) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Not every worker asked a question on ticket ${ticket}`);
}

function tailDetails(result: { details?: unknown }): Record<string, unknown> {
  const details = objectOf(result.details, "result.details");
  const tail = objectOf(details.tail, "details.tail");
  expect(
    Check(tailDetailsSchema, tail),
    `details.tail must satisfy the pinned schema: ${JSON.stringify(tail).slice(0, 300)}`,
  ).toBe(true);
  return tail;
}

describe("delegate_ticket tail — streamed output tails (#52)", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a file-backed task tails growing transcript text with advancing offsets, then settles done",
    async () => {
      // #52: growing text + advancing offset across a task's life; settled
      // task tails done + state with the full bounded output. Default
      // (shared) workspace makes the task file-backed — the read comes
      // from the durable .jsonl, parsed internally.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage([
          fauxText("ALPHA-PART"),
          fauxToolCall("ask_parent", { question: "Keep going?" }),
        ]),
        fauxAssistantMessage("BETA-PART"),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "tailme", prompt: "write prose", tools: ["read"] }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const questionId = await untilQuestion(session, ticket);

      const first = await callDelegateTicket(session, {
        action: "tail",
        ticket,
      });
      expect(first.isError).toBe(false);
      const t1 = tailDetails(first);
      expect(t1.done).toBe(false);
      expect(t1.taskState).toBe("running");
      expect(t1.text).toContain("ALPHA-PART");
      expect(t1.text).not.toContain("BETA-PART");
      // Clean text only — never raw transcript JSONL.
      expect(t1.text).not.toContain('"type":"message"');
      expect(t1.text).not.toContain('"role":"assistant"');
      const offset1 = t1.nextOffset as number;
      expect(offset1).toBeGreaterThan(0);

      // Resume the worker; the second turn lands and the task settles.
      await callDelegateTicket(session, {
        action: "answer",
        ticket,
        taskId: "tailme",
        questionId,
        answer: "yes",
      });
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 4000,
      });
      expect(settled.text).toContain("BETA-PART");

      // Incremental read from the cursor: only the new text.
      const second = await callDelegateTicket(session, {
        action: "tail",
        ticket,
        offset: offset1,
      });
      const t2 = tailDetails(second);
      expect(t2.done).toBe(true);
      expect(t2.taskState).toBe("ok");
      expect(t2.text).toContain("BETA-PART");
      expect(t2.text).not.toContain("ALPHA-PART");

      // Full stream from 0 reproduces both turns' text.
      const whole = await callDelegateTicket(session, {
        action: "tail",
        ticket,
        offset: 0,
      });
      const t3 = tailDetails(whole);
      expect(t3.done).toBe(true);
      expect(t3.text).toContain("ALPHA-PART");
      expect(t3.text).toContain("BETA-PART");
      expect(t3.nextOffset).toBeGreaterThanOrEqual(offset1);
    },
  );

  test(
    "waitMs parks the read, resolves early when new output lands, and never exceeds the bound",
    async () => {
      // #52: a bounded waitMs resolves early on new output. The child
      // parks inside its first provider call so the parked read provably
      // had no output yet; releasing it lands text while the task stays
      // running (it parks on a question), so done:false proves the early
      // resolve was output, not settlement.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      let release!: () => void;
      subagents.respond([
        // Turn 1 blocks inside the provider call, then lands text plus a
        // question so the task keeps running past its first output.
        async () => {
          await new Promise<void>((r) => (release = r));
          return fauxAssistantMessage([
            fauxText("EARLY-OUTPUT"),
            fauxToolCall("ask_parent", { question: "Proceed?" }),
          ]);
        },
        fauxAssistantMessage("LAST-PART"),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "slow", prompt: "think", tools: ["read"] }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "child parked inside its first provider call",
      );

      const started = Date.now();
      const parked = callDelegateTicket(session, {
        action: "tail",
        ticket,
        waitMs: 4000,
      });
      // Give the parked read a beat, then land new text.
      await Bun.sleep(150);
      release();
      const result = await parked;
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(3000);
      const tail = tailDetails(result);
      expect(tail.text).toContain("EARLY-OUTPUT");
      expect(tail.done).toBe(false);
      expect(tail.taskState).toBe("running");

      // Cleanup: answer the question, let the worker settle.
      const questionId = await untilQuestion(session, ticket);
      subagents.append([fauxAssistantMessage("LAST-PART")]);
      await callDelegateTicket(session, {
        action: "answer",
        ticket,
        taskId: "slow",
        questionId,
        answer: "go",
      });
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 4000,
      });
    },
  );

  test(
    "waitMs times out at the bound on a silent task; an offset past the end clamps",
    async () => {
      // #52: pure snapshot when waitMs is omitted/0; a parked read with no
      // new output returns at its bound; offsets beyond the end clamp.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage([
          fauxText("SEED-TEXT"),
          fauxToolCall("ask_parent", { question: "Ready?" }),
        ]),
        fauxAssistantMessage("FINAL-PART"),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "clamper", prompt: "wait", tools: ["read"] }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const questionId = await untilQuestion(session, ticket);

      // Offset beyond the end clamps to the stream's length.
      const far = await callDelegateTicket(session, {
        action: "tail",
        ticket,
        offset: 999_999,
      });
      const tf = tailDetails(far);
      expect(tf.done).toBe(false);
      expect(tf.text).toBe("");
      expect(tf.offset).toBe((tf.nextOffset as number));
      expect(tf.offset).toBeLessThan(999_999);
      expect((tf.offset as number)).toBeGreaterThan(0);

      // A bounded wait on a silent stream returns at the bound.
      const started = Date.now();
      const timed = await callDelegateTicket(session, {
        action: "tail",
        ticket,
        offset: tf.nextOffset as number,
        waitMs: 300,
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(280);
      expect(elapsed).toBeLessThan(3000);
      const tt = tailDetails(timed);
      expect(tt.text).toBe("");
      expect(tt.done).toBe(false);

      // A settled stream reports done + state with the full output.
      await callDelegateTicket(session, {
        action: "answer",
        ticket,
        taskId: "clamper",
        questionId,
        answer: "go",
      });
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 4000,
      });
      const done = await callDelegateTicket(session, {
        action: "tail",
        ticket,
      });
      const td = tailDetails(done);
      expect(td.done).toBe(true);
      expect(td.taskState).toBe("ok");
      expect(td.text).toContain("SEED-TEXT");
      expect(td.text).toContain("FINAL-PART");
    },
  );

  test(
    "a scratch (in-memory) task tails from captured activity text",
    async () => {
      // #52: scratch/isolated tasks have no durable transcript — their
      // tail source is the activity store's captured assistant text.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = mkdtempSync(join(tmpdir(), "delegate-tail-scratch-"));
      gitInit(dir);
      subagents.respond([
        fauxAssistantMessage([
          fauxText("MEM-TEXT"),
          fauxToolCall("ask_parent", { question: "More?" }),
        ]),
        fauxAssistantMessage("MEM-DONE"),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [
          {
            id: "scratchy",
            prompt: "scratch work",
            cwd: dir,
            tools: ["write"],
            workspace: "scratch",
          },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const questionId = await untilQuestion(session, ticket);

      const live = await callDelegateTicket(session, {
        action: "tail",
        ticket,
      });
      const tl = tailDetails(live);
      expect(tl.done).toBe(false);
      expect(tl.text).toContain("MEM-TEXT");

      await callDelegateTicket(session, {
        action: "answer",
        ticket,
        taskId: "scratchy",
        questionId,
        answer: "finish",
      });
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 4000,
      });
      const settled = await callDelegateTicket(session, {
        action: "tail",
        ticket,
      });
      const ts = tailDetails(settled);
      expect(ts.done).toBe(true);
      expect(ts.taskState).toBe("ok");
      expect(ts.text).toContain("MEM-TEXT");
      expect(ts.text).toContain("MEM-DONE");
    },
  );

  test(
    "a per-call text bound pages long output without losing the stream",
    async () => {
      // #52: spill-bounded reads — a task whose accumulated output exceeds
      // the ticket's tail bound returns bounded chunks; paging by
      // nextOffset reproduces the whole stream.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        output: { spillThresholdChars: 4000, spillTailChars: 120 },
      });
      const long = Array.from({ length: 30 }, (_, i) => `CHUNK-${String(i).padStart(2, "0")}`).join("-");
      subagents.respond([fauxAssistantMessage(long)]);
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "chatty", prompt: "produce text", tools: ["read"] }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 4000,
      });
      // Page the settled output: each read returns at most the bound and
      // nextOffset advances; concatenation reproduces the stream.
      let offset = 0;
      let collected = "";
      for (let i = 0; i < 10; i++) {
        const page = await callDelegateTicket(session, {
          action: "tail",
          ticket,
          offset,
        });
        const td = tailDetails(page);
        expect((td.text as string).length).toBeLessThanOrEqual(120);
        collected += td.text as string;
        offset = td.nextOffset as number;
        if (td.done === true && (td.text as string).length < 120) break;
      }
      expect(collected).toBe(long);
    },
  );

  test(
    "targeting and field rules: taskId defaults sensibly and names candidates; offset/waitMs belong to tail",
    async () => {
      // #52 boundary teaching: tail's taskId defaults to the only
      // still-running task or the ticket's only task; an ambiguous or
      // unknown target fails naming the tasks; offset/waitMs on other
      // actions reject.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      // Responses are a global FIFO across parallel workers — dispatch on
      // the task's own prompt so each worker parks with ITS text.
      const byPrompt: FauxResponseFactory = async (context) => {
        const which = JSON.stringify(context.messages).includes('"one"')
          ? "ONE"
          : "TWO";
        return fauxAssistantMessage([
          fauxText(which),
          fauxToolCall("ask_parent", { question: `${which}?` }),
        ]);
      };
      subagents.respond([byPrompt, byPrompt]);
      const dispatched = await callDelegate(session, {
        tasks: [
          { id: "alpha", prompt: "one", tools: ["read"] },
          { id: "beta", prompt: "two", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      // Both workers must be parked: untilQuestion returns on the first
      // question, so wait for beta's too before its stream is asserted.
      await untilQuestions(session, ticket, ["alpha", "beta"]);

      // Ambiguous: two running tasks, no taskId — names both as
      // canonical <ticket>#<task> addresses (#53).
      const ambiguous = await callDelegateTicket(session, {
        action: "tail",
        ticket,
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.text).toContain(`"${ticket}#alpha"`);
      expect(ambiguous.text).toContain(`"${ticket}#beta"`);

      // Unknown taskId names the ticket's tasks.
      const unknown = await callDelegateTicket(session, {
        action: "tail",
        ticket,
        taskId: "nope",
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain(`"${ticket}#nope"`);
      expect(unknown.text).toContain(`"${ticket}#alpha"`);
      expect(unknown.text).toContain(`"${ticket}#beta"`);

      // Field ownership: offset/waitMs on a non-tail action reject.
      const misplaced = await callDelegateTicket(session, {
        action: "poll",
        ticket,
        offset: 3,
      });
      expect(misplaced.isError).toBe(true);
      expect(misplaced.text).toContain('valid only with action "tail"');
      const misplacedWait = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        waitMs: 5,
      });
      expect(misplacedWait.isError).toBe(true);
      expect(misplacedWait.text).toContain('valid only with action "tail"');

      // A negative offset is malformed, not clamped-away.
      const negative = await callDelegateTicket(session, {
        action: "tail",
        ticket,
        taskId: "alpha",
        offset: -1,
      });
      expect(negative.isError).toBe(true);
      expect(negative.text).toContain("non-negative");

      // Explicit taskId works and reads that task's own stream.
      const named = await callDelegateTicket(session, {
        action: "tail",
        ticket,
        taskId: "beta",
      });
      const tn = tailDetails(named);
      expect(tn.taskId).toBe("beta");
      expect(tn.text).toContain("TWO");
      expect(tn.text).not.toContain("ONE");

      // A ticket-less tail is missing its required field.
      const noTicket = await callDelegateTicket(session, { action: "tail" });
      expect(noTicket.isError).toBe(true);
      expect(noTicket.text).toContain("ticket");

      // Cleanup: cancel the ticket (both workers parked on questions).
      await callDelegateTicket(session, { action: "cancel", ticket, force: true });
    },
  );
});

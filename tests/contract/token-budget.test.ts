import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
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

/** Poll one ticket until its view contains `text`. */
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

describe("batch token budget — fan-out cost ceiling (SPEC v3, issue #47)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "queued tasks settle budget-exhausted without consuming a worker",
    async () => {
      // SPEC v3 "Batch token budget": once settled usage reaches the
      // limit, a still-queued task settles `budget-exhausted` — it never
      // acquires a slot, worker, or session. tokenBudget 1 exhausts on
      // the first settle: the faux provider's estimated usage is >0 for
      // any prompt.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { maxConcurrent: 1 });
      const held = gate("TASK-ONE");
      subagents.respond([held.step]);

      const dispatched = await callDelegate(session, {
        tokenBudget: 1,
        tasks: [
          { id: "a", prompt: "one", tools: ["read"] },
          { prompt: "two", tools: ["read"] },
          { prompt: "three", tools: ["read"] },
        ],
      });
      expect(dispatched.isError).toBe(false);
      expect(dispatched.text).toContain("token budget: 0/1 tokens");
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 1,
        "task a parked inside its provider call",
      );

      held.release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.isError).toBe(false);
      expect(settled.text).toContain("### Task a — completed");
      expect(settled.text).toContain("### Task task-2 — budget-exhausted");
      expect(settled.text).toContain("### Task task-3 — budget-exhausted");
      expect(settled.text).toContain("tokenBudget of 1 tokens");
      expect(settled.text).toMatch(/token budget: [1-9]\d*\/1 tokens — exhausted/);
      // Queued tasks never started — the provider saw only task a.
      expect(subagents.state.callCount).toBe(1);

      const budget = objectOf(
        objectOf(settled.details, "result.details").tokenBudget,
        "details.tokenBudget",
      );
      expect(budget.limit).toBe(1);
      expect(budget.consumed).toBeGreaterThanOrEqual(1);
      expect(typeof budget.exhaustedAt).toBe("number");
    },
  );

  test(
    "a task already running finishes after the budget exhausts — no hard abort",
    async () => {
      // SPEC v3 "Batch token budget": running tasks always finish; the
      // ceiling only stops queued tasks from starting.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { maxConcurrent: 2 });
      const gateA = gate("A-DONE");
      const gateB = gate("B-DONE");
      subagents.respond([gateA.step, gateB.step, fauxAssistantMessage("C-DONE")]);

      const dispatched = await callDelegate(session, {
        tokenBudget: 1,
        tasks: [
          { id: "a", prompt: "one", tools: ["read"] },
          { id: "b", prompt: "two", tools: ["read"] },
          { id: "c", prompt: "three", tools: ["read"] },
        ],
      });
      const ticket = ticketIdOf(dispatched.text);
      await waitFor(
        () => subagents.state.callCount === 2,
        "tasks a and b parked inside their provider calls",
      );

      // a settles and exhausts the budget while b is still in-flight.
      gateA.release();
      await waitForTicketText(session, ticket, "### Task a — completed", "task a settles");
      gateB.release();

      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("### Task a — completed");
      // b was running when the ceiling hit — it finished normally.
      expect(settled.text).toContain("### Task b — completed");
      expect(settled.text).toContain("B-DONE");
      // c never started — the third provider factory went unused.
      expect(settled.text).toContain("### Task c — budget-exhausted");
      expect(subagents.state.callCount).toBe(2);
    },
  );

  test(
    "a dependent of a budget-exhausted task blocks naming the budget",
    async () => {
      // SPEC v3 "Batch token budget": `budget-exhausted` counts as
      // not-succeeded — dependents block through the same gate as a
      // failed prerequisite, with the exhausted budget named.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { maxConcurrent: 1 });
      subagents.respond([fauxAssistantMessage("FIRST-DONE")]);

      const dispatched = await callDelegate(session, {
        tokenBudget: 1,
        tasks: [
          { id: "x", prompt: "one", tools: ["read"] },
          { id: "y", prompt: "two", tools: ["read"] },
          { id: "z", prompt: "three", tools: ["read"], dependsOn: ["y"] },
        ],
      });
      const ticket = ticketIdOf(dispatched.text);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.isError).toBe(false);
      expect(settled.text).toContain("### Task x — completed");
      expect(settled.text).toContain("### Task y — budget-exhausted");
      expect(settled.text).toContain("### Task z — blocked");
      expect(settled.text).toMatch(/'y' — .*(token budget|never ran)/i);
      expect(subagents.state.callCount).toBe(1);
    },
  );

  test(
    "telemetry records the budget account on the call row and budget-exhausted task rows",
    async () => {
      // SPEC v3 "Observability" + issue #47: the dispatch row carries
      // {limit, consumed, exhaustedAt}; a task stopped by the ceiling
      // records outcome `budget-exhausted`. Budgetless dispatches leave
      // the columns NULL.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(session.cwd, "usage.db");
      configureDelegate(session, {
        maxConcurrent: 1,
        telemetry: { enabled: true, dbPath },
      });
      subagents.respond([fauxAssistantMessage("ONE"), fauxAssistantMessage("UNBUDGETED")]);

      const dispatched = await callDelegate(session, {
        tokenBudget: 1,
        async: false,
        tasks: [{ prompt: "one" }, { prompt: "two" }],
      });
      expect(dispatched.isError).toBe(false);
      await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "no ceiling" }],
      });

      const db = new DatabaseSync(dbPath);
      try {
        const tasks = db
          .prepare("SELECT outcome FROM tasks")
          .all() as { outcome: string }[];
        expect(tasks.some((row) => row.outcome === "budget-exhausted")).toBe(true);
        const calls = db
          .prepare(
            "SELECT budget_limit, budget_consumed, budget_exhausted_at FROM calls ORDER BY ts",
          )
          .all() as {
            budget_limit: number | null;
            budget_consumed: number | null;
            budget_exhausted_at: number | null;
          }[];
        const budgeted = calls.find((row) => row.budget_limit === 1);
        expect(budgeted).toBeDefined();
        expect(budgeted!.budget_consumed).toBeGreaterThanOrEqual(1);
        expect(budgeted!.budget_exhausted_at).not.toBeNull();
        const plain = calls.find((row) => row.budget_limit === null);
        expect(plain).toBeDefined();
        expect(plain!.budget_consumed).toBeNull();
        expect(plain!.budget_exhausted_at).toBeNull();
      } finally {
        db.close();
      }
    },
  );

  test(
    "validation rejects non-positive, fractional, and string tokenBudget values",
    async () => {
      // SPEC v3 "Batch token budget": the field is a positive integer —
      // out-of-domain values reject with the field named, and a budget
      // with no tasks is a dispatch field sent to the wrong mode.
      session = await openDelegateBoundary();
      await installSubagentModel(session);

      for (const bad of [0, -5, 1.5, "500"]) {
        const result = await callDelegate(session, {
          tokenBudget: bad,
          tasks: [{ prompt: "work" }],
        });
        expect(result.isError, `tokenBudget ${JSON.stringify(bad)}`).toBe(true);
        expect(result.text).toMatch(/tokenBudget/);
      }
      const noTasks = await callDelegate(session, { tokenBudget: 10 });
      expect(noTasks.isError).toBe(true);
      expect(noTasks.text).toMatch(/tokenBudget.*requires at least one task/);
    },
  );

  test(
    "without tokenBudget every queued task still runs — default unchanged",
    async () => {
      // Issue #47: the budget is opt-in; a budgetless batch keeps the v2
      // scheduling behavior and no budget header/details appear.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { maxConcurrent: 1 });
      subagents.respond([
        fauxAssistantMessage("ONE"),
        fauxAssistantMessage("TWO"),
        fauxAssistantMessage("THREE"),
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }],
      });
      expect(result.isError).toBe(false);
      expect(subagents.state.callCount).toBe(3);
      expect(result.text).not.toContain("token budget:");
      expect(objectOf(result.details, "result.details").tokenBudget).toBeUndefined();
    },
  );

  test(
    "tokenBudget joins the request fingerprint — same operationId, different budget conflicts",
    async () => {
      // SPEC v3 "Batch token budget" + operations contract: the ceiling
      // is request content — a replayed operationId carrying a different
      // budget is a different dispatch, not a duplicate.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("DONE")]);

      const original = await callDelegate(session, {
        operationId: "op-budget",
        tokenBudget: 1_000_000,
        tasks: [{ prompt: "one" }],
      });
      expect(original.isError).toBe(false);

      const changed = await callDelegate(session, {
        operationId: "op-budget",
        tokenBudget: 2_000_000,
        tasks: [{ prompt: "one" }],
      });
      expect(changed.isError).toBe(true);
      expect(changed.text).toContain("op-budget");
      expect(changed.text).toMatch(/original request|new operationId/i);

      const replay = await callDelegate(session, {
        operationId: "op-budget",
        tokenBudget: 1_000_000,
        tasks: [{ prompt: "one" }],
      });
      expect(replay.isError).toBe(false);
      expect(subagents.state.callCount).toBe(1);
    },
  );
});

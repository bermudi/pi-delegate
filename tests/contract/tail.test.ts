import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

/**
 * #130 field verdict 9: the `tail` action and its `offset`/`waitMs`
 * parameters are removed from delegate_ticket. "What is it doing?" is
 * answered by poll (live per-task activity rows) and the settled result;
 * humans watching mid-flight have the /subagents dashboard (#128). The
 * action rejects with teaching; the machinery (transcript-span reads,
 * activity tails) stays internal to poll views and spill.
 */
describe("removed tail action", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("tail rejects with schema-level teaching; offset/waitMs are not fields", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("RUNNING-FINE")]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "explore" }],
      async: true,
    });
    expect(dispatched.isError).toBe(false);
    const ticket = ticketIdOf(dispatched.text);

    // The action no longer exists in the enum — the schema rejects it
    // naming the accepted set (enumerate-or-inherit).
    const rejected = await callDelegateTicket(session, { action: "tail", ticket });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/tail/);

    // The parameter fields are gone from the vocabulary entirely.
    for (const args of [
      { action: "poll", offset: 0 },
      { action: "poll", waitMs: 100 },
    ] as const) {
      const result = await callDelegateTicket(session, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/offset|waitMs/);
    }

    // Ordinary actions are unaffected.
    const settled = await callDelegateTicket(session, { action: "wait", ticket });
    expect(settled.isError).toBe(false);
    expect(settled.text).toContain("RUNNING-FINE");
  });
});

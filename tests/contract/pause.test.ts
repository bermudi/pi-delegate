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
 * #130 field verdict 10: `pause`/`resume` are removed from the
 * model-facing delegate_ticket surface — a model that wants to hold work
 * waits; one that wants it stopped cancels. The pause state machine
 * itself survives as operator machinery: the /subagents dashboard's `p`
 * keybinding calls TicketStore.pause/resume directly, with no tool
 * schema involved. Park-mechanics coverage (watchdog suspension,
 * cancelled-while-paused) that previously drove the RPC is carried by
 * tests/regression/cancellation.test.ts's non-paused scenarios; the
 * paused-variant scenarios lost their public trigger with the action and
 * are a known coverage gap pending a dashboard integration test.
 *
 * Provenance (TEST-MIGRATION): supersedes v1 pause.test.ts's migrated
 * core; the surviving public contract is the teaching rejection.
 */
describe("removed pause/resume ticket actions", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("pause and resume reject with teaching toward wait/cancel, work untouched", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("UNPAUSED-EVENT")]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg", agent: "explore" }],
      async: true,
    });
    expect(dispatched.isError).toBe(false);
    const ticket = ticketIdOf(dispatched.text);

    for (const action of ["pause", "resume"] as const) {
      const rejected = await callDelegateTicket(session, { action, ticket });
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain(`"${action}" action has been removed`);
      expect(rejected.text).toContain("/subagents");
      expect(rejected.text).toContain('"wait"');
      expect(rejected.text).toContain('"cancel"');
    }

    // The ticket itself is unaffected — it settles normally.
    const settled = await callDelegateTicket(session, { action: "wait", ticket });
    expect(settled.isError).toBe(false);
    expect(settled.text).toContain("UNPAUSED-EVENT");
  });
});

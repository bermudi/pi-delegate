import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/**
 * #129 (owner ruling 2026-10-07): the caller-controlled batch tokenBudget
 * is removed — the concept dies entirely. A model-set spend ceiling is the
 * party being protected arming its own guard; 0 of 2,001 production
 * dispatches ever set one. Supplied `tokenBudget` rejects with teaching
 * before any task starts, in every shape (deadlineMs/#118 pattern); the
 * engine machinery (account, start-boundary checks, budget-exhausted
 * settlement, dependent blocking, notes, details, telemetry writes) is
 * gone. Historical telemetry columns and journal-record fields stay
 * readable for pre-removal records.
 */
describe("removed batch tokenBudget", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  const REJECTION = /tokenBudget.*has been removed.*not caller-set/s;

  test("presence rejects with teaching before any task starts — every value, even null", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    for (const tokenBudget of [50_000, 1, 0, -1, null, "50000", false]) {
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "sibling must not start", agent: "explore" }],
        tokenBudget,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(REJECTION);
      expect(result.text).toContain("Remove it");
    }
    expect(subagents.state.callCount).toBe(0);
  });

  test("flat and stringified recovery shapes reject the same way", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    for (const args of [
      { prompt: "flat", agent: "explore", tokenBudget: 100, async: false },
      { tasks: JSON.stringify([{ prompt: "encoded", agent: "explore" }]), tokenBudget: 100, async: false },
    ]) {
      const result = await callDelegate(session, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(REJECTION);
    }
    expect(subagents.state.callCount).toBe(0);
  });

  test("the schema no longer declares the field and results carry no budget account", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessageOf("DONE")]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "work", agent: "explore" }],
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.details)).not.toContain("tokenBudget");
    expect(JSON.stringify(result.details)).not.toContain("budget");
    expect(result.text).not.toContain("token budget");
  });
});

// Local import alias keeps the surviving dispatch test provider-free.
import { fauxAssistantMessage as fauxAssistantMessageOf } from "@earendil-works/pi-ai";

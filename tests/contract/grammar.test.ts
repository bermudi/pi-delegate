import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateTicket,
  configureDelegate,
  delegateTool,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/**
 * SPEC v3 "Interaction grammar": dispatch cardinality — a single task
 * blocks inline by default, a multi-task batch backgrounds by default,
 * and `async` overrides in both directions.
 */
describe("delegate interaction grammar (SPEC v3)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("a single task runs synchronously inline by default", async () => {
    // SPEC v3 "Interaction grammar": one task, no `async` → the caller
    // waits and gets the result inline, like the incumbent blocking
    // single-Task call.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SOLO-INLINE")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "solo" }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("SOLO-INLINE");
    expect(objectOf(result.details, "result.details").async).toBe(false);
  });

  test("a single task backgrounds on an explicit async: true", async () => {
    // SPEC v3 "Interaction grammar": `async` overrides both ways; true
    // backgrounds even the single task.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SOLO-BG")]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "solo" }],
      async: true,
    });

    expect(dispatched.isError).toBe(false);
    expect(objectOf(dispatched.details, "dispatched.details").async).toBe(true);
    const ticket = ticketIdOf(dispatched.text);
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.text).toContain("SOLO-BG");
  });

  test("a multi-task call returns a ticket by default and delivers settled results", async () => {
    // SPEC v3 "Interaction grammar": a batch's trained default is
    // fire-and-forget — a ticket comes back immediately and the settled
    // result is delivered (here: pollable) without the caller blocking.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("BATCH-A"),
      fauxAssistantMessage("BATCH-B"),
    ]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "a" }, { prompt: "b" }],
    });

    expect(dispatched.isError).toBe(false);
    expect(objectOf(dispatched.details, "dispatched.details").async).toBe(true);
    const ticket = ticketIdOf(dispatched.text);

    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.isError).toBe(false);
    expect(settled.text).toContain("BATCH-A");
    expect(settled.text).toContain("BATCH-B");
  });

  test("async: false blocks a multi-task batch and returns inline results", async () => {
    // SPEC v3 "Interaction grammar": the override runs the other way too
    // — an explicit false keeps the batch synchronous.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("SYNC-A"),
      fauxAssistantMessage("SYNC-B"),
    ]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "a" }, { prompt: "b" }],
    });

    expect(result.isError).toBe(false);
    expect(objectOf(result.details, "result.details").async).toBe(false);
    expect(result.text).toContain("SYNC-A");
    expect(result.text).toContain("SYNC-B");
  });

  test("the tool description teaches the cardinality rule", async () => {
    // SPEC v3 "Surface rules": the description is the only channel that
    // reaches trained weights — the batch-backgrounds default must be
    // legible there.
    session = await openDelegateBoundary();
    const description = delegateTool(session).description;
    expect(description).toMatch(/single task/i);
    expect(description).toMatch(/multi-task|batch/i);
    expect(description).toMatch(/async: false/);
    const asyncField = (
      delegateTool(session).parameters as {
        properties: { async: { description: string } };
      }
    ).properties.async.description;
    expect(asyncField).toMatch(/single task/i);
    expect(asyncField).toMatch(/ticket/i);
  });
});

/**
 * SPEC v3 "Reflex meeting": trained incumbent agent names expand to
 * built-ins at resolution — exact, case-sensitive — and the expansion is
 * visible in the result so the caller learns the canonical name.
 */
describe("agent-name aliases (SPEC v3 Reflex meeting)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  const aliases: readonly [string, string][] = [
    ["general", "default"],
    ["general-purpose", "default"],
    ["worker", "default"],
    ["explore", "scout"],
    ["plan", "scout"],
    ["implement", "coder"],
  ];

  for (const [alias, canonical] of aliases) {
    test(`agent "${alias}" resolves to "${canonical}" with a visible expansion note`, async () => {
      // Explicit tools decouple the alias check from the default
      // profile's parent-tool mirroring.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage(`VIA-${canonical}`)]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "work", agent: alias, tools: ["read"] }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain(`VIA-${canonical}`);
      expect(result.text).toContain(`agent "${alias}" → "${canonical}"`);
    });
  }

  test("the expansion note appears in the settled ticket view", async () => {
    // The note rides the ticket's task metadata, so a poll after
    // settlement still teaches the canonical name.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("ALIased-OK")]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "general-purpose", tools: ["read"] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.text).toContain('agent "general-purpose" → "default"');
  });

  test("an unknown name after alias expansion errors with the available list", async () => {
    // SPEC v3 "Reflex meeting": names that survive expansion still error,
    // in one teachable round-trip that lists built-ins and their aliases.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", agent: "bogus-agent" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("unknown agent 'bogus-agent'");
    expect(result.text).toContain("scout");
    // The list annotates built-ins with their aliases — both directions
    // teach in one error.
    expect(result.text).toMatch(/default \(aliases:.*general/);
    expect(subagents.state.callCount).toBe(0);
  });

  test("alias matching is exact and case-sensitive — 'General' errors", async () => {
    // SPEC v3: no fuzzy matching; the trained names arrive lowercase.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", agent: "General" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("unknown agent 'General'");
    expect(subagents.state.callCount).toBe(0);
  });

  test("a configured model pin resolves against the canonical name", async () => {
    // SPEC v3 "Reflex meeting": models/modelsByParent are keyed by the
    // canonical name — `models.scout` applies to `agent: "explore"`.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { models: { scout: subagents.alt.spec } });
    subagents.alt.respond([fauxAssistantMessage("PINNED-ALT")]);
    subagents.respond([fauxAssistantMessage("UNPINNED-PRIMARY")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "explore" }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("PINNED-ALT");
    expect(result.text).toContain('agent "explore" → "scout"');
    expect(subagents.alt.state.callCount).toBe(1);
    expect(subagents.state.callCount).toBe(0);
  });
});

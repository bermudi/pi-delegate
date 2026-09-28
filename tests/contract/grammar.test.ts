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
    ["plan", "explore"],
    ["scout", "explore"],
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

  test("the expansion note appears on the async dispatch receipt (#39)", async () => {
    // The receipt is the only sync surface an async call has — the note
    // must appear at dispatch, not only in the delivered/settled views.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("RECEIPT-1"),
      fauxAssistantMessage("RECEIPT-2"),
    ]);

    // A multi-task batch is async by default — no explicit `async` needed.
    const dispatched = await callDelegate(session, {
      tasks: [
        { prompt: "work", agent: "scout" },
        { prompt: "more work", agent: "plan" },
      ],
    });

    expect(dispatched.isError).toBe(false);
    expect(dispatched.text).toContain('task-1: agent "scout" → "explore"');
    expect(dispatched.text).toContain('task-2: agent "plan" → "explore"');
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
    expect(result.text).toContain("explore");
    // The list annotates built-ins with their aliases — both directions
    // teach in one error.
    expect(result.text).toMatch(/default \(aliases:.*general/);
    expect(result.text).toMatch(/explore \(aliases:.*scout/);
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

  test('"explore" resolves as the built-in itself — no expansion note (#40)', async () => {
    // SPEC v3 "Reflex meeting": the trained read-only name IS the
    // canonical profile; calling it directly expands nothing.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("VIA-EXPLORE")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "explore", tools: ["read"] }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("VIA-EXPLORE");
    expect(result.text).not.toContain("→");
  });

  test("a configured model pin resolves against the canonical name", async () => {
    // SPEC v3 "Reflex meeting": models/modelsByParent are keyed by the
    // canonical name — `models.explore` applies to `agent: "scout"`.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { models: { explore: subagents.alt.spec } });
    subagents.alt.respond([fauxAssistantMessage("PINNED-ALT")]);
    subagents.respond([fauxAssistantMessage("UNPINNED-PRIMARY")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "scout" }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("PINNED-ALT");
    expect(result.text).toContain('agent "scout" → "explore"');
    expect(subagents.alt.state.callCount).toBe(1);
    expect(subagents.state.callCount).toBe(0);
  });

  test('a "models.scout" key fails loudly naming the new key (#40)', async () => {
    // SPEC v3 "Reflex meeting" + issue #40: config keys are contract —
    // the retired canonical is never silently mapped.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { models: { scout: "ghost-provider/model-x" } });

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", agent: "explore" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("models.scout is rejected");
    expect(result.text).toContain("models.explore");
    expect(subagents.state.callCount).toBe(0);
  });

  test('a "modelsByParent" scout key fails loudly naming the new key (#40)', async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, {
      modelsByParent: { "delegate-faux/faux-1": { scout: subagents.spec } },
    });

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", agent: "explore" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("scout is rejected");
    expect(result.text).toContain("explore");
    expect(subagents.state.callCount).toBe(0);
  });
});

/**
 * SPEC v3 "Reflex meeting" + issue #41: Claude-Code-shaped task fields —
 * `subagent_type`, `description`, `run_in_background` — are accepted
 * cross-harness spellings that normalize onto canonical fields at
 * validation, with each applied rename taught on the result/receipt as
 * `field "<field>" → "<to>"`. The schema still fails closed on fields it
 * does not know.
 */
describe("cross-harness field spellings (SPEC v3 Reflex meeting)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("a Claude-Code-shaped task normalizes subagent_type and labels by description", async () => {
    // The trained Task call {subagent_type, description, prompt}:
    // subagent_type folds into agent BEFORE resolution so the alias table
    // applies (general-purpose → default); description becomes the
    // section-head label without replacing the correlation id.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SHAPED-OK")]);

    const result = await callDelegate(session, {
      tasks: [
        {
          subagent_type: "general-purpose",
          description: "classify auth",
          prompt: "Classify the auth boundary",
          tools: ["read"],
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("SHAPED-OK");
    // One note per applied normalization, then the alias expansion it
    // enabled — the same teaching pattern as agent aliases.
    expect(result.text).toContain('field "subagent_type" → "agent"');
    expect(result.text).toContain('agent "general-purpose" → "default"');
    // The description is the section-head label, not the correlation id.
    expect(result.text).toContain("### Task classify auth — completed");
    expect(result.text).not.toContain("### Task task-1");
  });

  test("top-level run_in_background normalizes to async — a multi-task call returns a ticket", async () => {
    // SPEC v3 "Reflex meeting"/"Interaction grammar": identical to
    // `async: true` — a receipt immediately, settled results delivered.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("BG-A"),
      fauxAssistantMessage("BG-B"),
    ]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "a" }, { prompt: "b" }],
      run_in_background: true,
    });

    expect(dispatched.isError).toBe(false);
    expect(objectOf(dispatched.details, "dispatched.details").async).toBe(true);
    expect(dispatched.text).toContain('field "run_in_background" → "async"');
    const ticket = ticketIdOf(dispatched.text);

    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.isError).toBe(false);
    expect(settled.text).toContain("BG-A");
    expect(settled.text).toContain("BG-B");
  });

  test("per-task run_in_background normalizes to async and labels the ticket view", async () => {
    // Harnesses that carry the flag on each task emit this shape; the
    // receipt records the per-task normalization and the settled section
    // head prefers the description label.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("TASK-BG")]);

    const dispatched = await callDelegate(session, {
      tasks: [
        {
          prompt: "background me",
          run_in_background: true,
          description: "classify auth",
        },
      ],
    });

    expect(dispatched.isError).toBe(false);
    expect(objectOf(dispatched.details, "dispatched.details").async).toBe(true);
    expect(dispatched.text).toContain(
      'task-1: field "run_in_background" → "async"',
    );
    const ticket = ticketIdOf(dispatched.text);

    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.isError).toBe(false);
    // The description label rides the ticket's section headers — and the
    // normalization note persists there too (journal-carried).
    expect(settled.text).toContain("### Task classify auth — completed");
    expect(settled.text).toContain('field "run_in_background" → "async"');
  });

  test("run_in_background: false pins a batch synchronous, like async: false", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("SYNC-RIB-A"),
      fauxAssistantMessage("SYNC-RIB-B"),
    ]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "a" }, { prompt: "b" }],
      run_in_background: false,
    });

    expect(result.isError).toBe(false);
    expect(objectOf(result.details, "result.details").async).toBe(false);
    expect(result.text).toContain('field "run_in_background" → "async"');
    expect(result.text).toContain("SYNC-RIB-A");
  });

  test("agent + subagent_type naming different agents errors naming both fields", async () => {
    // SPEC v3 "Reflex meeting": the two spellings name one field —
    // agreement is fine, divergence is a whole-call error.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", agent: "coder", subagent_type: "explore" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("'agent'");
    expect(result.text).toContain("'subagent_type'");
    expect(result.text).toContain("coder");
    expect(result.text).toContain("explore");
    expect(subagents.state.callCount).toBe(0);
  });

  test("agent + subagent_type naming the same agent is accepted with the note", async () => {
    // Equal-after-alias spellings agree: alias expansion is shared, so
    // "scout" and "explore" are the same agent — no conflict.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("AGREE-OK")]);

    const result = await callDelegate(session, {
      tasks: [
        {
          prompt: "x",
          agent: "scout",
          subagent_type: "explore",
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("AGREE-OK");
    expect(result.text).toContain('field "subagent_type" → "agent"');
    expect(result.text).toContain('agent "scout" → "explore"');
  });

  test("async + run_in_background with conflicting values errors naming both fields", async () => {
    // SPEC v3 "Reflex meeting": explicit async wins only when they agree;
    // a value conflict fails the call before any task starts.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x" }],
      async: true,
      run_in_background: false,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("'async'");
    expect(result.text).toContain("'run_in_background'");
    expect(subagents.state.callCount).toBe(0);
  });

  test("async + run_in_background agreeing still runs, noting the rename", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("AGREE-BG")]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "x" }],
      async: true,
      run_in_background: true,
    });

    expect(dispatched.isError).toBe(false);
    expect(objectOf(dispatched.details, "dispatched.details").async).toBe(true);
    expect(dispatched.text).toContain('field "run_in_background" → "async"');
  });

  test("an unknown task field still fails closed at the schema boundary", async () => {
    // SPEC v3 "Reflex meeting": additionalProperties: false stays — only
    // the three named spellings were admitted; `priority` is not a task
    // field in any harness we accept.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", priority: 1 }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/priority|additional propert|unexpected/i);
    expect(subagents.state.callCount).toBe(0);
  });
});

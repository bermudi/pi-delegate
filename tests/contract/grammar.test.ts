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

/** #61: task count never changes the background default. */
describe("delegate interaction grammar (SPEC v3, #61)", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  for (const surface of ["full", "compact"] as const) {
    for (const count of [1, 2, 3]) {
      test(`${surface}: omitted async backgrounds ${count} task(s)`, async () => {
        session = await openDelegateBoundary({ surface });
        const subagents = await installSubagentModel(session);
        subagents.respond(Array.from({ length: count }, (_, i) =>
          fauxAssistantMessage(`BACKGROUND-${i}`),
        ));

        // Actual public arguments omit async; no helper supplies a default.
        const dispatched = await callDelegate(session, {
          tasks: Array.from({ length: count }, (_, i) => ({
            prompt: `task ${i}`, agent: "explore",
          })),
        });
        expect(dispatched.isError).toBe(false);
        expect(objectOf(dispatched.details, "details").async).toBe(true);
        const settled = await callDelegateTicket(session, {
          action: "wait", ticket: ticketIdOf(dispatched.text),
        });
        expect(settled.isError).toBe(false);
        for (let i = 0; i < count; i++) {
          expect(settled.text).toContain(`BACKGROUND-${i}`);
        }
        expect(subagents.state.callCount).toBe(count);
      });
    }
  }

  for (const count of [1, 2]) {
    test(`async:false returns ${count} task(s) inline`, async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond(Array.from({ length: count }, (_, i) =>
        fauxAssistantMessage(`INLINE-${i}`),
      ));
      const result = await callDelegate(session, {
        async: false,
        tasks: Array.from({ length: count }, (_, i) => ({ prompt: `task ${i}` })),
      });
      expect(result.isError).toBe(false);
      expect(objectOf(result.details, "details").async).toBe(false);
      for (let i = 0; i < count; i++) expect(result.text).toContain(`INLINE-${i}`);
    });
  }

  test("explicit async:true returns a ticket for a single task", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("EXPLICIT-BACKGROUND")]);
    const result = await callDelegate(session, {
      async: true, tasks: [{ prompt: "solo" }],
    });
    expect(result.isError).toBe(false);
    expect(objectOf(result.details, "details").async).toBe(true);
    const settled = await callDelegateTicket(session, {
      action: "wait", ticket: ticketIdOf(result.text), timeoutMs: 5000,
    });
    expect(settled.text).toContain("EXPLICIT-BACKGROUND");
  });

  test("the tool description teaches background default and explicit inline opt-in", async () => {
    session = await openDelegateBoundary();
    const tool = delegateTool(session);
    expect(tool.description).toMatch(/background|async/i);
    expect(tool.description).toContain("async: false");
    const asyncField = (tool.parameters as {
      properties: { async: { description: string } };
    }).properties.async.description;
    expect(asyncField).toMatch(/every nonempty|default/i);
    expect(asyncField).toMatch(/background/i);
    expect(asyncField).toContain("async: false");
    expect(asyncField).toMatch(/ticket/i);
  });
});

/** #61 replaces automatic name translations with exact profile lookup. */
describe("exact agent names (SPEC v3, #61)", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  for (const name of ["general", "general-purpose", "worker", "explorer", "plan", "scout", "implement", "General", "Explore"]) {
    test(`unauthored agent ${name} rejects the whole batch before execution`, async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "valid sibling", agent: "explore" }, { prompt: "x", agent: name }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`unknown agent '${name}'`);
      expect(result.text).toContain("default");
      expect(result.text).toContain("explore");
      expect(result.text).not.toContain("aliases:");
      expect(subagents.state.callCount).toBe(0);
    });
  }

  test("a canonical explore model pin remains effective without translation", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { models: { explore: subagents.alt.spec } });
    subagents.alt.respond([fauxAssistantMessage("PINNED-ALT")]);
    const result = await callDelegate(session, {
      async: false, tasks: [{ prompt: "work", agent: "explore" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("PINNED-ALT");
    expect(result.text).not.toContain("→");
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

/** Removed field presence rejects, including agreement and null. */
describe("canonical task fields (SPEC v3, #61)", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  for (const [field, canonical, value] of [
    ["subagent_type", "agent", "explore"],
    ["run_in_background", "async", true],
  ] as const) {
    for (const shape of ["task", "flat", "stringified", "top"] as const) {
      test(`${field} rejects in ${shape} calls even when agreeing or null`, async () => {
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        for (const aliasValue of [value, null]) {
          const task = { prompt: "work", [canonical]: value, [field]: aliasValue };
          const args = shape === "flat" ? task
            : shape === "top" ? { tasks: [{ prompt: "work" }], [canonical]: value, [field]: aliasValue }
            : { tasks: shape === "stringified" ? JSON.stringify([task]) : [{ prompt: "valid sibling" }, task] };
          const result = await callDelegate(session, args);
          expect(result.isError).toBe(true);
          expect(result.text).toContain(field);
          expect(result.text).toContain(canonical);
          expect(subagents.state.callCount).toBe(0);
        }
      });
    }
  }

  test("full-mode description labels output without replacing the correlation id", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("LABELED")]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [{ id: "correlation", description: "classify auth", prompt: "work", agent: "explore" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("### Task classify auth — completed");
    const results = objectOf(result.details, "details").results as { id: string }[];
    expect(results[0]!.id).toBe("correlation");
  });

  test("canonical flat, stringified, string-tools and null recovery still dispatch", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    for (const args of [
      { async: false, prompt: "flat", tools: "read", agent: null },
      { async: false, tasks: JSON.stringify([{ prompt: "encoded", tools: "read", id: null }]), brief: null },
    ]) {
      subagents.respond([fauxAssistantMessage("RECOVERED")]);
      const result = await callDelegate(session, args);
      expect(result.isError).toBe(false);
      expect(result.text).toContain("RECOVERED");
    }
    expect(subagents.state.callCount).toBe(2);
  });

  test("unknown task fields still fail closed", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const result = await callDelegate(session, { tasks: [{ prompt: "x", priority: 1 }] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/priority|additional propert|unexpected/i);
    expect(subagents.state.callCount).toBe(0);
  });

  // Issue #56 (third codex comparison): a caller asking for context
  // sharing via fork_turns/fork_context — or the history/parent_context
  // cousins — must not die on a bare additionalProperties wall. Each is
  // a known-foreign field: the rejection names it, restates the
  // no-inheritance invariant, and points at the batch brief.
  for (const field of ["fork_turns", "fork_context", "history", "parent_context"]) {
    test(`task-level ${field} rejects with brief-pointer teaching`, async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", [field]: 2 }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain(`The ${field} field is not accepted`);
      expect(result.text).toContain("never inherit this conversation");
      expect(result.text).toContain('"brief"');
      expect(subagents.state.callCount).toBe(0);
    });

    test(`top-level ${field} rejects with brief-pointer teaching`, async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x" }],
        [field]: 3,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain(`The ${field} field is not accepted`);
      expect(result.text).toContain("never inherit this conversation");
      expect(result.text).toContain('"brief"');
      expect(subagents.state.callCount).toBe(0);
    });
  }

  test("foreign context spellings reject under flat, stringified, and null shapes", async () => {
    // #56: the teaching fires wherever the field lands — a flat call
    // (fields fold into one task), a JSON-stringified tasks array, and a
    // null value (presence alone rejects, like the removed `context`).
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    for (const args of [
      { prompt: "flat", fork_turns: 5 },
      { tasks: JSON.stringify([{ prompt: "encoded", fork_context: true }]) },
      { tasks: [{ prompt: "x", history: null }] },
      { fork_turns: 2 },
    ]) {
      const result = await callDelegate(session, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/field is not accepted/);
      expect(result.text).toContain('"brief"');
    }
    expect(subagents.state.callCount).toBe(0);
  });
});

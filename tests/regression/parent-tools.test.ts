import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fauxAssistantMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";
import { join, resolve } from "node:path";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

import { mockParentTools } from "../support/parent-tools.ts";

// Issue #13 regression (v2 evidence, not a migrated v1 helper test): a
// degraded host tool probe must not silently give a restricted parent writers.
describe("regression: parent tool mirroring", () => {
  let session: TestSession | undefined;
  const restores: (() => void)[] = [];

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    session?.dispose();
    session = undefined;
  });

  function unavailableTools() {
    const mocked = mockParentTools(session!, () => {
      throw new Error("parent tool inventory unavailable");
    });
    restores.push(mocked.restore);
    return mocked.probe;
  }

  for (const async of [false, true]) {
    test(`mixed batch rejects before any child starts when parent tools throw (${async ? "async" : "sync"})`, async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("UNEXPECTED-CHILD"), fauxAssistantMessage("UNEXPECTED-CHILD")]);
      unavailableTools();
      const logged = spyOn(console, "error").mockImplementation(() => {});
      restores.push(() => logged.mockRestore());

      const result = await callDelegate(session, {
        async,
        tasks: [
          { prompt: "valid sibling must not start", agent: "explore" },
          { prompt: "requires parent tools", agent: "default" },
        ],
      });

      // Let an erroneously admitted async batch settle before checking starts.
      if (async && !result.isError) {
        await callDelegateTicket(session, { action: "wait", ticket: ticketIdOf(result.text) });
      }
      expect(subagents.state.callCount).toBe(0);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/default.*parent.*tools/i);
      expect(result.text).toContain("parent tool inventory unavailable");
      expect(result.text).toMatch(/explicit.*tools|restore.*parent/i);
      expect(subagents.state.callCount).toBe(0);
      expect(logged.mock.calls.flat().join(" ")).toContain("parent tool inventory unavailable");
      const roster = await callDelegateTicket(session, { action: "poll" });
      expect(roster.text).not.toContain("running");
    });
  }

  test("independent tool choices bypass unavailable parent tools", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const probe = unavailableTools();
    const cases = [
      { task: { agent: "default", tools: ["read"] }, tools: ["read"] },
      { task: { agent: "default", tools: [] }, tools: [] },
      { task: { agent: "explore", tools: [] }, tools: [] },
      { task: { tools: [] }, tools: [] },
      { task: { agent: "explore" }, tools: ["read", "grep", "find", "ls"] },
      { task: { agent: "coder" }, tools: ["read", "bash", "edit", "write"] },
      { task: { agent: "reviewer" }, tools: ["read", "bash"] },
      { task: {}, tools: ["read", "bash", "edit", "write"] },
    ];
    for (const { task, tools } of cases) {
      let observed: string[] | undefined;
      subagents.respond([(context) => {
        observed = getCurrentTools(context.messages).map((tool) => tool.name).sort();
        return fauxAssistantMessage("EXPECTED-CHILD");
      }]);
      const result = await callDelegate(session, { async: false, tasks: [{ prompt: "inspect capabilities", ...task }] });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("EXPECTED-CHILD");
      expect(observed).toEqual([...tools].sort());
    }
    expect(subagents.state.callCount).toBe(cases.length);
    expect(probe).not.toHaveBeenCalled();
  });

  test("default profile mirrors restricted parent tools", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const mocked = mockParentTools(session, () => ["read", "delegate"]);
    restores.push(mocked.restore);
    let observed: string[] | undefined;
    subagents.respond([(context) => {
      observed = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage("READ-ONLY-CHILD");
    }]);
    const result = await callDelegate(session, { async: false, tasks: [{ prompt: "inspect", agent: "default" }] });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("READ-ONLY-CHILD");
    expect(observed).toEqual(["read"]);
    expect(subagents.state.callCount).toBe(1);
  });

  // Independent review #13 (5722868479): a successful empty intersection
  // must stay empty, whether injected or produced by actual host tool limits.
  for (const inventory of [[], ["web_search", "delegate"]]) {
    test(`default profile preserves empty delegatable inventory: ${JSON.stringify(inventory)}`, async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const mocked = mockParentTools(session, () => inventory);
      restores.push(mocked.restore);
      let observed: string[] | undefined;
      subagents.respond([(context) => {
        observed = getCurrentTools(context.messages).map((tool) => tool.name);
        return fauxAssistantMessage("NO-TOOLS-CHILD");
      }]);
      const result = await callDelegate(session, { async: false, tasks: [{ prompt: "inspect", agent: "default" }] });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("NO-TOOLS-CHILD");
      expect(subagents.state.callCount).toBe(1);
      expect(observed).toEqual([]);
    });
  }

  test("default profile honors actual host restriction to the delegate tools", async () => {
    session = await createTestSession({
      extensions: [
        resolve(import.meta.dirname, "../../delegate.ts"),
        resolve(import.meta.dirname, "../support/restrict-parent-tools.ts"),
      ],
      propagateErrors: false,
    });
    session.session.sessionManager.getSessionDir = () => join(session!.cwd, "sessions", "--test--");
    const subagents = await installSubagentModel(session);
    let parent: string[] | undefined;
    let observed: string[] | undefined;
    subagents.respond([(context) => {
      parent = session!.session.getActiveToolNames();
      observed = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage("HOST-LIMITED-CHILD");
    }]);
    const result = await callDelegate(session, { async: false, tasks: [{ prompt: "inspect", agent: "default" }] });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("HOST-LIMITED-CHILD");
    expect(subagents.state.callCount).toBe(1);
    expect(parent).toEqual([
      "delegate",
      "delegate_ticket",
      "delegate_session",
    ]);
    expect(observed).toEqual([]);
  });
});

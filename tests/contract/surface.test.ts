import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate, callDelegateTicket, configureDelegate, delegateTool,
  installSubagentModel, objectOf, openDelegateBoundary, registeredTool, ticketIdOf,
} from "../support/pi-boundary.ts";

/**
 * ADR 0002: one tool surface. Every field the schema declares is always
 * advertised and always accepted; the former compact/full split and its
 * delegate.json "surface" key are gone. These tests pin the single
 * schema's shape, the single manual, the removed-key rejection, and the
 * omitted-async default that #61 established.
 */
describe("the single delegate surface", () => {
  const sessions: TestSession[] = [];
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
  });
  const open = async (): Promise<TestSession> => {
    const session = await openDelegateBoundary();
    sessions.push(session);
    return session;
  };
  const properties = (session: TestSession, tool = "delegate"): Record<string, unknown> =>
    objectOf(objectOf(registeredTool(session, tool).parameters).properties);

  test("the declared and executable schema is the single full vocabulary", async () => {
    const session = await open();
    const top = properties(session);
    expect(Object.keys(top).sort()).toEqual(["async", "brief", "tasks", "workspace"]);
    const task = objectOf(objectOf(top.tasks).items);
    expect(Object.keys(objectOf(task.properties)).sort()).toEqual([
      "agent", "cwd", "dependsOn", "description", "id", "prompt",
      "resumeFrom", "sessionId", "systemPrompt", "tools", "workspace",
    ]);
    expect(task.additionalProperties).toBe(false);
    expect(objectOf(delegateTool(session).parameters).additionalProperties).toBe(false);
    const ticket = properties(session, "delegate_ticket");
    expect(objectOf(ticket.action).enum).toEqual([
      "poll", "wait", "cancel", "answer", "steer", "interrupt",
    ]);
    // No cross-harness synonym is ever declared.
    for (const key of ["agent_type", "subagent_type", "task_name", "message", "run_in_background"]) {
      expect(objectOf(task.properties)[key]).toBeUndefined();
    }
    // The registered declaration and the executable tool agree (one
    // schema, not a documented facade over another).
    const actual = (session.session as AgentSession).getAllTools().find((tool) => tool.name === "delegate");
    expect(objectOf(actual?.parameters)).toEqual(objectOf(delegateTool(session).parameters));
    const names = (session.session as AgentSession).getAllTools().map((tool) => tool.name).filter((name) => name.startsWith("delegate"));
    expect(names.sort()).toEqual(["delegate", "delegate_session", "delegate_ticket"]);
    // No mode-wall teaching remains on any description.
    for (const tool of ["delegate", "delegate_ticket", "delegate_session"]) {
      expect(registeredTool(session, tool).description).not.toContain('"surface"');
    }
  });

  test("the manual is single-edition: every control it names is callable, no surface delta exists", async () => {
    const session = await open();
    const manual = await callDelegate(session, { tasks: [] });
    for (const section of [
      "## Interfaces",
      "## delegate — ordinary dispatch",
      "## delegate — task and batch controls",
      "## Models, profiles, and context",
      "## Workspaces",
      "## delegate_ticket — tickets",
      "## delegate_session — sessions",
      "## Telemetry",
    ]) {
      expect(manual.text).toContain(section);
    }
    // The compact/full machinery is gone from the manual entirely.
    expect(manual.text).not.toContain("Current surface");
    expect(manual.text).not.toContain("Full surface adds");
    expect(manual.text).not.toContain("full-mode controls");
    // Recovery affordances are taught unconditionally.
    expect(manual.text).toContain("sessionId");
    expect(manual.text).toContain("resumeFrom");
    expect(manual.text).toContain("dependsOn");
  });

  test("a supplied \"surface\" config key rejects loudly at config load, before any task runs", async () => {
    const session = await open();
    configureDelegate(session, { surface: "full" } as Record<string, unknown>);
    const subagents = await installSubagentModel(session);
    const rejected = await callDelegate(session, { tasks: [{ prompt: "must not run" }] });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("surface");
    expect(rejected.text).toContain("removed");
    expect(subagents.state.callCount).toBe(0);
    // Removing the key restores ordinary operation.
    configureDelegate(session, {});
    expect((await callDelegateTicket(session, { action: "poll" })).isError).toBe(false);
  });

  test("advanced task fields are accepted members of the one schema", async () => {
    // The former compact rejections inverted (ADR 0002): fields like
    // sessionId/dependsOn/id are ordinary schema members. Schema-level
    // acceptance is asserted here; execution semantics live in their
    // own suites.
    const session = await open();
    const task = objectOf(objectOf(objectOf(properties(session).tasks).items).properties);
    for (const key of ["id", "tools", "systemPrompt", "dependsOn", "sessionId", "resumeFrom", "description"]) {
      expect(task[key]).toBeDefined();
    }
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("FULL-OVERRIDE")]);
    const result = await callDelegate(session, {
      async: false, tasks: [{ prompt: "custom", tools: [], systemPrompt: "one-off base" }],
    });
    expect(result.text).toContain("FULL-OVERRIDE");
  });

  test("malformed supplied tasks cannot hide aliases behind flat recovery", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    for (const tasks of [
      { prompt: "discarded", agent_type: null },
      '{"prompt":"discarded","agent_type":null}',
      "not JSON", 42,
    ]) {
      const result = await callDelegate(session, {
        tasks, prompt: "retained", async: false,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/agent_type|tasks.*array/i);
    }
    expect(subagents.state.callCount).toBe(0);
  });

  test("a named profile's tools and body are used without repeating configuration", async () => {
    const session = await open();
    mkdirSync(join(session.cwd, "agents"));
    writeFileSync(join(session.cwd, "agents", "scout.md"),
      "---\nname: scout\ndescription: authored scout\ntools: read\n---\nPROFILE-BASE\n");
    const subagents = await installSubagentModel(session);
    let observed = "";
    let tools: string[] = [];
    subagents.respond([(context) => {
      observed = JSON.stringify(context.messages);
      const system = context.messages.find((message) => message.role === "system");
      const added: unknown = system === undefined ? [] : objectOf(system).toolsAdded;
      if (Array.isArray(added)) tools = added.map((tool: unknown) => {
        const name = objectOf(tool).name;
        if (typeof name !== "string") throw new Error("Expected a named tool declaration.");
        return name;
      });
      return fauxAssistantMessage("PROFILE-RESULT");
    }]);
    const result = await callDelegate(session, {
      async: false, tasks: [{ prompt: "investigate", agent: "scout" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("PROFILE-RESULT");
    expect(observed).toContain("PROFILE-BASE");
    expect(tools).toEqual(["read"]);
  });

  test("an authored global scout profile is a valid exact-name model pin", async () => {
    const session = await open();
    mkdirSync(join(session.cwd, "agents"));
    writeFileSync(join(session.cwd, "agents", "scout.md"),
      "---\nname: scout\ndescription: authored scout\ntools: read\n---\nAUTHORED-SCOUT\n");
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { models: { scout: subagents.alt.spec } });
    subagents.alt.respond([fauxAssistantMessage("EXACT-PIN")]);
    const result = await callDelegate(session, {
      async: false, tasks: [{ prompt: "investigate", agent: "scout" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("EXACT-PIN");
    expect(subagents.state.callCount).toBe(0);
    expect(subagents.alt.state.callCount).toBe(1);
  });

  test("omitted async returns before a gated worker finishes", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    subagents.respond([async () => {
      await gate;
      finished = true;
      return fauxAssistantMessage("GATED-RESULT");
    }]);
    try {
      const dispatched = await callDelegate(session, { tasks: [{ prompt: "gated", agent: "explore" }] });
      expect(dispatched.isError).toBe(false);
      expect(finished).toBe(false);
      release();
      const settled = await callDelegateTicket(session, { action: "wait", ticket: ticketIdOf(dispatched.text) });
      expect(settled.text).toContain("GATED-RESULT");
    } finally {
      release();
    }
  });

  test("identical unkeyed dispatches execute independently (#130: operationId removed)", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("FIRST-RUN"),
      fauxAssistantMessage("SECOND-RUN"),
    ]);
    const args = { tasks: [{ prompt: "work", agent: "explore" }] };
    const first = await callDelegate(session, { ...args, async: false });
    const second = await callDelegate(session, { ...args, async: false });
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    // No dedup layer exists: identical requests are two executions by
    // design, and a supplied operationId rejects with teaching.
    expect(subagents.state.callCount).toBe(2);
    const rejected = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "explore" }], operationId: "retry",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("operationId field has been removed");
  });
});

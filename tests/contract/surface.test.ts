import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate, callDelegateTicket, configureDelegate, delegateTool,
  installSubagentModel, objectOf, openDelegateBoundary, registeredTool, ticketIdOf,
} from "../support/pi-boundary.ts";

/** #61: operator-selected schemas change exposure, not the execution engine. */
describe("compact/full delegate surface", () => {
  const sessions: TestSession[] = [];
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
  });
  const open = async (surface: "compact" | "full" = "compact"): Promise<TestSession> => {
    const session = await openDelegateBoundary({ surface });
    sessions.push(session);
    return session;
  };
  const properties = (session: TestSession, tool = "delegate"): Record<string, unknown> =>
    objectOf(objectOf(registeredTool(session, tool).parameters).properties);

  test("missing config selects a genuinely compact declared and executable schema", async () => {
    const session = await open();
    const top = properties(session);
    expect(Object.keys(top).sort()).toEqual(["async", "brief", "tasks", "workspace"]);
    const task = objectOf(objectOf(top.tasks).items);
    expect(Object.keys(objectOf(task.properties)).sort()).toEqual(["agent", "cwd", "prompt", "workspace"]);
    expect(task.required).toEqual(["prompt"]);
    expect(task.additionalProperties).toBe(false);
    expect(objectOf(delegateTool(session).parameters).additionalProperties).toBe(false);
    const ticket = properties(session, "delegate_ticket");
    expect(Object.keys(ticket).sort()).toEqual([
      "action", "answer", "force", "message", "questionId", "taskId", "ticket",
    ]);
    expect(objectOf(ticket.action).enum).toEqual(["poll", "wait", "cancel", "answer", "steer", "interrupt"]);
    const actual = (session.session as AgentSession).getAllTools().find((tool) => tool.name === "delegate");
    expect(objectOf(actual?.parameters)).toEqual(objectOf(delegateTool(session).parameters));
    expect(delegateTool(session).description).toContain('"surface": "full"');
    const manual = await callDelegate(session, { tasks: [] });
    expect(manual.text).toContain("Current surface: compact");
    expect(manual.text).toContain("/reload");
  });

  test("the compact manual documents only compact-accepted controls and signposts the full delta", async () => {
    // #64: a compact caller reading about a full-only control would issue a
    // call the schema rejects — the manual it sees must not name them as
    // usable. The delta is still signposted so the opt-in is discoverable.
    const session = await open();
    const manual = await callDelegate(session, { tasks: [] });
    expect(manual.text).toContain("Current surface: compact");
    for (const section of [
      "## delegate — ordinary dispatch",
      "## Models, profiles, and context",
      "## Workspaces",
      "## delegate_ticket — tickets",
      "## delegate_session — sessions",
      "## Telemetry",
    ]) {
      expect(manual.text).toContain(section);
    }
    // No full-only control is documented as callable.
    expect(manual.text).not.toContain("## delegate — full-mode controls");
    expect(manual.text).not.toContain('action: "pause"');
    expect(manual.text).not.toContain('"pause" | "resume"');
    expect(manual.text).not.toContain('action: "tail"');
    expect(manual.text).not.toContain("steerId?");
    expect(manual.text).not.toContain("watches several");
    expect(manual.text).not.toContain("`timeoutMs`");
    expect(manual.text).not.toContain("char offset into");
    // The closing line names what full adds and how to enable it.
    expect(manual.text).toContain("Full surface adds:");
    expect(manual.text).toContain('"surface": "full"');
  });

  test("the full manual keeps the full-mode controls and every ticket action", async () => {
    const session = await open("full");
    const manual = await callDelegate(session, { tasks: [] });
    expect(manual.text).toContain("Current surface: full");
    expect(manual.text).toContain("## delegate — full-mode controls");
    expect(manual.text).toContain('"pause" | "resume"');
    expect(manual.text).toContain('action: "tail"');
    expect(manual.text).toContain("steerId");
    expect(manual.text).toContain("watches several");
    expect(manual.text).not.toContain("Full surface adds:");
  });

  test("full selection changes declarations without introducing extra tool names", async () => {
    const compact = await open();
    const full = await open("full");
    expect(properties(compact).tokenBudget).toBeUndefined();
    expect(properties(full).tokenBudget).toBeDefined();
    const fullTask = objectOf(objectOf(objectOf(properties(full).tasks).items).properties);
    for (const key of ["id", "tools", "systemPrompt", "deadlineMs", "dependsOn", "sessionId", "resumeFrom", "description"]) {
      expect(fullTask[key]).toBeDefined();
    }
    for (const key of ["agent_type", "subagent_type", "task_name", "message", "run_in_background"]) {
      expect(fullTask[key]).toBeUndefined();
    }
    expect(properties(full, "delegate_ticket").timeoutMs).toBeDefined();
    const names = (full.session as AgentSession).getAllTools().map((tool) => tool.name).filter((name) => name.startsWith("delegate"));
    expect(names.sort()).toEqual(["delegate", "delegate_session", "delegate_ticket"]);
    const subagents = await installSubagentModel(full);
    subagents.respond([fauxAssistantMessage("FULL-OVERRIDE")]);
    const result = await callDelegate(full, {
      async: false, tasks: [{ prompt: "custom", tools: [], systemPrompt: "one-off base" }],
    });
    expect(result.text).toContain("FULL-OVERRIDE");
    expect(properties(compact).operationId).toBeUndefined();
  });

  test("compact rejects every advanced task field before any sibling starts", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    for (const [field, value] of [
      ["id", "a"], ["description", "label"], ["tools", []], ["systemPrompt", "custom"],
      ["deadlineMs", 100], ["sessionId", "pooled"], ["resumeFrom", "/missing.jsonl"], ["dependsOn", []],
    ] as const) {
      for (const input of [value, null]) {
        const result = await callDelegate(session, {
          tasks: [{ prompt: "valid", agent: "explore" }, { prompt: "hidden", [field]: input }],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(field);
        expect(result.text).toContain('"surface": "full"');
      }
    }
    for (const args of [
      { prompt: "flat", tools: "ro" },
      { tasks: JSON.stringify([{ prompt: "encoded", systemPrompt: "hidden" }]) },
      { tasks: [{ prompt: "budget" }], tokenBudget: 1 },
      { tasks: [{ prompt: "keyed" }], operationId: "retry" },
    ]) {
      const result = await callDelegate(session, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('"surface": "full"');
    }
    expect(subagents.state.callCount).toBe(0);
  });

  test("compact rejects advanced ticket fields and actions, but polling stays immediate", async () => {
    const session = await open();
    for (const field of ["timeoutMs", "tickets", "steerId", "offset", "waitMs"]) {
      const result = await callDelegateTicket(session, { action: "poll", [field]: null });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('"surface": "full"');
    }
    for (const action of ["pause", "resume", "tail"]) {
      const result = await callDelegateTicket(session, { action, ticket: "unknown" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('"surface": "full"');
    }
    expect((await callDelegateTicket(session, { action: "poll" })).isError).toBe(false);
  });

  test("a compact failure view's resume hint names the full-surface requirement", async () => {
    // resumeFrom is a full-mode field: a compact caller following a bare
    // resumeFrom hint would hit the boundary rejection, so the hint names
    // the requirement instead. Full mode keeps the copy-pasteable call.
    const session = await open();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider blew up",
      }),
    ]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "fail" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("session: ");
    expect(result.text).toContain("→ To retry:");
    expect(result.text).toContain("requires the full delegate surface");
    expect(result.text).toContain('"surface": "full"');
    expect(result.text).toContain("resumeFrom");
  });

  test("malformed supplied tasks cannot hide aliases behind flat recovery", async () => {
    for (const surface of ["compact", "full"] as const) {
      const session = await open(surface);
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
    }
  });

  test("compact uses a named profile's tools and body without repeating configuration", async () => {
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
    const session = await open("full");
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

  test("surface edits require reload and invalid selection fails visibly rather than widening access", async () => {
    const session = await open();
    configureDelegate(session, { surface: "full" });
    expect(properties(session).operationId).toBeUndefined();
    expect((await callDelegate(session, { tasks: [{ prompt: "hidden", tools: [] }] })).isError).toBe(true);
    await (session.session as AgentSession).reload();
    expect(properties(session).operationId).toBeDefined();
    configureDelegate(session, { surface: "typo" });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await (session.session as AgentSession).reload();
      expect(log.mock.calls.flat().join(" ")).toContain("surface selection failed");
      expect(properties(session).operationId).toBeUndefined();
      const rejected = await callDelegate(session, { tasks: [{ prompt: "must not run" }] });
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain('surface must be "compact" or "full"');
    } finally {
      log.mockRestore();
    }
    configureDelegate(session, { surface: "compact" });
    await (session.session as AgentSession).reload();
    expect((await callDelegateTicket(session, { action: "poll" })).isError).toBe(false);
  });

  test("omitted async returns before a gated worker finishes, in both schema modes", async () => {
    for (const surface of ["compact", "full"] as const) {
      const session = await open(surface);
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
    }
  });

  test("omitted async and explicit true share an operation; false conflicts", async () => {
    const session = await open("full");
    const subagents = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    subagents.respond([async () => {
      await gate;
      return fauxAssistantMessage("ONE-OPERATION");
    }]);
    const args = {
      operationId: "stable-default", tasks: [{ prompt: "work", agent: "explore" }],
    };
    try {
      const first = await callDelegate(session, args);
      const second = await callDelegate(session, { ...args, async: true });
      expect(ticketIdOf(second.text)).toBe(ticketIdOf(first.text));
      const conflict = await callDelegate(session, { ...args, async: false });
      expect(conflict.isError).toBe(true);
      expect(conflict.text).toMatch(/different dispatch request|already bound/i);
      release();
      const settled = await callDelegateTicket(session, { action: "wait", ticket: ticketIdOf(first.text) });
      expect(settled.text).toContain("ONE-OPERATION");
      expect(subagents.state.callCount).toBe(1);
    } finally {
      release();
    }
  });
});

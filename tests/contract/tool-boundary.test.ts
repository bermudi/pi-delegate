import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  callDelegateSession,
  callDelegateTicket,
  delegateTool,
  objectOf,
  openDelegateBoundary,
  registeredTool,
} from "../support/pi-boundary.ts";

describe("delegate public tool contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("registers three tools with human-facing metadata", async () => {
    session = await openDelegateBoundary();
    const dispatch = delegateTool(session);
    const ticket = registeredTool(session, "delegate_ticket");
    const sessionTool = registeredTool(session, "delegate_session");

    expect(dispatch.name).toBe("delegate");
    expect(dispatch.label).toBe("Delegate to Subagents");
    expect(ticket.name).toBe("delegate_ticket");
    expect(ticket.label).toBe("Delegate Tickets");
    expect(sessionTool.name).toBe("delegate_session");
    expect(sessionTool.label).toBe("Delegate Sessions");
    for (const tool of [dispatch, ticket, sessionTool]) {
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.promptSnippet?.trim().length).toBeGreaterThan(0);
    }
  });

  test("delegate's prompt guidance names its workflow rules", async () => {
    session = await openDelegateBoundary();
    const guidelines = delegateTool(session).promptGuidelines ?? [];
    expect(guidelines.length).toBe(7);
    expect(guidelines.join(" ")).toMatch(/never see|self-contained/i);
    // #45: the nesting rule is spoken at the parent boundary (manual-only
    // teaching never reaches the models that need it — the failure lands
    // inside the child, invisible to misfire telemetry).
    expect(guidelines.join(" ")).toMatch(/cannot delegate further/);
    expect(guidelines.join(" ")).toMatch(/ask_parent/);
    expect(guidelines.join(" ")).toMatch(/poll/i);
    expect(guidelines.join(" ")).toMatch(/isolated/);
    // #121: the size rule is now a hard cap, not truncation — guidance
    // must teach the limit and the file-reference remedy.
    expect(guidelines.join(" ")).toMatch(/32,?768/);
    expect(guidelines.join(" ")).toMatch(/reference files by path/i);
    expect(guidelines.join(" ")).toMatch(/yourself/i);
    expect(guidelines.join(" ")).toMatch(/final message/i);
    expect(guidelines.join(" ")).toMatch(/Parallelize reads/);
    // #126: the fan-out decision procedure is its own guideline — the old
    // "keep edits to one writer" advice contradicted the isolated remedy.
    expect(guidelines.join(" ")).toMatch(/2\+ write-capable tasks/);
    expect(guidelines.join(" ")).toMatch(/workspace "isolated"/);
    expect(guidelines.join(" ")).toMatch(/dependsOn chain/);
    expect(guidelines.join(" ")).not.toMatch(/one writer where possible/);
  });

  test("publishes the canonical operation and task fields", async () => {
    session = await openDelegateBoundary();
    const dispatch = objectOf(delegateTool(session).parameters, "delegate schema");
    const top = objectOf(dispatch.properties, "top-level properties");
    const tasks = objectOf(top.tasks, "tasks schema");
    const task = objectOf(tasks.items, "task schema");
    const taskFields = objectOf(task.properties, "task properties");

    // Full mode exposes all canonical controls, without compatibility spellings.
    expect(Object.keys(top).sort()).toEqual(
      [
        "async",
        "brief",
        "operationId",
        "tasks",
        "workspace",
      ].sort(),
    );

    // Profile overrides and workflow controls remain available in full mode.
    expect(Object.keys(taskFields).sort()).toEqual(
      [
        "agent",
        "cwd",
        "dependsOn",
        "description",
        "id",
        "prompt",
        "resumeFrom",
        "sessionId",
        "systemPrompt",
        "tools",
        "workspace",
      ].sort(),
    );

    const ticket = objectOf(
      registeredTool(session, "delegate_ticket").parameters,
      "ticket schema",
    );
    expect(Object.keys(objectOf(ticket.properties)).sort()).toEqual(
      [
        "action",
        "answer",
        "force",
        "message",
        "offset",
        "questionId",
        "steerId",
        "taskId",
        "ticket",
        "tickets",
        "timeoutMs",
        "waitMs",
      ].sort(),
    );

    const sessionSchema = objectOf(
      registeredTool(session, "delegate_session").parameters,
      "session schema",
    );
    expect(Object.keys(objectOf(sessionSchema.properties)).sort()).toEqual(
      ["action", "sessionId"].sort(),
    );
  });

  test("publishes closed control and workspace values", async () => {
    session = await openDelegateBoundary();
    const dispatch = objectOf(delegateTool(session).parameters);
    const top = objectOf(dispatch.properties);
    const tasks = objectOf(top.tasks);
    const task = objectOf(tasks.items);
    const fields = objectOf(task.properties);

    const ticket = objectOf(
      registeredTool(session, "delegate_ticket").parameters,
    );
    expect(objectOf(objectOf(ticket.properties).action).enum).toEqual([
      "poll",
      "wait",
      "cancel",
      "pause",
      "resume",
      "answer",
      "steer",
      "interrupt",
      "tail",
    ]);
    const sessionSchema = objectOf(
      registeredTool(session, "delegate_session").parameters,
    );
    expect(objectOf(objectOf(sessionSchema.properties).action).enum).toEqual(
      ["list", "close"],
    );
    expect(objectOf(fields.workspace).enum).toEqual([
      "shared",
      "scratch",
      "isolated",
    ]);
    expect(objectOf(top.workspace).enum).toEqual([
      "shared",
      "scratch",
      "isolated",
    ]);
    expect(fields.context).toBeUndefined();
  });

  test("keeps removed controls outside the public schema", async () => {
    session = await openDelegateBoundary();
    const schema = objectOf(delegateTool(session).parameters);
    const top = objectOf(schema.properties);
    const tasks = objectOf(top.tasks);
    const task = objectOf(tasks.items);
    const taskFields = objectOf(task.properties);

    expect(top.action).toBeUndefined();
    expect(top.unsafeSharedWrites).toBeUndefined();
    expect(top.ticketAction).toBeUndefined();
    expect(top.sessionAction).toBeUndefined();
    expect(top.ticket).toBeUndefined();
    expect(top.sessionId).toBeUndefined();
    expect(top.timeoutMs).toBeUndefined();
    expect(top.force).toBeUndefined();
    expect(taskFields.async).toBeUndefined();
    expect(taskFields.operationId).toBeUndefined();
    expect(taskFields.sessionAction).toBeUndefined();
    expect(taskFields.unsafeSharedWrites).toBeUndefined();
  });

  test("returns help for both omitted and empty tasks", async () => {
    for (const arguments_ of [{}, { tasks: [] }]) {
      session?.dispose();
      session = await openDelegateBoundary();
      const result = await callDelegate(session, arguments_);
      expect(result.isError).toBe(false);
      expect(result.text).toContain("Delegate Manual");
      expect(result.text).toContain("delegate_ticket");
      expect(result.text).toContain("delegate_session");
    }
  });

  test("rejects orphaned operation fields instead of falling into help", async () => {
    const invalidCalls: Record<string, unknown>[] = [
      { async: true },
      { tasks: [], async: true },
      { tasks: [{ prompt: "x" }], sessionId: "s" },
    ];

    for (const arguments_ of invalidCalls) {
      session?.dispose();
      session = await openDelegateBoundary();
      const result = await callDelegate(session, arguments_);

      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("Delegate Manual");
    }
  });

  test("does not misclassify roster operations as help", async () => {
    // A bare ticket poll answers with the empty roster rather than the
    // manual or an error.
    session = await openDelegateBoundary();
    const polled = await callDelegateTicket(session, { action: "poll" });
    expect(polled.isError).toBe(false);
    expect(polled.text).not.toContain("Delegate Manual");

    // Session list answers with the empty session roster.
    session?.dispose();
    session = await openDelegateBoundary();
    const listed = await callDelegateSession(session, { action: "list" });
    expect(listed.isError).toBe(false);
    expect(listed.text).not.toContain("Delegate Manual");
  });
});

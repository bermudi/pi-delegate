import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  callDelegateSession,
  callDelegateTicket,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

describe("regression: malformed provider calls recover at the public boundary", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  async function call(
    arguments_: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly isError: boolean }> {
    // Fresh session per call keeps each case independent — no shared
    // transcript, ticket store, or extension state between calls.
    session?.dispose();
    session = await openDelegateBoundary();
    return callDelegate(session, arguments_);
  }

  async function callTicket(
    arguments_: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly isError: boolean }> {
    session?.dispose();
    session = await openDelegateBoundary();
    return callDelegateTicket(session, arguments_);
  }

  async function callSession(
    arguments_: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly isError: boolean }> {
    session?.dispose();
    session = await openDelegateBoundary();
    return callDelegateSession(session, arguments_);
  }

  test("recovers a JSON-stringified task array", async () => {
    const result = await call({
      tasks: '[{"prompt":"inspect"}]',
      async: true,
    });
    expect(result.text).not.toContain("Validation failed");
  });

  test("accepts flat task fields after boundary recovery", async () => {
    const result = await call({
      prompt: "inspect",
      tools: '["read","grep"]',
      async: true,
    });
    expect(result.text).not.toContain("Validation failed");
  });

  test("accepts a bare tool group after boundary recovery", async () => {
    const result = await call({
      tasks: [{ prompt: "inspect", tools: "ro" }],
    });
    expect(result.text).not.toContain("Validation failed");
  });

  test("does not reinterpret foreign dispatch fields as ticket or session work", async () => {
    const ticket = await callTicket({
      action: "poll",
      prompt: "stray",
    });
    expect(ticket.isError).toBe(true);
    expect(ticket.text).toContain("delegate(");
    expect(ticket.text).not.toContain("dispatch is not implemented");

    const sessionControl = await callSession({
      action: "close",
      sessionId: "review",
      prompt: "stray",
    });
    expect(sessionControl.isError).toBe(true);
    expect(sessionControl.text).toContain("delegate(");
    expect(sessionControl.text).not.toContain("dispatch is not implemented");
  });

  test("treats a bare sessionId as task reuse intent", async () => {
    const result = await call({
      sessionId: "review",
      prompt: "continue",
    });
    expect(result.text).not.toContain("Validation failed");
  });

  test("leaves ambiguous malformed strings for schema rejection", async () => {
    const invalidTasks = await call({
      tasks: "not json",
    });
    expect(invalidTasks.isError).toBe(true);
    expect(invalidTasks.text).toContain("Validation failed");
    expect(invalidTasks.text).not.toContain("dispatch is not implemented");

    // v1: the schema rejected the ambiguous tools string outright. pi-ai's
    // typebox 1.x validator now coerces it to ["read, write"] before our
    // semantics run, so prepareArguments rejects it pre-coercion instead
    // (found in the #10 review): still a whole-call failure with actionable
    // guidance, never a degraded "unknown tool" error.
    const invalidTools = await call({
      tasks: [{ prompt: "inspect", tools: "read, write" }],
    });
    expect(invalidTools.isError).toBe(true);
    expect(invalidTools.text).toContain("tools");
    expect(invalidTools.text).not.toContain("unknown tool");
    expect(invalidTools.text).not.toContain("dispatch is not implemented");
  });

  test("rejects string-typed boolean and number fields instead of coercing them", async () => {
    // The host's Value.Convert would silently turn these into true/123/1000
    // and run the call; SPEC's repair list does not include them, so they
    // must fail the whole call at the boundary (v1 rejected them by
    // schema). Regression found in the #10 review.
    const force = await callTicket({
      action: "cancel",
      ticket: "t-1",
      force: "true",
    });
    expect(force.isError).toBe(true);
    expect(force.text).toContain("'force'");

    const timeout = await callTicket({
      action: "wait",
      ticket: "t-1",
      timeoutMs: "123",
    });
    expect(timeout.isError).toBe(true);
    expect(timeout.text).toContain("'timeoutMs'");

    const deadline = await call({
      tasks: [{ prompt: "inspect", deadlineMs: "1000" }],
    });
    expect(deadline.isError).toBe(true);
    expect(deadline.text).toContain("'deadlineMs'");
  });
});

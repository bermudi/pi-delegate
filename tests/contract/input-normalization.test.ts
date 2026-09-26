import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateSession,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

// Boundary input normalization (issue #27): null means "not given" at every
// level, blank means "not given" for optional identifiers only, and fields
// owned by a sibling tool answer with guidance that names the tool and shows
// an example call built from what the caller sent.
describe("input normalization contract", () => {
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

  // ── null means "not given" ────────────────────────────────────────────────

  test("a null operationId dispatches normally", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("NULL-OPID")]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "run" }],
      operationId: null,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("NULL-OPID");
  });

  test("task-level null fields are stripped before dispatch", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("NULL-FIELDS")]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "run", sessionId: null, cwd: null, agent: null }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("NULL-FIELDS");
  });

  test("poll with ticket:null lists the roster", async () => {
    const result = await callTicket({ action: "poll", ticket: null });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/no|none|empty/i);
  });

  test("wait with ticket:null reports the missing required field", async () => {
    const result = await callTicket({ action: "wait", ticket: null });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/ticket/i);
  });

  // ── blank means "not given" for optional identifiers only ─────────────────

  test("a blank ticket on poll lists the roster", async () => {
    const result = await callTicket({ action: "poll", ticket: "   " });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/no|none|empty/i);
  });

  test("a blank answer on a non-answer action stays a malformed call", async () => {
    // Blank means "not given" for optional identifiers, but `answer` is a
    // payload: present-but-empty is invalid, never an absent field.
    const result = await callTicket({ action: "poll", answer: "" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('answer is valid only with action "answer"');
  });

  test("a blank sessionId on close reports the required field", async () => {
    const result = await callSession({ action: "close", sessionId: "  " });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/sessionId/i);
  });

  test("a blank task sessionId runs as a one-shot task", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("ONE-SHOT")]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "run", sessionId: "   " }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("ONE-SHOT");
  });

  test("blank task id, prompt, and systemPrompt remain invalid", async () => {
    const blankId = await call({ tasks: [{ id: "  ", prompt: "x" }] });
    expect(blankId.isError).toBe(true);
    const blankPrompt = await call({ tasks: [{ prompt: "  " }] });
    expect(blankPrompt.isError).toBe(true);
    // A schema-completing model's systemPrompt:"" must fail loudly — a
    // blank override would otherwise silently erase the profile's prompt.
    const blankSystemPrompt = await call({
      tasks: [{ prompt: "x", systemPrompt: " " }],
    });
    expect(blankSystemPrompt.isError).toBe(true);
    expect(blankSystemPrompt.text).toMatch(/systemPrompt/);
  });

  // ── cross-tool guidance: pre-split field names ────────────────────────────

  test("pre-split ticket fields on delegate point at delegate_ticket", async () => {
    for (const [arguments_, example] of [
      [
        { ticketAction: "poll", ticket: "t-1" },
        'delegate_ticket({ action: "poll", ticket: "t-1" })',
      ],
      [
        { ticket: "t-1" },
        'delegate_ticket({ action: "poll", ticket: "t-1" })',
      ],
      [{ force: true }, 'delegate_ticket({ action: "cancel", force: true })'],
      [
        { taskId: "t", questionId: "q", answer: "a" },
        'delegate_ticket({ action: "answer", taskId: "t", questionId: "q", answer: "a" })',
      ],
    ] as const) {
      const result = await call(arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("delegate_ticket");
      expect(result.text).toContain(example);
    }
  });

  test("pre-split sessionAction on delegate points at delegate_session", async () => {
    const result = await call({ sessionAction: "list" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("delegate_session");
    expect(result.text).toContain('delegate_session({ action: "list" })');
  });

  test("timeoutMs on delegate explains bounded waits live on delegate_ticket", async () => {
    const result = await call({
      tasks: [{ prompt: "x" }],
      timeoutMs: 5000,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot be bounded|waits for every task/i);
    expect(result.text).toContain('delegate_ticket({ action: "wait"');
    expect(result.text).toContain("timeoutMs: 5000");
  });

  test("a bare action field on delegate names both siblings", async () => {
    const result = await call({ action: "poll" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("delegate_ticket");
    expect(result.text).toContain("delegate_session");
  });

  test("guidance examples never echo an invalid action back", async () => {
    // An example must be followable: a bogus or blank selector value is
    // clamped to a valid action rather than repeated verbatim.
    const ticket = await callTicket({ ticketAction: "bogus" });
    expect(ticket.isError).toBe(true);
    expect(ticket.text).toContain("delegate_ticket");
    expect(ticket.text).not.toContain("bogus");

    const sessionResult = await callSession({ sessionAction: "bogus" });
    expect(sessionResult.isError).toBe(true);
    expect(sessionResult.text).toContain(
      'delegate_session({ action: "list" })',
    );
    expect(sessionResult.text).not.toContain("bogus");
  });

  test("a sibling tool's action value routes there", async () => {
    // A correct-shaped call aimed at the wrong tool gets named guidance,
    // not a bare enum rejection.
    const sessionAction = await callTicket({ action: "list" });
    expect(sessionAction.isError).toBe(true);
    expect(sessionAction.text).toContain("delegate_session");

    const ticketAction = await callSession({ action: "poll" });
    expect(ticketAction.isError).toBe(true);
    expect(ticketAction.text).toContain("delegate_ticket");
  });

  test("a mixed call's guidance names the half that did not run", async () => {
    // The corrected example shows only the routed half; the leftover fields
    // must be named so following the example literally does not drop them.
    const dispatch = await call({ tasks: [{ prompt: "x" }], ticket: "t-1" });
    expect(dispatch.isError).toBe(true);
    expect(dispatch.text).toContain(
      'delegate_ticket({ action: "poll", ticket: "t-1" })',
    );
    expect(dispatch.text).toContain("'tasks'");

    const ticket = await callTicket({
      action: "poll",
      tasks: [{ prompt: "x" }],
    });
    expect(ticket.isError).toBe(true);
    expect(ticket.text).toContain("delegate(");
    expect(ticket.text).toContain("'action'");
  });

  // ── cross-tool guidance: foreign shapes on the new tools ──────────────────

  test("dispatch fields on delegate_ticket point at delegate", async () => {
    for (const [arguments_, example] of [
      [
        { action: "poll", tasks: [{ prompt: "x" }] },
        'delegate({ tasks: [{"prompt":"x"}] })',
      ],
      [{ action: "poll", async: true }, "delegate("],
      [{ action: "poll", workspace: "isolated" }, "delegate("],
      [{ action: "poll", operationId: "op-1" }, "delegate("],
      [{ action: "poll", prompt: "x" }, 'delegate({ tasks: [{"prompt":"x"}] })'],
    ] as const) {
      const result = await callTicket(arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("delegate(");
      expect(result.text).toContain(example);
    }
  });

  test("session fields on delegate_ticket point at delegate_session", async () => {
    for (const [arguments_, example] of [
      [
        { action: "poll", sessionAction: "list" },
        'delegate_session({ action: "list" })',
      ],
      [
        { action: "wait", ticket: "t1", sessionId: "s1" },
        'delegate_session({ action: "close", sessionId: "s1" })',
      ],
    ] as const) {
      const result = await callTicket(arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("delegate_session");
      expect(result.text).toContain(example);
    }
  });

  test("ticketAction on delegate_ticket says the field is now action", async () => {
    const result = await callTicket({ ticketAction: "poll", ticket: "t-1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/"action", not "ticketAction"/);
    expect(result.text).toContain(
      'delegate_ticket({ action: "poll", ticket: "t-1" })',
    );
  });

  test("ticket fields on delegate_session point at delegate_ticket", async () => {
    const result = await callSession({
      action: "list",
      ticket: "t-1",
      ticketAction: "poll",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("delegate_ticket");
    expect(result.text).toContain(
      'delegate_ticket({ action: "poll", ticket: "t-1" })',
    );
  });

  test("dispatch fields on delegate_session point at delegate", async () => {
    const result = await callSession({ action: "list", tasks: [{ prompt: "x" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("delegate(");
    expect(result.text).toContain('delegate({ tasks: [{"prompt":"x"}] })');
  });

  test("sessionAction on delegate_session says the field is now action", async () => {
    const result = await callSession({ sessionAction: "close", sessionId: "s1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/"action", not "sessionAction"/);
    expect(result.text).toContain(
      'delegate_session({ action: "close", sessionId: "s1" })',
    );
  });
});

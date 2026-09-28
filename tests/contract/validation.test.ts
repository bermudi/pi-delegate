import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  callDelegateSession,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

describe("delegate validation contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  async function call(
    arguments_: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly isError: boolean }> {
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

  // ── Schema-level rejections (enforced at the boundary today) ────────────

  test("rejects values outside the closed enums", async () => {
    // v1 regression: glm-5.3 read "none confine access" prose as a fourth
    // workspace value and sent workspace:"none". Closed enums are the contract.
    for (const arguments_ of [
      { tasks: [{ prompt: "x", workspace: "none" }] },
    ]) {
      const result = await call(arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Validation failed");
    }
    const ticketResult = await callTicket({ action: "explode" });
    expect(ticketResult.isError).toBe(true);
    expect(ticketResult.text).toContain("Validation failed");
    const sessionResult = await callSession({ action: "restart" });
    expect(sessionResult.isError).toBe(true);
    expect(sessionResult.text).toContain("Validation failed");
  });

  test("rejects task-level control fields instead of silently degrading", async () => {
    // v1 regression: a task-level `async: true` was silently ignored and the
    // batch ran synchronously. Task-level control keys must be rejected.
    for (const arguments_ of [
      { tasks: [{ prompt: "x", async: true }] },
      { tasks: [{ prompt: "x", sessionAction: "close" }] },
      { tasks: [{ prompt: "x", unsafeSharedWrites: true }] },
    ]) {
      const result = await call(arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Validation failed");
      expect(result.text).not.toContain("dispatch is not implemented");
    }
    // A dispatch-shaped call to delegate_ticket gets cross-tool guidance,
    // never a silent degradation.
    const guidance = await callTicket({
      action: "poll",
      tasks: [{ prompt: "x" }],
    });
    expect(guidance.isError).toBe(true);
    expect(guidance.text).toContain("delegate(");
  });

  test("rejects task ids outside the correlation-key charset", async () => {
    for (const id of ["has space", "bad/slash", "emoji-🚫", "x".repeat(65)]) {
      const result = await call({ tasks: [{ id, prompt: "x" }] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Validation failed");
    }
  });

  // ── Semantic validation (pending: scaffold has no semantic pass yet) ─────

  test(
    "rejects duplicate task ids with an actionable error before any task starts",
    async () => {
      // v1 evidence: schema.test.ts task id validation; SPEC batch-before-start.
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [
          { id: "dup", prompt: "a" },
          { id: "dup", prompt: "b" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/dup/i);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  test(
    "rejects duplicate session ids in one batch before any task starts",
    async () => {
      // v1 evidence: task-resolution validateTasks duplicate-session checks.
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [
          { prompt: "a", sessionId: "shared-one" },
          { prompt: "b", sessionId: "shared-one" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/shared-one|session/i);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  test("a blank task sessionId is treated as absent and runs one-shot", async () => {
    // Blank optional identifiers mean "not given" at the boundary: this
    // task dispatches with no session instead of failing.
    session = await openDelegateBoundary();
    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", sessionId: "" }],
    });
    expect(result.text).not.toContain("Validation failed");
    expect(result.text).not.toMatch(/sessionId must be a non-empty/);
  });

  test("rejects non-positive deadlines with an actionable error", async () => {
    // v1 evidence: schema.test.ts "rejects non-positive deadlineMs".
    session = await openDelegateBoundary();
    for (const deadlineMs of [0, -50]) {
      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", deadlineMs }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/deadline/i);
      expect(result.text).not.toContain("dispatch is not implemented");
    }
  });

  test(
    "rejects one-shot workspaces combined with session persistence or resume",
    async () => {
      // v1 evidence: schema.test.ts "rejects scratch workspace with persistent
      // sessions or resume" and "allows async isolated workspaces but rejects
      // persistent ones". SPEC: scratch and isolated cannot use sessionId or
      // resumeFrom.
      session = await openDelegateBoundary();
      for (const task of [
        { prompt: "x", workspace: "scratch", sessionId: "s1" },
        { prompt: "x", workspace: "scratch", resumeFrom: "/tmp/x.jsonl" },
        { prompt: "x", workspace: "isolated", sessionId: "s1" },
        { prompt: "x", workspace: "isolated", resumeFrom: "/tmp/x.jsonl" },
      ]) {
        const result = await callDelegate(session, { tasks: [task] });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/workspace|session|resume/i);
        expect(result.text).not.toContain("dispatch is not implemented");
      }
    },
  );

  test(
    "rejects cross-tool field mixes with guidance toward the right tool",
    async () => {
      // v1 evidence: schema.test.ts mode matrix (ticket control combined with
      // tasks/sessionId/prompt; session precedence over tasks). With the
      // split tools, foreign fields cannot run: the boundary answers with
      // guidance naming the sibling tool instead of executing anything.
      const cases: [
        (a: Record<string, unknown>) => Promise<{
          readonly text: string;
          readonly isError: boolean;
        }>,
        Record<string, unknown>,
        RegExp,
      ][] = [
        [call, { ticketAction: "poll", tasks: [{ prompt: "x" }] }, /delegate_ticket/],
        [call, { ticketAction: "wait", ticket: "t1" }, /delegate_ticket/],
        [call, { sessionAction: "list", tasks: [{ prompt: "x" }] }, /delegate_session/],
        [callTicket, { action: "wait", ticket: "t1", sessionId: "s1" }, /delegate_session/],
        [callTicket, { action: "poll", tasks: [{ prompt: "x" }] }, /delegate\(/],
        [callSession, { action: "close", sessionId: "s1", prompt: "x" }, /delegate\(/],
      ];
      for (const [invoke, arguments_, pattern] of cases) {
        // Fresh session per case keeps each rejection independent — no
        // shared transcript, ticket store, or extension state between calls.
        const result = await invoke(arguments_);
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(pattern);
        expect(result.text).not.toContain("not implemented");
        expect(result.text).not.toContain("Delegate Manual");
      }
    },
  );

  test(
    "does not merge flat fields into an explicit non-empty task array",
    async () => {
      // v1 evidence: schema.test.ts "rejects any flat task field mixed with
      // an explicit tasks array". SPEC input-recovery: flat folding only
      // applies when there is no task array — a stray field beside one names
      // itself rather than surfacing a bare additionalProperties error.
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [{ prompt: "inside" }],
        prompt: "outside",
        sessionId: "s1",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("cannot mix top-level task field(s)");
      expect(result.text).toContain("'prompt'");
      expect(result.text).toContain("'sessionId'");
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  test(
    "a top-level model field gets the model rejection beside an explicit tasks array",
    async () => {
      // Issue #27: `model` rejects the same way `context` does — wherever it
      // appears, including stranded at the top level next to `tasks`.
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [{ prompt: "x" }],
        model: "some/model",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("model field is not accepted");
      expect(result.text).toContain("delegate.json");
    },
  );

  test(
    "the thinking field is rejected wherever it appears (#32)",
    async () => {
      // Issue #32: effort is user-configured only — `thinking` rejects like
      // `model`, inside a task, flat-folded, stranded at the top level, and
      // on the sibling tools.
      session = await openDelegateBoundary();
      for (const arguments_ of [
        { tasks: [{ prompt: "x", thinking: "high" }] },
        { prompt: "x", thinking: "high" },
        { tasks: [{ prompt: "x" }], thinking: "high" },
      ]) {
        const result = await callDelegate(session, arguments_);
        expect(result.isError).toBe(true);
        expect(result.text).toContain("thinking field is not accepted");
      }
      const ticket = await callDelegateTicket(session, {
        action: "poll",
        thinking: "high",
      });
      expect(ticket.isError).toBe(true);
      expect(ticket.text).toContain("thinking field is not accepted");
      const sessionResult = await callDelegateSession(session, {
        action: "list",
        thinking: "high",
      });
      expect(sessionResult.isError).toBe(true);
      expect(sessionResult.text).toContain("thinking field is not accepted");
    },
  );

  test("rejects a task with no prompt and no resume intent", async () => {
    // v1 evidence: lifecycle.test.ts "task without prompt (and not
    // close/list/resume) throws". SPEC: prompt is optional only with resumeFrom.
    session = await openDelegateBoundary();
    const result = await callDelegate(session, {
      tasks: [{ agent: "explore" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/prompt/i);
    expect(result.text).not.toContain("dispatch is not implemented");
  });

  test(
    "rejects an unknown agent with guidance toward valid profiles",
    async () => {
      // v1 evidence: delegate.test.ts "execute rejects unknown agents and
      // suggests help"; lifecycle.test.ts "unknown agent name produces clear
      // error".
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", agent: "nonexistent-agent" }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/nonexistent-agent/);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  test(
    "ticket and session controls report which field they require",
    async () => {
      // v1 evidence: delegate.test.ts "cancel requires ticket ID",
      // "close sessionAction requires sessionId", "wait requires a ticket ID".
      session = await openDelegateBoundary();
      for (const action of ["cancel", "wait", "pause", "resume"]) {
        const result = await callDelegateTicket(session, { action });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/ticket/i);
        expect(result.text).not.toContain("not implemented");
      }
      const close = await callDelegateSession(session, { action: "close" });
      expect(close.isError).toBe(true);
      expect(close.text).toMatch(/sessionId/i);
      expect(close.text).not.toContain("not implemented");
    },
  );

  test(
    "a custom or unknown tool name fails the whole call before any task starts",
    async () => {
      // INVARIANTS "Shared writes": unknown tools are mutating — admission
      // must never narrow an unrecognized capability to read-only. The
      // public boundary enforces the stricter form: a tool outside the
      // known child inventory rejects the whole call during resolution,
      // before admission or any worker exists. A caller-supplied name can
      // never silently downgrade a writer into an unreserved reader.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "never runs",
            tools: ["read", "mcp__foghorn__index_the_universe"],
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/unknown tool 'mcp__foghorn__index_the_universe'/);
      expect(result.text).toMatch(/Known tools/i);
      // The provider was never reached: the rejection is pre-worker.
      expect(subagents.state.callCount).toBe(0);
    },
  );
});

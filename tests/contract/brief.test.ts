import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { join } from "node:path";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/** The first user-role message's text — what the child actually receives. */
function firstUserText(context: TranscriptContext): string {
  const message = context.messages.find((m) => m.role === "user");
  if (message === undefined) return "";
  const content = message.content;
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

/** Count `needle` occurrences in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("shared batch brief — context prepended to every task (SPEC v3, issue #43)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a batch brief prepends a delimited preamble to every task's prompt",
    async () => {
      // SPEC v3 "Interaction grammar — Batch brief": each child sees the
      // fenced brief block before its own prompt prose; the fence keeps
      // the shared context distinct from the task.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const prompts: string[] = [];
      const capture: FauxResponseFactory = (context) => {
        prompts.push(firstUserText(context));
        return fauxAssistantMessage("DONE");
      };
      subagents.respond([capture, capture]);

      const result = await callDelegate(session, {
        brief: "PROJECT-CONTEXT: the repo is ESM-only",
        tasks: [{ prompt: "alpha task" }, { prompt: "beta task" }],
        async: true,
      });
      expect(result.isError).toBe(false);
      const ticket = ticketIdOf(result.text);
      await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });

      expect(prompts.length).toBe(2);
      const alpha = prompts.find((text) => text.includes("alpha task"));
      const beta = prompts.find((text) => text.includes("beta task"));
      for (const text of [alpha, beta]) {
        expect(text).toBeDefined();
        expect(text).toContain("--- batch brief ---");
        expect(text).toContain("PROJECT-CONTEXT: the repo is ESM-only");
        expect(text).toContain("--- end batch brief ---");
        // Preamble precedes the task's own prose.
        expect(text!.indexOf("--- batch brief ---")).toBeLessThan(
          text!.indexOf("--- end batch brief ---"),
        );
      }
      expect(alpha!.indexOf("--- end batch brief ---")).toBeLessThan(
        alpha!.indexOf("alpha task"),
      );
      expect(beta!.indexOf("--- end batch brief ---")).toBeLessThan(
        beta!.indexOf("beta task"),
      );
    },
  );

  test(
    "the result header names the brief once; task sections never repeat it",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("OUT-A"),
        fauxAssistantMessage("OUT-B"),
      ]);

      const result = await callDelegate(session, {
        brief: "BRIEF-HEADER-CHECK",
        tasks: [{ prompt: "a" }, { prompt: "b" }],
        async: false,
      });
      expect(result.isError).toBe(false);
      expect(occurrences(result.text, 'brief: "BRIEF-HEADER-CHECK"')).toBe(1);
      // One mention, in the head — the task sections themselves carry
      // no brief text (the children carry it, not the report).
      expect(result.text.indexOf('brief: "BRIEF-HEADER-CHECK"'))
        .toBeLessThan(result.text.indexOf("### Task"));
      const sections = result.text.slice(result.text.indexOf("### Task"));
      expect(sections).not.toContain("BRIEF-HEADER-CHECK");
    },
  );

  test(
    "the async receipt and ticket view name the brief once, surviving recovery",
    async () => {
      // The receipt is the only sync surface an async call has (same
      // rationale as the alias notes), and the ticket record persists
      // the brief so a post-restart view still names it.
      session = await openDelegateBoundary();
      const agentDir = session.cwd;
      (session.session as AgentSession).sessionManager.getSessionDir =
        () => join(agentDir, "sessions", "--test--");
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("OUT")]);

      const dispatched = await callDelegate(session, {
        brief: "ASYNC-BRIEF-MARKER",
        tasks: [{ prompt: "work" }],
        async: true,
      });
      expect(dispatched.isError).toBe(false);
      expect(dispatched.text).toContain('brief: "ASYNC-BRIEF-MARKER"');
      const ticket = ticketIdOf(dispatched.text);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(occurrences(settled.text, 'brief: "ASYNC-BRIEF-MARKER"')).toBe(1);

      // A fresh boundary over the same journal recovers the record —
      // brief included.
      const next = await openDelegateBoundary();
      (next.session as AgentSession).sessionManager.getSessionDir =
        () => join(agentDir, "sessions", "--test--");
      const recovered = await callDelegateTicket(next, {
        action: "poll",
        ticket,
      });
      expect(recovered.isError).toBe(false);
      expect(recovered.text).toContain('brief: "ASYNC-BRIEF-MARKER"');
      next.dispose();
    },
  );

  test(
    "context normalizes to brief with a visible field note",
    async () => {
      // SPEC v3 "Reflex meeting": `context` is the cross-harness
      // spelling — it folds into `brief` and the rename is reported
      // like every applied normalization.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const prompts: string[] = [];
      subagents.respond([
        (context) => {
          prompts.push(firstUserText(context));
          return fauxAssistantMessage("DONE");
        },
      ]);

      const result = await callDelegate(session, {
        context: "CTX-SPELLING-BRIEF",
        tasks: [{ prompt: "one" }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain('field "context" → "brief"');
      expect(result.text).toContain('brief: "CTX-SPELLING-BRIEF"');
      expect(prompts[0]).toContain("CTX-SPELLING-BRIEF");
      expect(prompts[0]).toContain("--- batch brief ---");
    },
  );

  test(
    "conflicting brief and context reject naming both",
    async () => {
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        brief: "version A",
        context: "version B",
        tasks: [{ prompt: "work" }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("'brief'");
      expect(result.text).toContain("'context'");
    },
  );

  test(
    "an absent brief leaves prompts and results untouched",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const prompts: string[] = [];
      subagents.respond([
        (context) => {
          prompts.push(firstUserText(context));
          return fauxAssistantMessage("DONE");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "plain task" }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain("brief:");
      expect(prompts[0]).toBe("plain task");
    },
  );

  test(
    "a dependent's prompt keeps the handoff appendix trailing the brief",
    async () => {
      // The brief is a preamble; the dependency handoff still appends
      // after the task's own prose (SPEC v3 "Batch brief": ordering).
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const prompts: string[] = [];
      const capture: FauxResponseFactory = (context) => {
        prompts.push(firstUserText(context));
        return fauxAssistantMessage("PREREQ-OUT");
      };
      subagents.respond([capture, capture]);

      const result = await callDelegate(session, {
        brief: "ORDER-CHECK-BRIEF",
        tasks: [
          { prompt: "first" },
          { prompt: "second needs first", dependsOn: ["task-1"] },
        ],
        async: false,
      });
      expect(result.isError).toBe(false);
      const dependent = prompts.find((text) =>
        text.includes("second needs first"),
      );
      expect(dependent).toBeDefined();
      // Order: brief fence → own prompt → handoff appendix.
      const fence = dependent!.indexOf("--- batch brief ---");
      const own = dependent!.indexOf("second needs first");
      const handoff = dependent!.indexOf("Handoffs from prerequisite tasks");
      const prereqOut = dependent!.indexOf("PREREQ-OUT");
      expect(fence).toBeGreaterThanOrEqual(0);
      expect(fence).toBeLessThan(own);
      expect(own).toBeLessThan(handoff);
      expect(handoff).toBeLessThan(prereqOut);
    },
  );
});

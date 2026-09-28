import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import type {
  FauxResponseFactory,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateSession,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/** A scripted subagent stream that blocks until `release` is invoked. */
function gate(output = "OUTPUT-RELEASED") {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage(output);
  };
  return { release, step };
}

/** Poll until true, bounded — keeps in-flight ordering assertions stable. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250 && !probe(); i++) await Bun.sleep(20);
  expect(probe(), `${what} (timed out waiting)`).toBeTrue();
}

/** True when the child's provider-visible transcript carried `text`. */
function transcriptSaw(context: TranscriptContext, text: string): boolean {
  return context.messages.some((message) => {
    const content = message.content;
    if (typeof content === "string") return content.includes(text);
    return content.some(
      (part) => part.type === "text" && part.text.includes(text),
    );
  });
}

describe("pooled-session residency — idle sessions unload to disk (SPEC v3, issue #46)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "idle sessions past the bound unload; the next same-sessionId task reloads them transparently",
    async () => {
      // SPEC v3 "Pooled sessions — Residency": sessions.maxIdle bounds
      // resident *idle* sessions; the LRU idle unloads to its transcript
      // and reloads on the next same-sessionId task, continuing the same
      // conversation.
      session = await openDelegateBoundary();
      configureDelegate(session, { sessions: { maxIdle: 1 } });
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("FIRST")]);
      await callDelegate(session, {
        tasks: [{ prompt: "remember ALPHA-MARKER", sessionId: "s1" }],
      });
      subagents.respond([fauxAssistantMessage("SECOND")]);
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "s2" }],
      });

      // Bound 1 with two idle sessions: s1 (older idle) is on disk.
      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.text).toMatch(/s1[^\n]*\(idle, on disk\)/);
      expect(listed.text).toMatch(/- "s2" — model [^\n(]*$/m);

      // The unloaded session reloads transparently: the child sees the
      // first conversation, not a fresh one.
      const sawHistory: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          transcriptSaw(context, "ALPHA-MARKER") ? "CONTINUED" : "FRESH-SESSION",
        );
      subagents.respond([sawHistory]);
      const second = await callDelegate(session, {
        tasks: [{ prompt: "again", sessionId: "s1" }],
      });
      expect(second.isError).toBe(false);
      expect(second.text).toContain("CONTINUED");

      // s1 is resident again and s2 (now the older idle) unloaded.
      const after = await callDelegateSession(session, { action: "list" });
      expect(after.text).toMatch(/- "s1" — model [^\n(]*$/m);
      expect(after.text).toMatch(/s2[^\n]*\(idle, on disk\)/);
    },
  );

  test(
    "the frozen configuration still rejects incompatible reuse after unload",
    async () => {
      // SPEC v3: reload must not weaken the freeze — an unloaded entry
      // enforces identical cwd/tools/thinking/model/base-prompt checks.
      session = await openDelegateBoundary();
      configureDelegate(session, { sessions: { maxIdle: 1 } });
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("hi"), fauxAssistantMessage("hi")]);
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "conv", tools: ["read"] }],
      });
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "other" }],
      });
      // 'conv' is now the unloaded record; reuse must still reject.
      const mismatched = await callDelegate(session, {
        tasks: [
          { prompt: "x", sessionId: "conv", tools: ["read", "bash"] },
        ],
      });
      expect(mismatched.text).toMatch(/conv|session/i);
      expect(mismatched.text).toMatch(/frozen|mismatch|incompatible|tools/i);
    },
  );

  test(
    "a checked-out session never unloads, even over the bound",
    async () => {
      // SPEC v3: residency selects idle sessions only — an in-flight run
      // keeps its worker resident regardless of the bound.
      session = await openDelegateBoundary();
      configureDelegate(session, { sessions: { maxIdle: 1 } });
      const subagents = await installSubagentModel(session);

      // Pool s1 and s2 (s1 unloads — older idle), then park s2's next run.
      subagents.respond([
        fauxAssistantMessage("ONE"),
        fauxAssistantMessage("TWO"),
      ]);
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "s1" }],
      });
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "s2" }],
      });

      const held = gate("HELD");
      subagents.respond([held.step, fauxAssistantMessage("THREE")]);
      const receipt = await callDelegate(session, {
        tasks: [{ prompt: "more", sessionId: "s2" }],
        async: true,
      });
      expect(receipt.isError).toBe(false);
      await waitFor(
        () => subagents.state.callCount === 3,
        "pooled child parked in its provider call",
      );

      // A new pooled session settles while s2 is checked out: the bound
      // counts only idle residents — s3 pools, s2 stays running, s1 stays
      // on disk. s3 is read-only so admission does not pin it behind s2's
      // shared write reservation.
      const third = await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "s3", tools: ["read"] }],
      });
      expect(third.isError).toBe(false);
      const during = await callDelegateSession(session, { action: "list" });
      expect(during.text).toMatch(/s2[^\n]*\(running\)/);
      expect(during.text).toMatch(/s1[^\n]*\(idle, on disk\)/);
      expect(during.text).toMatch(/- "s3" — model [^\n(]*$/m);

      // s2 was never an eviction candidate while checked out — its run
      // completes normally once the gate opens. At its own settle the
      // resident idles are s3 (older) + s2 (newest): the bound evicts s3,
      // the longer-idle one, and s2 stays resident. The async dispatch's
      // tool result is the ticket receipt — poll list for the settlement.
      held.release();
      let after = "";
      for (let i = 0; i < 250; i++) {
        after = (await callDelegateSession(session, { action: "list" })).text;
        if (/s3[^\n]*\(idle, on disk\)/.test(after)) break;
        await Bun.sleep(20);
      }
      expect(after).toMatch(/- "s2" — model [^\n(]*$/m);
      expect(after).toMatch(/s3[^\n]*\(idle, on disk\)/);
    },
  );

  test(
    "close removes an unloaded session's record; maxIdle 0 unloads every settle",
    async () => {
      // SPEC v3: delegate_session close works on on-disk entries (no live
      // worker to abort); a zero bound keeps nothing resident.
      session = await openDelegateBoundary();
      configureDelegate(session, { sessions: { maxIdle: 0 } });
      const subagents = await installSubagentModel(session);

      subagents.respond([
        fauxAssistantMessage("A"),
        fauxAssistantMessage("B"),
      ]);
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "one" }],
      });
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "two" }],
      });
      const listed = await callDelegateSession(session, { action: "list" });
      expect(listed.text).toMatch(/one[^\n]*\(idle, on disk\)/);
      expect(listed.text).toMatch(/two[^\n]*\(idle, on disk\)/);

      const closed = await callDelegateSession(session, {
        action: "close",
        sessionId: "one",
      });
      expect(closed.isError).toBe(false);
      expect(closed.text).toMatch(/closed/i);
      const after = await callDelegateSession(session, { action: "list" });
      expect(after.text).not.toContain('"one"');
      expect(after.text).toContain('"two"');
    },
  );
});

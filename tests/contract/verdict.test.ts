import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

type VerdictEntry = { verdict: string; taskId: string };

/** details.verdict — absent when no outcome carried a parsed verdict. */
function verdictsOf(details: unknown): VerdictEntry[] | undefined {
  const entries = objectOf(details, "details").verdict;
  if (entries === undefined) return undefined;
  if (!Array.isArray(entries)) {
    throw new Error(`details.verdict is not an array: ${typeof entries}`);
  }
  return entries as VerdictEntry[];
}

/** A scripted subagent stream that blocks until `release` is invoked. */
function gate(message: string) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage(message);
  };
  return { release, step };
}

async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error("Timed out awaiting delivery observation");
    }
    await Bun.sleep(5);
  }
}

describe("verifier profile — verdict evidence (SPEC v3 #49)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a PASS verdict renders beside attribution with the unverifiable note and rides details.verdict",
    async () => {
      // SPEC v3 "Observability — Completion evidence — verifier verdict"
      // (#49): the built-in verifier's parsed verdict renders beside the
      // task's claim; a PASS that observed no file change reports
      // `unverifiable`; details.verdict carries {verdict, taskId}.
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([
        fauxAssistantMessage("Checked the claim against the tree.\nVERDICT: PASS"),
      ]);

      const result = await callDelegate(session, {
        tasks: [{ id: "check", agent: "verifier", prompt: "verify claim X" }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("verdict: PASS — unverifiable");

      const verdicts = verdictsOf(result.details);
      expect(verdicts).toEqual([{ verdict: "PASS", taskId: "check" }]);
      const outcomes = objectOf(result.details).results as { verdict?: string }[];
      expect(outcomes[0]!.verdict).toBe("PASS");
    },
  );

  test(
    "a FAIL verdict with zero attributed files reports the claim uncorroborated",
    async () => {
      // #49: FAIL + zero attributed files → "claim not corroborated by
      // any observed file change" — a failing claim the tree shows no
      // evidence for must not read as settled fact.
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([fauxAssistantMessage("Evidence contradicts it.\nVERDICT: FAIL")]);

      const result = await callDelegate(session, {
        tasks: [{ agent: "verifier", prompt: "verify claim Y" }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain(
        "verdict: FAIL — claim not corroborated by any observed file change",
      );
      expect(verdictsOf(result.details)).toEqual([
        { verdict: "FAIL", taskId: "task-1" },
      ]);
    },
  );

  test(
    "AMBIGUOUS, whitespace-tolerant, and parenthetical verdict lines all parse",
    async () => {
      // #49: three values are legal; whitespace around the marker and
      // value is tolerated; an optional parenthetical count may follow.
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([
        fauxAssistantMessage("Cannot decide.\n  VERDICT:   AMBIGUOUS  "),
        fauxAssistantMessage("Checked twice.\nVERDICT: FAIL (2 findings)"),
      ]);

      const ambiguous = await callDelegate(session, {
        tasks: [{ agent: "verifier", prompt: "verify Z" }],
      });
      expect(ambiguous.text).toContain("verdict: AMBIGUOUS");
      expect(ambiguous.text).not.toContain("unverifiable");
      expect(verdictsOf(ambiguous.details)).toEqual([
        { verdict: "AMBIGUOUS", taskId: "task-1" },
      ]);

      const counted = await callDelegate(session, {
        tasks: [{ agent: "verifier", prompt: "verify W" }],
      });
      expect(counted.text).toContain("verdict: FAIL — claim not corroborated");
      expect(verdictsOf(counted.details)).toEqual([
        { verdict: "FAIL", taskId: "task-1" },
      ]);
    },
  );

  test(
    "the LAST well-formed VERDICT line wins; a malformed tail does not shadow it",
    async () => {
      // #49: parse the final output's last VERDICT: line — a line that
      // carries the marker but not a clean value is not a verdict line,
      // so an earlier clean verdict still reports.
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([
        fauxAssistantMessage(
          "VERDICT: PASS\nreconsidering...\nVERDICT: FAIL\n",
        ),
        fauxAssistantMessage(
          "VERDICT: PASS\nVERDICT: not-a-verdict trailing words",
        ),
      ]);

      const lastWins = await callDelegate(session, {
        tasks: [{ agent: "verifier", prompt: "verify M" }],
      });
      expect(lastWins.text).toContain("verdict: FAIL");
      expect(lastWins.text).not.toContain("verdict: PASS");
      expect(verdictsOf(lastWins.details)).toEqual([
        { verdict: "FAIL", taskId: "task-1" },
      ]);

      const malformedTail = await callDelegate(session, {
        tasks: [{ agent: "verifier", prompt: "verify N" }],
      });
      expect(malformedTail.text).toContain("verdict: PASS");
      expect(verdictsOf(malformedTail.details)).toEqual([
        { verdict: "PASS", taskId: "task-1" },
      ]);
    },
  );

  test(
    "no VERDICT line reports nothing; the marker is case-sensitive",
    async () => {
      // #49: none found => no verdict, nothing reported — no `verdict:`
      // line, no details.verdict. A lowercase marker is not the marker.
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([
        fauxAssistantMessage("checked and done — no verdict given"),
        fauxAssistantMessage("verdict: fail\nVerdict: FAIL"),
      ]);

      const none = await callDelegate(session, {
        tasks: [{ agent: "verifier", prompt: "verify P" }],
      });
      expect(none.isError).toBe(false);
      expect(none.text).not.toContain("verdict:");
      expect(verdictsOf(none.details)).toBeUndefined();

      const wrongCase = await callDelegate(session, {
        tasks: [{ agent: "verifier", prompt: "verify Q" }],
      });
      // The child's own output echoes its lines verbatim — what must NOT
      // appear is the evidence line's shape, `verdict: <UPPERCASE VALUE>`.
      expect(wrongCase.text).not.toContain("verdict: FAIL");
      expect(wrongCase.text).not.toContain("verdict: PASS");
      expect(wrongCase.text).not.toContain("verdict: AMBIGUOUS");
      expect(verdictsOf(wrongCase.details)).toBeUndefined();
    },
  );

  test(
    "non-verifier tasks are completely untouched by the verdict layer",
    async () => {
      // #49: verdict parsing applies only to tasks run under the verifier
      // profile — an inline task that emits a VERDICT-looking line reports
      // nothing new anywhere.
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([
        fauxAssistantMessage("I checked it myself.\nVERDICT: FAIL"),
        fauxAssistantMessage("reviewer-looking output\nVERDICT: PASS"),
      ]);

      const inline = await callDelegate(session, {
        tasks: [{ prompt: "check it" }],
      });
      expect(inline.isError).toBe(false);
      expect(inline.text).not.toContain("verdict:");
      expect(verdictsOf(inline.details)).toBeUndefined();
      const inlineOutcomes = objectOf(inline.details).results as { verdict?: string }[];
      expect(inlineOutcomes[0]!.verdict).toBeUndefined();

      const reviewer = await callDelegate(session, {
        tasks: [{ agent: "reviewer", prompt: "look" }],
      });
      expect(reviewer.text).not.toContain("verdict:");
      expect(verdictsOf(reviewer.details)).toBeUndefined();
    },
  );

  test(
    "the verdict rides the settled ticket view and poll/wait details",
    async () => {
      // #49: rendered beside attribution in ticket views; details.verdict
      // on the poll/wait surface carries the same {verdict, taskId}.
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      // The two verifier tasks run in parallel and the response queue is
      // a shared FIFO — route by the task's own prompt so v-one always
      // reports PASS and v-two FAIL regardless of provider-call order.
      const byPrompt: FauxResponseFactory = async (context) =>
        fauxAssistantMessage(
          JSON.stringify(context.messages).includes('"verify one"')
            ? "Held up.\nVERDICT: PASS"
            : "done\nVERDICT: FAIL (1 finding)",
        );
      model.respond([byPrompt, byPrompt]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { id: "v-one", agent: "verifier", prompt: "verify one" },
          { id: "v-two", agent: "verifier", prompt: "verify two" },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.isError).toBe(false);
      expect(waited.text).toContain("verdict: PASS — unverifiable");
      expect(waited.text).toContain(
        "verdict: FAIL — claim not corroborated by any observed file change",
      );
      expect(verdictsOf(waited.details)).toEqual([
        { verdict: "PASS", taskId: "v-one" },
        { verdict: "FAIL", taskId: "v-two" },
      ]);

      const polled = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(polled.text).toContain("verdict: PASS — unverifiable");
      expect(verdictsOf(polled.details)).toEqual([
        { verdict: "PASS", taskId: "v-one" },
        { verdict: "FAIL", taskId: "v-two" },
      ]);
    },
  );

  test(
    "a delivered async result carries the verdict in its wake text and details",
    async () => {
      // #49: delivered results show the verdict beside attribution the
      // same as polls — the wake is the ticket view — and the delivered
      // message's details.verdict carries {verdict, taskId}.
      session = await openDelegateBoundary();
      const host = session.session as AgentSession;
      const model = await installSubagentModel(session);
      const blocked = gate("Held up.\nVERDICT: PASS");
      model.respond([blocked.step]);
      const sends = spyOn(host, "sendCustomMessage");
      const dispatched = await callDelegate(session, {
        tasks: [{ id: "v", agent: "verifier", prompt: "verify" }],
        async: true,
      });
      expect(ticketIdOf(dispatched.text)).not.toBe("");
      blocked.release();
      await until(() => sends.mock.calls.length > 0);
      const message = sends.mock.calls[0]![0] as {
        content: string;
        details?: unknown;
      };
      expect(message.content).toContain("verdict: PASS — unverifiable");
      expect(verdictsOf(message.details)).toEqual([
        { verdict: "PASS", taskId: "v" },
      ]);
    },
  );

  test(
    "a mixed batch renders the verdict only on the verifier's section",
    async () => {
      // #49: the layer keys on the profile, not the batch — a sibling
      // task in the same dispatch keeps its plain result shape.
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      // Verifier and coder run in parallel — route the verdict to the
      // verifier's prompt by content, not by shared FIFO order.
      const byPrompt: FauxResponseFactory = async (context) =>
        fauxAssistantMessage(
          JSON.stringify(context.messages).includes('"verify"')
            ? "Ruled.\nVERDICT: PASS"
            : "PLAIN-OUTPUT",
        );
      model.respond([byPrompt, byPrompt]);

      const result = await callDelegate(session, {
        tasks: [
          { id: "v", agent: "verifier", prompt: "verify" },
          { id: "c", agent: "coder", prompt: "build" },
        ],
        async: false,
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("verdict: PASS — unverifiable");
      // The coder's section carries no verdict evidence.
      const coderSection = result.text.slice(result.text.indexOf("### Task c"));
      expect(coderSection).not.toContain("verdict:");
      expect(verdictsOf(result.details)).toEqual([
        { verdict: "PASS", taskId: "v" },
      ]);
    },
  );
});

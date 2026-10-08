import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

/**
 * Output-bounding contract (issue #25): the LLM-facing result text keeps a
 * bounded tail of an over-threshold output and points at an owner-only temp
 * file holding the whole output; the complete record stays in `details`.
 * Everything here drives the registered `delegate` tool — spill I/O is
 * steered through TMPDIR, which `os.tmpdir()` reads per call.
 */

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

function spillFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("delegate-output-"));
}

/** Extract the spill path named by a rendered pointer, if one is present. */
function spilledPathOf(text: string): string | undefined {
  return /spilled to (.+?) —/.exec(text)?.[1];
}

async function pollUntil(session: TestSession, ticket: string, needle: RegExp) {
  const end = Date.now() + 5000;
  for (;;) {
    const result = await callDelegateTicket(session, {
      action: "poll",
      ticket,
    });
    if (needle.test(result.text)) return result;
    if (Date.now() > end) {
      throw new Error(`timed out waiting for poll to match ${needle}`);
    }
    // Macrotask yield: a tight microtask poll starves Bun's child-exit
    // delivery for the Git evidence probes.
    await Bun.sleep(5);
  }
}

describe("delegate output bounding", () => {
  let session: TestSession | undefined;
  let spillDir: string | undefined;
  let savedTmpdir: string | undefined;
  let tmpdirOverridden = false;

  afterEach(() => {
    session?.dispose();
    session = undefined;
    if (tmpdirOverridden) {
      if (savedTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = savedTmpdir;
      }
      savedTmpdir = undefined;
      tmpdirOverridden = false;
    }
    if (spillDir !== undefined) {
      fs.rmSync(spillDir, { recursive: true, force: true });
      spillDir = undefined;
    }
  });

  /** Route spill writes into a fresh directory this test can inspect. */
  function useSpillDir(): string {
    spillDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-spill-test-"));
    savedTmpdir = process.env.TMPDIR;
    tmpdirOverridden = true;
    process.env.TMPDIR = spillDir;
    return spillDir;
  }

  test("under-threshold output passes through unchanged", async () => {
    // v1 evidence: spill.test.ts decideSpill "under threshold passes through
    // unchanged, no spill" and "exactly at threshold does NOT spill".
    const dir = useSpillDir();
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 100, spillTailChars: 20 },
    });
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SMALL-OUTPUT")]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "small" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("SMALL-OUTPUT");
    expect(result.text).not.toContain("spilled to");
    expect(spillFiles(dir)).toHaveLength(0);
  });

  test(
    "over-threshold sync output keeps a tail, writes the whole output to an " +
      "owner-only temp file, and leaves the complete record in details",
    async () => {
      // v1 evidence: spill.test.ts renderOutputForLLM "over threshold returns
      // tail + pointer and writes a spill file", "file is created mode 0o600";
      // format.ts details.results carries the unbounded TaskResult.
      const dir = useSpillDir();
      session = await openDelegateBoundary();
      configureDelegate(session, {
        output: { spillThresholdChars: 100, spillTailChars: 30 },
      });
      const subagents = await installSubagentModel(session);
      const output = "H".repeat(200) + "T".repeat(40) + "TAILMARKER";
      subagents.respond([fauxAssistantMessage(output)]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "big" }],
      });
      expect(result.isError).toBe(false);

      // Tail + pointer, not the head.
      expect(result.text).toContain("TAILMARKER");
      expect(result.text).not.toContain("H".repeat(50));
      expect(result.text).toContain("spilled to");
      expect(result.text).toContain("above is the tail");
      expect(result.text).toContain("retention follows OS temp policy");

      // The named file holds the complete output, owner-only.
      const filePath = spilledPathOf(result.text);
      expect(filePath).toBeDefined();
      expect(path.dirname(filePath!)).toBe(dir);
      expect(path.basename(filePath!)).toMatch(
        /^delegate-output-inline-[0-9a-f]{32}\.md$/,
      );
      expect(fs.readFileSync(filePath!, "utf8")).toBe(output);
      expect(fs.statSync(filePath!).mode & 0o777).toBe(0o600);

      // The recovery surface keeps the complete output.
      const details = objectOf(result.details, "details");
      const results = details.results as { output?: string }[] | undefined;
      expect(results?.[0]?.output).toBe(output);
    },
  );

  test("a failed task's partial output is bounded the same way", async () => {
    // v1 evidence: format.ts formatFailedTask renders partial output through
    // renderOutputForLLM.
    const dir = useSpillDir();
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 50, spillTailChars: 20 },
    });
    const subagents = await installSubagentModel(session);
    const partial = "P".repeat(300) + "PARTIAL-TAIL";
    subagents.respond([
      fauxAssistantMessage(partial, {
        stopReason: "error",
        errorMessage: "provider blew up",
      }),
    ]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "fails with partial output" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("provider blew up");
    expect(result.text).toContain("PARTIAL-TAIL");
    expect(result.text).not.toContain("P".repeat(50));
    const filePath = spilledPathOf(result.text);
    expect(filePath).toBeDefined();
    expect(fs.readFileSync(filePath!, "utf8")).toBe(partial);
  });

  test(
    "a running ticket's poll bounds a finished task to a tail and writes " +
      "no file; settling spills it",
    async () => {
      // v1 evidence: spill.test.ts renderOutputForPoll "over tail budget
      // returns the tail + a note, and writes NO file"; ticket-format.ts
      // formatSettledPollLines routes running-ticket output through
      // renderOutputForPoll.
      const dir = useSpillDir();
      session = await openDelegateBoundary();
      configureDelegate(session, {
        output: { spillThresholdChars: 100, spillTailChars: 30 },
      });
      const subagents = await installSubagentModel(session);
      const blocked = gate();
      const output = "Q".repeat(200) + "RUNNING-TAIL";
      subagents.respond([fauxAssistantMessage(output), blocked.step]);

      const dispatched = await callDelegate(session, {
        // #126 vehicle: read-only tasks — the subject is poll bounding of a
        // finished task beside a blocked one.
        tasks: [
          { prompt: "done-fast", tools: ["read"] },
          { prompt: "blocked", tools: ["read"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const running = await pollUntil(session, ticket, /1\/2/);
      expect(running.text).toContain("RUNNING-TAIL");
      expect(running.text).toContain("truncated in this poll");
      expect(running.text).not.toContain("Q".repeat(50));
      expect(running.text).not.toContain("spilled to");
      expect(spillFiles(dir)).toHaveLength(0);

      blocked.release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("spilled to");
      const filePath = spilledPathOf(settled.text);
      expect(filePath).toBeDefined();
      expect(fs.readFileSync(filePath!, "utf8")).toBe(output);
    },
  );

  test("a settled ticket's spill pointer is stable across polls", async () => {
    // v1 evidence: tickets.ts formatCompletedTicket memoizes
    // ticket.formattedResult once workersSettled — repeated polls name one
    // path rather than writing a fresh file per render.
    const dir = useSpillDir();
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 50, spillTailChars: 20 },
    });
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("R".repeat(300))]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "big" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });

    const first = await callDelegateTicket(session, {
      action: "poll",
      ticket,
    });
    const second = await callDelegateTicket(session, {
      action: "poll",
      ticket,
    });
    const firstPath = spilledPathOf(first.text);
    expect(firstPath).toBeDefined();
    expect(spilledPathOf(second.text)).toBe(firstPath);
    // The wait's settle-time render may run before the view freezes
    // (worker quiescence lands after caller settlement), but per-outcome
    // memoization means every render of this outcome shares one file.
    expect(spillFiles(dir)).toHaveLength(1);
  });

  test(
    "a settled ticket renders under the bounds snapshotted at creation, " +
      "not a later config edit",
    async () => {
      // v1 evidence: format.ts formatCompletedTask's dispatch-scoped config
      // snapshot — "the bounds captured when the task started are the ones
      // the caller committed to".
      const dir = useSpillDir();
      session = await openDelegateBoundary();
      configureDelegate(session, {
        output: { spillThresholdChars: 50, spillTailChars: 20 },
      });
      const subagents = await installSubagentModel(session);
      const blocked = gate("W".repeat(300));
      subagents.respond([blocked.step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "big" }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      // The ticket exists with its bounds; widening the config afterwards
      // must not un-spill its settled view.
      configureDelegate(session, {
        output: { spillThresholdChars: 100_000, spillTailChars: 50_000 },
      });
      blocked.release();

      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.text).toContain("spilled to");
      expect(spilledPathOf(waited.text)).toBeDefined();
    },
  );

  test("a spill write failure returns the complete output in-context", async () => {
    // v1 evidence: spill.test.ts renderOutputForLLM "write failure degrades
    // to the full output unchanged (lossless)" — lossless always.
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 50, spillTailChars: 20 },
    });
    savedTmpdir = process.env.TMPDIR;
    tmpdirOverridden = true;
    spillDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-spill-test-"));
    // An unwritable target: os.tmpdir() resolves inside a directory that
    // does not exist, so every spill create fails.
    process.env.TMPDIR = path.join(spillDir, "nonexistent");
    const subagents = await installSubagentModel(session);
    const output = "F".repeat(300) + "FULL-FALLBACK";
    subagents.respond([fauxAssistantMessage(output)]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "big" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(output);
    expect(result.text).not.toContain("spilled to");
  });

  test("the kept tail never begins with a lone surrogate half", async () => {
    // v1 evidence: spill.test.ts "surrogate-pair-aware: cut does not begin
    // on a lone trailing surrogate".
    useSpillDir();
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 50, spillTailChars: 5 },
    });
    const subagents = await installSubagentModel(session);
    // 100 BMP chars + 50 astral chars: a 5-unit tail cut lands on the low
    // surrogate of a pair and must advance to the whole emoji.
    subagents.respond([
      fauxAssistantMessage("h".repeat(100) + "😀".repeat(50)),
    ]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "emoji" }],
    });
    expect(result.isError).toBe(false);
    const cut = result.text.indexOf("…");
    expect(cut).toBeGreaterThanOrEqual(0);
    const first = result.text.charCodeAt(cut + 1);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(result.text).not.toContain("\uFFFD");
  });

  test("empty and placeholder outputs are never bounded", async () => {
    // v1 evidence: spill.test.ts "empty / placeholder outputs pass through
    // without spilling".
    const dir = useSpillDir();
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 1, spillTailChars: 1 },
    });
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("(no output)")]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "quiet" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("(no output)");
    expect(result.text).not.toContain("spilled to");
    expect(spillFiles(dir)).toHaveLength(0);
  });

  test("whitespace-only over-threshold output still spills", async () => {
    // Bug 9: a trim()-based emptiness exemption let 100000 spaces pass a
    // 100-char limit. Whitespace still consumes LLM context, so only bare
    // empty and the exact placeholder bypass bounding.
    const dir = useSpillDir();
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 100, spillTailChars: 20 },
    });
    const subagents = await installSubagentModel(session);
    const output = " ".repeat(500);
    subagents.respond([fauxAssistantMessage(output)]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "spaces" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("spilled to");
    const filePath = spilledPathOf(result.text);
    expect(filePath).toBeDefined();
    expect(fs.readFileSync(filePath!, "utf8")).toBe(output);
    expect(spillFiles(dir)).toHaveLength(1);
  });

  test("malformed output bounds fail the whole call before any task starts", async () => {
    // v1 evidence: config.ts validation — "output must be an object",
    // "output.spillThresholdChars must be a positive integer",
    // "output.spillTailChars must be a non-negative integer".
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SHOULD-NOT-RUN")]);

    for (const [output, needle] of [
      ["not-an-object", /output must be an object/],
      [
        { spillThresholdChars: 0 },
        /output\.spillThresholdChars must be a positive integer/,
      ],
      [
        { spillThresholdChars: 1.5 },
        /output\.spillThresholdChars must be a positive integer/,
      ],
      [
        { spillTailChars: -1 },
        /output\.spillTailChars must be a non-negative integer/,
      ],
      [
        { spillTailChars: "x" },
        /output\.spillTailChars must be a non-negative integer/,
      ],
    ] as const) {
      configureDelegate(session, { output });
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "never" }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(needle);
      expect(result.text).not.toContain("SHOULD-NOT-RUN");
    }
    expect(subagents.state.callCount).toBe(0);
  });
});

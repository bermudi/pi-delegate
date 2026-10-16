import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
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
 * Output-bounding contract (issue #25, re-ruled by #145 on 2026-10-16):
 * a successful task's output stays verbatim up to a high emergency valve
 * (~25k tokens), over which the LLM-facing result keeps a bounded tail and
 * points at a content-addressed owner-only file under the agent directory
 * (never OS temp); a failed task's partial output caps at an error tail
 * (~900 tokens, Codex parity) and points at the durable copies. The
 * complete record always stays in `details`. Everything here drives the
 * registered `delegate` tool — the session's temp cwd is its agent dir, so
 * spills land in `<cwd>/delegate-spills`.
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

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  /** The session's temp cwd is its agent dir; spills live under it. */
  function spillDirOf(s: TestSession): string {
    return path.join(s.cwd, "delegate-spills");
  }

  test("under-threshold output passes through unchanged", async () => {
    // v1 evidence: spill.test.ts decideSpill "under threshold passes through
    // unchanged, no spill" and "exactly at threshold does NOT spill".
    session = await openDelegateBoundary();
    const dir = spillDirOf(session);
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
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("a realistic result renders verbatim under the shipped valve (#145)", async () => {
    // The #145 incident class: 8-9k-char outputs used to spill at the old
    // 8k threshold. The ruled default delivers successful finals verbatim
    // (incumbent parity) until the ~25k-token emergency valve.
    session = await openDelegateBoundary();
    const dir = spillDirOf(session);
    const subagents = await installSubagentModel(session);
    const output = `FINDING-${"y".repeat(8500)}-END`;
    subagents.respond([fauxAssistantMessage(output)]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "research" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(output);
    expect(result.text).not.toContain("spilled to");
    expect(fs.existsSync(dir)).toBe(false);
  });

  test(
    "over-valve sync output keeps a tail, writes the whole output to an " +
      "owner-only file under the agent directory, and leaves the complete record in details",
    async () => {
      // v1 evidence: spill.test.ts renderOutputForLLM "over threshold returns
      // tail + pointer and writes a spill file", "file is created mode 0o600";
      // format.ts details.results carries the unbounded TaskResult.
      session = await openDelegateBoundary();
      const dir = spillDirOf(session);
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
      expect(result.text).toContain("swept only after 30 days");

      // The named file holds the complete output, owner-only, under the
      // agent directory — never OS temp (#145).
      const filePath = spilledPathOf(result.text);
      expect(filePath).toBeDefined();
      expect(path.dirname(filePath!)).toBe(dir);
      expect(path.basename(filePath!)).toMatch(
        /^delegate-output-inline-[0-9a-f]{16}\.md$/,
      );
      expect(fs.readFileSync(filePath!, "utf8")).toBe(output);
      expect(fs.statSync(filePath!).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

      // The recovery surface keeps the complete output.
      const details = objectOf(result.details, "details");
      const results = details.results as { output?: string }[] | undefined;
      expect(results?.[0]?.output).toBe(output);
    },
  );

  test("a successful outcome names its session transcript (#145)", async () => {
    // The parent gets a durable pointer to the worker's full trajectory on
    // every success — plain pointer, no resume hint (failure-recovery
    // teaching).
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SESSION-LINE-CHECK")]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "anything" }],
    });
    expect(result.isError).toBe(false);
    const line = /^session: (\S+)$/m.exec(result.text);
    expect(line).not.toBeNull();
    const sessionFile = line?.[1];
    expect(sessionFile).toBeDefined();
    expect(fs.existsSync(sessionFile!)).toBe(true);
    // The resume hint stays failure-only.
    expect(result.text).not.toContain("resumeFrom");
  });

  test("a failed task's partial output is capped at the error tail (#145)", async () => {
    // v1 evidence: format.ts formatFailedTask renders partial output
    // bounded; #145 ruling: error payloads cap at `errorTailChars` (Codex
    // ~900-token parity) and never write a spill file — the complete text
    // stays on the durable copies.
    session = await openDelegateBoundary();
    const dir = spillDirOf(session);
    configureDelegate(session, {
      output: { spillThresholdChars: 50, spillTailChars: 20, errorTailChars: 30 },
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
    expect(result.text).toContain("partial output truncated");
    expect(result.text).toContain("details and the session transcript");
    // No spill file for an error payload.
    expect(fs.existsSync(dir)).toBe(false);
    // The complete text still rides the durable record.
    const details = objectOf(result.details, "details");
    const results = details.results as { output?: string }[] | undefined;
    expect(results?.[0]?.output).toBe(partial);
  });

  test(
    "a running ticket's poll bounds a finished task to a tail and writes " +
      "no file; settling spills it",
    async () => {
      // v1 evidence: spill.test.ts renderOutputForPoll "over tail budget
      // returns the tail + a note, and writes NO file"; ticket-format.ts
      // formatSettledPollLines routes running-ticket output through
      // renderOutputForPoll.
      session = await openDelegateBoundary();
      const dir = spillDirOf(session);
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
          { prompt: "done-fast", agent: "explore" },
          { prompt: "blocked", agent: "explore" },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const running = await pollUntil(session, ticket, /1\/2/);
      expect(running.text).toContain("RUNNING-TAIL");
      expect(running.text).toContain("truncated in this poll");
      expect(running.text).not.toContain("Q".repeat(50));
      expect(running.text).not.toContain("spilled to");
      expect(fs.existsSync(dir)).toBe(false);

      blocked.release();
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
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
    // path rather than writing a fresh file per render. #145: the file name
    // is content-addressed, so the same output renders the same path.
    session = await openDelegateBoundary();
    const dir = spillDirOf(session);
    configureDelegate(session, {
      output: { spillThresholdChars: 50, spillTailChars: 20 },
    });
    const subagents = await installSubagentModel(session);
    const output = "R".repeat(300);
    subagents.respond([fauxAssistantMessage(output)]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "big" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegateTicket(session, {
      action: "wait",
      ticket,
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
    expect(spillFiles(dir)).toHaveLength(1);
  });

  test(
    "a settled ticket renders under the bounds snapshotted at creation, " +
      "not a later config edit",
    async () => {
      // v1 evidence: format.ts formatCompletedTask's dispatch-scoped config
      // snapshot — "the bounds captured when the task started are the ones
      // the caller committed to".
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
      });
      expect(waited.text).toContain("spilled to");
      expect(spilledPathOf(waited.text)).toBeDefined();
    },
  );

  test("a spill write failure returns the complete output in-context", async () => {
    // v1 evidence: spill.ts renderOutputForLLM "write failure degrades to
    // the full output unchanged (lossless)" — lossless always. An
    // unwritable target: a regular file occupies the spill directory's
    // path, so every spill create fails.
    session = await openDelegateBoundary();
    configureDelegate(session, {
      output: { spillThresholdChars: 50, spillTailChars: 20 },
    });
    fs.writeFileSync(path.join(session.cwd, "delegate-spills"), "not a directory");
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

  test("expired spill files are swept on the pipeline's first dispatch", async () => {
    // #145: spills live as long as the transcripts naming them (30 days),
    // then go. The sweep rides the first dispatch's agent-dir resolution —
    // sync batches never connect the ticket store, and this dispatch is
    // sync, so it proves the pipeline is the seam (see DispatchPipeline).
    session = await openDelegateBoundary();
    const dir = spillDirOf(session);
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "delegate-output-stale-deadbeef.md");
    const fresh = path.join(dir, "delegate-output-fresh-CAFEBABE.md");
    fs.writeFileSync(stale, "old");
    fs.writeFileSync(fresh, "new");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("SWEEP-CHECK")]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "trigger connect" }],
    });
    expect(result.isError).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test("a truncated file at the spill path is repaired by the next render", async () => {
    // Post-#145 review finding: a same-name file used to be trusted as
    // identical content on EEXIST, so a hard kill between create and write
    // left a partial file owning the content hash — every later render
    // pointed at truncated content while advertising the full size, and
    // only the 30-day sweep could fix it. A re-render must verify, not
    // trust the name: same pointer path, complete file restored, and no
    // stray write siblings left behind.
    session = await openDelegateBoundary();
    const dir = spillDirOf(session);
    configureDelegate(session, {
      output: { spillThresholdChars: 50, spillTailChars: 20 },
    });
    const subagents = await installSubagentModel(session);
    const output = "R".repeat(300) + "REPAIR-END";
    subagents.respond([fauxAssistantMessage(output)]);

    const first = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "big" }],
    });
    const spillPath = spilledPathOf(first.text);
    expect(spillPath).toBeDefined();
    expect(fs.readFileSync(spillPath!, "utf8")).toBe(output);

    // Simulate the crash window: a partial file owns the content hash.
    fs.writeFileSync(spillPath!, output.slice(0, 120));

    subagents.respond([fauxAssistantMessage(output)]);
    const second = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "big again" }],
    });
    expect(second.isError).toBe(false);
    expect(spilledPathOf(second.text)).toBe(spillPath);
    expect(fs.readFileSync(spillPath!, "utf8")).toBe(output);
    expect(spillFiles(dir)).toHaveLength(1);
  });

  test("the kept tail never begins with a lone surrogate half", async () => {
    // v1 evidence: spill.test.ts "surrogate-pair-aware: cut does not begin
    // on a lone trailing surrogate".
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
    session = await openDelegateBoundary();
    const dir = spillDirOf(session);
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
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("whitespace-only over-threshold output still spills", async () => {
    // Bug 9: a trim()-based emptiness exemption let 100000 spaces pass a
    // 100-char limit. Whitespace still consumes LLM context, so only bare
    // empty and the exact placeholder bypass bounding.
    session = await openDelegateBoundary();
    const dir = spillDirOf(session);
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
    // "output.spillTailChars must be a non-negative integer". #145 adds
    // errorTailChars with the same teaching.
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
      [
        { errorTailChars: -1 },
        /output\.errorTailChars must be a non-negative integer/,
      ],
      [
        { errorTailChars: "x" },
        /output\.errorTailChars must be a non-negative integer/,
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

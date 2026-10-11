import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { Check } from "typebox/value";
// The exported details schemas are the stabilization artifact (issue
// #51, Phase A — Pi's ToolDefinition has no result/details schema slot),
// so pinning them is done by `Check`ing fixtures directly — the same
// seam details.test.ts uses for real dispatch output.
import {
  taskOutcomeDetailsSchema,
  ticketDetailsSchema,
} from "../../src/details.ts";
import {
  callDelegateTicket,
  objectOf,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/**
 * The strict/tolerant split these fixtures pin: emitted-details schemas
 * reject anything beyond the caller-visible shape (`additionalProperties:
 * false` — an internal field like `durationMs` must fail), while the
 * ticket journal's record schemas tolerate unknown keys so records
 * written by older versions keep loading (additive evolution;
 * #62/#123/#127). Tolerant means unknown KEYS pass — enumeration VALUES
 * are still the shared contract and an unknown status must not parse.
 */

const TICKETS_DIR = "delegate-tickets";

function writeRecord(
  session: TestSession,
  id: string,
  record: Record<string, unknown>,
): void {
  const dir = join(session.cwd, TICKETS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record), {
    mode: 0o600,
  });
}

/** Minimal shape: everything the v1 record contract requires. */
function minimalRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id,
    status: "completed",
    tasks: [{ id: "task-1", agent: "inline" }],
    outcomes: [
      { index: 0, id: "task-1", status: "ok", output: "FIXTURE-OUTPUT", retries: 0 },
    ],
    outputBounds: { spillThresholdChars: 40000, spillTailChars: 8000 },
    createdAt: 1_700_000_000_000,
    notices: [],
    ...overrides,
  };
}

describe("schema fixtures — strict emitted details vs tolerant journal records", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("a pre-#127 journal record (no durationMs/transcriptStart, unknown keys) round-trips through the load path", async () => {
    // Hand-written historical shape: none of the optional fields added
    // since the first record format, plus keys a future writer might
    // add — tolerant parsing must ignore the unknown keys entirely.
    session = await openDelegateBoundary();
    const id = "t-00000000-0000-4000-8000-000000000001";
    const record = minimalRecord(id);
    (record as Record<string, unknown>).legacyEnvelope = { from: "v0" };
    (record.outcomes[0] as Record<string, unknown>).futureProbe = "yes";
    // Journal tolerance applies inside nested objects too: an unknown
    // key on `integration` — and on a `conflicts` entry — survives load
    // just like the top-level outcome key above.
    (record.outcomes[0] as Record<string, unknown>).integration = {
      status: "applied_unverified",
      proposedFiles: ["a.ts"],
      appliedFiles: ["a.ts"],
      futureNested: 1,
      conflicts: [{ path: "a.ts", reason: "diverged", futureConflict: true }],
    };
    writeRecord(session, id, record);

    const polled = await callDelegateTicket(session, { action: "poll", ticket: id });
    expect(polled.isError).toBe(false);
    expect(polled.text).toContain("completed");
    expect(polled.text).toContain("FIXTURE-OUTPUT");

    // Tolerant load must not leak into the strict emitted boundary: the
    // cold-polled details Check against ticketDetailsSchema — which
    // nests taskOutcomeDetailsSchema (additionalProperties: false) — and
    // every tolerated unknown key is absent from the returned outcome,
    // nested `integration`, and `conflicts` entries alike.
    expect(Check(ticketDetailsSchema, polled.details)).toBe(true);
    const results = objectOf(polled.details, "details").results as Record<
      string,
      unknown
    >[];
    expect("futureProbe" in results[0]!).toBe(false);
    const integration = objectOf(results[0]!.integration, "integration");
    expect("futureNested" in integration).toBe(false);
    const conflicts = integration.conflicts as Record<string, unknown>[];
    expect("futureConflict" in conflicts[0]!).toBe(false);
  });

  test("a record covering every task status, integration status, and verdict parses through the journal path", async () => {
    // The shared enumeration sets, asserted literally: all six task
    // statuses, all six integration statuses, all three verdicts — plus
    // durationMs, which is a journal-only field the strict emitted
    // schema must never admit (see the emitted fixture below).
    session = await openDelegateBoundary();
    const id = "t-00000000-0000-4000-8000-000000000002";
    writeRecord(session, id, {
      version: 1,
      id,
      status: "partial",
      tasks: [
        { id: "t-ok", agent: "inline" },
        { id: "t-fail", agent: "inline" },
        { id: "t-cancel", agent: "inline" },
        { id: "t-block", agent: "inline" },
        { id: "t-inter", agent: "inline" },
        { id: "t-budget", agent: "inline" },
      ],
      outcomes: [
        {
          index: 0, id: "t-ok", status: "ok", output: "OUT-OK", retries: 0,
          usage: {
            input: 10, output: 5, cacheRead: 1, cacheWrite: 2,
            cacheWrite1h: 2, reasoning: 3, totalTokens: 21,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          integration: { status: "applied_unverified", proposedFiles: ["a.ts"], appliedFiles: ["a.ts"] },
          verdict: "PASS",
        },
        {
          index: 1, id: "t-fail", status: "failed", error: "boom", retries: 2,
          integration: { status: "conflict", proposedFiles: [], appliedFiles: [] },
          verdict: "FAIL",
        },
        {
          index: 2, id: "t-cancel", status: "cancelled", retries: 0,
          integration: { status: "retained", proposedFiles: [], appliedFiles: ["b.ts"] },
        },
        {
          index: 3, id: "t-block", status: "blocked", retries: 0, blockedBy: ["t-fail"],
          integration: { status: "no_changes", proposedFiles: [], appliedFiles: [] },
        },
        {
          index: 4, id: "t-inter", status: "interrupted", retries: 0,
          durationMs: 1234,
          integration: { status: "discarded", proposedFiles: ["c.ts"], appliedFiles: [] },
          verdict: "AMBIGUOUS",
        },
        {
          index: 5, id: "t-budget", status: "budget-exhausted", retries: 0,
          integration: { status: "apply_failed", proposedFiles: [], appliedFiles: [], reason: "patch rejected" },
        },
      ],
      outputBounds: { spillThresholdChars: 40000, spillTailChars: 8000 },
      createdAt: 1_700_000_000_000,
      notices: [],
    });

    const polled = await callDelegateTicket(session, { action: "poll", ticket: id });
    expect(polled.isError).toBe(false);
    expect(polled.text).toContain("OUT-OK");
    expect(polled.text).toContain("budget-exhausted");
    expect(polled.text).toContain("interrupted");
    expect(polled.text).toContain("verdict: AMBIGUOUS");
  });

  test("an unknown enumeration value does not parse through the journal path", async () => {
    // Tolerant is about unknown keys, not unknown values: a status the
    // shared enumeration does not contain must fail record validation.
    session = await openDelegateBoundary();
    const id = "t-00000000-0000-4000-8000-000000000003";
    const record = minimalRecord(id);
    (record.outcomes[0] as Record<string, unknown>).status = "melted";
    writeRecord(session, id, record);

    const polled = await callDelegateTicket(session, { action: "poll", ticket: id });
    expect(polled.isError).toBe(true);
    expect(polled.text).toMatch(/recover ticket|invalid or unsupported/i);
  });

  test("a realistic details.results entry Checks strictly — and fails with an internal field", () => {
    // The emitted half of the split: a captured realistic outcome passes
    // taskOutcomeDetailsSchema, but the same payload carrying an
    // internal field (durationMs, #127 — legal in the journal, asserted
    // in the fixture above) must fail the strict emitted boundary. So
    // must an unknown status or a stray key inside integration.
    const emitted = {
      index: 0,
      id: "task-1",
      status: "ok",
      output: "DONE",
      retries: 0,
      usage: {
        input: 10, output: 5, cacheRead: 1, cacheWrite: 2,
        cacheWrite1h: 2, reasoning: 3, totalTokens: 21,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      integration: {
        status: "applied_unverified",
        proposedFiles: ["a.ts"],
        appliedFiles: ["a.ts"],
      },
      attributedFiles: ["/repo/a.ts"],
      observedFiles: ["/repo/a.ts"],
      uncertainFiles: false,
      shellObserved: false,
      concurrentWriters: ["parent"],
      verdict: "PASS",
    };
    expect(Check(taskOutcomeDetailsSchema, emitted)).toBe(true);
    expect(Check(taskOutcomeDetailsSchema, { ...emitted, durationMs: 42 })).toBe(false);
    expect(Check(taskOutcomeDetailsSchema, { ...emitted, status: "melted" })).toBe(false);
    expect(
      Check(taskOutcomeDetailsSchema, {
        ...emitted,
        integration: { ...(emitted.integration as object), stray: true },
      }),
    ).toBe(false);
  });
});

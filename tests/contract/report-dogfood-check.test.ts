import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReportScenario,
  RECEIPT_SENTENCE,
  REPORT_TREE,
  type ReportScenarioEvidence,
} from "../../scripts/dogfood-report.ts";

/**
 * The dogfood's report scenario asserts a live session's spool, transcript,
 * and diagnostics channel. A live-model run cannot be part of the provider-free
 * suite, so this drives the very same assertion code with synthetic evidence:
 * a good fixture must pass silently, and each way the scenario can rot (wrong
 * mode bits, no marker, no session-file pointer, prose in the diagnostics
 * channel, a missing receipt, a second record) must be named.
 *
 * The module under test is dev tooling under `scripts/`, not a production
 * internal: the checks are the artifact.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly evidence: ReportScenarioEvidence;
  readonly spool: string;
  readonly recordPath: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "delegate-report-scenario-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const agentDir = join(root, "agent");
  const spool = join(agentDir, REPORT_TREE);
  mkdirSync(spool, { recursive: true, mode: 0o700 });
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, "{}\n");
  const marker = "DOGMARK-scenario";
  const recordPath = join(spool, "abcdef123456.json");
  writeFileSync(
    recordPath,
    `${JSON.stringify(
      {
        id: "abcdef123456",
        filedAt: "2026-10-15T00:00:00.000Z",
        what: `${marker} dogfood report-surface check`,
        expected: "the surface accepts one report",
        observed: "it did",
        extensionVersion: "0.6.1",
        hostVersion: "0.87.0",
        sessionFile,
        ticketsTouched: ["t-11111111-2222-3333-4444-555555555555"],
        telemetry: { sessionId: "session-1", windowStart: 1, windowEnd: 2 },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const diagnostic = (record: Record<string, unknown>): string =>
    `[delegate] ${JSON.stringify(record)}`;
  const output = diagnostic({
    time: "2026-10-15T00:00:00.000Z",
    pid: 1,
    level: "info",
    event: "bug report filed",
    context: { path: recordPath, count: 1 },
  });
  const transcript = [
    JSON.stringify({ type: "tool_use", name: "delegate_report", input: {} }),
    JSON.stringify({ type: "tool_result", content: RECEIPT_SENTENCE }),
    marker,
  ].join("\n");
  return {
    evidence: { agentDir, marker, transcript, output },
    spool,
    recordPath,
  };
}

/** Read the spooled record, mutate it, write it back at its real mode. */
function patchRecord(
  path: string,
  mutate: (record: Record<string, unknown>) => void,
): void {
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(record);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function failuresOf(evidence: ReportScenarioEvidence): string[] {
  const failures: string[] = [];
  assertReportScenario(evidence, failures);
  return failures;
}

function reportOf(evidence: ReportScenarioEvidence): string {
  return failuresOf(evidence).join("\n");
}

test("a good fixture passes every report-scenario check silently", () => {
  const { evidence } = fixture();
  expect(failuresOf(evidence)).toEqual([]);
});

test("each way the scenario can rot is named", () => {
  // Missing spool: the message points at the tree, not at the model's prose.
  {
    const { evidence } = fixture();
    rmSync(join(evidence.agentDir, REPORT_TREE), { recursive: true, force: true });
    expect(reportOf(evidence)).toContain("report spool");
  }
  // Wrong file mode: a record readable by anyone is the privacy failure.
  {
    const { evidence, recordPath } = fixture();
    chmodSync(recordPath, 0o644);
    expect(reportOf(evidence)).toContain("not a 0600 single-link regular file");
  }
  // Wrong tree mode.
  {
    const { evidence } = fixture();
    chmodSync(join(evidence.agentDir, REPORT_TREE), 0o755);
    expect(reportOf(evidence)).toContain("is not 0700");
  }
  // A record that is not this run's report (marker missing).
  {
    const { evidence } = fixture();
    expect(reportOf({ ...evidence, marker: "OTHER-MARKER" })).toContain(
      "no spooled report carries the marker",
    );
  }
  // The extension's ground truth, field by field.
  for (const [field, expected] of [
    ["extensionVersion", "is missing 'extensionVersion'"],
    ["hostVersion", "is missing 'hostVersion'"],
    ["sessionFile", "does not point at a real sessionFile"],
    ["ticketsTouched", "lists no tickets touched this session"],
    ["telemetry", "carries no usable telemetry pointer"],
  ] as const) {
    const { evidence, recordPath } = fixture();
    patchRecord(recordPath, (record) => {
      delete record[field];
    });
    expect(`${field}: ${reportOf(evidence)}`).toContain(expected);
  }
  // The model's half is required structure.
  {
    const { evidence, recordPath } = fixture();
    patchRecord(recordPath, (record) => {
      record.expected = "";
    });
    expect(reportOf(evidence)).toContain("is missing the record field 'expected'");
  }
  // A model summary instead of the receipt sentence in the transcript.
  {
    const { evidence } = fixture();
    expect(reportOf({ ...evidence, transcript: "delegate_report done" })).toContain(
      "receipt sentence",
    );
  }
  // The scenario files exactly one report.
  {
    const { evidence, spool } = fixture();
    writeFileSync(join(spool, "second.json"), "{}\n", { mode: 0o600 });
    expect(reportOf(evidence)).toContain("exactly 1 spooled report");
  }
  // The diagnostics channel: exactly one allowlisted info event...
  {
    const { evidence, recordPath } = fixture();
    expect(reportOf({ ...evidence, output: "" })).toContain("found 0");
    const record = {
      time: "2026-10-15T00:00:00.000Z",
      pid: 1,
      level: "info",
      event: "bug report filed",
      context: { path: recordPath, count: 1 },
    };
    expect(
      reportOf({
        ...evidence,
        output: `[delegate] ${JSON.stringify({ ...record, level: "error" })}`,
      }),
    ).toContain("logged at level error");
    expect(
      reportOf({
        ...evidence,
        output: `[delegate] ${JSON.stringify({
          ...record,
          context: { path: recordPath, count: 1, prose: "leak" },
        })}`,
      }),
    ).toContain("context keys are count,path,prose");
  }
  // ...and model prose never rides it, even under an allowlisted key.
  {
    const { evidence, recordPath } = fixture();
    const prose = "the error message lied about the workspace";
    patchRecord(recordPath, (record) => {
      record.observed = prose;
    });
    const record = {
      time: "2026-10-15T00:00:00.000Z",
      pid: 1,
      level: "info",
      event: "bug report filed",
      context: { path: recordPath, count: 1, note: prose },
    };
    expect(
      reportOf({ ...evidence, output: `[delegate] ${JSON.stringify(record)}` }),
    ).toContain("entered the diagnostics channel");
  }
});

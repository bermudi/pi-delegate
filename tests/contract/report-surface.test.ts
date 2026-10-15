import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  VERSION as PI_VERSION,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { diagnosticRecords } from "../support/diagnostic-records.ts";
import {
  callDelegate,
  callDelegateTool,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  registeredTool,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/**
 * SPEC v3 "Report surface": `delegate_report` is the parent model's return
 * channel for the collisions only it can see. Everything here is driven
 * through the registered tool — never a production import — so the assertions
 * are about the surface a caller (and the operator) actually gets:
 *
 *  - the record is a local, owner-only file whose model half is exactly what
 *    was sent and whose extension half is process ground truth;
 *  - the receipt names the record's pointers and promises nothing;
 *  - identical content is one record, and the per-session cap counts accepted
 *    reports only;
 *  - an unknown `ticketId` rejects listing the set this session can resolve;
 *  - model prose never enters the diagnostics channel, and a planted symlink
 *    or a non-conforming existing entry is refused rather than followed.
 */

// Secure descriptor-relative routing (and therefore report filing) is a Linux
// capability; the unsupported path is the graceful alternative everywhere else.
const linuxTest = process.platform === "linux" ? test : test.skip;

const EXTENSION_VERSION = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
  ) as { version: string }
).version;

const REPORT_FIELD_LIMIT = 512;
const REPORT_SESSION_CAP = 3;

interface ReportRecord {
  id: string;
  filedAt: string;
  what: string;
  expected: string;
  observed: string;
  ticketId?: string;
  extensionVersion: string;
  hostVersion: string;
  sessionFile?: string;
  ticketsTouched: string[];
  telemetry: { sessionId: string; windowStart?: number; windowEnd: number };
}

interface RenderedComponent {
  render(width: number): string[];
}

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function renderCall(active: TestSession, args: unknown): string {
  const tool = registeredTool(active, "delegate_report") as unknown as {
    renderCall(
      args: unknown,
      theme: unknown,
      context: { lastComponent?: unknown },
    ): RenderedComponent;
  };
  return tool
    .renderCall(args, plainTheme, { lastComponent: undefined })
    .render(8192)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

function renderResult(
  active: TestSession,
  result: { content: unknown; details?: unknown },
  expanded: boolean,
): string {
  const tool = registeredTool(active, "delegate_report") as unknown as {
    renderResult(
      result: { content: unknown; details?: unknown },
      options: { expanded: boolean; isPartial: boolean },
      theme: unknown,
      context: { lastComponent?: unknown; isError?: boolean },
    ): RenderedComponent;
  };
  return tool
    .renderResult(result, { expanded, isPartial: false }, plainTheme, {
      lastComponent: undefined,
    })
    .render(8192)
    .join("\n");
}

function reportIdOf(what: string, expected: string, observed: string): string {
  return createHash("sha256")
    .update(`${what}\u0000${expected}\u0000${observed}`)
    .digest("hex")
    .slice(0, 12);
}

describe("delegate_report — the parent model's local defect spool", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  const open = async (): Promise<TestSession> => {
    const opened = await openDelegateBoundary();
    session = opened;
    return opened;
  };

  const spoolOf = (active: TestSession): string =>
    join(active.cwd, "delegate-reports");

  const spoolFiles = (active: TestSession): string[] => {
    const dir = spoolOf(active);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };

  const readRecord = (active: TestSession, path: string): ReportRecord =>
    JSON.parse(readFileSync(path, "utf8")) as ReportRecord;

  const reportCall = (
    active: TestSession,
    fields: Record<string, unknown>,
  ) => callDelegateTool(active, "delegate_report", fields);

  const fields = (): Record<string, string> => ({
    what: `WHAT_${randomUUID()}`,
    expected: `EXPECTED_${randomUUID()}`,
    observed: `OBSERVED_${randomUUID()}`,
  });

  linuxTest("a filed report spools an owner-only record and receipts its pointers", async () => {
    const active = await open();
    const sent = fields();
    const result = await reportCall(active, sent);

    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "This is a local record for the operator; it changes nothing about running work.",
    );
    const details = objectOf(result.details);
    expect(details.mode).toBe("report");
    expect(details.status).toBe("filed");
    const id = String(details.reportId);
    const path = String(details.path);
    // The id IS the content address, and the receipt's path is the real file.
    expect(id).toBe(reportIdOf(sent.what!, sent.expected!, sent.observed!));
    expect(path).toBe(join(spoolOf(active), `${id}.json`));
    expect(result.text).toContain(id);
    expect(result.text).toContain(path);

    // Owner-only bits: 0700 tree, 0600 single-link file owned by this user.
    const dir = lstatSync(spoolOf(active));
    expect(dir.isDirectory()).toBe(true);
    expect(dir.isSymbolicLink()).toBe(false);
    expect(dir.mode & 0o777).toBe(0o700);
    expect(dir.uid).toBe(process.getuid!());
    const file = lstatSync(path);
    expect(file.isFile()).toBe(true);
    expect(file.isSymbolicLink()).toBe(false);
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.nlink).toBe(1);
    expect(file.uid).toBe(process.getuid!());

    // The record: the model's three fields verbatim, plus the ground truth
    // this process holds (and nothing else).
    const record = readRecord(active, path);
    expect(record.what).toBe(sent.what as string);
    expect(record.expected).toBe(sent.expected as string);
    expect(record.observed).toBe(sent.observed as string);
    expect(record.id).toBe(id);
    expect(typeof record.filedAt).toBe("string");
    expect(record.extensionVersion).toBe(EXTENSION_VERSION);
    expect(record.hostVersion).toBe(PI_VERSION);
    expect(record.ticketsTouched).toEqual([]);
    expect(record.telemetry.sessionId).toBe(
      (active.session as AgentSession).sessionManager.getSessionId() as string,
    );
    expect(typeof record.telemetry.windowEnd).toBe("number");
    // A session with nothing to date the window from records the gap.
    expect(record.telemetry.windowStart).toBeUndefined();
    const claimed = (
      (active.session as AgentSession).sessionManager as unknown as {
        getSessionFile?: () => string | undefined;
      }
    ).getSessionFile?.();
    const sessionFile =
      typeof claimed === "string" && claimed !== "" ? claimed : undefined;
    expect(record.sessionFile).toBe(sessionFile);
    // An unavailable host capability is a visible gap — the key is absent,
    // never an invented path.
    expect("sessionFile" in record).toBe(sessionFile !== undefined);
    expect(Object.keys(record).sort()).toEqual(
      [
        "expected",
        "extensionVersion",
        "filedAt",
        "hostVersion",
        "id",
        "observed",
        "telemetry",
        "ticketsTouched",
        "what",
        ...(sessionFile === undefined ? [] : ["sessionFile"]),
      ].sort(),
    );
    // The receipt lists the attached-evidence pointers.
    for (const pointer of [
      `extension ${EXTENSION_VERSION}`,
      `host pi ${PI_VERSION}`,
      "tickets none touched this session",
      `telemetry ${record.telemetry.sessionId}`,
    ]) {
      expect(result.text).toContain(pointer);
    }
  });

  linuxTest("this session's tickets and their window ride the record as pointers", async () => {
    const active = await open();
    const subagents = await installSubagentModel(active);
    subagents.respond([fauxAssistantMessage("DONE")]);
    const dispatched = await callDelegate(active, {
      tasks: [{ prompt: "background work" }],
    });
    const ticket = ticketIdOf(dispatched.text);

    const result = await reportCall(active, { ...fields(), ticketId: ticket });
    expect(result.isError).toBe(false);
    const record = readRecord(active, String(objectOf(result.details).path));
    expect(record.ticketId).toBe(ticket);
    expect(record.ticketsTouched).toContain(ticket);
    expect(typeof record.telemetry.windowStart).toBe("number");
    expect(record.telemetry.windowEnd).toBeGreaterThanOrEqual(
      record.telemetry.windowStart!,
    );
    expect(result.text).toContain(`tickets ${ticket}`);
  });

  linuxTest("identical content is one record and never consumes the cap", async () => {
    const active = await open();
    const first = fields();
    const filed = await reportCall(active, first);
    expect(filed.isError).toBe(false);
    const id = String(objectOf(filed.details).reportId);

    const duplicate = await reportCall(active, first);
    expect(duplicate.isError).toBe(false);
    expect(duplicate.text).toContain(`duplicate of ${id}`);
    expect(duplicate.text).toContain("not re-filed");
    expect(duplicate.text).not.toContain(id + id);
    expect(spoolFiles(active)).toEqual([`${id}.json`]);

    // Two more distinct reports exhaust the budget; the duplicate still
    // answers as a duplicate (and still does not count).
    expect((await reportCall(active, fields())).isError).toBe(false);
    expect((await reportCall(active, fields())).isError).toBe(false);
    const lateDuplicate = await reportCall(active, first);
    expect(lateDuplicate.isError).toBe(false);
    expect(lateDuplicate.text).toContain(`duplicate of ${id}`);

    const beyond = fields();
    const capped = await reportCall(active, beyond);
    expect(capped.isError).toBe(true);
    expect(capped.text).toContain(`cap of ${REPORT_SESSION_CAP}`);
    expect(capped.text).toContain(
      `Nothing was written and nothing about running work changed.`,
    );
    expect(objectOf(capped.details).status).toBe("capped");
    expect(objectOf(capped.details).path).toBeUndefined();
    // The capped report left no record behind: exactly the three accepted
    // reports exist, and the refused content is not among them.
    const files = spoolFiles(active);
    expect(files).toHaveLength(REPORT_SESSION_CAP);
    expect(files).toContain(`${id}.json`);
    expect(
      files.includes(
        `${reportIdOf(beyond.what!, beyond.expected!, beyond.observed!)}.json`,
      ),
    ).toBe(false);
  });

  linuxTest("an unknown ticketId rejects listing the resolvable set", async () => {
    const active = await open();
    const empty = await reportCall(active, { ...fields(), ticketId: "t-nope" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain('unknown ticketId "t-nope"');
    expect(empty.text).toContain("There are no tickets right now");
    expect(spoolFiles(active)).toEqual([]);

    const subagents = await installSubagentModel(active);
    subagents.respond([fauxAssistantMessage("DONE")]);
    const dispatched = await callDelegate(active, {
      tasks: [{ prompt: "background work" }],
    });
    const ticket = ticketIdOf(dispatched.text);
    const rejected = await reportCall(active, {
      ...fields(),
      ticketId: "t-nope",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('unknown ticketId "t-nope"');
    expect(rejected.text).toContain(`"${ticket}"`);
    expect(spoolFiles(active)).toEqual([]);
  });

  linuxTest("field bounds and required fields reject with teaching", async () => {
    const active = await open();
    const oversized = await reportCall(active, {
      ...fields(),
      what: "x".repeat(REPORT_FIELD_LIMIT + 1),
    });
    expect(oversized.isError).toBe(true);
    expect(oversized.text).toContain(
      `what must be at most ${REPORT_FIELD_LIMIT} characters; got ${
        REPORT_FIELD_LIMIT + 1
      }`,
    );

    const blank = await reportCall(active, { ...fields(), observed: "   " });
    expect(blank.isError).toBe(true);
    expect(blank.text).toContain("observed is required");

    const missing = await reportCall(active, {
      expected: "e",
      observed: "o",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("what");

    expect(spoolFiles(active)).toEqual([]);
  });

  linuxTest("model prose never enters the diagnostics channel", async () => {
    const active = await open();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sent = fields();
      const result = await reportCall(active, sent);
      expect(result.isError).toBe(false);
      const records = [
        ...diagnosticRecords(errors.mock.calls),
        ...diagnosticRecords(warnings.mock.calls),
      ];
      const filed = records.filter((record) => record.event === "bug report filed");
      expect(filed).toHaveLength(1);
      expect(filed[0]!.level).toBe("info");
      // Only allowlisted operational keys, and no model text anywhere.
      expect(Object.keys(filed[0]!.context).sort()).toEqual(["count", "path"]);
      expect(filed[0]!.context.count).toBe(1);
      const channel = JSON.stringify(records);
      for (const value of Object.values(sent)) {
        expect(channel).not.toContain(value);
      }
      // The prose DID reach the spool — the privacy rule is about the channel.
      expect(readFileSync(String(objectOf(result.details).path), "utf8")).toContain(
        sent.what as string,
      );
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  linuxTest("a planted symlink or a non-conforming entry is refused, never followed", async () => {
    const active = await open();
    const sent = fields();
    const id = reportIdOf(sent.what!, sent.expected!, sent.observed!);
    const tree = spoolOf(active);
    mkdirSync(tree, { mode: 0o700 });

    // (a) the record name itself is a symlink to a file outside the spool.
    const victim = join(active.cwd, "victim.json");
    writeFileSync(victim, "SYNTHETIC_VICTIM\n", { mode: 0o600 });
    symlinkSync(victim, join(tree, `${id}.json`));
    const linked = await reportCall(active, sent);
    expect(linked.isError).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("SYNTHETIC_VICTIM\n");
    expect(lstatSync(join(tree, `${id}.json`)).isSymbolicLink()).toBe(true);

    // (b) a foreign-mode regular file at the record name is not "already filed".
    const other = fields();
    const otherId = reportIdOf(other.what!, other.expected!, other.observed!);
    writeFileSync(join(tree, `${otherId}.json`), "{}", { mode: 0o644 });
    const loose = await reportCall(active, other);
    expect(loose.isError).toBe(true);
    expect(readFileSync(join(tree, `${otherId}.json`), "utf8")).toBe("{}");
  });

  linuxTest("the call row and both result views carry pointers, never prose", async () => {
    const active = await open();
    const sent = fields();

    // The call row: a static title plus the optional ticket. Model prose is
    // deliberately absent — the row is a transcript label, not a channel.
    expect(renderCall(active, sent)).toBe("delegate_report");
    expect(
      renderCall(active, {
        ...sent,
        ticketId: "t-1a2b3c4d-5678-90ab-cdef-1234567890ab",
      }),
    ).toBe("delegate_report #t-1a2b3c4d");
    for (const value of Object.values(sent)) {
      expect(renderCall(active, sent)).not.toContain(value);
    }

    const filed = await reportCall(active, sent);
    const id = String(objectOf(filed.details).reportId);
    const collapsed = renderResult(active, filed, false);
    expect(collapsed).toContain(`report ${id}`);
    expect(collapsed).toContain("filed to the spool");
    expect(collapsed).not.toContain(sent.what as string);
    const expanded = renderResult(active, filed, true);
    expect(expanded).toContain(
      "This is a local record for the operator; it changes nothing about running work.",
    );
    expect(expanded).toContain(`Attached evidence: extension ${EXTENSION_VERSION}`);

    // A duplicate collapses to its own status line.
    const duplicate = await reportCall(active, sent);
    expect(renderResult(active, duplicate, false)).toContain(
      "duplicate, not re-filed",
    );

    // A refusal has no pointer to show: the collapsed view is its sentence.
    for (const extra of [0, 1].map(() => fields())) {
      await reportCall(active, extra);
    }
    const capped = await reportCall(active, fields());
    expect(objectOf(capped.details).status).toBe("capped");
    const cappedView = renderResult(active, capped, false);
    expect(cappedView).toContain("Bug report not filed");
    expect(cappedView).not.toContain("↳ report");
  });

  linuxTest("a symlinked spool tree is refused rather than followed", async () => {
    const active = await open();
    const target = join(active.cwd, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, spoolOf(active));
    const result = await reportCall(active, fields());
    expect(result.isError).toBe(true);
    expect(objectOf(result.details).status).toBe("failed");
    expect(readdirSync(target)).toEqual([]);
  });
});

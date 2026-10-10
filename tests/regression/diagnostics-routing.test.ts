import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const childScript = resolve(
  import.meta.dirname,
  "../support/diagnostics-boundary-child.ts",
);
const marker = "DIAGNOSTICS_BOUNDARY_RESULT ";
const roots: string[] = [];
interface RecordEntry {
  readonly time: string;
  readonly pid: number;
  readonly level: string;
  readonly event: string;
  readonly context: Record<string, unknown>;
  readonly error?: { readonly class: string; readonly code?: string };
  readonly primaryFailure?: unknown;
}
interface ChildMarker {
  readonly admissionReleased?: boolean;
  readonly shutdown?: boolean;
  readonly noticeFailure?: boolean;
  readonly startupRecovery?: boolean;
  readonly unsupported?: boolean;
  readonly safeCauses?: boolean;
  readonly workerNoninterference?: boolean;
  readonly retryDiagnostic?: boolean;
  readonly tty: boolean;
  readonly pid: number;
  readonly wait: boolean;
  readonly answer: boolean;
  readonly steer: boolean;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseEntry(line: string): RecordEntry {
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    typeof value.time !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.level !== "string" ||
    typeof value.event !== "string" ||
    !isRecord(value.context)
  )
    throw new Error("Malformed diagnostic record");
  return value as unknown as RecordEntry;
}
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
async function runChild(scenario: string, tty: boolean) {
  const scratch = mkdtempSync(join(tmpdir(), "delegate-diagnostics-test-"));
  roots.push(scratch);
  const agentDir = join(scratch, "agent");
  const temp = join(scratch, "tmp");
  mkdirSync(agentDir, { mode: 0o700 });
  mkdirSync(temp, { mode: 0o700 });
  const cmd = tty
    ? [
        "script",
        "-q",
        "-e",
        "-c",
        [process.execPath, childScript, scenario].map(quote).join(" "),
        "/dev/null",
      ]
    : [process.execPath, childScript, scenario];
  const child = Bun.spawn(cmd, {
    cwd: root,
    env: {
      ...process.env,
      DELEGATE_AGENT_DIR: agentDir,
      TMPDIR: temp,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
      DELEGATE_SHUTDOWN_QUIESCENCE_MS: "2000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(
      `Diagnostic boundary exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  const trimmed = stdout.replaceAll("\r", "").trim();
  expect(trimmed.startsWith(marker)).toBe(true);
  expect(trimmed.split("\n")).toHaveLength(1);
  const value: unknown = JSON.parse(trimmed.slice(marker.length));
  if (
    !isRecord(value) ||
    typeof value.pid !== "number" ||
    typeof value.tty !== "boolean" ||
    (!scenario.startsWith("failure-") &&
      (value.wait !== true || value.answer !== true || value.steer !== true))
  )
    throw new Error("Missing successful public-tool outcomes");
  const outcome = value as unknown as ChildMarker;
  expect(outcome.tty).toBe(tty);
  const logDirs: string[] = [];
  if (
    (scenario === "normal" || scenario.startsWith("failure-")) &&
    existsSync(join(agentDir, "delegate-diagnostics"))
  )
    logDirs.push(join(agentDir, "delegate-diagnostics"));
  for (const entry of readdirSync(temp, { withFileTypes: true }))
    if (
      entry.isDirectory() &&
      entry.name.startsWith("pi-delegate-diagnostics-")
    )
      logDirs.push(join(temp, entry.name));
  const fileRecords: RecordEntry[] = [];
  for (const directory of logDirs) {
    const owner = process.getuid?.();
    if (owner === undefined)
      throw new Error("Private-file verification requires a user id");
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(directory).uid).toBe(owner);
    for (const filename of readdirSync(directory)) {
      expect(filename).toBe(`${outcome.pid}.jsonl`);
      const file = join(directory, filename);
      const stat = lstatSync(file);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
      expect(stat.uid).toBe(owner);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      for (const line of lines) {
        expect(Buffer.byteLength(line)).toBeLessThan(64 * 1024);
        fileRecords.push(parseEntry(line));
      }
    }
  }
  const stderrRecords = stderr.trim()
    ? stderr
        .trim()
        .split("\n")
        .map((line) => {
          expect(line.startsWith("[delegate] ")).toBe(true);
          return parseEntry(line.slice("[delegate] ".length));
        })
    : [];
  const records = tty ? fileRecords : stderrRecords;
  if (tty) {
    expect(stderr).toBe("");
    expect(stdout).not.toContain("[delegate]");
    expect(fileRecords.length).toBeGreaterThan(0);
  } else {
    expect(fileRecords).toHaveLength(0);
    expect(stdout).not.toContain("[delegate]");
    expect(stderrRecords.length).toBeGreaterThan(0);
  }
  expect(records.every((entry) => entry.pid === outcome.pid)).toBe(true);
  if (scenario.startsWith("failure-")) {
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    return {
      scratch,
      agentDir,
      logDirs,
      records,
      outcome: value as unknown as ChildMarker,
    };
  }
  expect(
    records.some(
      (entry) =>
        entry.event === "delegate tools registered" &&
        entry.context.count === 3,
    ),
  ).toBe(true);
  expect(
    records.some((entry) => entry.event === "malformed agent frontmatter"),
  ).toBe(true);
  expect(
    records.some(
      (entry) =>
        entry.event === "telemetry failed" &&
        entry.context.operation === "open" &&
        entry.error?.code === "EISDIR",
    ),
  ).toBe(true);
  expect(
    records.some(
      (entry) =>
        entry.event === "delivery skipped: result already returned" &&
        entry.context.by === "wait",
    ),
  ).toBe(true);
  expect(
    records.some(
      (entry) =>
        entry.event === "task waiting for answer" &&
        entry.context.taskId === "asker",
    ),
  ).toBe(true);
  expect(
    records.some(
      (entry) =>
        entry.event === "task answered question" &&
        entry.context.taskId === "asker",
    ),
  ).toBe(true);
  expect(
    records.some(
      (entry) =>
        entry.event === "task steer receipt" &&
        String(entry.context.steerId).startsWith("steer:"),
    ),
  ).toBe(true);
  expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  for (const entry of records)
    if (entry.error) {
      expect(
        Object.keys(entry.error).every(
          (key) => key === "class" || key === "code",
        ),
      ).toBe(true);
    }
  expect(readFileSync(join(scratch, "outside", "victim.txt"), "utf8")).toBe(
    "OUTSIDE_FILE_UNTOUCHED",
  );
  return { scratch, agentDir, logDirs, records, outcome };
}
afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// #122: actual process streams/PTY and registered tools, never production logger imports.
describe("diagnostic routing at public tool boundary", () => {
  test("redirected diagnostics use stderr, never machine-readable stdout", async () => {
    await runChild("normal", false);
  }, 20_000);
  const ttyTest =
    process.platform === "linux" && Bun.which("script") ? test : test.skip;
  ttyTest(
    "attached terminal receives no Delegate diagnostics; private logs preserve signals and omit bodies",
    async () => {
      const observed = await runChild("normal", true);
      expect(observed.logDirs).toEqual([
        join(observed.agentDir, "delegate-diagnostics"),
      ]);
      expect(
        observed.records.every((entry) => entry.primaryFailure === undefined),
      ).toBe(true);
    },
    20_000,
  );
  for (const scenario of [
    "blocked",
    "symlink-directory",
    "insecure-directory",
    "symlink-file",
    "hardlink-file",
    "insecure-file",
  ]) {
    ttyTest(
      `unsafe primary destination (${scenario}) uses private fallback without touching targets`,
      async () => {
        const observed = await runChild(scenario, true);
        expect(observed.logDirs).toHaveLength(1);
        expect(observed.logDirs[0]).toStartWith(
          join(observed.scratch, "tmp", "pi-delegate-diagnostics-"),
        );
        expect(
          observed.records.every((entry) => entry.primaryFailure !== undefined),
        ).toBe(true);
        if (scenario === "blocked")
          expect(
            readFileSync(
              join(observed.agentDir, "delegate-diagnostics"),
              "utf8",
            ),
          ).toBe("LOG_DESTINATION_UNTOUCHED");
        if (scenario === "symlink-directory")
          expect(readdirSync(join(observed.scratch, "outside"))).toEqual([
            "victim.txt",
          ]);
        if (scenario === "insecure-file")
          expect(
            readFileSync(
              join(
                observed.agentDir,
                "delegate-diagnostics",
                `${observed.outcome.pid}.jsonl`,
              ),
              "utf8",
            ),
          ).toBe("LOG_FILE_UNTOUCHED");
      },
      20_000,
    );
  }
  ttyTest(
    "concurrent explicit agent directories keep diagnostics isolated",
    async () => {
      const [first, second] = await Promise.all([
        runChild("normal", true),
        runChild("normal", true),
      ]);
      expect(first.outcome.pid).not.toBe(second.outcome.pid);
      expect(JSON.stringify(first.records)).not.toContain(second.agentDir);
      expect(JSON.stringify(second.records)).not.toContain(first.agentDir);
    },
    20_000,
  );
  for (const scenario of [
    "failure-answer",
    "failure-shutdown",
    "failure-startup",
    "failure-no-getuid",
    "failure-no-follow",
    "failure-foreign",
    "failure-safe-causes",
    "failure-worker-default",
    "failure-worker-observer",
    "failure-retry",
  ]) {
    ttyTest(
      `${scenario}: routing never controls public-tool lifecycle and failures remain visible`,
      async () => {
        const observed = await runChild(scenario, true);
        const outcome = observed.outcome;
        if (scenario === "failure-answer") {
          expect(outcome.answer).toBe(true);
          expect(outcome.admissionReleased).toBe(true);
          expect(outcome.noticeFailure).toBe(true);
        } else if (scenario === "failure-shutdown") {
          expect(outcome.shutdown).toBe(true);
          expect(outcome.admissionReleased).toBe(true);
        } else if (scenario === "failure-startup")
          expect(outcome.startupRecovery).toBe(true);
        else if (scenario === "failure-safe-causes") {
          expect(outcome.safeCauses).toBe(true);
          expect(
            observed.records.some(
              (r) =>
                r.event === "session-start probe failed" &&
                r.error?.code === "ECONNRESET",
            ),
          ).toBe(true);
        } else if (scenario.startsWith("failure-worker-")) {
          expect(outcome.workerNoninterference).toBe(true);
          expect(
            observed.records.find(
              (r) => r.event === "worker startup timeout; killing",
            )?.level,
          ).toBe("error");
          expect(
            observed.records.find((r) => r.event === "worker fatal")?.level,
          ).toBe("error");
        } else if (scenario === "failure-retry") {
          expect(outcome.retryDiagnostic).toBe(true);
          const retry = observed.records.find(
            (r) => r.event === "retrying task after transient failure",
          );
          expect(retry?.context.category).toBe("transient");
          expect(retry?.error?.class).toBe("unknown");
        } else {
          expect(outcome.unsupported).toBe(true);
          expect(outcome.noticeFailure).toBe(true);
        }
      },
      20_000,
    );
  }
});

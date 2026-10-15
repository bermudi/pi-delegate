#!/usr/bin/env bun
/**
 * Report triage — the operator's emptying step for the model-authored spool
 * (SPEC v3 "Report surface").
 *
 * `delegate_report` writes owner-only records under
 * `<DELEGATE_AGENT_DIR>/delegate-reports/`. That spool is *intake*, never a
 * backlog: GitHub issues stay the only backlog, so every record must end up
 * either filed as an issue or explicitly discarded. This script lists what is
 * untriaged (structure only — ids, sizes, and pointers; the prose lives in the
 * record file and is read deliberately, not dumped into a terminal) and marks
 * each record with its disposition beside it.
 *
 * Usage:
 *   bun run reports:triage list
 *   bun run reports:triage filed <id|file> --issue <number-or-url>
 *   bun run reports:triage discarded <id|file>
 *
 * The spool directory is whatever the extension used: `DELEGATE_AGENT_DIR`
 * when set (nonempty), otherwise Pi's public agent directory. The resolved
 * directory is printed on every run.
 *
 * A disposition is written as a sibling `<id>.triaged.json` (0600, never
 * overwriting an existing one) so the byte record stays untouched for the
 * issue it was filed into — and so an identical resubmission still answers
 * "duplicate of <id>, not re-filed" instead of re-filling the spool.
 */

import { constants } from "node:fs";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const REPORT_TREE = "delegate-reports";
const USAGE = `usage:
  bun run reports:triage list
  bun run reports:triage filed <id|file> --issue <number-or-url>
  bun run reports:triage discarded <id|file>`;

function die(message: string, code = 2): never {
  console.error(`[triage] FAIL: ${message}`);
  process.exit(code);
}

function agentDir(): string {
  const fromEnv = process.env.DELEGATE_AGENT_DIR?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : getAgentDir();
}

interface RecordShape {
  readonly id?: unknown;
  readonly filedAt?: unknown;
  readonly what?: unknown;
  readonly expected?: unknown;
  readonly observed?: unknown;
  readonly ticketId?: unknown;
  readonly extensionVersion?: unknown;
  readonly hostVersion?: unknown;
  readonly sessionFile?: unknown;
  readonly ticketsTouched?: unknown;
  readonly telemetry?: unknown;
}

interface TriagedShape {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly issue?: unknown;
  readonly at?: unknown;
}

type Entry =
  | { readonly kind: "record"; readonly id: string; readonly path: string; readonly record: RecordShape }
  | { readonly kind: "triaged"; readonly id: string; readonly triaged: TriagedShape }
  | { readonly kind: "unreadable"; readonly id: string; readonly path: string; readonly problem: string };

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A spool entry is read only when it is exactly the shape the extension
 * writes: a regular, single-link, owner-owned file. A planted symlink or a
 * foreign file is reported, never followed.
 */
function inspect(directory: string, name: string): Entry {
  const path = join(directory, name);
  const id = name.replace(/\.(triaged\.)?json$/, "");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return { kind: "unreadable", id, path, problem: error instanceof Error ? error.message : String(error) };
  }
  const owner = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (owner !== undefined && stat.uid !== owner)) {
    return { kind: "unreadable", id, path, problem: "not an owner-only regular single-link file" };
  }
  if (name.endsWith(".triaged.json")) return { kind: "triaged", id, triaged: readJson(path) as TriagedShape };
  return { kind: "record", id, path, record: readJson(path) as RecordShape };
}

function entriesOf(directory: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    die(`cannot read ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return names.filter((name) => name.endsWith(".json")).sort().map((name) => inspect(directory, name));
}

const chars = (value: unknown): string =>
  typeof value === "string" ? `${value.length} chars` : "missing";
const text = (value: unknown): string => (typeof value === "string" ? value : "—");

function list(directory: string): void {
  const entries = entriesOf(directory);
  const triaged = new Map(
    entries.filter((entry): entry is Extract<Entry, { kind: "triaged" }> => entry.kind === "triaged")
      .map((entry) => [entry.id, entry.triaged]),
  );
  const records = entries.filter((entry): entry is Extract<Entry, { kind: "record" }> => entry.kind === "record");
  const untriaged = records.filter((entry) => !triaged.has(entry.id));
  console.log(`[triage] spool ${directory}`);
  console.log(`[triage] ${records.length} record(s): ${untriaged.length} untriaged, ${records.length - untriaged.length} triaged`);
  for (const entry of entries) {
    if (entry.kind === "unreadable") {
      console.log(`  ! ${entry.id}: ${entry.problem} (${entry.path})`);
    }
  }
  if (untriaged.length === 0) {
    console.log("[triage] nothing untriaged — the spool is empty of pending intake.");
    return;
  }
  for (const entry of untriaged) {
    const { record } = entry;
    const tickets = Array.isArray(record.ticketsTouched) ? record.ticketsTouched.filter((t): t is string => typeof t === "string") : [];
    console.log(`\n  ${entry.id}  ${text(record.filedAt)}`);
    console.log(`    what ${chars(record.what)} · expected ${chars(record.expected)} · observed ${chars(record.observed)}`);
    console.log(
      `    extension ${text(record.extensionVersion)} · host pi ${text(record.hostVersion)}` +
        `${record.ticketId === undefined ? "" : ` · ticketId ${text(record.ticketId)}`}`,
    );
    console.log(`    sessionFile ${text(record.sessionFile)}`);
    console.log(`    ticketsTouched ${tickets.length === 0 ? "none" : tickets.join(", ")}`);
    console.log(`    telemetry ${JSON.stringify(record.telemetry ?? null)}`);
  }
  console.log(
    `\n[triage] read a record whole with: cat ${join(directory, `${untriaged[0]!.id}.json`)}\n` +
      `[triage] mark it: bun run reports:triage filed <id> --issue <number-or-url> | bun run reports:triage discarded <id>`,
  );
}

/** Resolve an argument that may be an id, a file name, or a path. */
function recordIdOf(directory: string, argument: string): string {
  if (argument.includes("/") || argument.endsWith(".json")) {
    const base = argument.split("/").pop()!;
    const id = base.replace(/\.(triaged\.)?json$/, "");
    if (!existsSync(join(directory, `${id}.json`))) {
      die(`${argument} does not name a record in ${directory}`);
    }
    return id;
  }
  if (!existsSync(join(directory, `${argument}.json`))) {
    die(`no record '${argument}' in ${directory} — run \`bun run reports:triage list\` to see the spool`);
  }
  return argument;
}

/** Exclusive 0600 create: a second disposition never overwrites the first. */
function writeDisposition(directory: string, id: string, body: unknown): void {
  const path = join(directory, `${id}.triaged.json`);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

const [command = "list", ...rest] = process.argv.slice(2);
const directory = join(agentDir(), REPORT_TREE);
const issueFlag = rest.indexOf("--issue");
const issue = issueFlag === -1 ? undefined : rest[issueFlag + 1];
const positional = rest.filter((value, index) => !value.startsWith("--") && index !== issueFlag + 1);

if (command === "list") {
  if (positional.length > 0) die(USAGE);
  list(directory);
} else if (command === "filed" || command === "discarded") {
  const [target] = positional;
  if (target === undefined || positional.length > 1) die(USAGE);
  if (command === "filed" && (issue === undefined || issue.trim() === "")) {
    die("`filed` requires --issue <number-or-url>: the spool is not the backlog, the issue is");
  }
  const id = recordIdOf(directory, target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeDisposition(directory, id, {
      id,
      status: command,
      ...(command === "filed" ? { issue } : {}),
      at: new Date().toISOString(),
      by: `pid ${process.pid}`,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      die(`${id} already has a disposition; inspect ${join(directory, `${id}.triaged.json`)}`);
    }
    throw error;
  }
  console.log(
    command === "filed"
      ? `[triage] ${id} filed as ${issue} — the record stays beside its disposition: ${join(directory, `${id}.json`)}`
      : `[triage] ${id} discarded`,
  );
} else {
  die(USAGE);
}

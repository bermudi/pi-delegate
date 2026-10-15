/**
 * The parent model's bug-report spool (SPEC v3 "Report surface").
 *
 * `delegate_report` gives the trained weights a return channel for the one
 * thing only they can see: where the advertised contract and the observed
 * behavior disagree. The model is a lossy witness, so its half of the record
 * is bounded structured text (`what`, `expected`, `observed`, an optional
 * `ticketId`) and the extension attaches the ground truth it already holds:
 * versions, the session file, the tickets this session touched, and a
 * pointer — never a copy — into the telemetry window.
 *
 * Reports are model-authored content and MUST NOT ride the diagnostic sink's
 * allowlisted channel: the sink records only the bounded operational fact
 * that a report was filed (`path`, `count`). A record is a local,
 * owner-only file for the operator; nothing here files an issue, promises
 * action, or leaves the machine.
 *
 * Abuse control is structural: one identically-worded report is one record
 * (content-addressed name, exclusive create), so a resubmission answers
 * "duplicate of <id>, not re-filed" and does not consume the per-session
 * budget. Beyond the cap the surface stops accepting rather than growing an
 * unbounded pile the operator never reads — the spool is intake with a
 * mandated emptying step (scripts/report-triage.ts), not a backlog.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import {
  DiagnosticSink,
  privateRecordExists,
  REPORT_TREE,
  writePrivateRecord,
} from "./diagnostics.ts";
import { EXTENSION_VERSION } from "./telemetry.ts";
import type { ReportCall } from "./validation.ts";

/**
 * Per-field bound on the model's contribution, matching the diagnostic sink's
 * own bounded-metadata limit. A field over it rejects with teaching — the
 * bound is a constant, never a knob.
 */
export const REPORT_FIELD_LIMIT = 512;

/**
 * Accepted reports per session. Not a knob: three is the point past which a
 * session is producing triage noise rather than a distinct collision, and an
 * unemptied spool is exactly the backlog this surface must not become.
 */
export const REPORT_SESSION_CAP = 3;

/** How many hex characters of the content digest name a record. */
const REPORT_ID_LENGTH = 12;

/**
 * The record id and file name: the first 12 hex of sha256 over the model's
 * three fields. Content-addressed on purpose — an exclusive create that finds
 * the name taken IS the dedup signal, and no separate index is needed to
 * answer "have I filed exactly this before?".
 */
function reportIdOf(call: ReportCall): string {
  return createHash("sha256")
    .update(`${call.what}\u0000${call.expected}\u0000${call.observed}`)
    .digest("hex")
    .slice(0, REPORT_ID_LENGTH);
}

/** Absolute path of a record, for receipts, details, and triage. */
function reportPathOf(agentDir: string, id: string): string {
  return join(agentDir, REPORT_TREE, `${id}.json`);
}

/**
 * The extension-attached half of a record: facts this process holds and the
 * model cannot supply. `ticketsTouched` is scoped like the ticket roster —
 * this session's own tickets — and `windowStart` is the earliest timestamp
 * this session can date its telemetry window from (undefined when nothing
 * dates it, so the gap stays visible rather than being filled with an
 * invented session-start).
 */
export interface ReportGroundTruth {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly ticketsTouched: readonly string[];
  readonly windowStart: number | undefined;
}

/** One spooled record as written to disk. */
interface ReportRecord {
  readonly id: string;
  readonly filedAt: string;
  readonly what: string;
  readonly expected: string;
  readonly observed: string;
  readonly ticketId?: string;
  readonly extensionVersion: string;
  readonly hostVersion: string;
  readonly sessionFile?: string;
  readonly ticketsTouched: readonly string[];
  /** Pointer only: query the telemetry store for this session's rows in the
   * window. Telemetry rows are never copied into a record. */
  readonly telemetry: {
    readonly sessionId: string;
    readonly windowStart?: number;
    readonly windowEnd: number;
  };
}

/** The outcome of one `delegate_report` call, before it is rendered. */
type ReportFiling =
  | {
      readonly status: "filed";
      readonly id: string;
      readonly path: string;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: "duplicate";
      readonly id: string;
      readonly path: string;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: "capped";
      readonly cap: number;
      readonly filed: readonly string[];
    }
  | { readonly status: "unsupported" }
  | {
      readonly status: "failed";
      readonly path: string;
      readonly code: string | undefined;
    };

function errorCode(error: unknown): string | undefined {
  try {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined; // Revoked proxies are never inspected twice.
  }
}

/**
 * The `delegate_report` spool. Instance-owned (never module state): the
 * per-session budget lives here and dies with the extension instance that
 * served the session.
 */
export class ReportSpool {
  private filed: string[] = [];

  constructor(private readonly diagnostics: DiagnosticSink) {}

  /** How many reports this session has had accepted. */
  get accepted(): number {
    return this.filed.length;
  }

  /**
   * File one report. Ordering matters to the contract: duplicate detection
   * precedes the cap, so resubmitting something already recorded answers
   * "duplicate ... not re-filed" even after the cap is reached and never
   * consumes budget. Nothing here throws — a spool failure is a refusal the
   * caller must be able to read, and an operational diagnostic for the
   * operator.
   */
  file(truth: ReportGroundTruth, call: ReportCall): ReportFiling {
    const id = reportIdOf(call);
    const name = `${id}.json`;
    const path = reportPathOf(truth.agentDir, id);
    const now = Date.now();
    const duplicate: ReportFiling = {
      status: "duplicate",
      id,
      path,
      evidence: evidenceOf(truth, now),
    };
    try {
      // Dedup before the cap: an identical resubmission is not new intake,
      // so it must answer (and must not consume budget) even at the cap.
      if (privateRecordExists(truth.agentDir, REPORT_TREE, name)) return duplicate;
      if (this.filed.length >= REPORT_SESSION_CAP) {
        return {
          status: "capped",
          cap: REPORT_SESSION_CAP,
          filed: [...this.filed],
        };
      }
      // An exclusive create that loses the race to an identical report is
      // the same duplicate answer.
      if (
        writePrivateRecord(
          truth.agentDir,
          REPORT_TREE,
          name,
          recordContents(id, truth, call, now),
        ) === "exists"
      )
        return duplicate;
    } catch (error) {
      const code = errorCode(error);
      // The routing gap is a platform fact, not a spool fault: report it as
      // unsupported (no fallback destination exists by design), and never
      // write to an attached terminal.
      if (code === "DIAGNOSTIC_UNSUPPORTED") return { status: "unsupported" };
      this.diagnostics.log("error", "bug report spool write failed", { path }, error);
      return { status: "failed", path, code };
    }
    this.filed.push(id);
    this.diagnostics.log("info", "bug report filed", {
      path,
      count: this.filed.length,
    });
    return { status: "filed", id, path, evidence: evidenceOf(truth, now) };
  }
}

/** The record's model-authored fields, bounded at the boundary already. */
function recordContents(
  id: string,
  truth: ReportGroundTruth,
  call: ReportCall,
  now: number,
): string {
  const record: ReportRecord = {
    id,
    filedAt: new Date().toISOString(),
    what: call.what,
    expected: call.expected,
    observed: call.observed,
    ...(call.ticketId === undefined ? {} : { ticketId: call.ticketId }),
    extensionVersion: EXTENSION_VERSION,
    hostVersion: PI_VERSION,
    ...(truth.sessionFile === undefined ? {} : { sessionFile: truth.sessionFile }),
    ticketsTouched: [...truth.ticketsTouched],
    telemetry: {
      sessionId: truth.sessionId,
      ...(truth.windowStart === undefined ? {} : { windowStart: truth.windowStart }),
      windowEnd: now,
    },
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Pointers the record carries — never contents, never telemetry rows. */
function evidenceOf(truth: ReportGroundTruth, now: number): string[] {
  return [
    `extension ${EXTENSION_VERSION}`,
    `host pi ${PI_VERSION}`,
    `sessionFile ${truth.sessionFile ?? "unavailable"}`,
    truth.ticketsTouched.length === 0
      ? "tickets none touched this session"
      : `tickets ${truth.ticketsTouched.join(", ")}`,
    `telemetry ${truth.sessionId} window ${
      truth.windowStart === undefined ? "unrecorded" : truth.windowStart
    }-${now}`,
  ];
}

/**
 * The receipt the model reads. Terse, no promise of action and no corrective
 * guidance: a filed record changes nothing about running work, and saying so
 * is the whole point of the sentence the contract pins.
 */
export function receiptOf(filing: ReportFiling): string {
  if (filing.status === "filed" || filing.status === "duplicate") {
    const head =
      filing.status === "filed"
        ? `Bug report filed: ${filing.id} — ${filing.path}`
        : `Bug report duplicate of ${filing.id} — not re-filed; the record is at ${filing.path}`;
    return [
      head,
      `Attached evidence: ${filing.evidence.join(" · ")}`,
      filing.status === "filed"
        ? "Dedup: first filing of this content."
        : "Dedup: identical content already recorded; no new record and no cap consumed.",
      "This is a local record for the operator; it changes nothing about running work.",
    ].join("\n");
  }
  if (filing.status === "capped") {
    return (
      `Bug report not filed: this session reached the delegate_report cap of ${filing.cap} filed reports ` +
      `(a constant, not a knob). Already filed: ${filing.filed.join(", ")}. ` +
      "Nothing was written and nothing about running work changed."
    );
  }
  if (filing.status === "unsupported") {
    return (
      "Bug report not filed: owner-only report routing is unsupported here " +
      "(it requires Linux with getuid, O_NOFOLLOW, and O_DIRECTORY). " +
      "Nothing was written — there is no terminal or temporary-directory fallback — " +
      "and nothing about running work changed."
    );
  }
  return (
    `Bug report not filed: the report spool could not be written at ${filing.path}` +
    `${filing.code === undefined ? "" : ` (${filing.code})`}. ` +
    "Nothing was written and nothing about running work changed."
  );
}

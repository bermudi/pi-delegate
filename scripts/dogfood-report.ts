#!/usr/bin/env bun
/**
 * The `delegate_report` half of the dogfood evidence trail (SPEC v3 "Report
 * surface"), split out of scripts/dogfood.ts so the checks themselves are
 * verifiable against synthetic evidence instead of only against a live model
 * session — the assertions are the deliverable here, and an untested
 * assertion is how a dogfood silently stops dogfooding.
 *
 * Everything asserted is a file, a transcript line, or a diagnostics record.
 * The model's own summary is never evidence.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The receipt sentence SPEC v3 pins for a filed report. */
export const RECEIPT_SENTENCE =
  "This is a local record for the operator; it changes nothing about running work.";

/** The reserved runtime tree the spool lives in. */
export const REPORT_TREE = "delegate-reports";

export interface ReportScenarioEvidence {
  /** DELEGATE_AGENT_DIR used by the session — the spool's parent. */
  readonly agentDir: string;
  /** The marker the session's tasks wrote and read; the report names it. */
  readonly marker: string;
  /** Saved session transcript text ("" when none was found). */
  readonly transcript: string;
  /** Combined stdout/stderr of the headless session. */
  readonly output: string;
}

interface SpooledRecord {
  readonly what?: unknown;
  readonly expected?: unknown;
  readonly observed?: unknown;
  readonly id?: unknown;
  readonly filedAt?: unknown;
  readonly extensionVersion?: unknown;
  readonly hostVersion?: unknown;
  readonly sessionFile?: unknown;
  readonly ticketsTouched?: unknown;
  readonly telemetry?: unknown;
}

function readJson(path: string): SpooledRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object"
      ? (value as SpooledRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assert the report scenario's evidence. Failures are pushed as prose lines so
 * the caller can print them all at once; an empty result means every check
 * passed. No check reads the session's model output.
 */
export function assertReportScenario(
  evidence: ReportScenarioEvidence,
  failures: string[],
): void {
  const spool = join(evidence.agentDir, REPORT_TREE);
  if (!existsSync(spool)) {
    failures.push(`report spool ${spool} missing — delegate_report never filed`);
    return;
  }
  const owner = process.getuid?.();
  const spoolStat = lstatSync(spool);
  if (!spoolStat.isDirectory() || spoolStat.isSymbolicLink()) {
    failures.push(`report spool ${spool} is not a real directory`);
  } else if ((spoolStat.mode & 0o777) !== 0o700) {
    failures.push(
      `report spool ${spool} is not 0700 (mode ${(spoolStat.mode & 0o777).toString(8)})`,
    );
  }
  if (owner !== undefined && spoolStat.uid !== owner) {
    failures.push(`report spool ${spool} is not owned by uid ${owner}`);
  }

  const files = readdirSync(spool).filter((name) => name.endsWith(".json"));
  if (files.length !== 1) {
    failures.push(
      `expected exactly 1 spooled report, found ${files.length}: ${files.join(", ")}`,
    );
  }
  const matching: SpooledRecord[] = [];
  for (const name of files) {
    const path = join(spool, name);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    ) {
      failures.push(
        `${name} is not a 0600 single-link regular file (mode ${(stat.mode & 0o777).toString(8)}, nlink ${stat.nlink})`,
      );
      continue;
    }
    const record = readJson(path);
    if (record === undefined) {
      failures.push(`${name} is not a JSON object`);
      continue;
    }
    if (typeof record.what === "string" && record.what.includes(evidence.marker)) {
      matching.push(record);
    }
    // Structure (the model's half) and ground truth (the extension's half).
    for (const field of ["id", "filedAt", "what", "expected", "observed"] as const) {
      if (typeof record[field] !== "string" || record[field] === "") {
        failures.push(`${name} is missing the record field '${field}'`);
      }
    }
    for (const field of ["extensionVersion", "hostVersion"] as const) {
      if (typeof record[field] !== "string" || record[field] === "") {
        failures.push(
          `${name} is missing '${field}' — the extension must attach its own versions`,
        );
      }
    }
    const telemetry = record.telemetry as
      | { sessionId?: unknown; windowStart?: unknown; windowEnd?: unknown }
      | undefined;
    if (
      telemetry === undefined ||
      typeof telemetry.sessionId !== "string" ||
      telemetry.sessionId === "" ||
      typeof telemetry.windowEnd !== "number" ||
      (telemetry.windowStart !== undefined &&
        typeof telemetry.windowStart !== "number")
    ) {
      failures.push(
        `${name} carries no usable telemetry pointer (session id + time window)`,
      );
    }
    if (!Array.isArray(record.ticketsTouched) || record.ticketsTouched.length === 0) {
      failures.push(`${name} lists no tickets touched this session`);
    }
    if (
      typeof record.sessionFile !== "string" ||
      !existsSync(record.sessionFile)
    ) {
      failures.push(
        `${name} does not point at a real sessionFile (got ${JSON.stringify(record.sessionFile)})`,
      );
    }
  }
  if (matching.length === 0) {
    failures.push(
      `no spooled report carries the marker ${evidence.marker} in 'what'`,
    );
  }

  if (!evidence.transcript.includes("delegate_report")) {
    failures.push("session transcript shows no delegate_report tool execution");
  }
  if (!evidence.transcript.includes(RECEIPT_SENTENCE)) {
    failures.push(
      "session transcript never carries the filed report's receipt sentence",
    );
  }

  // The diagnostics channel: one allowlisted info record, and no model prose.
  const records = evidence.output
    .split("\n")
    .filter((line) => line.startsWith("[delegate] "))
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line.slice("[delegate] ".length));
        return value !== null && typeof value === "object"
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  const filed = records.filter((record) => record.event === "bug report filed");
  if (filed.length !== 1) {
    failures.push(
      `expected exactly 1 'bug report filed' diagnostic, found ${filed.length}`,
    );
  }
  for (const record of filed) {
    if (record.level !== "info") {
      failures.push(`'bug report filed' logged at level ${String(record.level)}`);
    }
    const keys = Object.keys(
      (record.context as Record<string, unknown> | undefined) ?? {},
    ).sort();
    if (keys.join(",") !== "count,path") {
      failures.push(
        `'bug report filed' context keys are ${keys.join(",")} — expected count,path`,
      );
    }
    const line = JSON.stringify(record);
    for (const opinion of matching) {
      for (const field of ["what", "expected", "observed"] as const) {
        const value = opinion[field];
        if (typeof value === "string" && value !== "" && line.includes(value)) {
          failures.push(`model prose from '${field}' entered the diagnostics channel`);
        }
      }
    }
  }
}

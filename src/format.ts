import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { renderOutputForLLM } from "./spill.ts";
import type {
  OutputBounds,
  ResolvedTask,
  TaskIntegration,
  TaskOutcome,
} from "./types.ts";

/**
 * Short identity tag for a resumed transcript, derived from its session
 * file path (Pi names sessions `<timestamp>_<uuid>.jsonl`, so the tail is
 * the stable part). Best-effort display identity only — never parsed back.
 */
export function resumeTagOf(transcriptPath: string): string {
  const stem = transcriptPath
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\.jsonl$/i, "");
  const base = stem.split("/").pop() ?? stem;
  const unique = base.includes("_") ? (base.split("_").pop() ?? base) : base;
  return (unique.slice(0, 8) || "resumed").trim();
}

/**
 * The `↻<tag>` revival marker for a task row. Empty for non-resume tasks,
 * and also when the agent label already carries the resume identity
 * (`resume:<tag>`, assigned at resolution to an omitted-agent resume) —
 * the marker must not duplicate it.
 */
export function resumeMarker(
  agent: string,
  tag: string | undefined,
): string {
  return tag !== undefined && agent !== `resume:${tag}` ? ` ↻${tag}` : "";
}

/** Human-readable activity age ("active now", "active 5s ago", …). */
export function activityAge(lastEventAt: number | undefined): string {
  if (lastEventAt === undefined) return "";
  const ago = Math.max(0, Date.now() - lastEventAt);
  if (ago < 1000) return "active now";
  if (ago < 60_000) return `active ${Math.floor(ago / 1000)}s ago`;
  return `active ${Math.floor(ago / 60_000)}m ago`;
}

/** Truncate a string to at most `limit` chars, ending with an ellipsis. */
export function truncateLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * A transcript is *resumable* iff `resumeFrom` opens a conversation with
 * restorable history: the file exists and holds at least one
 * message-bearing entry. A header-only `.jsonl` — produced when a
 * subagent's first model call dies before emitting an assistant message
 * and the failure path force-flushes the header — is real on disk but
 * gives a resume no prior context, so the hint would send the caller to
 * an empty conversation pretending continuity.
 *
 * Reads the file but short-circuits at the first restorable entry; on the
 * failure path these files are tiny (header-only or near-empty).
 */
function isResumableTranscript(sessionFile: string): boolean {
  if (!existsSync(sessionFile)) return false;
  try {
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      if (line === "") continue;
      try {
        const entry = JSON.parse(line) as { type?: string };
        if (entry.type === "message" || entry.type === "custom_message") {
          return true;
        }
      } catch {
        // Skip malformed or trailing lines — a torn write must not kill
        // the resumability check itself.
      }
    }
  } catch {
    // Unreadable — treat as not resumable.
  }
  return false;
}

/**
 * The recovery lines for a failed or cancelled task that left a session
 * transcript: the `session:` path and either a copy-pasteable resume hint
 * or an explicit note that the saved transcript holds no prior messages —
 * so the caller re-dispatches fresh rather than chasing an empty resume.
 */
export function recoveryLines(sessionFile: string | undefined): string[] {
  if (sessionFile === undefined) return [];
  const lines = [`session: ${sessionFile}`];
  if (isResumableTranscript(sessionFile)) {
    lines.push(
      `→ To retry: delegate({ tasks: [{ resumeFrom: ${JSON.stringify(sessionFile)}, prompt: "continue" }] })`,
    );
  } else {
    lines.push(
      "[saved transcript holds no prior messages — re-dispatch as a fresh task]",
    );
  }
  return lines;
}

/**
 * One advisory line per serialized shared-writer group: which tasks, which
 * write scope, and the isolated-workspace remedy. The notice exists so the
 * caller learns that independent same-repo work can run in parallel — a
 * serialized batch is the expensive way to discover that.
 */
export function serializedNotices(
  tasks: readonly ResolvedTask[],
  groups: readonly { tasks: readonly number[]; roots: readonly string[] }[],
): string[] {
  return groups.map((group) => {
    const names = group.tasks
      .map((index) => `'${tasks[index]!.id}'`)
      .join(", ");
    const roots = group.roots.join(", ");
    return (
      `Notice — serialized writers: ${names} share write scope '${roots}' and ` +
      `will run one at a time in this order. If they are independent edits, ` +
      `workspace "isolated" runs them in parallel and merges in task order.`
    );
  });
}

function statusWord(outcome: TaskOutcome): string {
  return outcome.status === "ok" ? "completed" : outcome.status;
}

/**
 * The alias-expansion note for a task section (SPEC v3 "Reflex
 * meeting"): `agent "general" → "default"`. Visible expansion is the
 * teaching channel — the caller sees which canonical name ran.
 */
export function aliasNote(aliasedFrom: string | undefined, agent: string): string {
  return aliasedFrom !== undefined ? `agent "${aliasedFrom}" → "${agent}"` : "";
}

/**
 * The isolated-workspace reconciliation line(s) for one task: status, file
 * counts, recovery pointers, and the applied_unverified disclaimer. A clean
 * apply is never presented as verified or tested.
 */
export function integrationLines(integration: TaskIntegration): string[] {
  const lines = [
    `[INTEGRATION: ${integration.status} · proposed ${integration.proposedFiles.length} file(s) · applied ${integration.appliedFiles.length} file(s)]`,
  ];
  if (integration.proposedFiles.length > 0) {
    lines.push(`proposed: ${integration.proposedFiles.join(", ")}`);
  }
  if (
    integration.appliedFiles.length > 0 &&
    integration.appliedFiles.join("\0") !== integration.proposedFiles.join("\0")
  ) {
    lines.push(`applied: ${integration.appliedFiles.join(", ")}`);
  }
  if (integration.baselineRef) {
    lines.push(`baseline ref: ${integration.baselineRef}`);
  }
  if (integration.proposalRef) {
    lines.push(`proposal ref: ${integration.proposalRef}`);
  }
  if (integration.patchPath) {
    lines.push(`full patch: ${integration.patchPath}`);
  }
  if (integration.worktreePath) {
    lines.push(`recovery worktree: ${integration.worktreePath}`);
  }
  if (
    (integration.status === "retained" || integration.status === "discarded") &&
    integration.reason
  ) {
    lines.push(`not applied: ${integration.reason}`);
  }
  for (const conflict of integration.conflicts ?? []) {
    lines.push(`conflict: ${conflict.path}: ${conflict.reason}`);
  }
  if (integration.status === "applied_unverified") {
    lines.push(
      integration.appliedFiles.length === 0
        ? "The proposal's changes were already present in the source tree; nothing further was written. Review or test them before relying on them."
        : "Changes were applied but not verified; review or test them before relying on them.",
    );
  }
  return lines;
}

/**
 * SPEC v3 "Observability — Completion evidence": an absolute attributed
 * path displays relative to the task cwd when it resolves under it
 * (v1's relativeTouchedSummary rule, format.ts:640-649) — but a path
 * escaping the cwd renders absolute rather than being dropped: evidence
 * is never hidden, only shortened.
 */
export function displayPath(file: string, cwd: string | undefined): string {
  if (cwd === undefined) return file;
  const rel = relative(cwd, file);
  return rel !== "" && !rel.startsWith("..") ? rel : file;
}

/**
 * The compact `files:` evidence line beside a task's output/claim:
 * `files: a.ts, src/b.md` for observed write/edit targets; `files:
 * uncertain (bash)` when only shell calls ran (their file effects are
 * unobservable and bash output is never parsed); both marks when both
 * kinds of evidence exist. Undefined when the task carries no evidence.
 */
export function filesLine(
  files: readonly string[] | undefined,
  uncertain: boolean | undefined,
  cwd: string | undefined,
): string | undefined {
  const paths = files ?? [];
  const mark = "uncertain (bash)";
  if (paths.length === 0) {
    return uncertain === true ? `files: ${mark}` : undefined;
  }
  const list = paths.map((file) => displayPath(file, cwd)).join(", ");
  return `files: ${list}${uncertain === true ? ` · ${mark}` : ""}`;
}

/**
 * One line per absolute path that two or more outcomes in the batch
 * claimed: `overlap: /path — attributed by tasks a, b`. Computed on
 * attributed (write/edit-observed) paths only — never on bash-uncertain
 * tasks, whose effects name no path. Evidence, not a lock claim: it
 * says so once, naming the file and the tasks (SPEC v3 "Observability —
 * Completion evidence").
 */
export function overlapLines(
  outcomes: readonly TaskOutcome[],
): string[] {
  const claims = new Map<string, string[]>();
  for (const outcome of outcomes) {
    for (const file of new Set(outcome.attributedFiles ?? [])) {
      const ids = claims.get(file) ?? [];
      if (!ids.includes(outcome.id)) ids.push(outcome.id);
      claims.set(file, ids);
    }
  }
  return [...claims]
    .filter(([, ids]) => ids.length > 1)
    .map(([file, ids]) => `overlap: ${file} — attributed by tasks ${ids.join(", ")}`)
    .sort();
}

/**
 * Synchronous dispatch result body: one section per task, in input order.
 * Task output is projected through the spill boundary — over-threshold
 * output becomes a tail plus a temp-file pointer; `outcome.output` itself
 * stays complete for the details/recovery surface. A failed task's
 * partial output is bounded the same way.
 */
export function formatDispatchResult(
  outcomes: readonly TaskOutcome[],
  tasks: readonly ResolvedTask[],
  bounds: OutputBounds,
): string {
  const sections = outcomes.map((outcome) => {
    const task = tasks[outcome.index];
    const tag = task?.resumeTag;
    const aliased = task !== undefined ? aliasNote(task.aliasedFrom, task.agent) : "";
    const head = `### Task ${outcome.id}${tag !== undefined ? ` ↻${tag}` : ""} — ${statusWord(outcome)}${aliased !== "" ? `\n${aliased}` : ""}`;
    const quarantined = outcome.quarantined
      ? "\nWorker termination is unconfirmed; its write scope stays reserved. Recorded output and token usage are lower bounds — its accounting is incomplete."
      : "";
    const integration = outcome.integration
      ? `\n${integrationLines(outcome.integration).join("\n")}`
      : "";
    const label = tasks[outcome.index]?.agent ?? outcome.id;
    // Completion evidence rides beside the task's claim — between the
    // status head and its output (SPEC v3 "Observability").
    const evidence = filesLine(
      outcome.attributedFiles,
      outcome.uncertainFiles,
      task?.cwd,
    );
    const files = evidence !== undefined ? `\n${evidence}` : "";
    if (outcome.status === "ok") {
      return `${head}${files}\n${renderOutputForLLM(outcome.output ?? "", label, bounds)}${quarantined}${integration}`;
    }
    const detail = outcome.error ?? "no output";
    const session =
      outcome.sessionFile !== undefined
        ? `\n${recoveryLines(outcome.sessionFile).join("\n")}`
        : "";
    const partial = outcome.output
      ? `\n\nPartial output:\n${renderOutputForLLM(outcome.output, label, bounds)}`
      : "";
    return `${head}${files}\n${detail}${partial}${session}${quarantined}${integration}`;
  });
  // The result's aggregate usage rides `details.usage`; when any worker's
  // accounting is incomplete that total is a lower bound, not a sum — the
  // flag must ride the text so a caller reading only the body knows it.
  const lowerBound = outcomes.some((outcome) => outcome.quarantined)
    ? "\n\nNote: token usage and cost totals are lower bounds — at least one worker's accounting is incomplete (termination unconfirmed)."
    : "";
  const overlap = overlapLines(outcomes);
  const overlapNote =
    overlap.length > 0 ? `\n\n${overlap.join("\n")}` : "";
  return sections.join("\n\n") + lowerBound + overlapNote;
}

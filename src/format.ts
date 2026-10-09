import type { DiagnosticSink } from "./diagnostics.ts";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { renderOutputForLLM } from "./spill.ts";
import type {
  FieldNormalization,
  OutputBounds,
  ResolvedTask,
  TaskIntegration,
  TaskOutcome,
  TaskVerdict,
  Ticket,
  TokenBudgetReport,
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

/** Compact wall-clock duration: "800ms", "12.3s", "4m07s", "1h05m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m${String(secs).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
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
 * Truncate to at most `limit` chars, cutting at the last word boundary at
 * or before the limit so the ellipsis lands between words; text with no
 * reasonable boundary (a long path or token run) still hard-cuts.
 */
export function truncateWords(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, Math.max(0, limit - 1));
  const boundary = slice.lastIndexOf(" ");
  const body =
    boundary > Math.floor(limit / 2) ? slice.slice(0, boundary) : slice;
  return `${body.trimEnd()}…`;
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
export function isResumableTranscript(sessionFile: string): boolean {
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
export function recoveryLines(
  sessionFile: string | undefined,
): string[] {
  if (sessionFile === undefined) return [];
  const lines = [`session: ${sessionFile}`];
  if (isResumableTranscript(sessionFile)) {
    const retry =
      `delegate({ tasks: [{ resumeFrom: ${JSON.stringify(sessionFile)}, prompt: "continue" }] })`;
    lines.push(`→ To retry: ${retry}`);
  } else {
    lines.push(
      "[saved transcript holds no prior messages — re-dispatch as a fresh task]",
    );
  }
  return lines;
}

/**
 * One advisory line per serialized shared-writer group: which tasks, which
 * write scope, and the isolated-workspace remedy. Since #126 every group
 * here is cross-phase (same-phase overlapping shared writers reject at
 * admission) — graph-ordered or incidentally separated — so the notice
 * reinforces the parallel alternative for the next dispatch: a serialized
 * batch is still the slow way to run independent work.
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
      `run one at a time in task order. Independent edits belong in ` +
      `workspace "isolated" — same-repo writers run in parallel there and ` +
      `merge in task order.`
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
 * The batch-brief header note (SPEC v3 "Batch brief"): `brief: "<head>"`,
 * whitespace-collapsed and truncated to ~80 chars — the header mentions
 * the brief once; it never repeats inside per-task sections.
 */
export function briefNote(brief: string | undefined): string | undefined {
  if (brief === undefined) return undefined;
  return `brief: "${truncateLine(brief.replace(/\s+/g, " ").trim(), 80)}"`;
}

/**
 * The token-budget header note (SPEC v3 "Batch token budget"):
 * `token budget: <consumed>/<limit> tokens[, exhausted]` — mentioned
 * once at the head of a dispatch result or ticket view; per-task
 * `budget-exhausted` statuses carry the per-task story.
 */
export function budgetNote(report: TokenBudgetReport | undefined): string | undefined {
  if (report === undefined) return undefined;
  return (
    `token budget: ${report.consumed}/${report.limit} tokens` +
    (report.exhaustedAt !== undefined ? " — exhausted" : "")
  );
}

/**
 * The delimited preamble prepended to every task prompt when a dispatch
 * carries a batch brief (SPEC v3 "Batch brief") — the brief is a fenced
 * block, never merged into the task's own prose.
 */
export function briefPreamble(brief: string): string {
  return `--- batch brief ---\n${brief}\n--- end batch brief ---\n\n`;
}

/**
 * The field-normalization notes for a task section (SPEC v3 "Reflex
 * meeting"): one `field "<field>" → "<to>"` line per cross-harness
 * spelling validation folded into a canonical field — the same teaching
 * pattern as the alias note.
 */
export function fieldNotes(
  normalizedFrom: readonly FieldNormalization[] | undefined,
): string[] {
  return (normalizedFrom ?? []).map((note) => `field "${note.field}" → "${note.to}"`);
}

/**
 * The caller's `description` as a single-line display label (SPEC v3
 * "Reflex meeting"): whitespace-collapsed and bounded for rows and
 * section heads; undefined when absent or blank so callers fall back to
 * the correlation id, then a prompt preview.
 */
export function descriptionLabel(
  description: string | undefined,
): string | undefined {
  const collapsed = description?.replace(/\s+/g, " ").trim();
  return collapsed === undefined || collapsed === ""
    ? undefined
    : truncateLine(collapsed, 80);
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
  // #62: source drift is reported on shell-capable workers only (isolated
  // and scratch) — a bash escape the write/edit guard cannot see must not
  // pass as a clean no-op.
  if (integration.sourceDrift !== undefined && integration.sourceDrift.length > 0) {
    const shown = integration.sourceDrift.slice(0, 10);
    const rest = integration.sourceDrift.length - shown.length;
    lines.push(
      `source drift: ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""} changed in the original while workers ran. Shell commands are not confined — if you didn't make these edits, a worker wrote to the original directly.`,
    );
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
 * `files: a.ts, src/b.md` for the merged attribution set — write/edit
 * call targets union the Git window's changed paths (user decision
 * 2026-10-02; bash output is still never parsed). When a task ran a
 * shell with no Git coverage, shell changes are unknowable: `files:
 * unknown (shell used outside git)`, or `· plus unknown shell changes
 * (outside git)` beside observed paths. Named concurrent writers append
 * `· may include concurrent edits by: …` — the window is shared, so its
 * diff may carry a sibling's or the parent's work. Undefined when the
 * task carries no evidence.
 */
export function filesLine(
  files: readonly string[] | undefined,
  uncertain: boolean | undefined,
  cwd: string | undefined,
  concurrentWriters?: readonly string[],
): string | undefined {
  const paths = files ?? [];
  const writers =
    concurrentWriters !== undefined && concurrentWriters.length > 0
      ? ` · may include concurrent edits by: ${concurrentWriters.join(", ")}`
      : "";
  if (paths.length === 0) {
    return uncertain === true
      ? `files: unknown (shell used outside git)${writers}`
      : undefined;
  }
  const list = paths.map((file) => displayPath(file, cwd)).join(", ");
  return `files: ${list}${uncertain === true ? " · plus unknown shell changes (outside git)" : ""}${writers}`;
}

/**
 * One `VERDICT:` line of a verifier's final output (SPEC v3
 * "Observability — Completion evidence — verifier verdict"): the marker
 * is case-sensitive, the value is one of PASS|FAIL|AMBIGUOUS, and an
 * optional parenthetical (the profile invites counts) may follow.
 * Whitespace around the marker and value is tolerated; anything else on
 * the line means it is not a verdict line.
 */
const VERDICT_LINE = /^\s*VERDICT:\s*(PASS|FAIL|AMBIGUOUS)(?:\s*\([^()\n]*\))?\s*$/;

/**
 * The verdict of the LAST well-formed `VERDICT:` line in `output`, or
 * undefined when none parses. Lines that carry the marker but not a
 * clean value are simply not matches — an earlier clean line still wins
 * over a later malformed one, matching "parse the last VERDICT: line;
 * none found => no verdict" (#49).
 */
export function parseVerdict(output: string): TaskVerdict | undefined {
  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = VERDICT_LINE.exec(lines[index]!);
    if (match !== null) return match[1] as TaskVerdict;
  }
  return undefined;
}

/**
 * The `verdict:` evidence line rendered beside `files:` — the parsed
 * verdict plus the honesty note the attribution evidence earns (#49):
 * a FAIL that observed no file change is an uncorroborated claim; a
 * PASS with nothing attributed is unverifiable. Undefined when the
 * outcome carries no verdict (non-verifier tasks, absent lines).
 */
export function verdictLine(outcome: TaskOutcome): string | undefined {
  const verdict = outcome.verdict;
  if (verdict === undefined) return undefined;
  if ((outcome.attributedFiles ?? []).length > 0) return `verdict: ${verdict}`;
  const note = verdict === "FAIL"
    ? "claim not corroborated by any observed file change"
    : verdict === "PASS"
      ? "unverifiable"
      : undefined;
  return note !== undefined ? `verdict: ${verdict} — ${note}` : `verdict: ${verdict}`;
}

/**
 * One line per absolute path that two or more outcomes in the batch
 * claimed: `overlap: /path — attributed by tasks a, b`. Computed on
 * write/edit-observed paths plus Git-derived paths only from tasks with
 * no concurrent writers — a task whose window named other writers may
 * carry their changes in its diff, so its Git-derived set would pin a
 * sibling's file on both tasks at once (user decision 2026-10-02).
 * Evidence, not a lock claim: it says so once, naming the file and the
 * tasks (SPEC v3 "Observability — Completion evidence").
 */
export function overlapLines(
  outcomes: readonly TaskOutcome[],
): string[] {
  const claims = new Map<string, string[]>();
  for (const outcome of outcomes) {
    const basis =
      (outcome.concurrentWriters?.length ?? 0) > 0
        ? (outcome.observedFiles ?? [])
        : outcome.attributedFiles;
    for (const file of new Set(basis ?? [])) {
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
 * stays complete for the details/recovery surface (the always-on
 * single surface renders every pointer unconditionally, ADR 0002).
 * A failed task's partial output is bounded the same way.
 */
export function formatDispatchResult(
  diagnostics: DiagnosticSink,
  outcomes: readonly TaskOutcome[],
  tasks: Ticket["tasks"],
  bounds: OutputBounds,
  brief?: string,
  tokenBudget?: TokenBudgetReport,
): string {
  const sections = outcomes.map((outcome) => {
    const task = tasks[outcome.index];
    const tag = task?.resumeTag;
    const aliased = task !== undefined ? aliasNote(task.aliasedFrom, task.agent) : "";
    // Field-normalization notes precede the alias note — the fold happens
    // first (SPEC v3 "Reflex meeting").
    const notes = [
      ...fieldNotes(task?.normalizedFrom),
      ...(aliased !== "" ? [aliased] : []),
    ];
    const head = `### Task ${descriptionLabel(task?.description) ?? outcome.id}${tag !== undefined ? ` ↻${tag}` : ""} — ${statusWord(outcome)}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`;
    const quarantined = outcome.quarantined
      ? "\nWorker termination is unconfirmed; its write scope stays reserved. Recorded output and token usage are lower bounds — its accounting is incomplete."
      : "";
    const integration = outcome.integration
      ? `\n${integrationLines(outcome.integration).join("\n")}`
      : "";
    const label = tasks[outcome.index]?.agent ?? outcome.id;
    // Completion evidence rides beside the task's claim — between the
    // status head and its output (SPEC v3 "Observability"). A verifier
    // task's parsed verdict rides the same evidence block (#49).
    const evidence = [
      filesLine(
        outcome.attributedFiles,
        outcome.uncertainFiles,
        task?.cwd,
        outcome.concurrentWriters,
      ),
      verdictLine(outcome),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const files = evidence !== "" ? `\n${evidence}` : "";
    if (outcome.status === "ok") {
      return `${head}${files}\n${renderOutputForLLM(diagnostics, outcome.output ?? "", label, bounds)}${quarantined}${integration}`;
    }
    const detail = outcome.error ?? "no output";
    const session =
      outcome.sessionFile !== undefined
        ? `\n${recoveryLines(outcome.sessionFile).join("\n")}`
        : "";
    const partial = outcome.output
      ? `\n\nPartial output:\n${renderOutputForLLM(diagnostics, outcome.output, label, bounds)}`
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
  // The brief is batch context, not a task — it heads the result once
  // and never repeats inside a task section (SPEC v3 "Batch brief").
  // The token-budget account rides the same header row (#47).
  const head = [briefNote(brief), budgetNote(tokenBudget)]
    .filter((line) => line !== undefined)
    .join("\n");
  return (head !== "" ? `${head}\n\n` : "") +
    sections.join("\n\n") + lowerBound + overlapNote;
}

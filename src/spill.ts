import { DiagnosticSink } from "./diagnostics.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DELEGATE_TREES } from "./fsx.ts";
import type { OutputBounds } from "./types.ts";

const SPILL_PREFIX = "delegate-output-";
const SPILL_HASH_CHARS = 16;

// Spill files older than this are swept when the ticket store connects.
const SPILL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// ── Spill: keep subagent final-output bloat out of the LLM context ───────
//
// Two audiences share one source of truth (`outcome.output`):
//   - the human's expanded views (always the full output — the ticket
//     record retains it, and delivered/sync results carry it in details)
//   - the LLM-facing `content` string (bounded here — tail kept, head
//     spilled)
//
// The spill is a greppable plain-text `.md` projection of the *final output*
// only. The full transcript already lives in the session `.jsonl`; this does
// not duplicate it. Since #145 (ruled 2026-10-16) spills live under the
// agent directory beside the ticket records, content-addressed so every
// render of the same output names the same path across processes, and are
// swept after SPILL_RETENTION_MS — a pointer in a transcript never names a
// file the OS is about to delete. Design: lossless always — if the spill
// write fails, we degrade to full output in-context rather than
// hard-truncate.

/** The spill directory for an agent directory (single derivation site). */
export function spillDirOf(agentDir: string): string {
  return path.join(agentDir, DELEGATE_TREES.spills);
}

/**
 * Bounds that never bound: `decideSpill` can never fire under them, so no
 * spill file is ever written and every output renders whole. The human
 * expanded views (tool result, ticket poll, delivered message) render
 * recorded output through them — spill is an LLM-context economy, not a
 * display one.
 */
export const UNBOUNDED_OUTPUT: OutputBounds = {
  spillThresholdChars: Number.POSITIVE_INFINITY,
  spillTailChars: Number.POSITIVE_INFINITY,
  errorTailChars: Number.POSITIVE_INFINITY,
};

/** Decision over an output string: spill or not, and what stays in-context. */
export interface SpillDecision {
  /** True when the output exceeds the threshold and should be spilled. */
  readonly spill: boolean;
  /** The text to keep in-context — full output when not spilling, the tail when spilling. */
  readonly inContext: string;
  /** Length of the full output (chars). */
  readonly fullChars: number;
}

/**
 * Pure decision: given an output string and bounds, decide whether to spill
 * and what tail to keep in-context. Testable without any filesystem.
 *
 * - Output at or under the threshold → passthrough (no spill).
 * - Over the threshold → keep the suffix of length `spillTailChars`.
 * - The tail is the *suffix*, not the prefix: a subagent's verdict is at the
 *   end; the preamble is usually regurgitated tool output.
 *
 * The tail slice is surrogate-pair-aware: if the cut lands on a trailing
 * surrogate, it advances one so the in-context string never begins with a
 * lone (replacement-char-rendering) half of an astral character.
 */
export function decideSpill(
  output: string,
  bounds: OutputBounds,
): SpillDecision {
  const fullChars = output.length;
  if (fullChars <= bounds.spillThresholdChars) {
    return { spill: false, inContext: output, fullChars };
  }
  return {
    spill: true,
    inContext: tailOf(output, bounds.spillTailChars),
    fullChars,
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

/** Deterministic spill path: same output content → same file name. */
function spillFilePath(
  dir: string,
  label: string,
  output: string,
): string {
  const safeLabel = label.replace(/[^\w.-]+/g, "_").slice(0, 64) || "agent";
  const digest = createHash("sha256").update(output).digest("hex");
  return path.join(
    dir,
    `${SPILL_PREFIX}${safeLabel}-${digest.slice(0, SPILL_HASH_CHARS)}.md`,
  );
}

/**
 * Write the full output under the agent directory and return its path, or
 * `null` on failure. Never throws — callers rely on the lossless-degrade
 * guarantee.
 *
 * The name is content-addressed (sha256 of the output), so any renderer of
 * the same output — this process or a cold restart — computes the same path.
 * Files are mode 0o600 in a 0o700 owner-only directory and opened with
 * `wx`: an existing name means identical content is already on disk, and no
 * create can ever clobber another spill.
 */
function writeSpill(
  diagnostics: DiagnosticSink,
  dir: string,
  output: string,
  label: string,
): string | null {
  let fd: number | undefined;
  const target = spillFilePath(dir, label, output);
  try {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (mkdirError) {
      diagnostics.log("warn", "spill directory unavailable", { path: dir }, mkdirError);
      return null;
    }
    fd = fs.openSync(target, "wx", 0o600);
    fs.writeFileSync(fd, output);
    fs.closeSync(fd);
    return target;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Continue to remove the incomplete file below.
      }
      try {
        fs.rmSync(target, { force: true });
      } catch (cleanupError) {
        diagnostics.log("warn", "spill partial-file cleanup failed", { path: target }, cleanupError);
      }
    }
    // A same-name file already on disk is the common success case
    // (content-addressed re-render), not a failure.
    if (errorCode(error) === "EEXIST") return target;
    diagnostics.log("warn", "spill write failed", { path: target }, error);
    return null;
  }
}

/**
 * Delete spill files older than SPILL_RETENTION_MS. Observation only —
 * never throws, and the swept files are derived artifacts (the ticket
 * records retain the complete outputs) so a failure to sweep is logged and
 * forgotten.
 */
export function sweepSpills(diagnostics: DiagnosticSink, dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // No spills yet — nothing to sweep.
  }
  const cutoff = Date.now() - SPILL_RETENTION_MS;
  let swept = 0;
  for (const name of names) {
    if (!name.startsWith(SPILL_PREFIX)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        swept++;
      }
    } catch (statError) {
      diagnostics.log("warn", "spill sweep stat failed", { path: file }, statError);
    }
  }
  if (swept > 0) {
    diagnostics.log("info", "swept expired spill files", { path: dir, count: swept });
  }
}

/**
 * Render a subagent's final output for the LLM-facing `content` string.
 *
 * What the settled-ticket and sync-result callers use. Behavior:
 *   - under threshold (or empty/placeholder) → output unchanged
 *   - over threshold + write ok → tail + pointer to the spill file
 *   - over threshold + write fail → output unchanged (degrade), warn-logged
 */
export function renderOutputForLLM(
  diagnostics: DiagnosticSink,
  output: string,
  label: string,
  bounds: OutputBounds,
  spillDir: string | undefined,
): string {
  // Skip empty / placeholder — nothing to spill, nothing to bound. The
  // check is bare-empty plus the exact placeholder: a long whitespace-only
  // output must still spill (LLM context is consumed by chars, not by
  // visible content), so it is never exempted via trim().
  if (!output || output === "(no output)") return output;

  const decision = decideSpill(output, bounds);
  if (!decision.spill) return output;

  // No resolved spill directory (no agent dir): the lossless degrade.
  if (spillDir === undefined) return output;
  const filePath = writeSpill(diagnostics, spillDir, output, label);
  // Lossless degrade: write failed → return full output, never hard-truncate.
  if (!filePath) return output;

  return spillPointer(decision.inContext, filePath, decision.fullChars);
}

/**
 * Render a failed task's partial output for the LLM-facing content string:
 * a bounded tail plus one line naming the durable copies — never a spill
 * file (#145 ruling: error payloads cap at `errorTailChars`, Codex parity;
 * the complete text is already retained on the record, in details, and in
 * the session transcript the failure section names).
 */
export function renderPartialForLLM(
  output: string,
  errorTailChars: number,
): string {
  if (!output || output.length <= errorTailChars) return output;
  const tail = tailOf(output, errorTailChars);
  return `…${tail}\n[partial output truncated to its last ${errorTailChars} chars; the complete text is retained in this result's details and the session transcript]`;
}

/**
 * Render output for the running-ticket poll view: **tail only, no file.**
 *
 * The output is a moving target mid-flight (a done task's full spill lands
 * at ticket completion); writing a file per poll would churn paths and
 * confuse the LLM. So the poll stays bounded with a tail and accurately
 * says whether completion will spill or include the full output.
 * Under the tail budget → unchanged.
 */
export function renderOutputForPoll(
  output: string,
  bounds: OutputBounds,
): string {
  if (!output || output === "(no output)") return output;
  if (output.length <= bounds.spillTailChars) return output;
  const tail = tailOf(output, bounds.spillTailChars);
  const completionNote =
    output.length > bounds.spillThresholdChars
      ? "full output will spill to a file if possible when the ticket completes, with full in-result inclusion as the fallback"
      : "full output will be included when the ticket completes";
  return `…${tail}\n[truncated in this poll — ${completionNote}]`;
}

/** Assemble the tail + pointer block emitted on a successful spill. */
function spillPointer(
  tail: string,
  filePath: string,
  fullChars: number,
): string {
  return `…${tail}\n\n[full output (${humanSize(fullChars)}) spilled to ${filePath} —\n retained with the ticket store and swept only after 30 days; \`read\`/\`grep\` it if completeness matters here; above is the tail]`;
}

/**
 * Suffix of `s` at most `n` chars long, surrogate-pair-aware. If the cut
 * would land on a trailing surrogate, advance one so the result never
 * starts with a lone half of an astral character.
 */
export function tailOf(s: string, n: number): string {
  if (s.length <= n) return s;
  let start = s.length - n;
  if (start > 0 && (s.charCodeAt(start) & 0xfc00) === 0xdc00) start++;
  return s.slice(start);
}

/** Compact human-readable size from a char count (≈ bytes for ASCII). */
function humanSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${Math.round(chars / 1024)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

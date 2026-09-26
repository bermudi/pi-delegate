import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OutputBounds } from "./types.ts";

const SPILL_PREFIX = "delegate-output-";
const RANDOM_SUFFIX_BYTES = 16;
const CREATE_ATTEMPTS = 5;

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
// not duplicate it. Delegate never deletes spills because their pointers can
// persist in transcripts; lifecycle is left to the OS temp policy. Design:
// lossless always — if the spill write fails, we degrade to full output
// in-context rather than hard-truncate.

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

/**
 * Write the full output to a temp `.md` file and return its path, or `null`
 * on failure. Never throws — callers rely on the lossless-degrade guarantee.
 *
 * Files are mode 0o600 and opened with `wx`: even an improbable collision
 * can never overwrite another spill. Names use 128 bits of randomness and
 * collisions retry.
 */
export function spillToTempFile(
  output: string,
  label: string,
): string | null {
  const safeLabel = label.replace(/[^\w.-]+/g, "_").slice(0, 64) || "agent";
  const dir = os.tmpdir();
  let lastPath = path.join(dir, `${SPILL_PREFIX}${safeLabel}-unknown.md`);
  let lastError: unknown;

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    let fd: number | undefined;
    try {
      const candidate = randomBytes(RANDOM_SUFFIX_BYTES).toString("hex");
      lastPath = path.join(dir, `${SPILL_PREFIX}${safeLabel}-${candidate}.md`);
      fd = fs.openSync(lastPath, "wx", 0o600);
      fs.writeFileSync(fd, output);
      fs.closeSync(fd);
      return lastPath;
    } catch (error) {
      lastError = error;
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Continue to remove the incomplete file below.
        }
        try {
          fs.rmSync(lastPath, { force: true });
        } catch (cleanupError) {
          console.warn(
            `[delegate] spill partial-file cleanup failed (${lastPath}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
      if (errorCode(error) === "EEXIST") continue;
      break;
    }
  }

  console.warn(
    `[delegate] spill write failed (${lastPath}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  return null;
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
  output: string,
  label: string,
  bounds: OutputBounds,
): string {
  // Skip empty / placeholder — nothing to spill, nothing to bound. The
  // check is bare-empty plus the exact placeholder: a long whitespace-only
  // output must still spill (LLM context is consumed by chars, not by
  // visible content), so it is never exempted via trim().
  if (!output || output === "(no output)") return output;

  const decision = decideSpill(output, bounds);
  if (!decision.spill) return output;

  const filePath = spillToTempFile(output, label);
  // Lossless degrade: write failed → return full output, never hard-truncate.
  if (!filePath) return output;

  return spillPointer(decision.inContext, filePath, decision.fullChars);
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
  return `…${tail}\n\n[full output (${humanSize(fullChars)}) spilled to ${filePath} —\n retention follows OS temp policy; \`read\`/\`grep\` it if completeness matters here; above is the tail]`;
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

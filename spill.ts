import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOutputSpillTail, getOutputSpillThreshold } from "./config.ts";

const SPILL_PREFIX = "delegate-output-";
/** Delegate never removes a spill while its pointer may still be fresh in
 * model context. Older files are swept opportunistically; the OS may retain
 * them longer according to its own temp policy. */
export const OUTPUT_SPILL_RETENTION_MS = 24 * 60 * 60 * 1000;
const SPILL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const RANDOM_SUFFIX_BYTES = 16;
const CREATE_ATTEMPTS = 5;
const lastSpillSweepAtByDir = new Map<string, number>();

// ── Spill: keep subagent final-output bloat out of the LLM context ───────
//
// Two audiences share one source of truth (`result.output`):
//   - the human's expanded TUI view (always the full output, via
//     render-branches.ts `new Markdown(r.output)`)
//   - the LLM-facing `content` string (bounded here — tail kept, head spilled)
//
// The spill is a greppable plain-text `.md` projection of the *final output*
// only. The full transcript already lives in the session `.jsonl`; this does
// not duplicate it. Design: lossless always — if the spill write fails, we
// degrade to today's behavior (full output in context) rather than hard-truncate.

/** Decision over an output string: spill or not, and what stays in-context. */
export interface SpillDecision {
  /** True when the output exceeds the threshold and should be spilled. */
  spill: boolean;
  /** The text to keep in-context — full output when not spilling, the tail when spilling. */
  inContext: string;
  /** Length of the full output (chars). */
  fullChars: number;
}

/**
 * Pure decision: given an output string and bounds, decide whether to spill
 * and what tail to keep in-context. Testable without any filesystem.
 *
 * - Output at or under the threshold → passthrough (no spill).
 * - Over the threshold → keep the suffix of length `tailChars`.
 * - The tail is the *suffix*, not the prefix: a subagent's verdict is at the
 *   end; the preamble is usually regurgitated tool output.
 *
 * The tail slice is surrogate-pair-aware: if the cut lands on a trailing
 * surrogate, it advances one so the in-context string never begins with a
 * lone (replacement-char-rendering) half of an astral character.
 */
export function decideSpill(
  output: string,
  opts: { thresholdChars: number; tailChars: number },
): SpillDecision {
  const fullChars = output.length;
  if (fullChars <= opts.thresholdChars) {
    return { spill: false, inContext: output, fullChars };
  }
  return { spill: true, inContext: tailOf(output, opts.tailChars), fullChars };
}

/** Remove only Delegate spill files older than the retention window.
 *
 * This is deliberately independent of the 30-minute ticket TTL: a spill path
 * may already be present in model context after its ticket leaves the poll
 * registry. Cleanup is best-effort and never removes fresh files.
 */
export function sweepStaleSpillFiles(
  dir: string = os.tmpdir(),
  now = Date.now(),
  retentionMs = OUTPUT_SPILL_RETENTION_MS,
): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SPILL_PREFIX) || !name.endsWith(".md")) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && now - stat.mtimeMs > retentionMs) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // Another process may have removed it; cleanup must not block delivery.
    }
  }
}

function maybeSweepStaleSpillFiles(dir: string): void {
  const now = Date.now();
  const lastSweepAt = lastSpillSweepAtByDir.get(dir) ?? 0;
  if (now - lastSweepAt < SPILL_SWEEP_INTERVAL_MS) return;
  lastSpillSweepAtByDir.set(dir, now);
  sweepStaleSpillFiles(dir, now);
}

/**
 * Write the full output to a temp `.md` file and return its path, or `null`
 * on failure. Never throws — callers rely on the lossless-degrade guarantee.
 *
 * Files are mode 0o600 and opened with `wx`: even an improbable collision can
 * never overwrite another spill. Production names use 128 bits of randomness
 * and retry collisions. `suffix` and `dir` remain injectable for focused I/O
 * tests; a supplied suffix is attempted exactly once.
 */
export function spillToTempFile(
  output: string,
  label: string,
  suffix?: string,
  dir: string = os.tmpdir(),
): string | null {
  maybeSweepStaleSpillFiles(dir);
  const safeLabel = label.replace(/[^\w.-]+/g, "_").slice(0, 64) || "agent";
  const attempts = suffix === undefined ? CREATE_ATTEMPTS : 1;
  let lastPath = path.join(dir, `${SPILL_PREFIX}${safeLabel}-unknown.md`);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let fd: number | undefined;
    try {
      const candidate =
        suffix ?? randomBytes(RANDOM_SUFFIX_BYTES).toString("hex");
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
        } catch {
          // Best effort; the caller still receives the full output in context.
        }
      }
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (suffix === undefined && code === "EEXIST") continue;
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
 * What the callers use. Behavior:
 *   - under threshold (or empty/placeholder) → output unchanged
 *   - over threshold + write ok → tail + pointer to the spill file
 *   - over threshold + write fail → output unchanged (degrade), warn-logged
 *
 * `opts` lets tests inject small thresholds (and a `dir` to force write
 * failures) without touching the config singleton (there are no config
 * mutators — `delegate.json` is the only write path). Production callers omit
 * it and pick up `delegate.json` defaults.
 */
export function renderOutputForLLM(
  output: string,
  label: string,
  opts?: { thresholdChars?: number; tailChars?: number; dir?: string },
): string {
  // Skip empty / placeholder — nothing to spill, nothing to bound.
  if (!output || !output.trim() || output === "(no output)") return output;

  const thresholdChars = opts?.thresholdChars ?? getOutputSpillThreshold();
  const tailChars = opts?.tailChars ?? getOutputSpillTail();

  const decision = decideSpill(output, { thresholdChars, tailChars });
  if (!decision.spill) return output;

  const filePath = spillToTempFile(output, label, undefined, opts?.dir);
  // Lossless degrade: write failed → return full output, never hard-truncate.
  if (!filePath) return output;

  return spillPointer(decision.inContext, filePath, decision.fullChars);
}

/**
 * Render output for the running-ticket poll view: **tail only, no file.**
 *
 * The output is a moving target mid-flight (a done task's full spill lands at
 * ticket completion via `formatCompletedTask`); writing a file per poll would
 * churn paths and confuse the LLM. So the poll stays bounded with a tail and
 * accurately says whether completion will spill or include the full output.
 * Under the tail budget → unchanged.
 */
export function renderOutputForPoll(
  output: string,
  opts?: { tailChars?: number; thresholdChars?: number },
): string {
  if (!output || !output.trim() || output === "(no output)") return output;
  const tailChars = opts?.tailChars ?? getOutputSpillTail();
  if (output.length <= tailChars) return output;
  const thresholdChars = opts?.thresholdChars ?? getOutputSpillThreshold();
  const tail = tailOf(output, tailChars);
  const completionNote =
    output.length > thresholdChars
      ? "full output is spilled to a file when the ticket completes"
      : "full output will be included when the ticket completes";
  return `…${tail}\n[truncated in this poll — ${completionNote}]`;
}

/** Assemble the tail + pointer block emitted on a successful spill. */
function spillPointer(
  tail: string,
  filePath: string,
  fullChars: number,
): string {
  return `…${tail}\n\n[full output (${humanSize(fullChars)}) spilled to ${filePath} —\n retained by Delegate for at least 24 hours; \`read\`/\`grep\` it if completeness matters here; above is the tail]`;
}

/**
 * Suffix of `s` at most `n` chars long, surrogate-pair-aware. If the cut
 * would land on a trailing surrogate, advance one so the result never starts
 * with a lone half of an astral character.
 */
function tailOf(s: string, n: number): string {
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

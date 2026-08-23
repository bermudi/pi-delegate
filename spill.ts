import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { promises as asyncFs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOutputSpillTail, getOutputSpillThreshold } from "./config.ts";

const SPILL_PREFIX = "delegate-output-";
/** Delegate never removes a spill while its pointer may still be fresh in
 * model context. Older files are swept opportunistically; the OS may retain
 * them longer according to its own temp policy. */
export const OUTPUT_SPILL_RETENTION_MS = 24 * 60 * 60 * 1000;
const SPILL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SPILL_SWEEP_RETRY_BACKOFF_MS = 60 * 1000;
const SPILL_SWEEP_WARNING_INTERVAL_MS = 60 * 60 * 1000;
const RANDOM_SUFFIX_BYTES = 16;
const CREATE_ATTEMPTS = 5;
const lastSuccessfulSpillSweepAtByDir = new Map<string, number>();
const lastSpillSweepAttemptAtByDir = new Map<string, number>();
const lastSpillSweepWarningAtByDir = new Map<string, number>();
const spillSweepsInFlight = new Map<string, Promise<void>>();

type SpillSweep = (
  dir: string,
  now?: number,
  retentionMs?: number,
) => Promise<void>;

let spillSweep: SpillSweep = sweepStaleSpillFiles;
let spillSweepNow = Date.now;
let spillSweepWarn = (message: string): void => console.warn(message);

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

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove only Delegate spill files older than the retention window.
 *
 * This is deliberately independent of the 30-minute ticket TTL: a spill path
 * may already be present in model context after its ticket leaves the poll
 * registry. Cleanup is best-effort and never removes fresh files. Benign
 * ENOENT races are ignored; other per-file failures are reported together so
 * the scheduler can warn once rather than flooding stderr.
 */
export async function sweepStaleSpillFiles(
  dir: string = os.tmpdir(),
  now = Date.now(),
  retentionMs = OUTPUT_SPILL_RETENTION_MS,
): Promise<void> {
  let names: string[];
  try {
    names = await asyncFs.readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }

  const failures: Error[] = [];
  for (const name of names) {
    if (!name.startsWith(SPILL_PREFIX) || !name.endsWith(".md")) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = await asyncFs.lstat(filePath);
      if (stat.isFile() && now - stat.mtimeMs > retentionMs) {
        await asyncFs.rm(filePath, { force: true });
      }
    } catch (error) {
      // A concurrent process or temp cleaner may win either race.
      if (errorCode(error) === "ENOENT") continue;
      failures.push(new Error(`${filePath}: ${describeError(error)}`));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `failed to sweep ${failures.length} spill file${failures.length === 1 ? "" : "s"}`,
    );
  }
}

function warnAboutSpillSweepFailure(dir: string, error: unknown): void {
  const now = spillSweepNow();
  const lastWarningAt = lastSpillSweepWarningAtByDir.get(dir);
  if (
    lastWarningAt !== undefined &&
    now - lastWarningAt < SPILL_SWEEP_WARNING_INTERVAL_MS
  ) {
    return;
  }
  lastSpillSweepWarningAtByDir.set(dir, now);

  const detail =
    error instanceof AggregateError
      ? `${error.message}: ${error.errors.map(describeError).join("; ")}`
      : describeError(error);
  try {
    spillSweepWarn(`[delegate] spill cleanup failed (${dir}): ${detail}`);
  } catch {
    // Logging must not turn a best-effort background cleanup into a rejection.
  }
}

/**
 * Start a due sweep in a later microtask. The returned promise always settles
 * successfully: production deliberately fire-and-forgets it, while tests can
 * await the same promise through `_spillSweepTestHooks`.
 */
function maybeScheduleStaleSpillSweep(dir: string): Promise<void> | undefined {
  const now = spillSweepNow();
  const lastSuccessfulSweepAt = lastSuccessfulSpillSweepAtByDir.get(dir);
  if (
    lastSuccessfulSweepAt !== undefined &&
    now - lastSuccessfulSweepAt < SPILL_SWEEP_INTERVAL_MS
  ) {
    return undefined;
  }

  const existing = spillSweepsInFlight.get(dir);
  if (existing) return existing;

  // Completion and attempt timing are deliberately separate: success keeps
  // the normal hourly cadence, while failure becomes retryable after a short
  // backoff instead of making every subsequent spill rescan the directory.
  const lastAttemptAt = lastSpillSweepAttemptAtByDir.get(dir);
  if (
    lastAttemptAt !== undefined &&
    now - lastAttemptAt < SPILL_SWEEP_RETRY_BACKOFF_MS
  ) {
    return undefined;
  }
  lastSpillSweepAttemptAtByDir.set(dir, now);

  let completion!: Promise<void>;
  completion = Promise.resolve()
    .then(() => spillSweep(dir, now, OUTPUT_SPILL_RETENTION_MS))
    .then(() => {
      // A failed or partially failed sweep remains immediately retryable.
      lastSuccessfulSpillSweepAtByDir.set(dir, spillSweepNow());
    })
    .catch((error: unknown) => {
      try {
        warnAboutSpillSweepFailure(dir, error);
      } catch {
        // Keep the fire-and-forget promise fulfilled even if an injected test
        // clock or an unusual error object breaks warning formatting.
      }
    })
    .finally(() => {
      if (spillSweepsInFlight.get(dir) === completion) {
        spillSweepsInFlight.delete(dir);
      }
    });
  spillSweepsInFlight.set(dir, completion);
  return completion;
}

/**
 * Test-only controls for deterministic background-sweep assertions. Reset must
 * be called only after `awaitPending()` so a prior injected sweep cannot write
 * into freshly reset state.
 */
export const _spillSweepTestHooks = {
  setDependencies(overrides: {
    sweep?: SpillSweep;
    now?: () => number;
    warn?: (message: string) => void;
  }): void {
    spillSweep = overrides.sweep ?? sweepStaleSpillFiles;
    spillSweepNow = overrides.now ?? Date.now;
    spillSweepWarn = overrides.warn ?? ((message) => console.warn(message));
  },
  async awaitPending(): Promise<void> {
    await Promise.all([...spillSweepsInFlight.values()]);
  },
  reset(): void {
    if (spillSweepsInFlight.size > 0) {
      throw new Error(
        "cannot reset spill sweep state while a sweep is pending",
      );
    }
    spillSweep = sweepStaleSpillFiles;
    spillSweepNow = Date.now;
    spillSweepWarn = (message) => console.warn(message);
    lastSuccessfulSpillSweepAtByDir.clear();
    lastSpillSweepAttemptAtByDir.clear();
    lastSpillSweepWarningAtByDir.clear();
  },
};

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
  // The cleanup promise handles its own failure and starts in a later
  // microtask, keeping directory scans and removals off result delivery.
  void maybeScheduleStaleSpillSweep(dir);
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
      const code = errorCode(error);
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
  return `…${tail}\n\n[full output (${humanSize(fullChars)}) spilled to ${filePath} —\n Delegate cleanup is eligible after 24 hours, but OS temp cleanup may delete it sooner; \`read\`/\`grep\` it if completeness matters here; above is the tail]`;
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

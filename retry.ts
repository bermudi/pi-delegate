export const RETRYABLE_PATTERNS: RegExp[] = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /overloaded/i,
  /service unavailable/i,
  /temporar(?:ily)? unavailable/i,
  /provider.*unavailable/i,
  /model.*unavailable/i,
  /model.*disabled/i,
  /model.*not found/i,
  /unknown model/i,
  /connection refused/i,
  /connection.*(?:error|lost)/i,
  /other side closed/i,
  /reset before headers/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /ended without/i,
  /http2 request did not get a response/i,
  /upstream/i,
  /timed? out/i,
  /\btimeout\b/i,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /retry delay/i,
];

/** Backward-compat single regex for callers that import the old name.
 *  @deprecated Use isRetryableError() or RETRYABLE_PATTERNS */
export const RETRYABLE_PATTERN = new RegExp(
  RETRYABLE_PATTERNS.map((p) => p.source).join("|"),
  "i",
);

/** Check if an error message matches any retryable pattern. */
export function isRetryableError(error: string): boolean {
  if (!error) return false;
  return RETRYABLE_PATTERNS.some((p) => p.test(error));
}

/** Patterns that indicate a rate-limit (429 / quota) error. */
export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /overloaded/i,
  /retry delay/i,
];

/** Check if an error is specifically a rate limit (429 / quota) error.
 *  Rate limits need much longer backoff than transient network errors. */
export function isRateLimitError(error: string): boolean {
  if (!error) return false;
  return RATE_LIMIT_PATTERNS.some((p) => p.test(error));
}

/** Rate limits need much longer backoff than transient network errors.
 *  Multiplied against retryBaseMs so test suites can shrink all backoff by
 *  passing a small retryBaseMs — production default (2000) yields 30s. */
export const RATE_LIMIT_BACKOFF_MULTIPLIER = 15;

/** Pure helper for retry backoff math. Exported for testing. */
export function computeRetryDelay(
  attempt: number,
  retryBaseMs: number,
  taskIndex: number,
  isRateLimit: boolean,
): { baseDelay: number; jitter: number; stagger: number; delay: number } {
  const rawBase = isRateLimit ? retryBaseMs * RATE_LIMIT_BACKOFF_MULTIPLIER : retryBaseMs;
  const baseDelay = rawBase * Math.pow(2, attempt);
  const jitter = Math.random() * rawBase;
  const stagger = taskIndex * 10_000;
  const delay = Math.min(
    baseDelay + jitter + stagger,
    isRateLimit ? 300_000 : 60_000,
  );
  return { baseDelay, jitter, stagger, delay };
}

/**
 * Custom error for abort signals — avoids brittle string-matching on
 * error messages when distinguishing between expected aborts and real failures.
 */
export class AbortError extends Error {
  override name = "AbortError";
  constructor() {
    super("Aborted");
  }
}

/** Sleep for ms, aborting early if signal fires. */
export async function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Close TOCTOU window: signal could have fired between our early
      // aborted check above and addEventListener here.
      if (signal.aborted) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(new AbortError());
      }
    }
  });
}

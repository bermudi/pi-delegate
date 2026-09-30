/* Whole-task provider failure classification. Only explicit provider limits
 * override an ambiguous HTTP status; reset headers alone never imply a limit
 * (or override an explicit credential/account failure). */

type FailureKind = "auth" | "quota" | "window" | "short-limit" | "transient" | "other";

function classify(error: string | undefined): FailureKind {
  if (!error) return "other";
  // Provider prose and codes conventionally vary only in their word separators.
  const text = error.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (text.includes("abort")) return "other";
  const reset = /\b(?:retry after|x rate ?limit reset|reset(?:s|ting)? (?:in|at)|try again (?:in|after)|wait \d+\s*(?:s|sec|seconds?|m|min|minutes?|h|hours?))\b/.test(text);
  // Header-like metadata is not itself a provider diagnosis.
  const signal = text.replace(/\b(?:x rate ?limit(?: [a-z]+)?|rate limit):\s*\S+/g, "");
  if (/\b(?:unauthorized|unauthenticated|authentication|invalid api key|api key (?:is )?invalid|invalid oauth token|oauth token (?:is )?invalid)\b/.test(signal)) return "auth";
  if (/\b(?:usage limit|upgrade for higher limits|quota|exceeded your|insufficient (?:credit|funds)|billing)\b/.test(signal)) return "quota";
  if (/\b(?:rate limit(?: exceeded)?|too many requests|429)\b/.test(signal)) return reset ? "window" : "short-limit";
  if (/\b(?:401|403)\b/.test(signal)) return "auth";
  // A hint without an identified limit is not enough to authorize a retry.
  if (reset) return "other";
  if (/\b(?:temporarily overloaded|temporarily unavailable|overloaded|timeout|timed out|connection reset|econnreset|connection refused|network error|5\d\d)\b/.test(signal)) return "transient";
  return "other";
}

export function isModelAttributableError(error: string | undefined): boolean {
  return ["auth", "quota", "window"].includes(classify(error));
}

export function limitHint(error: string): string | undefined {
  switch (classify(error)) {
    case "window":
      return "Provider limit with a reported reset window; the provider's hint is above. No immediate retry or automatic resume is scheduled.";
    case "auth":
      return "Account or authentication problem; check the provider account or user-side delegate.json configuration. Delegate will not automatically resume this task.";
    case "quota":
      return "Provider usage/quota limit; check when the account's limit resets or whether it needs attention. No automatic resume is scheduled.";
    case "short-limit":
      return "Temporary provider rate limit; a short retry may have been attempted before side effects. No automatic resume is scheduled.";
    default:
      return undefined;
  }
}

export function isClearlyTransientError(error: string | undefined): boolean {
  const kind = classify(error);
  return kind === "short-limit" || kind === "transient";
}

export const MODEL_SWAP_HINT =
  "This looks like a model/account failure rather than a transient error; no same-model retry applies. The model comes from delegate.json (or the parent session) — the user may need to reconfigure it.";

export const MAX_TASK_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 150;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

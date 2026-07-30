// Node clamps timer delays larger than the signed 32-bit limit (~24.8 days)
// to ~1ms. Long waits are therefore scheduled against an absolute deadline in
// safe-sized chunks, so an intentionally patient timeout or inactivity window
// cannot be collapsed into an immediate fire.

/** Maximum delay a single `setTimeout` can represent before Node clamps it to
 *  ~1ms (the signed 32-bit millisecond limit). */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Invoke `onDeadline` at the absolute `deadline` timestamp, re-arming the timer
 * in sub-`MAX_TIMER_DELAY_MS` chunks so Node's clamp cannot turn a long wait
 * into an immediate fire.
 *
 * Returns a `clear()` that cancels the pending timer. `clear()` is idempotent
 * and also suppresses a callback already dequeued but not yet run, so a deadline
 * firing after cancellation is a no-op rather than a spurious action — callers
 * therefore do not need their own "already settled / already aborted" re-check
 * inside the terminal callback.
 */
export function scheduleDeadline(
  deadline: number,
  onDeadline: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  const arm = (): void => {
    if (cleared) return;
    const remaining = deadline - Date.now();
    const delay = Math.min(Math.max(remaining, 0), MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      if (cleared) return;
      if (Date.now() < deadline) {
        arm();
      } else {
        onDeadline();
      }
    }, delay);
  };
  arm();
  return () => {
    cleared = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}

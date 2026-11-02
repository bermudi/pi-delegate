import { expect } from "bun:test";

/**
 * Bun's default per-test timeout. `waitFor` MUST fail before this fires, or
 * the whole helper is pointless: Bun kills the test with a generic
 * "this test timed out after 5000ms" and the descriptive
 * `<what> (timed out waiting)` message — the reason these probes are shared —
 * never runs. Setup time counts against the test budget too, so the margin
 * below is not spare room for slow machines; it is room for the message.
 */
const BUN_DEFAULT_TEST_TIMEOUT_MS = 5_000;

/**
 * The one poll budget for test-level `waitFor` probes.
 *
 * These probes wait for observable state produced by a live worker: a
 * transcript line, a board row, a ticket view. The wait is a barrier, never a
 * measurement — a generous budget cannot make a passing test fail, it only
 * changes how long a genuinely broken test takes to report.
 *
 * 4s is measured, not guessed: across a full suite run the slowest real wait
 * is ~2s (a live-board frame under a deliberately blocked task), next ~1s,
 * and everything else under ~110ms. That leaves ~2x headroom on the observed
 * worst case while staying under the test timeout. Per-file budgets used to
 * diverge (2s / 4s / 4.5s / 5s); the 2s copy could expire on a loaded CI box,
 * and the 5s copies were already losing their own failure message to Bun.
 */
export const WAIT_BUDGET_MS = 4_000;

if (WAIT_BUDGET_MS >= BUN_DEFAULT_TEST_TIMEOUT_MS) {
  throw new Error(
    `WAIT_BUDGET_MS (${WAIT_BUDGET_MS}) must stay below Bun's ${BUN_DEFAULT_TEST_TIMEOUT_MS}ms ` +
      "test timeout, or a timed-out wait reports Bun's generic message instead of " +
      "the probe's own condition. Give a slow test an explicit longer timeout instead.",
  );
}

/**
 * Poll interval.
 *
 * 20ms is the interval eight of the replaced per-file copies used; the
 * `details.test.ts` and `live-board.test.ts` copies polled at 10ms. The
 * interval only bounds how stale an observation can be — the budget above is
 * what decides pass or fail — so the shared value stays slower rather than
 * busier.
 */
const POLL_INTERVAL_MS = 20;

/**
 * Block until `probe` reports true, then fail the test if it never did.
 *
 * Fails through `expect` so every waiting test reports the same shape:
 * `<what> (timed out waiting)`.
 */
export async function waitFor(
  probe: () => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!probe() && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  expect(probe(), `${what} (timed out waiting)`).toBeTrue();
}

import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/**
 * Pi-upgrade seam: subagent sessions must run with Pi's per-turn provider
 * auto-retry disabled (src/host.ts createSubagentSession sets an in-memory
 * `settingsManager.setRetryEnabled(false)`), because Pi's retry would
 * blindly re-issue a provider call before Delegate can apply its bounded,
 * side-effect-aware whole-task policy — e.g. immediately retrying into an
 * hour-long rate-limit reset window. AGENTS.md requires rechecking this
 * seam on every Pi bump; this test is that check.
 *
 * Determinism: `callCount` increments synchronously at stream entry. The
 * scripted error ("503 ... temporarily overloaded") is retryable by BOTH
 * Pi's own classifier (pi-ai isRetryableAssistantError matches 5xx /
 * "overloaded") and Delegate's transient classifier, so the counts below
 * distinguish the two retry owners exactly:
 * - retry off (contract): one provider call per whole-task attempt, and
 *   Delegate's MAX_TASK_ATTEMPTS = 2 → exactly 2 calls;
 * - retry on (regression): the first turn alone burns Pi's 3 attempts
 *   (with 2s backoffs) → ≥3 calls and the test fails on the count.
 */
describe("regression: child sessions disable Pi's per-turn auto-retry", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a retryable provider error gets exactly Delegate's bounded attempts, never Pi's per-turn retries",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const alwaysTransientError = () =>
        fauxAssistantMessage("attempt failed", {
          stopReason: "error",
          errorMessage: "503 temporarily overloaded; try again later",
        });
      subagents.respond([
        alwaysTransientError,
        alwaysTransientError,
        alwaysTransientError,
        alwaysTransientError,
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "hit a transient provider error" }],
      });

      // Delegate's whole-task retry ran (2 attempts) and each attempt made
      // exactly one provider call — Pi never retried inside a turn.
      expect(result.isError).toBe(true);
      expect(result.text).toContain("503 temporarily overloaded");
      expect(subagents.state.callCount).toBe(2);
    },
  );
});

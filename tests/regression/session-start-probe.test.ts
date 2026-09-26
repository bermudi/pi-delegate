import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { callDelegate, openDelegateBoundary } from "../support/pi-boundary.ts";

const faultPath = resolve(
  import.meta.dirname,
  "../support/broken-runtime-fault.ts",
);

describe("regression: session-start host-compat probe", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a broken host seam logs at session start without breaking the chat; the first dispatch fails with the actionable error",
    async () => {
      // Review of 150b46d: the session_start health probe must never
      // throw. A throw routes through the host's extension-error channel —
      // an error banner (or worse, a failed startup) for every session,
      // including chatters who never dispatch — and the model wiring may
      // not be final that early, so a hard failure could cry wolf. The
      // fault extension is loaded before delegate.ts and sabotages the
      // private runtime handle during its own session_start, so delegate's
      // probe runs against the broken seam: it must log a [delegate] line,
      // startup must complete with the tools registered, and the first
      // dispatch must fail whole-call with the same actionable message as
      // before the probe existed (dispatch-time behavior separately pinned
      // by tests/regression/host-runtime.test.ts).
      const error = spyOn(console, "error").mockImplementation(() => {});
      try {
        session = await openDelegateBoundary({
          leadingExtensions: [faultPath],
        });

        // Startup completed and the probe logged instead of reporting an
        // extension error through the host channel.
        expect(
          error.mock.calls.some((call) => {
            const line = String(call[0]);
            return (
              line.includes("[delegate]") &&
              line.includes("session-start probe failed")
            );
          }),
        ).toBe(true);
        expect(
          error.mock.calls.some((call) =>
            String(call[0]).includes("Extension error"),
          ),
        ).toBe(false);

        const result = await callDelegate(session, {
          tasks: [{ prompt: "never starts" }],
        });

        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "delegate cannot reach the parent session's model runtime; subagent dispatch is unavailable.",
        );
      } finally {
        error.mockRestore();
      }
    },
  );
});

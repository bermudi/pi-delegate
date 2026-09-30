import { describe, expect, test } from "bun:test";
import { exec } from "../../src/fsx.ts";

/**
 * Internal test, justified under COMPATIBILITY's migration policy ("add new
 * internal tests only when v2's own design warrants them"): a child exiting
 * before it drains a >pipe-buffer stdin payload raises an EPIPE on the stdin
 * stream, and that error lives below the delegate tool's public boundary —
 * no dispatch can deterministically force a git child to abandon its stdin
 * mid-patch. The scenario mirrors the `git apply --binary` stdin path
 * (src/isolated.ts), where the uncaught stream error once took down the
 * whole host process. The child's own exit status remains the only truth
 * about success or failure; absorbing the stream error hides nothing.
 */

/** Comfortably exceeds the ~64KB pipe buffer, so writes outlive the child. */
const OVER_PIPE_BUFFER = "a".repeat(4 * 1024 * 1024);

describe("exec stdin draining", () => {
  test("a child exiting early without draining stdin raises no uncaught stream error", async () => {
    // `head -c 10` reads 10 bytes and exits 0; the remaining ~4MB hits EPIPE.
    // Without an error listener on stdin this fails the run as an unhandled
    // stream error instead of resolving here.
    const result = await exec("head", ["-c", "10"], {
      input: OVER_PIPE_BUFFER,
      timeoutMs: 10_000,
      maxBuffer: 10_000_000,
    });
    expect(result.stdout).toBe("a".repeat(10));
  });

  test("a child failing before draining stdin still rejects with the child's failure", async () => {
    // The child exits 3 without reading anything: the exec failure must
    // surface through the promise, not vanish with the absorbed EPIPE.
    await expect(
      exec("sh", ["-c", "exit 3"], {
        input: OVER_PIPE_BUFFER,
        timeoutMs: 10_000,
        maxBuffer: 10_000_000,
      }),
    ).rejects.toThrow("failed");
  });
});

/**
 * Live-process worker stub for #43 stage-A tests: a real subprocess
 * (spawned via `process.execPath`) that speaks the real framed protocol
 * through `runWorkerHost`, with failure modes selected by
 * STUB_WORKER_MODE — provider-free, no model anywhere:
 *
 * - `cooperative` (default): streams progress events, quiesces on abort,
 *   returns a result.
 * - `wedged`: ignores abort and SIGTERM — only SIGKILL ends it.
 * - `crash`: dies with a nonzero exit code after hello.
 * - `descendant`: spawns a sleeping child inside its process group and
 *   reports the pid in an event, so tests can verify group kill.
 * - `wrong-version`: writes a `hello` with a bogus protocol version and
 *   then just sits (raw frames — the host's own hello is skipped).
 * - `silent`: never says hello (startup-timeout path).
 */
import { spawn } from "node:child_process";
import {
  runWorkerHost,
  type WorkerEmission,
} from "../../src/worker/host.ts";
import { encodeFrame } from "../../src/worker/protocol.ts";

const mode = process.env.STUB_WORKER_MODE ?? "cooperative";

if (mode === "wrong-version") {
  process.stdout.write(
    encodeFrame({ type: "hello", protocol: 999, pid: process.pid }),
  );
  process.stdin.resume(); // stay alive until killed
} else if (mode === "silent") {
  process.stdin.resume(); // say nothing, forever
} else {
  if (mode === "wedged") {
    // A wedged worker ignores every gentle nudge — SIGTERM included.
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
  }

  void runWorkerHost(async ({ emit, quiesce, abortSignal }) => {
    if (mode === "crash") {
      process.exit(3);
    }
    if (mode === "descendant") {
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      emit({
        type: "event",
        event: { kind: "descendant", pid: child.pid },
      } satisfies WorkerEmission);
      child.unref();
    }
    emit({
      type: "event",
      event: { kind: "progress", note: "working" },
    } satisfies WorkerEmission);
    if (mode === "wedged") {
      // Never settles: no abort listener, and a ref'd handle keeps the
      // loop alive — only a hard kill ends this worker.
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    // Simulate ongoing work: ticks until abort. 25ms cadence is fast
    // enough for the parent to observe liveness without flooding frames.
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        emit({
          type: "event",
          event: { kind: "tick" },
        } satisfies WorkerEmission);
      }, 25);
      tick.unref?.();
      abortSignal.addEventListener("abort", () => {
        clearInterval(tick);
        quiesce(`aborted: ${String(abortSignal.reason)}`);
        resolve();
      });
    });
    return { status: "ok", output: "stub-result" };
  }).then((code) => process.exit(code));
}

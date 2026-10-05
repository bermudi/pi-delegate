import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createFrameDecoder,
  encodeFrame,
  parseCommand,
  parseMessage,
  WORKER_PROTOCOL_VERSION,
} from "../../src/worker/protocol.ts";
import { spawnWorker } from "../../src/worker/spawn.ts";
import type {
  WorkerMessage,
  WorkerTaskSpec,
} from "../../src/worker/protocol.ts";

/**
 * #43 stage A — the worker subprocess boundary's machinery, exercised
 * against real live processes. Stage A is invariant-neutral: nothing in
 * dispatch calls `spawnWorker` yet, so there is no public tool surface
 * to drive this through — these pin the protocol and the supervisor
 * directly. The stage-B cutover adds registered-tool coverage.
 */

const STUB = resolve(import.meta.dirname, "../support/stub-worker.ts");

const SPEC: WorkerTaskSpec = {
  taskId: "t-stub",
  label: "stub",
  prompt: "PROMPT-NEVER-ON-ARGV",
  cwd: "/tmp",
  agentDir: "/tmp",
  model: "delegate-faux/faux-1",
  tools: [],
};

function spawnStub(
  mode: string,
  extra: Partial<Parameters<typeof spawnWorker>[0]> = {},
) {
  const messages: WorkerMessage[] = [];
  const logLines: string[] = [];
  const supervisor = spawnWorker({
    command: [process.execPath, STUB],
    spec: SPEC,
    env: { ...process.env, STUB_WORKER_MODE: mode },
    graceMs: 120,
    killGraceMs: 120,
    startupTimeoutMs: 250,
    onMessage: (message) => messages.push(message),
    log: (line) => logLines.push(line),
    ...extra,
  });
  return { supervisor, messages, logLines };
}

/** Poll until true, bounded. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !probe(); i++) await Bun.sleep(10);
  expect(probe(), `${what} (timed out waiting)`).toBe(true);
}

describe("worker protocol framing", () => {
  test("frames round-trip across arbitrary chunk boundaries", () => {
    const frames = [
      encodeFrame({ type: "hello", protocol: 1, pid: 42 }),
      encodeFrame({ type: "quiescent", reason: "done" }),
      encodeFrame({ type: "abort", reason: "stop" }),
    ];
    const wire = frames.join("");
    const seen: unknown[] = [];
    const decode = createFrameDecoder(
      (frame) => seen.push(frame),
      (error) => {
        throw error;
      },
    );
    // Byte-at-a-time feeding must reassemble identical frames.
    for (const char of wire) decode(char);
    expect(seen).toHaveLength(3);
    expect(parseMessage(seen[0])).toEqual({
      type: "hello",
      protocol: 1,
      pid: 42,
    });
    expect(parseMessage(seen[1])).toEqual({
      type: "quiescent",
      reason: "done",
    });
    expect(parseCommand(seen[2])).toEqual({ type: "abort", reason: "stop" });
  });

  test("an invalid frame is a loud decode error, once", () => {
    const errors: string[] = [];
    const decode = createFrameDecoder(
      () => {},
      (error) => errors.push(error.message),
    );
    decode("not-json\n");
    decode('{"type":"hello","protocol":1,"pid":1}\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("invalid frame");
  });

  test("oversized frames reject", () => {
    const errors: string[] = [];
    const decode = createFrameDecoder(
      () => {},
      (error) => errors.push(error.message),
    );
    decode(`${"x".repeat(4 * 1024 * 1024 + 1)}\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("size limit");
  });

  test("unknown message types and malformed hellos reject", () => {
    expect(() => parseMessage({ type: "nope" })).toThrow();
    expect(() => parseMessage({ type: "hello", protocol: "1" })).toThrow();
    expect(() => parseCommand({ type: "explode" })).toThrow();
  });
});

describe("worker supervision over a live process", () => {
  test("a cooperative worker aborts within the grace window", async () => {
    const { supervisor, messages, logLines } = spawnStub("cooperative");
    await waitFor(
      () => messages.length >= 1,
      "the first worker progress event",
    );
    const exit = await supervisor.requestStop("test abort");
    expect(exit.class).toBe("aborted");
    expect(exit.code).toBe(0);
    expect(
      (exit.result as { status?: string } | undefined)?.status,
    ).toBe("ok");
    // Correlated lifecycle log lines exist for diagnosis.
    expect(logLines.some((line) => line.includes("hello"))).toBe(true);
    expect(logLines.some((line) => line.includes("abort requested"))).toBe(
      true,
    );
    expect(logLines.some((line) => line.includes("quiescent"))).toBe(true);
    expect(
      logLines.some((line) => line.includes("class=aborted")),
    ).toBe(true);
  });

  test("a wedged worker escalates to a process-group kill", async () => {
    const { supervisor, logLines } = spawnStub("wedged");
    const started = Date.now();
    const exit = await supervisor.requestStop("wedged");
    expect(exit.class).toBe("killed");
    // The ladder is bounded: grace + kill grace, not a hang.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(logLines.some((line) => line.includes("SIGTERM"))).toBe(true);
    expect(logLines.some((line) => line.includes("SIGKILL"))).toBe(true);
  });

  test("a crashing worker classifies as crashed and keeps its code", async () => {
    const { supervisor } = spawnStub("crash");
    const exit = await supervisor.settled;
    expect(exit.class).toBe("crashed");
    expect(exit.code).toBe(3);
  });

  test("killing the worker's group takes its descendants with it", async () => {
    const { supervisor, messages } = spawnStub("descendant");
    await waitFor(() => {
      return messages.some(
        (message) =>
          message.type === "event" &&
          typeof (message.event as { pid?: unknown }).pid === "number",
      );
    }, "the descendant pid report");
    const report = messages.find(
      (message): message is Extract<WorkerMessage, { type: "event" }> =>
        message.type === "event" &&
        (message.event as { kind?: string }).kind === "descendant",
    )!;
    const descendantPid = (report.event as { pid: number }).pid;
    const exit = await supervisor.requestStop("group test");
    expect(["aborted", "killed"]).toContain(exit.class);
    // The supervisor sweeps the group on every exit path — a descendant
    // that outlives the worker dies with it, never orphans.
    await waitFor(() => {
      try {
        process.kill(descendantPid, 0);
        return false;
      } catch {
        return true;
      }
    }, `descendant pid ${descendantPid} to die`);
  });

  test("a protocol-version mismatch is protocol-failed", async () => {
    const { supervisor } = spawnStub("wrong-version");
    const exit = await supervisor.settled;
    expect(exit.class).toBe("protocol-failed");
    expect(exit.fatal).toContain("protocol version 999");
    expect(exit.fatal).toContain(String(WORKER_PROTOCOL_VERSION));
  });

  test("a worker that never says hello is startup-failed", async () => {
    const { supervisor } = spawnStub("silent");
    const exit = await supervisor.settled;
    expect(exit.class).toBe("startup-failed");
  });

  test("the task spec never travels on argv", async () => {
    const { supervisor } = spawnStub("cooperative");
    await waitFor(() => supervisor.pid !== undefined, "worker pid");
    const pid = supervisor.pid!;
    if (existsSync(`/proc/${pid}/cmdline`)) {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      expect(cmdline).not.toContain("PROMPT-NEVER-ON-ARGV");
      expect(cmdline).not.toContain("t-stub");
    }
    await supervisor.requestStop("done");
  });
});

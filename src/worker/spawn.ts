/**
 * Parent-side worker supervision (#43): spawns a worker subprocess in
 * its own process group, speaks the framed protocol over the child's
 * stdin/stdout, and owns the stop escalation ladder — cooperative
 * `abort`, a bounded grace, `SIGTERM` to the whole group, then `SIGKILL`
 * — so a wedged worker can never hold the parent indefinitely.
 * Descendants share the worker's process group and die with it.
 *
 * Every spawn, cancellation phase, crash, and cleanup failure is logged
 * through `log` (stderr by default) with the worker's correlation id.
 * This is stage A: nothing in dispatch calls it, and per the
 * 2026-10-06 owner decision closing #43 as wontfix (in-process execution
 * is permanent; no incumbent harness isolates subagents as subprocesses)
 * nothing ever will unless #43 is reopened on observed evidence of a
 * child session freezing the parent event loop.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  createFrameDecoder,
  encodeFrame,
  parseMessage,
  WORKER_PROTOCOL_VERSION,
  type WorkerCommand,
  type WorkerExitClass,
  type WorkerMessage,
  type WorkerTaskSpec,
} from "./protocol.ts";

export interface WorkerExit {
  readonly class: WorkerExitClass;
  /** The process exit code, or null when a signal ended it. */
  readonly code: number | null;
  readonly signal: string | null;
  /** The `result` frame's outcome payload, if one arrived before exit. */
  readonly result?: unknown;
  /** A `fatal` frame's message, if the worker reported one. */
  readonly fatal?: string;
}

export interface WorkerSupervisorOptions {
  /** Executable plus entry arguments — the task spec is NOT in here. */
  readonly command: readonly string[];
  readonly spec: WorkerTaskSpec;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /** Cooperative-abort grace before SIGTERM (default 5000ms). */
  readonly graceMs?: number;
  /** SIGTERM→SIGKILL escalation grace (default 2000ms). */
  readonly killGraceMs?: number;
  /** Deadline for the `hello` handshake (default 10_000ms). */
  readonly startupTimeoutMs?: number;
  /** Non-result messages stream here as they arrive. */
  readonly onMessage?: (message: WorkerMessage) => void;
  /** Correlated log sink; default prefixes `[delegate worker <id>]`. */
  readonly log?: (line: string) => void;
}

export interface WorkerSupervisor {
  /** The worker's pid once spawned — its process-group id too. */
  readonly pid: number | undefined;
  /** Resolves exactly once with the classified exit. */
  readonly settled: Promise<WorkerExit>;
  /** Send a control command; silently dropped once the worker is gone. */
  readonly send: (command: WorkerCommand) => void;
  /** The escalation ladder; idempotent, returns the final exit. */
  readonly requestStop: (reason?: string) => Promise<WorkerExit>;
}

export function spawnWorker(
  options: WorkerSupervisorOptions,
): WorkerSupervisor {
  const taskId = options.spec.taskId;
  const log = (line: string): void => {
    (options.log ?? ((text) => console.error(`[delegate worker ${taskId}] ${text}`)))(line);
  };
  const graceMs = options.graceMs ?? 5000;
  const killGraceMs = options.killGraceMs ?? 2000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;

  const child: ChildProcess = spawn(options.command[0]!, [...options.command.slice(1)], {
    // The worker leads its own process group: `kill(-pid)` reaches every
    // descendant it spawned. POSIX-only semantics; on platforms without
    // process groups the ladder still kills the worker itself.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env !== undefined ? { ...options.env } : undefined,
  });
  child.unref();

  let resolveSettled!: (exit: WorkerExit) => void;
  const settled = new Promise<WorkerExit>((resolve) => {
    resolveSettled = resolve;
  });
  let sawHello = false;
  let sawQuiescent = false;
  let sawResult: unknown;
  let fatalMessage: string | undefined;
  let fatalClass: WorkerExitClass | undefined;
  let exited = false;
  let termSent = false;
  let killSent = false;
  let stopRequested = false;
  const timers = new Set<NodeJS.Timeout>();
  const after = (ms: number, run: () => void): void => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    timers.add(timer);
  };
  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  const groupSignal = (signal: "SIGTERM" | "SIGKILL"): void => {
    if (child.pid === undefined) return;
    try {
      // Negative pid: the worker's whole process group — descendants
      // terminate with it rather than orphaning.
      process.kill(-child.pid, signal);
    } catch (error) {
      // ESRCH means the group is already gone — the good outcome.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch (inner) {
          log(
            `${signal} failed for group and worker: ${inner instanceof Error ? inner.message : String(inner)}`,
          );
        }
      }
    }
  };

  const finish = (exit: WorkerExit): void => {
    if (exited) return;
    exited = true;
    clearTimers();
    log(
      `exited class=${exit.class} code=${exit.code ?? "∅"} signal=${exit.signal ?? "∅"}`,
    );
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolveSettled(exit);
  };

  const classify = (code: number | null, signal: string | null): WorkerExit => {
    if (!sawHello) {
      return { class: "startup-failed", code, signal };
    }
    if (fatalMessage !== undefined) {
      // A worker-reported fatal keeps its own classification; a bare
      // nonzero exit without one is a crash.
      return { class: fatalClass ?? "crashed", code, signal, fatal: fatalMessage };
    }
    if (killSent || termSent) {
      return { class: "killed", code, signal };
    }
    if (stopRequested || sawQuiescent) {
      return { class: "aborted", code, signal, result: sawResult };
    }
    if (code === 0) {
      return { class: "settled", code, signal, result: sawResult };
    }
    return { class: "crashed", code, signal, result: sawResult };
  };

  const decode = createFrameDecoder(
    (frame) => {
      let message: WorkerMessage;
      try {
        message = parseMessage(frame);
      } catch (error) {
        fatalMessage =
          error instanceof Error ? error.message : String(error);
        fatalClass = "protocol-failed";
        log(`protocol error: ${fatalMessage}`);
        // A peer that cannot speak the protocol cannot be asked to stop;
        // kill its group so nothing orphans.
        groupSignal("SIGKILL");
        finish({ class: "protocol-failed", code: null, signal: null, fatal: fatalMessage });
        return;
      }
      if (message.type === "hello") {
        if (message.protocol !== WORKER_PROTOCOL_VERSION) {
          fatalMessage =
            `protocol version ${message.protocol} — expected ${WORKER_PROTOCOL_VERSION}`;
          fatalClass = "protocol-failed";
          log(`protocol error: ${fatalMessage}`);
          groupSignal("SIGKILL");
          finish({ class: "protocol-failed", code: null, signal: null, fatal: fatalMessage });
          return;
        }
        sawHello = true;
        log(`hello from pid ${message.pid}`);
        return;
      }
      if (message.type === "result") {
        sawResult = message.outcome;
        return;
      }
      if (message.type === "quiescent") {
        sawQuiescent = true;
        log(`quiescent: ${message.reason}`);
        return;
      }
      if (message.type === "fatal") {
        fatalMessage = message.message;
        fatalClass = message.class;
        log(`fatal (${message.class}): ${message.message}`);
        return;
      }
      options.onMessage?.(message);
    },
    (error) => {
      fatalMessage = error.message;
      fatalClass = "protocol-failed";
      log(`protocol error: ${error.message}`);
      groupSignal("SIGKILL");
      finish({ class: "protocol-failed", code: null, signal: null, fatal: error.message });
    },
  );

  child.stdout?.on("data", (chunk: Buffer) => decode(chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    // Worker stderr is operational chatter: correlated, line-wise, never
    // silently dropped.
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() !== "") log(`stderr: ${line}`);
    }
  });
  child.on("error", (error) => {
    log(`spawn error: ${error.message}`);
    finish({ class: "startup-failed", code: null, signal: null, fatal: error.message });
  });
  child.on("exit", (code, signal) => {
    // Group sweep on every exit path — cooperative included: the group id
    // outlives its leader, so a descendant that outlived the worker still
    // takes the signal instead of orphaning.
    if (process.platform !== "win32" && child.pid !== undefined) {
      groupSignal("SIGTERM");
    }
    finish(classify(code, signal));
  });

  const send = (command: WorkerCommand): void => {
    if (exited || child.stdin?.writable !== true) return;
    try {
      child.stdin.write(encodeFrame(command));
    } catch (error) {
      log(`control write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // The handshake deadline: a worker that never says hello is
  // startup-failed — kill it rather than wait forever.
  after(startupTimeoutMs, () => {
    if (!sawHello && !exited) {
      log(`startup timeout after ${startupTimeoutMs}ms — killing`);
      killSent = true;
      groupSignal("SIGKILL");
      finish({ class: "startup-failed", code: null, signal: null });
    }
  });

  let stopping: Promise<WorkerExit> | undefined;
  const requestStop = (reason = "stop requested"): Promise<WorkerExit> => {
    if (stopping !== undefined) return stopping;
    stopRequested = true;
    stopping = (async () => {
      send({ type: "abort", reason });
      log(`abort requested (${reason}); grace ${graceMs}ms`);
      // Cooperative phase: quiescent or exit within the grace window
      // means gentle means sufficed.
      const gentle = await Promise.race([
        settled.then(() => "exited" as const),
        new Promise<"grace-expired">((resolve) =>
          after(graceMs, () => resolve("grace-expired")),
        ),
      ]);
      if (gentle === "exited") return settled;
      log(`grace expired — SIGTERM process group`);
      termSent = true;
      groupSignal("SIGTERM");
      const terminated = await Promise.race([
        settled.then(() => "exited" as const),
        new Promise<"kill-expired">((resolve) =>
          after(killGraceMs, () => resolve("kill-expired")),
        ),
      ]);
      if (terminated === "exited") return settled;
      log(`SIGTERM ignored — SIGKILL process group`);
      killSent = true;
      groupSignal("SIGKILL");
      return settled;
    })();
    return stopping;
  };

  // Kick the spec over the control channel as soon as the pipe is ready.
  send({ type: "start", spec: options.spec });
  log(`spawned pid ${child.pid ?? "?"}`);

  return {
    get pid() {
      return child.pid;
    },
    settled,
    send,
    requestStop,
  };
}

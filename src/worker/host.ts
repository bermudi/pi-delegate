/**
 * The worker subprocess's host loop (#43): says `hello`, reads the
 * `start` frame's task spec off stdin, runs the supplied body, and
 * relays its emissions and outcome back over stdout. Cooperative abort
 * is first-class — `abort` flips the signal the body must honor; the
 * body reports quiescence so the parent's escalation ladder knows when
 * gentle means sufficed.
 *
 * This module is a library, not an entry point: a worker entry script
 * calls `runWorkerHost` with the body that actually runs the task. The
 * production body — building the AgentSession — was declined with #43
 * (closed wontfix 2026-10-06); this module is dormant scaffolding and
 * no parent ever invokes a worker.
 */
import {
  createFrameDecoder,
  encodeFrame,
  parseCommand,
  WORKER_PROTOCOL_VERSION,
  type WorkerMessage,
  type WorkerTaskSpec,
} from "./protocol.ts";

/** What the body may emit mid-run; `result` is sent by the host itself. */
export type WorkerEmission = Extract<
  WorkerMessage,
  { type: "event" | "usage" | "question" }
>;

export interface WorkerBodyContext {
  readonly spec: WorkerTaskSpec;
  /** Fires when the parent requests cooperative abort. */
  readonly abortSignal: AbortSignal;
  /** Stream a progress/event/usage/question message to the parent. */
  readonly emit: (emission: WorkerEmission) => void;
  /** Announce that all worker activity has stopped. */
  readonly quiesce: (reason: string) => void;
}

/**
 * The task body. Resolve with the outcome payload (relayed as `result`),
 * or throw — a throw becomes a `fatal` frame followed by a nonzero exit.
 */
export type WorkerBody = (
  context: WorkerBodyContext,
) => Promise<unknown>;

interface IoStreams {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
}

/**
 * Run a worker on the given streams (the child's own stdio in
 * production; anything in tests). Resolves with the process exit code
 * the entry script should use — nonzero only when no classified result
 * or fatal could be reported.
 */
export async function runWorkerHost(
  body: WorkerBody,
  io: IoStreams = process,
): Promise<number> {
  const send = (message: WorkerMessage): void => {
    io.stdout.write(encodeFrame(message));
  };

  send({ type: "hello", protocol: WORKER_PROTOCOL_VERSION, pid: process.pid });

  const abortController = new AbortController();
  let done: (code: number) => void;
  const finished = new Promise<number>((resolve) => (done = resolve));
  let started = false;
  let settled = false;
  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    done(code);
  };
  // Quiescence is exactly-once by contract: the first declaration wins,
  // later calls are no-ops so a body can't quiesce twice by accident.
  let quiesced = false;
  const quiesce = (reason: string): void => {
    if (quiesced || settled) return;
    quiesced = true;
    send({ type: "quiescent", reason });
  };

  const decode = createFrameDecoder(
    (frame) => {
      let command;
      try {
        command = parseCommand(frame);
      } catch (error) {
        send({
          type: "fatal",
          class: "protocol-failed",
          message: error instanceof Error ? error.message : String(error),
        });
        finish(65);
        return;
      }
      if (command.type === "abort") {
        abortController.abort(command.reason);
        return;
      }
      if (command.type === "shutdown") {
        quiesce("shutdown");
        finish(0);
        return;
      }
      if (started) return; // a second start is meaningless; ignore it
      started = true;
      void (async () => {
        try {
          const outcome = await body({
            spec: command.spec,
            abortSignal: abortController.signal,
            emit: (emission) => {
              if (!settled) send(emission);
            },
            quiesce,
          });
          send({ type: "result", outcome });
          finish(0);
        } catch (error) {
          send({
            type: "fatal",
            class: "crashed",
            message:
              error instanceof Error ? error.message : String(error),
          });
          finish(70);
        }
      })();
    },
    (error) => {
      send({
        type: "fatal",
        class: "protocol-failed",
        message: error.message,
      });
      finish(65);
    },
  );

  io.stdin.on("data", (chunk: Buffer | string) => decode(chunk));
  // Parent gone or channel closed mid-run: a stdin end means nobody is
  // listening — honor it as an abort so a worker never orphans silently.
  io.stdin.on("end", () => {
    if (!settled) abortController.abort("control channel closed");
    if (!started) finish(64);
  });
  io.stdin.on("error", () => {
    if (!settled) abortController.abort("control channel error");
  });

  return finished;
}

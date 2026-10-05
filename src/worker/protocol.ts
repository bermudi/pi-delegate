/**
 * The parent↔worker wire protocol (#43): newline-delimited JSON frames
 * over the child's stdin (commands) and stdout (messages). Prompts,
 * credentials, and environment contents never travel on argv, env, or
 * process metadata — the task spec arrives as the `start` frame on the
 * control channel.
 *
 * NDJSON is the frame format: JSON strings cannot contain a raw
 * newline, so one line is exactly one message with no length prefixing.
 * A version `hello` is the child's first frame; a mismatched protocol is
 * a loud failure, never a silent degrade.
 */
export const WORKER_PROTOCOL_VERSION = 1;

/** Largest single frame accepted; a peer exceeding it is protocol-failed. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * What the parent hands the worker in `start`. The stage-B AgentSession
 * body consumes it; keep it self-contained (no live handles, no
 * credentials) so it survives the wire verbatim.
 */
export interface WorkerTaskSpec {
  readonly taskId: string;
  readonly label: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly agentDir: string;
  /** `provider/model-id` the task resolves through. */
  readonly model: string;
  readonly tools: readonly string[];
}

/** Parent → child control channel (child stdin). */
export type WorkerCommand =
  | { readonly type: "start"; readonly spec: WorkerTaskSpec }
  | { readonly type: "abort"; readonly reason: string }
  | { readonly type: "shutdown" };

/** Why a worker ended. */
export type WorkerExitClass =
  | "settled"
  | "aborted"
  | "crashed"
  | "killed"
  | "startup-failed"
  | "protocol-failed";

/** Child → parent event channel (child stdout). */
export type WorkerMessage =
  | { readonly type: "hello"; readonly protocol: number; readonly pid: number }
  /** A forwarded worker-session event (progress, tool activity). */
  | { readonly type: "event"; readonly event: unknown }
  | { readonly type: "usage"; readonly usage: unknown }
  | { readonly type: "question"; readonly question: unknown }
  /** The task's final outcome payload; sent once, then the worker exits. */
  | { readonly type: "result"; readonly outcome: unknown }
  /** All worker activity confirmed stopped — safe to terminate. */
  | { readonly type: "quiescent"; readonly reason: string }
  /** A classified failure the worker itself reports before dying. */
  | {
      readonly type: "fatal";
      readonly class: WorkerExitClass;
      readonly message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse one decoded frame into a command; throws on any shape drift. */
export function parseCommand(frame: unknown): WorkerCommand {
  if (!isRecord(frame) || typeof frame.type !== "string") {
    throw new Error("worker command frame is not a typed object");
  }
  switch (frame.type) {
    case "start":
      if (!isRecord(frame.spec)) {
        throw new Error("start command carries no spec");
      }
      return frame as unknown as WorkerCommand;
    case "abort":
      return {
        type: "abort",
        reason:
          typeof frame.reason === "string" ? frame.reason : "abort requested",
      };
    case "shutdown":
      return { type: "shutdown" };
    default:
      throw new Error(`unknown worker command "${frame.type}"`);
  }
}

/** Parse one decoded frame into a message; throws on any shape drift. */
export function parseMessage(frame: unknown): WorkerMessage {
  if (!isRecord(frame) || typeof frame.type !== "string") {
    throw new Error("worker message frame is not a typed object");
  }
  switch (frame.type) {
    case "hello":
      if (
        typeof frame.protocol !== "number" ||
        typeof frame.pid !== "number"
      ) {
        throw new Error("hello frame missing protocol or pid");
      }
      return frame as unknown as WorkerMessage;
    case "event":
    case "usage":
    case "question":
      return frame as unknown as WorkerMessage;
    case "result":
      return frame as unknown as WorkerMessage;
    case "quiescent":
      return {
        type: "quiescent",
        reason:
          typeof frame.reason === "string" ? frame.reason : "worker stopped",
      };
    case "fatal":
      return {
        type: "fatal",
        class:
          typeof frame.class === "string"
            ? (frame.class as WorkerExitClass)
            : "protocol-failed",
        message:
          typeof frame.message === "string" ? frame.message : "unknown fatal",
      };
    default:
      throw new Error(`unknown worker message "${frame.type}"`);
  }
}

/** One wire frame: a JSON object plus the newline terminator. */
export function encodeFrame(message: WorkerCommand | WorkerMessage): string {
  const encoded = JSON.stringify(message);
  if (encoded === undefined) {
    throw new Error("worker frame failed to serialize");
  }
  return `${encoded}\n`;
}

/**
 * Incremental NDJSON decoder: `push` accepts arbitrarily chunked input
 * and calls `onFrame` once per complete line. An oversized or invalid
 * line reports through `onError` — the decoder is then dead and must not
 * be reused (a broken stream can never resynchronize honestly).
 */
export function createFrameDecoder(
  onFrame: (frame: unknown) => void,
  onError: (error: Error) => void,
): (chunk: string | Uint8Array) => void {
  let buffer = "";
  let dead = false;
  const fail = (error: Error): void => {
    if (dead) return;
    dead = true;
    onError(error);
  };
  return (chunk) => {
    if (dead) return;
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES * 2) {
      fail(new Error("worker frame exceeded the size limit"));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        fail(new Error("worker frame exceeded the size limit"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail(
          new Error(
            `worker sent an invalid frame: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      onFrame(parsed);
    }
  };
}

import { existsSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AdmissionController } from "./admission.ts";
import type { ResolvedTask, TaskStatus } from "./types.ts";

function log(context: string, error: unknown): void {
  console.error(
    `[delegate] ${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * The configuration a `sessionId` freezes at first use. Every reuse is
 * compared against the resolved (post-profile/default expansion) task —
 * tool comparison is order-independent. Provider extensions are not part
 * of it: subagent sessions are extension-free by construction.
 */
interface FrozenSessionConfig {
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly thinking: string | undefined;
  readonly model: string;
  readonly systemPrompt: string | undefined;
  readonly appendSystemPrompt: readonly string[];
}

function frozenConfig(task: ResolvedTask): FrozenSessionConfig {
  return {
    cwd: task.cwd,
    tools: [...task.tools].sort(),
    thinking: task.thinking,
    model: `${task.model.provider}/${task.model.id}`,
    systemPrompt: task.systemPrompt,
    appendSystemPrompt: task.appendSystemPrompt,
  };
}

function mismatches(
  frozen: FrozenSessionConfig,
  actual: FrozenSessionConfig,
): string[] {
  const diffs: string[] = [];
  if (frozen.cwd !== actual.cwd) {
    diffs.push(`cwd '${frozen.cwd}' vs '${actual.cwd}'`);
  }
  if (frozen.model !== actual.model) {
    diffs.push(`model '${frozen.model}' vs '${actual.model}'`);
  }
  if (frozen.thinking !== actual.thinking) {
    diffs.push(
      `thinking '${frozen.thinking ?? "default"}' vs '${actual.thinking ?? "default"}'`,
    );
  }
  if (frozen.systemPrompt !== actual.systemPrompt) {
    diffs.push("base prompt differs");
  }
  if (frozen.appendSystemPrompt.join("\n") !== actual.appendSystemPrompt.join("\n")) {
    diffs.push("appended prompt text differs");
  }
  if (frozen.tools.join("\n") !== actual.tools.join("\n")) {
    diffs.push(
      `tools [${frozen.tools.join(", ")}] vs [${actual.tools.join(", ")}]`,
    );
  }
  return diffs;
}

function incompatibleReuse(sessionId: string, diffs: readonly string[]): Error {
  return new Error(
    `Session '${sessionId}' is live with a frozen configuration; incompatible reuse: ${diffs.join("; ")}. ` +
      `Close it first with delegate_session({ action: "close", sessionId: "${sessionId}" }) or reuse it with matching cwd, tools, thinking, model, and base prompt.`,
  );
}

/** A live pooled session. `checkedOut` marks a run currently owning it. */
export interface PooledSession {
  readonly sessionId: string;
  readonly session: AgentSession;
  readonly config: FrozenSessionConfig;
  checkedOut: boolean;
}

/** How a finished run left its session; the pool decides the disposition. */
export interface SessionSettle {
  readonly entry: PooledSession | undefined;
  readonly task: ResolvedTask;
  readonly session: AgentSession;
  readonly outcome: {
    readonly status: TaskStatus;
    /** Whether session.prompt() was attempted this run. */
    readonly prompted: boolean;
    /** Set when a watchdog (deadline or stall) ended the run. */
    readonly watchdog: "deadline" | "stall" | undefined;
    /** Worker quiescence could not be confirmed; never dispose. */
    readonly quarantined: boolean;
  };
}

/**
 * The `sessionId` pool: live subagent sessions kept between calls for the
 * host's lifetime. Owned by the extension closure; admission serializes
 * same-ID calls, so an entry is ever checked out by one run at a time.
 *
 * Disposition rules (INVARIANTS "Session reuse"):
 * - insert only after a successful, prompted run with a durable session file;
 * - a checked-out session cancelled or watchdog-ended (deadline/stall) after
 *   prompting is evicted; either before prompting leaves it intact;
 * - an ordinary failure on a pooled session keeps it reusable;
 * - a quarantined session is evicted but never disposed — it may still be
 *   mutating.
 */
export class SessionPool {
  private readonly entries = new Map<string, PooledSession>();

  /**
   * Transcript file of a pooled session, when one is pooled — admission
   * resolves it for transcript exclusivity (a `resumeFrom` pointing at a
   * live pooled session's file must reject).
   */
  transcriptFileOf(sessionId: string): string | undefined {
    const file = this.entries.get(sessionId)?.session.sessionFile;
    return typeof file === "string" ? file : undefined;
  }

  /** Active invocation of the delegate-owned tool; never part of frozen tools. */
  private readonly questionHandlers = new WeakMap<AgentSession, (question: string, signal: AbortSignal) => Promise<string>>();

  bindQuestion(session: AgentSession, handler: ((question: string, signal: AbortSignal) => Promise<string>) | undefined): void {
    if (handler) this.questionHandlers.set(session, handler);
    else this.questionHandlers.delete(session);
  }

  askQuestion(session: AgentSession, question: string, signal: AbortSignal): Promise<string> {
    const handler = this.questionHandlers.get(session);
    if (!handler) throw new Error("ask_parent is only available during an async ticket run.");
    return handler(question, signal);
  }
  private closed = false;

  /**
   * Whole-call validation for dispatch: a reuse that would violate the
   * frozen configuration fails before any task starts. No-op for sessions
   * that are not pooled yet.
   */
  validateReuse(tasks: readonly ResolvedTask[]): void {
    const wantsSessions = tasks.some((task) => task.sessionId !== undefined);
    if (this.closed && wantsSessions) {
      throw new Error(
        "Delegate is shutting down; pooled sessions are no longer available.",
      );
    }
    for (const task of tasks) {
      if (task.sessionId === undefined) continue;
      const entry = this.entries.get(task.sessionId);
      if (entry === undefined) continue;
      if (task.resumeFrom !== undefined) {
        throw new Error(
          `Session '${task.sessionId}' is already live; resumeFrom cannot be applied to a running conversation. ` +
            `Close it first with delegate_session({ action: "close", sessionId: "${task.sessionId}" }).`,
        );
      }
      const diffs = mismatches(entry.config, frozenConfig(task));
      if (diffs.length > 0) throw incompatibleReuse(task.sessionId, diffs);
    }
  }

  /**
   * Take a pooled session for one run, or undefined when the id is not
   * pooled (or the task has none). Re-checks the frozen configuration —
   * a late mismatch is a task-level failure, not a whole-call error.
   */
  checkout(task: ResolvedTask): PooledSession | undefined {
    if (task.sessionId === undefined) return undefined;
    if (this.closed) {
      throw new Error(
        "Delegate is shutting down; pooled sessions are no longer available.",
      );
    }
    const entry = this.entries.get(task.sessionId);
    if (entry === undefined) return undefined;
    const diffs = mismatches(entry.config, frozenConfig(task));
    if (diffs.length > 0) throw incompatibleReuse(task.sessionId, diffs);
    if (entry.checkedOut) {
      throw new Error(
        `Session '${task.sessionId}' is already running a task; wait for it to finish.`,
      );
    }
    entry.checkedOut = true;
    return entry;
  }

  /**
   * Return a run's session to the pool's custody. Called exactly once per
   * run; owns disposal of every session it does not keep. A session whose
   * entry was removed underneath it (close/shutdown) is disposed rather
   * than re-pooled.
   */
  settle(args: SessionSettle): void {
    const { entry, task, session, outcome } = args;
    const sessionId = task.sessionId!;
    const stillPooled =
      entry !== undefined && this.entries.get(entry.sessionId) === entry;
    const evict = () => {
      if (stillPooled) this.entries.delete(sessionId);
      if (entry) entry.checkedOut = false;
    };
    const keep = () => {
      if (stillPooled) {
        entry.checkedOut = false;
      } else {
        this.dispose(session, sessionId);
      }
    };
    const dispose = () => this.dispose(session, sessionId);

    // Unconfirmed worker state outranks everything, including shutdown:
    // never reusable, never disposed — it may still be mutating.
    if (outcome.quarantined) {
      evict();
      return;
    }
    if (this.closed) {
      evict();
      dispose();
      return;
    }
    if (outcome.status === "ok" && outcome.prompted) {
      if (stillPooled) {
        entry.checkedOut = false;
        return;
      }
      if (entry !== undefined) {
        dispose();
        return;
      }
      // Insert-on-success requires a durable session file.
      const file = session.sessionFile;
      if (typeof file === "string" && existsSync(file)) {
        this.entries.set(sessionId, {
          sessionId,
          session,
          config: frozenConfig(task),
          checkedOut: false,
        });
      } else {
        console.error(
          `[delegate] session '${sessionId}' succeeded but has no durable session file; not pooled.`,
        );
        this.dispose(session, sessionId);
      }
      return;
    }
    if (entry !== undefined) {
      // Cancellation or a watchdog abort before prompting leaves the
      // session intact. Ordinary failure keeps it reusable. Anything else
      // evicts it.
      if (!outcome.prompted) {
        keep();
        return;
      }
      if (outcome.status === "failed" && outcome.watchdog === undefined) {
        keep();
        return;
      }
      evict();
      dispose();
      return;
    }
    // A fresh session that did not succeed never enters the pool.
    dispose();
  }

  private dispose(session: AgentSession, sessionId: string): void {
    try {
      session.dispose();
    } catch (error) {
      log(`dispose of pooled session '${sessionId}' failed`, error);
    }
  }

  /** `delegate_session` "list": every live pooled session, running or idle. */
  list(): string {
    if (this.entries.size === 0) {
      return "No live sessions. A task with a sessionId creates one.";
    }
    const lines = [...this.entries.values()].map(
      (entry) =>
        `- "${entry.sessionId}" — model ${entry.config.model}, cwd ${entry.config.cwd}` +
        (entry.checkedOut ? " (running)" : ""),
    );
    return `Sessions:\n${lines.join("\n")}`;
  }

  /**
   * `delegate_session` "close": remove, then cooperatively abort and dispose.
   * A busy session is running work — closing it would race that run's state
   * updates, so it rejects.
   */
  close(sessionId: string, busy: boolean): string {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      if (busy) {
        throw new Error(
          `Session '${sessionId}' is running work; it cannot be closed while a task owns it ` +
            `(its termination may also be unconfirmed). Wait for the work to finish or cancel the owning ticket.`,
        );
      }
      throw new Error(`No live session named '${sessionId}'.`);
    }
    if (busy || entry.checkedOut) {
      throw new Error(
        `Session '${sessionId}' is running work; it cannot be closed while a task owns it. ` +
          `Wait for the work to finish or cancel the owning ticket.`,
      );
    }
    this.entries.delete(sessionId);
    // The entry is already removed, so ordering is safe: request an abort
    // (no-op on an idle session) without awaiting — abort() waits for
    // quiescence, which a stuck session could withhold forever — then
    // dispose.
    entry.session.abort().catch((error: unknown) => {
      log(`abort on close of session '${sessionId}' failed`, error);
    });
    this.dispose(entry.session, sessionId);
    return `Session '${sessionId}' closed.`;
  }

  /**
   * Host shutdown: reject new pooling, request termination of checked-out
   * sessions (their runs own disposal through settle), and dispose idle
   * ones. Every failure is surfaced, none stops the remaining cleanup.
   */
  shutdown(): void {
    this.closed = true;
    const failures: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.checkedOut) {
        entry.session.abort().catch((error: unknown) => {
          log(`abort of session '${entry.sessionId}' during shutdown`, error);
        });
        continue;
      }
      try {
        entry.session.dispose();
      } catch (error) {
        failures.push(
          `${entry.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.entries.clear();
    if (failures.length > 0) {
      console.error(
        `[delegate] session shutdown cleanup failures: ${failures.join("; ")}`,
      );
    }
  }
}

export interface SessionRpcResult {
  readonly text: string;
  readonly isError: boolean;
}

/** delegate_session actions against the pool. */
export function handleSessionRpc(
  call: { action: "list" | "close"; sessionId: string | undefined },
  pool: SessionPool,
  admission: AdmissionController,
): SessionRpcResult {
  if (call.action === "list") {
    return { text: pool.list(), isError: false };
  }
  const sessionId = call.sessionId!;
  try {
    const text = pool.close(sessionId, admission.isSessionBusy(sessionId));
    return { text, isError: false };
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

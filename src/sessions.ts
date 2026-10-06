import { DiagnosticSink } from "./diagnostics.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AdmissionController } from "./admission.ts";
import { sanitizeText } from "./activity.ts";
import type { ResolvedTask, TaskStatus } from "./types.ts";


/**
 * The configuration a `sessionId` freezes at first use. Every reuse is
 * compared against the resolved (post-profile/default expansion) task —
 * tool comparison is order-independent. The provider-extension signature
 * is part of it: a `delegate.json` edit changing the applicable
 * allowlist must never silently reuse a session whose runtime already
 * loaded different extension code (#59; v1 lifecycle.ts).
 */
interface FrozenSessionConfig {
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly thinking: string | undefined;
  readonly model: string;
  readonly systemPrompt: string | undefined;
  readonly appendSystemPrompt: readonly string[];
  /** Opaque hash of the task's applicable extension sources ("" when none). */
  readonly providerExtensions: string;
}

function frozenConfig(task: ResolvedTask): FrozenSessionConfig {
  return {
    cwd: task.cwd,
    tools: [...task.tools].sort(),
    thinking: task.thinking,
    model: `${task.model.provider}/${task.model.id}`,
    systemPrompt: task.systemPrompt,
    appendSystemPrompt: task.appendSystemPrompt,
    providerExtensions: task.providerExtensions?.signature ?? "",
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
  if (frozen.providerExtensions !== actual.providerExtensions) {
    // The signature stays opaque even in the error — it may hash
    // credential-bearing source URLs.
    diffs.push("providerExtensions: changed");
  }
  return diffs;
}

function incompatibleReuse(sessionId: string, diffs: readonly string[]): Error {
  return new Error(
    `Session '${sessionId}' is live with a frozen configuration; incompatible reuse: ${diffs.join("; ")}. ` +
      `Close it first with delegate_session({ action: "close", sessionId: "${sessionId}" }) or reuse it with matching cwd, tools, thinking, model, and base prompt.`,
  );
}

/**
 * Force-flush a session's recorded entries (header plus any buffered
 * prompt/message lines) to its `.jsonl`.
 *
 * Pi's SessionManager intentionally does not write the file until the
 * first assistant message lands (its `_persist()` gates the first write
 * behind that check — an upstream contract). When a subagent's *first*
 * model call dies before producing one — e.g. a provider error — no file
 * is ever created, yet the planned path is already recorded. Reporting
 * that path as a resume target would send the caller to a nonexistent
 * file.
 *
 * The flush goes through upstream's `_rewriteFile()` — a private method,
 * the same seam upstream itself uses to recover empty/corrupt session
 * files — so the reported path becomes real on disk. Call this only on a
 * session that has wound down (never while a worker may still write, or
 * the rewrite could interleave with its appends). Idempotent: no-op when
 * the file already exists or the manager has no sessionFile.
 *
 * Returns true when a transcript file exists on return (whether this
 * call wrote it or it pre-existed), false otherwise.
 */
export function persistSessionHeader(diagnostics: DiagnosticSink, sm: unknown): boolean {
  const inner = sm as {
    getSessionFile?: () => string | undefined;
    _rewriteFile?: () => void;
  };
  const file = inner.getSessionFile?.();
  if (file === undefined) return false;
  if (existsSync(file)) return true;
  try {
    inner._rewriteFile?.();
  } catch (error) {
    // Best effort — the caller reports no sessionFile when this fails,
    // but the failure itself must not vanish silently.
    diagnostics.log("error", "session transcript flush failed", {}, error);
  }
  return existsSync(file);
}

/**
 * A transcript file's current byte size — 0 when it is absent or
 * unreadable. SessionManager appends whole lines synchronously once the
 * first assistant message lands, so a byte offset captured before the
 * first prompt marks where a run's entries begin (delegate_ticket tail).
 */
export function transcriptSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Clean assistant text appended to a session transcript after byte offset
 * `start` (the run's baseline — 0 for a fresh file, the size at checkout
 * for a pooled or resumed one). This is the delegate_ticket tail's source
 * of truth for file-backed tasks: the caller never parses `.jsonl`.
 *
 * Entries are whole `type: "message"` lines; a partial trailing line (a
 * write in flight) is skipped — the next read catches it once complete.
 * Per-message text blocks join with blank lines, messages with blank
 * lines — the same accumulation the activity store uses, so a tail stream
 * keeps its offsets when the source switches. Sanitized like activity
 * text: ANSI/control noise never reaches a tool result. A missing,
 * shrunk, or unreadable file reads as empty.
 */
export function assistantTextFromTranscript(
  file: string,
  start: number,
): string {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return "";
  }
  if (buffer.length <= start) return "";
  const slice = buffer.subarray(start).toString("utf8");
  const whole = slice.endsWith("\n") ? slice : slice.slice(0, slice.lastIndexOf("\n") + 1);
  const messages: string[] = [];
  for (const line of whole.split("\n")) {
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // corrupt or partially-written line — skip it
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry as { type?: unknown }).type !== "message"
    ) {
      continue;
    }
    const message = (entry as { message?: unknown }).message;
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { role?: unknown }).role !== "assistant"
    ) {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string" &&
        (block as { text: string }).text !== ""
      ) {
        parts.push(sanitizeText((block as { text: string }).text));
      }
    }
    if (parts.length > 0) messages.push(parts.join("\n\n"));
  }
  return messages.join("\n\n");
}

/** A live pooled session. `checkedOut` marks a run currently owning it. */
export interface PooledSession {
  readonly sessionId: string;
  /**
   * The live session while resident; undefined once the residency policy
   * (#46) unloaded it to `transcriptFile`. The record stays addressable —
   * the next checkout reloads it transparently, and `close`/`list` work
   * on it either way.
   */
  session: AgentSession | undefined;
  readonly config: FrozenSessionConfig;
  /** The durable transcript the session unloads to and reloads from. */
  readonly transcriptFile: string;
  checkedOut: boolean;
  /** Idle ordering for residency eviction — bumped on every return to idle. */
  idleSeq: number;
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
    /** Set when the inactivity watchdog ended the run. */
    readonly watchdog: "stall" | undefined;
    /** Worker quiescence could not be confirmed; never dispose. */
    readonly quarantined: boolean;
  };
  /** Idle residency bound (#46) — `delegate.json sessions.maxIdle`. */
  readonly maxIdle: number;
}

/**
 * The `sessionId` pool: live subagent sessions kept between calls for the
 * host's lifetime. Owned by the extension closure; admission serializes
 * same-ID calls, so an entry is ever checked out by one run at a time.
 *
 * Disposition rules (INVARIANTS "Session reuse"):
 * - insert only after a successful, prompted run with a durable session file;
 * - a checked-out session cancelled or stalled after
 *   prompting is evicted; either before prompting leaves it intact;
 * - an ordinary failure keeps it reusable, and so does an interrupt —
 *   the aborted run wound down quiescent, and keeping the worker alive is
 *   the interrupt's point (SPEC v3 "Interaction grammar — Interrupt");
 * - a quarantined session is evicted but never disposed — it may still be
 *   mutating.
 */
export class SessionPool {
  constructor(private readonly diagnostics: DiagnosticSink) {}

  private readonly entries = new Map<string, PooledSession>();
  /** Monotonic idle-order clock for residency eviction (#46). */
  private idleClock = 0;

  /**
   * Transcript file of a pooled session, when one is pooled — admission
   * resolves it for transcript exclusivity (a `resumeFrom` pointing at a
   * live pooled session's file must reject). Resident or unloaded, the
   * recorded file is the session's durable state.
   */
  transcriptFileOf(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.transcriptFile;
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
   * An entry unloaded under the residency policy (#46) reloads
   * transparently through `open` — the frozen-config check above already
   * proved the world did not change, so the reload continues the same
   * conversation on the same transcript file.
   */
  async checkout(
    task: ResolvedTask,
    open: (transcriptFile: string) => Promise<AgentSession>,
  ): Promise<PooledSession | undefined> {
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
    if (entry.session === undefined) {
      // Claim the entry before the async open: a second checkout arriving
      // mid-reload must see checkedOut, not race a duplicate open on the
      // same transcript file. A failed open releases the claim — the
      // unloaded record stays pooled for a later retry.
      entry.checkedOut = true;
      try {
        entry.session = await open(entry.transcriptFile);
      } catch (error) {
        entry.checkedOut = false;
        throw new Error(
          `Session '${task.sessionId}' could not be reloaded from its transcript ${entry.transcriptFile}: ` +
            `${error instanceof Error ? error.message : String(error)}.`,
          { cause: error },
        );
      }
    }
    // A steer or follow-up queued in the previous run's tail window (after
    // the loop's last queue poll but before settle) must not leak into this
    // reuse — while pooled, nothing can queue anything, so clearing here
    // once covers every park path.
    try {
      entry.session.agent.clearAllQueues();
    } catch (error) {
      this.diagnostics.log("error", "session cleanup failed", { operation: `clearing message queues on pooled session '${task.sessionId}' failed` }, error);
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
    const { entry, task, session, outcome, maxIdle } = args;
    const sessionId = task.sessionId!;
    const stillPooled =
      entry !== undefined && this.entries.get(entry.sessionId) === entry;
    const evict = () => {
      if (stillPooled) this.entries.delete(sessionId);
      if (entry) entry.checkedOut = false;
    };
    // A run releasing its entry idle re-arms it for residency selection.
    const keep = () => {
      if (stillPooled) {
        entry.checkedOut = false;
        entry.idleSeq = ++this.idleClock;
        this.enforceResidency(maxIdle);
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
        entry.idleSeq = ++this.idleClock;
        this.enforceResidency(maxIdle);
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
          transcriptFile: file,
          checkedOut: false,
          idleSeq: ++this.idleClock,
        });
        this.enforceResidency(maxIdle);
      } else {
        this.diagnostics.log("warn", "session succeeded but has no durable session file; not pooled", { sessionId });
        this.dispose(session, sessionId);
      }
      return;
    }
    if (entry !== undefined) {
      // Cancellation or a watchdog abort before prompting leaves the
      // session intact. Ordinary failure keeps it reusable, and so does
      // an interrupt: the run wound down quiescent and the worker is the
      // resumable surface the interrupt exists to preserve. Anything else
      // evicts it.
      if (!outcome.prompted) {
        keep();
        return;
      }
      if (
        (outcome.status === "failed" && outcome.watchdog === undefined) ||
        outcome.status === "interrupted"
      ) {
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

  /**
   * Idle residency bound (#46): beyond `maxIdle` resident idle sessions,
   * the least-recently-idle unload — the AgentSession is disposed and its
   * record keeps only the frozen config + transcript file, which the next
   * checkout reloads through `open`. Checked-out (in-flight) sessions are
   * never candidates; eviction runs on idle transitions only, so a session
   * is never unloaded out from under a run.
   */
  private enforceResidency(maxIdle: number): void {
    const resident = [...this.entries.values()].filter(
      (entry) => !entry.checkedOut && entry.session !== undefined,
    );
    resident.sort((a, b) => a.idleSeq - b.idleSeq);
    while (resident.length > maxIdle) {
      const victim = resident.shift()!;
      this.dispose(victim.session!, victim.sessionId);
      victim.session = undefined;
    }
  }

  private dispose(session: AgentSession, sessionId: string): void {
    try {
      session.dispose();
    } catch (error) {
      this.diagnostics.log("error", "session cleanup failed", { operation: `dispose of pooled session '${sessionId}' failed` }, error);
    }
  }

  /** `delegate_session` "list": every pooled session — running, resident idle, or on disk (#46). */
  list(): string {
    if (this.entries.size === 0) {
      return "No live sessions. A task with a sessionId creates one.";
    }
    const lines = [...this.entries.values()].map(
      (entry) =>
        `- "${entry.sessionId}" — model ${entry.config.model}, cwd ${entry.config.cwd}` +
        (entry.checkedOut
          ? " (running)"
          : entry.session === undefined
            ? " (idle, on disk)"
            : ""),
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
    // dispose. An unloaded entry has no live session at all (#46).
    if (entry.session !== undefined) {
      entry.session.abort().catch((error: unknown) => {
        this.diagnostics.log("error", "session cleanup failed", { operation: `abort on close of session '${sessionId}' failed` }, error);
      });
      this.dispose(entry.session, sessionId);
    }
    return `Session '${sessionId}' closed.`;
  }

  /**
   * Host shutdown: reject new pooling, request termination of checked-out
   * sessions (their runs own disposal through settle), and dispose idle
   * ones. Every failure is surfaced, none stops the remaining cleanup.
   */
  shutdown(): void {
    this.closed = true;
    let failures = 0;
    for (const entry of this.entries.values()) {
      // An unloaded entry (#46) owns no live session — nothing to tear down.
      if (entry.session === undefined) continue;
      if (entry.checkedOut) {
        entry.session.abort().catch((error: unknown) => {
          this.diagnostics.log("error", "session cleanup failed", { operation: `abort of session '${entry.sessionId}' during shutdown` }, error);
        });
        continue;
      }
      try {
        entry.session.dispose();
      } catch (error) {
        failures += 1;
        this.diagnostics.log("error", "session shutdown disposal failed", { sessionId: entry.sessionId }, error);
      }
    }
    this.entries.clear();
    if (failures > 0) {
      this.diagnostics.log("error", "session shutdown cleanup failures", { count: failures });
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

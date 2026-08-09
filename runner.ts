import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getGitChangedFiles,
  extractTouchedFromActivities,
} from "./file-tracking.ts";
import { extractTextFromPartialResult, extractOutput } from "./utils.ts";
import { snapshotSessionUsage, usageDelta, emptyUsage } from "./usage.ts";
import { getStallTimeoutMs } from "./config.ts";
import { fmtDuration } from "./format.ts";
import { scheduleDeadline } from "./timer.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  AgentProgressUpdate,
  TaskFailureKind,
  ToolActivity,
} from "./types.ts";

/** Human-facing error for an expired `deadlineMs` budget.
 *
 * This is exported so the lifecycle pre-check can return the same text as the
 * runner, keeping the sync and (future) async paths consistent. */
export function formatDeadlineExceededError(budgetMs: number): string {
  return `Deadline exceeded: task exceeded its ${fmtDuration(
    Math.max(0, budgetMs),
  )} wall-clock budget and was cooperatively aborted (not a hard kill). Completed writes and commands remain.`;
}

/**
 * Run a single prompt against a live `AgentSession` and report progress.
 *
 * This replaces the old `createAgent` / `runAgentOnce` / `runAgent` stack.
 * The `AgentSession` owns the model-call loop, per-message auto-retry
 * (strip-bad-message + `agent.continue()`), compaction, overflow recovery, and
 * session persistence — so this function only:
 *   1. subscribes to the session's event stream and maps it to the renderer's
 *      `AgentProgressUpdate` / `ToolActivity` shapes,
 *   2. wires the parent abort signal to `session.abort()`,
 *   3. waits for extension-started post-run compaction/continuations to become
 *      quiescent before returning ownership to lifecycle,
 *   4. snapshots usage before/after the prompt for token delta accounting, and
 *   5. computes touched files from activity + git diff.
 *
 * Touched-file tracking is best-effort. Explicit edit/write tool calls are
 * captured from the activity log. bash mutations are only captured via git
 * status when the cwd is a git repo and git is available; in a non-git
 * directory, bash-mutated files are not reported. Git failures on either the
 * baseline or post-run snapshot degrade to an empty diff, and a failed baseline
 * suppresses git-based attribution entirely so pre-existing dirty files are not
 * blamed on this task. The resulting list is a lower bound, not a complete
 * record.
 *
 * Output is captured from AgentSession events so compaction cannot erase it
 * before collection; `session.messages` is only a guarded fallback for
 * providers that fail before emitting message_end. AgentSession's internal
 * retry means a transient mid-loop error no longer hard-fails a task whose
 * work is already done.
 */
export async function runAgentSession(
  session: AgentSession,
  prompt: string,
  config: { cwd: string },
  signal: AbortSignal | undefined,
  onProgress: ((update: AgentProgressUpdate) => void) | undefined,
  gitBaseline: Set<string> | undefined,
  start: number,
  deadlineAt?: number,
): Promise<{
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
  usage: Usage;
  /** Best-effort union of activity- and git-derived touched files for display. */
  touchedFiles: string[];
  /** Files directly attributable to this run's edit/write tool calls. */
  attributedFiles: string[];
  failureKind?: TaskFailureKind;
  /** Whether `session.prompt()` was actually invoked. Distinguishes a pre-prompt
   *  deadline (session never used) from a mid-prompt deadline (session was
   *  prompted and may have partial state mutations). */
  prompted: boolean;
}> {
  const startTime = start ?? Date.now();
  const stallTimeoutMs = getStallTimeoutMs();
  let toolUses = 0;
  let lastActivityAt: number | undefined = startTime;
  let phase = "starting agent";
  let stalled = false;
  let stalledPhase: string | undefined;
  let clearStallDeadline: (() => void) | undefined;
  let deadlineExceeded = false;
  let clearDeadline: (() => void) | undefined;
  let prompted = false;
  const activities: ToolActivity[] = [];
  const pendingById = new Map<string, ToolActivity>();
  let sessionEventGeneration = 0;
  let wakeSessionEvent: (() => void) | undefined;

  // AgentSession.prompt() can return while an agent_settled extension callback
  // is still running fire-and-forget work through ctx.compact(). Keep a small
  // internal event seam so the runner can wait without polling throughout a
  // potentially long remote compaction. The generation closes the race between
  // checking session state and installing the next waiter.
  let abortRequestedGeneration = -1;
  const noteSessionEvent = () => {
    sessionEventGeneration++;
    const wake = wakeSessionEvent;
    wakeSessionEvent = undefined;
    wake?.();
  };
  const waitForSessionEventAfter = async (
    generation: number,
  ): Promise<void> => {
    if (sessionEventGeneration !== generation) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const probe = setTimeout(() => finish(), 250);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(probe);
        if (wakeSessionEvent === finish) wakeSessionEvent = undefined;
        resolve();
      };
      if (sessionEventGeneration !== generation) {
        finish();
        return;
      }
      // AgentSession normally emits every transition we care about. The slow
      // probe is a liveness fallback for host versions that clear an internal
      // busy flag without a corresponding public event.
      wakeSessionEvent = finish;
    });
  };
  const nextEventLoopTurn = () =>
    new Promise<void>((resolve) => setImmediate(resolve));

  const requestSessionCancellation = (
    source: "parent-aborted" | "stalled" | "deadline",
  ): void => {
    const logFailure = (operation: string, error: unknown) => {
      console.error(`[delegate] ${source} subagent ${operation} failed`, error);
    };
    try {
      session.abortCompaction();
    } catch (error) {
      logFailure("compaction cancellation", error);
    }
    try {
      session.abortBranchSummary();
    } catch (error) {
      logFailure("branch-summary cancellation", error);
    }
    noteSessionEvent();
    // Fire the abort before recording the generation. session.abort() may
    // synchronously emit events (e.g. a final message_update as the stream
    // unwinds) that increment the generation. Recording after the call
    // ensures those abort-caused events are accounted for, so the quiescence
    // barrier's re-abort check doesn't loop on the abort's own events.
    void session.abort().catch((error: unknown) => {
      logFailure("agent cancellation", error);
    });
    // Record the generation after abort is dispatched. If new session events
    // fire after this point (e.g. a continuation prompt started by an
    // extension's onComplete callback delayed by async auth), the quiescence
    // barrier re-aborts to cancel that continuation rather than letting it run
    // — and potentially mutate files — after the task is considered cancelled.
    abortRequestedGeneration = sessionEventGeneration;
  };

  /**
   * Wait until the session is idle and non-compacting for two unchanged event
   * loop turns. The quiet turns are significant: AgentSession emits
   * compaction_end before ctx.compact's onComplete/onError callback runs, and a
   * successful callback may immediately start a continuation prompt.
   *
   * Cancellation re-abort: if the task has been cancelled (parent abort or
   * stall), any session event after the last cancellation request means new
   * work started — typically a continuation from an extension's onComplete
   * callback, possibly delayed by async auth. The barrier re-aborts to cancel
   * it. This check runs *before* the idle check so a fast continuation that
   * already completed between samples is still caught: the generation changed
   * even though the session is idle again, and re-abort resets the tracker to
   * catch any further continuations.
   *
   * Cancelled grace period: when cancelled and idle, a single 50 ms wait is
   * required before quiet turns can accumulate. Without it, a continuation
   * delayed by async auth or another extension handler can start after the
   * runner returns — the two event-loop turns pass in microseconds, far faster
   * than any realistic async-auth gap. This is a **mitigation, not a
   * deterministic fix**: a deterministic solution would require the host to
   * expose pending extension work (e.g. `AgentSession.hasPendingExtensionWork()`)
   * so the barrier could wait on it explicitly. The grace period adds at most
   * one 50 ms wait per cancellation/re-abort cycle — re-aborts reset the
   * `graceWaited` flag, so a sequence of delayed continuations can cause
   * multiple grace waits.
   */
  const waitForSessionQuiescence = async (): Promise<void> => {
    const cancelledGraceMs = 50;
    const cancellationRequested = () =>
      signal?.aborted || stalled || deadlineExceeded;
    const cancellationSource = (): "parent-aborted" | "stalled" | "deadline" =>
      signal?.aborted
        ? "parent-aborted"
        : deadlineExceeded
          ? "deadline"
          : "stalled";
    let quietTurns = 0;
    let graceWaited = false;
    while (quietTurns < 2) {
      const generation = sessionEventGeneration;
      await nextEventLoopTurn();

      // Re-abort if new activity started after the last cancellation request.
      // This runs before the idle check so a fast continuation that completed
      // between samples (generation changed, session idle again) is still
      // caught. After re-aborting, restart the loop to recompute isIdle/
      // isCompacting rather than falling through to the 250 ms event probe.
      if (
        cancellationRequested() &&
        abortRequestedGeneration >= 0 &&
        sessionEventGeneration !== abortRequestedGeneration
      ) {
        requestSessionCancellation(cancellationSource());
        quietTurns = 0;
        graceWaited = false;
        continue;
      }

      const idle = session.isIdle && !session.isCompacting;
      if (idle && sessionEventGeneration === generation) {
        if (cancellationRequested() && !graceWaited) {
          // Wait once for a grace period before accepting quiet turns. A
          // continuation delayed by async auth can start after the immediate
          // microtask batch settles. This is a single setTimeout, not a
          // busy-spin — the event loop is free to process the continuation's
          // events during the wait.
          graceWaited = true;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, cancelledGraceMs),
          );
          continue;
        }
        quietTurns++;
        continue;
      }

      quietTurns = 0;
      graceWaited = false;
      if (!idle) {
        await waitForSessionEventAfter(sessionEventGeneration);
      }
    }
  };

  // Snapshot cumulative usage before the prompt so we can report only the
  // tokens consumed by this call (not cumulative history on a pooled/resumed
  // session). Cumulative session stats (including compacted-away history) are the only
  // stable accounting boundary for pooled/resumed sessions. The transcript can
  // be replaced during compaction, so a message-array length/usage delta is not
  // a valid per-call counter.
  const statsBefore = snapshotSessionUsage(session);
  const currentUsage = () =>
    usageDelta(statsBefore, snapshotSessionUsage(session));

  const fireProgress = () => {
    if (!onProgress) return;
    const delta = currentUsage().totalTokens;
    try {
      onProgress({
        tokens: delta,
        toolUses,
        durationMs: Date.now() - startTime,
        lastActivityAt,
        activities: [...activities],
        failureKind: signal?.aborted
          ? undefined
          : deadlineExceeded
            ? "deadline_exceeded"
            : stalled
              ? "stalled"
              : undefined,
      });
    } catch (error) {
      console.error("[delegate] progress callback threw; continuing", error);
    }
  };

  const stallError = () =>
    `Stalled: no AgentSession activity for ${fmtDuration(stallTimeoutMs)} while ${stalledPhase ?? phase}; task aborted.`;
  const clearStallWatchdog = () => {
    clearStallDeadline?.();
    clearStallDeadline = undefined;
  };
  const abortForStall = () => {
    if (stalled || signal?.aborted || deadlineExceeded) return;
    stalled = true;
    stalledPhase = phase;
    clearStallWatchdog();
    clearDeadline?.();
    clearDeadline = undefined;
    console.warn(
      `[delegate] stalled subagent detected after ${fmtDuration(stallTimeoutMs)} while ${phase}; requesting cooperative cancellation`,
    );
    // AgentSession.abort() only covers the agent loop. A post-settle manual
    // compaction is idle by that definition, so cancel the other session work
    // explicitly before waiting for the prompt/quiescence barrier to settle.
    requestSessionCancellation("stalled");
    // Surface the transition immediately. Cancellation is cooperative, so the
    // final TaskResult may not arrive until the provider/tool becomes idle.
    fireProgress();
  };
  const armStallWatchdog = (graceMs = 0) => {
    clearStallWatchdog();
    if (!stallTimeoutMs || stalled || signal?.aborted || deadlineExceeded)
      return;

    const grace = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;
    const deadline = Date.now() + stallTimeoutMs + grace;
    clearStallDeadline = scheduleDeadline(deadline, abortForStall);
  };

  const deadlineError = () =>
    formatDeadlineExceededError(deadlineAt ? deadlineAt - startTime : 0);
  const clearDeadlineWatchdog = () => {
    clearDeadline?.();
    clearDeadline = undefined;
  };
  const abortForDeadline = () => {
    if (deadlineExceeded || signal?.aborted) return;
    deadlineExceeded = true;
    clearDeadlineWatchdog();
    clearStallWatchdog();
    console.warn(
      `[delegate] subagent exceeded its wall-clock deadline; requesting cooperative cancellation`,
    );
    requestSessionCancellation("deadline");
    fireProgress();
  };
  const armDeadlineWatchdog = () => {
    clearDeadlineWatchdog();
    if (!deadlineAt || deadlineExceeded || stalled || signal?.aborted) return;
    if (Date.now() >= deadlineAt) {
      abortForDeadline();
      return;
    }
    clearDeadline = scheduleDeadline(deadlineAt, abortForDeadline);
  };

  const noteActivity = (nextPhase: string, graceMs = 0) => {
    lastActivityAt = Date.now();
    phase = nextPhase;
    armStallWatchdog(graceMs);
    fireProgress();
  };

  // AgentSession can replace `session.messages` during compaction. Capture
  // finalized assistant messages from the event stream instead of slicing the
  // mutable transcript after prompt() returns. Keep each low-level attempt as
  // structured data: overflow compaction reports its retry disposition only
  // *after* agent_end, so output cannot be settled permanently at agent_end.
  //
  // The initial array and its prefix are also retained for the narrow fallback
  // below. A Set of initial message objects is not enough: compaction can
  // rebuild historical messages as fresh objects, making them look like new
  // output. New pre-message_end output is still recoverable when the host has
  // appended it to the unchanged transcript.
  const initialMessages = session.messages;
  const initialMessageCount = initialMessages.length;
  const initialMessageSnapshot = initialMessages.slice();
  let compactionInProgress = false;
  let completedCompaction = false;
  const assistantMessagesForAttempt: AgentMessage[] = [];
  let partialAssistantMessage: AgentMessage | undefined;
  type AttemptCapture = {
    eventMessages: AgentMessage[];
    capturedAssistants: AgentMessage[];
    partialAssistant?: AgentMessage;
    /** Set by a retrying agent_end or a later overflow compaction_end. */
    omitFinalAssistant: boolean;
  };
  const settledAttempts: AttemptCapture[] = [];
  let pendingCompactionAttempt: AttemptCapture | undefined;

  const countAssistants = (messages: readonly AgentMessage[]): number =>
    messages.reduce(
      (count, message) => count + (message.role === "assistant" ? 1 : 0),
      0,
    );
  const removeAssistantAt = (
    messages: readonly AgentMessage[],
    assistantOrdinal: number,
  ): AgentMessage[] => {
    if (assistantOrdinal < 0) return [...messages];
    let currentOrdinal = 0;
    for (let index = 0; index < messages.length; index++) {
      if (messages[index]?.role !== "assistant") continue;
      if (currentOrdinal === assistantOrdinal) {
        return messages.filter((_, candidate) => candidate !== index);
      }
      currentOrdinal++;
    }
    return [...messages];
  };
  const renderAttempt = (attempt: AttemptCapture): string => {
    // `agent_end.messages` is authoritative for the low-level attempt. When a
    // retry is requested, remove the final assistant by position. The
    // message_end collection is filtered by the same assistant ordinal rather
    // than object identity: hosts/extensions may clone event payloads.
    const eventAssistantCount = countAssistants(attempt.eventMessages);
    const finalAssistantOrdinal = eventAssistantCount - 1;
    const eventMessages = attempt.omitFinalAssistant
      ? removeAssistantAt(attempt.eventMessages, finalAssistantOrdinal)
      : [...attempt.eventMessages];
    const capturedAssistantCount = countAssistants(attempt.capturedAssistants);
    const capturedOrdinal = attempt.omitFinalAssistant
      ? finalAssistantOrdinal >= 0
        ? finalAssistantOrdinal
        : capturedAssistantCount - 1
      : -1;
    const capturedAssistants = attempt.omitFinalAssistant
      ? removeAssistantAt(attempt.capturedAssistants, capturedOrdinal)
      : [...attempt.capturedAssistants];
    const eventText = extractOutput(eventMessages);
    const capturedText = extractOutput(capturedAssistants);
    const attemptTextWithoutPartial = eventText || capturedText;
    const attemptParts = attemptTextWithoutPartial
      ? [attemptTextWithoutPartial]
      : [];

    // A failed stream can contain useful text that never receives a
    // message_end. If this agent run also contains an earlier successful turn,
    // that turn must not win the `||` chain and hide the newer partial output.
    // Do not retain partial text for a response that will be retried, including
    // the overflow case whose retry disposition arrives at compaction_end.
    const partialText =
      attempt.omitFinalAssistant || !attempt.partialAssistant
        ? ""
        : extractOutput([attempt.partialAssistant]);
    // Avoid duplicating partial output already represented by the authoritative
    // event selection (including when the host copied the message object).
    if (
      partialText &&
      !attemptParts.some(
        (text) => text === partialText || text.includes(partialText),
      )
    ) {
      attemptParts.push(partialText);
    }
    return attemptParts.join("\n\n");
  };
  const rememberPartialAssistant = (message: AgentMessage): void => {
    // AgentSession emits an empty synthetic failure message after a provider
    // throws mid-stream. Do not let that empty message erase useful text from
    // the real, pre-message_end partial response.
    const existingText = partialAssistantMessage
      ? extractOutput([partialAssistantMessage])
      : "";
    const nextText = extractOutput([message]);
    if (nextText || !existingText) partialAssistantMessage = message;
  };
  const finishAttempt = (
    messages: readonly AgentMessage[],
    willRetry: boolean,
  ): void => {
    const attempt: AttemptCapture = {
      eventMessages: [...messages],
      capturedAssistants: [...assistantMessagesForAttempt],
      partialAssistant: partialAssistantMessage,
      omitFinalAssistant: willRetry,
    };
    settledAttempts.push(attempt);
    pendingCompactionAttempt = attempt;
    assistantMessagesForAttempt.length = 0;
    partialAssistantMessage = undefined;
  };
  const capturedOutput = (): string => {
    const parts = settledAttempts.map(renderAttempt).filter(Boolean);
    const currentAttempt = renderAttempt({
      eventMessages: [],
      capturedAssistants: assistantMessagesForAttempt,
      partialAssistant: partialAssistantMessage,
      omitFinalAssistant: false,
    });
    if (currentAttempt) parts.push(currentAttempt);
    const eventOutput = parts.join("\n\n");
    if (eventOutput) return eventOutput;
    // Once an event boundary has been observed, an empty rendered result is
    // meaningful (for example, a sole retrying response was intentionally
    // removed). Do not let the mutable transcript re-introduce that response.
    if (
      settledAttempts.length > 0 ||
      assistantMessagesForAttempt.length > 0 ||
      partialAssistantMessage
    ) {
      return "";
    }

    // Keep an append-only fallback for providers/fakes that reject before
    // emitting message_end. It is deliberately used only when event capture
    // is empty; event capture is authoritative across compaction and retries.
    // An aborted compaction may leave the original append-only transcript
    // untouched. Completed or indeterminate compaction remains fail-closed even
    // if a host happened to preserve the array identity.
    const currentMessages = session.messages;
    if (
      compactionInProgress ||
      completedCompaction ||
      currentMessages !== initialMessages ||
      currentMessages.length < initialMessageCount
    ) {
      return "";
    }
    for (let i = 0; i < initialMessageCount; i++) {
      if (currentMessages[i] !== initialMessageSnapshot[i]) return "";
    }
    return extractOutput(currentMessages.slice(initialMessageCount));
  };

  // Map the AgentSession event union to the renderer's ToolActivity model.
  // Field names line up 1:1 (toolCallId, toolName, args, partialResult,
  // result, isError) — AgentSession forwards the underlying agent events
  // verbatim. Retry and compaction events are handled below; queue/bookkeeping
  // events and thinking changes are intentionally ignored.
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    noteSessionEvent();
    switch (event.type) {
      case "tool_execution_start": {
        const now = Date.now();
        const activity: ToolActivity = {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          startTime: now,
        };
        pendingById.set(event.toolCallId, activity);
        activities.push(activity);
        noteActivity(`executing tool '${event.toolName}'`);
        break;
      }
      case "tool_execution_update": {
        const activity = pendingById.get(event.toolCallId);
        if (activity) {
          const text = extractTextFromPartialResult(event.partialResult);
          if (text !== undefined) activity.liveOutput = text;
        }
        noteActivity(`executing tool '${event.toolName}'`);
        break;
      }
      case "tool_execution_end": {
        const now = Date.now();
        const activity = pendingById.get(event.toolCallId);
        if (activity) {
          activity.result = {
            content: event.result?.content ?? [],
            isError: event.isError,
          };
          activity.endTime = now;
          pendingById.delete(event.toolCallId);
        }
        toolUses++;
        noteActivity("waiting for the next agent turn");
        break;
      }
      case "message_start":
      case "message_update":
        if (event.message?.role === "assistant") {
          rememberPartialAssistant(event.message);
        }
        noteActivity("streaming model output");
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          assistantMessagesForAttempt.push(event.message);
          // Keep a text-bearing partial if the host follows a provider
          // exception with an empty synthetic failure message. A real
          // finalized text response supersedes the partial.
          if (extractOutput([event.message])) {
            partialAssistantMessage = undefined;
          }
        }
        noteActivity("waiting for the next agent turn");
        break;
      case "turn_end":
        noteActivity("waiting for the next agent turn");
        break;
      case "agent_start":
      case "turn_start":
        noteActivity("waiting for model output");
        break;
      case "agent_end":
        finishAttempt(event.messages, event.willRetry);
        noteActivity("finishing agent run");
        break;
      case "agent_settled":
        noteActivity("finishing agent run");
        break;
      case "auto_retry_start":
        // A declared retry delay is intentional silence, not a wedge. Add the
        // delay before ordinary inactivity detection resumes.
        noteActivity("waiting to retry", event.delayMs);
        break;
      case "auto_retry_end": {
        const autoRetry = event as {
          success?: unknown;
        };
        if (autoRetry.success === false && pendingCompactionAttempt) {
          pendingCompactionAttempt.omitFinalAssistant = false;
        }
        noteActivity("waiting for model output");
        break;
      }
      case "compaction_start":
        compactionInProgress = true;
        noteActivity("compacting context");
        break;
      case "compaction_end":
        compactionInProgress = false;
        if (!event.aborted) completedCompaction = true;
        // Context-overflow agent_end is intentionally emitted with
        // willRetry=false because Pi's retry decision belongs to compaction.
        // Only an overflow compaction that actually retries may retract that
        // preceding response. Failed compaction retains its error evidence;
        // threshold compaction never discards a successful answer.
        if (
          event.reason === "overflow" &&
          event.willRetry &&
          pendingCompactionAttempt
        ) {
          pendingCompactionAttempt.omitFinalAssistant = true;
        }
        pendingCompactionAttempt = undefined;
        noteActivity("waiting for model output");
        break;
      default: {
        // Pi 0.83 added summarization-retry and direct-bash progress events.
        // The extension still typechecks against its oldest supported Pi, so
        // recognize this forward-compatible event subset at runtime.
        const compatEvent = event as unknown as {
          type: string;
          delayMs?: unknown;
        };
        if (compatEvent.type === "summarization_retry_scheduled") {
          const delayMs =
            typeof compatEvent.delayMs === "number" ? compatEvent.delayMs : 0;
          noteActivity("waiting to retry summarization", delayMs);
        } else if (
          compatEvent.type === "summarization_retry_attempt_start" ||
          compatEvent.type === "summarization_retry_finished"
        ) {
          noteActivity("summarizing context");
        } else if (compatEvent.type === "bash_execution_update") {
          noteActivity("running bash command");
        }
        // queue_update, entry_appended, session_info_changed, and thinking
        // changes are local bookkeeping, not evidence a blocked operation lives.
        break;
      }
    }
  });

  // Wire the parent abort signal to the session. AgentSession.abort() cancels
  // the in-flight model call, any retry backoff, and waits for idle.
  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      clearStallWatchdog();
      clearDeadlineWatchdog();
      // Fire-and-forget: prompt()/the quiescence barrier observe cancellation
      // and then return the partial evidence that this runner reports.
      requestSessionCancellation("parent-aborted");
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  // The signal may have fired *between* lifecycle's pre-acquire abort check
  // and this listener registration (e.g. during getHostDeps/createAgentSession/
  // git baseline). addEventListener("abort", …, { once }) does NOT fire for an
  // already-aborted signal, so without this re-check a cancelled async ticket
  // can still start a subagent that writes files and gets pooled.
  if (signal?.aborted) {
    abortHandler?.();
    // The early return skips the try/finally below, so clean up the
    // subscription and abort listener here — otherwise they leak on every
    // already-aborted call, which is especially harmful for pooled sessions
    // whose subscription would outlive the task.
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
    unsubscribe();
    return {
      output: "",
      error: "Aborted",
      durationMs: Date.now() - startTime,
      tokens: 0,
      usage: emptyUsage(),
      touchedFiles: [],
      attributedFiles: [],
      prompted: false,
    };
  }

  // If the deadline is already in the past, request cooperative cancellation
  // and wait for the session to settle before returning ownership. Starting a
  // prompt after the deadline would let the session do work without an active
  // deadline watchdog.
  if (deadlineAt && Date.now() >= deadlineAt) {
    abortForDeadline();
    // A pre-prompt deadline still calls session.abort(), so any in-flight
    // compaction or extension work must settle before lifecycle disposes or
    // reuses the session. The same quiescence barrier used after prompt()
    // handles a never-prompted session safely — it just observes idle state.
    //
    // Keep the parent abort listener armed during the quiescence wait. If the
    // parent signal aborts while we are waiting, the runner should report the
    // parent cancellation ("Aborted") rather than the pre-expired deadline.
    await waitForSessionQuiescence();
    clearStallWatchdog();
    clearDeadlineWatchdog();
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
    unsubscribe();
    if (signal?.aborted) {
      return {
        output: "",
        error: "Aborted",
        durationMs: Date.now() - startTime,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
        prompted: false,
      };
    }
    return {
      output: "(no output)",
      error: deadlineError(),
      durationMs: Date.now() - startTime,
      tokens: 0,
      usage: emptyUsage(),
      touchedFiles: [],
      attributedFiles: [],
      failureKind: "deadline_exceeded",
      prompted: false,
    };
  }

  try {
    // Start detection only once the session is ready to receive its prompt;
    // queued delegate tasks never enter this runner and therefore never time out.
    armStallWatchdog();
    armDeadlineWatchdog();
    fireProgress();

    prompted = true;
    await session.prompt(prompt);
    await waitForSessionQuiescence();

    // The model is done; inactivity is no longer the right watchdog. Git
    // evidence collection can take several seconds (up to 5s per git call),
    // so keep the wall-clock deadline armed through it while preventing the
    // stall watchdog from firing on the silent git commands.
    clearStallWatchdog();
    phase = "collecting git evidence";
    lastActivityAt = Date.now();

    const gitAfter = await getGitChangedFiles(config.cwd);
    if (deadlineAt && Date.now() >= deadlineAt && !deadlineExceeded) {
      abortForDeadline();
    }
    clearDeadlineWatchdog();
    // If the deadline or parent abort fired after the first quiescence barrier,
    // including while Git was running, the fire-and-forget
    // cancellation is still unwinding. Wait for the same quiescence barrier so
    // lifecycle does not dispose/reuse the session while compaction or an
    // extension callback is still active.
    if (deadlineExceeded || signal?.aborted) await waitForSessionQuiescence();

    // Recompute evidence after the final quiescence wait. Output, usage,
    // activity-derived touched files, and the session error state can all be
    // mutated by the unwinding work that the barrier just waited for.
    const state = session.state as { errorMessage?: string };
    const output = capturedOutput();
    const usage = currentUsage();
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const fromGit =
      gitBaseline && gitAfter
        ? [...gitAfter].filter((f) => !gitBaseline.has(f))
        : [];
    const touchedFiles = [...new Set([...fromActivities, ...fromGit])];
    const attributedFiles = fromActivities;
    const errorMessage = signal?.aborted
      ? "Aborted"
      : deadlineExceeded
        ? deadlineError()
        : stalled
          ? stallError()
          : state.errorMessage;

    return {
      output: output || "(no output)",
      error: errorMessage,
      durationMs: Date.now() - startTime,
      tokens: usage.totalTokens,
      usage,
      touchedFiles,
      attributedFiles,
      failureKind: signal?.aborted
        ? undefined
        : deadlineExceeded
          ? "deadline_exceeded"
          : stalled
            ? "stalled"
            : undefined,
      prompted,
    };
  } catch (err) {
    // Preserve partial-work evidence: whatever assistant output, token spend,
    // and touched files accumulated before the failure/abort. The touched-file
    // union is still best-effort; any edit/write activity and git-visible
    // changes observed so far are retained. Keep the stall watchdog armed
    // through the quiescence barrier so a busy session that stops emitting
    // events is still rescued; clear it only once the barrier completes.
    await waitForSessionQuiescence();
    clearStallWatchdog();
    phase = "collecting git evidence";
    lastActivityAt = Date.now();

    const gitAfter = await getGitChangedFiles(config.cwd);
    if (deadlineAt && Date.now() >= deadlineAt && !deadlineExceeded) {
      abortForDeadline();
    }
    clearDeadlineWatchdog();
    // If the deadline or parent abort fired after the first quiescence barrier,
    // including while Git was running, the fire-and-forget
    // cancellation is still unwinding. Wait for the same quiescence barrier so
    // lifecycle does not dispose/reuse the session while compaction or an
    // extension callback is still active.
    if (deadlineExceeded || signal?.aborted) await waitForSessionQuiescence();

    // Recompute evidence after the final quiescence wait. Output, usage, and
    // activity-derived touched files can all be mutated by the unwinding work
    // that the barrier just waited for.
    const partialOutput = capturedOutput();
    const usage = currentUsage();
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const fromGit =
      gitBaseline && gitAfter
        ? [...gitAfter].filter((f) => !gitBaseline.has(f))
        : [];
    const touchedFiles = [...new Set([...fromActivities, ...fromGit])];
    const attributedFiles = fromActivities;

    const msg = signal?.aborted
      ? "Aborted"
      : deadlineExceeded
        ? deadlineError()
        : stalled
          ? stallError()
          : err instanceof Error
            ? err.message
            : String(err);
    return {
      output: partialOutput || "(no output)",
      error: msg,
      durationMs: Date.now() - startTime,
      tokens: usage.totalTokens,
      usage,
      touchedFiles,
      attributedFiles,
      failureKind: signal?.aborted
        ? undefined
        : deadlineExceeded
          ? "deadline_exceeded"
          : stalled
            ? "stalled"
            : undefined,
      prompted,
    };
  } finally {
    clearStallWatchdog();
    clearDeadlineWatchdog();
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
    unsubscribe();
  }
}

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getGitChangedFiles,
  extractAttributedFromActivities,
  extractTouchedFromActivities,
  snapshotPhysicalToolTarget,
} from "./file-tracking.ts";
import { extractTextFromPartialResult, extractOutput } from "./utils.ts";
import { snapshotSessionUsage, usageDelta, emptyUsage } from "./usage.ts";
import { getStallTimeoutMs } from "./config.ts";
import { fmtDuration } from "./format.ts";
import { scheduleDeadline } from "./timer.ts";
import {
  createQuiescenceBarrier,
  type CancellationSource,
  type QuiescenceBarrier,
} from "./quiescence.ts";
import { markSessionQuarantined } from "./session-quarantine.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  AgentProgressUpdate,
  TaskFailureKind,
  ToolActivity,
} from "./types.ts";

let quiescenceTimingsForTesting:
  Partial<import("./quiescence.ts").QuiescenceTimings> | undefined;

/** @internal Test-only timings for forcing the bounded abandonment path. */
export function _setRunnerQuiescenceTimingsForTesting(
  timings: Partial<import("./quiescence.ts").QuiescenceTimings> | undefined,
): void {
  quiescenceTimingsForTesting = timings;
}

/** Human-facing error for an expired `deadlineMs` budget.
 *
 * This is exported so the lifecycle pre-check can return the same text as the
 * runner, keeping the sync and (future) async paths consistent. */
export function formatDeadlineExceededError(budgetMs: number): string {
  return `Deadline exceeded: task exceeded its ${fmtDuration(
    Math.max(0, budgetMs),
  )} wall-clock budget and was cooperatively aborted (not a hard kill). Completed writes and commands remain.`;
}

function unionGitEvidence(
  first: Set<string> | undefined,
  second: Set<string> | undefined,
): Set<string> | undefined {
  if (!first) return second;
  if (!second) return first;
  return new Set([...first, ...second]);
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
 *      quiescent before returning ownership to lifecycle (`quiescence.ts`),
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
  /** Dispatch-scoped delegate.json snapshot for the stall timeout. */
  delegateConfig?: import("./config.ts").DelegateConfig,
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
  /** Quiescence was abandoned. All returned accounting and evidence are lower
   * bounds captured before quarantined background work became safe. */
  incomplete?: "quiescence_abandoned";
}> {
  const startTime = start ?? Date.now();
  const stallTimeoutMs = getStallTimeoutMs(delegateConfig);
  let toolUses = 0;
  let lastActivityAt: number | undefined = startTime;
  let phase = "starting agent";
  let stalled = false;
  let stalledPhase: string | undefined;
  let clearStallDeadline: (() => void) | undefined;
  let deadlineExceeded = false;
  let clearDeadline: (() => void) | undefined;
  let prompted = false;
  let cancellationDispatched = false;
  let promptSettled = false;
  let promptSettlement:
    | Promise<
        | { status: "not_started" | "fulfilled" }
        | { status: "rejected"; error: unknown }
      >
    | undefined;
  const currentCancellationSource = (): CancellationSource | undefined => {
    if (signal?.aborted) return "parent-aborted";
    if (deadlineExceeded) return "deadline";
    if (stalled) return "stalled";
    return undefined;
  };
  let recoveryBarrier: QuiescenceBarrier | undefined;
  let abandonmentSafety: Promise<void> | undefined;
  let unsubscribeFull: (() => void) | undefined;
  let unsubscribeRecovery: (() => void) | undefined;
  const safeLog = (message: string, error?: unknown): void => {
    try {
      console.error(message, error);
    } catch {
      // Recovery and listener cleanup must never create an unhandled failure.
    }
  };
  const removeFullListener = (): void => {
    const remove = unsubscribeFull;
    unsubscribeFull = undefined;
    try {
      remove?.();
    } catch (error) {
      safeLog("[delegate] full AgentSession listener cleanup failed", error);
    }
  };
  const removeRecoveryListener = (): void => {
    const remove = unsubscribeRecovery;
    unsubscribeRecovery = undefined;
    try {
      remove?.();
    } catch (error) {
      safeLog(
        "[delegate] recovery AgentSession listener cleanup failed",
        error,
      );
    }
  };
  const activities: ToolActivity[] = [];
  const pendingById = new Map<string, ToolActivity>();
  let notifyCancellationRequested!: () => void;
  const cancellationRequested = new Promise<void>((resolve) => {
    notifyCancellationRequested = resolve;
  });

  // AgentSession.prompt() can return while an agent_settled extension callback
  // is still running fire-and-forget work through ctx.compact(). The barrier
  // owns the "is the session really done?" reasoning; see quiescence.ts for
  // why it cannot be answered deterministically against today's host.
  const barrier = createQuiescenceBarrier({
    session,
    timings: quiescenceTimingsForTesting,
    cancellation: currentCancellationSource,
    cancel: (source) => requestSessionCancellation(source),
  });
  // Once the bounded cancelled unwind gives up, do not start another full
  // unwind budget later in the same runner. The session may still be active,
  // but cancellation has an explicit terminal path instead of repeatedly
  // waiting on work that the host cannot prove has stopped.
  let sessionAbandoned = false;
  let startAbandonedRecovery!: (source: CancellationSource) => Promise<void>;
  const quarantineSession = (source: CancellationSource): void => {
    if (sessionAbandoned) return;
    sessionAbandoned = true;
    abandonmentSafety ??= startAbandonedRecovery(source);
  };
  const waitForSessionQuiescence = async () => {
    if (sessionAbandoned) return "abandoned" as const;
    const outcome = await barrier.wait();
    if (outcome === "abandoned") {
      quarantineSession(currentCancellationSource() ?? "stalled");
    }
    return outcome;
  };

  const requestSessionCancellation = (source: CancellationSource): void => {
    cancellationDispatched = true;
    const logFailure = (operation: string, error: unknown) => {
      safeLog(`[delegate] ${source} subagent ${operation} failed`, error);
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
    barrier.noteEvent();
    // Fire the abort before recording the cancellation point. session.abort()
    // may synchronously emit events (e.g. a final message_update as the stream
    // unwinds); recording after the call attributes those to the abort, so the
    // barrier's re-abort check doesn't loop on the abort's own events.
    try {
      void session.abort().catch((error: unknown) => {
        logFailure("agent cancellation", error);
      });
    } catch (error) {
      // Some host fakes/versions can throw before returning the abort promise.
      // Continue recording cancellation so the quarantine path still engages.
      logFailure("agent cancellation", error);
    }
    // Any session event after this point means new work started despite the
    // abort (e.g. a continuation prompt from an extension's onComplete
    // callback delayed by async auth). The barrier re-aborts it rather than
    // letting it mutate files after the task is considered cancelled.
    barrier.noteCancellationRequested();
    // Wake the prompt race only after every cooperative cancellation request
    // has been dispatched and the barrier knows its cancellation generation.
    notifyCancellationRequested();
  };

  startAbandonedRecovery = (source) => {
    safeLog(
      `[delegate] QUARANTINING ${source} AgentSession after quiescence abandonment; it will not be reused, disposed, or have its workspace cleaned until background termination confirms safety`,
    );

    try {
      recoveryBarrier = createQuiescenceBarrier({
        session,
        cancellation: () => source,
        // Recovery is deliberately unbounded. If the host never proves safety,
        // the quarantine and its workspace live forever rather than racing work.
        timings: { cancelledUnwindBudgetMs: Number.POSITIVE_INFINITY },
        // A permanent quarantine is an intentional leak, not a reason to keep a
        // headless Node process alive forever on its liveness probe.
        unrefTimers: true,
        cancel: (nextSource) => {
          requestSessionCancellation(nextSource);
          recoveryBarrier?.noteCancellationRequested();
        },
        onAbandon: () => {
          // Infinity above makes this unreachable; keep fail-closed semantics if
          // timing arithmetic ever changes.
        },
      });

      // Freeze user-visible output/progress at the terminal result boundary.
      // Recovery needs only event generation; retaining the full listener
      // would mutate returned evidence and emit stale terminal progress.
      unsubscribeRecovery = session.subscribe(() =>
        recoveryBarrier?.noteEvent(),
      );
      removeFullListener();

      requestSessionCancellation(source);
      recoveryBarrier.noteCancellationRequested();
    } catch (error) {
      removeFullListener();
      removeRecoveryListener();
      safeLog(
        `[delegate] quarantined ${source} AgentSession recovery setup failed; retaining session and workspace indefinitely`,
        error,
      );
      return new Promise<void>(() => {});
    }

    const recovery = (async () => {
      // Keep actively re-aborting while an ignored prompt/provider call winds
      // down. A first quiet observation is not enough if prompt() itself is
      // unresolved; after it settles, require a fresh quiet window.
      await Promise.all([
        promptSettlement ?? Promise.resolve({ status: "not_started" as const }),
        recoveryBarrier!.wait(),
      ]);
      await recoveryBarrier!.wait();
      safeLog(
        `[delegate] quarantined ${source} AgentSession is now quiescent; deferred disposal and workspace cleanup may proceed`,
      );
      removeRecoveryListener();
    })().catch((error) => {
      safeLog(
        `[delegate] quarantined ${source} AgentSession background termination failed; retaining session and workspace indefinitely`,
        error,
      );
      // Never resolve safety after an observer failure: leaking is safer than
      // allowing disposal or filesystem teardown to race unknown live work.
      return new Promise<void>(() => {});
    });
    return recovery;
  };

  const finishResult = <T extends object>(
    result: T,
  ): T & { incomplete?: "quiescence_abandoned" } => {
    if (!abandonmentSafety) return result;
    return markSessionQuarantined(
      { ...result, incomplete: "quiescence_abandoned" as const },
      { safe: abandonmentSafety },
    );
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
      const cancellationSource = currentCancellationSource();
      onProgress({
        tokens: delta,
        toolUses,
        durationMs: Date.now() - startTime,
        lastActivityAt,
        activities: [...activities],
        failureKind:
          cancellationSource === "deadline"
            ? "deadline_exceeded"
            : cancellationSource === "stalled"
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
  unsubscribeFull = session.subscribe((event: AgentSessionEvent) => {
    barrier.noteEvent();
    recoveryBarrier?.noteEvent();
    switch (event.type) {
      case "tool_execution_start": {
        const now = Date.now();
        const activity: ToolActivity = {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          startTime: now,
        };
        if (event.toolName === "edit" || event.toolName === "write") {
          // AgentSession emits this boundary synchronously before invoking the
          // tool. Capture the physical target now: after execution a tool can
          // delete or retarget the symlink it wrote through.
          activity.physicalTarget = snapshotPhysicalToolTarget(
            activity,
            config.cwd,
          );
        }
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
    // A pooled session can still have extension-started work even though this
    // runner never prompts it. Use the same bounded cancelled unwind as every
    // other cancellation path before returning ownership.
    await waitForSessionQuiescence();
    // The early return skips the try/finally below. The abandonment path has
    // already replaced the full listener with its minimal recovery listener.
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
    removeFullListener();
    return finishResult({
      output: "",
      error: "Aborted",
      durationMs: Date.now() - startTime,
      tokens: 0,
      usage: emptyUsage(),
      touchedFiles: [],
      attributedFiles: [],
      prompted: false,
    });
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
    removeFullListener();
    if (signal?.aborted) {
      return finishResult({
        output: "",
        error: "Aborted",
        durationMs: Date.now() - startTime,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
        prompted: false,
      });
    }
    return finishResult({
      output: "(no output)",
      error: deadlineError(),
      durationMs: Date.now() - startTime,
      tokens: 0,
      usage: emptyUsage(),
      touchedFiles: [],
      attributedFiles: [],
      failureKind: "deadline_exceeded" as const,
      prompted: false,
    });
  }

  try {
    // Start detection only once the session is ready to receive its prompt;
    // queued delegate tasks never enter this runner and therefore never time out.
    armStallWatchdog();
    armDeadlineWatchdog();
    fireProgress();

    // AgentSession.abort() normally settles prompt(), but providers/tools can
    // ignore cancellation and leave that promise pending forever. Race prompt
    // settlement against cancellation, then use the barrier's bounded unwind.
    // Prompt start is queued, so a cancellation dispatched in that window must be checked
    // again inside the queued callback; otherwise the runner can return while
    // that callback starts a newly cancelled prompt. Rejections are converted
    // to data so a late rejection after abandonment cannot become an unhandled
    // promise rejection.
    promptSettlement = Promise.resolve()
      .then(async () => {
        if (cancellationDispatched) return { status: "not_started" as const };
        prompted = true;
        try {
          await session.prompt(prompt);
          return { status: "fulfilled" as const };
        } catch (error) {
          return { status: "rejected" as const, error };
        }
      })
      .then((outcome) => {
        promptSettled = true;
        return outcome;
      });
    const promptOutcome = await Promise.race([
      promptSettlement,
      cancellationRequested.then(() => ({ status: "cancelled" as const })),
    ]);
    if (promptOutcome.status === "rejected") throw promptOutcome.error;
    await waitForSessionQuiescence();
    if (promptOutcome.status === "cancelled" && !promptSettled) {
      // isIdle/quiescence can lie while a provider/tool keeps prompt() pending.
      // Returning that object to lifecycle would permit reuse or disposal while
      // ignored work still owns it, so force the existing quarantine recovery.
      quarantineSession(currentCancellationSource() ?? "stalled");
    }

    // The model is done; inactivity is no longer the right watchdog. Git
    // evidence collection can take several seconds (up to 5s per git call),
    // so keep the wall-clock deadline armed through it while preventing the
    // stall watchdog from firing on the silent git commands.
    clearStallWatchdog();
    phase = "collecting git evidence";
    lastActivityAt = Date.now();

    let gitAfter = await getGitChangedFiles(config.cwd);
    if (deadlineAt && Date.now() >= deadlineAt && !deadlineExceeded) {
      abortForDeadline();
    }
    clearDeadlineWatchdog();
    // If the deadline or parent abort fired after the first quiescence barrier,
    // including while Git was running, the fire-and-forget
    // cancellation is still unwinding. Wait for the same quiescence barrier so
    // lifecycle does not dispose/reuse the session while compaction or an
    // extension callback is still active.
    if (currentCancellationSource()) {
      await waitForSessionQuiescence();
      // Cancellation unwind can mutate files after the first Git snapshot.
      // Recollect only after the final bounded quiescence decision and union
      // both observations: a later failure or reverted file must not erase
      // evidence already observed before the unwind settled.
      gitAfter = unionGitEvidence(
        gitAfter,
        await getGitChangedFiles(config.cwd),
      );
    }

    // Recompute evidence after the final quiescence wait. Output, usage,
    // activity-derived touched files, and the session error state can all be
    // mutated by the unwinding work that the barrier just waited for.
    const state = session.state as { errorMessage?: string };
    const output = capturedOutput();
    const usage = currentUsage();
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const attributedFiles = extractAttributedFromActivities(
      activities,
      config.cwd,
    );
    const fromGit =
      gitBaseline && gitAfter
        ? [...gitAfter].filter((f) => !gitBaseline.has(f))
        : [];
    const touchedFiles = [
      ...new Set([...fromActivities, ...attributedFiles, ...fromGit]),
    ];
    const cancellationSource = currentCancellationSource();
    const errorMessage =
      cancellationSource === "parent-aborted"
        ? "Aborted"
        : cancellationSource === "deadline"
          ? deadlineError()
          : cancellationSource === "stalled"
            ? stallError()
            : state.errorMessage;

    return finishResult({
      output: output || "(no output)",
      error: errorMessage,
      durationMs: Date.now() - startTime,
      tokens: usage.totalTokens,
      usage,
      touchedFiles,
      attributedFiles,
      failureKind:
        cancellationSource === "deadline"
          ? "deadline_exceeded"
          : cancellationSource === "stalled"
            ? "stalled"
            : undefined,
      prompted,
    });
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

    let gitAfter = await getGitChangedFiles(config.cwd);
    if (deadlineAt && Date.now() >= deadlineAt && !deadlineExceeded) {
      abortForDeadline();
    }
    clearDeadlineWatchdog();
    // If the deadline or parent abort fired after the first quiescence barrier,
    // including while Git was running, the fire-and-forget
    // cancellation is still unwinding. Wait for the same quiescence barrier so
    // lifecycle does not dispose/reuse the session while compaction or an
    // extension callback is still active.
    if (currentCancellationSource()) {
      await waitForSessionQuiescence();
      // As in the success path, the unwind itself can change Git-visible
      // files. Preserve the first observation if recollection fails and union
      // both successful observations so transient changes remain evidence.
      gitAfter = unionGitEvidence(
        gitAfter,
        await getGitChangedFiles(config.cwd),
      );
    }

    // Recompute evidence after the final quiescence wait. Output, usage, and
    // activity-derived touched files can all be mutated by the unwinding work
    // that the barrier just waited for.
    const partialOutput = capturedOutput();
    const usage = currentUsage();
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const attributedFiles = extractAttributedFromActivities(
      activities,
      config.cwd,
    );
    const fromGit =
      gitBaseline && gitAfter
        ? [...gitAfter].filter((f) => !gitBaseline.has(f))
        : [];
    const touchedFiles = [
      ...new Set([...fromActivities, ...attributedFiles, ...fromGit]),
    ];

    const cancellationSource = currentCancellationSource();
    const msg =
      cancellationSource === "parent-aborted"
        ? "Aborted"
        : cancellationSource === "deadline"
          ? deadlineError()
          : cancellationSource === "stalled"
            ? stallError()
            : err instanceof Error
              ? err.message
              : String(err);
    return finishResult({
      output: partialOutput || "(no output)",
      error: msg,
      durationMs: Date.now() - startTime,
      tokens: usage.totalTokens,
      usage,
      touchedFiles,
      attributedFiles,
      failureKind:
        cancellationSource === "deadline"
          ? "deadline_exceeded"
          : cancellationSource === "stalled"
            ? "stalled"
            : undefined,
      prompted,
    });
  } finally {
    clearStallWatchdog();
    clearDeadlineWatchdog();
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
    removeFullListener();
  }
}

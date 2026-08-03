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
  gitBaseline: Set<string>,
  start: number,
): Promise<{
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
  usage: Usage;
  touchedFiles: string[];
  failureKind?: TaskFailureKind;
}> {
  const startTime = start ?? Date.now();
  const stallTimeoutMs = getStallTimeoutMs();
  let toolUses = 0;
  let lastActivityAt: number | undefined = startTime;
  let phase = "starting agent";
  let stalled = false;
  let stalledPhase: string | undefined;
  let clearStallDeadline: (() => void) | undefined;
  const activities: ToolActivity[] = [];
  const pendingById = new Map<string, ToolActivity>();
  let sessionEventGeneration = 0;
  let wakeSessionEvent: (() => void) | undefined;

  // AgentSession.prompt() can return while an agent_settled extension callback
  // is still running fire-and-forget work through ctx.compact(). Keep a small
  // internal event seam so the runner can wait without polling throughout a
  // potentially long remote compaction. The generation closes the race between
  // checking session state and installing the next waiter.
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
    source: "parent-aborted" | "stalled",
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
    void session.abort().catch((error: unknown) => {
      logFailure("agent cancellation", error);
    });
  };

  /**
   * Wait until the session is idle and non-compacting for two unchanged event
   * loop turns. The quiet turns are significant: AgentSession emits
   * compaction_end before ctx.compact's onComplete/onError callback runs, and a
   * successful callback may immediately start a continuation prompt.
   */
  const waitForSessionQuiescence = async (): Promise<void> => {
    let quietTurns = 0;
    while (quietTurns < 2) {
      const generation = sessionEventGeneration;
      await nextEventLoopTurn();

      const idle = session.isIdle && !session.isCompacting;
      if (idle && sessionEventGeneration === generation) {
        quietTurns++;
        continue;
      }

      quietTurns = 0;
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
    onProgress({
      tokens: delta,
      toolUses,
      durationMs: Date.now() - startTime,
      lastActivityAt,
      activities: [...activities],
      failureKind: stalled ? "stalled" : undefined,
    });
  };

  const stallError = () =>
    `Stalled: no AgentSession activity for ${fmtDuration(stallTimeoutMs)} while ${stalledPhase ?? phase}; task aborted.`;
  const clearStallWatchdog = () => {
    clearStallDeadline?.();
    clearStallDeadline = undefined;
  };
  const abortForStall = () => {
    if (stalled || signal?.aborted) return;
    stalled = true;
    stalledPhase = phase;
    clearStallWatchdog();
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
    if (!stallTimeoutMs || stalled || signal?.aborted) return;

    const grace = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;
    const deadline = Date.now() + stallTimeoutMs + grace;
    clearStallDeadline = scheduleDeadline(deadline, abortForStall);
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
  let transcriptMayHaveBeenReplaced = false;
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
    // Requiring the original array and unchanged historical prefix prevents a
    // replacement/compaction transcript from leaking old assistant output.
    const currentMessages = session.messages;
    if (
      transcriptMayHaveBeenReplaced ||
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
      case "auto_retry_end":
        noteActivity("waiting for model output");
        break;
      case "compaction_start":
        // Even if a host mutates the transcript in place rather than replacing
        // its array, historical messages are no longer a safe fallback source.
        transcriptMayHaveBeenReplaced = true;
        noteActivity("compacting context");
        break;
      case "compaction_end":
        transcriptMayHaveBeenReplaced = true;
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
    return {
      output: "",
      error: "Aborted",
      durationMs: Date.now() - startTime,
      tokens: 0,
      usage: emptyUsage(),
      touchedFiles: [],
    };
  }

  // Start detection only once the session is ready to receive its prompt;
  // queued delegate tasks never enter this runner and therefore never time out.
  armStallWatchdog();
  fireProgress();

  try {
    await session.prompt(prompt);
    await waitForSessionQuiescence();
    clearStallWatchdog();

    const state = session.state as { errorMessage?: string };
    const output = capturedOutput();
    const usage = currentUsage();

    // Compute touched files: union of activity-based (edit/write) and git diff
    // against the pre-prompt baseline. Independent of the runner's event model.
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const gitAfter = await getGitChangedFiles(config.cwd);
    const fromGit = [...gitAfter].filter((f) => !gitBaseline.has(f));
    const touchedFiles = [...new Set([...fromActivities, ...fromGit])];
    const errorMessage = stalled
      ? stallError()
      : signal?.aborted
        ? "Aborted"
        : state.errorMessage;

    return {
      output: output || "(no output)",
      error: errorMessage,
      durationMs: Date.now() - startTime,
      tokens: usage.totalTokens,
      usage,
      touchedFiles,
      failureKind: stalled ? "stalled" : undefined,
    };
  } catch (err) {
    // Preserve partial-work evidence: whatever assistant output, token spend,
    // and touched files accumulated before the failure/abort.
    const partialOutput = capturedOutput();
    const usage = currentUsage();

    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const gitAfter = await getGitChangedFiles(config.cwd);
    const fromGit = [...gitAfter].filter((f) => !gitBaseline.has(f));
    const touchedFiles = [...new Set([...fromActivities, ...fromGit])];

    const msg = stalled
      ? stallError()
      : signal?.aborted
        ? "Aborted"
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
      failureKind: stalled ? "stalled" : undefined,
    };
  } finally {
    clearStallWatchdog();
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
    unsubscribe();
  }
}

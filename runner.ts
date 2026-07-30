import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getGitChangedFiles,
  extractTouchedFromActivities,
} from "./file-tracking.ts";
import {
  extractTextFromPartialResult,
  extractOutput,
  extractUsage,
} from "./utils.ts";
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
 *   3. snapshots usage before/after the prompt for token delta accounting, and
 *   4. computes touched files from activity + git diff.
 *
 * Output/errors are read from `session.messages` / `session.state` after the
 * prompt resolves; AgentSession's internal retry means a transient mid-loop
 * error no longer hard-fails a task whose work is already done.
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

  // Snapshot usage before the prompt so we can report only the tokens consumed
  // by this call (not cumulative history on a pooled/resumed session).
  const usageBeforeTotal = extractUsage(session.messages).total;
  // Cumulative session stats (cover compacted-away history) feed the full
  // provider Usage reported up to the parent's session-total accounting.
  const statsBefore = snapshotSessionUsage(session);

  const fireProgress = () => {
    if (!onProgress) return;
    const usage = extractUsage(session.messages);
    const delta = Math.max(0, usage.total - usageBeforeTotal);
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
    // AgentSession.abort() is the upstream cancellation primitive. It waits
    // for idle, so the prompt below remains responsible for preserving the
    // final partial-output/session evidence after cancellation settles.
    void session.abort().catch((error: unknown) => {
      console.error("[delegate] stalled subagent abort failed", error);
    });
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

  // Map the AgentSession event union to the renderer's ToolActivity model.
  // Field names line up 1:1 (toolCallId, toolName, args, partialResult,
  // result, isError) — AgentSession forwards the underlying agent events
  // verbatim. Retry and compaction events are handled below; queue/bookkeeping
  // events and thinking changes are intentionally ignored.
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
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
        noteActivity("streaming model output");
        break;
      case "message_end":
      case "turn_end":
        noteActivity("waiting for the next agent turn");
        break;
      case "agent_start":
      case "turn_start":
        noteActivity("waiting for model output");
        break;
      case "agent_end":
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
        noteActivity("compacting context");
        break;
      case "compaction_end":
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
      // Fire-and-forget: prompt() observes AgentSession's abort and then
      // returns the partial evidence that this runner reports to the caller.
      void session.abort().catch((error: unknown) => {
        console.error(
          "[delegate] parent-aborted subagent cleanup failed",
          error,
        );
      });
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

  // Remember how many messages existed before the prompt so we can extract
  // only the new assistant output (not cumulative history) on both success and
  // abort/failure paths.
  const messagesBefore = session.messages.length;

  try {
    await session.prompt(prompt);
    clearStallWatchdog();

    const messages = session.messages;
    const state = session.state as { errorMessage?: string };
    const output = extractOutput(messages.slice(messagesBefore));
    const usageAfterTotal = extractUsage(messages).total;
    const tokensThisCall = Math.max(0, usageAfterTotal - usageBeforeTotal);
    const usage = usageDelta(statsBefore, snapshotSessionUsage(session));

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
      tokens: tokensThisCall,
      usage,
      touchedFiles,
      failureKind: stalled ? "stalled" : undefined,
    };
  } catch (err) {
    // Preserve partial-work evidence: whatever assistant output, token spend,
    // and touched files accumulated before the failure/abort.
    const messages = session.messages;
    const partialOutput = extractOutput(messages.slice(messagesBefore));
    const usageAfterTotal = extractUsage(messages).total;
    const tokensThisCall = Math.max(0, usageAfterTotal - usageBeforeTotal);
    const usage = usageDelta(statsBefore, snapshotSessionUsage(session));

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
      tokens: tokensThisCall,
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

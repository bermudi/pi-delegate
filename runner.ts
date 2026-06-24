import type {
  AgentSession,
  AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import {
  getGitChangedFiles,
  extractTouchedFromActivities,
} from "./file-tracking.ts";
import {
  extractTextFromPartialResult,
  extractOutput,
  extractUsage,
} from "./utils.ts";
import type { AgentProgressUpdate, ToolActivity } from "./types.ts";

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
  touchedFiles: string[];
}> {
  const startTime = start || Date.now();
  let toolUses = 0;
  let lastActivityAt: number | undefined;
  const activities: ToolActivity[] = [];
  const pendingById = new Map<string, ToolActivity>();

  // Snapshot usage before the prompt so we can report only the tokens consumed
  // by this call (not cumulative history on a pooled/resumed session).
  const usageBeforeTotal = extractUsage(session.messages).total;

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
    });
  };

  // Map the AgentSession event union to the renderer's ToolActivity model.
  // Field names line up 1:1 (toolCallId, toolName, args, partialResult,
  // result, isError) — AgentSession forwards the underlying agent events
  // verbatim, plus its own retry/compaction/queue events (ignored here).
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "tool_execution_start": {
        const now = Date.now();
        lastActivityAt = now;
        const activity: ToolActivity = {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          startTime: now,
        };
        pendingById.set(event.toolCallId, activity);
        activities.push(activity);
        fireProgress();
        break;
      }
      case "tool_execution_update": {
        lastActivityAt = Date.now();
        const activity = pendingById.get(event.toolCallId);
        if (activity) {
          const text = extractTextFromPartialResult(event.partialResult);
          if (text !== undefined) activity.liveOutput = text;
          fireProgress();
        }
        break;
      }
      case "tool_execution_end": {
        const now = Date.now();
        lastActivityAt = now;
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
        fireProgress();
        break;
      }
      case "message_end": {
        lastActivityAt = Date.now();
        fireProgress();
        break;
      }
      default:
        // auto_retry_start/end, compaction_*, queue_update, session_info_changed,
        // thinking_level_changed — not surfaced to the renderer's progress model.
        break;
    }
  });

  // Wire the parent abort signal to the session. AgentSession.abort() cancels
  // the in-flight model call, any retry backoff, and waits for idle.
  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      // Fire-and-forget: abort() is async; we don't need to await it here.
      void session.abort().catch(() => {
        /* best effort */
      });
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    // Remember how many messages existed before the prompt so we can extract
    // only the new assistant output (not cumulative history).
    const messagesBefore = session.messages.length;

    await session.prompt(prompt);

    const messages = session.messages;
    const state = session.state as { errorMessage?: string };
    const errorMessage = state.errorMessage;
    const output = extractOutput(messages.slice(messagesBefore));
    const usageAfterTotal = extractUsage(messages).total;
    const tokensThisCall = Math.max(0, usageAfterTotal - usageBeforeTotal);

    // Compute touched files: union of activity-based (edit/write) and git diff
    // against the pre-prompt baseline. Independent of the runner's event model.
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const gitAfter = await getGitChangedFiles(config.cwd);
    const fromGit = [...gitAfter].filter((f) => !gitBaseline.has(f));
    const touchedFiles = [...new Set([...fromActivities, ...fromGit])];

    return {
      output: output || "(no output)",
      error: errorMessage,
      durationMs: Date.now() - startTime,
      tokens: tokensThisCall,
      touchedFiles,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: "",
      error: msg,
      durationMs: Date.now() - startTime,
      tokens: 0,
      touchedFiles: [],
    };
  } finally {
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
    unsubscribe();
  }
}

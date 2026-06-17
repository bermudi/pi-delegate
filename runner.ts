import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import { type Api, type Model, streamSimple } from "@mariozechner/pi-ai";
import {
  convertToLlm,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { TOOL_FACTORIES } from "./tools.ts";
import {
  getGitChangedFiles,
  extractTouchedFromActivities,
} from "./file-tracking.ts";
import {
  isRetryableError,
  isRateLimitError,
  computeRetryDelay,
  sleepWithAbort,
  AbortError,
} from "./retry.ts";
import {
  extractOutput,
  extractTextFromPartialResult,
  extractUsage,
} from "./utils.ts";
import type {
  AgentProgressUpdate,
  AgentRunConfig,
  SessionManagerLike,
  ToolActivity,
} from "./types.ts";

let __retryBaseMsOverride: number | undefined;

/** Test-only: override the default retryBaseMs for all runAgent calls.
 *  Lets test suites shrink backoff without real-clock sleeps. Pass undefined
 *  to reset. No effect in production code — only runAgent consults this. */
export function setRetryBaseMsForTesting(ms?: number): void {
  __retryBaseMsOverride = ms;
}

export function createAgent(
  config: AgentRunConfig,
  modelRegistry: ModelRegistry,
  messages?: AgentMessage[],
): Agent {
  const tools = config.tools
    .map((name) => TOOL_FACTORIES[name]?.(config.cwd))
    .filter(Boolean) as AgentTool[];
  return new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model: config.model,
      thinkingLevel: config.thinking,
      tools,
      ...(messages ? { messages } : {}),
    },
    convertToLlm,
    streamFn: async (m, context, options) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(m);
      if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
      return streamSimple(m, context, {
        ...options,
        apiKey: auth.apiKey,
        headers: auth.headers ?? undefined,
      });
    },
  });
}

export async function runAgentOnce(
  agent: Agent,
  prompt: string,
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  },
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
  onProgress?: (update: AgentProgressUpdate) => void,
  sessionManager?: SessionManagerLike,
  gitBaseline?: Set<string>,
  start?: number,
  suppressSessionAppend = false,
): Promise<{
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
  touchedFiles: string[];
}> {
  const startTime = start ?? Date.now();
  const baseline = gitBaseline ?? new Set<string>();
  let toolUses = 0;
  let lastActivityAt: number | undefined;
  const activities: ToolActivity[] = [];
  const pendingById = new Map<string, ToolActivity>();
  let usageBeforeTotal = 0;

  const fireProgress = () => {
    if (!onProgress) return;
    const usage = extractUsage(agent.state.messages);
    const delta = Math.max(0, usage.total - usageBeforeTotal);
    onProgress({
      tokens: delta,
      toolUses,
      durationMs: Date.now() - startTime,
      lastActivityAt,
      activities: [...activities],
    });
  };

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
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
    } else if (event.type === "tool_execution_update") {
      lastActivityAt = Date.now();
      const activity = pendingById.get(event.toolCallId);
      if (activity) {
        const text = extractTextFromPartialResult(event.partialResult);
        if (text !== undefined) activity.liveOutput = text;
        fireProgress();
      }
    } else if (event.type === "tool_execution_end") {
      lastActivityAt = Date.now();
      const activity = pendingById.get(event.toolCallId);
      if (activity) {
        activity.result = {
          content: event.result?.content ?? [],
          isError: event.isError,
        };
        activity.endTime = lastActivityAt;
        pendingById.delete(event.toolCallId);
      }
      toolUses++;
      fireProgress();
    } else if (event.type === "message_end") {
      lastActivityAt = Date.now();
      fireProgress();
    }
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      try {
        agent.abort();
      } catch {
        /* */
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    // Snapshot state before prompt for delta-based persistence and token counting.
    const messagesBefore = agent.state.messages.length;
    const usageBefore = extractUsage(agent.state.messages);
    usageBeforeTotal = usageBefore.total;

    await agent.prompt(prompt);
    await agent.waitForIdle();

    const state = agent.state as {
      messages: AgentMessage[];
      errorMessage?: string;
    };
    const errorMessage = state.errorMessage;
    // Extract only the new output from this prompt (not cumulative history).
    const output = extractOutput(state.messages.slice(messagesBefore));
    const usageAfter = extractUsage(state.messages);
    const tokensThisCall = usageAfter.total - usageBeforeTotal;

    // Persist only the new messages added by this prompt (avoids duplication on pool reuse).
    // When retrying, we defer this flush so failed attempts don't pollute the session file.
    if (sessionManager && !suppressSessionAppend) {
      try {
        for (let mi = messagesBefore; mi < state.messages.length; mi++) {
          const msg = state.messages[mi]!;
          if (
            msg.role === "user" ||
            msg.role === "assistant" ||
            msg.role === "toolResult" ||
            msg.role === "custom"
          ) {
            sessionManager.appendMessage?.(msg);
          }
        }
      } catch {
        /* best effort */
      }
    }

    // Compute touched files: union of activity-based (edit/write) and git diff.
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const gitAfter = await getGitChangedFiles(config.cwd);
    const fromGit = [...gitAfter].filter((f) => !baseline.has(f));
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

export async function runAgent(
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  },
  prompt: string,
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
  onProgress?: (update: AgentProgressUpdate) => void,
  sessionManager?: SessionManagerLike,
  maxRetries = 3,
  retryBaseMs = 2000,
  /** Pre-existing agent. When provided AND allowRetry=false, skips creation and retry — runs once (pool hits). */
  existingAgent?: Agent,
  /** When true, existingAgent is a resumed session — safe to retry on transient errors. */
  allowRetry = false,
  /** Task index within a concurrent delegate batch. Used to stagger retries across tasks. */
  taskIndex = 0,
): Promise<{
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
  touchedFiles: string[];
}> {
  const start = Date.now();

  // Snapshot git status before the agent starts so we can diff after.
  const gitBaseline = await getGitChangedFiles(config.cwd);

  // Pool hits: single attempt, no retry loop (stateful agent with accumulated context).
  // Resumed agents (allowRetry=true) fall through to the retry loop.
  if (existingAgent && !allowRetry) {
    return runAgentOnce(
      existingAgent,
      prompt,
      config,
      modelRegistry,
      signal,
      onProgress,
      sessionManager,
      gitBaseline,
      start,
    );
  }

  // Create agent once — reuse across retries to preserve prior work (tool results, reasoning).
  // Fresh agents start empty; resumed/pooled agents start with loaded state.
  let agent: Agent;
  if (existingAgent) {
    agent = existingAgent;
  } else {
    agent = createAgent(config, modelRegistry);
  }

  // Snapshot messages before any attempts — used to restore clean state on retry.
  // The Agent's messages setter is a public API that copies the array, so this
  // avoids poking at internals (unlike the old .length mutation approach).
  const messagesSnapshot = [...agent.state.messages];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return {
        output: "",
        error: "Aborted",
        durationMs: Date.now() - start,
        tokens: 0,
        touchedFiles: [],
      };
    }

    // Signal retry to the progress UI.
    if (attempt > 0 && onProgress)
      onProgress({
        tokens: 0,
        toolUses: 0,
        durationMs: Date.now() - start,
        activities: [],
      });

    // On retry, restore messages to pre-attempt state using the public setter.
    if (attempt > 0) {
      agent.state.messages = messagesSnapshot;
    }

    const messagesBeforeAttempt = agent.state.messages.length;
    const result = await runAgentOnce(
      agent,
      prompt,
      config,
      modelRegistry,
      signal,
      onProgress,
      sessionManager,
      gitBaseline,
      start,
      true,
    );
    if (
      result.error &&
      attempt < maxRetries &&
      isRetryableError(result.error)
    ) {
      const isRateLimit = isRateLimitError(result.error);
      const { delay } = computeRetryDelay(
        attempt,
        __retryBaseMsOverride ?? retryBaseMs,
        taskIndex,
        isRateLimit,
      );

      try {
        await sleepWithAbort(delay, signal);
      } catch (sleepErr) {
        if (!(sleepErr instanceof AbortError)) throw sleepErr;
      }
      continue;
    }

    // Flush pending messages only on success. Failed attempts (even the final
    // exhausted retry) should not pollute the session file.
    if (sessionManager && !result.error) {
      try {
        for (
          let mi = messagesBeforeAttempt;
          mi < agent.state.messages.length;
          mi++
        ) {
          const msg = agent.state.messages[mi]!;
          if (
            msg.role === "user" ||
            msg.role === "assistant" ||
            msg.role === "toolResult" ||
            msg.role === "custom"
          ) {
            sessionManager.appendMessage?.(msg);
          }
        }
      } catch {
        /* best effort */
      }
    }

    return result;
  }

  // Unreachable — every code path inside the loop returns. Defense-in-depth.
  return {
    output: "",
    error: "Unknown error",
    durationMs: Date.now() - start,
    tokens: 0,
    touchedFiles: [],
  };
}

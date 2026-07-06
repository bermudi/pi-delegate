import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { DEFAULT_TOOLS, VALID_THINKING } from "./constants.ts";
import { TOOL_FACTORIES, resolveToolGroups } from "./tools.ts";
import { configFor } from "./pool.ts";
import { isSessionBusy } from "./tickets.ts";
import { buildSubagentSystemPrompt } from "./agents.ts";
import { buildParentTranscript } from "./parent-context.ts";
import { findAvailableAlternative, resolveModel } from "./model.ts";
import { resolveModelSpec } from "./config.ts";
import { loadDelegateSettings } from "./settings.ts";
import { resolveCwd } from "./utils.ts";
import type {
  AgentConfig,
  DelegateToolCtx,
  DelegateToolResult,
  ResolvedTask,
  TaskDef,
} from "./types.ts";

/** Build a tool result for an error/notice with no task progress. */
function noticeResult(
  text: string,
  tasks: TaskDef[],
  parentModel: string | undefined,
): DelegateToolResult {
  return {
    content: [{ type: "text", text }],
    details: { tasks, results: [], progress: [], parentModel },
  };
}

/** Pre-dispatch validation: duplicate sessionIds, sessions busy with an async
 *  ticket, and unknown agent names. Returns an error result to short-circuit
 *  the call, or null when all checks pass. */
export function validateTasks(
  tasks: TaskDef[],
  agents: Map<string, AgentConfig>,
  parentModelId: string | undefined,
): DelegateToolResult | null {
  // Disallow same sessionId across multiple parallel tasks (one agent can't serve two prompts concurrently).
  const sessionIds = tasks.map((t) => t.sessionId).filter(Boolean) as string[];
  const duplicateSessions = sessionIds.filter(
    (id, i) => sessionIds.indexOf(id) !== i,
  );
  if (duplicateSessions.length) {
    return noticeResult(
      `Duplicate sessionId(s) across tasks: ${[...new Set(duplicateSessions)].join(", ")}. Each session can only handle one task at a time.`,
      tasks,
      parentModelId,
    );
  }

  // Disallow sessionIds already claimed by a running async ticket.
  const busyConflicts: string[] = [];
  for (const sid of sessionIds) {
    const owner = isSessionBusy(sid);
    if (owner) busyConflicts.push(`${sid} (ticket ${owner})`);
  }
  if (busyConflicts.length) {
    return noticeResult(
      `Session(s) already in use: ${busyConflicts.join(", ")}. Each session can only handle one task at a time.`,
      tasks,
      parentModelId,
    );
  }

  const unknown: string[] = [];
  for (const t of tasks) {
    if (t.agent && !agents.has(t.agent)) unknown.push(t.agent);
  }
  if (unknown.length) {
    const names = [...agents.keys()];
    return noticeResult(
      `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}. Call delegate with an empty tasks array for help.`,
      tasks,
      parentModelId,
    );
  }

  return null;
}

/** Resolve every task into a fully-specified `ResolvedTask`: cwd, system
 *  prompt, model, tools, thinking, and prompt (with optional parent-transcript
 *  injection). Throws on unrecoverable misconfiguration (missing prompt,
 *  unavailable explicit model, no model at all). */
export function resolveTasks(
  tasks: TaskDef[],
  ctx: DelegateToolCtx,
  agents: Map<string, AgentConfig>,
): ResolvedTask[] {
  // Build parent transcript lazily — only computed once if any task uses with-parent-transcript
  let parentTranscript: string | null = null;
  const needsParentContext = tasks.some(
    (t) => t.context === "with-parent-transcript",
  );
  if (needsParentContext) {
    if (!ctx.sessionManager) {
      throw new Error(
        "context: 'with-parent-transcript' requires a persisted parent session.",
      );
    }
    parentTranscript = buildParentTranscript(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    );
  }

  const parentSystemPrompt = ctx.getSystemPrompt?.();

  return tasks.map((t, i) => {
    const agent = t.agent ? agents.get(t.agent) : undefined;
    const cwd = resolveCwd(t.cwd ?? ctx.cwd);

    // Load settings-based overrides for this agent
    const settings = loadDelegateSettings(cwd);
    const agentOverride =
      t.agent && settings?.agentOverrides?.[t.agent]
        ? settings.agentOverrides[t.agent]
        : undefined;

    // Build system prompt. Explicit task prompts and named agent prompts
    // win; ad-hoc subagents inherit the parent prompt when Pi exposes it,
    // then get explicit skills/AGENTS.md injection below.
    const pooledConfig = t.sessionId
      ? configFor(t.sessionId)
      : undefined;

    // Prompt is required for fresh tasks. ResumeFrom provides context already.
    if (
      t.action !== "close" &&
      t.action !== "list" &&
      !t.resumeFrom &&
      !t.prompt?.trim()
    ) {
      throw new Error(
        `Task ${i}: prompt is required unless action is 'close'/'list' or resumeFrom is set.`,
      );
    }

    // System prompt resolution. AgentSession's resource loader owns
    // skills + AGENTS.md discovery (it appends them via _rebuildSystemPrompt),
    // so we resolve only the *base* prompt here: explicit task prompt → named
    // agent body → parent session prompt → default. The resolved base is
    // passed as the loader's customPrompt (see buildDelegateSession).
    const systemPrompt = buildSubagentSystemPrompt({
      taskSystemPrompt: t.systemPrompt,
      agentSystemPrompt: agent?.systemPrompt,
      parentSystemPrompt,
      pooledSystemPrompt: pooledConfig?.systemPrompt,
    });

    // Build prompt — wrap with parent context if using with-parent-transcript
    let prompt =
      t.prompt ||
      (t.resumeFrom
        ? "Continue from where you left off. Pick up the task and keep going."
        : t.prompt);
    const parentCtx =
      t.context === "with-parent-transcript" && parentTranscript
        ? parentTranscript
        : null;
    if (parentCtx) {
      prompt = [
        "<parent-session>",
        "The following is the conversation from the parent session.",
        "Read this for context, then execute the task below.",
        "Do not continue the parent conversation or respond to prior messages.",
        "",
        parentCtx,
        "</parent-session>",
        "",
        "## Task",
        prompt,
      ].join("\n");
    }

    // Resolve model — explicit specs must resolve or fail; omitted falls back to parent
    let model: Model<Api> | undefined;
    let tools: string[] = [];
    let thinking: ThinkingLevel = "off";
    const warnings: string[] = [];

    if (t.action !== "close" && t.action !== "list") {
      // For pool hits, the model is already baked into the agent — skip resolution.
      if (pooledConfig) {
        model = pooledConfig.model;
      } else {
        // Resolve an explicit model spec (precedence: task > session > config >
        // frontmatter). resolveModelSpec returns undefined when none is set, so
        // we skip resolveModel entirely — passing the parent's composite id
        // (e.g. OpenRouter's "deepseek/deepseek-v4-flash") would split on "/"
        // and misroute to the upstream provider. Leaving resolvedModel
        // undefined also lets findAvailableAlternative run below: it returns
        // ctx.model as-is when it has auth, or swaps to an authenticated
        // same-id alternative when the parent's provider lost auth.
        const agentType = t.agent ?? "inline";
        const modelSpec = resolveModelSpec({
          taskModel: t.model ?? agentOverride?.model,
          agentType,
          frontmatterModel: agent?.model,
        });
        const resolvedModel = modelSpec
          ? resolveModel(modelSpec, ctx.modelRegistry, ctx.model)
          : undefined;

        // If the task or settings explicitly set a model but it couldn't resolve, fail loudly
        const explicitRequest = t.model ?? agentOverride?.model;
        if (explicitRequest && !resolvedModel) {
          throw new Error(
            `Task ${i}: requested model '${explicitRequest}' is not available. Check provider config or remove the model field to use the parent model.`,
          );
        }

        model =
          resolvedModel ??
          findAvailableAlternative(ctx.model, ctx.modelRegistry) ??
          ctx.model;
      }

      if (!model) {
        throw new Error(
          `Task ${i}: no model available — parent session has no model set.`,
        );
      }

      // Resolve tools — warn about unknown tool names.
      // For active pooled sessions, fall back to the frozen pooled config so
      // "continue with only sessionId" works without re-supplying tools.
      // Explicit overrides that don't match get rejected by acquireAgentSession.
      const isPoolHit = pooledConfig !== undefined;
      tools = resolveToolGroups(
        t.tools ??
          agentOverride?.tools ??
          agent?.tools ??
          (isPoolHit ? pooledConfig?.tools : undefined) ??
          DEFAULT_TOOLS,
      );
      const unknownTools = tools.filter((name) => !(name in TOOL_FACTORIES));
      if (unknownTools.length) {
        warnings.push(
          `Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`,
        );
      }

      // Resolve thinking — for active pooled sessions, default from the
      // frozen pooled config (same reasoning as tools above).
      const thinkingRaw =
        t.thinking ??
        agentOverride?.thinking ??
        agent?.thinking ??
        (isPoolHit ? pooledConfig?.thinking : undefined) ??
        "off";
      thinking = VALID_THINKING.has(thinkingRaw)
        ? (thinkingRaw as ThinkingLevel)
        : "off";
    }
    return {
      ...t,
      cwd,
      systemPrompt,
      model: model!,
      tools,
      thinking,
      prompt,
      // Display label for ad-hoc subagents (no named profile). NOTE: the
      // config-namespace key at resolveModelSpec stays "inline" — that's a
      // delegate.json/settings contract, not a display string (friction #4).
      agentName: agent?.name ?? "ad-hoc",
      warnings,
    };
  });
}

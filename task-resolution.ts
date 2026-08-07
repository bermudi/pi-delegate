import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_TOOLS,
  VALID_THINKING,
} from "./constants.ts";
import { TOOL_FACTORIES, resolveToolGroups } from "./tools.ts";
import { configFor } from "./pool.ts";
import { isSessionBusy } from "./tickets.ts";
import { buildSubagentSystemPrompt } from "./agents.ts";
import { buildParentTranscript } from "./parent-context.ts";
import { findAvailableAlternative, resolveModelRequest } from "./model.ts";
import { resolveModelSpec } from "./config.ts";
import { loadDelegateSettings } from "./settings.ts";
import { resolveCwd } from "./utils.ts";
import type {
  AgentConfig,
  DelegateToolCtx,
  DelegateToolResult,
  ParentAgentDefaults,
  ResolvedTask,
  TaskDef,
} from "./types.ts";

const PROJECT_CONTEXT_START =
  "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
const PROJECT_CONTEXT_END = "\n</project_context>\n";

/**
 * Parent `getSystemPrompt()` is the fully assembled prompt, including the
 * parent's AGENTS.md files. A delegated session resolves resources for its own
 * cwd, so carrying that section across would leak global instructions and
 * duplicate project context. Preserve the parent's base prompt and everything
 * outside Pi's structured context section; the child ResourceLoader appends its
 * own (filtered) context afterward.
 */
function stripInheritedProjectContext(
  prompt: string | undefined,
): string | undefined {
  if (!prompt) return prompt;
  const start = prompt.indexOf(PROJECT_CONTEXT_START);
  if (start < 0) return prompt;
  const end = prompt.lastIndexOf(PROJECT_CONTEXT_END);
  if (end < start) return prompt;
  return `${prompt.slice(0, start)}${prompt.slice(end + PROJECT_CONTEXT_END.length)}`;
}

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
    if (t.agent && t.agent !== DEFAULT_AGENT_NAME && !agents.has(t.agent)) {
      unknown.push(t.agent);
    }
  }
  if (unknown.length) {
    const names = [DEFAULT_AGENT_NAME, ...agents.keys()];
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
  parentDefaults: ParentAgentDefaults,
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

  const parentSystemPrompt = stripInheritedProjectContext(
    ctx.getSystemPrompt?.(),
  );

  return tasks.map((t, i) => {
    const isDefaultAgent = t.agent === DEFAULT_AGENT_NAME;
    const agent = t.agent && !isDefaultAgent ? agents.get(t.agent) : undefined;
    const cwd = resolveCwd(t.cwd ?? ctx.cwd, ctx.cwd);

    // Load settings-based overrides for this agent
    const settings = loadDelegateSettings(cwd);
    const agentOverride =
      t.agent && !isDefaultAgent && settings?.agentOverrides?.[t.agent]
        ? settings.agentOverrides[t.agent]
        : undefined;

    // Build system prompt. Explicit task prompts and named agent prompts
    // win; ad-hoc subagents inherit the parent's base prompt when Pi exposes
    // it. The assembled parent project-context section was stripped above;
    // the child ResourceLoader supplies context for this task's cwd.
    const pooledConfig = t.sessionId ? configFor(t.sessionId) : undefined;

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
    // skills + project AGENTS.md discovery (it appends them via
    // _rebuildSystemPrompt), so we resolve only the *base* prompt here:
    // explicit task prompt → named agent body → sanitized parent prompt →
    // default. The resolved base is passed as the loader's customPrompt (see
    // buildDelegateSession).
    // Keep explicit intent separate: a bare `{ prompt, sessionId }` continues
    // the frozen prompt even if the parent prompt has since changed, while an
    // explicit task/profile prompt must not be silently ignored on reuse.
    const requestedSystemPrompt = t.systemPrompt?.trim()
      ? t.systemPrompt
      : agent?.systemPrompt?.trim()
        ? agent.systemPrompt
        : isDefaultAgent
          ? parentSystemPrompt
          : undefined;
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
    let requestedModel: Model<Api> | undefined;
    let modelSuffix: ThinkingLevel | undefined;
    let tools: string[] = [];
    let thinking: ThinkingLevel = "off";
    const warnings: string[] = [];

    if (t.action !== "close" && t.action !== "list") {
      // A pool hit always runs its frozen model, but an explicitly requested
      // task/profile model still has to be resolved so checkout can reject a
      // contradictory request rather than silently discarding it. Naming the
      // built-in `default` profile is also explicit: it requests the live
      // parent model, so reuse fails clearly if the pool was frozen differently.
      if (pooledConfig) {
        const requestedModelSpec =
          t.model ??
          (t.agent && !isDefaultAgent
            ? (agentOverride?.model ?? agent?.model)
            : undefined);
        if (requestedModelSpec) {
          const requested = resolveModelRequest(
            requestedModelSpec,
            ctx.modelRegistry,
            ctx.model,
          );
          requestedModel = requested.model;
          modelSuffix = requested.strippedSuffix;
          if (!requestedModel) {
            throw new Error(
              `Task ${i}: requested model '${requestedModelSpec}' is not available. Check provider config or remove the model field to continue the pooled session.`,
            );
          }
        } else if (isDefaultAgent) {
          requestedModel = ctx.model;
        }
        model = pooledConfig.model;
      } else {
        // The built-in `default` profile bypasses delegate.json and settings:
        // absent a task override, it means this exact live parent Model object.
        // Other tasks retain the normal task > config > frontmatter chain.
        const agentType = t.agent ?? "inline";
        const modelSpec = isDefaultAgent
          ? t.model
          : resolveModelSpec({
              taskModel: t.model ?? agentOverride?.model,
              agentType,
              frontmatterModel: agent?.model,
            });
        const resolvedRequest = modelSpec
          ? resolveModelRequest(modelSpec, ctx.modelRegistry, ctx.model)
          : undefined;
        const resolvedModel = resolvedRequest?.model;
        // A Pi-style `:level` suffix was tolerated so the reference resolves;
        // it is honored only as a last-resort thinking default (see below).
        modelSuffix = resolvedRequest?.strippedSuffix;

        // If the task or settings explicitly set a model but it couldn't resolve, fail loudly
        const explicitRequest = t.model ?? agentOverride?.model;
        if (explicitRequest && !resolvedModel) {
          throw new Error(
            `Task ${i}: requested model '${explicitRequest}' is not available. Check provider config or remove the model field to use the parent model.`,
          );
        }

        model = isDefaultAgent
          ? (resolvedModel ?? ctx.model)
          : (resolvedModel ??
            findAvailableAlternative(ctx.model, ctx.modelRegistry) ??
            ctx.model);
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
      const parentNativeTools = parentDefaults.tools.filter(
        (name) => name in TOOL_FACTORIES,
      );
      tools = resolveToolGroups(
        t.tools ??
          agentOverride?.tools ??
          agent?.tools ??
          (isDefaultAgent ? parentNativeTools : undefined) ??
          (isPoolHit ? pooledConfig?.tools : undefined) ??
          DEFAULT_TOOLS,
      );
      const unknownTools = tools.filter((name) => !(name in TOOL_FACTORIES));
      if (unknownTools.length) {
        warnings.push(
          `Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`,
        );
      }

      // Resolve thinking. Explicit task/profile/pool values retain their old
      // precedence. The built-in `default` profile instead uses the parent's
      // live level; an explicit model suffix still beats that inherited value.
      // On a named `default` pool reuse, the live parent level is intentional
      // and checkout will reject a conflict with the frozen session.
      const thinkingRaw =
        t.thinking ??
        agentOverride?.thinking ??
        agent?.thinking ??
        (isPoolHit && !isDefaultAgent ? pooledConfig?.thinking : undefined) ??
        modelSuffix ??
        (isDefaultAgent ? parentDefaults.thinking : undefined) ??
        (isPoolHit ? pooledConfig?.thinking : undefined) ??
        "off";
      thinking = VALID_THINKING.has(thinkingRaw)
        ? (thinkingRaw as ThinkingLevel)
        : "off";
      // The suffix was set but a higher-precedence source won — surface it so
      // the caller knows the `:level` had no effect (rather than silently
      // discarding the intent).
      if (modelSuffix && thinkingRaw !== modelSuffix) {
        warnings.push(
          `Model ':${modelSuffix}' suffix ignored — thinking resolved to '${thinking}' from a higher-precedence source.`,
        );
      }
    }
    return {
      ...t,
      cwd,
      systemPrompt,
      model: model!,
      tools,
      thinking,
      // Empty only for close/list actions (validated above) — downstream
      // display code treats "" and absent alike (`t.prompt || …`).
      prompt: prompt ?? "",
      // Keep the built-in selector visible in progress/results. Omitted-agent
      // inline tasks retain the established `ad-hoc` label and config namespace.
      agentName: isDefaultAgent
        ? DEFAULT_AGENT_NAME
        : (agent?.name ?? "ad-hoc"),
      warnings,
      reuseIntent: {
        model: requestedModel,
        systemPrompt: requestedSystemPrompt,
      },
    };
  });
}

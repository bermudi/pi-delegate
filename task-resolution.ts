import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  BUILTIN_AGENT_NAMES,
  DEFAULT_AGENT_NAME,
  DEFAULT_TOOLS,
  VALID_THINKING,
} from "./constants.ts";
import {
  TOOL_FACTORIES,
  availableToolNames,
  resolveToolGroups,
} from "./tools.ts";
import { configFor } from "./pool.ts";
import { isSessionBusy } from "./tickets.ts";
import { BUILTIN_AGENT_CONFIGS, buildSubagentSystemPrompt } from "./agents.ts";
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
 *
 * The AGENTS.md/CLAUDE.md content is inserted verbatim inside
 * `<project_instructions>...</project_instructions>` blocks. A file that
 * itself contains `\n</project_context>\n` can therefore forge an early
 * closing marker. It could also include a forged `</project_instructions>` to
 * balance the open tag, making the fake `</project_context>` look like the
 * section end. A content-controlled marker can only ever appear *inside* the
 * generated `<project_context>` block, before the real `</project_context>`
 * that Pi appends after the last file. Skills escape angle brackets, the
 * `appendSystemPrompt` text is added before this section, and the trailing
 * `Current working directory:` line contains no such marker, so the real
 * closing marker is the final raw `\n</project_context>\n` in the prompt.
 * We therefore match the Pi-generated opening marker to the final matching
 * closing marker, deterministically stripping the whole generated section.
 */
export function stripInheritedProjectContext(
  prompt: string | undefined,
): string | undefined {
  if (!prompt) return prompt;

  const start = prompt.indexOf(PROJECT_CONTEXT_START);
  if (start < 0) return prompt;

  // The real closing marker is the final occurrence: child content cannot
  // place a `</project_context>` after the one Pi generates to close the
  // section.
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

/** Format a task reference for error messages: one-based index with an optional caller id. */
function formatTaskRef(index: number, id: string | undefined): string {
  return `Task ${index + 1}${id ? `#${id}` : ""}`;
}

/** Pre-dispatch validation: duplicate sessionIds, sessions busy with an async
 *  ticket, and unknown agent names. Returns an error result to short-circuit
 *  the call, or null when all checks pass. */
export function validateTasks(
  tasks: TaskDef[],
  agents: Map<string, AgentConfig>,
  parentModelId: string | undefined,
): DelegateToolResult | null {
  const unknown: string[] = [];
  for (const task of tasks) {
    if (
      task.agent &&
      !(BUILTIN_AGENT_NAMES as readonly string[]).includes(task.agent) &&
      !agents.has(task.agent)
    ) {
      unknown.push(task.agent);
    }
  }
  if (unknown.length) {
    const names = [...new Set([...BUILTIN_AGENT_NAMES, ...agents.keys()])];
    return noticeResult(
      `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}. Call delegate with an empty tasks array for help.`,
      tasks,
      parentModelId,
    );
  }

  // Scratch sessions are deliberately one-shot. This check uses the
  // effective workspace, so reviewer gets the same protection even when the
  // caller omits workspace. Explicit scratch is never silently promoted to
  // shared.
  for (const [index, task] of tasks.entries()) {
    const agent = task.agent
      ? (agents.get(task.agent) ?? BUILTIN_AGENT_CONFIGS[task.agent])
      : undefined;
    const workspace = task.workspace ?? agent?.workspace ?? "shared";
    const sessionAction = task.sessionAction;
    if (
      workspace === "scratch" &&
      (task.sessionId || task.resumeFrom || sessionAction !== undefined)
    ) {
      const defaultText =
        task.workspace === undefined && agent?.workspace === "scratch"
          ? "defaults to workspace `scratch`"
          : "uses workspace `scratch`";
      const persistentAgent = task.agent ?? "agent";
      return noticeResult(
        `${formatTaskRef(index, task.id)}: Agent \`${persistentAgent}\` ${defaultText}, which is one-shot and cannot use \`sessionId\`, \`resumeFrom\`, or session actions. Set \`workspace: "shared"\` to use a persistent ${persistentAgent}.`,
        tasks,
        parentModelId,
      );
    }
  }

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

  // Disallow duplicate caller-provided task ids within one dispatch.
  const seenIds = new Map<string, number>();
  const duplicateIds: string[] = [];
  for (const [index, task] of tasks.entries()) {
    if (task.id) {
      if (seenIds.has(task.id)) {
        duplicateIds.push(
          `task ${index + 1}: duplicate id '${task.id}' — ids must be unique within one dispatch.`,
        );
      } else {
        seenIds.set(task.id, index);
      }
    }
  }
  if (duplicateIds.length) {
    return noticeResult(duplicateIds.join(" "), tasks, parentModelId);
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
    const agent = t.agent
      ? (agents.get(t.agent) ?? BUILTIN_AGENT_CONFIGS[t.agent])
      : undefined;
    const isBuiltinAgent = agent?.builtin === true;
    const cwd = resolveCwd(t.cwd ?? ctx.cwd, ctx.cwd);

    // Load settings-based overrides for this agent
    const settings = loadDelegateSettings(cwd);
    const parentModelKey = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined;
    const parentModelOverride =
      t.agent && !isDefaultAgent && parentModelKey
        ? settings?.agentOverridesByParentModel?.[parentModelKey]?.[t.agent]
        : undefined;
    const agentOverride =
      t.agent && !isDefaultAgent && settings?.agentOverrides?.[t.agent]
        ? settings.agentOverrides[t.agent]
        : undefined;

    // Build system prompt. Explicit task prompts and named agent prompts
    // win; ad-hoc subagents inherit the parent's base prompt when Pi exposes
    // it. The assembled parent project-context section was stripped above;
    // the child ResourceLoader supplies context for this task's cwd.
    const pooledConfig = t.sessionId ? configFor(t.sessionId) : undefined;
    const isPoolHit = pooledConfig !== undefined;
    const parentNativeTools = parentDefaults.tools.filter((name) =>
      Object.hasOwn(TOOL_FACTORIES, name),
    );
    let tools: string[] = [];
    const warnings: string[] = [];
    const workspace = t.workspace ?? agent?.workspace ?? "shared";
    if (workspace === "scratch") {
      warnings.push(
        "Scratch workspace: relative file changes run in a disposable CoW copy and are discarded.",
      );
    }

    // Prompt is required for fresh tasks. ResumeFrom provides context already.
    if (
      t.sessionAction !== "close" &&
      t.sessionAction !== "list" &&
      !t.resumeFrom &&
      !t.prompt?.trim()
    ) {
      throw new Error(
        `${formatTaskRef(i, t.id)}: prompt is required unless sessionAction is 'close'/'list' or resumeFrom is set.`,
      );
    }

    // Resolve tools — warn about unknown tool names.
    // For active pooled sessions, fall back to the frozen pooled config so
    // "continue with only sessionId" works without re-supplying tools.
    // Explicit overrides that don't match get rejected by acquireAgentSession.
    if (t.sessionAction !== "close" && t.sessionAction !== "list") {
      // For `default` a deny-only override (no explicit allowlist) is not
      // materialized at discovery; apply its denylist to the parent's actual
      // tools here so a read-only parent stays read-only.
      let effectiveParentTools = parentNativeTools;
      if (
        isDefaultAgent &&
        agent?.deniedTools?.length &&
        !agent?.explicitTools
      ) {
        const denied = new Set(agent.deniedTools);
        effectiveParentTools = parentNativeTools.filter(
          (t) => !denied.has(t),
        );
      }
      tools = resolveToolGroups(
        t.tools ??
          parentModelOverride?.tools ??
          agentOverride?.tools ??
          (isDefaultAgent
            ? agent?.explicitTools
              ? agent.tools
              : effectiveParentTools
            : undefined) ??
          (isBuiltinAgent ? agent?.tools : undefined) ??
          agent?.tools ??
          (isPoolHit ? pooledConfig?.tools : undefined) ??
          DEFAULT_TOOLS,
      );
    }

    // System prompt resolution. AgentSession's resource loader owns
    // skills + project AGENTS.md discovery (it appends them via
    // _rebuildSystemPrompt), so we resolve only the *base* prompt here:
    // explicit task prompt → named agent body → sanitized parent prompt →
    // default. The resolved base is passed as the loader's customPrompt (see
    // buildDelegateSession).
    //
    // The *requested* system prompt is what the reuse check compares against the
    // frozen pooled value. A bare `{ prompt, sessionId }` omits it so the pool
    // can keep using the frozen prompt even if the parent prompt changed. An
    // explicit task/profile prompt is used as-is. The built-in `default` profile
    // intentionally mirrors the live parent, so its requested prompt is the
    // *sanitized* parent prompt — the same form that would be stored as the
    // frozen base, avoiding a false mismatch when the inherited default prompt
    // gets its stale tool inventory stripped.
    const resolvedBasePrompt = buildSubagentSystemPrompt({
      taskSystemPrompt: t.systemPrompt,
      agentSystemPrompt: agent?.systemPrompt,
      parentSystemPrompt,
      tools,
    });
    let requestedSystemPrompt = t.systemPrompt?.trim()
      ? t.systemPrompt
      : agent?.systemPrompt?.trim()
        ? agent.systemPrompt
        : isDefaultAgent
          ? resolvedBasePrompt
          : undefined;
    let systemPrompt = buildSubagentSystemPrompt({
      taskSystemPrompt: t.systemPrompt,
      agentSystemPrompt: agent?.systemPrompt,
      parentSystemPrompt,
      pooledSystemPrompt: pooledConfig?.systemPrompt,
      tools,
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
    let thinking: ThinkingLevel = "off";

    if (t.sessionAction !== "close" && t.sessionAction !== "list") {
      const agentType = t.agent ?? "inline";
      // The built-in `default` profile bypasses delegate/settings model
      // overrides for backwards compatibility. The other built-ins accept
      // task and settings.json model overrides, but deliberately ignore the
      // legacy delegate.json agent model map so they inherit the parent unless
      // an explicit modern override wins.
      // Overridden built-ins can still provide an explicit `model` in their
      // Markdown frontmatter – when `explicitModel` is set, honor it instead
      // of silently ignoring it (which would contradict the Markdown contract).
      const modelSpec = isDefaultAgent
        ? (t.model ?? (agent?.explicitModel ? agent.model : undefined))
        : isBuiltinAgent
          ? (t.model ??
            parentModelOverride?.model ??
            agentOverride?.model ??
            (agent?.explicitModel ? agent.model : undefined))
          : resolveModelSpec({
              taskModel:
                t.model ?? parentModelOverride?.model ?? agentOverride?.model,
              agentType,
              frontmatterModel: agent?.model,
            });

      // A pool hit always runs its frozen model, but an explicitly requested
      // task/profile model still has to be resolved so checkout can reject a
      // contradictory request rather than silently discarding it. Naming the
      // built-in `default` profile is also explicit: it requests the live
      // parent model, so reuse fails clearly if the pool was frozen differently.
      if (pooledConfig) {
        if (modelSpec) {
          const requested = resolveModelRequest(
            modelSpec,
            ctx.modelRegistry,
            ctx.model,
          );
          requestedModel = requested.model;
          modelSuffix = requested.strippedSuffix;
          if (!requestedModel) {
            throw new Error(
              `${formatTaskRef(i, t.id)}: requested model '${modelSpec}' is not available. Check provider config or remove the model field to continue the pooled session.`,
            );
          }
        } else if (isDefaultAgent) {
          requestedModel = ctx.model;
        }
        model = pooledConfig.model;
      } else {
        const resolvedRequest = modelSpec
          ? resolveModelRequest(modelSpec, ctx.modelRegistry, ctx.model)
          : undefined;
        const resolvedModel = resolvedRequest?.model;
        // A Pi-style `:level` suffix was tolerated so the reference resolves;
        // it is honored only as a last-resort thinking default (see below).
        modelSuffix = resolvedRequest?.strippedSuffix;

        // The selected model spec is explicit regardless of whether it came
        // from the task, settings, or named-agent frontmatter. If it cannot
        // resolve, fail loudly instead of silently falling back to the parent.
        const explicitRequest = modelSpec;
        if (explicitRequest && !resolvedModel) {
          throw new Error(
            `${formatTaskRef(i, t.id)}: requested model '${explicitRequest}' is not available. Check provider config or remove the model field to use the parent model.`,
          );
        }

        model = isBuiltinAgent
          ? (resolvedModel ?? ctx.model)
          : (resolvedModel ??
            findAvailableAlternative(ctx.model, ctx.modelRegistry) ??
            ctx.model);
      }

      if (!model) {
        throw new Error(
          `${formatTaskRef(i, t.id)}: no model available — parent session has no model set.`,
        );
      }

      // Resolve thinking. Precedence for most agents: explicit `thinking` >
      // agent override > frontmatter > frozen pooled config > model `:level`
      // suffix (last resort). The built-in `default` agent intentionally
      // inverts the last two steps: model suffix beats the parent's live
      // thinking, which beats the frozen pooled value. This surfaces a clear
      // `config mismatch` error on reuse when the parent thinking level has
      // changed, rather than silently reusing a stale frozen value. The final
      // pooled fallback is reachable only when parentDefaults.thinking is
      // undefined (headless parent without a thinking level).
      const thinkingRaw = isBuiltinAgent
        ? isDefaultAgent
          ? (t.thinking ??
            parentModelOverride?.thinking ??
            agentOverride?.thinking ??
            (agent?.explicitThinking ? agent.thinking : undefined) ??
            modelSuffix ??
            parentDefaults.thinking ??
            (isPoolHit ? pooledConfig?.thinking : undefined) ??
            "off")
          : (t.thinking ??
            parentModelOverride?.thinking ??
            agentOverride?.thinking ??
            (agent?.explicitThinking ? agent.thinking : undefined) ??
            (isPoolHit ? pooledConfig?.thinking : undefined) ??
            modelSuffix ??
            parentDefaults.thinking ??
            "off")
        : (t.thinking ??
          agentOverride?.thinking ??
          agent?.thinking ??
          (isPoolHit ? pooledConfig?.thinking : undefined) ??
          modelSuffix ??
          "off");
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

    const availableTools = availableToolNames(model?.provider);
    const availableToolSet = new Set(availableTools);
    const unknownTools = tools.filter((name) => !availableToolSet.has(name));
    if (unknownTools.length) {
      warnings.push(
        `Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${availableTools.join(", ")}`,
      );
    }
    tools = tools.filter((name) => availableToolSet.has(name));
    systemPrompt = buildSubagentSystemPrompt({
      taskSystemPrompt: t.systemPrompt,
      agentSystemPrompt: agent?.systemPrompt,
      parentSystemPrompt,
      pooledSystemPrompt: pooledConfig?.systemPrompt,
      tools,
    });
    if (isDefaultAgent && !t.systemPrompt?.trim() && !agent?.systemPrompt?.trim()) {
      requestedSystemPrompt = systemPrompt;
    }

    return {
      ...t,
      id: t.id,
      cwd,
      workspace,
      systemPrompt,
      model: model!,
      tools,
      thinking,
      // Empty only for close/list actions (validated above) — downstream
      // display code treats "" and absent alike (`t.prompt || …`).
      prompt: prompt ?? "",
      // Keep the built-in selector visible in progress/results. Omitted-agent
      // inline tasks retain the established `ad-hoc` label and config namespace.
      agentName: agent?.name ?? "ad-hoc",
      warnings,
      reuseIntent: {
        model: requestedModel,
        systemPrompt: requestedSystemPrompt,
      },
    };
  });
}

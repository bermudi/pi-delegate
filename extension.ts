import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Text, Markdown } from "@mariozechner/pi-tui";
import {
  getMarkdownTheme,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_TOOLS, VALID_THINKING, POOL_TTL_MS } from "./constants.ts";
import { TOOL_FACTORIES, resolveToolGroups } from "./tools.ts";
import { agentPool, sweepPool } from "./pool.ts";
import {
  ticketRegistry,
  generateTicketId,
  handleCancel,
  handlePoll,
  deliverTicketResults,
  sweepTickets,
  isSessionBusy,
} from "./tickets.ts";
import {
  getConcurrencyLimit,
  getMaxAsyncTickets,
  getMaxConcurrent,
} from "./config.ts";
import { discoverAgents, buildSubagentSystemPrompt } from "./agents.ts";
import { buildParentTranscript } from "./parent-context.ts";
import { findAvailableAlternative, resolveModel } from "./model.ts";
import { resolveModelSpec } from "./config.ts";
import { loadDelegateSettings } from "./settings.ts";
import { getModelKey, mapConcurrentByModel } from "./concurrency.ts";
import { runResolvedTask, updateProgressFromRun } from "./lifecycle.ts";
import {
  fmtDuration,
  fmtTokens,
  getActivityAge,
  indent,
  tree,
  trunc,
  truncLine,
  spinnerFrame,
  applyLineBudget,
  formatToolCallShort,
  formatFailedTask,
  shortenPath,
  getTermWidth,
  previewOutputLine,
} from "./format.ts";
import { resolveCwd, stripAnsi, resolveCarriageReturn } from "./utils.ts";
import type {
  AgentConfig,
  AsyncTicket,
  DelegateDetails,
  DelegateParams,
  ResolvedTask,
  TaskDef,
  TaskProgress,
  TaskResult,
  TaskRunEnv,
} from "./types.ts";

// ── Extracted schema constant ───────────────────────────────────────────
// Avoids inline `this` context issues and lets TypeScript infer params safely.
const delegateParameters = Type.Object({
  action: Type.Optional(
    Type.String({
      enum: ["poll", "cancel"],
    }),
  ),
  async: Type.Optional(Type.Boolean()),
  ticket: Type.Optional(Type.String()),
  tasks: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          prompt: Type.Optional(Type.String()),
          agent: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String()),
          // ── Undocumented overrides — accepted but not advertised in schema.
          // Discovered via empty-tasks help text.
          systemPrompt: Type.Optional(Type.String()),
          context: Type.Optional(
            Type.String({ enum: ["fresh", "with-parent-transcript"] }),
          ),
          model: Type.Optional(Type.String()),
          tools: Type.Optional(Type.Array(Type.String())),
          thinking: Type.Optional(
            Type.String({
              enum: [...VALID_THINKING],
            }),
          ),
          sessionId: Type.Optional(Type.String()),
          action: Type.Optional(
            Type.String({
              enum: ["prompt", "close", "list", "poll", "cancel"],
            }),
          ),
          resumeFrom: Type.Optional(Type.String()),
        }),
        {
          minItems: 0,
        },
      ),
      // Some models stringify the task array when emitting tool calls. Accept
      // the type so execute can return an actionable repair hint instead of
      // Pi's generic schema error; never parse it implicitly.
      Type.String(),
    ]),
  ),
});

function getSubagentManualMarkdown(agents: Map<string, AgentConfig>): string {
  const entries = [...agents];
  const agentList = entries.length
    ? entries
        .map(([n, a]) => {
          const model = a.model ? ` (model: ${a.model})` : "";
          const thinking =
            a.thinking !== "off" ? ` [thinking: ${a.thinking}]` : "";
          const tools =
            a.tools.length !== DEFAULT_TOOLS.length ||
            a.tools.some((t, i) => t !== DEFAULT_TOOLS[i])
              ? ` tools: ${a.tools.join(", ")}`
              : "";
          const scope =
            a.scope === "project"
              ? " [project]"
              : a.scope === "global"
                ? " [global]"
                : a.scope === "claude"
                  ? " [claude]"
                  : a.scope === "builtin"
                    ? " [builtin]"
                    : "";
          return `- **${n}**${model}${thinking}${tools}${scope}: ${a.description}`;
        })
        .join("\n")
    : "_(none defined)_";

  return [
    "# Delegate Tool Manual",
    "",
    "Delegate subagents to execute tasks in parallel. Each subagent gets an independent context, system prompt, model, tools, and thinking level.",
    "",
    "## Available Agents",
    "",
    agentList,
    "",
    "Agents live in `.pi/agents/*.md` (project-local), `~/.pi/agent/agents/` (global), and `.claude/agents/` (interchange with Claude Code). Each agent file is Markdown with YAML-ish frontmatter:",
    "",
    "```markdown",
    "---",
    "name: my-agent",
    "description: What it does",
    "model: anthropic/claude-haiku-4-5  # optional",
    "thinking: low                     # off/minimal/low/medium/high/xhigh",
    "tools: *                          # * = full agent. ro = read-only. Omit to inherit *.",
    "---",
    "You are a helpful agent...",
    "```",
    "",
    "## Task Fields",
    "",
    "- `prompt` — The task for this subagent. Optional when `resumeFrom` is set (defaults to a continuation prompt).",
    "- `agent` — Named agent from the list above. Inline fields override agent defaults.",
    "- `systemPrompt` — System prompt. Falls back to agent definition, then parent session system prompt.",
    "- `model` — e.g. `anthropic/claude-sonnet-4`. Falls back to agent default, then parent model.",
    "- `tools` — Tool names or shorthands (`*` = full: read,write,edit,bash; `ro` = read-only: read,grep,find,ls). Omitted → inherit `*`. Claude Code tool names (Read/Glob/…) are mapped automatically; unmappable tools are dropped.",
    "- `thinking` — off, minimal, low, medium, high, xhigh. Default: agent setting or 'off'.",
    "- `cwd` — Working directory for the subagent (settings, AGENTS.md resolution). Default: parent session cwd. Named-agent discovery is always parent-session-scoped regardless of per-task cwd.",
    "- `context` — 'fresh' (default) or 'with-parent-transcript' to inject the full parent conversation into the subagent's prompt (token-expensive — use deliberately).",
    "- `sessionId` — Name for a persistent subagent. First use creates it, subsequent calls reuse the same agent (multi-turn).",
    "- `action` — Per-task action: 'prompt' (default), 'close' to tear down a pooled session, 'list' to show active sessions.",
    "- top-level `action` — Async ticket action: 'poll' or 'cancel'. Does not require `tasks`.",
    "- `tasks` must be a real JSON array of objects, not a quoted/stringified JSON array.",
    "",
    "## Session Reuse",
    "",
    "When `sessionId` is set, the subagent is kept alive in a pool for the duration of the pi session.",
    "Subsequent calls with the same `sessionId` continue the conversation — the agent remembers prior context.",
    "",
    "```json",
    "// First call — creates and runs",
    '{ "prompt": "Investigate the auth module", "agent": "scout", "sessionId": "auth-research" }',
    "",
    "// Second call — continues the same agent",
    '{ "prompt": "Now check the tests for that module", "sessionId": "auth-research" }',
    "",
    "// Clean up when done",
    '{ "prompt": "", "sessionId": "auth-research", "action": "close" }',
    "```",
    "",
    `Pooled agents are automatically closed after ${POOL_TTL_MS / 60_000} minutes of inactivity.`,
    "",
    "## Resuming Previous Sessions",
    "",
    "Use `resumeFrom` to continue a failed or interrupted subagent from where it left off.",
    "Pass the exact absolute path to the session `.jsonl` file copied from delegate retry output. Do not invent placeholder values, and do not use `resumeFrom` for async polling.",
    "The agent gets the full conversation history and the new `prompt` continues naturally.",
    "",
    "```json",
    "// Resume a failed browser test — agent remembers everything it already did",
    '{ "prompt": "Continue testing — the server is already running on :3000",',
    '  "resumeFrom": "/home/user/.pi/agent/sessions/project/2026-01-01T12-00-00Z_abc123.jsonl" }',
    "```",
    "",
    "Combine with `sessionId` to resume AND pool the agent for further multi-turn use:",
    "",
    "```json",
    '{ "prompt": "Continue the investigation",',
    '  "resumeFrom": "/path/to/session.jsonl",',
    '  "sessionId": "my-resumed-agent" }',
    "```",
    "",
    "## Async Mode",
    "",
    "Set `async: true` on the top-level call to fire tasks in the background:",
    "",
    "```json",
    'delegate({ async: true, tasks: [{ agent: "scout", prompt: "Investigate auth" }] })',
    "```",
    "\u2192 Returns ticket ID immediately. Parent keeps working.",
    "",
    '- `delegate({ action: "poll" })` \u2014 list all tickets',
    '- `delegate({ action: "poll", ticket: "abc123" })` \u2014 check one ticket',
    '- `delegate({ action: "cancel", ticket: "abc123" })` \u2014 abort a running ticket',
    "",
    `Max ${getMaxAsyncTickets()} concurrent async tickets. Results are delivered automatically when all tasks finish. Poll for progress while running, but avoid polling in a tight loop \u2014 do other work while waiting.`,
    "",
    "## Gotchas",
    "",
    '- `*` means the full agent (read, write, edit, bash), not "every tool." The grep/find/ls trio exists only for `ro` (read-only) agents where bash is unavailable — bash already subsumes them.',
    '- `tasks` must be an array, not a string containing JSON. Use `{ "tasks": [{ "prompt": "..." }] }`, never `{ "tasks": "[{...}]" }`.',
    "- Omitting `tools:` inherits the full agent set (`*`) — for both inline tasks and named agent files.",
    "- Subagents inherit all skills discovered in their `cwd` (via AgentSession's resource loader). Per-task skill filtering is not supported — curate the cwd's skill set instead.",
    `- Sync \`delegate\` runs at most ${getMaxConcurrent()} tasks at once (the rest queue, not fail). Use \`async: true\` to move work to the background.`,
    "- `with-parent-transcript` injects your entire conversation. A 50k-token session means the subagent starts 50k tokens deep.",
    "",
    "## Config",
    "",
    "Tunables live in `~/.pi/agent/delegate.json`: `maxConcurrent` (sync ceiling), `maxAsyncTickets` (background ticket cap), per-model/per-provider concurrency limits, and global model overrides.",
  ].join("\n");
}

export default function delegateExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate to Subagents",
    description:
      "Spawn subagents to run tasks in parallel — each with its own model, tools, and context. " +
      "Supports named agent profiles, persistent multi-turn sessions, async background tickets, " +
      "and resuming interrupted runs. Call with an empty tasks array for the full manual and list " +
      "of configured agents.",
    parameters: delegateParameters,

    async execute(_id, params: DelegateParams, signal, onUpdate, ctx) {
      const parentModelId = ctx.model?.id;
      if (typeof params.tasks === "string") {
        return {
          content: [
            {
              type: "text",
              text: 'Invalid delegate arguments: `tasks` must be an array of task objects, not a JSON string. Use `{ "tasks": [{ "prompt": "...", "agent": "scout" }] }`, not `{ "tasks": "[{...}]" }`.',
            },
          ],
          details: {
            tasks: [],
            results: [
              {
                error:
                  "Invalid delegate arguments: tasks must be an array of task objects, not a JSON string.",
              },
            ],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }
      const tasks = params.tasks ?? [];

      // ── Poll action ───────────────────────────────────────────────────
      // Top-level action is the public API. Per-task action is accepted for
      // backward compatibility with early async builds.
      if (params.action === "poll" || tasks.some((t) => t.action === "poll")) {
        return handlePoll(params, ctx);
      }

      // ── Cancel action ─────────────────────────────────────────────────
      // Top-level action is the public API. Per-task action is accepted for
      // backward compatibility with early async builds.
      if (
        params.action === "cancel" ||
        tasks.some((t) => t.action === "cancel")
      ) {
        return handleCancel(params);
      }

      // Agent discovery is intentionally parent-cwd-scoped: agent profiles are a
      // session-level resource, not per-task. Per-task cwd governs settings,
      // and AGENTS.md resolution (see resolveCwd below), but not which
      // named agents exist. Changing this would let a task's throwaway cwd
      // silently swap the agent roster.
      const agents = discoverAgents(ctx.cwd);

      // ── Help mode ─────────────────────────────────────────────────
      if (!tasks.length) {
        return {
          content: [{ type: "text", text: getSubagentManualMarkdown(agents) }],
          details: {
            tasks: [],
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      // ── Validate ──────────────────────────────────────────────────
      // Disallow same sessionId across multiple parallel tasks (one agent can't serve two prompts concurrently).
      const sessionIds = tasks
        .map((t) => t.sessionId)
        .filter(Boolean) as string[];
      const duplicateSessions = sessionIds.filter(
        (id, i) => sessionIds.indexOf(id) !== i,
      );
      if (duplicateSessions.length) {
        return {
          content: [
            {
              type: "text",
              text: `Duplicate sessionId(s) across tasks: ${[...new Set(duplicateSessions)].join(", ")}. Each session can only handle one task at a time.`,
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      // Disallow sessionIds already claimed by a running async ticket.
      const busyConflicts: string[] = [];
      for (const sid of sessionIds) {
        const owner = isSessionBusy(sid);
        if (owner) busyConflicts.push(`${sid} (ticket ${owner})`);
      }
      if (busyConflicts.length) {
        return {
          content: [
            {
              type: "text",
              text: `Session(s) already in use: ${busyConflicts.join(", ")}. Each session can only handle one task at a time.`,
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      const unknown: string[] = [];
      for (const t of tasks) {
        if (t.agent && !agents.has(t.agent)) unknown.push(t.agent);
      }
      if (unknown.length) {
        const names = [...agents.keys()];
        return {
          content: [
            {
              type: "text",
              text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}. Call delegate with an empty tasks array for help.`,
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      // ── Resolve tasks ─────────────────────────────────────────────
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

      const getParentSystemPrompt = (
        ctx as { getSystemPrompt?: () => string | undefined }
      ).getSystemPrompt;
      const parentSystemPrompt =
        typeof getParentSystemPrompt === "function"
          ? getParentSystemPrompt.call(ctx)
          : undefined;

      const resolved = tasks.map((t, i) => {
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
          ? agentPool.get(t.sessionId)?.config
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
          if (t.sessionId && agentPool.has(t.sessionId)) {
            model = agentPool.get(t.sessionId)!.config.model;
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
          const isPoolHit = t.sessionId ? agentPool.has(t.sessionId) : false;
          tools = resolveToolGroups(
            t.tools ??
              agentOverride?.tools ??
              agent?.tools ??
              (isPoolHit ? pooledConfig?.tools : undefined) ??
              DEFAULT_TOOLS,
          );
          const unknownTools = tools.filter(
            (name) => !(name in TOOL_FACTORIES),
          );
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

      // ── Progress tracking ─────────────────────────────────────────
      const startedAt = Date.now();
      const progress: TaskProgress[] = resolved.map((t, i) => ({
        index: i,
        agent: t.agentName,
        task: trunc(t.prompt || t.action || "", 50),
        status: "pending" as const,
        durationMs: 0,
        tokens: 0,
        toolUses: 0,
        activities: [],
        model: t.model?.id,
        warnings: t.warnings.length ? [...t.warnings] : undefined,
      }));
      const fire = () =>
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Running ${resolved.length} subagent${resolved.length > 1 ? "s" : ""}…`,
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [...progress],
            parentModel: parentModelId,
          },
        });
      fire();

      // ── Async mode ───────────────────────────────────────────────────
      if (params.async) {
        sweepTickets();
        const runningCount = [...ticketRegistry.values()].filter(
          (t) => t.status === "running",
        ).length;
        if (runningCount >= getMaxAsyncTickets()) {
          return {
            content: [
              {
                type: "text",
                text: `Too many async tickets running (${runningCount}/${getMaxAsyncTickets()}). Poll existing tickets or cancel one first.`,
              },
            ],
            details: {
              tasks,
              results: [],
              progress: [],
              parentModel: parentModelId,
            },
          };
        }

        const ticketId = generateTicketId();
        const controller = new AbortController();
        const ticket: AsyncTicket = {
          id: ticketId,
          created: Date.now(),
          tasks,
          resolved,
          status: "running",
          results: new Array(resolved.length),
          progress: [...progress],
          controller,
          parentModelId,
        };
        ticketRegistry.set(ticketId, ticket);

        // Capture values for the closure — do NOT use `signal` from execute()
        // The parent turn's signal dies when execute() returns.
        const ticketSignal = controller.signal;
        const modelRegistry = ctx.modelRegistry;

        const asyncEnv: TaskRunEnv = {
          signal: ticketSignal,
          modelRegistry,
          parentSessionManager: ctx.sessionManager,
          ticketId,
          delegateStartedAt: ticket.created,
          onProgress: (p, u) => {
            updateProgressFromRun(p, u);
          },
        };

        // Fire and forget — runs on the event loop.
        // Worker must store the TaskResult back into ticket.results, since
        // formatCompletedTicket/handlePoll read from there. Without the write,
        // completed async tasks would be reported as PENDING.
        mapConcurrentByModel(
          resolved,
          (t) => getModelKey(t.model),
          getConcurrencyLimit,
          async (t, i) => {
            const result = await runResolvedTask(
              asyncEnv,
              t,
              ticket.progress[i]!,
              i,
            );
            ticket.results[i] = result;
            return result;
          },
          ticketSignal,
          getMaxConcurrent(),
        )
          .then(() => {
            // All tasks settled — determine final ticket status.
            // Use progress (set by runResolvedTask) for settled-ness so the
            // status reflects work completion, not just result-array density.
            const anyFailed = ticket.results.some(
              (r) => r && "error" in r && r.error,
            );
            const allSettled = ticket.progress.every(
              (p) => p.status === "done" || p.status === "failed",
            );
            if (ticket.status === "running") {
              if (allSettled && anyFailed) ticket.status = "failed";
              else if (allSettled) ticket.status = "done";
              else ticket.status = "done"; // partial — report what we have
              ticket.completedAt = Date.now();
            }
            deliverTicketResults(pi, ticket);
          })
          .catch((err) => {
            // Defense-in-depth — should not happen if individual tasks catch properly
            ticket.status = "failed";
            ticket.error = err instanceof Error ? err.message : String(err);
            ticket.completedAt = Date.now();
            deliverTicketResults(pi, ticket);
          });

        return {
          content: [
            {
              type: "text",
              text: [
                `Async ticket: ${ticketId}`,
                `${resolved.length} task(s) dispatched · ${runningCount + 1}/${getMaxAsyncTickets()} async slots in use`,
                "",
                "Completed task results are available via poll. Final results delivered automatically when all tasks complete.",
                `Check progress: delegate({ action: "poll", ticket: "${ticketId}" }) — avoid polling in a tight loop`,
                `Cancel if needed: delegate({ action: "cancel", ticket: "${ticketId}" })`,
              ].join("\n"),
            },
          ],
          details: {
            tasks,
            results: [],
            progress: [...progress],
            parentModel: parentModelId,
            ticketId,
          },
        };
      }

      // ── Sync mode ─────────────────────────────────────────────────
      // Sweep stale pooled agents before dispatching.
      sweepPool();

      const syncEnv: TaskRunEnv = {
        signal,
        modelRegistry: ctx.modelRegistry,
        parentSessionManager: ctx.sessionManager,
        ticketId: undefined,
        delegateStartedAt: startedAt,
        onProgress: (p, u) => {
          updateProgressFromRun(p, u);
          fire();
        },
        onStatusChange: () => fire(),
      };

      const results = await mapConcurrentByModel(
        resolved,
        (t) => getModelKey(t.model),
        getConcurrencyLimit,
        async (t, i) => runResolvedTask(syncEnv, t, progress[i]!, i),
        signal,
        getMaxConcurrent(),
      );

      // ── Format for LLM ────────────────────────────────────────────
      const finalResults = results;
      const elapsedTotal = Date.now() - startedAt;

      const parts: string[] = [];
      const succeeded = finalResults.filter((r) => !r.error).length;
      parts.push(
        `${succeeded}/${finalResults.length} tasks completed successfully · ${fmtDuration(elapsedTotal)} wall time\n`,
      );
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i]!;
        const t = resolved[i]!;
        parts.push(
          `=== ${r.agent}: ${trunc(t.prompt || t.action || "", 80)} ===`,
        );
        if (t.warnings?.length) {
          for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
        }
        if (r.error) {
          parts.push(...formatFailedTask(r));
        } else {
          const meta = [
            `OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens`,
          ];
          if (r.sessionFile) meta.push(shortenPath(r.sessionFile));
          if (r.touchedFiles.length > 0) {
            const rel = r.touchedFiles
              .map((f) => path.relative(t.cwd, f))
              .filter((f) => f && !f.startsWith(".."));
            if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
          }
          parts.push(`[${meta.join(" · ")}]\n\n${r.output}`);
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: {
          tasks,
          results: finalResults,
          progress,
          parentModel: parentModelId,
        },
      };
    },

    renderCall(args, theme, ctx) {
      const state = ctx.state as {
        startedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };
      const tasks = (args as { tasks?: TaskDef[] }).tasks ?? [];
      const text =
        (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (!tasks.length) {
        text.setText(theme.fg("toolTitle", theme.bold("delegate")));
        return text;
      }
      // Minimal call rendering — renderResult handles all detail.
      // ToolExecutionComponent stacks call + result, so duplication
      // happens if both show task trees.
      // Only show spinner while still running (ctx.isPartial).
      if (ctx.executionStarted && ctx.isPartial) {
        if (state.startedAt === undefined) state.startedAt = Date.now();
        const elapsed = fmtDuration(Date.now() - state.startedAt);
        text.setText(
          theme.fg(
            "toolTitle",
            theme.bold(
              `${spinnerFrame()} delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""} · ${elapsed}`,
            ),
          ),
        );
        return text;
      }
      text.setText(
        theme.fg(
          "toolTitle",
          theme.bold(
            `delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""}`,
          ),
        ),
      );
      return text;
    },

    renderResult(result, options, theme, ctx) {
      const state = ctx.state as Record<string, unknown> & {
        startedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };
      // Use a faster animation cadence for spinner (80ms) vs the old 1s
      const tickMs = 80;
      if (options.isPartial && !state.interval)
        state.interval = setInterval(() => ctx.invalidate(), tickMs);
      if (!options.isPartial && state.interval) {
        clearInterval(state.interval);
        state.interval = undefined;
      }
      const text =
        (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      const details = result.details as DelegateDetails | undefined;
      if (!details?.progress?.length) {
        const content =
          (result.content as Array<{ type: string; text: string }>)
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n") ?? "";
        text.setText(content ? `\n${content}` : "");
        return text;
      }

      const { progress, results: taskResults } = details;
      const total = progress.length;
      const w = getTermWidth() - 4;
      const lines: string[] = [""];

      const statJoin = (parts: string[]) =>
        parts.length ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "";
      const modelLabel = (p: TaskProgress) =>
        p.model ? ` ${theme.fg("accent", p.model)}` : "";

      // ── Helper: format the "current activity" line (collapsed or expanded fallback) ─────
      const compactActivity = (p: TaskProgress): string => {
        const current = p.activities.findLast((a) => !a.result);
        if (current) {
          const call = formatToolCallShort(current.name, current.args);
          const toolAge = fmtDuration(Date.now() - current.startTime);
          return `${call} | ${toolAge}`;
        }
        // No current tool — show the last completed one, or "thinking…"
        if (p.activities.length > 0) {
          const last = p.activities[p.activities.length - 1]!;
          const call = formatToolCallShort(last.name, last.args);
          return `${call} ✓`;
        }
        return "thinking…";
      };

      // Push muted warning lines for a task under its status row. Rendered in
      // both partial and final views so a human watching the TUI sees that tools
      // were silently dropped — the LLM already gets this in `content`.
      const pushWarnings = (p: TaskProgress, ind: string) => {
        if (!p.warnings?.length) return;
        for (const wn of p.warnings) {
          lines.push(truncLine(`${ind}${theme.fg("warning", `⚠ ${wn}`)}`, w));
        }
      };

      if (options.isPartial) {
        const done = progress.filter(
          (p) => p.status === "done" || p.status === "failed",
        ).length;
        const running = progress.filter((p) => p.status === "running").length;
        const elapsed = state.startedAt
          ? ` · ${fmtDuration(Date.now() - state.startedAt)}`
          : "";

        // Richer header: agent counts + wall time. The Ctrl+O affordance is
        // tool-scoped in Pi, so a single header hint suffices — one per running
        // task just repeats the same line N times.
        const headerParts: string[] = [];
        if (running > 0) headerParts.push(`${running} running`);
        headerParts.push(`${done}/${total} done`);
        if (!options.expanded && running > 0)
          headerParts.push(theme.fg("accent", "Ctrl+O for detail"));
        lines.push(
          theme.fg("muted", `${headerParts.join(" · ")}${elapsed}`),
          "",
        );

        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const ind = indent(i, total);
          const runParts: string[] = [];
          if (p.toolUses > 0)
            runParts.push(`${p.toolUses} tool${p.toolUses > 1 ? "s" : ""}`);
          if (p.tokens > 0) runParts.push(`${fmtTokens(p.tokens)} tokens`);

          switch (p.status) {
            case "done":
              lines.push(
                truncLine(
                  `${tree(i, total)} ${theme.fg("success", "✓")} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`,
                  w,
                ),
              );
              if (options.expanded) {
                for (const activity of p.activities.slice(-3)) {
                  const call = formatToolCallShort(
                    activity.name,
                    activity.args,
                  );
                  const icon = activity.result?.isError
                    ? theme.fg("error", "✗")
                    : theme.fg("success", "✓");
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`,
                      w,
                    ),
                  );
                }
              }
              break;
            case "failed":
              lines.push(
                truncLine(
                  `${tree(i, total)} ${theme.fg("error", "✗")} ${theme.bold(p.agent)}${modelLabel(p)}${p.error ? theme.fg("error", ` ${p.error}`) : ""}`,
                  w,
                ),
              );
              if (options.expanded) {
                for (const activity of p.activities.slice(-3)) {
                  const call = formatToolCallShort(
                    activity.name,
                    activity.args,
                  );
                  const icon = activity.result?.isError
                    ? theme.fg("error", "✗")
                    : theme.fg("success", "✓");
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`,
                      w,
                    ),
                  );
                }
              }
              break;
            case "running":
              {
                const activityAge = getActivityAge(p.lastActivityAt);
                const ageTag = activityAge ? ` · ${activityAge}` : "";
                const glyph = theme.fg("warning", spinnerFrame());
                lines.push(
                  truncLine(
                    `${tree(i, total)} ${glyph} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin(runParts)}${theme.fg("muted", ageTag)}`,
                    w,
                  ),
                );

                if (options.expanded) {
                  // ── Expanded: recent activity history (like done/failed) ──
                  if (p.activities.length > 0) {
                    for (const activity of p.activities.slice(-5)) {
                      const call = formatToolCallShort(
                        activity.name,
                        activity.args,
                      );
                      if (!activity.result) {
                        // In-flight
                        const elapsed = ` | ${fmtDuration(Date.now() - activity.startTime)}`;
                        lines.push(
                          truncLine(
                            `${ind}${theme.fg("warning", `> ${call}${elapsed}`)}`,
                            w,
                          ),
                        );
                        // Show live stdout/stderr preview for streaming tools
                        if (activity.liveOutput) {
                          const clean = stripAnsi(
                            resolveCarriageReturn(activity.liveOutput),
                          );
                          const preview = clean
                            .split("\n")
                            .filter((l) => l.trim())
                            .slice(-3);
                          for (const outLine of preview) {
                            lines.push(
                              truncLine(
                                `${ind}  ${theme.fg("toolOutput", outLine)}`,
                                w,
                              ),
                            );
                          }
                        }
                      } else {
                        const icon = activity.result.isError
                          ? theme.fg("error", "✗")
                          : theme.fg("success", "✓");
                        lines.push(
                          truncLine(
                            `${ind}${theme.fg("muted", `→ ${call}`)} ${icon}`,
                            w,
                          ),
                        );
                      }
                    }
                  } else {
                    lines.push(
                      truncLine(`${ind}${theme.fg("muted", "  thinking…")}`, w),
                    );
                  }
                } else {
                  // ── Collapsed: compact tool line with duration ─────
                  // The Ctrl+O affordance lives once in the header now — emitting
                  // it per task just repeats the same hint for every running agent.
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `⎿  ${compactActivity(p)}`)}`,
                      w,
                    ),
                  );
                }
              }
              break;
            default:
              // Pending / waiting. When the concurrency cap is the reason, show
              // how many slots are occupied so a human sees throttling, not a stall.
              {
                const ahead = running;
                const queuedTag =
                  ahead >= getMaxConcurrent()
                    ? theme.fg("muted", ` queued (${ahead} running)`)
                    : theme.fg("muted", " waiting…");
                lines.push(
                  truncLine(
                    `${tree(i, total)} ${theme.fg("muted", "○")} ${theme.bold(p.agent)}${modelLabel(p)} ${queuedTag}`,
                    w,
                  ),
                );
              }
          }
          pushWarnings(p, ind);
        }
        const budgeted = applyLineBudget(
          lines.filter(Boolean),
          options.expanded ?? false,
        );
        lines.length = 0;
        lines.push(...budgeted);
      } else {
        // ── Final result ─────────────────────────────────────────────
        // Also covers async dispatch + poll of a *running* ticket: those return
        // details.progress with non-terminal (pending/running) statuses. The
        // partial branch isn't used for them (execute has already returned), so
        // this branch must render every status. A ticket banner is shown when
        // details.ticketId is present so the human sees this is background work.
        const succeeded = progress.filter((p) => p.status === "done").length;
        const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);
        const hasLiveTasks = progress.some(
          (p) => p.status === "running" || p.status === "pending",
        );
        const ticketId = details.ticketId;
        const elapsed = state.startedAt
          ? fmtDuration(Date.now() - state.startedAt)
          : fmtDuration(progress.reduce((sum, p) => sum + p.durationMs, 0));

        if (ticketId && hasLiveTasks) {
          // Background ticket — frame it as in-progress, not a finished result.
          const running = progress.filter((p) => p.status === "running").length;
          const ticketParts = [
            `ticket ${ticketId}`,
            `${succeeded}/${total} done`,
          ];
          if (running > 0) ticketParts.push(`${running} running`);
          ticketParts.push("running in background");
          lines.push(theme.fg("warning", `⏳ ${ticketParts.join(" · ")}`), "");
        } else {
          lines.push(
            theme.fg(
              "muted",
              `${succeeded}/${total} completed · ${elapsed} wall · ${fmtTokens(totalTokens)} tokens`,
            ),
            "",
          );
        }

        // Invariant across tasks: compute once, not per iteration (mirrors the
        // partial branch's `running` at line 898).
        const runningNow = progress.filter(
          (q) => q.status === "running",
        ).length;
        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const r = taskResults[i];
          const ind = indent(i, total);
          // Unified status glyphs: ✓ done, ✗ failed, ◐ running, ○ pending.
          // (The live partial branch uses an animated spinner for running; this
          // static final/ticket view can't animate, so a fixed glyph is right.)
          const icon =
            p.status === "done"
              ? theme.fg("success", "✓")
              : p.status === "failed"
                ? theme.fg("error", "✗")
                : p.status === "running"
                  ? theme.fg("warning", "◐")
                  : theme.fg("muted", "○");
          const taskPreview = theme.fg("muted", trunc(p.task, w - 30));
          const isLive = p.status === "running" || p.status === "pending";
          // Live tasks show an activity/waiting hint instead of final stats.
          const liveTail =
            p.status === "running"
              ? theme.fg("muted", ` · ${compactActivity(p)}`)
              : p.status === "pending"
                ? theme.fg(
                    "muted",
                    runningNow >= getMaxConcurrent()
                      ? ` queued (${runningNow} running)`
                      : " waiting…",
                  )
                : "";
          lines.push(
            truncLine(
              `${tree(i, total)} ${icon} ${theme.bold(p.agent)}${modelLabel(p)} ${taskPreview}${isLive ? liveTail : statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`,
              w,
            ),
          );

          // Warnings (e.g. unknown tools ignored) — muted line under the task.
          pushWarnings(p, ind);

          // Tool activities: compact summary only in expanded mode, terminal tasks only.
          if (p.activities.length > 0 && options.expanded && !isLive) {
            const names = p.activities
              .map((a) => a.name)
              .filter((n, i, arr) => arr.indexOf(n) === i);
            const nameList =
              names.slice(0, 4).join(", ") +
              (names.length > 4 ? ` +${names.length - 4}` : "");
            const okCount = p.activities.filter(
              (a) => a.result && !a.result.isError,
            ).length;
            const errCount = p.activities.filter(
              (a) => a.result?.isError,
            ).length;
            const statusParts: string[] = [];
            if (okCount > 0) statusParts.push(`${okCount} ✓`);
            if (errCount > 0) statusParts.push(`${errCount} ✗`);
            const status = statusParts.length
              ? ` · ${statusParts.join(", ")}`
              : "";
            lines.push(
              truncLine(
                `${ind}${theme.fg("muted", `${p.activities.length} tool${p.activities.length > 1 ? "s" : ""}: ${nameList}${status}`)}`,
                w,
              ),
            );
          }

          // Surface errors even when output exists (agent may have emitted text before failing).
          if (r && "error" in r && r.error) {
            lines.push(truncLine(`${ind}${theme.fg("error", r.error)}`, w));
          }
          // Collapsed: one-line output preview so a human scanning the TUI sees
          // the payoff without expanding every task. Expanded mode renders the
          // full markdown below instead.
          if (!options.expanded && p.status === "done") {
            const preview =
              r && "output" in r
                ? previewOutputLine(r.output ?? "", w - ind.length - 3)
                : "";
            if (preview) {
              lines.push(
                truncLine(
                  `${ind}${theme.fg("muted", `⎿ ${preview}`)}`,
                  w,
                ),
              );
            }
          }
          // Output: render markdown only in expanded mode.
          if (
            r &&
            "output" in r &&
            r.output?.trim() &&
            r.output !== "(no output)" &&
            options.expanded
          ) {
            const cacheKey = `md_${i}_${options.expanded ? "exp" : "col"}_${w - ind.length}`;
            let mdLines: string[] | undefined = state[cacheKey] as
              | string[]
              | undefined;
            if (!mdLines || state[`${cacheKey}_src`] !== r.output) {
              const md = new Markdown(
                r.output.trim(),
                0,
                0,
                getMarkdownTheme(),
              );
              mdLines = md.render(Math.max(20, w - ind.length));
              state[`${cacheKey}_src`] = r.output;
              state[cacheKey] = mdLines;
            }
            for (const line of mdLines) {
              lines.push(truncLine(ind + line, w));
            }
          }
          // Visual separator between tasks — only in expanded mode.
          if (options.expanded) lines.push("");
        }

        // Prevent terminal overflow — preserve blank lines for visual spacing
        const budgeted = applyLineBudget(lines, options.expanded ?? false);
        lines.length = 0;
        lines.push(...budgeted);
      }

      text.setText(lines.join("\n"));
      return text;
    },
  });

  // ── Session shutdown: abort all running async tickets ───────────────
  pi.on("session_shutdown", () => {
    for (const ticket of ticketRegistry.values()) {
      if (ticket.status === "running") {
        ticket.controller.abort();
        ticket.status = "cancelled";
        ticket.completedAt = Date.now();
      }
    }
    // Do NOT clear the entire registry here — only abort running tickets.
    // Cleared tickets are cleaned up by sweepTickets() TTL.
  });
}

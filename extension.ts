import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  handleCancel,
  handlePoll,
  handleWait,
  cancelTicketForShutdown,
  ticketRegistry,
} from "./tickets.ts";
import { discoverAgents } from "./agents.ts";
import { getSubagentManualMarkdown } from "./manual.ts";
import {
  delegateArgumentsSchema,
  normalizeDelegateArguments,
  validateDelegateOperation,
} from "./schema.ts";
import { validateTasks, resolveTasks } from "./task-resolution.ts";
import {
  initProgress,
  makeFireUpdater,
  dispatchAsync,
  dispatchSync,
  type AsyncDispatchInput,
  type SyncDispatchInput,
} from "./dispatch.ts";
import { renderDelegateCall, renderDelegateResult } from "./render-result.ts";
import { hostCompatError } from "./host-compat.ts";
import { closeAllPooledAgents } from "./pool.ts";
import type { DelegateArguments } from "./types.ts";

export default function delegateExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate to Subagents",
    description:
      "Run parallel subagents via tasks:[{prompt}]. Sync returns results; async returns a ticket.",
    parameters: delegateArgumentsSchema,
    // Runs before schema validation — recovers stringified `tasks` arrays
    // (a common model mistake that would otherwise be rejected upstream).
    prepareArguments: normalizeDelegateArguments,

    async execute(_id, params: DelegateArguments, signal, onUpdate, ctx) {
      const parentModelId = ctx.model?.id;
      const tasks = params.tasks ?? [];

      const operationError = validateDelegateOperation(params);
      if (operationError) {
        return {
          content: [
            { type: "text", text: `Invalid delegate call: ${operationError}` },
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId,
          },
        };
      }

      // ── Poll action ───────────────────────────────────────────────────
      if (params.action === "poll") {
        return handlePoll(params, ctx);
      }

      // ── Cancel action ─────────────────────────────────────────────────
      if (params.action === "cancel") {
        return handleCancel(params);
      }

      // ── Wait action ────────────────────────────────────────────────────
      if (params.action === "wait") {
        return handleWait(params, signal, onUpdate, ctx);
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

      // ── Host compatibility ────────────────────────────────────────
      // Guard against pi dropping/renaming a symbol this extension imports
      // (version skew between the installed pi and the bundle's build target).
      // Surfaces a clear, actionable error instead of a cryptic
      // `undefined.create` deep in dispatch. Cached after the first call.
      const compatError = hostCompatError();
      if (compatError) return compatError;

      // ── Validate ──────────────────────────────────────────────────
      const validationError = validateTasks(tasks, agents, parentModelId);
      if (validationError) return validationError;

      // ── Resolve tasks ─────────────────────────────────────────────
      const resolved = resolveTasks(tasks, ctx, agents);

      // ── Progress tracking ─────────────────────────────────────────
      const progress = initProgress(resolved);
      const fire = makeFireUpdater(
        onUpdate,
        tasks,
        progress,
        resolved,
        parentModelId,
      );
      fire();

      // ── Async mode ───────────────────────────────────────────────────
      if (params.async) {
        const asyncInput: AsyncDispatchInput = {
          pi,
          ctx,
          tasks,
          resolved,
          progress,
          parentModelId,
        };
        return dispatchAsync(asyncInput);
      }

      // ── Sync mode ─────────────────────────────────────────────────
      const syncInput: SyncDispatchInput = {
        ctx,
        tasks,
        resolved,
        progress,
        parentModelId,
        signal,
        fire,
      };
      return dispatchSync(syncInput);
    },

    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,
  });

  // ── Session shutdown: abort tickets and dispose live pooled sessions ──
  pi.on("session_shutdown", async () => {
    for (const ticket of ticketRegistry.values()) {
      cancelTicketForShutdown(ticket);
    }
    // Do NOT clear the ticket registry here — completed tickets are retained
    // until their TTL cleanup. Pooled AgentSessions, however, own listeners
    // and must be disposed before the parent session exits.
    await closeAllPooledAgents();
  });
}

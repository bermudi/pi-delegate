import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { handleCancel, handlePoll, ticketRegistry } from "./tickets.ts";
import { discoverAgents } from "./agents.ts";
import { delegateParameters, getSubagentManualMarkdown } from "./manual.ts";
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
import type { DelegateParams } from "./types.ts";

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

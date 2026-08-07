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
} from "./schema.ts";
import {
  dispatchDelegate,
  validateDelegateOperationResult,
} from "./dispatch.ts";
import { renderDelegateCall, renderDelegateResult } from "./render-result.ts";
import { hostCompatError } from "./host-compat.ts";
import { invalidateHostDepsCache } from "./host.ts";
import { closeAllPooledAgents } from "./pool.ts";
import {
  activeTicketSummary,
  clearDelegateStatusContext,
  describeActiveTickets,
  guardSessionReplacement,
  notifyActiveTicketsOnSettled,
  syncDelegateStatus,
} from "./status.ts";
import type { DelegateArguments } from "./types.ts";

/** Register the delegate tool and clean up its parent-session resources. */
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
      // Guard against pi dropping/renaming a symbol this extension imports
      // before any operation-specific validation or early return.
      const compatError = hostCompatError();
      if (compatError) return compatError;

      const parentModelId = ctx.model?.id;
      const tasks = params.tasks ?? [];

      const operationResult = validateDelegateOperationResult(
        params,
        parentModelId,
      );
      if (operationResult) return operationResult;

      // ── Poll action ───────────────────────────────────────────────────
      if (params.action === "poll") {
        return handlePoll(params, ctx);
      }

      // ── Cancel action ─────────────────────────────────────────────────
      if (params.action === "cancel") {
        const result = handleCancel(params);
        // A forced cancel flips the ticket to "cancelling" — keep the
        // footer status in step (deduped; the preview path is a no-op).
        syncDelegateStatus();
        return result;
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

      // Cache the full ExtensionContext for the footer-status module before
      // dispatch narrows it to DelegateToolCtx (which has no `ui`). The
      // status push itself is a deduped no-op here; dispatchAsync re-syncs
      // after registering its ticket.
      syncDelegateStatus(ctx);

      // Keep expensive host deps shared within this dispatch, not indefinitely
      // across dispatches: edits to auth/models/settings/context files must be
      // visible without restarting Pi.
      invalidateHostDepsCache();
      return dispatchDelegate({
        pi,
        params,
        ctx,
        agents,
        parentModelId,
        signal,
        onUpdate,
      });
    },

    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,
  });

  // ── Background-work visibility (see status.ts) ──────────────────────────
  // The turn settling with live tickets is the "looks idle but isn't" moment:
  // warn once per ticket. The footer status carries it from there.
  pi.on("agent_settled", (_event, ctx) => {
    notifyActiveTicketsOnSettled(ctx);
  });

  // Session replacements are cancellable — confirm before killing live work.
  pi.on("session_before_switch", (_event, ctx) =>
    guardSessionReplacement(ctx, "switch"),
  );
  pi.on("session_before_fork", (_event, ctx) =>
    guardSessionReplacement(ctx, "fork"),
  );

  // ── Session shutdown: abort tickets and dispose live pooled sessions ──
  pi.on("session_shutdown", async (event, ctx) => {
    // Quit and /reload kill background work with no cancellable hook, so
    // leave a trace. For quit the TUI is already stopped — stderr lands in
    // the scrollback. For reload the TUI survives — warn in place. Switch
    // and fork already passed the confirm guard above.
    const active = activeTicketSummary();
    if (active.tickets.length) {
      if (event.reason === "quit") {
        console.error(
          `[delegate] pi exited with ${describeActiveTickets(active)} — aborted.`,
        );
      } else if (event.reason === "reload") {
        ctx.ui.notify(
          `[delegate] reload aborted ${describeActiveTickets(active)}`,
          "warning",
        );
      }
    }
    for (const ticket of ticketRegistry.values()) {
      cancelTicketForShutdown(ticket);
    }
    syncDelegateStatus(ctx);
    // The runtime is invalidated right after this handler returns; aborted
    // tickets keep unwinding asynchronously and must find no cached ctx (or
    // captured pi) to touch. See the "cancelled"-at-entry guard in dispatch.
    clearDelegateStatusContext();
    // Do NOT clear the ticket registry here — completed tickets are retained
    // until their TTL cleanup. Pooled AgentSessions, however, own listeners
    // and must be disposed before the parent session exits.
    //
    // closeAllPooledAgents attempts every session (Promise.allSettled) before
    // aggregating failures into an AggregateError, so swallowing here does not
    // abandon remaining cleanup. Catch and log so a wedged session's failure
    // stays observable instead of becoming an unhandled rejection — pi.on is
    // EventEmitter-style and does not surface handler rejections — and so
    // shutdown completes even when one pooled session failed to abort/dispose.
    try {
      await closeAllPooledAgents();
    } catch (error) {
      const failures = error instanceof AggregateError ? error.errors : [error];
      console.error(
        "[delegate] pooled-session cleanup failed during shutdown:",
        failures,
      );
    }
  });
}

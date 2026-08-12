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
import { recordTreeNavigation, resetLeafTracking } from "./leaf.ts";
import { closeAllPooledAgents } from "./pool.ts";
import {
  activeTicketSummary,
  clearDelegateStatusContext,
  describeActiveTickets,
  guardSessionReplacement,
  guardTreeNavigation,
  notifyActiveTicketsOnSettled,
  syncDelegateStatus,
} from "./status.ts";
import { beginCall } from "./telemetry.ts";
import type { DelegateArguments } from "./types.ts";

/** Register the delegate tool and clean up its parent-session resources. */
export default function delegateExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate to Subagents",
    description:
      "Run parallel subagents via tasks:[{prompt}]. Sync returns results; async=ticket. tasks:[]=full manual.",
    parameters: delegateArgumentsSchema,
    // Runs before schema validation — recovers stringified `tasks` arrays
    // (a common model mistake that would otherwise be rejected upstream).
    prepareArguments: normalizeDelegateArguments,

    async execute(_id, params: DelegateArguments, signal, onUpdate, ctx) {
      const parentModelId = ctx.model?.id;
      const tasks = params.tasks ?? [];
      const parentSessionFile = (
        ctx as { sessionManager?: { getSessionFile?(): string | undefined } }
      ).sessionManager?.getSessionFile?.();

      let mode: string;
      if (params.ticketAction) {
        mode = params.ticketAction;
      } else if (tasks.length === 0) {
        mode = "manual";
      } else if (params.async) {
        mode = "async";
      } else {
        mode = "sync";
      }
      const taskCount = params.ticketAction ? 0 : tasks.length;
      const callSpan = beginCall({
        parentModel: parentModelId,
        mode,
        taskCount,
        parentSessionFile,
      });

      function failCall(): void {
        callSpan.finish({
          status: "failed",
          totalTokens: 0,
          totalCost: 0,
          wallMs: Date.now() - callSpan.startedAt,
        });
      }

      function succeedCall(): void {
        callSpan.finish({
          status: "success",
          totalTokens: 0,
          totalCost: 0,
          wallMs: Date.now() - callSpan.startedAt,
        });
      }

      // Guard against pi dropping/renaming a symbol this extension imports
      // before any operation-specific validation or early return.
      const compatError = hostCompatError();
      if (compatError) {
        failCall();
        return compatError;
      }

      const operationResult = validateDelegateOperationResult(
        params,
        parentModelId,
      );
      if (operationResult) {
        failCall();
        return operationResult;
      }

      // ── Poll action ───────────────────────────────────────────────────
      if (params.ticketAction === "poll") {
        const result = handlePoll(params, ctx);
        succeedCall();
        return result;
      }

      // ── Cancel action ─────────────────────────────────────────────────
      if (params.ticketAction === "cancel") {
        const result = handleCancel(params);
        // A forced cancel flips the ticket to "cancelling" — keep the
        // footer status in step (deduped; the preview path is a no-op).
        syncDelegateStatus(ctx);
        succeedCall();
        return result;
      }

      // ── Wait action ────────────────────────────────────────────────────
      if (params.ticketAction === "wait") {
        try {
          const result = await handleWait(params, signal, onUpdate, ctx);
          succeedCall();
          return result;
        } catch (err) {
          failCall();
          throw err;
        }
      }

      // Agent discovery is intentionally parent-cwd-scoped: agent profiles are a
      // session-level resource, not per-task. Per-task cwd governs settings,
      // and AGENTS.md resolution (see resolveCwd below), but not which
      // named agents exist. Changing this would let a task's throwaway cwd
      // silently swap the agent roster.
      const agents = discoverAgents(ctx.cwd);

      // ── Help mode ─────────────────────────────────────────────────
      if (!tasks.length) {
        succeedCall();
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
      try {
        return await dispatchDelegate({
          pi,
          params,
          ctx,
          agents,
          parentModelId,
          parentDefaults: {
            thinking: pi.getThinkingLevel(),
            tools: pi.getActiveTools(),
          },
          signal,
          onUpdate,
          callSpan,
        });
      } catch (err) {
        failCall();
        throw err;
      }
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

  // /tree navigation stays inside the same session: nothing is torn down and
  // live tickets keep running, but their results would land on the branch the
  // user moves to. Ask first, and record the new leaf either way so delivery
  // can detect the mismatch (issue #30). `session_tree` also fires for
  // extension-driven ctx.navigateTree, which never reaches the guard.
  pi.on("session_before_tree", (_event, ctx) => guardTreeNavigation(ctx));
  pi.on("session_tree", (event, ctx) => {
    recordTreeNavigation(event.newLeafId);
    syncDelegateStatus(ctx);
  });

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
    // A replacement session starts on its own leaf; stale tracking would make
    // every ticket look cross-leaf (or, worse, look same-leaf by accident).
    resetLeafTracking();
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

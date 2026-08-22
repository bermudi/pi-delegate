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
import {
  renderAsyncDelegateMessage,
  renderDelegateCall,
  renderDelegateResult,
} from "./render-result.ts";
import { hostCompatError } from "./host-compat.ts";
import { invalidateHostDepsCache } from "./host.ts";
import { registerProviderExtensionNotifier } from "./provider-extensions.ts";
import { recordTreeNavigation, resetLeafTracking } from "./leaf.ts";
import { closeAllPooledAgents } from "./pool.ts";
import { reconfigureGlobalConcurrency } from "./concurrency.ts";
import { reloadDelegateConfig, getMaxConcurrent } from "./config.ts";
import { warnLegacyDelegateSettingsMoved } from "./settings.ts";
import {
  activeTicketSummary,
  clearDelegateStatusContext,
  describeActiveTickets,
  guardSessionReplacement,
  guardTreeNavigation,
  notifyActiveTicketsOnSettled,
  syncDelegateStatus,
} from "./status.ts";
import {
  beginCall,
  closeTelemetry,
  getTelemetryGeneration,
  prepareTelemetryForSession,
  sealTelemetryWrites,
} from "./telemetry.ts";
import type { DelegateArguments, DelegateDetails } from "./types.ts";

const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
let shutdownDrainTimeoutMs = DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;

type ShutdownDrainResult =
  { drained: true; failures: unknown[] } | { drained: false; failures: [] };

/** Wait for shutdown workers without allowing a stuck provider/tool to hold
 * Pi's reload or exit hostage. The allSettled promise is intentionally left
 * attached after timeout so a late rejection cannot become unhandled. */
export async function drainAsyncTickets(
  completions: readonly Promise<void>[],
  timeoutMs = shutdownDrainTimeoutMs,
): Promise<ShutdownDrainResult> {
  if (!completions.length) return { drained: true, failures: [] };

  const drain = Promise.allSettled(completions).then((results) => ({
    drained: true as const,
    failures: results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason),
  }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ShutdownDrainResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ drained: false, failures: [] }),
      timeoutMs,
    );
  });
  const result = await Promise.race([drain, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

/** Wait for another shutdown cleanup operation without allowing a stuck
 * session lock to hold reload/quit forever. Rejection is consumed here; the
 * caller reports it when it wins the race, and a late rejection stays handled.
 */
async function boundedShutdownCleanup(
  cleanup: Promise<void>,
  timeoutMs = shutdownDrainTimeoutMs,
): Promise<"settled" | "timed-out" | "failed"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = cleanup.then(
    () => "settled" as const,
    () => "failed" as const,
  );
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  const result = await Promise.race([outcome, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

/** @internal Test-only timeout override. */
export function _setShutdownDrainTimeoutForTesting(
  timeoutMs: number | undefined,
): void {
  shutdownDrainTimeoutMs = timeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
}

/** Register the delegate tool and clean up its parent-session resources. */
export default function delegateExtension(pi: ExtensionAPI): void {
  // A /reload can reuse this module instance after the previous runtime closed
  // its SQLite handle. Permit the new runtime to open a fresh backend; stale
  // workers from the old runtime remain blocked from reopening it.
  prepareTelemetryForSession();

  // Async completion arrives as a custom message after the original tool call
  // has returned. Give it the same compact/expanded UI as sync results while
  // leaving the full message intact for model context.
  pi.registerMessageRenderer<DelegateDetails>(
    "async_delegate_result",
    renderAsyncDelegateMessage,
  );

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
      // Reload user-edited delegate.json at the start of every execution.
      // Help, poll, cancel, wait, and invalid calls observe new settings, and
      // the global concurrency cap is reconfigured so hot-reloaded maxConcurrent
      // takes effect for subsequent acquisitions. A parse/read error keeps the
      // previous snapshot and warns instead of falling back to defaults.
      warnLegacyDelegateSettingsMoved(ctx.cwd, (message) =>
        ctx.ui.notify(message, "warning"),
      );
      reloadDelegateConfig();
      reconfigureGlobalConcurrency(getMaxConcurrent());

      // Prime the UI notice for best-effort provider extensions that load for
      // subagents (host.ts consumes it where the fact is discovered). Every
      // execute re-primes so a stale ctx never sticks.
      registerProviderExtensionNotifier((message) =>
        ctx.ui.notify(message, "info"),
      );
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

  // A reload may rebuild the extension runtime without re-invoking this
  // module's default export. Re-open telemetry only after the prior shutdown
  // handler has drained old workers and closed its connection.
  pi.on("session_start", () => {
    prepareTelemetryForSession();
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
    const shutdownGeneration = getTelemetryGeneration();
    const shutdownDeadline = Date.now() + shutdownDrainTimeoutMs;
    const ticketCompletions: Promise<void>[] = [];
    let drainAttempted = false;
    let telemetrySealed = false;

    try {
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
          try {
            ctx.ui.notify(
              `[delegate] reload aborted ${describeActiveTickets(active)}`,
              "warning",
            );
          } catch (error) {
            console.error(
              "[delegate] reload shutdown notification failed",
              error,
            );
          }
        }
      }

      for (const ticket of ticketRegistry.values()) {
        if (ticket.status === "running" || ticket.status === "cancelling") {
          cancelTicketForShutdown(ticket);
        }
        // Include already-cancelled tickets too: a repeated shutdown event can
        // race the first handler while its workers are still unwinding.
        if (ticket.completion) ticketCompletions.push(ticket.completion);
      }
      syncDelegateStatus(ctx);
      // The runtime is invalidated right after this handler returns; aborted
      // tickets keep unwinding asynchronously and must find no cached ctx (or
      // captured pi) to touch. The cancelled completion path still writes one
      // final aggregate after late task results arrive, but never delivers UI.
      clearDelegateStatusContext();
      registerProviderExtensionNotifier(undefined);
      // A replacement session starts on its own leaf; stale tracking would make
      // every ticket look cross-leaf (or, worse, look same-leaf by accident).
      resetLeafTracking();
      // Do NOT clear the ticket registry here — completed tickets are retained
      // until their TTL cleanup. Pooled AgentSessions, however, own listeners
      // and must be disposed before the parent session exits.
      //
      // Start pooled cleanup before waiting for ticket completion. Its immediate
      // abort requests can help a worker blocked on a pooled session unwind;
      // SQLite still stays open until both cleanup paths finish.
      let poolCleanup: Promise<void>;
      try {
        poolCleanup = closeAllPooledAgents();
      } catch (error) {
        console.error("[delegate] pooled-session shutdown start failed", error);
        poolCleanup = Promise.resolve();
      }
      // Drain cooperatively, but never let a provider/tool hold reload or
      // quit forever. A timed-out old runtime is sealed before a new one can
      // reopen telemetry; its eventual task completion remains harmless.
      drainAttempted = true;
      const drain = await drainAsyncTickets(
        ticketCompletions,
        Math.max(0, shutdownDeadline - Date.now()),
      );
      if (!drain.drained) {
        console.error(
          `[delegate] async-ticket shutdown drain exceeded ${shutdownDrainTimeoutMs}ms; continuing without late results`,
        );
        // Seal immediately, before waiting on pooled-session cleanup. A worker
        // that finishes during that second phase belongs to the old runtime
        // and must not write into a freshly reopened backend.
        telemetrySealed = sealTelemetryWrites(shutdownGeneration);
      } else if (drain.failures.length) {
        console.error(
          "[delegate] async-ticket cleanup failed during shutdown:",
          drain.failures,
        );
      }

      // closeAllPooledAgents attempts every session (Promise.allSettled) before
      // aggregating failures into an AggregateError, so swallowing here does
      // not abandon remaining cleanup.
      const poolResult = await boundedShutdownCleanup(
        poolCleanup,
        Math.max(0, shutdownDeadline - Date.now()),
      );
      if (poolResult === "timed-out") {
        console.error(
          `[delegate] pooled-session shutdown cleanup exceeded ${shutdownDrainTimeoutMs}ms; continuing`,
        );
      } else if (poolResult === "failed") {
        // closeAllPooledAgents aggregates every session failure before
        // rejecting, so the rejection is already a complete diagnostic.
        try {
          await poolCleanup;
        } catch (error) {
          const failures =
            error instanceof AggregateError ? error.errors : [error];
          console.error(
            "[delegate] pooled-session cleanup failed during shutdown:",
            failures,
          );
        }
      }
    } catch (error) {
      // pi.on is EventEmitter-style and does not surface handler rejections.
      // Keep shutdown moving, but leave the failure visible.
      console.error("[delegate] shutdown cleanup failed", error);
    } finally {
      if (!drainAttempted) {
        // An unexpected earlier cleanup failure must not leave a worker with an
        // unhandled rejection, but this fallback is bounded too.
        await drainAsyncTickets(
          ticketCompletions,
          Math.max(0, shutdownDeadline - Date.now()),
        );
      }
      // Once the bounded drain expires, old workers may still unwind. Seal
      // their generation before closing SQLite so a later runtime cannot
      // receive stale task/call writes.
      if (!telemetrySealed) {
        telemetrySealed = sealTelemetryWrites(shutdownGeneration);
      }
      closeTelemetry(shutdownGeneration);
    }
  });
}

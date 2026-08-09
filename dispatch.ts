import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  ticketRegistry,
  generateTicketId,
  deliverTicketResults,
  sweepTickets,
  resolveFinalTicketStatus,
  syncTicketBusyIndex,
  notifyWaiters,
} from "./tickets.ts";
import { getConcurrencyLimit, getMaxAsyncTickets } from "./config.ts";
import { getModelKey, mapConcurrentByModel } from "./concurrency.ts";
import { sumUsage } from "./usage.ts";
import { runResolvedTask, updateProgressFromRun } from "./lifecycle.ts";
import {
  fmtDuration,
  formatCompletedTask,
  trunc,
  findTouchedOverlaps,
  formatTouchedOverlapWarning,
} from "./format.ts";
import { validateDelegateOperation } from "./schema.ts";
import { syncDelegateStatus } from "./status.ts";
import { validateTasks, resolveTasks } from "./task-resolution.ts";
import type {
  AgentConfig,
  AsyncTicket,
  DelegateArguments,
  DelegateDetails,
  DelegateToolCtx,
  DelegateToolResult,
  ParentAgentDefaults,
  ResolvedTask,
  TaskDef,
  TaskProgress,
  TaskResult,
  TaskRunEnv,
} from "./types.ts";

/** Return the structured result for an invalid top-level operation, or null when
 * the call may proceed to a ticket control/help/dispatch path. */
export function validateDelegateOperationResult(
  params: DelegateArguments,
  parentModelId: string | undefined,
): DelegateToolResult | null {
  const operationError = validateDelegateOperation(params);
  if (!operationError) return null;

  return {
    content: [
      { type: "text", text: `Invalid delegate call: ${operationError}` },
    ],
    details: {
      tasks: params.tasks ?? [],
      results: [],
      progress: [],
      parentModel: parentModelId,
    },
  };
}

/** Build the initial per-task progress rows from resolved tasks. */
export function initProgress(resolved: ResolvedTask[]): TaskProgress[] {
  return resolved.map((t, i) => ({
    id: t.id,
    index: i,
    agent: t.agentName,
    task: trunc(t.prompt || t.sessionAction || "", 50),
    status: "pending" as const,
    durationMs: 0,
    tokens: 0,
    toolUses: 0,
    activities: [],
    model: t.model?.id,
    warnings: t.warnings.length ? [...t.warnings] : undefined,
  }));
}

/** Construct the `fire()` updater that pushes a "Running N subagents" progress
 *  frame to the parent TUI. Used for the initial dispatch frame and (in sync
 *  mode) after every progress/status mutation. */
export function makeFireUpdater(
  onUpdate: AgentToolUpdateCallback<DelegateDetails> | undefined,
  tasks: TaskDef[],
  progress: TaskProgress[],
  resolved: ResolvedTask[],
  parentModelId: string | undefined,
): () => void {
  return () =>
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
}

/** Inputs needed by the async (fire-and-forget) dispatch path. */
export interface AsyncDispatchInput {
  pi: ExtensionAPI;
  ctx: DelegateToolCtx;
  tasks: TaskDef[];
  resolved: ResolvedTask[];
  progress: TaskProgress[];
  parentModelId: string | undefined;
}

/** Inputs needed by the sync (blocking) dispatch path. */
export interface SyncDispatchInput {
  ctx: DelegateToolCtx;
  tasks: TaskDef[];
  resolved: ResolvedTask[];
  progress: TaskProgress[];
  parentModelId: string | undefined;
  signal: AbortSignal | undefined;
  fire: () => void;
}

/** Inputs for the normal task-validation, resolution, and dispatch path. */
export interface DelegateDispatchInput {
  pi: ExtensionAPI;
  params: DelegateArguments;
  ctx: DelegateToolCtx;
  agents: Map<string, AgentConfig>;
  parentModelId: string | undefined;
  parentDefaults: ParentAgentDefaults;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<DelegateDetails> | undefined;
}

/** Validate, resolve, and dispatch a non-short-circuit delegate operation. */
export async function dispatchDelegate(
  input: DelegateDispatchInput,
): Promise<DelegateToolResult> {
  const {
    pi,
    params,
    ctx,
    agents,
    parentModelId,
    parentDefaults,
    signal,
    onUpdate,
  } = input;
  const tasks = params.tasks ?? [];

  const validationError = validateTasks(tasks, agents, parentModelId);
  if (validationError) return validationError;

  const resolved = resolveTasks(tasks, ctx, agents, parentDefaults);
  const progress = initProgress(resolved);
  const fire = makeFireUpdater(
    onUpdate,
    tasks,
    progress,
    resolved,
    parentModelId,
  );
  fire();

  if (params.async) {
    return dispatchAsync({
      pi,
      ctx,
      tasks,
      resolved,
      progress,
      parentModelId,
    });
  }

  return dispatchSync({
    ctx,
    tasks,
    resolved,
    progress,
    parentModelId,
    signal,
    fire,
  });
}

/** Fire-and-forget background execution. Registers an `AsyncTicket`, kicks off
 *  the concurrent run, and returns the ticket acknowledgment immediately.
 *  Results are delivered via `deliverTicketResults` when all tasks settle. */
export function dispatchAsync(input: AsyncDispatchInput): DelegateToolResult {
  const { pi, ctx, tasks, resolved, progress, parentModelId } = input;

  sweepTickets();
  const runningCount = [...ticketRegistry.values()].filter(
    (t) => t.status === "running" || t.status === "cancelling",
  ).length;
  if (runningCount >= getMaxAsyncTickets()) {
    return {
      content: [
        {
          type: "text",
          text: `Too many async tickets running or cancelling (${runningCount}/${getMaxAsyncTickets()}). Poll existing tickets or cancel one first.`,
        },
      ],
      details: { tasks, results: [], progress: [], parentModel: parentModelId },
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
  // Footer visibility for the new background work (see status.ts). Uses the
  // ctx cached from the dispatch path in extension.ts — DelegateToolCtx is
  // the intentionally narrowed surface and does not carry `ui`.
  syncDelegateStatus();

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
      notifyWaiters(ticket);
      // Live subagent counts in the footer. Deduped by text, so only
      // running/pending count transitions trigger a render.
      syncDelegateStatus();
    },
    onStatusChange: () => {
      notifyWaiters(ticket);
      syncDelegateStatus();
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
      const result = await runResolvedTask(asyncEnv, t, ticket.progress[i]!, i);
      ticket.results[i] = result;
      return result;
    },
    ticketSignal,
  )
    .then(() => {
      // A ticket that is already terminally "cancelled" at this point was
      // finalized by cancelTicketForShutdown (user cancels pass through
      // "cancelling" first): the extension runtime is being torn down, the
      // captured `pi` is stale or about to be, and a follow-up message has
      // no live session to land in. Skip delivery entirely.
      if (ticket.status === "cancelled") return;
      // All tasks settled — determine final ticket status.
      // Use progress (set by runResolvedTask) for settled-ness so the
      // status reflects work completion, not just result-array density.
      // A partial ticket (not all settled, e.g. aborted mid-flight) must
      // NOT be marked "done" — that would mask incomplete work as
      // complete. resolveFinalTicketStatus returns "failed" for that
      // case and for any case with a failed task.
      if (ticket.status === "running") {
        ticket.status = resolveFinalTicketStatus(ticket);
        ticket.completedAt = Date.now();
        syncTicketBusyIndex(ticket);
      } else if (ticket.status === "cancelling") {
        // Cancellation was requested while tasks were still settling. The
        // per-task results record what actually happened; the ticket state
        // reports that the batch was aborted by the caller.
        ticket.status = "cancelled";
        ticket.completedAt = Date.now();
        syncTicketBusyIndex(ticket);
      }
      syncDelegateStatus();
      deliverTicketResults(pi, ticket);
    })
    .catch((err) => {
      // Defense-in-depth — should not happen if individual tasks catch properly.
      // Same shutdown guard as the .then path above.
      if (ticket.status === "cancelled") return;
      if (ticket.status === "cancelling") {
        ticket.status = "cancelled";
      } else if (ticket.status === "running") {
        ticket.status = "failed";
      }
      ticket.error = err instanceof Error ? err.message : String(err);
      ticket.completedAt = Date.now();
      syncTicketBusyIndex(ticket);
      syncDelegateStatus();
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
          `Check progress: delegate({ ticketAction: "poll", ticket: "${ticketId}" }) — avoid polling in a tight loop`,
          `Cancel if needed: delegate({ ticketAction: "cancel", ticket: "${ticketId}", force: true }) — first call without force is a preview`,
        ].join("\n"),
      },
    ],
    details: {
      tasks,
      results: [],
      progress: [...progress],
      parentModel: parentModelId,
      ticketId,
      status: ticket.status,
    },
  };
}

/** Synchronous concurrent execution — awaits all tasks and formats the
 * combined LLM-facing result. Pooled sessions remain live until closed. */
export async function dispatchSync(
  input: SyncDispatchInput,
): Promise<DelegateToolResult> {
  const { ctx, tasks, resolved, progress, parentModelId, signal, fire } = input;

  const startedAt = Date.now();
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
  );

  // ── Format for LLM ────────────────────────────────────────────
  const finalResults: TaskResult[] = results;
  const elapsedTotal = Date.now() - startedAt;

  const parts: string[] = [];
  const succeeded = finalResults.filter((r) => !r.error).length;
  parts.push(
    `${succeeded}/${finalResults.length} tasks completed successfully · ${fmtDuration(elapsedTotal)} wall time\n`,
  );
  for (let i = 0; i < finalResults.length; i++) {
    const r = finalResults[i]!;
    const t = resolved[i]!;
    parts.push(...formatCompletedTask(t, r));
  }

  const overlapWarning = formatTouchedOverlapWarning(
    findTouchedOverlaps(finalResults),
  );
  if (overlapWarning) parts.push("", overlapWarning);

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    details: {
      tasks,
      results: finalResults,
      progress,
      parentModel: parentModelId,
      overlapWarning: overlapWarning || undefined,
    },
    // Aggregate subagent spend so Pi folds it into the parent's
    // session/footer totals. Sync dispatch only — async results arrive via a
    // follow-up message that has no usage slot (see DelegateToolResult).
    usage: sumUsage(finalResults.map((r) => r.usage)),
  };
}

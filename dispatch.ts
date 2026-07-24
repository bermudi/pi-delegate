import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { sweepPool } from "./pool.ts";
import {
  ticketRegistry,
  generateTicketId,
  deliverTicketResults,
  sweepTickets,
  resolveFinalTicketStatus,
  syncTicketBusyIndex,
} from "./tickets.ts";
import { getConcurrencyLimit, getMaxAsyncTickets } from "./config.ts";
import { getModelKey, mapConcurrentByModel } from "./concurrency.ts";
import { sumUsage } from "./usage.ts";
import { runResolvedTask, updateProgressFromRun } from "./lifecycle.ts";
import { fmtDuration, formatCompletedTask, trunc } from "./format.ts";
import type {
  AsyncTicket,
  DelegateDetails,
  DelegateToolCtx,
  DelegateToolResult,
  ResolvedTask,
  TaskDef,
  TaskProgress,
  TaskResult,
  TaskRunEnv,
} from "./types.ts";

/** Build the initial per-task progress rows from resolved tasks. */
export function initProgress(resolved: ResolvedTask[]): TaskProgress[] {
  return resolved.map((t, i) => ({
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

/** Fire-and-forget background execution. Registers an `AsyncTicket`, kicks off
 *  the concurrent run, and returns the ticket acknowledgment immediately.
 *  Results are delivered via `deliverTicketResults` when all tasks settle. */
export function dispatchAsync(input: AsyncDispatchInput): DelegateToolResult {
  const { pi, ctx, tasks, resolved, progress, parentModelId } = input;

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
      const result = await runResolvedTask(asyncEnv, t, ticket.progress[i]!, i);
      ticket.results[i] = result;
      return result;
    },
    ticketSignal,
  )
    .then(() => {
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
      }
      deliverTicketResults(pi, ticket);
    })
    .catch((err) => {
      // Defense-in-depth — should not happen if individual tasks catch properly
      ticket.status = "failed";
      ticket.error = err instanceof Error ? err.message : String(err);
      ticket.completedAt = Date.now();
      syncTicketBusyIndex(ticket);
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

/** Synchronous concurrent execution — awaits all tasks and formats the
 *  combined LLM-facing result. Sweeps stale pooled agents before dispatch. */
export async function dispatchSync(
  input: SyncDispatchInput,
): Promise<DelegateToolResult> {
  const { ctx, tasks, resolved, progress, parentModelId, signal, fire } = input;

  // Sweep stale pooled agents before dispatching.
  sweepPool();

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

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    details: {
      tasks,
      results: finalResults,
      progress,
      parentModel: parentModelId,
    },
    // Aggregate subagent spend so Pi folds it into the parent's
    // session/footer totals. Sync dispatch only — async results arrive via a
    // follow-up message that has no usage slot (see DelegateToolResult).
    usage: sumUsage(finalResults.map((r) => r.usage)),
  };
}

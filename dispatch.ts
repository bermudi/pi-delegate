import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  ticketRegistry,
  generateTicketId,
  deliverTicketResults,
  sweepTickets,
  resolveFinalTicketStatus,
  settleTicket,
  notifyWaiters,
} from "./tickets.ts";
import {
  getConcurrencyLimit,
  getMaxAsyncTickets,
  getDelegateConfigSnapshot,
  getTelemetryConfig,
} from "./config.ts";
import type { DelegateConfig } from "./config.ts";
import { getCurrentLeafId } from "./leaf.ts";
import { getModelKey, mapConcurrentByModel } from "./concurrency.ts";
import { aggregateTaskResults, sumUsage } from "./usage.ts";
import { runResolvedTask, updateProgressFromRun } from "./lifecycle.ts";
import {
  fmtDuration,
  formatCompletedTask,
  trunc,
  findTouchedOverlaps,
  formatTouchedOverlapWarning,
} from "./format.ts";
import { validateDelegateOperation } from "./schema.ts";
import { notifyCrossLeafDelivery, syncDelegateStatus } from "./status.ts";
import { validateTasks, resolveTasks } from "./task-resolution.ts";
import {
  findSharedWriteConflicts,
  isSharedWriter,
  type SharedWriteConflict,
} from "./shared-write-safety.ts";
import type { CallSpan } from "./telemetry.ts";
import { prepareIsolatedBatch } from "./isolated-workspace.ts";
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

const UNSAFE_SHARED_WRITES_WARNING =
  "UNSAFE SHARED WRITES ENABLED: shared-write admission is bypassed. Delegate provides no isolation or rollback.";

interface ActiveSyncDispatch {
  tasks: TaskDef[];
  resolved: ResolvedTask[];
}

const activeSyncDispatches = new Map<symbol, ActiveSyncDispatch>();
let sharedWriteAdmissionTail: Promise<void> = Promise.resolve();

/** Serialize the preflight snapshot and publication step. The lock is held only
 * during admission, never while subagents run. This prevents two concurrent
 * calls from both inspecting an empty active set and then starting together. */
async function withSharedWriteAdmissionLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sharedWriteAdmissionTail;
  let release!: () => void;
  sharedWriteAdmissionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

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
  dispatchWarning?: string,
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
        dispatchWarning,
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
  callSpan?: CallSpan;
  dispatchConfig: DelegateConfig;
  dispatchWarning?: string;
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
  callSpan?: CallSpan;
  dispatchConfig: DelegateConfig;
  dispatchWarning?: string;
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
  callSpan?: CallSpan;
}

function taskReference(task: TaskDef, index: number): string {
  return `Task ${index + 1}${task.id ? `#${task.id}` : ""}`;
}

/** Isolated workers do not share their worktrees with each other, but their
 * source root must remain reserved against shared writers until ordered apply
 * finishes. Represent them as shared only inside the admission index. */
function asAdmissionWriter(task: ResolvedTask): ResolvedTask {
  return task.workspace === "isolated"
    ? { ...task, workspace: "shared" }
    : task;
}

function sharedWriteRejection(
  tasks: TaskDef[],
  parentModelId: string | undefined,
  conflicts: SharedWriteConflict[],
  references: readonly string[] = tasks.map(taskReference),
): DelegateToolResult {
  const scopes = conflicts
    .map(({ scope, taskIndexes }) => {
      const refs = taskIndexes
        .map((index) => references[index] ?? `Active writer ${index + 1}`)
        .join(", ");
      return `${refs} share ${scope.kind === "git" ? "Git root" : "directory"} '${scope.root}'.`;
    })
    .join(" ");
  return {
    content: [
      {
        type: "text",
        text:
          `Rejected before dispatch; no tasks were started. ${scopes} ` +
          "Each listed task has mutating or unclassified tool capability, so concurrent shared execution could silently overwrite work. " +
          'Run them sequentially, use workspace: "isolated" for Git-backed ordered reconciliation, or use workspace: "scratch" when changes may be discarded. ' +
          "External processes remain outside this check.",
      },
    ],
    details: { tasks, results: [], progress: [], parentModel: parentModelId },
  };
}

function sharedWriteSafetyFailure(
  tasks: TaskDef[],
  parentModelId: string | undefined,
  error: unknown,
): DelegateToolResult {
  const detail =
    error instanceof Error ? error.message : "Unknown workspace error.";
  return {
    content: [
      {
        type: "text",
        text:
          `Rejected before dispatch; no tasks were started because shared-write safety could not be verified. ${detail} ` +
          'Fix the task directory or Git metadata, run tasks sequentially, use workspace: "isolated" for Git-backed ordered reconciliation, or use workspace: "scratch" when changes may be discarded.',
      },
    ],
    details: { tasks, results: [], progress: [], parentModel: parentModelId },
  };
}

/** Validate, resolve, and dispatch a non-short-circuit delegate operation. */
export async function dispatchDelegate(
  input: DelegateDispatchInput,
): Promise<DelegateToolResult> {
  // The extension entry point already reloaded delegate.json and reconfigured
  // the global concurrency cap. Capture a dispatch-scoped snapshot here so the
  // retry/stall/output/provider settings stay immutable for every task in this
  // batch, even if a later dispatch mutates the global singleton while async
  // work is still in flight.
  const dispatchConfig = getDelegateConfigSnapshot();
  const {
    pi,
    params,
    ctx,
    agents,
    parentModelId,
    parentDefaults,
    signal,
    onUpdate,
    callSpan,
  } = input;
  const tasks = params.tasks ?? [];

  const validationError = validateTasks(tasks, agents, parentModelId);
  if (validationError) {
    callSpan?.finish({
      status: "failed",
      totalTokens: 0,
      totalCost: 0,
      wallMs: Date.now() - callSpan.startedAt,
    });
    return validationError;
  }

  const resolved = resolveTasks(
    tasks,
    ctx,
    agents,
    parentDefaults,
    dispatchConfig,
  );
  if (params.async && resolved.some((task) => task.workspace === "isolated")) {
    callSpan?.finish({
      status: "failed",
      totalTokens: 0,
      totalCost: 0,
      wallMs: Date.now() - callSpan.startedAt,
    });
    return {
      content: [
        {
          type: "text",
          text: 'Invalid delegate call: workspace "isolated" is synchronous; remove async.',
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

  const dispatchWarning = dispatchConfig.allowUnsafeSharedWrites
    ? UNSAFE_SHARED_WRITES_WARNING
    : undefined;
  const signalWasAbortedBeforeAdmission = signal?.aborted === true;
  let syncReservation: symbol | undefined;
  let admissionResult:
    DelegateToolResult | { progress: TaskProgress[]; fire: () => void };

  try {
    admissionResult = await withSharedWriteAdmissionLock(async () => {
      // The call may have been cancelled while queued behind another
      // preflight. Async dispatch uses its own controller after publication, so
      // this check must happen before progress, reservations, or ticket
      // creation rather than relying on the parent signal downstream.
      if (!signalWasAbortedBeforeAdmission && signal?.aborted) {
        throw new Error("Delegate call aborted while waiting for admission.");
      }
      if (
        !dispatchConfig.allowUnsafeSharedWrites &&
        resolved.some((task) => isSharedWriter(asAdmissionWriter(task)))
      ) {
        const incomingForSafety = resolved.map(asAdmissionWriter);
        const activeResolved: ResolvedTask[] = [];
        const references = resolved.map((_, index) =>
          taskReference(tasks[index]!, index),
        );

        for (const ticket of ticketRegistry.values()) {
          if (
            ticket.status !== "running" &&
            ticket.status !== "cancelling" &&
            ticket.workersSettled !== false
          ) {
            continue;
          }
          for (let index = 0; index < ticket.resolved.length; index++) {
            activeResolved.push(ticket.resolved[index]!);
            references.push(
              `async ticket '${ticket.id}' ${taskReference(ticket.tasks[index]!, index).toLowerCase()}`,
            );
          }
        }
        for (const active of activeSyncDispatches.values()) {
          for (let index = 0; index < active.resolved.length; index++) {
            activeResolved.push(active.resolved[index]!);
            references.push(
              `active sync ${taskReference(active.tasks[index]!, index).toLowerCase()}`,
            );
          }
        }

        const incomingCount = resolved.length;
        const conflicts = (
          await findSharedWriteConflicts(
            [...incomingForSafety, ...activeResolved],
            signal,
          )
        ).filter(({ taskIndexes }) => {
          if (!taskIndexes.some((index) => index < incomingCount)) return false;
          // Multiple isolated tasks in this call intentionally share one
          // baseline/root. Any shared task or active dispatch in the same
          // conflict group still rejects the call.
          return !taskIndexes.every(
            (index) =>
              index < incomingCount &&
              resolved[index]?.workspace === "isolated",
          );
        });
        if (conflicts.length) {
          return sharedWriteRejection(
            tasks,
            parentModelId,
            conflicts,
            references,
          );
        }
      }

      const progress = initProgress(resolved);
      const fire = makeFireUpdater(
        onUpdate,
        tasks,
        progress,
        resolved,
        parentModelId,
        dispatchWarning,
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
          callSpan,
          dispatchConfig,
          dispatchWarning,
        });
      }

      syncReservation = Symbol("shared-write-dispatch");
      activeSyncDispatches.set(syncReservation, {
        tasks,
        resolved: resolved.map(asAdmissionWriter),
      });
      return { progress, fire };
    });
  } catch (error) {
    // A parent abort mid-preflight rejects the git rev-parse execFile call;
    // gitRepositoryRoot wraps every execFile error (abort-shaped ones
    // included) in GitScopeError, so the error alone cannot distinguish a
    // cancellation from a verification failure. Check the signal first —
    // reporting Git-metadata advice for a plain abort would misdirect.
    if (signal?.aborted) {
      callSpan?.finish({
        status: "cancelled",
        totalTokens: 0,
        totalCost: 0,
        wallMs: Date.now() - callSpan.startedAt,
      });
      return {
        content: [
          {
            type: "text",
            text: "Aborted before dispatch; no tasks were started.",
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
    callSpan?.finish({
      status: "failed",
      totalTokens: 0,
      totalCost: 0,
      wallMs: Date.now() - callSpan.startedAt,
    });
    return sharedWriteSafetyFailure(tasks, parentModelId, error);
  }

  if ("content" in admissionResult) {
    if (admissionResult.content[0]?.text.includes("Rejected before dispatch")) {
      callSpan?.finish({
        status: "failed",
        totalTokens: 0,
        totalCost: 0,
        wallMs: Date.now() - callSpan.startedAt,
      });
    }
    return admissionResult;
  }

  try {
    return await dispatchSync({
      ctx,
      tasks,
      resolved,
      progress: admissionResult.progress,
      parentModelId,
      signal,
      fire: admissionResult.fire,
      callSpan,
      dispatchConfig,
      dispatchWarning,
    });
  } finally {
    if (syncReservation) activeSyncDispatches.delete(syncReservation);
  }
}

/** Deliver a settled ticket and, when leaf affinity downgraded delivery to a
 *  non-waking `nextTurn` message, tell the human — otherwise the completion is
 *  silent apart from the footer clearing. */
function finishTicketDelivery(pi: ExtensionAPI, ticket: AsyncTicket): void {
  if (deliverTicketResults(pi, ticket) === "deferred") {
    notifyCrossLeafDelivery(ticket);
  }
}

function settleAsyncCall(
  ticket: AsyncTicket,
  callSpan: CallSpan | undefined,
): void {
  if (!callSpan) return;
  const { totalTokens, totalCost } = aggregateTaskResults(ticket.results);
  const wallMs = (ticket.completedAt ?? Date.now()) - callSpan.startedAt;
  const status =
    ticket.status === "done"
      ? "done"
      : ticket.status === "cancelled"
        ? "cancelled"
        : "failed";
  callSpan.finish({ status, totalTokens, totalCost, wallMs });
}

/** Fire-and-forget background execution. Registers an `AsyncTicket`, kicks off
 *  the concurrent run, and returns the ticket acknowledgment immediately.
 *  Results are delivered via `deliverTicketResults` when all tasks settle. */
export function dispatchAsync(input: AsyncDispatchInput): DelegateToolResult {
  const {
    pi,
    ctx,
    tasks,
    resolved,
    progress,
    parentModelId,
    callSpan,
    dispatchConfig,
    dispatchWarning,
  } = input;

  sweepTickets();
  const runningCount = [...ticketRegistry.values()].filter(
    (t) => t.status === "running" || t.status === "cancelling",
  ).length;
  const maxAsyncTickets = getMaxAsyncTickets(dispatchConfig);
  if (runningCount >= maxAsyncTickets) {
    callSpan?.finish({
      status: "failed",
      totalTokens: 0,
      totalCost: 0,
      wallMs: Date.now() - (callSpan?.startedAt ?? Date.now()),
    });
    return {
      content: [
        {
          type: "text",
          text: `Too many async tickets running or cancelling (${runningCount}/${maxAsyncTickets}). Poll existing tickets or cancel one first.`,
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
    // Leaf affinity for delivery: a ticket that outlives a /tree navigation
    // must not wake the agent on the branch the user moved to (issue #30).
    spawnLeafId: getCurrentLeafId(),
    callId: callSpan?.id,
    callStartedAt: callSpan?.startedAt,
    callRecord: callSpan ? { ...callSpan.baseRecord() } : undefined,
    telemetryGeneration: callSpan?.generation,
    telemetryConfig: callSpan?.telemetryConfig,
    workersSettled: false,
    dispatchWarning,
    // Capture the dispatch-scoped snapshot so async workers and later poll/wait
    // formatting use the same retry/stall/output/provider settings that were
    // in effect when the ticket was spawned.
    config: dispatchConfig,
  };
  ticketRegistry.set(ticketId, ticket);
  callSpan?.spawn();
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
    ticketId,
    delegateStartedAt: ticket.created,
    telemetryCallId: callSpan?.id,
    telemetryGeneration: callSpan?.generation,
    telemetryConfig:
      callSpan?.telemetryConfig ?? getTelemetryConfig(dispatchConfig),
    async: true,
    config: dispatchConfig,
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
  //
  // Worker settlement is complete before these live-runtime observers run.
  // In particular, result delivery is allowed to fail without re-entering the
  // worker completion path; the terminal ticket remains available to poll.
  const finishLiveSettlement = (t: AsyncTicket): void => {
    syncDelegateStatus();
    settleAsyncCall(t, callSpan);
    finishTicketDelivery(pi, t);
  };

  const completion = mapConcurrentByModel(
    resolved,
    (t) => getModelKey(t.model),
    (modelKey) => getConcurrencyLimit(modelKey, dispatchConfig),
    async (t, i) => {
      const result = await runResolvedTask(asyncEnv, t, ticket.progress[i]!, i);
      ticket.results[i] = result;
      return result;
    },
    ticketSignal,
  )
    .then(() => {
      // Shutdown marks the ticket terminal before cooperative worker aborts
      // have finished. Still write one final aggregate after every result has
      // landed; the immediate shutdown snapshot may have missed late usage.
      // The runtime is being torn down, so never attempt UI delivery here.
      if (ticket.status === "cancelled") {
        settleAsyncCall(ticket, callSpan);
        return;
      }
      // All tasks settled — determine final ticket status.
      // Use progress (set by runResolvedTask) for settled-ness so the
      // status reflects work completion, not just result-array density.
      // A partial ticket (not all settled, e.g. aborted mid-flight) must
      // NOT be marked "done" — that would mask incomplete work as
      // complete. resolveFinalTicketStatus returns "failed" for that
      // case and for any case with a failed task.
      // A "cancelling" ticket that outlived its workers settles as
      // "cancelled": the per-task results record what actually happened;
      // the ticket state reports that the batch was aborted by the caller.
      settleTicket(ticket, {
        status:
          ticket.status === "running"
            ? resolveFinalTicketStatus(ticket)
            : "cancelled",
      });
      finishLiveSettlement(ticket);
    })
    .catch((err) => {
      // Defense-in-depth — should not happen if individual tasks catch properly.
      // Even an unexpected worker rejection must leave the shutdown aggregate
      // with every result that did settle, without touching the stale UI.
      if (ticket.status === "cancelled") {
        settleAsyncCall(ticket, callSpan);
        return;
      }
      settleTicket(ticket, {
        status: ticket.status === "cancelling" ? "cancelled" : "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      finishLiveSettlement(ticket);
    })
    .finally(() => {
      ticket.workersSettled = true;
    });
  ticket.completion = completion;

  return {
    content: [
      {
        type: "text",
        text: [
          `Async ticket: ${ticketId}`,
          `${resolved.length} task(s) dispatched · ${runningCount + 1}/${maxAsyncTickets} async slots in use`,
          ...(dispatchWarning ? [`WARNING: ${dispatchWarning}`] : []),
          "",
          "Work is detached. Stop this turn to let final results auto-deliver.",
          `If this turn must block for the result, call once: delegate({ ticketAction: "wait", ticket: "${ticketId}" }) — omit timeoutMs and do not poll`,
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
      elapsedMs: Date.now() - ticket.created,
      dispatchWarning,
    },
  };
}

/** Synchronous concurrent execution — awaits all tasks and formats the
 * combined LLM-facing result. Pooled sessions remain live until closed. */
export async function dispatchSync(
  input: SyncDispatchInput,
): Promise<DelegateToolResult> {
  const {
    ctx,
    tasks,
    resolved,
    progress,
    parentModelId,
    signal,
    fire,
    callSpan,
    dispatchConfig,
    dispatchWarning,
  } = input;

  const startedAt = Date.now();
  let executionResolved = resolved;
  let isolatedBatch: Awaited<ReturnType<typeof prepareIsolatedBatch>>;
  try {
    isolatedBatch = await prepareIsolatedBatch(resolved, signal);
    if (isolatedBatch) executionResolved = isolatedBatch.resolved;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    callSpan?.finish({
      status: "failed",
      totalTokens: 0,
      totalCost: 0,
      wallMs: Date.now() - startedAt,
    });
    return {
      content: [
        {
          type: "text",
          text: `Isolated workspace setup failed; no subagents were started. ${detail}`,
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
  const syncEnv: TaskRunEnv = {
    signal,
    modelRegistry: ctx.modelRegistry,
    ticketId: undefined,
    delegateStartedAt: startedAt,
    telemetryCallId: callSpan?.id,
    telemetryGeneration: callSpan?.generation,
    telemetryConfig:
      callSpan?.telemetryConfig ?? getTelemetryConfig(dispatchConfig),
    async: false,
    config: dispatchConfig,
    onProgress: (p, u) => {
      updateProgressFromRun(p, u);
      fire();
    },
    onStatusChange: () => fire(),
  };

  let results = await mapConcurrentByModel(
    executionResolved,
    (t) => getModelKey(t.model),
    (modelKey) => getConcurrencyLimit(modelKey, dispatchConfig),
    async (t, i) => runResolvedTask(syncEnv, t, progress[i]!, i),
    signal,
  );
  if (isolatedBatch) {
    try {
      results = await isolatedBatch.reconcile(results);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[delegate] isolated reconciliation failed", error);
      for (let index = 0; index < results.length; index++) {
        if (resolved[index]?.workspace !== "isolated") continue;
        results[index] = {
          ...results[index]!,
          integration: {
            status: "apply_failed",
            proposedFiles: [],
            appliedFiles: [],
            conflicts: [{ path: "(batch)", reason: detail }],
          },
        };
      }
    }
  }

  // ── Format for LLM ────────────────────────────────────────────
  const finalResults: TaskResult[] = results;
  const elapsedTotal = Date.now() - startedAt;

  const parts: string[] = [];
  const succeeded = finalResults.filter((r) => !r.error).length;
  parts.push(
    `${succeeded}/${finalResults.length} tasks completed successfully · ${fmtDuration(elapsedTotal)} wall time\n`,
  );
  if (dispatchWarning) parts.push(`WARNING: ${dispatchWarning}`);
  for (let i = 0; i < finalResults.length; i++) {
    const r = finalResults[i]!;
    const t = resolved[i]!;
    parts.push(...formatCompletedTask(t, r, dispatchConfig));
  }

  const overlapWarning = formatTouchedOverlapWarning(
    findTouchedOverlaps(finalResults),
  );
  if (overlapWarning) parts.push("", overlapWarning);

  const status = finalResults.some(
    (r) =>
      r.error ||
      r.integration?.status === "conflict" ||
      r.integration?.status === "apply_failed",
  )
    ? "failed"
    : "success";
  const totalTokens = finalResults.reduce((sum, r) => sum + r.tokens, 0);
  const totalCost = finalResults.reduce(
    (sum, r) => sum + r.usage.cost.total,
    0,
  );
  callSpan?.finish({
    status,
    totalTokens,
    totalCost,
    wallMs: Date.now() - callSpan.startedAt,
  });

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    details: {
      tasks,
      results: finalResults,
      progress,
      parentModel: parentModelId,
      elapsedMs: elapsedTotal,
      overlapWarning: overlapWarning || undefined,
      dispatchWarning,
    },
    // Aggregate subagent spend so Pi folds it into the parent's
    // session/footer totals. Sync dispatch only — async results arrive via a
    // follow-up message that has no usage slot (see DelegateToolResult).
    usage: sumUsage(finalResults.map((r) => r.usage)),
  };
}

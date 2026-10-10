import type { ActivityStore } from "./activity.ts";
import type { AdmissionGrant } from "./admission.ts";
import type { DiagnosticSink } from "./diagnostics.ts";
import type { TicketStore } from "./tickets.ts";
import type {
  Deferred,
  ExecutionHandle,
  ResolvedTask,
  TaskOutcome,
  Ticket,
} from "./types.ts";

/**
 * One started task's outcome and worker-tail ownership. Batch scheduling,
 * reconciliation, and proof adoption remain with the coordinator; these are
 * the existing proof gates and shared outcome slot, not a second lifecycle.
 * Construction is inert: signal listeners and activity tracking stay at their
 * original coordinator call sites.
 */
export class TaskLifetime {
  // Sticky: after any execution is created, an infrastructure failure cannot
  // assume the task was pre-worker merely because an attempt already stopped.
  private workerCreated = false;
  // Once the worker's true outcome has landed it must not be overwritten
  // by a provisional one — worker truth is strictly better information.
  private workerTruthRecorded = false;
  private liveExecutions = 0;
  private runEnded = false;
  private disposed = false;
  // The composed signal propagates the (long-lived) dispatch and ticket
  // cancellation signals to this task's controls. Its listeners on those
  // sources are removed once the task is fully done: every created
  // execution has truly settled AND the run body has ended. Until both
  // hold, removal could silence a still-live worker's abort propagation;
  // after both, nothing listens to the composed signal anymore.
  private combined: { signal: AbortSignal; dispose(): void } | undefined;

  constructor(private readonly options: {
    task: ResolvedTask;
    outcomes: (TaskOutcome | undefined)[];
    workerStoppedProof: Deferred;
    workerTailStoppedProof: Deferred;
    diagnostics: DiagnosticSink;
    tickets: TicketStore;
    activity?: ActivityStore;
    grant: AdmissionGrant;
    ticket?: Ticket;
    taskStartedAt: number;
    syncRunId?: string;
    cleanupStoppedWorker?: (taskIndex: number) => Promise<void>;
    onTaskOutcomeRecorded?: (task: ResolvedTask, outcome: TaskOutcome) => void;
    /** Reads the coordinator's settled Git window only when late truth lands. */
    decorateLateOutcome: (outcome: TaskOutcome) => TaskOutcome;
  }) {}

  get workerMayExist(): boolean {
    return this.workerCreated;
  }

  attachSignal(combined: { signal: AbortSignal; dispose(): void }): AbortSignal {
    this.combined = combined;
    return combined.signal;
  }

  executionCreated(handle: ExecutionHandle): void {
    this.workerCreated = true;
    this.liveExecutions += 1;
    const { ticket, tickets, task } = this.options;
    if (ticket) {
      tickets.registerExecution(ticket, task.index, handle);
    }
  }

  recordOutcome(outcome: TaskOutcome): void {
    const options = this.options;
    const {
      task, ticket, outcomes, taskStartedAt,
      workerStoppedProof, workerTailStoppedProof,
    } = options;
    if (this.workerTruthRecorded) return;
    outcomes[task.index] = outcome;
    // Live-activity feed: ticket rows update status; sync tasks become
    // retained browser rows. Best-effort — the browser is diagnostics,
    // never a dispatch dependency: a throwing sink must not skip the
    // store's own outcome recording below it.
    if (options.activity !== undefined) {
      try {
        if (ticket !== undefined) {
          options.activity.setTicketTaskStatus(ticket.id, task.id, outcome.status);
        } else if (options.syncRunId !== undefined) {
          // A tracked inline row settles in place — it IS the retained
          // row, keeping its tool-call history and observed tail.
          options.activity.setSyncTaskStatus(
            options.syncRunId,
            task.id,
            outcome.status,
            outcome.status === "ok"
              ? (outcome.output ?? "")
              : (outcome.error ?? outcome.output ?? "no output"),
          );
        } else {
          options.activity.retainSyncRun({
            taskId: task.id,
            label: task.agent,
            prompt: task.prompt,
            status: outcome.status,
            startedAt: taskStartedAt,
            endedAt: Date.now(),
            summary:
              outcome.status === "ok"
                ? (outcome.output ?? "")
                : (outcome.error ?? outcome.output ?? "no output"),
          });
        }
      } catch (error) {
        options.diagnostics.log("error", "activity feed failed", { taskId: task.id }, error);
      }
    }
    // A non-quarantined outcome confirms the worker stopped (or never
    // started), with no late-worker cleanup tail. Phase reconciliation
    // can still be pending; the batch-body proof holds shutdown through it.
    if (!outcome.quarantined) {
      workerStoppedProof.resolve();
      workerTailStoppedProof.resolve();
    }
    if (ticket) {
      // The store owns lifecycle; recording can settle the ticket but
      // never un-settles it.
      options.tickets.recordOutcome(ticket, outcome);
    }
    // Usage reporting (#60): the settled outcome's recorded usage is
    // what the event carries — emit at the settlement point itself,
    // not at batch end, so a long-running ticket reports as it goes.
    if (options.onTaskOutcomeRecorded !== undefined) {
      try {
        options.onTaskOutcomeRecorded(task, outcome);
      } catch (error) {
        options.diagnostics.log("error", "usage settlement sink failed", { taskId: task.id }, error);
      }
    }
  }

  /**
   * The worker's true settlement, independent of the caller-visible one.
   * The live handle is dropped at real quiescence — a provisional
   * (cancelled-before-confirmed) outcome leaves the worker reachable for
   * a later, stronger abort. When the true outcome differs from what was
   * recorded, it replaces it for visibility — never the ticket status.
   * Worker stop initiates deferred cleanup; the retained reservation
   * releases only after that tail ends.
   */
  executionStopped(handle: ExecutionHandle, late: TaskOutcome | undefined): void {
    const options = this.options;
    const {
      task, ticket, outcomes, workerStoppedProof, workerTailStoppedProof, grant,
    } = options;
    // The worker's true settlement: it can no longer observe the composed
    // signal, so this attempt's propagation listeners become droppable.
    this.liveExecutions -= 1;
    if (this.liveExecutions === 0 && this.runEnded) this.disposeSignal();
    if (ticket) {
      options.tickets.dropExecution(ticket, task.index, handle);
    }
    if (late === undefined) return;
    this.workerTruthRecorded = true;
    // Reconciliation may already have annotated the provisional entry;
    // worker truth replaces the run outcome but keeps its integration —
    // and the Git window's evidence folds over its own observed set.
    const merged: TaskOutcome = {
      ...options.decorateLateOutcome(late),
      integration: outcomes[task.index]?.integration ?? late.integration,
    };
    outcomes[task.index] = merged;
    if (ticket) {
      options.tickets.recordOutcome(ticket, merged);
    } else if (
      options.syncRunId !== undefined &&
      options.activity !== undefined
    ) {
      // A provisional row keeps its provisional status until worker
      // truth lands — fold it so a live row never reads cancelled when
      // the worker actually finished.
      try {
        options.activity.setSyncTaskStatus(
          options.syncRunId,
          task.id,
          merged.status,
          merged.status === "ok"
            ? (merged.output ?? "")
            : (merged.error ?? merged.output ?? "no output"),
        );
      } catch {
        // Diagnostics only; the outcome is already recorded.
      }
    }
    // workerStopped() fulfilling proves the worker stopped — no background
    // continuations remain — even when an earlier abort threw and marked
    // the outcome quarantined. A thrown abort must not poison quiescence
    // confirmation for the worker's lifetime: confirm now, run the
    // deferred cleanup, and release the retained reservation so shutdown
    // and admission are not held forever by a stopped worker. A worker
    // that never settles never reaches here, so its barrier correctly
    // stays pending while it may still be mutating.
    workerStoppedProof.resolve();
    // Confirmed quiescence: deferred workspace cleanup first, then the
    // retained reservation may be released. This completes the worker tail;
    // batchBodyStopped independently covers phase reconciliation.
    void (async () => {
      try {
        await options.cleanupStoppedWorker?.(task.index);
      } catch (error) {
        options.diagnostics.log("error", "deferred cleanup after quiescence failed", { taskId: task.id }, error);
      }
      try {
        grant.releaseRetained(task.index);
      } catch (error) {
        options.diagnostics.log("error", "releasing quiesced task reservations failed", { taskId: task.id }, error);
      } finally {
        // Worker and cleanup have stopped even if synchronous bookkeeping
        // failed. A failed release cannot authorize a new reservation.
        workerTailStoppedProof.resolve();
      }
    })();
  }

  finishRun(): void {
    // Only executions still winding down keep propagation alive after runOne.
    this.runEnded = true;
    if (this.liveExecutions === 0) this.disposeSignal();
  }

  private disposeSignal(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.combined?.dispose();
  }
}

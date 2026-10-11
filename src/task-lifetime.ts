import type { ActivityStore } from "./activity.ts";
import type { AdmissionGrant } from "./admission.ts";
import type { DiagnosticSink } from "./diagnostics.ts";
import type { OutcomeLedger } from "./outcomes.ts";
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
  // #127: the monotonic instant the run body began — both concurrency
  // slots held, every pre-run gate passed. Undefined while the task has
  // only ever been queued, so a never-started settlement stamps no
  // duration.
  private admittedAt: number | undefined;
  // The composed signal propagates the (long-lived) dispatch and ticket
  // cancellation signals to this task's controls. Its listeners on those
  // sources are removed once the task is fully done: every created
  // execution has truly settled AND the run body has ended. Until both
  // hold, removal could silence a still-live worker's abort propagation;
  // after both, nothing listens to the composed signal anymore.
  private combined: { signal: AbortSignal; dispose(): void } | undefined;

  constructor(private readonly options: {
    task: ResolvedTask;
    ledger: OutcomeLedger;
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

  /**
   * The admission stamp (#127): called once both concurrency slots are
   * held and the run body begins. Dependency, pause, predecessor, and
   * slot waits before this point are queueing, not task duration; the
   * first call wins so a reacquired slot never restarts the span.
   */
  markAdmitted(): void {
    if (this.admittedAt === undefined) this.admittedAt = performance.now();
  }

  /**
   * Milliseconds inside the admitted span, or undefined when no duration
   * may be stamped. Two gates: the task must have been admitted AND a
   * worker must exist — a task that dies between markAdmitted and
   * executionCreated (resource loading, pre-session failures) is
   * never-started despite holding slots, so SPEC's "Task durations"
   * keeps it NULL. Monotonic — wall-clock jumps cannot move it.
   */
  private admittedElapsed(): number | undefined {
    return this.admittedAt === undefined || !this.workerCreated
      ? undefined
      : performance.now() - this.admittedAt;
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
      task, ticket, ledger, taskStartedAt,
      workerStoppedProof, workerTailStoppedProof,
    } = options;
    if (this.workerTruthRecorded) return;
    // Visible settlement ends the admitted span (#127): the duration is
    // stamped on the outcome being recorded, once — a later worker-truth
    // merge keeps this first measurement. The key is only set with a
    // real stamp: an own `durationMs: undefined` would survive into
    // details.results and trip the strict additionalProperties schema.
    // A task that was admitted but never produced a worker is
    // never-started (SPEC "Task durations") — admittedElapsed() gates
    // on workerCreated and returns undefined for it.
    const elapsed = this.admittedElapsed();
    const recorded: TaskOutcome =
      outcome.durationMs === undefined && elapsed !== undefined
        ? { ...outcome, durationMs: elapsed }
        : outcome;
    ledger.write(task.index, recorded);
    // Live-activity feed: ticket rows update status; sync tasks become
    // retained browser rows. Best-effort — the browser is diagnostics,
    // never a dispatch dependency: a throwing sink must not skip the
    // store's own outcome recording below it.
    if (options.activity !== undefined) {
      try {
        if (ticket !== undefined) {
          options.activity.setTicketTaskStatus(ticket.id, task.id, recorded.status);
        } else if (options.syncRunId !== undefined) {
          // A tracked inline row settles in place — it IS the retained
          // row, keeping its tool-call history and observed tail.
          options.activity.setSyncTaskStatus(
            options.syncRunId,
            task.id,
            recorded.status,
            recorded.status === "ok"
              ? (recorded.output ?? "")
              : (recorded.error ?? recorded.output ?? "no output"),
          );
        } else {
          options.activity.retainSyncRun({
            taskId: task.id,
            label: task.agent,
            prompt: task.prompt,
            status: recorded.status,
            startedAt: taskStartedAt,
            endedAt: Date.now(),
            summary:
              recorded.status === "ok"
                ? (recorded.output ?? "")
                : (recorded.error ?? recorded.output ?? "no output"),
          });
        }
      } catch (error) {
        options.diagnostics.log("error", "activity feed failed", { taskId: task.id }, error);
      }
    }
    // A non-quarantined outcome confirms the worker stopped (or never
    // started), with no late-worker cleanup tail. Phase reconciliation
    // can still be pending; the batch-body proof holds shutdown through it.
    if (!recorded.quarantined) {
      workerStoppedProof.resolve();
      workerTailStoppedProof.resolve();
    }
    ledger.publishToTicket(recorded);
    // Usage reporting (#60): the settled outcome's recorded usage is
    // what the event carries — emit at the settlement point itself,
    // not at batch end, so a long-running ticket reports as it goes.
    if (options.onTaskOutcomeRecorded !== undefined) {
      try {
        options.onTaskOutcomeRecorded(task, recorded);
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
      task, ticket, ledger, workerStoppedProof, workerTailStoppedProof, grant,
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
    const merged = ledger.mergeWorkerTruth(
      task.index,
      late,
      options.decorateLateOutcome,
      this.admittedElapsed(),
    );
    if (
      ticket === undefined &&
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

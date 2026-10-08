import { DiagnosticSink } from "./diagnostics.ts";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { AdmissionGrant } from "./admission.ts";
import {
  DEFAULT_CONFIG,
  modelConcurrencyLimit,
  type DelegateConfig,
} from "./config.ts";
import { runTask, type RunControls } from "./execution.ts";
import {
  withGitEvidence,
  type AttributionWindows,
  type WindowEvidence,
} from "./git-attribution.ts";
import {
  blockingReason,
  handoffAppendix,
  prerequisiteSatisfied,
} from "./graph.ts";
import { briefPreamble } from "./format.ts";
import type { HostEnvironment } from "./host.ts";
import type { ActivityStore } from "./activity.ts";
import type { SessionPool } from "./sessions.ts";
import { Deferred, Semaphore } from "./types.ts";
import type { TicketStore } from "./tickets.ts";
import type {
  ExecutionHandle,
  ResolvedTask,
  TaskOutcome,
  Ticket,
  TokenBudgetReport,
} from "./types.ts";

function onAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/**
 * Compose abort sources into one signal. The returned `dispose` removes the
 * listeners this call attached to the (possibly long-lived) source signals —
 * call it only once the task is fully done (every execution truly settled),
 * never earlier: until then the sources must keep propagating aborts.
 */
function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const disposers: (() => void)[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    disposers.push(() => signal.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const dispose of disposers) dispose();
      disposers.length = 0;
    },
  };
}

export interface DispatchOutcome {
  readonly outcomes: readonly TaskOutcome[];
  readonly usage: Usage | undefined;
  /**
   * Present when the call carried a `tokenBudget` (SPEC v3 "Batch token
   * budget"): the final account — limit, tokens recorded by settled
   * tasks, and when the ceiling was reached.
   */
  readonly tokenBudget?: TokenBudgetReport;
}

/**
 * Schedules tasks for one call or ticket: pause gates, same-call writer
 * serialization, the global concurrency semaphore, then execution. Task
 * outcomes land index-aligned; ticket lifecycle and its live machinery live
 * in the ticket store, not here.
 */
export class DispatchCoordinator {
  private readonly semaphore = new Semaphore(DEFAULT_CONFIG.maxConcurrent);
  private readonly modelSemaphores = new Map<string, Semaphore>();

  constructor(private readonly diagnostics: DiagnosticSink,
    private readonly tickets: TicketStore,
    /** Optional live-activity sink (issue #24 subagent browser). */
    private readonly activity?: ActivityStore,
  ) {}

  /**
   * Tasks holding a global-semaphore permit right now — the live half of
   * the capacity context an admission rejection reports (issue #51).
   */
  runningCount(): number {
    return this.semaphore.activeCount;
  }

  /** Per-model bound, keyed `provider/id`; created once, re-limited per call. */
  private modelSemaphore(task: ResolvedTask, config: DelegateConfig): Semaphore {
    const key = `${task.model.provider}/${task.model.id}`;
    let semaphore = this.modelSemaphores.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(modelConcurrencyLimit(key, config));
      this.modelSemaphores.set(key, semaphore);
    } else {
      semaphore.setLimit(modelConcurrencyLimit(key, config));
    }
    return semaphore;
  }

  /**
   * Acquire a semaphore slot with abort wake-up: a grant resolving after the
   * abort is handed straight back, and undefined signals cancellation.
   */
  private async acquireOrAborted(
    semaphore: Semaphore,
    signal: AbortSignal,
  ): Promise<(() => void) | undefined> {
    const acquire = semaphore.acquire();
    const release = await Promise.race([
      acquire,
      onAbort(signal).then(() => undefined),
    ]);
    if (release === undefined) {
      void acquire.then((late) => late());
      return undefined;
    }
    return release;
  }

  /**
   * Run a batch to completion. Resolves with index-aligned outcomes; a task
   * failure never rejects the batch and never destroys sibling results.
   *
   * `finalize` runs after every task has a caller-visible outcome but inside
   * the admission-reservation window — isolated reconciliation lives there.
   * `onWorkerQuiesced` runs when a provisionally-recorded worker's true
   * settlement arrives, before its retained reservation is released.
   */
  async run(
    tasks: readonly ResolvedTask[],
    options: {
      env: HostEnvironment;
      config: DelegateConfig;
      grant: AdmissionGrant;
      sessions: SessionPool;
      signal?: AbortSignal;
      ticket?: Ticket;
      /**
       * Prepare the workspaces of one dependency phase, returning the
       * phase's tasks with any scratch/isolated cwd remapped. Runs before
       * that phase's first task starts — later phases prepare after
       * earlier phases' proposals applied, so dependents see their work.
       */
      preparePhase?: (phase: number) => Promise<readonly ResolvedTask[]>;
      /**
       * Reconcile one phase's workspaces after all its outcomes are
       * recorded — isolated proposals apply (or retain) here, inside the
       * admission-reservation window, before the next phase starts.
       */
      reconcilePhase?: (
        phase: number,
        outcomes: TaskOutcome[],
      ) => Promise<readonly TaskOutcome[]>;
      onWorkerQuiesced?: (taskIndex: number) => Promise<void>;
      /**
       * The session's Git evidence-window registry (SPEC v3
       * "Observability — Completion evidence"; user decision 2026-10-02):
       * each task's window opens right before its first attempt and
       * settles after the final one, so one window spans every retry.
       * Undefined leaves attribution purely tool-observed.
       */
      attribution?: AttributionWindows;
      /**
       * Bound on a quarantined task's deferred window settle: a
       * provisional outcome leaves the worker possibly still mutating,
       * so its evidence window closes only when quiescence is confirmed
       * — or is abandoned after this many ms (the caller passes the
       * session's shutdown-quiescence bound; a worker that outlives even
       * that can no longer produce honest evidence anyway).
       */
      attributionQuiescenceBoundMs?: number;
      /**
       * One task's caller-visible settlement (#60): invoked for every
       * recorded outcome — provisional or final — as it lands, with the
       * settled outcome's recorded usage. The sink publishes usage
       * telemetry (pi.events "delegate:usage"); it must never throw
       * into the dispatch — call sites guard like the activity feed.
       */
      onTaskSettled?: (task: ResolvedTask, outcome: TaskOutcome) => void;
      /**
       * Ticket-less (inline) dispatch identity (#119): the live-activity
       * run key this batch's rows track under — `sync-run:<runId>:<taskId>`
       * keeps concurrent inline dispatches and repeated task ids distinct.
       * Absent on ticket-backed batches, whose rows key by ticket id.
       */
      syncRunId?: string;
      /**
       * The shared batch brief (SPEC v3 "Batch brief"): prepended to
       * every task's prompt as a delimited preamble — before the task's
       * own prose, leaving the dependent handoff appendix trailing it.
       */
      brief?: string;
      /**
       * The call's shared token ceiling (SPEC v3 "Batch token budget").
       * Consumption is summed from settled tasks' recorded usage; once it
       * reaches the limit, queued tasks settle `budget-exhausted` instead
       * of starting — running tasks are never hard-aborted and finish
       * normally.
       */
      tokenBudget?: number;
      /**
       * This batch's shutdown barrier, accepted as part of taking the
       * batch. `run` binds its resolver in the synchronous prefix of the
       * call — before the first await — so the moment the dispatcher
       * invokes `run` the transfer is total: the dispatcher's failure
       * routine can no longer run, and this call resolves the barrier on
       * every path it owns. The barrier resolves once EVERY task's
       * quiescence is confirmed, every worker that settled late through
       * `onWorkerSettled` has finished its deferred cleanup and
       * retained-reservation release, AND the batch itself has finished —
       * `finalize` (isolated reconciliation, scratch finalization) plus
       * the admission-reservation release. Worker quiescence alone is not
       * full quiescence: reconciliation still mutates the source tree
       * after the last worker stops, and shutdown completing in that
       * window would let a replacement session (whose admission
       * controller knows nothing of this batch) start writers into it.
       * The barrier resolves independently of this call's own fate and
       * never while a quarantined worker is unconfirmed — no timeout.
       */
      quiescence: Deferred;
    },
  ): Promise<DispatchOutcome> {
    const outcomes: (TaskOutcome | undefined)[] = new Array(tasks.length);
    // A serialized successor must wait for its predecessor's confirmed
    // quiescence — not merely a recorded outcome. A provisional
    // (quarantined) predecessor may still be mutating the shared root.
    const quiescence = new Map<number, Deferred>();
    // Confirmed quiescence alone is not the full barrier: a late-settled
    // worker still owes deferred cleanup and its retained-reservation
    // release. `fullyQuiesced` resolves only after that tail completes.
    const fullyQuiesced = new Map<number, Deferred>();
    for (const task of tasks) {
      quiescence.set(task.index, new Deferred());
      fullyQuiesced.set(task.index, new Deferred());
    }
    // Resolves once the run body itself has finished: `finalize` (isolated
    // reconciliation applying to or retaining against the source tree,
    // scratch disposal) and the admission-reservation release in the
    // finally below.
    const bodySettled = new Deferred();
    // Accept the batch's shutdown barrier before anything that could
    // throw: this wiring is the synchronous prefix of the call, so from
    // the moment `run` is invoked the coordinator owns the barrier's
    // resolution on every path. The `finally` below always resolves
    // `bodySettled` (even on a finalize failure), and a worker that never
    // settles keeps its `fullyQuiesced` pending — so a batch this call has
    // taken can never leak its barrier, and a worker that may still be
    // mutating holds it.
    void Promise.all([
      ...tasks.map((task) => fullyQuiesced.get(task.index)!.promise),
      bodySettled.promise,
    ]).then(() => options.quiescence.resolve());
    // Nothing between the barrier wiring above and the `try` below may
    // throw. The dispatcher's cancelled-preparation rerun invokes `run`
    // with no fallback catch: a throw in this gap on that path would leak
    // the barrier and hang every future shutdown. `setLimit` cannot throw
    // for a validated numeric config; keep it that way.
    this.semaphore.setLimit(options.config.maxConcurrent);
    const grant = options.grant;
    const loaders = new Map<string, Promise<DefaultResourceLoader>>();
    // SPEC v3 "Batch token budget": consumption is what settled tasks
    // recorded — summed live over the outcomes array so a late
    // worker-truth usage lands as soon as it is written. The latch stamps
    // exhaustion the moment consumption crosses the limit, whether or not
    // a queued task is waiting to observe it.
    const budgetConsumed = () =>
      outcomes.reduce(
        (sum, outcome) => sum + (outcome?.usage?.totalTokens ?? 0),
        0,
      );
    let exhaustedAt: number | undefined;
    let budgetReport: TokenBudgetReport | undefined;
    const budgetExhausted = (): boolean => {
      if (options.tokenBudget === undefined) return false;
      if (budgetConsumed() < options.tokenBudget) return false;
      exhaustedAt ??= Date.now();
      return true;
    };

    try {
      // Dependency phases run in order: every task in a phase waits for
      // the whole earlier phase — including its isolated reconciliation —
      // before it starts, so a dependent's tree carries prerequisite work.
      const phases = [...new Set(tasks.map((task) => task.phase))].sort(
        (a, b) => a - b,
      );
      for (const phase of phases) {
        const phaseTasks = tasks.filter((task) => task.phase === phase);
        const preparedByIndex = new Map<number, ResolvedTask>();
        let prepError: unknown;
        if (options.preparePhase !== undefined) {
          try {
            for (const prepared of await options.preparePhase(phase)) {
              preparedByIndex.set(prepared.index, prepared);
            }
          } catch (error) {
            // A phase's workspace preparation failed: its non-shared tasks
            // record pre-worker failures below; shared tasks have no
            // workspace to prepare and still run.
            prepError = error;
            this.diagnostics.log("error", "workspace preparation failed", { phase }, error);
          }
        }
        await Promise.all(
          phaseTasks.map((task) =>
            this.runOne(
              preparedByIndex.get(task.index) ?? task,
              options,
              grant,
              loaders,
              outcomes,
              quiescence,
              fullyQuiesced,
              tasks,
              prepError,
              budgetExhausted,
            ),
          ),
        );
        // Defensive: runOne is exception-safe and every exit records an
        // outcome, but a silent gap would skip reconciliation, block every
        // dependent on a never-resolving quiescence gate, and leak
        // reservations. A missing outcome means the task's state is
        // unknown — quarantine it rather than assume the root is clean.
        // This names the blocker: shutdown will wait on this dispatch's
        // quiescence barrier while the reservation stays held, so the task
        // must be visible.
        for (const task of phaseTasks) {
          if (outcomes[task.index] === undefined) {
            this.diagnostics.log("error", "internal dispatch error: no outcome recorded; quarantining write scope and holding shutdown quiescence", { taskId: task.id, index: task.index });
            const outcome: TaskOutcome = {
              index: task.index,
              id: task.id,
              status: "failed",
              error: "internal dispatch error: no outcome was recorded",
              retries: 0,
              quarantined: true,
            };
            outcomes[task.index] = outcome;
            if (options.ticket) {
              this.tickets.recordOutcome(options.ticket, outcome);
            }
          }
        }
        if (options.reconcilePhase !== undefined) {
          const ticket = options.ticket;
          try {
            await options.reconcilePhase(phase, outcomes as TaskOutcome[]);
          } catch (error) {
            // The tree's integration failed mid-flight: later phases can
            // never run on it. Settle every unstarted task now — a task
            // without an outcome never entered runOne, so no worker can
            // exist: a pre-worker failure needs no quarantine, and
            // resolving its gates here is what keeps the batch's shutdown
            // barrier from waiting forever on tasks that will never run.
            // The error still propagates: the batch fails as a whole once
            // the finally below has recorded this phase's reconciled
            // outcomes.
            const reason = `workspace reconciliation failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
            this.diagnostics.log("error", "workspace reconciliation failed", { phase }, error);
            for (const task of tasks) {
              if (outcomes[task.index] !== undefined) continue;
              const outcome: TaskOutcome = {
                index: task.index,
                id: task.id,
                status: "failed",
                error: reason,
                retries: 0,
              };
              outcomes[task.index] = outcome;
              quiescence.get(task.index)!.resolve();
              fullyQuiesced.get(task.index)!.resolve();
              if (ticket) {
                this.tickets.recordOutcome(ticket, outcome);
              }
            }
            throw error;
          } finally {
            if (ticket) {
              // The reconciled (integration-annotated) outcomes are the
              // ticket's terminal record; settlement is held until they
              // land.
              const phaseIndexes = new Set(
                phaseTasks.map((task) => task.index),
              );
              for (const outcome of outcomes) {
                if (outcome && phaseIndexes.has(outcome.index)) {
                  this.tickets.recordOutcome(ticket, outcome);
                }
              }
            }
          }
        }
        // Phase source effects (including isolated applies) have finished.
        // A provisional/quarantined outcome is never proof for scratch copying.
        for (const task of phaseTasks) {
          if (outcomes[task.index] && !outcomes[task.index]!.quarantined) {
            grant.confirmTaskQuiescence(task.index);
          }
        }
      }
    } finally {
      // Tasks whose sessions could not be confirmed quiescent keep their
      // reservations: their roots may still be mutating.
      const retained = new Set<number>();
      for (const outcome of outcomes) {
        if (outcome?.quarantined) retained.add(outcome.index);
      }
      grant.release(retained);
      // The budget account is final once every outcome has landed: the
      // last latch check stamps a crossing whose last task was itself the
      // one to consume the ceiling, and the report persists on the ticket
      // before the settlement hold lifts so a racing `wait` never misses
      // it (SPEC v3 "Batch token budget").
      if (options.tokenBudget !== undefined) {
        budgetExhausted();
        budgetReport = {
          limit: options.tokenBudget,
          consumed: budgetConsumed(),
          ...(exhaustedAt !== undefined ? { exhaustedAt } : {}),
        };
        if (options.ticket) {
          this.tickets.noteTokenBudget(options.ticket, budgetReport);
        }
      }
      if (options.ticket) this.tickets.finishBatch(options.ticket);
      // Only now is the batch fully quiesced for a shutdown barrier:
      // finalization and every admission reservation release have run.
      bodySettled.resolve();
    }

    return {
      outcomes: outcomes as TaskOutcome[],
      usage: outcomes.reduce<Usage | undefined>(
        (total, outcome) => addUsage(total, outcome?.usage),
        undefined,
      ),
      tokenBudget: budgetReport,
    };
  }

  private async runOne(
    task: ResolvedTask,
    options: {
      env: HostEnvironment;
      config: DelegateConfig;
      sessions: SessionPool;
      signal?: AbortSignal;
      ticket?: Ticket;
      onWorkerQuiesced?: (taskIndex: number) => Promise<void>;
      onTaskSettled?: (task: ResolvedTask, outcome: TaskOutcome) => void;
      syncRunId?: string;
      brief?: string;
      tokenBudget?: number;
      attribution?: AttributionWindows;
      attributionQuiescenceBoundMs?: number;
    },
    grant: AdmissionGrant,
    loaders: Map<string, Promise<DefaultResourceLoader>>,
    outcomes: (TaskOutcome | undefined)[],
    quiescence: Map<number, Deferred>,
    fullyQuiesced: Map<number, Deferred>,
    tasks: readonly ResolvedTask[],
    prepError: unknown,
    budgetExhausted: () => boolean,
  ): Promise<void> {
    const ticket = options.ticket;
    // The composed signal propagates the (long-lived) dispatch and ticket
    // cancellation signals to this task's controls. Its listeners on those
    // sources are removed once the task is fully done: every created
    // execution has truly settled AND the run body has ended. Until both
    // hold, removal could silence a still-live worker's abort propagation;
    // after both, nothing listens to the composed signal anymore.
    const combined = combineSignals(
      options.signal,
      ticket ? this.tickets.cancellationSignal(ticket) : undefined,
    );
    const signal = combined.signal;
    let liveExecutions = 0;
    let runEnded = false;
    let disposed = false;
    const disposeSignal = () => {
      if (disposed) return;
      disposed = true;
      combined.dispose();
    };
    const taskStartedAt = Date.now();
    // Live browser rows from the start (diagnostics only): ticket tasks
    // key by ticket id, inline tasks by this dispatch's run id (#119).
    if (this.activity !== undefined) {
      try {
        if (ticket !== undefined) {
          this.activity.trackTicketTask({
            ticketId: ticket.id,
            taskId: task.id,
            label: task.agent,
            prompt: task.prompt,
          });
        } else if (options.syncRunId !== undefined) {
          this.activity.trackSyncTask({
            runId: options.syncRunId,
            taskId: task.id,
            label: task.agent,
            prompt: task.prompt,
          });
        }
      } catch {
        // A failed track never blocks the task it wanted to display.
      }
    }
    const confirmed = quiescence.get(task.index)!;
    const fully = fullyQuiesced.get(task.index)!;
    // True once a worker session may exist; below that point a failure is
    // provably pre-worker and needs no quarantine.
    let workerCreated = false;
    // Once the worker's true outcome has landed it must not be overwritten
    // by a provisional one — worker truth is strictly better information.
    let workerTruthRecorded = false;
    // The task's Git evidence window, once settled: a late worker-truth
    // outcome folds the same evidence over its own observed set.
    let windowEvidence: WindowEvidence | undefined;
    const record = (outcome: TaskOutcome) => {
      if (workerTruthRecorded) return;
      outcomes[task.index] = outcome;
      // Live-activity feed: ticket rows update status; sync tasks become
      // retained browser rows. Best-effort — the browser is diagnostics,
      // never a dispatch dependency: a throwing sink must not skip the
      // store's own outcome recording below it.
      if (this.activity !== undefined) {
        try {
          if (ticket !== undefined) {
            this.activity.setTicketTaskStatus(ticket.id, task.id, outcome.status);
          } else if (options.syncRunId !== undefined) {
            // A tracked inline row settles in place — it IS the retained
            // row, keeping its tool-call history and observed tail.
            this.activity.setSyncTaskStatus(
              options.syncRunId,
              task.id,
              outcome.status,
              outcome.status === "ok"
                ? (outcome.output ?? "")
                : (outcome.error ?? outcome.output ?? "no output"),
            );
          } else {
            this.activity.retainSyncRun({
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
          this.diagnostics.log("error", "activity feed failed", { taskId: task.id }, error);
        }
      }
      // A non-quarantined outcome confirms the worker is done (or never
      // started): serialized successors may proceed, and nothing remains
      // owed to a shutdown barrier — no deferred cleanup is pending.
      if (!outcome.quarantined) {
        confirmed.resolve();
        fully.resolve();
      }
      if (ticket) {
        // The store owns lifecycle; recording can settle the ticket but
        // never un-settles it.
        this.tickets.recordOutcome(ticket, outcome);
      }
      // Budget latch: this outcome's usage may have crossed the limit —
      // stamp exhaustion now so the report is honest even when no queued
      // task is left to observe it.
      budgetExhausted();
      // Usage reporting (#60): the settled outcome's recorded usage is
      // what the event carries — emit at the settlement point itself,
      // not at batch end, so a long-running ticket reports as it goes.
      if (options.onTaskSettled !== undefined) {
        try {
          options.onTaskSettled(task, outcome);
        } catch (error) {
          this.diagnostics.log("error", "usage settlement sink failed", { taskId: task.id }, error);
        }
      }
    };
    /**
     * The worker's true settlement, independent of the caller-visible one.
     * The live handle is dropped at real quiescence — a provisional
     * (cancelled-before-confirmed) outcome leaves the worker reachable for
     * a later, stronger abort. When the true outcome differs from what was
     * recorded, it replaces it for visibility — never the ticket status —
     * and confirmed quiescence releases the retained reservation.
     */
    const onWorkerSettled = (
      handle: ExecutionHandle,
      late: TaskOutcome | undefined,
    ) => {
      // The worker's true settlement: it can no longer observe the composed
      // signal, so this attempt's propagation listeners become droppable.
      liveExecutions -= 1;
      if (liveExecutions === 0 && runEnded) disposeSignal();
      if (ticket) {
        this.tickets.dropExecution(ticket, task.index, handle);
      }
      if (late === undefined) return;
      workerTruthRecorded = true;
      // Reconciliation may already have annotated the provisional entry;
      // worker truth replaces the run outcome but keeps its integration —
      // and the Git window's evidence folds over its own observed set.
      const merged: TaskOutcome = {
        ...(windowEvidence === undefined
          ? late
          : withGitEvidence(late, windowEvidence)),
        integration: outcomes[task.index]?.integration ?? late.integration,
      };
      outcomes[task.index] = merged;
      if (ticket) {
        this.tickets.recordOutcome(ticket, merged);
      } else if (
        options.syncRunId !== undefined &&
        this.activity !== undefined
      ) {
        // A provisional row keeps its provisional status until worker
        // truth lands — fold it so a live row never reads cancelled when
        // the worker actually finished.
        try {
          this.activity.setSyncTaskStatus(
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
      // Worker truth can carry usage the provisional snapshot lacked —
      // it may be the write that crosses the limit.
      budgetExhausted();
      // Settled() resolving proves the worker stopped — no background
      // continuations remain — even when an earlier abort threw and marked
      // the outcome quarantined. A thrown abort must not poison quiescence
      // confirmation for the worker's lifetime: confirm now, run the
      // deferred cleanup, and release the retained reservation so shutdown
      // and admission are not held forever by a stopped worker. A worker
      // that never settles never reaches here, so its barrier correctly
      // stays pending while it may still be mutating.
      confirmed.resolve();
      // Confirmed quiescence: deferred workspace cleanup first, then the
      // retained reservation may be released. Only after that tail is the
      // task fully quiesced for a shutdown barrier.
      void (async () => {
        try {
          await options.onWorkerQuiesced?.(task.index);
        } catch (error) {
          this.diagnostics.log("error", "deferred cleanup after quiescence failed", { taskId: task.id }, error);
        }
        grant.releaseRetained(task.index);
        fully.resolve();
      })();
    };

    // Queued tasks hold no execution resources: pause first, then wait for a
    // serialized writer predecessor, then acquire a concurrency slot.
    // A throw anywhere below is an infrastructure fault, not a task failure —
    // convert it so Promise.all can never reject while siblings still run.
    try {
      // Dependency gate: every prerequisite's confirmed quiescence first —
      // a provisional (quarantined) one may still be mutating — then its
      // terminal state decides. A failed, cancelled, or unapplied-isolated
      // prerequisite blocks the dependent visibly without it consuming a
      // worker, session, or slot; cancellation supersedes the block.
      if (task.dependsOn.length > 0) {
        for (const depIndex of task.dependsOn) {
          // A recorded quarantined outcome is provisional but already
          // decided for this gate: it exists only after cancellation was
          // requested, and a worker truth after cancellation is never a
          // success — while its confirmed quiescence may never arrive.
          // Waiting on it would park the dependent (and the batch's
          // Promise.all) on a worker that may still be mutating; skip the
          // wait and let the gate below record the block with its reason.
          const recorded = outcomes[depIndex];
          const unsatisfiable =
            recorded !== undefined &&
            recorded.quarantined === true &&
            !prerequisiteSatisfied(recorded, tasks[depIndex]!);
          if (!unsatisfiable) {
            await Promise.race([
              quiescence.get(depIndex)?.promise ?? Promise.resolve(),
              onAbort(signal),
            ]);
          }
          if (signal.aborted) {
            record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
            return;
          }
        }
        const blockers = task.dependsOn.filter(
          (depIndex) =>
            !prerequisiteSatisfied(outcomes[depIndex]!, tasks[depIndex]!),
        );
        if (blockers.length > 0) {
          record({
            index: task.index,
            id: task.id,
            status: "blocked",
            error:
              `blocked by ${blockers
                .map(
                  (depIndex) =>
                    `'${tasks[depIndex]!.id}' — it ${blockingReason(outcomes[depIndex], tasks[depIndex]!)}`,
                )
                .join("; ")}`,
            blockedBy: blockers.map((depIndex) => tasks[depIndex]!.id),
            retries: 0,
          });
          return;
        }
      }
      // A phase whose workspace preparation failed cannot run its
      // non-shared tasks — a scratch/isolated task without its workspace
      // would touch the real tree. This is a pre-worker failure: nothing
      // ran, so no quarantine.
      if (prepError !== undefined && task.workspace !== "shared") {
        record({
          index: task.index,
          id: task.id,
          status: "failed",
          error: `workspace preparation failed: ${prepError instanceof Error ? prepError.message : String(prepError)}`,
          retries: 0,
        });
        return;
      }
      // The batch brief (SPEC v3 "Batch brief") leads the prompt as a
      // delimited preamble — kept out of `task.prompt` itself so display
      // surfaces (labels, fingerprints) still see the caller's prose.
      const briefed: ResolvedTask =
        options.brief === undefined
          ? task
          : { ...task, prompt: briefPreamble(options.brief) + task.prompt };
      // The handoff: each declared prerequisite's bounded final output and
      // what became of its work is appended to this task's prompt. Every
      // prerequisite is confirmed-quiescent and satisfied at this point,
      // so the projection reads final outcomes only.
      const effectiveTask: ResolvedTask =
        briefed.dependsOn.length > 0
          ? {
              ...briefed,
              prompt:
                briefed.prompt +
                handoffAppendix(
                  briefed.dependsOn.map((depIndex) => ({
                    task: tasks[depIndex]!,
                    outcome: outcomes[depIndex]!,
                  })),
                  options.config.output,
                ),
            }
          : briefed;
      while (true) {
        if (ticket) await this.waitWhilePaused(ticket, signal);
        if (signal.aborted) {
          record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
          return;
        }
        // SPEC v3 "Batch token budget": a task still queued when the
        // ceiling is reached never starts — it settles budget-exhausted
        // without consuming a slot, worker, or session.
        if (budgetExhausted()) {
          record({
            index: task.index,
            id: task.id,
            status: "budget-exhausted",
            error: `the batch tokenBudget of ${options.tokenBudget} tokens was exhausted before this task started`,
            retries: 0,
          });
          return;
        }
        const predecessor = grant.predecessors.get(task.index);
        if (predecessor !== undefined) {
          // Wait for confirmed quiescence, not caller-visible settlement: a
          // provisional predecessor may still be writing the shared root.
          await Promise.race([
            quiescence.get(predecessor)?.promise ?? Promise.resolve(),
            onAbort(signal),
          ]);
        }
        if (signal.aborted) {
          record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
          return;
        }
        // Queued tasks need both a per-model slot and a global slot; abort
        // wakes them without waiting for either.
        const modelRelease = await this.acquireOrAborted(
          this.modelSemaphore(task, options.config),
          signal,
        );
        if (modelRelease === undefined) {
          record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
          return;
        }
        const release = await this.acquireOrAborted(this.semaphore, signal);
        if (release === undefined) {
          modelRelease();
          record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
          return;
        }
        let held: (() => void) | undefined = () => {
          release();
          modelRelease();
        };
        const releaseBoth = () => {
          held?.();
          held = undefined;
        };
        if (!ticket?.paused || signal.aborted) {
          try {
            if (signal.aborted) {
              record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
              return;
            }
            // The ceiling may have been crossed while this task waited
            // on a slot — recheck at the start boundary so no worker is
            // launched past the budget. Held slots release via finally.
            if (budgetExhausted()) {
              record({
                index: task.index,
                id: task.id,
                status: "budget-exhausted",
                error: `the batch tokenBudget of ${options.tokenBudget} tokens was exhausted before this task started`,
                retries: 0,
              });
              return;
            }
            const controls: RunControls = {
              env: options.env,
              sessions: options.sessions,
              signal,
              stallTimeoutMs: options.config.stallTimeoutMs,
              maxIdleSessions: options.config.sessions.maxIdle,
              holdTranscript: (path) => grant.holdTranscript(task.index, path),
              // #123: claim-time journaling. Sync runs carry no ticket
              // and nothing to journal — the callback stays undefined.
              noteTranscript:
                ticket !== undefined
                  ? (path: string, start: number) =>
                      this.tickets.noteTaskTranscript(ticket, task.index, path, start)
                  : undefined,
              isAborted: () => signal.aborted,
              observe:
                this.activity !== undefined &&
                (ticket !== undefined || options.syncRunId !== undefined)
                  ? (event) => {
                      try {
                        if (ticket !== undefined) {
                          this.activity?.observe(ticket.id, task.id, event);
                        } else if (options.syncRunId !== undefined) {
                          this.activity?.observeSync(
                            options.syncRunId,
                            task.id,
                            event,
                          );
                        }
                      } catch {
                        // execution.ts already guards the sink; this is belt.
                      }
                    }
                  : undefined,
              waitWhilePaused: (runSignal) =>
                ticket
                  ? this.waitWhilePaused(ticket, runSignal ?? signal, {
                      onPark: () => this.setTaskStatusSafely(ticket, task.id, "paused"),
                      onWake: () => {
                        // Only restore "running" when the ticket is genuinely
                        // back mid-flight; settle/pause raced past the gate.
                        if (ticket.status === "running" && !ticket.paused) {
                          this.setTaskStatusSafely(ticket, task.id, "running");
                        }
                      },
                    })
                  : Promise.resolve(),
              // Steers parked while the task had no live run ride its
              // next prompt's first turn (SPEC v3 "Steering").
              consumeSteers:
                ticket === undefined
                  ? undefined
                  : () => this.tickets.takePendingSteers(ticket, task.index),
              askQuestion: ticket === undefined ? undefined : async (question, toolSignal) => {
                const combined = combineSignals(signal, toolSignal);
                try {
                  // The pending tool still owns its session and admission
                  // reservation. Only execution semaphores are yielded.
                  const waiting = this.tickets.ask(ticket, task.index, question, combined.signal);
                  releaseBoth();
                  const answer = await waiting;
                  if (combined.signal.aborted || ticket.status !== "running") {
                    throw new Error("Question cancelled before worker could resume.");
                  }
                  const nextModel = await this.acquireOrAborted(this.modelSemaphore(task, options.config), combined.signal);
                  if (!nextModel) throw new Error("Question cancelled while awaiting model capacity.");
                  const nextGlobal = await this.acquireOrAborted(this.semaphore, combined.signal);
                  if (!nextGlobal) {
                    nextModel();
                    throw new Error("Question cancelled while awaiting execution capacity.");
                  }
                  held = () => { nextGlobal(); nextModel(); };
                  if (combined.signal.aborted || ticket.status !== "running") {
                    throw new Error("Question cancelled before worker resumed.");
                  }
                  return answer;
                } finally {
                  combined.dispose();
                }
              },
            };
            this.setTaskStatusSafely(
              ticket,
              task.id,
              "running",
              options.syncRunId,
            );
            // The Git evidence window (SPEC v3 "Observability —
            // Completion evidence") opens here — after admission, pause,
            // predecessor, and slot gates, immediately before the first
            // attempt — so a queued task never absorbs pre-window
            // changes, and one window spans all of runTask's retries.
            const window =
              options.attribution === undefined
                ? undefined
                : await options.attribution.open(task, ticket?.id);
            let outcome: TaskOutcome;
            let windowClosed = window === undefined;
            try {
              outcome = await runTask(
                effectiveTask,
                controls,
                loaders,
                (handle) => {
                  workerCreated = true;
                  liveExecutions += 1;
                  if (ticket) {
                    this.tickets.registerExecution(ticket, task.index, handle);
                  }
                },
                onWorkerSettled,
              );
              // The window settles after the final attempt but before
              // workspace reconciliation — its diff must not count the
              // integrator's own writes.
              if (window !== undefined && options.attribution !== undefined) {
                if (outcome.quarantined === true) {
                  // A provisional record cannot wait on the second
                  // snapshot — and the snapshot itself cannot run yet
                  // either: a cancelled worker may still be writing. The
                  // window closes when quiescence is confirmed, folding
                  // its evidence over the worker-truth record, or is
                  // abandoned at the quiescence bound when the worker
                  // never stops.
                  windowClosed = true;
                  const attribution = options.attribution;
                  const openWindow = window;
                  const boundMs =
                    options.attributionQuiescenceBoundMs ?? 30_000;
                  void (async () => {
                    try {
                      const quiesced = await Promise.race([
                        confirmed.promise.then(() => true),
                        new Promise<false>((resolve) =>
                          setTimeout(() => resolve(false), boundMs),
                        ),
                      ]);
                      if (!quiesced) {
                        attribution.abandon(openWindow);
                        return;
                      }
                      const evidence = await attribution.settle(openWindow);
                      windowEvidence = evidence;
                      // Worker truth's record is already on file — fold
                      // the window's evidence over it so its files line
                      // reflects what the worker actually did.
                      const current = outcomes[task.index];
                      if (current !== undefined) {
                        const enriched = withGitEvidence(current, evidence);
                        outcomes[task.index] = enriched;
                        if (ticket) {
                          this.tickets.recordOutcome(ticket, enriched);
                        }
                      }
                    } catch (error) {
                      attribution.abandon(openWindow);
                      this.diagnostics.log("error", "deferred git evidence settle failed", { taskId: task.id }, error);
                    }
                  })();
                } else {
                  const evidence = await options.attribution.settle(window);
                  windowEvidence = evidence;
                  outcome = withGitEvidence(outcome, evidence);
                  windowClosed = true;
                }
              }
            } finally {
              // On a thrown run the window still closes so it can never
              // look open-ended to siblings.
              if (window !== undefined && !windowClosed) {
                options.attribution?.abandon(window);
              }
            }
            record(outcome);
            return;
          } finally {
            releaseBoth();
          }
        }
        // Paused between acquire and start: give the slots back and re-park.
        releaseBoth();
      }
    } catch (error) {
      // Unknown task state: quarantine when a worker session may exist so
      // its reservation stays held; otherwise the root is provably clean.
      record({
        index: task.index,
        id: task.id,
        status: "failed",
        error: `internal dispatch error: ${error instanceof Error ? error.message : String(error)}`,
        retries: 0,
        quarantined: workerCreated || undefined,
      });
    } finally {
      // The run body is over; only executions still winding down (settled()
      // pending) keep the propagation listeners alive past this point.
      runEnded = true;
      if (liveExecutions === 0) disposeSignal();
    }
  }

  private waitWhilePaused(
    ticket: Ticket,
    signal: AbortSignal,
    hooks?: { onPark: () => void; onWake: () => void },
  ): Promise<void> {
    return (async () => {
      // Park/wake bracket the actual held state, so display state is
      // produced by the checkpoint that owns the truth (#46 M1): a task
      // reports "paused" only while it is genuinely parked between turns,
      // never while its final pre-pause turn is still streaming.
      let parked = false;
      while (ticket.paused && ticket.status === "running" && !signal.aborted) {
        if (!parked) {
          parked = true;
          hooks?.onPark();
        }
        const gate = this.tickets.pauseGatePromise(ticket);
        if (gate === undefined) break;
        await Promise.race([gate, onAbort(signal)]);
      }
      if (parked) hooks?.onWake();
    })();
  }

  /** Activity is diagnostics; a status update must never fail the run. */
  private setTaskStatusSafely(
    ticket: Ticket | undefined,
    taskId: string,
    status: "running" | "paused",
    syncRunId?: string,
  ): void {
    if (this.activity === undefined) return;
    try {
      if (ticket !== undefined) {
        this.activity.setTicketTaskStatus(ticket.id, taskId, status);
      } else if (syncRunId !== undefined) {
        this.activity.setSyncTaskStatus(syncRunId, taskId, status);
      }
    } catch (error) {
      this.diagnostics.log("error", "task status update failed", {}, error);
    }
  }
}

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

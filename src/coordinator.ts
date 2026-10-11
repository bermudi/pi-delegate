import { DiagnosticSink } from "./diagnostics.ts";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { AdmissionGrant } from "./admission.ts";
import type { DispatchLifetime } from "./lifetime.ts";
import { TaskLifetime } from "./task-lifetime.ts";
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
import { OutcomeLedger } from "./outcomes.ts";
import type { ActivityStore } from "./activity.ts";
import type { SessionPool } from "./sessions.ts";
import { Deferred, Semaphore } from "./types.ts";
import type { TicketStore } from "./tickets.ts";
import type {
  ResolvedTask,
  TaskOutcome,
  Ticket,
} from "./types.ts";

function onAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/** Public tool errors render `.message`; keep the primary failure visible there. */
function aggregateFailure(message: string, failures: readonly unknown[]): AggregateError {
  const first = failures[0];
  const detail = first instanceof Error ? first.message : String(first);
  return new AggregateError(failures, `${message}: ${detail}`, { cause: first });
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
   * WorkspacePlan.reconcilePhase owns scratch drift capture, isolated
   * application, then scratch finalization, inside the phase/admission
   * window.
   * `cleanupStoppedWorker` runs after a provisionally-recorded worker's
   * workerStopped signal fulfills, before its retained reservation releases.
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
      cleanupStoppedWorker?: (taskIndex: number) => Promise<void>;
      /** Dispose prepared workspaces if batch setup fails before any task starts. */
      disposeUnstarted?: () => Promise<void>;
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
       * One task's recorded caller-visible outcome (#60): invoked for every
       * recorded outcome — provisional or final — as it lands, with the
       * settled outcome's recorded usage. The sink publishes usage
       * telemetry (pi.events "delegate:usage"); it must never throw
       * into the dispatch — call sites guard like the activity feed.
       */
      onTaskOutcomeRecorded?: (task: ResolvedTask, outcome: TaskOutcome) => void;
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
       * The dispatch's lifetime. `run` adopts this batch's full-quiescence
       * work into it, synchronously, before its first await. The batch is
       * covered once EVERY task's quiescence is confirmed, every late worker
       * has finished its deferred cleanup and retained-reservation release,
       * AND the batch itself has finished — phase reconciliation
       * (isolated application, scratch finalization) plus the
       * admission-reservation release. Worker quiescence alone is not full quiescence: the source
       * tree is still mutated after the last worker stops. This call never
       * resolves the lifetime itself; the dispatch pipeline closes it.
       */
      lifetime: DispatchLifetime;
    },
  ): Promise<DispatchOutcome> {
    const ledger = new OutcomeLedger(tasks.length, {
      ticket: options.ticket,
      tickets: this.tickets,
    });
    // A serialized successor must wait for its predecessor's confirmed
    // quiescence — not merely a recorded outcome. A provisional
    // (quarantined) predecessor may still be mutating the shared root.
    const workersStopped = new Map<number, Deferred>();
    // Worker termination is not resource quiescence. A late worker also
    // owes deferred workspace cleanup and retained-release bookkeeping.
    // This map covers that tail, NOT phase reconciliation generally:
    // ordinary outcomes resolve it before reconciliation, which remains
    // covered by batchBodyStopped and the aggregate lifetime.
    const workerTailsStopped = new Map<number, Deferred>();
    for (const task of tasks) {
      workersStopped.set(task.index, new Deferred());
      workerTailsStopped.set(task.index, new Deferred());
    }
    // Resolves once the run body itself has finished: phase reconciliation
    // (isolated application to or retention against the source tree,
    // scratch disposal) and admission-reservation release attempts in the
    // finally below.
    const batchBodyStopped = new Deferred();
    const grant = options.grant;
    const started = new Set<number>();
    const failures: unknown[] = [];

    try {
      // Register resolve-only proofs before starting work. Setup and every
      // later stage share this error boundary: never-started tasks are
      // settled below, while unknown worker state keeps its proofs pending.
      options.lifetime.adopt(batchBodyStopped);
      for (const proof of workerTailsStopped.values()) options.lifetime.adopt(proof);
      this.semaphore.setLimit(options.config.maxConcurrent);
      const loaders = new Map<string, Promise<DefaultResourceLoader>>();
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
        const runs = await Promise.allSettled(
          phaseTasks.map((task) => {
            started.add(task.index);
            return this.runOne(
              preparedByIndex.get(task.index) ?? task,
              options,
              grant,
              loaders,
              ledger,
              workersStopped,
              workerTailsStopped,
              tasks,
              prepError,
            );
          }),
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
          if (ledger.read(task.index) === undefined) {
            this.diagnostics.log("error", "internal dispatch error: no outcome recorded; quarantining write scope and holding shutdown quiescence", { taskId: task.id, index: task.index });
            const outcome: TaskOutcome = {
              index: task.index,
              id: task.id,
              status: "failed",
              error: "internal dispatch error: no outcome was recorded",
              retries: 0,
              quarantined: true,
            };
            ledger.publish(task.index, outcome);
          }
        }
        // An infrastructure exception escaping runOne must not run the
        // batch's final cleanup while sibling run bodies are still
        // active. Wait for them all,
        // then surface the failures; unknown workers remain quarantined.
        const runFailures: unknown[] = runs.flatMap((run) =>
          run.status === "rejected" ? [run.reason as unknown] : [],
        );
        if (runFailures.length > 0) {
          throw aggregateFailure("task infrastructure failed", runFailures);
        }
        if (options.reconcilePhase !== undefined) {
          try {
            await options.reconcilePhase(phase, ledger.snapshot() as TaskOutcome[]);
          } catch (error) {
            // Stop later phases. The outer failure boundary settles their
            // never-started tasks after this phase's final annotations land.
            this.diagnostics.log("error", "workspace reconciliation failed", { phase }, error);
            throw error;
          } finally {
            ledger.republishPhase(
              new Set(phaseTasks.map((task) => task.index)),
            );
          }
        }
        // Reconciliation has finished, but late worker truth may already have
        // replaced a quarantined outcome while deferred cleanup still mutates
        // source Git metadata. Only the full worker+cleanup barrier is proof
        // for exempting this writer during a later scratch copy.
        for (const task of phaseTasks) {
          if (workerTailsStopped.get(task.index)!.resolved) {
            grant.confirmTaskQuiescence(task.index);
          }
        }
      }
    } catch (error) {
      failures.push(error);
      this.diagnostics.log("error", "dispatch infrastructure failed", {}, error);
      for (const task of tasks) {
        if (started.has(task.index)) continue;
        const outcome: TaskOutcome = {
          index: task.index,
          id: task.id,
          status: options.signal?.aborted ? "cancelled" : "failed",
          error: `dispatch infrastructure failed: ${error instanceof Error ? error.message : String(error)}`,
          retries: 0,
        };
        ledger.write(task.index, outcome);
        // Proof comes from never entering runOne, not successful reporting.
        workersStopped.get(task.index)!.resolve();
        workerTailsStopped.get(task.index)!.resolve();
        try {
          ledger.publishToTicket(outcome);
        } catch (recordError) {
          failures.push(recordError);
          this.diagnostics.log("error", "recording unstarted task failure failed", { taskId: task.id }, recordError);
        }
      }
      if (started.size === 0) {
        try {
          await options.disposeUnstarted?.();
        } catch (cleanupError) {
          failures.push(cleanupError);
          this.diagnostics.log("error", "disposing unstarted dispatch failed", {}, cleanupError);
        }
      }
    } finally {
      // Late worker truth can look nonquarantined before its cleanup tail
      // finishes. Keep reservations through that full barrier too, otherwise
      // a new dispatch could copy the source after this batch returns while
      // isolated cleanup still changes its Git metadata.
      const retained = new Set<number>();
      for (const task of tasks) {
        if (!workerTailsStopped.get(task.index)!.resolved) retained.add(task.index);
      }
      try {
        grant.release(retained);
      } catch (error) {
        failures.push(error);
        this.diagnostics.log("error", "releasing dispatch reservations failed", {}, error);
      }
      try {
        if (options.ticket) this.tickets.markBatchFinished(options.ticket);
      } catch (error) {
        failures.push(error);
        this.diagnostics.log("error", "finishing dispatch ticket failed", {}, error);
      }
      // All synchronous finalization attempts ended. Unknown workers still
      // hold their own proof gates and retained reservations independently.
      batchBodyStopped.resolve();
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw aggregateFailure("dispatch infrastructure and finalization failed", failures);
    }
    return {
      outcomes: ledger.snapshot() as TaskOutcome[],
      usage: ledger.snapshot().reduce<Usage | undefined>(
        (total, outcome) => addUsage(total, outcome?.usage),
        undefined,
      ),
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
      cleanupStoppedWorker?: (taskIndex: number) => Promise<void>;
      onTaskOutcomeRecorded?: (task: ResolvedTask, outcome: TaskOutcome) => void;
      syncRunId?: string;
      brief?: string;
      attribution?: AttributionWindows;
      attributionQuiescenceBoundMs?: number;
    },
    grant: AdmissionGrant,
    loaders: Map<string, Promise<DefaultResourceLoader>>,
    ledger: OutcomeLedger,
    workersStopped: Map<number, Deferred>,
    workerTailsStopped: Map<number, Deferred>,
    tasks: readonly ResolvedTask[],
    prepError: unknown,
  ): Promise<void> {
    const ticket = options.ticket;
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
    const workerStoppedProof = workersStopped.get(task.index)!;
    const workerTailStoppedProof = workerTailsStopped.get(task.index)!;
    // The task's Git evidence window, once settled: a late worker-truth
    // outcome folds the same evidence over its own observed set.
    let windowEvidence: WindowEvidence | undefined;
    const lifetime = new TaskLifetime({
      task,
      ledger,
      workerStoppedProof,
      workerTailStoppedProof,
      diagnostics: this.diagnostics,
      tickets: this.tickets,
      activity: this.activity,
      grant,
      ticket,
      taskStartedAt,
      syncRunId: options.syncRunId,
      cleanupStoppedWorker: options.cleanupStoppedWorker,
      onTaskOutcomeRecorded: options.onTaskOutcomeRecorded,
      decorateLateOutcome: (late) =>
        windowEvidence === undefined ? late : withGitEvidence(late, windowEvidence),
    });

    // Queued tasks hold no execution resources: pause first, then wait for a
    // serialized writer predecessor, then acquire a concurrency slot.
    // A throw anywhere below is an infrastructure fault, not a task failure —
    // convert it so Promise.all can never reject while siblings still run.
    try {
      const signal = lifetime.attachSignal(combineSignals(
        options.signal,
        ticket ? this.tickets.cancellationSignal(ticket) : undefined,
      ));
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
          const recorded = ledger.read(depIndex);
          const unsatisfiable =
            recorded !== undefined &&
            recorded.quarantined === true &&
            !prerequisiteSatisfied(recorded, tasks[depIndex]!);
          if (!unsatisfiable) {
            await Promise.race([
              workersStopped.get(depIndex)?.promise ?? Promise.resolve(),
              onAbort(signal),
            ]);
          }
          if (signal.aborted) {
            lifetime.recordOutcome({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
            return;
          }
        }
        const blockers = task.dependsOn.filter(
          (depIndex) =>
            !prerequisiteSatisfied(ledger.read(depIndex)!, tasks[depIndex]!),
        );
        if (blockers.length > 0) {
          lifetime.recordOutcome({
            index: task.index,
            id: task.id,
            status: "blocked",
            error:
              `blocked by ${blockers
                .map(
                  (depIndex) =>
                    `'${tasks[depIndex]!.id}' — it ${blockingReason(ledger.read(depIndex), tasks[depIndex]!)}`,
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
        lifetime.recordOutcome({
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
                    outcome: ledger.read(depIndex)!,
                  })),
                  options.config.output,
                ),
            }
          : briefed;
      while (true) {
        if (ticket) await this.waitWhilePaused(ticket, signal);
        if (signal.aborted) {
          lifetime.recordOutcome({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
          return;
        }
        const predecessor = grant.predecessors.get(task.index);
        if (predecessor !== undefined) {
          // Wait for confirmed quiescence, not caller-visible settlement: a
          // provisional predecessor may still be writing the shared root.
          await Promise.race([
            workersStopped.get(predecessor)?.promise ?? Promise.resolve(),
            onAbort(signal),
          ]);
        }
        if (signal.aborted) {
          lifetime.recordOutcome({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
          return;
        }
        // Queued tasks need both a per-model slot and a global slot; abort
        // wakes them without waiting for either.
        const modelRelease = await this.acquireOrAborted(
          this.modelSemaphore(task, options.config),
          signal,
        );
        if (modelRelease === undefined) {
          lifetime.recordOutcome({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
          return;
        }
        const release = await this.acquireOrAborted(this.semaphore, signal);
        if (release === undefined) {
          modelRelease();
          lifetime.recordOutcome({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
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
              lifetime.recordOutcome({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
              return;
            }
            // #127: the admitted span begins here — both slots held and
            // the run body starts. Dependency, pause, predecessor, and
            // slot waits above are queueing, not task duration; the span
            // ends at the visible settlement (TaskLifetime).
            lifetime.markAdmitted();
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
                (handle) => lifetime.executionCreated(handle),
                (handle, late) => lifetime.executionStopped(handle, late),
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
                      const workerStopConfirmed = await Promise.race([
                        workerStoppedProof.promise.then(() => true),
                        new Promise<false>((resolve) =>
                          setTimeout(() => resolve(false), boundMs),
                        ),
                      ]);
                      if (!workerStopConfirmed) {
                        attribution.abandon(openWindow);
                        return;
                      }
                      const evidence = await attribution.settle(openWindow);
                      windowEvidence = evidence;
                      ledger.enrichWithEvidence(task.index, evidence);
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
            lifetime.recordOutcome(outcome);
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
      lifetime.recordOutcome({
        index: task.index,
        id: task.id,
        status: "failed",
        error: `internal dispatch error: ${error instanceof Error ? error.message : String(error)}`,
        retries: 0,
        quarantined: lifetime.workerMayExist || undefined,
      });
    } finally {
      // The run body is over; only executions still winding down (workerStopped()
      // pending) keep the propagation listeners alive past this point.
      lifetime.finishRun();
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

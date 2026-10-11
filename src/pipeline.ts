import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { AdmissionController, AdmissionGrant } from "./admission.ts";
import {
  loadDelegateConfigDetailed,
  RECOGNIZED_CONFIG_KEYS,
  resolveAgentDir,
  telemetryConfigHint,
  type DelegateConfig,
  type DelegateConfigLoad,
  type TelemetryConfig,
} from "./config.ts";
import type { DispatchCoordinator, DispatchOutcome } from "./coordinator.ts";
import type { DiagnosticSink } from "./diagnostics.ts";
import { serializedNotices } from "./format.ts";
import type { AttributionWindows } from "./git-attribution.ts";
import {
  hostEnvironment,
  resolveTasks,
  type HostEnvironment,
  type ParentPromptService,
} from "./host.ts";
import type { DispatchLifetime, DispatchRegistry } from "./lifetime.ts";
import { discoverProfiles } from "./profiles.ts";
import type { SessionPool } from "./sessions.ts";
import type { TelemetryStore } from "./telemetry.ts";
import type { TicketStore } from "./tickets.ts";
import type { OutputBounds, ResolvedTask, TaskOutcome, Ticket } from "./types.ts";
import type { TaskInput } from "./validation.ts";
import { prepareWorkspaces, type WorkspacePlan } from "./workspaces.ts";

/** Emission is adapted and throttled by the extension, across every dispatch. */
export interface UsageEventPayload {
  readonly ticketId?: string;
  readonly taskId?: string;
  readonly provider: string;
  readonly model: string;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

/** Extension-owned services and adapters; the pipeline owns no native API/UI. */
export interface DispatchPipelineDependencies {
  readonly diagnostics: DiagnosticSink;
  readonly tickets: TicketStore;
  readonly admission: AdmissionController;
  readonly sessions: SessionPool;
  readonly coordinator: DispatchCoordinator;
  readonly telemetry: TelemetryStore;
  readonly dispatches: DispatchRegistry;
  /** Shared with the entry's parent mutating-tool hooks. */
  readonly attributionWindows: AttributionWindows;
  readonly parentPrompt: ParentPromptService;
  readonly getActiveTools: () => readonly string[];
  readonly isShuttingDown: () => boolean;
  readonly shutdownQuiescenceBudgetMs: () => number;
  readonly noteMisfire: (
    ctx: ExtensionContext,
    agentDir: string,
    config: TelemetryConfig,
    phase: "config" | "validation" | "admission",
    error: unknown,
    tasks: readonly TaskInput[] | undefined,
    batchWorkspace: "shared" | "scratch" | "isolated" | undefined,
    async: boolean,
  ) => void;
  readonly emitUsage: (payload: UsageEventPayload) => void;
}

export interface DispatchPipelineOptions {
  readonly requestedTasks: readonly TaskInput[];
  readonly ctx: ExtensionContext;
  /** The sync caller's host signal; async batches run on the ticket's. */
  readonly signal?: AbortSignal;
  /** The shared batch brief (SPEC v3 "Batch brief"), if the call set one. */
  readonly brief?: string;
  readonly onNotices?: (notices: readonly string[]) => void;
  /** Inline activity key and display-only refresh at each recorded outcome. */
  readonly syncRunId?: string;
  readonly onTaskOutcomeRecorded?: (task: ResolvedTask, outcome: TaskOutcome) => void;
  /** Creates the durable ticket at the seam between validation and admission. */
  readonly createTicket?: (
    tasks: readonly ResolvedTask[],
    relabel: (label: string) => void,
    config: DelegateConfig,
  ) => Ticket;
}

export interface DispatchPipelineResult {
  readonly completion: Promise<DispatchOutcome>;
  readonly notices: readonly string[];
  readonly ticket: Ticket | undefined;
  /** Resolved tasks, for settled-render spill labels on the sync path. */
  readonly tasks: readonly ResolvedTask[];
  /** The loaded config's output bounds, for the sync result render. */
  readonly outputBounds: OutputBounds;
}

/** One settled task's usage payload: the provider/model that burned it. */
function taskUsagePayload(
  task: ResolvedTask,
  usage: Usage,
  ids: { ticketId?: string; taskId?: string },
): UsageEventPayload {
  return {
    ...ids,
    provider: task.model.provider,
    model: task.model.id,
    totalTokens: usage.totalTokens,
    inputTokens: usage.input,
    outputTokens: usage.output,
    costUsd: usage.cost.total,
  };
}

/**
 * The one dispatch pipeline, from barrier tracking to coordinator handoff,
 * for sync and async batches alike. Ticket creation, origin capture, delivery
 * arming and response formatting remain mode-specific entry adapters.
 */
export class DispatchPipeline {
  private callSeq = 0;
  // Once per extension instance, not per call (see resolveAgentDir).
  private warnedAgentDirFallback = false;
  // Discovery re-reads disk per dispatch; a broken profile warns once per
  // extension instance, not once per run (see discoverProfiles).
  private readonly warnedProfilePaths = new Set<string>();
  // #136: unknown delegate.json keys warn once per changed file content —
  // config path → content fingerprints already warned about. Each path's
  // set is bounded (oldest evicted past 64) and the path map itself is
  // bounded the same way; in practice one path per project or
  // DELEGATE_AGENT_DIR override, but nothing structural pins that.
  private readonly warnedConfigContents = new Map<string, Set<string>>();

  constructor(private readonly dependencies: DispatchPipelineDependencies) {}

  /**
   * #136 warn-once for unknown top-level delegate.json keys: one
   * diagnostic per changed file content, per config path, per extension
   * instance. The event leads with the ignored key names — they are the
   * actionable part and must lead because the sink bounds events to 192
   * chars. The complete ignored list and the recognized set ride in
   * context (bounded at 512 per value), so a long unknown-key list clips
   * the event's skim view without ever dropping names or the recognized
   * set from the record — key names only, never values or the file body.
   * Emission order matters little since DiagnosticSink.log is
   * non-throwing by contract, but the fingerprint is recorded after the
   * emission so a hypothetically throwing sink could not silently eat
   * the warning forever.
   */
  private warnOnUnknownConfigKeys(
    path: string,
    load: DelegateConfigLoad,
  ): void {
    if (load.unknownKeys.length === 0 || load.fingerprint === "") return;
    let warned = this.warnedConfigContents.get(path);
    if (warned === undefined) {
      warned = new Set<string>();
      this.warnedConfigContents.set(path, warned);
      // Map preserves insertion order; evict the oldest path past the
      // bound so a distinct path per dispatch cannot grow it forever.
      while (this.warnedConfigContents.size > 128) {
        const oldest = this.warnedConfigContents.keys().next().value;
        if (oldest === undefined) break;
        this.warnedConfigContents.delete(oldest);
      }
    }
    if (warned.has(load.fingerprint)) return;
    const keys = load.unknownKeys.join(", ");
    this.dependencies.diagnostics.log(
      "warn",
      `delegate.json unknown keys: ${keys}`,
      {
        path,
        keys,
        recognized: RECOGNIZED_CONFIG_KEYS.join(", "),
      },
    );
    warned.add(load.fingerprint);
    // Set preserves insertion order; evict the oldest past the bound.
    while (warned.size > 64) {
      const oldest = warned.values().next().value;
      if (oldest === undefined) break;
      warned.delete(oldest);
    }
  }

  // Register before any preparation can throw or await. Close on every exit:
  // adopted coordinator proofs retain the shutdown hold beyond the handoff.
  async run(options: DispatchPipelineOptions): Promise<DispatchPipelineResult> {
    const lifetime = this.dependencies.dispatches.open(
      options.createTicket !== undefined
        ? "async dispatch (preparing)"
        : "dispatch (preparing)",
    );
    try {
      return await this.runBody(lifetime, options);
    } finally {
      lifetime.close();
    }
  }

  private async runBody(
    lifetime: DispatchLifetime,
    options: DispatchPipelineOptions,
  ): Promise<DispatchPipelineResult> {
    const {
      diagnostics, tickets, admission, sessions, coordinator, telemetry,
      attributionWindows, parentPrompt, getActiveTools, isShuttingDown,
      shutdownQuiescenceBudgetMs, noteMisfire, emitUsage,
    } = this.dependencies;
    const diagnostic = diagnostics.log;
    const { requestedTasks, ctx, signal, onNotices, createTicket } = options;
    // The lifetime is opened by the run wrapper, before anything here can
    // throw or yield: task resolution probes Git for each writer or isolated
    // task's write scope, admission grants reservations, and workspace
    // preparation awaits subprocesses. Shutdown counts this dispatch from
    // the moment the wrapper opens it. (Only async preparation is abortable:
    // sync batches run on the caller's host signal, which shutdown does not
    // abort, so a parked sync dispatch rides out the hold and runs to
    // completion. Async batches run on the ticket's cancellation signal,
    // which shutdown force-cancels — their preparation aborts on its own
    // and the catch below settles the ticket as cancelled.)
    const relabel = (label: string): void => lifetime.relabel(label);
    let ticket: Ticket | undefined;
    let plan: WorkspacePlan | undefined;
    // Everything the failure routine below may still need once admission
    // has run. Admission is synchronous and immediately follows ticket
    // creation, so a ticket that exists at all always has its batch here:
    // a ticket can only be cancelled while this pipeline is parked in an
    // await, and there is none between creation and admission.
    let batch:
      | {
          readonly tasks: readonly ResolvedTask[];
          readonly env: HostEnvironment;
          readonly config: DelegateConfig;
          readonly grant: AdmissionGrant;
          readonly dispatchSignal: AbortSignal | undefined;
          readonly notices: readonly string[];
        }
      | undefined;
    try {
      // Async journal connect: async dispatch needs the saved journal and
      // ticket creation must be durable before workers spawn, but the
      // connect itself is synchronous filesystem setup — it runs here, in
      // the pipeline, rather than in execute's synchronous prefix. A
      // corrupt or inaccessible journal fails async dispatch visibly
      // without blocking synchronous work (which never touches it).
      if (createTicket !== undefined) {
        tickets.connect(resolveAgentDir(ctx).dir);
      }
      const agentDirResolution = resolveAgentDir(ctx);
      if (agentDirResolution.source === "cwd" && !this.warnedAgentDirFallback) {
        this.warnedAgentDirFallback = true;
        diagnostic("warn", "Falling back to agent directory; config and workspace trees use this path. Set DELEGATE_AGENT_DIR explicitly. Diagnostics destination is independent", { path: agentDirResolution.dir });
      }
      const env = hostEnvironment(
        diagnostics,
        ctx,
        agentDirResolution.dir,
        getActiveTools,
        parentPrompt,
      );
      const catalog = discoverProfiles(ctx.cwd, agentDirResolution.dir, {
        warnedPaths: this.warnedProfilePaths,
        diagnostics,
      });
      // Misfire phases (SPEC v3 "Observability"): config-load failures
      // record under "config" (telemetry status salvaged from the raw
      // file — the load itself just failed); task-resolution and
      // pooled-session reuse rejections record under "validation";
      // admission rejections record under "admission".
      let configLoad: DelegateConfigLoad;
      try {
        configLoad = loadDelegateConfigDetailed(
          agentDirResolution.dir,
          catalog.globalNames,
        );
      } catch (error) {
        noteMisfire(
          ctx, agentDirResolution.dir,
          telemetryConfigHint(agentDirResolution.dir),
          "config", error, requestedTasks, undefined,
          createTicket !== undefined,
        );
        throw error;
      }
      const config = configLoad.config;
      this.warnOnUnknownConfigKeys(configLoad.path, configLoad);
      let tasks: readonly ResolvedTask[];
      try {
        tasks = await resolveTasks(requestedTasks, env, config, catalog);
      } catch (error) {
        noteMisfire(
          ctx, agentDirResolution.dir, config.telemetry,
          "validation", error, requestedTasks, undefined,
          createTicket !== undefined,
        );
        throw error;
      }
      // Shutdown may have begun while resolveTasks awaited a Git scope probe.
      // Neither a pre-ticket async call nor a pre-admission sync call may
      // start a worker after shutdown's snapshot of live work.
      if (isShuttingDown()) {
        throw new Error(
          "Delegate shut down while this dispatch was preparing; no worker was started.",
        );
      }
      try {
        sessions.validateReuse(tasks);
      } catch (error) {
        noteMisfire(
          ctx, agentDirResolution.dir, config.telemetry,
          "validation", error, requestedTasks, undefined,
          createTicket !== undefined,
        );
        throw error;
      }
      ticket = createTicket?.(tasks, relabel, config);
      let owner = ticket?.id;
      if (owner === undefined) {
        this.callSeq += 1;
        owner = `call-${this.callSeq}`;
        relabel(owner);
      }
      const dispatchSignal = signal ??
        (ticket ? tickets.cancellationSignal(ticket) : undefined);
      let grant: AdmissionGrant;
      try {
        grant = admission.admit(tasks, owner, {
          sessionFileOf: (sessionId) => sessions.transcriptFileOf(sessionId),
          // Issue #51: a cross-call rejection names live capacity — the
          // coordinator's in-flight count against this call's configured
          // ceiling — beside the held claims it lists.
          capacity: {
            running: coordinator.runningCount(),
            maxConcurrent: config.maxConcurrent,
          },
        });
      } catch (error) {
        noteMisfire(
          ctx, agentDirResolution.dir, config.telemetry,
          "admission", error, requestedTasks, undefined,
          createTicket !== undefined,
        );
        throw error;
      }
      const notices = serializedNotices(tasks, grant.serialized);
      if (ticket) tickets.setNotices(ticket, notices);
      batch = { tasks, env, config, grant, dispatchSignal, notices };
      onNotices?.(notices);
      const telemetrySpan = telemetry.beginDispatch(
        config.telemetry,
        env.agentDir,
        { async: ticket !== undefined, startedAt: Date.now(), tasks },
      );
      plan = await prepareWorkspaces(
        diagnostics,
        tasks,
        grant,
        env.agentDir,
        dispatchSignal,
        telemetrySpan.ownedPaths,
      );
      // The completion is returned without awaiting it here. The lifetime
      // wrapper closes on every exit; the coordinator's adopted proofs cover
      // execution, reconciliation, and cleanup independently of this catch.
      const completion = coordinator
        .run(tasks, {
          env,
          config,
          grant,
          sessions,
          signal: dispatchSignal,
          ticket,
          lifetime,
          syncRunId: options.syncRunId,
          attribution: attributionWindows,
          attributionQuiescenceBoundMs: shutdownQuiescenceBudgetMs(),
          preparePhase: (phase) => plan!.preparePhase(phase),
          reconcilePhase: (phase, outcomes) =>
            // The dispatch facts the batch actually holds: plans consume
            // what applies to them (only isolated reconciliation reads
            // this context).
            plan!.reconcilePhase(phase, outcomes, {
              signal: dispatchSignal,
              shouldApplySource: () => !dispatchSignal?.aborted,
              retainedReason: ticket
                ? "The ticket was cancelled before source application."
                : "The call was aborted before source application.",
            }),
          cleanupStoppedWorker: (taskIndex) => plan!.cleanupWorker(taskIndex),
          disposeUnstarted: () => plan!.dispose(),
          // #60: task settlement is the usage event's firing point — the
          // settled outcome's recorded usage, tagged with its ticket and
          // task. No usage (never ran, cancelled pre-prompt) → no event.
          onTaskOutcomeRecorded: (task, outcome) => {
            if (outcome.usage !== undefined) {
              emitUsage(
                taskUsagePayload(task, outcome.usage, {
                  ticketId: ticket?.id,
                  taskId: task.id,
                }),
              );
            }
            // #119: an inline batch's board refreshes as each outcome
            // lands — display-only, so a throwing emitter is swallowed.
            if (options.onTaskOutcomeRecorded !== undefined) {
              try {
                options.onTaskOutcomeRecorded(task, outcome);
              } catch (error) {
                diagnostic("error", "settle observer failed", { taskId: task.id }, error);
              }
            }
          },
          brief: options.brief,
        })
        .then((outcome) => {
          telemetrySpan.finish(outcome, ticket?.status);
          // #60: batch settlement also reports — one event per distinct
          // provider/model pair with its summed settled usage (the
          // per-instance throttle decides what actually goes out).
          const byModel = new Map<
            string,
            {
              provider: string;
              model: string;
              totalTokens: number;
              inputTokens: number;
              outputTokens: number;
              costUsd: number;
            }
          >();
          for (const settled of outcome.outcomes) {
            if (settled?.usage === undefined) continue;
            const task = tasks[settled.index];
            if (task === undefined) continue;
            const key = `${task.model.provider}/${task.model.id}`;
            const aggregate = byModel.get(key) ?? {
              provider: task.model.provider,
              model: task.model.id,
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            };
            aggregate.totalTokens += settled.usage.totalTokens;
            aggregate.inputTokens += settled.usage.input;
            aggregate.outputTokens += settled.usage.output;
            aggregate.costUsd += settled.usage.cost.total;
            byModel.set(key, aggregate);
          }
          for (const aggregate of byModel.values()) {
            emitUsage({ ticketId: ticket?.id, ...aggregate });
          }
          return outcome;
        })
        .finally(() => {
          if (ticket) tickets.releaseSettlement(ticket);
        });
      return {
        completion,
        notices,
        ticket,
        tasks,
        outputBounds: config.output,
      };
    } catch (error) {
      // The one pre-handoff failure routine. The wrapper closes the
      // lifetime after this, so no barrier is resolved here. A disposal
      // failure must never erase the root cause: log it and keep the
      // original as the thrown error.
      try {
        await plan?.dispose();
      } catch (cleanupError) {
        diagnostic("error", "workspace disposal after preparation failure failed (root cause preserved)", {}, cleanupError);
      }
      if (
        ticket !== undefined &&
        ticket.status !== "running" &&
        batch !== undefined
      ) {
        const cancelledTicket = ticket;
        // Preparation raced a cancellation (shutdown or a force-cancel
        // aborting the workspace copy/worktree): the ticket is already
        // terminal cancelled and the caller still gets its id. End the
        // batch through the coordinator's own settle path — the one
        // batch-end implementation, not a hand-rolled copy: under the
        // already-aborted signal `run` records a cancelled outcome for
        // every task, and its finally releases the grant, finishes the
        // gates, and its adopted full-quiescence work settles the lifetime
        // through the same wiring as any batch. Telemetry records nothing —
        // the span above is never finished for a failed preparation (SPEC.md
        // "Telemetry": failed preparation records nothing).
        diagnostic("info", "async dispatch preparation aborted after cancellation; settling as cancelled", { ticketId: cancelledTicket.id }, error);
        return {
          notices: batch.notices,
          ticket: cancelledTicket,
          tasks: batch.tasks,
          outputBounds: batch.config.output,
          completion: coordinator
            .run(batch.tasks, {
              env: batch.env,
              config: batch.config,
              grant: batch.grant,
              sessions,
              signal: batch.dispatchSignal,
              ticket: cancelledTicket,
              lifetime,
              attribution: attributionWindows,
              attributionQuiescenceBoundMs: shutdownQuiescenceBudgetMs(),
              onTaskOutcomeRecorded: (task, outcome) => {
                if (outcome.usage === undefined) return;
                emitUsage(
                  taskUsagePayload(task, outcome.usage, {
                    ticketId: cancelledTicket.id,
                    taskId: task.id,
                  }),
                );
              },
            })
            .finally(() => tickets.releaseSettlement(cancelledTicket)),
        };
      }
      if (ticket !== undefined && tickets.get(ticket.id) !== undefined) {
        // A ticket whose batch never started is removed rather than
        // exposed: the whole call fails with the cause instead. The get
        // guard matters because create() itself removes its registration
        // when its own creation write throws — removing again would
        // delete another ticket's record if the id were ever reused, and
        // journal.remove() on an unsaved id can only throw noise.
        tickets.remove(ticket.id);
      }
      batch?.grant.release();
      throw error;
    }
  }
}

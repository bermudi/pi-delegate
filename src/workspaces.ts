import { DiagnosticSink } from "./diagnostics.ts";
import { join } from "node:path";
import { DELEGATE_TREES } from "./fsx.ts";
import { prepareIsolated, type IsolatedPlan } from "./isolated.ts";
import { prepareScratch } from "./scratch.ts";
import type { ResolvedTask, TaskOutcome } from "./types.ts";

/**
 * Dispatch-level facts a finalize stage may consult, assembled by the
 * pipeline from what the batch actually has — the batch's signal, whether
 * source application may still proceed, and why retained artifacts were
 * kept. Deliberately mode-neutral: plans consume what applies to them, so a
 * workspace mode that needs different finalize facts extends this only with
 * genuinely dispatch-level fields (see also the deferred workspace policy
 * object in issue #2).
 */
export interface FinalizeContext {
  /** The batch's cancellation signal; consulted around source applies. */
  readonly signal?: AbortSignal;
  /** Whether worker output may still be applied to source trees. */
  readonly shouldApplySource: () => boolean;
  /** Caller-facing explanation when application is refused and artifacts retained. */
  readonly retainedReason?: string;
}

/**
 * The one workspace plan per call. Routes every task by its `workspace` and
 * owns the batch's whole workspace lifecycle — phase-by-phase preparation,
 * phase-by-phase finalize, retained-worker cleanup, and disposal. Callers
 * never see (and so never hand-chain) the per-mode sub-plans; those stay
 * internal to `prepareWorkspaces`.
 */
export interface WorkspacePlan {
  /**
   * Prepare (once) and return the phase's tasks with each scratch/isolated
   * cwd remapped into its copy/worktree. Phase 0 is prepared eagerly at
   * plan creation; a dependent phase's copies and isolated baselines are
   * taken only when its preparePhase runs — after earlier phases finished
   * and their proposals applied, so dependents see their changes.
   */
  preparePhase(phase: number): Promise<readonly ResolvedTask[]>;
  /**
   * Finalize one phase's workspaces: isolated reconciliation first — it
   * applies worker output into source trees and must complete before the
   * next phase's preparation — then scratch discards the copies of
   * confirmed-quiescent workers. Sub-plans consume the context they need:
   * only isolated reconciliation reads it; scratch finalization consults
   * the outcomes alone.
   */
  reconcilePhase(
    phase: number,
    outcomes: TaskOutcome[],
    context: FinalizeContext,
  ): Promise<readonly TaskOutcome[]>;
  /** Discard a retained scratch copy / worktree once quiescence is confirmed. */
  cleanupWorker(taskIndex: number): Promise<void>;
  /** Preparation succeeded but a later stage failed before anything ran. */
  dispose(): Promise<void>;
}

/**
 * True when the batch's outcomes can still be annotated after the last
 * worker settles: isolated reconciliation applies proposals into the
 * source, and scratch finalize attaches drift evidence (#62). A ticketed
 * batch like this holds settlement until the reconciled outcomes land —
 * otherwise a racing `wait` renders the pre-reconcile record (missing
 * integration) while the batch is still reconciling.
 */
export function workspaceNeedsSettlementHold(
  tasks: readonly ResolvedTask[],
): boolean {
  return tasks.some(
    (task) => task.workspace === "isolated" || task.workspace === "scratch",
  );
}

interface PhasePlans {
  readonly scratch?: Awaited<ReturnType<typeof prepareScratch>>;
  readonly isolated?: IsolatedPlan;
}

export async function prepareWorkspaces(
  diagnostics: DiagnosticSink,
  tasks: readonly ResolvedTask[],
  agentDir: string,
  signal?: AbortSignal,
  excludedPaths: readonly string[] = [],
): Promise<WorkspacePlan> {
  const prepared = [...tasks];
  const plans = new Map<number, PhasePlans>();
  const preparedPhases = new Set<number>();
  const reconciledPhases = new Set<number>();
  const firstPhase = Math.min(...tasks.map((task) => task.phase));

  // Scratch before isolated: file copies are cheaper than Git setup, and
  // a later preparation failure can dispose() them. Each stage refines the
  // prepared list in place — isolated receives scratch's remapped cwds and
  // its own translation layers on top. Only this phase's tasks get copies.
  const prepareOne = async (phase: number): Promise<void> => {
    if (preparedPhases.has(phase)) return;
    const scratchPlan = await prepareScratch(
      diagnostics,
      prepared,
      join(agentDir, DELEGATE_TREES.scratch),
      signal,
      phase,
      excludedPaths,
    );
    if (scratchPlan) {
      for (const [index, task] of scratchPlan.tasks.entries()) {
        prepared[index] = task;
      }
    }
    let isolatedPlan: IsolatedPlan | undefined;
    try {
      isolatedPlan = await prepareIsolated(
        diagnostics,
        prepared,
        join(agentDir, DELEGATE_TREES.isolated),
        signal,
        excludedPaths,
        phase,
      );
      if (isolatedPlan) {
        for (const [index, task] of isolatedPlan.tasks.entries()) {
          prepared[index] = task;
        }
      }
    } catch (error) {
      try {
        await scratchPlan?.dispose();
      } catch (cleanupError) {
        diagnostics.log("error", "scratch disposal after isolated preparation failure failed (root cause preserved)", {}, cleanupError);
      }
      throw error;
    }
    plans.set(phase, { scratch: scratchPlan, isolated: isolatedPlan });
    preparedPhases.add(phase);
  };

  // Phase 0 prepares eagerly: its failure is the same whole-call error it
  // always was, before anything ran.
  await prepareOne(firstPhase);

  return {
    preparePhase: async (phase) => {
      await prepareOne(phase);
      return tasks
        .filter((task) => task.phase === phase)
        .map((task) => prepared[task.index]!);
    },
    reconcilePhase: async (phase, outcomes, context) => {
      if (reconciledPhases.has(phase)) return outcomes;
      reconciledPhases.add(phase);
      const plan = plans.get(phase);
      // Scratch drift windows close FIRST (#62): isolated reconciliation
      // applies proposals into the source tree below, and after an apply
      // the drift snapshot can no longer tell a legitimate apply from a
      // shell escape. The capture is read-only and never abort-gated.
      await plan?.scratch?.captureDrift();
      // The one adaptation site between dispatch-level facts and the
      // isolated sub-plan's reconcile options: field-picked explicitly, so
      // a context field can never leak into reconcile unnoticed, and a new
      // required reconcile option surfaces here at compile time.
      if (plan?.isolated) {
        await plan.isolated.reconcile(outcomes, {
          shouldApplySource: context.shouldApplySource,
          retainedReason: context.retainedReason,
          signal: context.signal,
        });
      }
      if (plan?.scratch) await plan.scratch.finalize(outcomes);
      return outcomes;
    },
    cleanupWorker: async (taskIndex) => {
      // A task has exactly one workspace; its own routing decision alone
      // decides which sub-plan holds its retained artifacts.
      const task = tasks[taskIndex];
      const plan = task ? plans.get(task.phase) : undefined;
      if (task?.workspace === "isolated") {
        await plan?.isolated?.cleanupWorker(taskIndex);
      } else if (task?.workspace === "scratch") {
        await plan?.scratch?.cleanupWorker(taskIndex);
      }
    },
    dispose: async () => {
      // A disposal failure must never erase the other plan's failure:
      // collect both, log them, and throw the first so the root cause
      // survives with its sibling visible.
      const settled = await Promise.allSettled(
        [...plans.values()].flatMap((plan) => [
          plan.isolated?.dispose(),
          plan.scratch?.dispose(),
        ]),
      );
      const failures = settled.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      for (const failure of failures) {
        diagnostics.log("error", "workspace dispose failed", {}, failure);
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

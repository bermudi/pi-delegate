import { tailOf } from "./spill.ts";
import type {
  OutputBounds,
  ResolvedTask,
  TaskOutcome,
} from "./types.ts";

/**
 * The dependency graph for one dispatch. `dependsOn` entries are
 * batch-local task ids — caller `id`s or the generated `task-N`
 * fallbacks — resolved here to task indexes; `phases` is the
 * longest-path depth used to order execution and workspace
 * preparation. Validation is total and happens before any task
 * starts: unknown references, self-dependencies, ambiguous effective
 * ids, and cycles are all whole-call errors.
 */
export interface DependencyGraph {
  /** Task index → deduplicated prerequisite task indexes. */
  readonly deps: readonly (readonly number[])[];
  /** Task index → phase (0 with no prerequisites, else deepest dep + 1). */
  readonly phases: readonly number[];
}

/** The id a task answers to inside a batch: its `id`, or `task-<n>`. */
export function effectiveTaskId(id: string | undefined, index: number): string {
  return id ?? `task-${index + 1}`;
}

/**
 * Validate `dependsOn` declarations and compute the graph. Throws an
 * actionable error on the first violation — this is input validation,
 * so it runs before config resolution, admission, and any spawn.
 */
export function resolveDependencyGraph(
  tasks: readonly { id?: string; dependsOn?: readonly string[] }[],
): DependencyGraph {
  const ids = tasks.map((task, index) => effectiveTaskId(task.id, index));
  const hasDeps = tasks.some((task) => (task.dependsOn ?? []).length > 0);

  // An explicit id can collide with a generated `task-N` fallback —
  // reference ambiguity only matters once dependencies exist to
  // resolve, so the check is gated on their presence.
  if (hasDeps) {
    const seen = new Map<string, number>();
    ids.forEach((id, index) => {
      const prior = seen.get(id);
      if (prior !== undefined) {
        throw new Error(
          `task id '${id}' is ambiguous — tasks[${prior}] and tasks[${index}] resolve to it ` +
            `(one may be the generated fallback). Give every task an explicit unique id to use dependsOn.`,
        );
      }
      seen.set(id, index);
    });
  }
  const indexOf = new Map(ids.map((id, index) => [id, index] as const));

  const deps: number[][] = tasks.map(() => []);
  tasks.forEach((task, index) => {
    const where = `tasks[${index}]${task.id ? ` (id '${task.id}')` : ""}`;
    const seen = new Set<number>();
    for (const ref of task.dependsOn ?? []) {
      if (ref === "") {
        throw new Error(`${where}: dependsOn entries must be non-empty task ids.`);
      }
      const dep = indexOf.get(ref);
      if (dep === undefined) {
        throw new Error(
          `${where}: dependsOn refers to unknown task '${ref}'. ` +
            `Task ids in this call: ${ids.join(", ")}.`,
        );
      }
      if (dep === index) {
        throw new Error(`${where}: a task cannot depend on itself ('${ref}').`);
      }
      if (!seen.has(dep)) {
        seen.add(dep);
        deps[index]!.push(dep);
      }
    }
  });

  // Longest-path phase per task; an in-stack revisit names the cycle.
  const phases: number[] = tasks.map(() => 0);
  const state: (0 | 1 | 2)[] = tasks.map(() => 0);
  const stack: number[] = [];
  const visit = (index: number): number => {
    if (state[index] === 2) return phases[index]!;
    if (state[index] === 1) {
      const cycle = [...stack.slice(stack.indexOf(index)), index]
        .map((i) => `'${ids[i]}'`)
        .join(" → ");
      throw new Error(
        `dependsOn forms a cycle: ${cycle}. Dependencies must point to independent tasks.`,
      );
    }
    state[index] = 1;
    stack.push(index);
    let depth = 0;
    for (const dep of deps[index]!) {
      depth = Math.max(depth, visit(dep) + 1);
    }
    stack.pop();
    state[index] = 2;
    phases[index] = depth;
    return depth;
  };
  for (let index = 0; index < tasks.length; index++) visit(index);

  return { deps, phases };
}

/**
 * True when `task` transitively depends on `dep` — i.e. `dep` must
 * finish before `task` starts. Used by admission to decide whether an
 * overlapping cross-kind pair is ordered by the graph.
 */
export function dependsTransitively(
  deps: readonly (readonly number[])[],
  task: number,
  dep: number,
): boolean {
  const seen = new Set<number>();
  const stack = [...deps[task]!];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === dep) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...deps[current]!);
  }
  return false;
}

/**
 * Whether a prerequisite's final outcome unblocks its dependents. An
 * isolated prerequisite must additionally have landed (or cleanly
 * lacked) its proposal — an applied-unverified or no-changes
 * integration means its work is visible in the tree the dependent
 * reads; anything else means the dependent would start on a tree
 * missing the work it declared it needs.
 */
export function prerequisiteSatisfied(
  outcome: TaskOutcome,
  dep: ResolvedTask,
): boolean {
  if (outcome.status !== "ok") return false;
  if (dep.workspace !== "isolated") return true;
  const status = outcome.integration?.status;
  return status === "applied_unverified" || status === "no_changes";
}

/** Why a prerequisite blocks its dependent — for the `blocked` error. */
export function blockingReason(
  outcome: TaskOutcome | undefined,
  dep: ResolvedTask,
): string {
  if (outcome === undefined) {
    return "no outcome was recorded for it";
  }
  if (outcome.status === "blocked") {
    return "was itself blocked";
  }
  if (outcome.status !== "ok") {
    return outcome.error
      ? `${outcome.status} — ${outcome.error}`
      : `ended ${outcome.status}`;
  }
  const status = outcome.integration?.status;
  return status === undefined
    ? "its isolated proposal was never reconciled — its changes are not in the tree"
    : `its isolated proposal ended '${status}' — its changes are not in the tree`;
}

/** A prerequisite's output projected into a dependent's prompt. */
function handoffOutput(output: string, bounds: OutputBounds): string {
  if (output.length <= bounds.spillThresholdChars) return output;
  return (
    `…${tailOf(output, bounds.spillThresholdChars)}\n` +
    `[prerequisite output truncated to its last ${bounds.spillThresholdChars} chars; ` +
    `the complete output is on its task result]`
  );
}

/**
 * The handoff appendix appended to a dependent's prompt: one section
 * per declared prerequisite with its id, what became of its work, and
 * its bounded final output. Only called once every prerequisite is
 * known-satisfied, so every section describes a completed task.
 */
export function handoffAppendix(
  deps: readonly { task: ResolvedTask; outcome: TaskOutcome }[],
  bounds: OutputBounds,
): string {
  const sections = deps.map(({ task, outcome }) => {
    let note = "";
    if (task.workspace === "isolated") {
      const integration = outcome.integration;
      if (
        integration?.status === "applied_unverified" &&
        integration.appliedFiles.length > 0
      ) {
        note =
          ` Its proposal was applied to the working tree ` +
          `(${integration.appliedFiles.length} file(s): ${integration.appliedFiles.join(", ")}). ` +
          `Inspect the actual changes, not just this summary.`;
      } else if (integration?.status === "no_changes") {
        note = " It made no changes to the tree.";
      }
    } else if (task.workspace === "scratch") {
      note =
        " It ran in a disposable scratch copy; its edits were discarded — only its output is handed off.";
    }
    const output =
      outcome.output !== undefined && outcome.output.trim() !== ""
        ? handoffOutput(outcome.output, bounds)
        : "(no output)";
    return `### '${outcome.id}' — completed${note}\n${output}`;
  });
  return (
    `\n\n---\nHandoffs from prerequisite tasks (finished before this one started):\n\n` +
    sections.join("\n\n")
  );
}

import { sep } from "node:path";
import { dependsTransitively } from "./graph.ts";
import type { ResolvedTask } from "./types.ts";

/** True when canonical root `a` equals, contains, or is contained in `b`. */
export function rootsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  // "/" + sep is "//", which no absolute path starts with — without
  // this special case a writer at "/" would never overlap anything and
  // bypass both same-call serialization and cross-call rejection.
  if (a === sep || b === sep) return true;
  const normA = a.length > 1 && a.endsWith(sep) ? a.slice(0, -1) : a;
  const normB = b.length > 1 && b.endsWith(sep) ? b.slice(0, -1) : b;
  if (normA === normB) return true;
  return normA.startsWith(normB + sep) || normB.startsWith(normA + sep);
}

/**
 * Environment redirects that would make a child `bash` invocation see a
 * different repository than the one admission reserved. The probe in
 * `writeRootsOf` scrubs them, but the child's shell still inherits them, so
 * a bash-capable multi-writer batch cannot be verified safely while they
 * are set.
 */
const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"] as const;

interface Reservation {
  readonly root: string;
  readonly owner: string;
  readonly kind: "shared" | "isolated";
  readonly taskIndex: number;
}

export interface AdmissionGrant {
  /**
   * Task index → task index of the predecessor it must wait for. Same-call
   * overlapping shared writers serialize in task order.
   */
  readonly predecessors: ReadonlyMap<number, number>;
  /**
   * Groups of same-call shared writers that serialize, in task order, with
   * the write roots they overlap on — the evidence for advisory notices.
   */
  readonly serialized: readonly {
    tasks: readonly number[];
    roots: readonly string[];
  }[];
  /**
   * Release every reservation taken by this call. Task indexes in `retain`
   * keep their reservations and busy-session marks: those tasks could not
   * be confirmed quiescent, so their roots stay protected until
   * `releaseRetained` observes confirmed quiescence — or for the life of
   * the process if it never comes.
   */
  readonly release: (retain?: ReadonlySet<number>) => void;
  /**
   * Release the reservations retained for one task. Only meaningful after
   * that task's worker has been confirmed quiescent; calling it earlier
   * would un-protect roots that may still be mutating.
   */
  readonly releaseRetained: (taskIndex: number) => void;
}

/**
 * The admission boundary for dispatch. All conflict decisions live here:
 * same-call mixed-workspace overlap, cross-call writer/session conflicts.
 * Reservations are held for the life of a call or ticket — including while
 * cancellation winds down — so conflicting work rejects deterministically
 * instead of partially starting.
 */
export class AdmissionController {
  private readonly reservations: Reservation[] = [];
  private readonly busySessions = new Map<string, { owner: string; taskIndex: number }>();

  /** True while a live call or ticket holds this sessionId. */
  isSessionBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  /**
   * Check then reserve. Throws an actionable error on any conflict; on
   * success the caller owns the reservations until `release()`.
   */
  admit(tasks: readonly ResolvedTask[], owner: string): AdmissionGrant {
    const reserving = tasks.filter((task) => task.writeRoots !== undefined);

    // Inherited Git redirects: a scrubbed probe can still name the real
    // repository root, but a child bash tool would run under the redirect —
    // and the isolated machinery itself drives Git, so it needs the same
    // protection. Multi-writer batches fail closed rather than trust a
    // narrowed scope.
    const redirects = GIT_REDIRECTS.filter(
      (name) => process.env[name] !== undefined,
    );
    if (
      reserving.length >= 2 &&
      redirects.length > 0 &&
      reserving.some((task) => task.tools.includes("bash"))
    ) {
      throw new Error(
        `Could not safely verify a bash-capable multi-writer batch while ${redirects.join(", ")} redirects Git repository context.`,
      );
    }

    // Within-call: group reserving tasks by root overlap (connected
    // components, union-find). An edge the dependency graph already orders
    // is not a concurrency hazard — the pair never runs at the same time —
    // so it must not bridge two otherwise-disjoint tasks into one group:
    // task A under /repo/x and task C under /repo/y share no root even
    // when task B reserves /repo itself sits between them, provided every
    // truly-overlapping cross-kind edge is ordered. Same-kind edges always
    // group (their writers serialize in task order regardless of phase).
    const overlaps = (
      a: readonly string[],
      b: readonly string[],
    ): boolean => a.some((ra) => b.some((rb) => rootsOverlap(ra, rb)));
    const deps = tasks.map((task) => task.dependsOn);
    const orderedPair = (
      a: (typeof reserving)[number],
      b: (typeof reserving)[number],
    ): boolean =>
      dependsTransitively(deps, a.index, b.index) ||
      dependsTransitively(deps, b.index, a.index);
    const parent = reserving.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    for (let i = 0; i < reserving.length; i++) {
      for (let j = i + 1; j < reserving.length; j++) {
        const a = reserving[i]!;
        const b = reserving[j]!;
        if (!overlaps(a.writeRoots!, b.writeRoots!)) continue;
        if (a.workspace !== b.workspace && orderedPair(a, b)) continue;
        parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, typeof reserving>();
    reserving.forEach((task, i) => {
      const root = find(i);
      groups.set(root, [...(groups.get(root) ?? []), task]);
    });

    const predecessors = new Map<number, number>();
    const serialized: { tasks: readonly number[]; roots: readonly string[] }[] =
      [];
    for (const group of groups.values()) {
      const kinds = new Set(group.map((task) => task.workspace));
      if (kinds.size > 1) {
        // Mixed shared/isolated overlap is admitted only when the
        // dependency graph orders every overlapping cross-kind pair —
        // either direction works: a shared dependent reads the tree
        // after the isolated proposal applied; an isolated dependent
        // is worktreed after the shared writer stopped. Unordered
        // pairs could still run concurrently and must reject.
        const unordered = group.some((a, i) =>
          group.some(
            (b, j) =>
              i < j &&
              a.workspace !== b.workspace &&
              !dependsTransitively(deps, a.index, b.index) &&
              !dependsTransitively(deps, b.index, a.index),
          ),
        );
        if (unordered) {
          const roots = [
            ...new Set(group.flatMap((task) => task.writeRoots!)),
          ].join(", ");
          throw new Error(
            `Conflicting workspaces: shared and isolated tasks in one call overlap at ${roots}. ` +
              `Split them into separate calls, or order them with dependsOn.`,
          );
        }
      }
      // Same-call shared writers serialize in task order, chaining
      // consecutive writers in (phase, index) order — including across
      // phases. The phase boundary awaits recorded outcomes, not
      // confirmed quiescence, so without a cross-phase edge a later-phase
      // writer could start while an earlier quarantined writer still
      // mutates the root. The sort keeps every predecessor in the same
      // or an earlier phase, so an edge never points at a task whose
      // phase has not started — that direction would deadlock the loop.
      const writers = group.filter((task) => task.workspace === "shared");
      if (writers.length > 1) {
        const ordered = [...writers].sort(
          (a, b) => a.phase - b.phase || a.index - b.index,
        );
        for (let i = 1; i < ordered.length; i++) {
          predecessors.set(ordered[i]!.index, ordered[i - 1]!.index);
        }
        serialized.push({
          tasks: ordered.map((task) => task.index),
          roots: [...new Set(ordered.flatMap((task) => task.writeRoots!))],
        });
      }
    }

    // Cross-call: no reserving task may overlap another owner's reservation.
    for (const task of reserving) {
      for (const reservation of this.reservations) {
        if (task.writeRoots!.some((root) => rootsOverlap(root, reservation.root))) {
          throw new Error(
            `Task ${task.id} conflicts with ${reservation.kind === "isolated" ? "an isolated" : "a shared"} write already running in ${reservation.root} (owner: ${reservation.owner}). Wait for it to finish or use a different cwd.`,
          );
        }
      }
    }

    // Sessions: a sessionId in use by a live call or ticket is busy.
    for (const task of tasks) {
      if (task.sessionId === undefined) continue;
      const holder = this.busySessions.get(task.sessionId);
      if (holder !== undefined && holder.owner !== owner) {
        throw new Error(
          `Session '${task.sessionId}' is busy running work for ${holder.owner}; wait for it to finish or cancel the owning ticket.`,
        );
      }
    }

    // Reserve.
    const taken: Reservation[] = reserving.flatMap((task) =>
      task.writeRoots!.map((root) => ({
        root,
        owner,
        kind: task.workspace === "isolated" ? ("isolated" as const) : ("shared" as const),
        taskIndex: task.index,
      })),
    );
    this.reservations.push(...taken);
    const heldSessions = tasks
      .filter((task) => task.sessionId !== undefined)
      .map((task) => ({ sessionId: task.sessionId!, taskIndex: task.index }));
    for (const held of heldSessions) {
      this.busySessions.set(held.sessionId, {
        owner,
        taskIndex: held.taskIndex,
      });
    }

    let released = false;
    const allIndexes = new Set(tasks.map((task) => task.index));
    const releaseIndexes = (indexes: ReadonlySet<number>): void => {
      for (const reservation of taken) {
        if (!indexes.has(reservation.taskIndex)) continue;
        const index = this.reservations.indexOf(reservation);
        if (index >= 0) this.reservations.splice(index, 1);
      }
      for (const held of heldSessions) {
        if (!indexes.has(held.taskIndex)) continue;
        const current = this.busySessions.get(held.sessionId);
        if (current?.owner === owner) {
          this.busySessions.delete(held.sessionId);
        }
      }
    };
    return {
      predecessors,
      serialized,
      release: (retain?: ReadonlySet<number>) => {
        if (released) return;
        released = true;
        releaseIndexes(
          retain === undefined
            ? allIndexes
            : new Set([...allIndexes].filter((index) => !retain.has(index))),
        );
      },
      releaseRetained: (taskIndex: number) => {
        releaseIndexes(new Set([taskIndex]));
      },
    };
  }
}

import { DiagnosticSink } from "./diagnostics.ts";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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

/**
 * Canonical transcript path for exclusivity matching: realpath defeats
 * symlink aliases (v1 quarantined canonical aliases too). A missing leaf —
 * a pooled session's first file, a stale resumeFrom — realpaths its parent
 * instead, so a symlinked ancestor still converges both spellings onto one
 * key; only a missing parent falls back to the lexical absolute.
 */
function canonicalTranscript(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

interface Reservation {
  readonly root: string;
  readonly owner: string;
  readonly kind: "shared" | "isolated";
  readonly taskIndex: number;
  /** The holding task's caller-visible id — reported on rejections. */
  readonly taskId: string;
}

export interface AdmissionGrant {
  /** Read protection only during a scratch source copy; release after cp settles. */
  readonly acquireSourceRead: (taskIndex: number, root: string) => () => void;
  /** Coordinator proof: worker, deferred cleanup, and reconciliation are done. */
  readonly confirmTaskQuiescence: (taskIndex: number) => void;
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
   * Claim exclusive ownership of a transcript file for one task, once the
   * concrete file is known — used for a pooled session's first run, whose
   * file does not exist at admission time. Throws when another live owner
   * holds the canonical path (a narrow admit-vs-hold race surfacing as a
   * visible task failure). Idempotent per (task, path).
   */
  readonly holdTranscript: (taskIndex: number, path: string) => void;
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
  private readonly sourceReads: { root: string; owner: string; taskId: string }[] = [];

  constructor(private readonly diagnostics: DiagnosticSink) {}
  private readonly busySessions = new Map<string, { owner: string; taskIndex: number }>();
  /** Canonical transcript files owned by live work (resumeFrom or a pooled
   * session's file). One transcript, one owner at a time. */
  private readonly busyTranscripts = new Map<
    string,
    { owner: string; taskIndex: number }
  >();

  /** True while a live call or ticket holds this sessionId. */
  isSessionBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  /**
   * Check then reserve. Throws an actionable error on any conflict; on
   * success the caller owns the reservations until `release()`.
   * `live.sessionFileOf` resolves a pooled session's transcript file when
   * the pool already knows it (a first run's file is claimed later through
   * the grant's `holdTranscript`).
   */
  admit(
    tasks: readonly ResolvedTask[],
    owner: string,
    live?: {
      sessionFileOf?: (sessionId: string) => string | undefined;
      /**
       * Dispatch capacity at check time — the coordinator's in-flight
       * task count and the call's configured `maxConcurrent`. When given,
       * a cross-call write conflict names them beside the held claims so
       * the rejection carries live context, not just the blocking claim.
       */
      capacity?: { running: number; maxConcurrent: number };
    },
  ): AdmissionGrant {
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
        `Could not safely verify a bash-capable multi-writer batch while ${redirects.join(", ")} redirects Git repository context. Clear or fix these inherited environment redirects, then retry.`,
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
      // Same-call shared writers serialize, chaining consecutive writers
      // in (phase, index) order. #126: same-phase overlapping shared
      // writers reject below — a graph edge always lands in a later phase,
      // so every same-phase pair is unordered by construction. Cross-phase
      // pairs (graph-ordered or incidentally separated) keep the chain:
      // every chained predecessor sits in an earlier phase, so an edge
      // never points at a task whose phase has not started — that
      // direction would deadlock the loop.
      const writers = group.filter((task) => task.workspace === "shared");
      if (writers.length > 1) {
        // #126: same-phase overlapping shared writers reject instead of
        // silently serializing. The advisory notice shipped 2026-09-12
        // (e0998c3) and was delivered five times in session 01a11872
        // with zero behavior change — the incumbent-trained fan-out
        // reflex beats prose on every fresh dispatch. Cross-phase pairs
        // keep the serialization contract below: their separation is
        // sound (a phase fully settles, quarantine included, before the
        // next admits) and dependsOn would change failure semantics
        // (blocking) where the caller asked for sequencing only.
        const phaseCounts = new Map<number, { count: number; ids: string[] }>();
        for (const task of writers) {
          const entry = phaseCounts.get(task.phase) ?? { count: 0, ids: [] };
          entry.count += 1;
          entry.ids.push(task.id);
          phaseCounts.set(task.phase, entry);
        }
        const concurrent = [...phaseCounts.values()].filter(
          (entry) => entry.count > 1,
        );
        if (concurrent.length > 0) {
          const roots = [
            ...new Set(group.flatMap((task) => task.writeRoots!)),
          ].join(", ");
          const names = concurrent
            .flatMap((entry) => entry.ids)
            .map((id) => `'${id}'`)
            .join(", ");
          throw new Error(
            `Unordered shared writers: tasks ${names} reserve overlapping write scope at ${roots} with no dependsOn ordering. ` +
              `Order them with dependsOn (they run one at a time in order), run independent edits with workspace "isolated" (parallel, merged in task order), or split them into separate calls.`,
          );
        }
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
          // Live context (issue #51): the running-task count against the
          // configured cap plus every held write claim, so a caller can
          // see both who blocks this task and how busy dispatch is.
          const context =
            live?.capacity === undefined
              ? ""
              : ` Right now ${live.capacity.running}/${live.capacity.maxConcurrent} tasks are running; held write claims: ${this.reservations
                  .map((held) => `${held.taskId} (owner ${held.owner})`)
                  .join(", ")}.`;
          throw new Error(
            `Task ${task.id} conflicts with ${reservation.kind === "isolated" ? "an isolated" : "a shared"} write already running in ${reservation.root} (owner: ${reservation.owner}).${context} Wait for it to finish or use a different cwd.`,
          );
        }
      }
    }

    // Reverse direction: writer admission is atomic against copying readers.
    for (const task of reserving) {
      for (const read of this.sourceReads) {
        if (!task.writeRoots!.some((root) => rootsOverlap(root, read.root))) continue;
        this.diagnostics.log("info", "scratch source read conflict", {
          taskId: task.id, by: read.owner, path: read.root, operation: "writer admission",
        });
        throw new Error(
          `Task ${task.id} conflicts with scratch source copying at ${read.root} (owner: ${read.owner}, task: ${read.taskId}). Wait for the copy to finish, then retry; scratch worker execution does not hold this read claim.`,
        );
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

    // Transcripts: a resumeFrom file, and a pooled session's file when the
    // pool knows it, are exclusive while their worker is live — one writer
    // per transcript (children write into resumed transcripts, and a pooled
    // session's file is its durable state). Symlink aliases canonicalize,
    // like v1's quarantine. Within one call two tasks never share one
    // transcript; across calls the current owner blocks until it settles
    // (retained under quarantine, like every other reservation).
    const transcriptOf = (task: ResolvedTask): string | undefined => {
      if (task.resumeFrom !== undefined) {
        return canonicalTranscript(task.resumeFrom);
      }
      if (task.sessionId !== undefined) {
        const file = live?.sessionFileOf?.(task.sessionId);
        return file === undefined ? undefined : canonicalTranscript(file);
      }
      return undefined;
    };
    const heldTranscripts: { path: string; taskIndex: number }[] = [];
    const seenInCall = new Map<string, string>();
    for (const task of tasks) {
      const path = transcriptOf(task);
      if (path === undefined) continue;
      const sibling = seenInCall.get(path);
      if (sibling !== undefined) {
        throw new Error(
          `Tasks '${sibling}' and '${task.id}' resume the same transcript (${path}); a transcript has one owner at a time. Chain the work in separate calls, or hand off through the task prompt.`,
        );
      }
      seenInCall.set(path, task.id);
      const holder = this.busyTranscripts.get(path);
      if (holder !== undefined && holder.owner !== owner) {
        throw new Error(
          `Transcript '${path}' is still in use by work running for ${holder.owner}; wait for it to finish or cancel it.`,
        );
      }
      heldTranscripts.push({ path, taskIndex: task.index });
    }

    // Reserve.
    const taken: Reservation[] = reserving.flatMap((task) =>
      task.writeRoots!.map((root) => ({
        root,
        owner,
        kind: task.workspace === "isolated" ? ("isolated" as const) : ("shared" as const),
        taskIndex: task.index,
        taskId: task.id,
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
    for (const held of heldTranscripts) {
      this.busyTranscripts.set(held.path, { owner, taskIndex: held.taskIndex });
    }

    const quiescent = new Set<number>();
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
      for (const held of heldTranscripts) {
        if (!indexes.has(held.taskIndex)) continue;
        const current = this.busyTranscripts.get(held.path);
        if (current?.owner === owner) {
          this.busyTranscripts.delete(held.path);
        }
      }
    };
    return {
      confirmTaskQuiescence: (taskIndex) => { quiescent.add(taskIndex); },
      acquireSourceRead: (taskIndex, root) => {
        const task = tasks.find((candidate) => candidate.index === taskIndex);
        if (released || task === undefined || task.workspace !== "scratch") {
          throw new Error("Cannot claim scratch source copying without a live scratch task owner.");
        }
        for (const held of this.reservations) {
          if (!rootsOverlap(root, held.root)) continue;
          // Own current/future phase writers have not started: phase preparation
          // finishes before workers begin. Earlier phase writers are exempt only
          // after worker/deferred cleanup quiescence AND reconciliation finished.
          if (held.owner === owner) {
            const writer = tasks.find((candidate) => candidate.index === held.taskIndex)!;
            if (writer.phase >= task.phase || quiescent.has(held.taskIndex)) continue;
          }
          this.diagnostics.log("info", "scratch source read conflict", {
            taskId: task.id, by: held.owner, path: root, operation: "source read acquisition",
            status: held.kind,
          });
          throw new Error(
            `Scratch task ${task.id} cannot copy source ${root}: overlapping ${held.kind} writer ${held.taskId} (owner: ${held.owner}) is active or quarantined. Wait for confirmed quiescence, then retry.`,
          );
        }
        const read = { root, owner, taskId: task.id };
        this.sourceReads.push(read);
        this.diagnostics.log("info", "scratch source read acquired", { taskId: task.id, by: owner, path: root });
        let done = false;
        return () => {
          if (done) return;
          done = true;
          this.sourceReads.splice(this.sourceReads.indexOf(read), 1);
          this.diagnostics.log("info", "scratch source read released", { taskId: task.id, by: owner, path: root });
        };
      },
      predecessors,
      serialized,
      holdTranscript: (taskIndex: number, rawPath: string): void => {
        const path = canonicalTranscript(rawPath);
        if (
          heldTranscripts.some(
            (held) => held.path === path && held.taskIndex === taskIndex,
          )
        ) {
          return; // idempotent re-claim by the same task
        }
        const holder = this.busyTranscripts.get(path);
        if (holder !== undefined && holder.owner !== owner) {
          throw new Error(
            `Transcript '${path}' is in use by work running for ${holder.owner}; this task cannot run until that work finishes or is cancelled.`,
          );
        }
        heldTranscripts.push({ path, taskIndex });
        this.busyTranscripts.set(path, { owner, taskIndex });
      },
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

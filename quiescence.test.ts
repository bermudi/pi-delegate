import { describe, expect, test } from "bun:test";
import {
  createQuiescenceBarrier,
  DEFAULT_QUIESCENCE_TIMINGS,
  type CancellationSource,
  type QuiescenceBarrier,
  type QuiescenceTimings,
} from "./quiescence.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A minimal stand-in for the two session flags the barrier observes, plus the
 * event feed. Mirrors the real coupling: a host that changes busy state without
 * emitting an event is a supported (if degraded) case, so state and events are
 * driven independently.
 */
function fakeSession(hooks: { onIdleRead?: () => void; reads: { n: number } }) {
  const state = { busy: false, compacting: false };
  let barrier: QuiescenceBarrier | undefined;
  return {
    session: {
      get isIdle() {
        hooks.reads.n++;
        hooks.onIdleRead?.();
        return !state.busy;
      },
      get isCompacting() {
        return state.compacting;
      },
    },
    state,
    attach(next: QuiescenceBarrier) {
      barrier = next;
    },
    /** Change busy state and announce it, the way AgentSession normally does. */
    emit() {
      barrier?.noteEvent();
    },
  };
}

type Harness = {
  barrier: QuiescenceBarrier;
  state: { busy: boolean; compacting: boolean };
  /** `onIdleRead` fires inside the session's `isIdle` getter. */
  hooks: { onIdleRead?: () => void; reads: { n: number } };
  emit: () => void;
  cancels: CancellationSource[];
  abandoned: { source: CancellationSource; waitedMs: number }[];
  setCancellation: (source: CancellationSource | undefined) => void;
};

function harness(
  options: {
    timings?: Partial<QuiescenceTimings>;
    unrefTimers?: boolean;
    /** Called on every re-abort, before the cancel is recorded. */
    onCancel?: (h: Harness) => void;
  } = {},
): Harness {
  const hooks: Harness["hooks"] = { reads: { n: 0 } };
  const fake = fakeSession(hooks);
  let cancellation: CancellationSource | undefined;
  const cancels: CancellationSource[] = [];
  const abandoned: { source: CancellationSource; waitedMs: number }[] = [];

  const h = {
    state: fake.state,
    hooks,
    emit: fake.emit,
    cancels,
    abandoned,
    setCancellation: (source: CancellationSource | undefined) => {
      cancellation = source;
    },
  } as Harness;

  h.barrier = createQuiescenceBarrier({
    session: fake.session,
    cancellation: () => cancellation,
    cancel: (source) => {
      options.onCancel?.(h);
      cancels.push(source);
      // The runner notes the cancellation point after dispatching abort.
      h.barrier.noteCancellationRequested();
    },
    timings: options.timings,
    unrefTimers: options.unrefTimers,
    onAbandon: ({ source, waitedMs }) => abandoned.push({ source, waitedMs }),
  });
  fake.attach(h.barrier);
  return h;
}

const tick = (ms = 0) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createQuiescenceBarrier", () => {
  test("returns immediately when the session is already idle and quiet", async () => {
    const h = harness();
    expect(await h.barrier.wait()).toBe("quiescent");
    expect(h.cancels).toEqual([]);
  });

  test("waits for a busy session to go idle", async () => {
    const h = harness();
    h.state.busy = true;

    let settled = false;
    const done = h.barrier.wait().then((outcome) => {
      settled = true;
      return outcome;
    });

    await tick(20);
    expect(settled).toBe(false);

    h.state.busy = false;
    h.emit();
    expect(await done).toBe("quiescent");
  });

  test("waits through compaction even while the agent loop is idle", async () => {
    // The whole reason the barrier exists: after prompt() resolves the agent is
    // idle, but a detached ctx.compact() is still running.
    const h = harness();
    h.state.compacting = true;

    let settled = false;
    const done = h.barrier.wait().then(() => (settled = true));

    await tick(20);
    expect(settled).toBe(false);

    h.state.compacting = false;
    h.emit();
    await done;
    expect(settled).toBe(true);
  });

  test("does not accept a quiet turn that races an incoming event", async () => {
    // An event landing between the generation sample and the state check must
    // reset progress — that is the exact race the generation counter closes.
    // Emitting from inside the isIdle read reproduces it deterministically.
    const h = harness();
    let emitted = 0;
    h.hooks.onIdleRead = () => {
      if (emitted < 3) {
        emitted++;
        h.emit();
      }
    };

    expect(await h.barrier.wait()).toBe("quiescent");
    expect(emitted).toBe(3);
    // 3 racing reads that had to be discarded, then 2 genuinely quiet turns.
    expect(h.hooks.reads.n).toBe(5);
  });

  test("liveness probe releases a busy session that never emits an event", async () => {
    // Some host versions clear an internal busy flag without a public event.
    const h = harness({ timings: { eventProbeMs: 10 } });
    h.state.busy = true;
    const done = h.barrier.wait();
    await tick(5);
    h.state.busy = false; // no emit()
    expect(await done).toBe("quiescent");
  });

  test("re-aborts work that starts after cancellation", async () => {
    const h = harness();
    h.setCancellation("parent-aborted");
    h.barrier.noteCancellationRequested();

    let started = false;
    setTimeout(() => {
      // A continuation from an onComplete callback, delayed past the microtask
      // batch by async auth.
      started = true;
      h.state.busy = true;
      h.emit();
      h.state.busy = false;
      h.emit();
    }, 10);

    expect(await h.barrier.wait()).toBe("quiescent");
    expect(started).toBe(true);
    expect(h.cancels).toEqual(["parent-aborted"]);
  });

  test("re-aborts a continuation that already finished between samples", async () => {
    // Detection, not prevention: the session is idle again by the time the loop
    // looks, but the generation moved. Extending the wait is the only way to
    // notice a *further* continuation.
    const h = harness();
    h.setCancellation("stalled");
    h.barrier.noteCancellationRequested();
    h.emit(); // whole continuation collapsed into one turn

    expect(await h.barrier.wait()).toBe("quiescent");
    expect(h.cancels).toEqual(["stalled"]);
  });

  test("skips the grace wait and re-abort while the task is healthy", async () => {
    // An uncancelled task must not pay the grace period, and must never have
    // cancel() called on its behalf.
    const h = harness({ timings: { cancelledGraceMs: 5_000 } });
    h.barrier.noteCancellationRequested();
    h.emit();
    expect(await h.barrier.wait()).toBe("quiescent");
    expect(h.cancels).toEqual([]);
  });

  test("reports the current cancellation source to cancel()", async () => {
    const h = harness();
    h.setCancellation("deadline");
    h.barrier.noteCancellationRequested();
    h.emit();
    await h.barrier.wait();
    expect(h.cancels).toEqual(["deadline"]);
  });

  test("converges when abort itself emits asynchronous settlement events", async () => {
    // Real abort() is idempotent: it emits settlement events on the first call
    // only. Each re-abort resets the tracker, so the loop must terminate.
    let firstCancel = true;
    const h = harness({
      onCancel: (self) => {
        if (!firstCancel) return;
        firstCancel = false;
        void (async () => {
          await Promise.resolve();
          self.emit();
          self.emit();
        })();
      },
    });
    h.setCancellation("parent-aborted");
    h.barrier.noteCancellationRequested();
    h.emit();

    expect(await h.barrier.wait()).toBe("quiescent");
    expect(h.cancels.length).toBeLessThanOrEqual(3);
  });

  test("abandons a cancelled unwind that never converges", async () => {
    // An extension that keeps launching continuations would otherwise reset
    // progress forever and hang the delegate task. The bound is what makes the
    // barrier safe to await unconditionally.
    const h = harness({
      timings: { cancelledUnwindBudgetMs: 30, cancelledGraceMs: 1 },
    });
    h.setCancellation("stalled");
    h.barrier.noteCancellationRequested();
    const pump = setInterval(() => h.emit(), 1);

    const outcome = await h.barrier.wait();
    clearInterval(pump);

    expect(outcome).toBe("abandoned");
    expect(h.abandoned).toHaveLength(1);
    expect(h.abandoned[0]?.source).toBe("stalled");
    expect(h.cancels.length).toBeGreaterThan(1);
  });

  test("abandons a cancelled session that never goes idle", async () => {
    const h = harness({ timings: { cancelledUnwindBudgetMs: 25 } });
    h.state.busy = true;
    h.setCancellation("parent-aborted");
    h.barrier.noteCancellationRequested();

    expect(await h.barrier.wait()).toBe("abandoned");
  });

  test("unrefs quarantine recovery probes", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let unrefs = 0;
    const timers = new Set<object>();
    globalThis.setTimeout = ((callback: () => void) => {
      const handle = {
        callback,
        unref: () => {
          unrefs++;
          return handle;
        },
      };
      timers.add(handle);
      return handle as never;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: object) => {
      timers.delete(handle);
    }) as typeof clearTimeout;

    try {
      const h = harness({
        unrefTimers: true,
        timings: { eventProbeMs: 10_000 },
      });
      h.state.busy = true;
      const done = h.barrier.wait();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unrefs).toBeGreaterThan(0);

      h.state.busy = false;
      h.emit();
      expect(await done).toBe("quiescent");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("does not bound a healthy wait", async () => {
    // A legitimate remote compaction can take minutes; cutting it short would
    // re-open the disposal race. The stall watchdog, not the budget, rescues a
    // wedged healthy session.
    const h = harness({
      timings: { cancelledUnwindBudgetMs: 5, eventProbeMs: 5 },
    });
    h.state.compacting = true;

    let settled = false;
    const done = h.barrier.wait().then(() => (settled = true));
    await tick(40);
    expect(settled).toBe(false);
    expect(h.abandoned).toEqual([]);

    h.state.compacting = false;
    h.emit();
    await done;
  });

  test("a wait that becomes cancelled mid-flight starts the budget then", async () => {
    const h = harness({ timings: { cancelledUnwindBudgetMs: 25 } });
    h.state.busy = true;

    const done = h.barrier.wait();
    await tick(30); // longer than the budget, but not cancelled yet
    expect(h.abandoned).toEqual([]);

    h.setCancellation("deadline");
    h.barrier.noteCancellationRequested();
    expect(await done).toBe("abandoned");
  });

  test("is reusable across the runner's multiple wait() calls", async () => {
    const h = harness();
    expect(await h.barrier.wait()).toBe("quiescent");
    h.state.busy = true;
    const done = h.barrier.wait();
    await tick(5);
    h.state.busy = false;
    h.emit();
    expect(await done).toBe("quiescent");
  });

  test("default timings are the values runner.ts relies on", () => {
    // requiredQuietTurns must be >= 2: compaction_end is emitted before
    // ctx.compact's onComplete runs, so one quiet turn can land in that gap.
    expect(
      DEFAULT_QUIESCENCE_TIMINGS.requiredQuietTurns,
    ).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_QUIESCENCE_TIMINGS.cancelledGraceMs).toBeGreaterThan(0);
    expect(DEFAULT_QUIESCENCE_TIMINGS.eventProbeMs).toBeGreaterThan(0);
    expect(
      DEFAULT_QUIESCENCE_TIMINGS.cancelledUnwindBudgetMs,
    ).toBeGreaterThanOrEqual(1_000);
  });
});

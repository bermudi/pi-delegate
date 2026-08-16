/**
 * The post-prompt quiescence barrier.
 *
 * ## Why this exists
 *
 * `AgentSession.prompt()` can resolve while work it started is still running.
 * Pi awaits `agent_settled` extension handlers, but an extension's handler is
 * free to call `ctx.compact()` and return immediately — and in pi 0.84
 * `ctx.compact()` is `void (async () => { … })()`. The session tracks that
 * compaction in `isCompacting`, but it holds no promise for it, and the
 * `onComplete` callback that fires afterwards may start a *continuation*
 * prompt. So `await prompt()` is not "the session is done with my task".
 *
 * If the runner returned ownership at that point, lifecycle would dispose or
 * re-pool a session that is still mutating files, spending tokens, and reading
 * a context that disposal has already invalidated. See
 * `docs/pi-codex-compaction-stale-context-defect.md`.
 *
 * ## Why it is a heuristic
 *
 * Pi exposes no primitive for "pending extension work" — no counter, no
 * promise registry, no `hasPendingExtensionWork()`. `waitForIdle()` is not a
 * substitute: `isIdle` is false only while a run is *active*, so a detached
 * continuation that has not started yet is indistinguishable from one that
 * will never start. All this barrier can observe is `isIdle`, `isCompacting`,
 * and the session event stream.
 *
 * It therefore waits for **stability** rather than completion: the session must
 * be idle, non-compacting, and event-quiet across N consecutive event-loop
 * turns. Two turns matter because `compaction_end` is emitted *before*
 * `ctx.compact`'s `onComplete` runs, and that callback may start a continuation
 * in the very next turn.
 *
 * This is a **mitigation, not a proof**. A deterministic fix belongs upstream
 * (make `ctx.compact()` awaitable, or expose pending extension work); until
 * then, detached work that pauses longer than the grace period can still
 * outlast the barrier.
 *
 * ## Bounded unwind
 *
 * While the task is healthy the barrier waits indefinitely — a legitimate
 * remote compaction can take minutes, and cutting it short re-opens the
 * disposal race. Unbounded waiting is safe there because the runner's stall
 * watchdog is armed: a wedged session gets cancelled, which moves the barrier
 * into its bounded mode.
 *
 * Once cancellation has been requested the session is supposed to be tearing
 * down, so the wait is bounded by `cancelledUnwindBudgetMs`. Without a bound,
 * an extension that keeps launching continuations keeps resetting progress and
 * the barrier never returns — hanging the delegate task forever, which is
 * strictly worse than reporting a cancelled task whose session may still be
 * active. On expiry the barrier logs and returns `"abandoned"`.
 */

/** Why the runner asked the session to stop. */
export type CancellationSource = "parent-aborted" | "stalled" | "deadline";

/** The only session state the barrier observes. */
export type QuiescenceObservable = {
  readonly isIdle: boolean;
  readonly isCompacting: boolean;
};

export type QuiescenceTimings = {
  /** Consecutive unchanged event-loop turns required to declare quiescence. */
  requiredQuietTurns: number;
  /**
   * One-shot wait, after cancellation, before quiet turns may accumulate. Two
   * event-loop turns pass in microseconds — far faster than a continuation
   * delayed by async auth — so without this the barrier would return before a
   * delayed continuation ever became observable.
   */
  cancelledGraceMs: number;
  /**
   * Liveness fallback for host versions that clear an internal busy flag
   * without emitting a corresponding public event. Normal transitions arrive
   * as events, so this only bounds the pathological case.
   */
  eventProbeMs: number;
  /** Ceiling on a cancelled unwind before the barrier gives up. */
  cancelledUnwindBudgetMs: number;
};

export const DEFAULT_QUIESCENCE_TIMINGS: QuiescenceTimings = {
  requiredQuietTurns: 2,
  cancelledGraceMs: 50,
  eventProbeMs: 250,
  cancelledUnwindBudgetMs: 30_000,
};

/**
 * `"quiescent"` — the session went idle and stayed quiet; ownership may be
 * returned to the caller. `"abandoned"` — the cancelled-unwind budget expired
 * while work was still starting; the caller regains ownership of a session
 * that may still be active.
 */
export type QuiescenceOutcome = "quiescent" | "abandoned";

export type QuiescenceBarrierOptions = {
  session: QuiescenceObservable;
  /** The active cancellation source, or `undefined` while the task is healthy. */
  cancellation: () => CancellationSource | undefined;
  /** Re-request cooperative cancellation of work that started post-cancellation. */
  cancel: (source: CancellationSource) => void;
  timings?: Partial<QuiescenceTimings>;
  now?: () => number;
  /** Overridable for tests; defaults to a `console.error` trace. */
  onAbandon?: (info: {
    source: CancellationSource;
    waitedMs: number;
    reAborts: number;
  }) => void;
};

export type QuiescenceBarrier = {
  /**
   * Record any observed session event. Every event counts, including ones the
   * runner ignores for progress: an event is evidence that something is alive.
   */
  noteEvent(): void;
  /**
   * Record that cooperative cancellation was just dispatched. Must be called
   * *after* `session.abort()` is invoked, so events the abort itself emits
   * synchronously are attributed to the abort rather than mistaken for new
   * work.
   */
  noteCancellationRequested(): void;
  /** Wait for stability. Safe to call more than once per task. */
  wait(): Promise<QuiescenceOutcome>;
};

export function createQuiescenceBarrier(
  options: QuiescenceBarrierOptions,
): QuiescenceBarrier {
  const { session, cancellation, cancel } = options;
  const timings = { ...DEFAULT_QUIESCENCE_TIMINGS, ...options.timings };
  const now = options.now ?? Date.now;
  const onAbandon =
    options.onAbandon ??
    (({ source, waitedMs, reAborts }) => {
      console.error(
        `[delegate] quiescence barrier gave up after ${waitedMs}ms and ${reAborts} re-abort(s) unwinding a ${source} subagent; the session may still be running detached extension work`,
      );
    });

  // Monotonic counter over observed session events. Comparing a sampled
  // generation to the current one closes the race between "check session
  // state" and "install the next waiter": an event that lands in between
  // changes the generation, so it can never be missed.
  let generation = 0;
  let wake: (() => void) | undefined;
  // Generation at the moment cancellation was last dispatched. Any later
  // event means new work started despite the abort. -1 = never cancelled.
  let cancelledAtGeneration = -1;

  const noteEvent = () => {
    generation++;
    const pending = wake;
    wake = undefined;
    pending?.();
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const nextEventLoopTurn = () =>
    new Promise<void>((resolve) => setImmediate(resolve));

  /** Resolve on the next session event, or after the liveness probe. */
  const waitForEventAfter = (sampled: number, probeMs: number) => {
    if (generation !== sampled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(probe);
        if (wake === finish) wake = undefined;
        resolve();
      };
      const probe = setTimeout(finish, probeMs);
      if (generation !== sampled) {
        finish();
        return;
      }
      wake = finish;
    });
  };

  const wait = async (): Promise<QuiescenceOutcome> => {
    let quietTurns = 0;
    let graceWaited = false;
    let reAborts = 0;
    let unwindStartedAt: number | undefined;
    // Remaining cancelled-unwind budget, or Infinity while healthy. Timed
    // waits are clamped to it so expiry is not overshot by a full probe.
    let budgetLeft = Number.POSITIVE_INFINITY;

    while (quietTurns < timings.requiredQuietTurns) {
      const sampled = generation;
      await nextEventLoopTurn();

      const source = cancellation();
      if (source) {
        unwindStartedAt ??= now();
        const waitedMs = now() - unwindStartedAt;
        budgetLeft = timings.cancelledUnwindBudgetMs - waitedMs;
        if (budgetLeft <= 0) {
          onAbandon({ source, waitedMs, reAborts });
          return "abandoned";
        }

        // Re-abort work that started after the last cancellation request —
        // typically a continuation from an extension's onComplete callback,
        // possibly delayed by async auth. Checked *before* the idle check so a
        // fast continuation that already finished between samples is still
        // caught: the generation moved even though the session is idle again.
        // Re-aborting resets progress so any further continuation is seen too.
        if (
          cancelledAtGeneration >= 0 &&
          generation !== cancelledAtGeneration
        ) {
          cancel(source);
          reAborts++;
          quietTurns = 0;
          graceWaited = false;
          continue;
        }
      }

      const idle = session.isIdle && !session.isCompacting;
      if (idle && generation === sampled) {
        if (source && !graceWaited) {
          // A single timed wait, not a busy-spin: the event loop stays free to
          // process a delayed continuation's events while we sleep.
          graceWaited = true;
          await sleep(Math.min(timings.cancelledGraceMs, budgetLeft));
          continue;
        }
        quietTurns++;
        continue;
      }

      quietTurns = 0;
      graceWaited = false;
      if (!idle) {
        await waitForEventAfter(
          generation,
          Math.min(timings.eventProbeMs, budgetLeft),
        );
      }
    }
    return "quiescent";
  };

  return {
    noteEvent,
    noteCancellationRequested: () => {
      cancelledAtGeneration = generation;
    },
    wait,
  };
}

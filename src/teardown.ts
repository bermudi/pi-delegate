import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiagnosticSink } from "./diagnostics.ts";
import type { WakeDelivery } from "./delivery.ts";
import type { DispatchRegistry } from "./lifetime.ts";
import type { SessionPool } from "./sessions.ts";
import type { TelemetryStore } from "./telemetry.ts";
import type { TicketStore } from "./tickets.ts";
import type { VisibilitySignals } from "./visibility.ts";

/**
 * The session-shutdown procedure, owned end-to-end by one component.
 *
 * Step independence is a deliberate hardening property, not an accident
 * of composition: teardown is a cascade of independent cleanup attempts
 * — the delivery drain, the quit/reload trace, the per-ticket abort
 * requests, the session pool, the quiescence bound, and the telemetry
 * drain are each still owed their attempt when an earlier step throws.
 * A synchronous `entry.session.abort()` throw inside the pool shutdown
 * used to skip the quiescence barrier and the telemetry drain (queued
 * writes lost) entirely; now a throwing step logs a diagnostic naming
 * the step and the sequence continues.
 */
export interface SessionTeardownDependencies {
  readonly diagnostics: DiagnosticSink;
  readonly delivery: WakeDelivery;
  readonly visibility: VisibilitySignals;
  readonly tickets: TicketStore;
  readonly sessions: SessionPool;
  readonly dispatches: DispatchRegistry;
  readonly telemetry: TelemetryStore;
  /** Shared with the pipeline's attribution quiescence bound. */
  readonly budgetMs: () => number;
}

export class SessionTeardown {
  /**
   * Shutdown latch: once the host begins teardown, new dispatches
   * reject and pending results are never delivered.
   */
  private latched = false;

  constructor(private readonly deps: SessionTeardownDependencies) {}

  isLatched(): boolean {
    return this.latched;
  }

  /**
   * The ordered teardown; each step is an independent attempt. The
   * latch lands first — it is what makes every later step's failure
   * survivable, since nothing new can start once it is set.
   */
  async run(reason: string, ctx: ExtensionContext): Promise<void> {
    this.latched = true;
    const attempt = (name: string, step: () => void): void => {
      try {
        step();
      } catch (error) {
        this.deps.diagnostics.log(
          "error",
          `shutdown step '${name}' failed; continuing teardown`,
          { operation: name },
          error,
        );
      }
    };
    attempt("suppress pending deliveries", () =>
      this.deps.delivery.suppressPending());
    // v1's quit/reload traces: name the live work being killed before the
    // force-cancel makes it invisible (quit → stderr; reload → notify).
    attempt("shutdown trace", () =>
      this.deps.visibility.shutdownTrace(
        reason,
        ctx,
        this.deps.tickets
          .list()
          .filter(
            (ticket) =>
              ticket.status === "running" && ticket.recovered !== true,
          ),
      ));
    // Forced cancellation settles every ticket immediately and resolves
    // its waiters; delivery is suppressed by the latch above. Checked-out
    // pooled sessions must get their abort requests before the quiescence
    // wait — their runs own disposal through settle, and the barrier
    // below is what confirms they actually stopped (a worker that ignores
    // the abort holds shutdown for as long as it runs, per
    // COMPATIBILITY.md). Each ticket's cancel is its own attempt: one
    // throwing must not leave a sibling's abort unsent or skip the pool,
    // the barrier, and the drain behind it.
    for (const ticket of this.deps.tickets.list()) {
      // Recovered records project a sibling session's journal — nothing
      // here can cancel them, and a settle would overwrite that entry.
      if (ticket.recovered === true) continue;
      attempt(`cancel ticket "${ticket.id}"`, () =>
        this.deps.tickets.cancel(ticket, true));
    }
    attempt("session pool shutdown", () => this.deps.sessions.shutdown());
    try {
      await this.quiescenceBarrier(ctx);
    } catch (error) {
      this.deps.diagnostics.log(
        "error",
        "shutdown step 'quiescence barrier' failed; continuing teardown",
        { operation: "quiescence barrier" },
        error,
      );
    }
    attempt("telemetry close", () => this.deps.telemetry.close());
  }

  /**
   * Wait for live dispatches to confirm their resources stopped, bounded
   * by the shared quiescence budget. The budget timer is scoped to the
   * race: unref'd so it can never hold a dying process open, and cleared
   * when the race resolves — left dangling it would leak a ref'd timer
   * on every session replacement the extension instance survives.
   */
  private async quiescenceBarrier(ctx: ExtensionContext): Promise<void> {
    const pending = this.deps.dispatches.pending();
    if (pending.length === 0) return;
    // The visible status names what is being waited on, so a worker that
    // ignores its abort is identifiable (its ticket id, or the sync call
    // label) without guessing from a bare count.
    const names = pending.map(({ label }) => label).join(", ");
    try {
      ctx.ui.notify(
        `Delegate: waiting for ${pending.length} dispatch(es) to stop before shutdown (${names})…`,
        "info",
      );
    } catch {
      // The UI may already be gone; the log line below still reports it.
    }
    this.deps.diagnostics.log(
      "info",
      "shutdown waiting for dispatches to reach quiescence",
      { count: pending.length },
    );
    const budgetMs = this.deps.budgetMs();
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const resourcesStopped = await Promise.race([
      Promise.all(pending.map(({ resourcesStopped }) => resourcesStopped)).then(
        () => true,
      ),
      new Promise<false>((resolve) => {
        budgetTimer = setTimeout(() => resolve(false), budgetMs);
        budgetTimer.unref?.();
      }),
    ]);
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    if (!resourcesStopped) {
      // The invariant holds in the only direction it can: reservations
      // are never released without confirmed quiescence, so nothing is
      // unblocked by proceeding — the host simply stops waiting on work
      // that may never stop.
      this.deps.diagnostics.log(
        "error",
        "shutdown quiescence budget expired; workers may still be mutating",
        { budgetMs, count: pending.length },
      );
      try {
        ctx.ui.notify(
          `Delegate: exiting with ${pending.length} dispatch(es) still stopping (${names}); they may still be mutating.`,
          "warning",
        );
      } catch {
        // The UI may already be gone; the diagnostic above carries it.
      }
    }
  }
}

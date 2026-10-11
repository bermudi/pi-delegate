import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiagnosticSink } from "./diagnostics.ts";
import { publicOutcome, type DeliveredDetails } from "./details.ts";
import type { Ticket } from "./types.ts";

/** customType of the custom message that delivers a settled async batch. */
export const DELIVERED_MESSAGE_TYPE = "delegate-result";

/**
 * SPEC v3 "Interaction grammar — Wake delivery": "simultaneous
 * settlements batch into one wake." Settled tickets enqueue here and the
 * first enqueue arms one flush — this window trades a small delivery
 * delay for one wake per settlement cluster instead of one turn per
 * ticket. Deliberately not configurable: SPEC "Surface rules" keeps
 * internal timing out of caller reach.
 */
const DELIVERY_FLUSH_MS = 100;

interface QueuedDelivery {
  readonly ticket: Ticket;
  /** The dispatch's own ctx — owner of the leaf check and UI notify. */
  readonly ctx: ExtensionContext;
}

/** The one send surface delivery needs — `api.sendMessage` narrowed to
 * the delivered-message shape and its two option spellings. */
export type DeliverySendMessage = (
  message: {
    customType: string;
    content: string;
    display: boolean;
    details: DeliveredDetails;
  },
  options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
  },
) => void;

/**
 * SPEC v3 "Interaction grammar — Wake delivery": settled results
 * inject as steering wakes, leaf-aware, and simultaneous settlements
 * batch into one wake. `deliver` used to send one message per ticket
 * the moment it settled — a fan-out produced one parent turn per
 * ticket. Now settlement enqueues here; the first enqueue arms one
 * flush timer (DELIVERY_FLUSH_MS), and the flush groups the queued
 * tickets by routing decision and emits one DELIVERED_MESSAGE_TYPE
 * message per group.
 *
 * Once-ness: `enqueuedDeliveries` makes enqueue idempotent for the
 * extension's lifetime — settlement, not delivery, is the source of
 * truth, and a settled ticket stays pollable regardless of what
 * delivery did with it. Entries are never removed: a ticket must
 * never enqueue twice, even across a flush boundary.
 *
 * Consumption: `consumedDeliveries` records the exact terminal view a
 * wait/poll already returned to the model. The flush suppresses the
 * wake per ticket only when the view it would send now is identical —
 * a render taken while the ticket was still finalizing (the settled
 * wait races the batch's own `markBatchFinished` by a few microtasks) still
 * suppresses, while a record that gained content since the render
 * (late outcomes, budget account, notices) still delivers. An
 * unconsumed sibling in the same window delivers normally.
 */
export class WakeDelivery {
  /**
   * Bumped on every observed tree transition — including a vetoed or
   * cancelled navigation attempt, which conservatively downgrades
   * delivery.
   */
  private navigationEpoch = 0;
  private readonly deliveryQueue: QueuedDelivery[] = [];
  private readonly enqueuedDeliveries = new Set<string>();
  private readonly consumedDeliveries = new Map<
    string,
    { readonly by: "wait" | "poll"; readonly view: string }
  >();
  private deliveryFlushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly diagnostics: DiagnosticSink,
    private readonly sendMessage: DeliverySendMessage,
    private readonly viewOf: (ticket: Ticket) => string,
    private readonly isShuttingDown: () => boolean,
  ) {}

  /** The current navigation epoch — dispatch stamps it on its ticket. */
  epoch(): number {
    return this.navigationEpoch;
  }

  /**
   * session_before_tree/session_tree: a tree transition was observed —
   * bump the epoch so delivery holds results non-waking from here.
   */
  noteTransition(): void {
    this.navigationEpoch += 1;
  }

  /**
   * SPEC v3 "Wake delivery": a wait/poll that returned the ticket's
   * terminal view has already shown the model its content — record the
   * fingerprint so the flush drops a wake that would only repeat it.
   */
  noteConsumed(
    ticketId: string,
    by: "wait" | "poll",
    view: string,
  ): void {
    this.consumedDeliveries.set(ticketId, { by, view });
  }

  /**
   * "Same leaf" means same branch: the parent's own turn appends entries
   * after dispatch, so the current leaf is a descendant of the origin
   * leaf — the origin must still lie on the current branch (a null origin
   * is the root, which every branch descends from). The epoch separately
   * rules out any observed transition, cancelled or not. Both are read
   * from the ticket, which latched them at dispatch (see execute's
   * synchronous prefix). Computed per ticket at flush time, exactly as
   * the old per-ticket deliver did at settle time.
   */
  sameLeaf(ticket: Ticket, ctx: ExtensionContext): boolean {
    return (
      this.navigationEpoch === ticket.originEpoch &&
      (ticket.originLeafId === null ||
        ctx.sessionManager
          .getBranch()
          .some((entry) => entry.id === ticket.originLeafId))
    );
  }

  /**
   * The delivered message for one settlement group: content is the
   * concatenation of the group's ticket views (each names its ticket and
   * carries its own spill-bounded sections), details merge the per-ticket
   * ids, the complete outcomes, and the notices. A single-ticket group
   * keeps the historical `ticket`/`originLeafId` shape so the expanded
   * renderer can serve the live `fullView`.
   */
  private deliveredMessage(group: readonly QueuedDelivery[]) {
    const anyCancelled = group.some(
      ({ ticket }) => ticket.status === "cancelled",
    );
    const details: DeliveredDetails =
      group.length === 1
        ? {
            ticket: group[0]!.ticket.id,
            originLeafId: group[0]!.ticket.originLeafId,
            results: group[0]!.ticket.outcomes.map((outcome) =>
              publicOutcome(outcome),
            ),
          }
        : {
            tickets: group.map(({ ticket }) => ticket.id),
            originLeafIds: group.map(({ ticket }) => ticket.originLeafId),
            results: group.flatMap(({ ticket }) =>
              ticket.outcomes.map((outcome) => publicOutcome(outcome)),
            ),
          };
    const notices = group.flatMap(({ ticket }) => ticket.notices);
    if (notices.length > 0) details.notices = notices;
    // Verifier verdicts (#49) — {verdict, taskId} per outcome that parsed
    // one, flattened across the delivered group.
    const verdict = group.flatMap(({ ticket }) =>
      ticket.outcomes.flatMap((outcome) =>
        outcome?.verdict !== undefined
          ? [{ verdict: outcome.verdict, taskId: outcome.id }]
          : [],
      ),
    );
    if (verdict.length > 0) details.verdict = verdict;
    return {
      customType: DELIVERED_MESSAGE_TYPE,
      content:
        group.map(({ ticket }) => this.viewOf(ticket)).join("\n\n") +
        (anyCancelled
          ? "\nCancellation is cooperative; worker cleanup may still be pending."
          : ""),
      display: true,
      details,
    };
  }

  /**
   * api.sendMessage is fire-and-forget on the stock ExtensionAPI (returns
   * void): async send rejections surface through the host's
   * extension-error channel, never here. Only synchronous throws — e.g.
   * a torn-down runtime failing assertActive — reach the catch below.
   * Either way, settlement stands and the results stay pollable.
   */
  private flushDeliveries = (): void => {
    this.deliveryFlushTimer = undefined;
    const batch = this.deliveryQueue.splice(0);
    if (batch.length === 0) return;
    if (this.isShuttingDown()) {
      for (const { ticket } of batch) {
        this.diagnostics.log("error", "delivery suppressed during shutdown (result remains pollable)", { ticketId: ticket.id });
      }
      return;
    }
    // A wait/poll that already showed this exact view makes the wake
    // redundant — drop it per ticket and say so. A ticket whose record
    // changed since that render still delivers: the wake carries
    // content the caller never saw.
    const pending = batch.filter(({ ticket }) => {
      const consumed = this.consumedDeliveries.get(ticket.id);
      if (consumed === undefined || this.viewOf(ticket) !== consumed.view) {
        return true;
      }
      this.diagnostics.log("info", "delivery skipped: result already returned", { ticketId: ticket.id, by: consumed.by });
      return false;
    });
    const wake: QueuedDelivery[] = [];
    const moved: QueuedDelivery[] = [];
    for (const queued of pending) {
      try {
        (this.sameLeaf(queued.ticket, queued.ctx) ? wake : moved).push(queued);
      } catch {
        // The leaf check reads guarded ctx accessors; a stale ctx means
        // the owning session was replaced or disposed between settlement
        // and flush — every replacement path that keeps the extension
        // alive fires session_shutdown first, which drains this queue, so
        // reaching here means the session is gone outright. Delivering a
        // computed-wrong or dead message is worse than none: the settled
        // result stays pollable (and journal-recoverable) either way.
        this.diagnostics.log("error", "delivery skipped: dispatch context no longer active (result remains pollable)", { ticketId: queued.ticket.id });
      }
    }
    if (wake.length === 0 && moved.length === 0) return;
    const ids = (group: readonly QueuedDelivery[]) =>
      group.map(({ ticket }) => `"${ticket.id}"`).join(", ");
    // Delivery failure never undoes settlement: the tickets stay
    // terminal and pollable. Each group's send is isolated so one
    // failure neither skips nor misreports the other — and only the
    // failed group's tickets are named (the stale-ctx branch's skips
    // already logged their own line and own no working ctx).
    const reportFailure = (
      group: readonly QueuedDelivery[],
      error: unknown,
    ): void => {
      this.diagnostics.log("error", "delivering tickets failed (results remain pollable)", {
        ticketId: group.map(({ ticket }) => ticket.id).join(", "), count: group.length,
      }, error);
      try {
        group[0]!.ctx.ui.notify(
          `Delegate ticket(s) ${ids(group)} settled but their results could not be delivered; poll them for the results.`,
          "error",
        );
      } catch {
        // A stale ctx cannot show the notice; the log line stands.
      }
    };
    if (wake.length > 0) {
      try {
        // Same leaf, no transition observed: a steering message merges
        // at the busy parent's next turn boundary — after the in-flight
        // assistant turn's tool calls, before the next model call — and
        // starts a turn on an idle one. One wake per settlement group,
        // not per ticket (SPEC "Wake delivery").
        this.sendMessage(this.deliveredMessage(wake), {
          deliverAs: "steer",
          triggerTurn: true,
        });
      } catch (error) {
        reportFailure(wake, error);
      }
    }
    if (moved.length > 0) {
      try {
        // Leaf moved or a transition is in flight: append durably at the
        // current leaf without triggering a turn — it enters model
        // context on the next user turn.
        this.sendMessage(this.deliveredMessage(moved), { triggerTurn: false });
        try {
          moved[0]!.ctx.ui.notify(
            moved.length === 1
              ? `Delegate ticket ${ids(moved)} settled on a different branch; its result was appended to the current branch for the next turn.`
              : `Delegate tickets ${ids(moved)} settled on a different branch; their results were appended to the current branch for the next turn.`,
            "info",
          );
        } catch {
          // The UI may already be gone; the append itself landed.
        }
      } catch (error) {
        reportFailure(moved, error);
      }
    }
  };

  /**
   * Settlement → delivery edge: enqueue and arm the one flush timer.
   * A shutdown already latched suppresses at enqueue (the queued-at-
   * shutdown case is handled by the shutdown path draining the queue
   * and by the flush's own re-check).
   */
  enqueue(ticket: Ticket, ctx: ExtensionContext): void {
    if (this.isShuttingDown()) {
      this.diagnostics.log("error", "delivery suppressed during shutdown (result remains pollable)", { ticketId: ticket.id });
      return;
    }
    if (this.enqueuedDeliveries.has(ticket.id)) return;
    this.enqueuedDeliveries.add(ticket.id);
    this.deliveryQueue.push({ ticket, ctx });
    if (this.deliveryFlushTimer === undefined) {
      this.deliveryFlushTimer = setTimeout(this.flushDeliveries, DELIVERY_FLUSH_MS);
      // The flush must never hold a dying process open.
      this.deliveryFlushTimer.unref?.();
    }
  }

  /**
   * A delivery flush armed before the latch must not fire after
   * teardown: cancel the timer and drain the queue with the same
   * suppression log the flush itself would have emitted — settlement
   * is the source of truth, and those results stay pollable.
   */
  suppressPending(): void {
    if (this.deliveryFlushTimer !== undefined) {
      clearTimeout(this.deliveryFlushTimer);
      this.deliveryFlushTimer = undefined;
    }
    for (const { ticket } of this.deliveryQueue.splice(0)) {
      this.diagnostics.log("error", "delivery suppressed during shutdown (result remains pollable)", { ticketId: ticket.id });
    }
  }
}

import {
  withGitEvidence,
  type WindowEvidence,
} from "./git-attribution.ts";
import type { TicketStore } from "./tickets.ts";
import type { TaskOutcome, Ticket } from "./types.ts";

/**
 * One dispatch batch's outcome record and its ticket publication. The
 * index-aligned slot array is the batch's single mutable outcome state —
 * written by task settlements, coordinator fills, in-place reconcile
 * annotations, and late worker-truth merges — and every record a ticket
 * must see goes through this class so the batch record and the ticket
 * store can never drift on separate write paths.
 *
 * Batch-scoped: constructed where the batch's outcome array is born and
 * dead with it; the shared mutable instance is what lets phase
 * reconciliation replace entries in place and lets worker truth that
 * lands after the batch returned still reach the published record.
 */
export class OutcomeLedger {
  private readonly outcomes: (TaskOutcome | undefined)[];

  constructor(
    size: number,
    private readonly options: {
      ticket?: Ticket;
      tickets: TicketStore;
    },
  ) {
    this.outcomes = new Array(size);
  }

  /** A task's currently recorded outcome — provisional records included. */
  read(index: number): TaskOutcome | undefined {
    return this.outcomes[index];
  }

  /**
   * The live index-aligned record itself — not a copy: phase
   * reconciliation mutates entries in place through the shared array,
   * and a worker-truth merge landing after the batch returned must
   * still reach the array the caller already holds.
   */
  snapshot(): readonly (TaskOutcome | undefined)[] {
    return this.outcomes;
  }

  /** Record-only write: publication to the ticket is a separate step. */
  write(index: number, outcome: TaskOutcome): void {
    this.outcomes[index] = outcome;
  }

  /**
   * Write plus ticket publication in one step — for sites where nothing
   * interleaves between the record landing and the store write.
   */
  publish(index: number, outcome: TaskOutcome): void {
    this.write(index, outcome);
    this.publishToTicket(outcome);
  }

  /**
   * Publish an already-written record. The store owns lifecycle;
   * recording can settle the ticket but never un-settles it. A
   * ticket-less batch has no store to publish to.
   */
  publishToTicket(outcome: TaskOutcome): void {
    if (this.options.ticket !== undefined) {
      this.options.tickets.recordOutcome(this.options.ticket, outcome);
    }
  }

  /**
   * Re-publish a phase's records after reconciliation. The reconciled
   * (integration-annotated) outcomes are the ticket's terminal record;
   * settlement is held until they land.
   */
  republishPhase(phaseIndexes: ReadonlySet<number>): void {
    const ticket = this.options.ticket;
    if (ticket === undefined) return;
    for (const outcome of this.outcomes) {
      if (outcome && phaseIndexes.has(outcome.index)) {
        this.options.tickets.recordOutcome(ticket, outcome);
      }
    }
  }

  /**
   * The worker's true settlement merged over the caller-visible record:
   * reconciliation may already have annotated the provisional entry;
   * worker truth replaces the run outcome but keeps its integration —
   * and the Git window's evidence folds over its own observed set (the
   * caller's `decorate`). #127: the first visible settlement owns the
   * duration — a provisional's stamp survives truth, never re-measured.
   * When truth itself is the first record (its stop raced the
   * provisional's write), it is stamped here instead. Omitted when no
   * side ever ran — an own undefined key would trip the strict details
   * schema the same way; `integration` gets the same guard, which
   * `decorate` may legitimately not provide. Returns the merged record
   * after writing and ticket-publishing it.
   */
  mergeWorkerTruth(
    index: number,
    late: TaskOutcome,
    decorate: (outcome: TaskOutcome) => TaskOutcome,
    admittedElapsedMs: number | undefined,
  ): TaskOutcome {
    const durationMs =
      this.outcomes[index]?.durationMs ??
      late.durationMs ??
      admittedElapsedMs;
    const integration =
      this.outcomes[index]?.integration ?? late.integration;
    const merged: TaskOutcome = {
      ...decorate(late),
      ...(integration !== undefined ? { integration } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    this.outcomes[index] = merged;
    this.publishToTicket(merged);
    return merged;
  }

  /**
   * Worker truth's record is already on file — fold a settled Git
   * window's evidence over it so its files line reflects what the
   * worker actually did. Nothing recorded yet: nothing to enrich.
   */
  enrichWithEvidence(index: number, evidence: WindowEvidence): void {
    const current = this.outcomes[index];
    if (current === undefined) return;
    this.publish(index, withGitEvidence(current, evidence));
  }
}

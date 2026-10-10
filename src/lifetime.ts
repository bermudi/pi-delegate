import { Deferred } from "./types.ts";

/**
 * One dispatch's resource-quiescence obligation, owned by a single object.
 *
 * A dispatch is safe to leave behind only when (a) its owner has closed the
 * lifetime — the dispatch pipeline has finished, whether it handed off to the
 * coordinator or failed before doing so — and (b) every obligation adopted
 * along the way has resolved. An obligation is a resolve-only proof gate,
 * never an execution promise: rejecting work does not prove it stopped.
 * The coordinator adopts gates covering every worker's confirmed quiescence,
 * deferred cleanup, and the batch's own reconciliation.
 *
 * This object owns the only resolution site. Callers never resolve it directly,
 * so there is no pre-handoff failure routine that must know which party
 * still owns a barrier: whatever path the pipeline takes, `close()` runs in
 * its `finally`, and the barrier resolves once every adopted proof is confirmed.
 * `resourcesStopped` means mutations have ended, not that disposal succeeded
 * or resources became reusable. Ticket completion and abort acknowledgement
 * do not fulfill this signal.
 */
export class DispatchLifetime {
  private readonly obligations: Promise<void>[] = [];
  private closed = false;
  private readonly resourcesStoppedProof = new Deferred();
  /** Resolves when the lifetime is closed and every adopted proof is confirmed. */
  readonly resourcesStopped: Promise<void> = this.resourcesStoppedProof.promise;

  constructor(
    private currentLabel: string,
    /** Called once, when resourcesStopped resolves; the registry untracks it then. */
    onResourcesStopped: () => void,
  ) {
    void this.resourcesStopped.then(onResourcesStopped);
  }

  /** The human-facing name shown while shutdown waits on this dispatch. */
  get label(): string {
    return this.currentLabel;
  }

  /** Rename the dispatch once its durable name exists (ticket id, call number). */
  relabel(next: string): void {
    if (!this.resourcesStoppedProof.resolved) this.currentLabel = next;
  }

  /**
   * Hold the barrier on a resolve-only quiescence proof. Deferred has no
   * rejection path: arbitrary execution promises deliberately cannot enter
   * this API. The proof's owner resolves it only after mutation has stopped.
   * Must be called before `close()`; adopting after close is a wiring bug
   * and fails loudly rather than silently
   * leaving work the barrier does not wait for.
   */
  adopt(proof: Deferred): void {
    if (this.closed) {
      throw new Error(
        `dispatch "${this.currentLabel}" adopted work after its lifetime closed`,
      );
    }
    this.obligations.push(proof.promise);
  }

  /**
   * The dispatch pipeline is finished with this lifetime. Idempotent. Resolves
   * the barrier on the next microtask when nothing was adopted, and otherwise once every
   * adopted proof is confirmed.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    void Promise.all(this.obligations).then(() => this.resourcesStoppedProof.resolve());
  }
}

/** The live dispatches of one extension instance; shutdown waits on these. */
export class DispatchRegistry {
  private readonly live = new Set<DispatchLifetime>();

  open(label: string): DispatchLifetime {
    const lifetime: DispatchLifetime = new DispatchLifetime(label, () => {
      this.live.delete(lifetime);
    });
    this.live.add(lifetime);
    return lifetime;
  }

  /** Dispatches whose barrier has not yet resolved, with their current labels. */
  pending(): readonly { label: string; resourcesStopped: Promise<void> }[] {
    return [...this.live].map((lifetime) => ({
      label: lifetime.label,
      resourcesStopped: lifetime.resourcesStopped,
    }));
  }
}

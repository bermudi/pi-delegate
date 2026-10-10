import { Deferred } from "./types.ts";

/**
 * One dispatch's shutdown obligation, owned by a single object.
 *
 * A dispatch is safe to leave behind only when (a) its owner has closed the
 * lifetime — the dispatch pipeline has finished, whether it handed off to the
 * coordinator or failed before doing so — and (b) every obligation adopted
 * along the way has settled. An obligation is a promise for work that may
 * still mutate the workspace: the coordinator adopts one per batch, covering
 * every worker's confirmed quiescence, deferred cleanup, and the batch's own
 * reconciliation.
 *
 * `quiesced` is the only resolution site. Callers never resolve it directly,
 * so there is no pre-handoff failure routine that must know which party
 * still owns a barrier: whatever path the pipeline takes, `close()` runs in
 * its `finally`, and the barrier resolves once the adopted work has settled.
 */
export class DispatchLifetime {
  private readonly obligations: Promise<unknown>[] = [];
  private closed = false;
  private readonly done = new Deferred();
  /** Resolves when the lifetime is closed and every adopted obligation has settled. */
  readonly quiesced: Promise<void> = this.done.promise;

  constructor(
    private currentLabel: string,
    /** Called once, when `quiesced` resolves — the registry untracks the lifetime then. */
    onQuiesced: () => void,
  ) {
    void this.quiesced.then(onQuiesced);
  }

  /** The human-facing name shown while shutdown waits on this dispatch. */
  get label(): string {
    return this.currentLabel;
  }

  /** Rename the dispatch once its durable name exists (ticket id, call number). */
  relabel(next: string): void {
    if (!this.done.resolved) this.currentLabel = next;
  }

  /**
   * Hold the barrier on `work`. Must be called before `close()`; adopting
   * after close is a wiring bug and fails loudly rather than silently
   * leaving work the barrier does not wait for.
   */
  adopt(work: Promise<unknown>): void {
    if (this.closed) {
      throw new Error(
        `dispatch "${this.currentLabel}" adopted work after its lifetime closed`,
      );
    }
    this.obligations.push(work);
  }

  /**
   * The dispatch pipeline is finished with this lifetime. Idempotent. Resolves
   * the barrier immediately when nothing was adopted, and otherwise once every
   * adopted obligation has settled.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    void Promise.all(this.obligations).then(() => this.done.resolve());
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
  pending(): readonly { label: string; quiesced: Promise<void> }[] {
    return [...this.live].map((lifetime) => ({
      label: lifetime.label,
      quiesced: lifetime.quiesced,
    }));
  }
}

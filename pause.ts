/** Cooperative, in-memory ticket pause. Active operations finish; participants
 * park at a checkpoint before starting their next operation. This neither
 * freezes child processes nor releases workspace reservations/concurrency. */
export type PauseState = "running" | "pausing" | "paused";

export class PauseController {
  private requested = false;
  private readonly active = new Set<number>();
  private readonly parked = new Set<number>();
  private readonly wake = new Set<() => void>();

  constructor(private readonly onChange: () => void = () => {}) {}

  get state(): PauseState {
    if (!this.requested) return "running";
    return [...this.active].every((index) => this.parked.has(index))
      ? "paused"
      : "pausing";
  }

  isParked(index: number): boolean {
    return this.requested && this.parked.has(index);
  }

  private publish(): void {
    try {
      this.onChange();
    } catch (error) {
      console.error("[delegate] pause state notification failed", error);
    }
  }

  pause(): void {
    if (this.requested) return;
    this.requested = true;
    this.publish();
  }

  resume(): void {
    if (!this.requested) return;
    this.requested = false;
    for (const wake of this.wake) wake();
    this.publish();
  }

  enter(index: number): void {
    this.active.add(index);
    this.publish();
  }

  leave(index: number): void {
    this.active.delete(index);
    this.parked.delete(index);
    this.publish();
  }

  /** Abort unblocks the checkpoint without clearing another task's pause.
   * Callers still observe their signal and take their normal cancellation path. */
  async checkpoint(index: number, signal?: AbortSignal): Promise<void> {
    if (!this.requested || signal?.aborted) return;
    this.parked.add(index);
    this.publish();
    try {
      while (this.requested && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            this.wake.delete(wake);
            signal?.removeEventListener("abort", wake);
            resolve();
          };
          this.wake.add(wake);
          signal?.addEventListener("abort", wake, { once: true });
          if (signal?.aborted) wake();
        });
      }
    } finally {
      this.parked.delete(index);
      this.publish();
    }
  }
}

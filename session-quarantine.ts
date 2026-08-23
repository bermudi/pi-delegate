import type { ResolvedTask } from "./types.ts";

/**
 * Internal, non-serialized hand-off for a runner that returned before its
 * AgentSession was proven quiescent. Symbol properties survive object spreads
 * inside delegate, but JSON/tool-result serialization ignores them.
 */
const SESSION_QUARANTINE = Symbol("delegate.sessionQuarantine");

export interface SessionQuarantine {
  /** Resolves only after background termination and quiescence checks confirm
   * that the abandoned AgentSession can no longer mutate its workspace. */
  safe: Promise<void>;
}

export type WithSessionQuarantine = {
  [SESSION_QUARANTINE]?: SessionQuarantine;
};

interface QuarantineReservation {
  task: ResolvedTask;
  quarantine: SessionQuarantine;
}

/** Process-local admission reservations for abandoned tasks. A reservation is
 * removed only when its safety proof fulfills; rejection is not evidence that
 * the session stopped mutating. */
const quarantineReservations = new Map<symbol, QuarantineReservation>();

function logObserverFailure(description: string, error: unknown): void {
  try {
    console.error(`[delegate] ${description}`, error);
  } catch {
    // A cleanup observer must never turn a handled background failure into an
    // unhandled rejection, even when a test or host replaces console.error.
  }
}

/** Observe a safety proof without creating a dangling rejecting promise.
 * Callback failures are surfaced and swallowed because cleanup must not become
 * a process-level unhandled rejection. */
export function observeQuarantineSafety(
  quarantine: SessionQuarantine,
  description: string,
  onSafe: () => void | Promise<void>,
  onFailure?: (error: unknown) => void | Promise<void>,
): void {
  const invoke = async (
    callback: (() => void | Promise<void>) | undefined,
  ): Promise<void> => {
    if (!callback) return;
    try {
      await callback();
    } catch (error) {
      logObserverFailure(`${description} callback failed`, error);
    }
  };

  // Both branches fulfill. The final catch is defensive against an unusual
  // Promise implementation or callback plumbing regression.
  void quarantine.safe
    .then(
      () => invoke(onSafe),
      (error) =>
        invoke(
          onFailure
            ? () => onFailure(error)
            : () =>
                logObserverFailure(`${description} safety proof failed`, error),
        ),
    )
    .catch((error) =>
      logObserverFailure(`${description} observer failed`, error),
    );
}

/** Reserve the task's shared-write capability and session id until safe. */
export function reserveSessionQuarantine(
  task: ResolvedTask,
  quarantine: SessionQuarantine,
): void {
  const key = Symbol("quarantined-task");
  quarantineReservations.set(key, { task, quarantine });
  observeQuarantineSafety(
    quarantine,
    "quarantine admission reservation release",
    () => {
      quarantineReservations.delete(key);
    },
    // Fail closed: a rejected proof retains the reservation indefinitely.
    () => {},
  );
}

/** Snapshot abandoned tasks that admission must treat as still active. */
export function quarantinedTasks(): ResolvedTask[] {
  return [...quarantineReservations.values()].map(({ task }) => task);
}

export function isSessionIdQuarantined(sessionId: string): boolean {
  for (const { task } of quarantineReservations.values()) {
    if (task.sessionId === sessionId) return true;
  }
  return false;
}

/** @internal Test-only reset. Existing safety observers are token-scoped, so a
 * late fulfillment cannot delete a reservation created after the reset. */
export function _resetQuarantineRegistryForTesting(): void {
  quarantineReservations.clear();
}

export function markSessionQuarantined<T extends object>(
  value: T,
  quarantine: SessionQuarantine,
): T & WithSessionQuarantine {
  Object.defineProperty(value, SESSION_QUARANTINE, {
    value: quarantine,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return value as T & WithSessionQuarantine;
}

export function sessionQuarantineOf(
  value: object | undefined,
): SessionQuarantine | undefined {
  return value
    ? (value as WithSessionQuarantine)[SESSION_QUARANTINE]
    : undefined;
}

/** Preserve quarantine across explicit result projections that do not use an
 * object spread. */
export function propagateSessionQuarantine<T extends object>(
  source: object,
  target: T,
): T {
  const quarantine = sessionQuarantineOf(source);
  return quarantine ? markSessionQuarantined(target, quarantine) : target;
}

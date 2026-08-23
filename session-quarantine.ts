import type { ResolvedTask } from "./types.ts";
import { canonicalPath } from "./trusted-paths.ts";
import { resolveCwd } from "./utils.ts";

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
  /** Physical transcript identity captured while the abandoned task still
   * owns it. This prevents a symlink or lexical alias from bypassing the
   * quarantine with a second `resumeFrom`. */
  resumeFromIdentity?: string;
}

/** Process-local admission reservations for abandoned tasks. A reservation is
 * removed only when its safety proof fulfills; rejection is not evidence that
 * the session stopped mutating. */
const quarantineReservations = new Map<symbol, QuarantineReservation>();

/** Per-transcript locks close the validation-to-dispatch race for resume-only
 * tasks (which have no sessionId and therefore do not use the pool lock). */
const resumeFromLocks = new Map<string, Promise<void>>();

/** Resolve an existing resume transcript to the physical path used as its
 * process-local identity. Invalid or missing paths are left to normal
 * resumeFrom validation and cannot match a reservation created from an
 * existing transcript. */
export function canonicalResumeFromIdentity(
  resumeFrom: string | undefined,
): string | undefined {
  return resumeFrom ? canonicalPath(resolveCwd(resumeFrom)) : undefined;
}

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

/** Reserve the task's shared-write capability and logical session identities
 * until safe. Transcript identity is canonicalized at publication time while
 * the path is known to belong to the abandoned acquisition/session. */
export function reserveSessionQuarantine(
  task: ResolvedTask,
  quarantine: SessionQuarantine,
): void {
  const key = Symbol("quarantined-task");
  quarantineReservations.set(key, {
    task,
    quarantine,
    resumeFromIdentity: canonicalResumeFromIdentity(task.resumeFrom),
  });
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

export function isResumeFromQuarantined(resumeFrom: string): boolean {
  const identity = canonicalResumeFromIdentity(resumeFrom);
  if (!identity) return false;
  for (const reservation of quarantineReservations.values()) {
    if (reservation.resumeFromIdentity === identity) return true;
  }
  return false;
}

/** Serialize uses of one physical resume transcript so a queued call rechecks
 * quarantine after the preceding owner publishes an abandonment reservation. */
export async function withResumeFromLock<T>(
  resumeFrom: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const identity = canonicalResumeFromIdentity(resumeFrom);
  if (!identity) return fn();

  const previous = resumeFromLocks.get(identity);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  resumeFromLocks.set(identity, current);
  try {
    if (previous) await previous;
    return await fn();
  } finally {
    release();
    if (resumeFromLocks.get(identity) === current) {
      resumeFromLocks.delete(identity);
    }
  }
}

/** @internal Test-only reset. Existing safety observers are token-scoped, so a
 * late fulfillment cannot delete a reservation created after the reset. */
export function _resetQuarantineRegistryForTesting(): void {
  quarantineReservations.clear();
  resumeFromLocks.clear();
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

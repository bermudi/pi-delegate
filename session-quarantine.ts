import { existsSync } from "node:fs";
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
  /** Physical transcript identity used to acquire the abandoned session.
   * This is passed through from acquisition and must never be re-resolved at
   * publication time: a symlink may have changed while the task was running. */
  resumeFromIdentity?: string;
}

/** Identity snapshot supplied while a resume transcript lock is held. */
export interface LockedResumeTranscript {
  /** Stable absolute spelling used even when the transcript does not exist. */
  lexicalPath: string;
  /** Physical target captured once for this acquisition. */
  canonicalPath?: string;
  /** The captured physical target still existed after this call acquired all
   * applicable lexical/physical locks. */
  exists: boolean;
}

/** Process-local admission reservations for abandoned tasks. A reservation is
 * removed only when its safety proof fulfills; rejection is not evidence that
 * the session stopped mutating. */
const quarantineReservations = new Map<symbol, QuarantineReservation>();

/** Per-transcript locks close the validation-to-dispatch race for resume-only
 * tasks (which have no sessionId and therefore do not use the pool lock). */
const resumeFromLocks = new Map<string, Promise<void>>();

/** Resolve an existing resume transcript to its current physical identity.
 * Admission-time callers use this as a best-effort early rejection only; the
 * lifecycle lock captures and carries the authoritative acquisition identity. */
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
 * until safe. `resumeFromIdentity` must be the exact canonical path passed to
 * acquisition; publication deliberately performs no mutable-path lookup. */
export function reserveSessionQuarantine(
  task: ResolvedTask,
  quarantine: SessionQuarantine,
  resumeFromIdentity: string | undefined,
): void {
  const key = Symbol("quarantined-task");
  quarantineReservations.set(key, {
    task,
    quarantine,
    resumeFromIdentity,
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

export function isResumeFromIdentityQuarantined(identity: string): boolean {
  for (const reservation of quarantineReservations.values()) {
    if (reservation.resumeFromIdentity === identity) return true;
  }
  return false;
}

export function isResumeFromQuarantined(resumeFrom: string): boolean {
  const identity = canonicalResumeFromIdentity(resumeFrom);
  return identity ? isResumeFromIdentityQuarantined(identity) : false;
}

async function withResumeLockKeys<T>(
  identities: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(identities)].sort();
  const previous = keys
    .map((identity) => resumeFromLocks.get(identity))
    .filter((pending): pending is Promise<void> => pending !== undefined);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Publish every claim before waiting. A later caller sharing any lexical or
  // physical identity therefore queues behind this owner rather than racing a
  // different key in the set.
  for (const identity of keys) resumeFromLocks.set(identity, current);
  try {
    await Promise.all(previous);
    return await fn();
  } finally {
    release();
    for (const identity of keys) {
      if (resumeFromLocks.get(identity) === current) {
        resumeFromLocks.delete(identity);
      }
    }
  }
}

/** Serialize transcript acquisition without trusting a mutable path twice.
 *
 * Every call claims its stable absolute lexical spelling, so missing and
 * unresolvable paths never fail open. Existing targets additionally claim the
 * pre-wait canonical snapshot, which serializes symlink aliases and pins a
 * queued call to the target it named when it entered. If a formerly missing
 * path becomes resolvable while waiting, its new physical key is claimed
 * before the callback runs. Existence is then checked under all applicable
 * locks and the same canonical path is passed through to acquisition. */
export async function withResumeTranscriptLock<T>(
  resumeFrom: string | undefined,
  fn: (transcript: LockedResumeTranscript | undefined) => Promise<T>,
): Promise<T> {
  if (!resumeFrom) return fn(undefined);

  const lexicalPath = resolveCwd(resumeFrom);
  const preWaitCanonicalPath = canonicalPath(lexicalPath);
  const initialKeys = preWaitCanonicalPath
    ? [lexicalPath, preWaitCanonicalPath]
    : [lexicalPath];

  return withResumeLockKeys(initialKeys, async () => {
    // Preserve an existing target captured before waiting. Only retry
    // canonicalization when there was no target to capture at call entry.
    const canonicalPathOnce =
      preWaitCanonicalPath ?? canonicalPath(lexicalPath);
    const invoke = async (): Promise<T> =>
      fn({
        lexicalPath,
        canonicalPath: canonicalPathOnce,
        exists:
          canonicalPathOnce !== undefined && existsSync(canonicalPathOnce),
      });

    // A missing/broken symlink can become a physical alias while queued. Claim
    // that identity before validation/acquisition so it cannot race an owner
    // that entered through the physical path or another alias.
    if (canonicalPathOnce && !initialKeys.includes(canonicalPathOnce)) {
      return withResumeLockKeys([canonicalPathOnce], invoke);
    }
    return invoke();
  });
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

/**
 * Session-tree leaf affinity for async tickets.
 *
 * An async ticket outlives the turn that spawned it. `/tree` navigation moves
 * the session to a different leaf **within the same session file**: no
 * `session_shutdown` fires, the extension runtime stays live, and the ticket
 * keeps running. When it finishes, `deliverTicketResults` wakes the agent at
 * whatever leaf is active *now* — which may be a branch that knows nothing
 * about the task. See GitHub issue #30.
 *
 * pi exposes no "what leaf am I on?" query, so the current leaf has to be
 * tracked from the `session_tree` event (`newLeafId`). That event also fires
 * for extension-driven `ctx.navigateTree`, so this tracking covers navigation
 * that never passed the `session_before_tree` confirm guard.
 *
 * State is runtime-scoped: `resetLeafTracking()` on session shutdown, since a
 * replacement session starts on its own (unknown) leaf.
 */
import type { AsyncTicket } from "./types.ts";

/** Leaf the session is currently on. `undefined` means no navigation has been
 *  observed by this runtime — i.e. the leaf the session opened on. */
let currentLeafId: string | null | undefined;

/** Record a completed `/tree` navigation. */
export function recordTreeNavigation(newLeafId: string | null): void {
  currentLeafId = newLeafId;
}

/** Leaf id to stamp on a ticket at spawn time. */
export function getCurrentLeafId(): string | null | undefined {
  return currentLeafId;
}

export function resetLeafTracking(): void {
  currentLeafId = undefined;
}

/** True when the session has navigated away from the leaf that spawned this
 *  ticket, so delivering its result would wake the agent on a foreign branch.
 *
 *  Navigating away and back to the spawn leaf yields a fresh leaf id and is
 *  therefore reported as cross-leaf. That false positive is deliberate: the
 *  cross-leaf path only downgrades delivery to non-waking, and reconstructing
 *  true leaf identity across a round trip is not worth the complexity. */
export function isCrossLeafTicket(ticket: AsyncTicket): boolean {
  return ticket.spawnLeafId !== currentLeafId;
}

import { readFileSync } from "node:fs";
import type { TicketOwner } from "./types.ts";

/**
 * This boot's kernel id, when the platform exposes one (#54). Linux reads
 * /proc/sys/kernel/random/boot_id; Windows and other platforms have no
 * equivalent — undefined then, and owner checks fall back to pid liveness
 * alone. Unreadable is treated the same as absent: callers must never
 * interrupt a possibly-live owner on boot evidence they cannot see.
 */
export function currentBootId(): string | undefined {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
}

/**
 * `kill(pid, 0)` liveness: the signal carries no payload — ESRCH means no
 * such process, EPERM means the process exists but belongs to another
 * user (still alive).
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * #54 owner liveness: a journaled `running` ticket is interrupted at
 * startup only when its recorded owner is PROVABLY dead —
 *
 * - the owner's boot id differs from this boot's (a restart happened), or
 * - the owning pid no longer exists.
 *
 * Everything else leaves the record alone: a missing owner (records
 * written before owner tracking) offers no proof either way; a live pid
 * is a live sibling pane whose ticket is sacred; and an absent boot id —
 * the Windows fallback, or an unreadable /proc — degrades the check to
 * pid evidence only, so a cross-boot guess can never interrupt a
 * possibly-live owner.
 */
export function ownerIsDead(
  owner: TicketOwner | undefined,
  bootId: string | undefined,
): boolean {
  if (owner === undefined) return false;
  if (
    owner.bootId !== undefined &&
    bootId !== undefined &&
    owner.bootId !== bootId
  ) {
    return true;
  }
  return !pidAlive(owner.pid);
}

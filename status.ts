/**
 * Background-activity visibility: footer status, settle warning, and
 * session-replacement guards for live async tickets.
 *
 * Async tickets keep subagents running after the parent turn settles, but pi
 * renders an idle session — nothing tells the human work is still in flight,
 * and quitting silently kills it. This module owns the three signals that
 * close that gap:
 *
 * 1. A persistent footer status (`ctx.ui.setStatus`) while any ticket is
 *    active — the only always-on indicator that background subagents exist.
 * 2. A one-shot warning notification at the first `agent_settled` with each
 *    active ticket — the moment a user is most likely to assume everything
 *    is done and close the session.
 * 3. A confirm guard on the session-replacement paths pi lets extensions
 *    cancel (`session_before_switch`, `session_before_fork`), plus a distinct
 *    prompt for `/tree` navigation, which re-targets results rather than
 *    killing them (see `guardTreeNavigation`).
 * 4. A notification when a ticket completes after the session navigated away
 *    from its spawn leaf: delivery is downgraded to non-waking, so without
 *    this the human gets no signal that the ticket finished at all.
 *
 * Quit (Ctrl+C×2 / Ctrl+D / /quit) and /reload CANNOT be intercepted from an
 * extension — `session_shutdown` is advisory, not cancellable. The footer
 * status plus the exit/reload trace in extension.ts are the mitigations
 * there.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestTicketCancel, ticketRegistry } from "./tickets.ts";
import type { AsyncTicket } from "./types.ts";

const STATUS_KEY = "delegate";

export interface ActiveTicketSummary {
  /** Tickets in a non-terminal state (running or cancelling). */
  tickets: AsyncTicket[];
  /** Progress rows still executing or queued across active tickets. */
  activeSubagents: number;
}

/** Snapshot the live background work from the ticket registry. */
export function activeTicketSummary(): ActiveTicketSummary {
  const tickets: AsyncTicket[] = [];
  let activeSubagents = 0;
  for (const ticket of ticketRegistry.values()) {
    if (ticket.status !== "running" && ticket.status !== "cancelling") continue;
    tickets.push(ticket);
    activeSubagents += ticket.progress.filter(
      (p) => p.status === "running" || p.status === "pending",
    ).length;
  }
  return { tickets, activeSubagents };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Footer status text, or undefined when nothing is active. */
export function buildStatusText(
  summary: ActiveTicketSummary,
): string | undefined {
  const { tickets, activeSubagents } = summary;
  if (tickets.length === 0) return undefined;
  // Wind-down window: tasks have settled but the ticket has not flipped to a
  // terminal status yet. "settling" is more honest than "0 subagents".
  if (activeSubagents === 0) {
    return tickets.length === 1
      ? `⏳ ${tickets[0]!.id} settling…`
      : `⏳ ${plural(tickets.length, "ticket")} settling…`;
  }
  return tickets.length === 1
    ? `⏳ ${plural(activeSubagents, "subagent")} · ${tickets[0]!.id}`
    : `⏳ ${plural(activeSubagents, "subagent")} · ${plural(tickets.length, "ticket")}`;
}

/** Most recent context with UI access. Refreshed by every sync call that
 *  receives a ctx, so event-driven updates can reach the footer without a
 *  direct ctx of their own. Single runtime per process — a replaced runtime
 *  refreshes this on its first delegate call or session event. */
let lastCtx: ExtensionContext | undefined;
/** Last text pushed to the footer — setStatus triggers a render, so dedupe. */
let lastStatusText: string | undefined;
/** Tickets already warned about at settle. Pruned to active tickets on sync. */
const settledWarnedTicketIds = new Set<string>();

/** Recompute the footer status from the registry and push it when changed.
 *  Called on every ticket lifecycle mutation (create, progress, complete,
 *  cancel); event-driven only — no timers, so the text never goes stale
 *  (counts are the only content). */
export function syncDelegateStatus(ctx?: ExtensionContext): void {
  if (ctx) lastCtx = ctx;

  const summary = activeTicketSummary();
  const text = buildStatusText(summary);

  if (settledWarnedTicketIds.size) {
    const activeIds = new Set(summary.tickets.map((t) => t.id));
    for (const id of settledWarnedTicketIds) {
      if (!activeIds.has(id)) settledWarnedTicketIds.delete(id);
    }
  }

  if (!lastCtx || text === lastStatusText) return;
  try {
    // The `ui` getter itself throws on a stale ctx — pi invalidates the old
    // runtime on session replacement, and an unwinding ticket can race the
    // teardown. A footer update must never crash the host.
    lastCtx.ui.setStatus(STATUS_KEY, text);
    lastStatusText = text;
  } catch {
    // Drop the stale ctx; the next live event re-caches a fresh one.
    lastCtx = undefined;
    lastStatusText = undefined;
  }
}

/** Drop the cached ctx and warn-set on session shutdown — the runtime is
 *  about to be invalidated, and any post-teardown sync (e.g. an aborted
 *  ticket unwinding) must become a no-op instead of touching a stale ctx. */
export function clearDelegateStatusContext(): void {
  lastCtx = undefined;
  lastStatusText = undefined;
  settledWarnedTicketIds.clear();
}

/** Warn once per ticket at the first agent_settled with that ticket active —
 *  the "looks idle but isn't" moment. The persistent footer status carries
 *  the information from then on, so later settles stay quiet. */
export function notifyActiveTicketsOnSettled(ctx: ExtensionContext): void {
  lastCtx = ctx;
  const summary = activeTicketSummary();
  const fresh = summary.tickets.filter(
    (t) => !settledWarnedTicketIds.has(t.id),
  );
  if (!fresh.length) return;

  const subagents = fresh.reduce(
    (n, t) =>
      n +
      t.progress.filter((p) => p.status === "running" || p.status === "pending")
        .length,
    0,
  );
  const detail =
    fresh.length === 1
      ? `(ticket ${fresh[0]!.id})`
      : `across ${plural(fresh.length, "ticket")} (${fresh.map((t) => t.id).join(", ")})`;
  try {
    ctx.ui.notify(
      `⏳ ${plural(subagents, "background subagent")} still running ${detail} — quitting pi aborts them`,
      "warning",
    );
    for (const t of fresh) settledWarnedTicketIds.add(t.id);
  } catch {
    // Stale or headless ctx: drop it so the next live event re-caches one.
    lastCtx = undefined;
    lastStatusText = undefined;
  }
}

/** Block a session replacement (switch/fork) while background subagents are
 *  live, unless the human confirms. Returns `{ cancel: true }` to abort the
 *  replacement, undefined to let it proceed. Headless contexts (no dialog
 *  capability) are never blocked — automation must not deadlock on a
 *  confirm it cannot answer. */
export async function guardSessionReplacement(
  ctx: ExtensionContext,
  action: "switch" | "fork",
): Promise<{ cancel: true } | undefined> {
  lastCtx = ctx;
  const summary = activeTicketSummary();
  if (!summary.tickets.length || !ctx.hasUI) return undefined;

  const ids = summary.tickets.map((t) => t.id).join(", ");
  const verb =
    action === "switch" ? "Switching sessions" : "Forking this session";
  const proceed = await ctx.ui.confirm(
    "Background subagents still running",
    `${plural(summary.activeSubagents, "subagent")} (${ids}) still working. ` +
      `${verb} aborts them — work already done is not rolled back. Continue anyway?`,
  );
  return proceed ? undefined : { cancel: true };
}

/** `/tree` navigation is not a session replacement: the runtime survives and
 *  the subagents keep running, but the eventual result no longer belongs to
 *  the branch the user is on. Offer the three honest outcomes instead of the
 *  destructive switch/fork confirm. Dismissal keeps the user where they are —
 *  the conservative choice, since navigating is what creates the hazard.
 *
 *  This guard is UX, not the correctness mechanism: navigation that never
 *  reaches it (dismissed dialog, headless ctx, `ctx.navigateTree` from another
 *  extension) is still handled at delivery time via leaf affinity. */
export async function guardTreeNavigation(
  ctx: ExtensionContext,
): Promise<{ cancel: true } | undefined> {
  lastCtx = ctx;
  const summary = activeTicketSummary();
  if (!summary.tickets.length || !ctx.hasUI) return undefined;

  const ids = summary.tickets.map((t) => t.id).join(", ");
  const hold = "Navigate — hold results (poll to read them)";
  const cancel = "Navigate — cancel the background subagents";
  const stay = "Stay on this branch";
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(
      `${plural(summary.activeSubagents, "background subagent")} (${ids}) still running — ` +
        "navigating means their results arrive on a different branch",
      [hold, cancel, stay],
    );
  } catch {
    // pi does not surface handler rejections, so a throwing dialog (stale ctx,
    // TUI failure) would become an unhandled rejection. Let the navigation
    // through rather than trapping the user: leaf affinity at delivery time is
    // the correctness mechanism, not this prompt.
    return undefined;
  }

  if (choice === hold) return undefined;
  if (choice === cancel) {
    for (const ticket of summary.tickets) requestTicketCancel(ticket);
    syncDelegateStatus(ctx);
    return undefined;
  }
  return { cancel: true };
}

/** Tell the human a ticket landed on a branch they had left. Delivery used
 *  `nextTurn` (no wake-up), so this notification and the pollable ticket are
 *  the only signals that the work finished. */
export function notifyCrossLeafDelivery(ticket: AsyncTicket): void {
  if (!lastCtx) return;
  try {
    lastCtx.ui.notify(
      `Ticket ${ticket.id} finished (${ticket.status}) on a branch you navigated away from — ` +
        `results are held for your next message; read them with delegate poll.`,
      "warning",
    );
  } catch {
    lastCtx = undefined;
    lastStatusText = undefined;
  }
}

/** One-line description of live work for shutdown traces. */
export function describeActiveTickets(
  summary: ActiveTicketSummary = activeTicketSummary(),
): string {
  const ids = summary.tickets.map((t) => t.id).join(", ");
  const agents = [
    ...new Set(
      summary.tickets.flatMap((t) =>
        t.progress
          .filter((p) => p.status === "running" || p.status === "pending")
          .map((p) => p.agent),
      ),
    ),
  ];
  const agentList = agents.length ? ` [${agents.join(", ")}]` : "";
  return `${plural(summary.activeSubagents, "background subagent")}${agentList} (ticket${summary.tickets.length === 1 ? "" : "s"}: ${ids})`;
}

export function _resetDelegateStatusForTesting(): void {
  lastCtx = undefined;
  lastStatusText = undefined;
  settledWarnedTicketIds.clear();
}

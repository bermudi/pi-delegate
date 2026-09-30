/**
 * Operator-visibility safety signals (issue #24): the footer status line,
 * the once-per-ticket settle warning, session-replacement consent guards,
 * and quit/reload abort traces. These restore the v1 behaviors recorded in
 * COMPATIBILITY.md "v2 deferred capabilities" that run on plain `ctx.ui`
 * calls — the TUI browser itself lives in `src/browser.ts`.
 *
 * State is instance-owned; the footer context is cached from tool `execute`
 * calls (the one context that is guaranteed to carry a full UI surface for
 * the extension's lifetime) and re-cached if it goes stale. Guards fail
 * open: leaf-aware delivery — not a consent dialog — is the correctness
 * mechanism, so a throwing dialog must never wedge a session switch.
 */

/** The caller-visible ticket state the signals read. */
export interface SignalTicket {
  readonly id: string;
  readonly status: string;
  readonly paused: boolean;
  readonly totalTasks: number;
  readonly outcomes: readonly (unknown | undefined)[];
  /** Cold-read record owned by another host — never live work here. */
  readonly recovered?: boolean;
}

interface StatusCtx {
  readonly ui: { setStatus(key: string, text: string | undefined): void };
}

interface DialogCtx {
  readonly hasUI: boolean;
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(
      title: string,
      options: readonly string[],
    ): Promise<string | undefined>;
  };
}

const FOOTER_KEY = "delegate";

function inFlight(ticket: SignalTicket): number {
  let done = 0;
  for (const outcome of ticket.outcomes) if (outcome !== undefined) done += 1;
  return Math.max(0, ticket.totalTasks - done);
}

function isSettling(ticket: SignalTicket): boolean {
  return inFlight(ticket) === 0;
}

/** Footer text for the active-ticket set, or undefined when nothing runs. */
export function footerText(active: readonly SignalTicket[]): string | undefined {
  if (active.length === 0) return undefined;
  const paused = active.find((ticket) => ticket.paused);
  if (paused !== undefined) {
    const others = active.length - 1;
    const base = `Ⅱ ${paused.id} paused`;
    return others > 0
      ? `${base} · ${others} other ticket(s) · /subagents`
      : `${base} · /subagents`;
  }
  const settling = active.filter(isSettling);
  if (settling.length === active.length) {
    return settling.length === 1
      ? `⏳ ${settling[0]!.id} settling… · /subagents`
      : `⏳ ${settling.length} tickets settling… · /subagents`;
  }
  const subs = active.reduce((sum, ticket) => sum + inFlight(ticket), 0);
  if (active.length === 1) {
    return `⏳ ${subs} subagent(s) · ${active[0]!.id} · /subagents`;
  }
  return `⏳ ${subs} subagent(s) · ${active.length} tickets · /subagents`;
}

/** "N background subagent(s) (ticket(s): …)" for shutdown traces. */
export function activeSummary(active: readonly SignalTicket[]): string {
  const subs = active.reduce((sum, ticket) => sum + inFlight(ticket), 0);
  const ids = active.map((ticket) => ticket.id).join(", ");
  return `${subs} background subagent(s) (ticket(s): ${ids})`;
}

export class VisibilitySignals {
  private readonly readTickets: () => readonly SignalTicket[];
  private readonly warned = new Set<string>();
  private footerCtx: StatusCtx | undefined;
  private lastFooter: string | undefined;

  constructor(readTickets: () => readonly SignalTicket[]) {
    this.readTickets = readTickets;
  }

  /** Cache a full-UI context (from tool execute) for footer updates. */
  captureFooterCtx(ctx: StatusCtx | undefined): void {
    if (ctx !== undefined && typeof ctx.ui?.setStatus === "function") {
      this.footerCtx = ctx;
      // A fresh context may succeed where the stale one failed: re-push.
      this.lastFooter = undefined;
      this.sync();
    }
  }

  private active(): SignalTicket[] {
    // A recovered record projects another session's journal — `running`
    // there means live under a sibling, not here, so it never counts as
    // this host's work (and quitting pi does not abort it).
    return this.readTickets().filter(
      (ticket) => ticket.status === "running" && ticket.recovered !== true,
    );
  }

  /** Recompute the footer; dedupe by text; prune the warned set. */
  sync(): void {
    const active = this.active();
    for (const id of [...this.warned]) {
      if (!active.some((ticket) => ticket.id === id)) this.warned.delete(id);
    }
    const text = footerText(active);
    if (text === this.lastFooter) return;
    const ctx = this.footerCtx;
    if (ctx === undefined) return;
    try {
      ctx.ui.setStatus(FOOTER_KEY, text);
      // Record success only: a failed push must retry on the next sync.
      this.lastFooter = text;
    } catch {
      // Stale context (host moved on); drop it so the next capture re-arms
      // with a clean dedupe baseline.
      this.footerCtx = undefined;
      this.lastFooter = undefined;
    }
  }

  /**
   * agent_settled: the turn looks idle but background work continues. One
   * aggregated warning per settle — once per ticket activation, marked
   * warned only when the notify actually reached the user — and the
   * footer carries it from there.
   */
  onSettled(ctx: DialogCtx): void {
    const unseen = this.active().filter((ticket) => !this.warned.has(ticket.id));
    if (unseen.length > 0) {
      const named = unseen
        .map((ticket) => `ticket ${ticket.id}`)
        .join(", ");
      const subs = unseen.reduce((sum, ticket) => sum + inFlight(ticket), 0);
      try {
        ctx.ui.notify(
          unseen.length === 1
            ? `⏳ ${subs} background subagent(s) still running (${named}) — quitting pi aborts them`
            : `⏳ ${subs} background subagent(s) still running across ${unseen.length} tickets (${named}) — quitting pi aborts them`,
          "warning",
        );
        for (const ticket of unseen) this.warned.add(ticket.id);
      } catch {
        // A failed notify must not burn the ticket's one warning.
      }
    }
    this.sync();
  }

  /**
   * Consent guard for session replacement. Undefined lets the replacement
   * proceed; `{ cancel: true }` blocks it. Never blocks headless hosts.
   */
  async guardReplacement(
    ctx: DialogCtx | undefined,
    verb: string,
  ): Promise<{ cancel?: boolean } | undefined> {
    const active = this.active();
    if (active.length === 0) return undefined;
    if (ctx === undefined || !ctx.hasUI) return undefined;
    const ids = active.map((ticket) => ticket.id).join(", ");
    const subs = active.reduce((sum, ticket) => sum + inFlight(ticket), 0);
    try {
      const proceed = await ctx.ui.confirm(
        "Background subagents still running",
        `${subs} subagent(s) (${ids}) still working. ${verb} aborts them — ` +
          `work already done is not rolled back. Continue anyway?`,
      );
      return proceed ? undefined : { cancel: true };
    } catch {
      // Fail open: delivery safety does not depend on the dialog.
      return undefined;
    }
  }

  /**
   * Consent guard for session-tree navigation: a 2-way choice — cancel
   * the background work and navigate, or stay. Deliberate divergence
   * from v1's 3-way prompt (owner decision, 2026-09-22): no hold option;
   * navigating with live tickets offers exactly cancel-or-stay. Dismissing
   * the dialog is "stay" — the conservative choice, since navigating is
   * what creates the hazard. A throwing dialog fails open: leaf-aware
   * delivery, not this prompt, is the correctness mechanism, so a broken
   * dialog must never trap the user. Never blocks headless hosts.
   */
  async guardTreeNavigation(
    ctx: DialogCtx | undefined,
    cancelActive: () => void,
  ): Promise<{ cancel?: boolean } | undefined> {
    const active = this.active();
    if (active.length === 0) return undefined;
    if (ctx === undefined || !ctx.hasUI) return undefined;
    const ids = active.map((ticket) => ticket.id).join(", ");
    const subs = active.reduce((sum, ticket) => sum + inFlight(ticket), 0);
    const cancel = "Navigate — cancel the background subagents";
    const stay = "Stay on this branch";
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(
        `${subs} background subagent(s) (${ids}) still running — ` +
          "navigating means their results arrive on a different branch",
        [cancel, stay],
      );
    } catch {
      // Fail open: delivery safety does not depend on the dialog.
      return undefined;
    }
    if (choice === cancel) {
      cancelActive();
      return undefined;
    }
    return { cancel: true };
  }

  /**
   * v1's quit/reload traces: a stderr line on quit (the TUI is already
   * gone), a warning notify on /reload, silence for guarded replacements.
   * Called before force-cancellation so the summary names live work.
   */
  shutdownTrace(
    reason: string,
    ctx: Pick<DialogCtx, "ui"> | undefined,
    active: readonly SignalTicket[],
  ): void {
    if (active.length === 0) return;
    const summary = activeSummary(active);
    if (reason === "quit") {
      console.error(`[delegate] pi exited with ${summary} — aborted.`);
      return;
    }
    if (reason === "reload") {
      try {
        ctx?.ui.notify(`[delegate] reload aborted ${summary}`, "warning");
      } catch {
        console.error(`[delegate] reload aborted ${summary}`);
      }
    }
  }
}

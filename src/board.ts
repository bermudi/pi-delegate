/**
 * The inline batch's live board (#119): while a synchronous
 * `async:false` dispatch runs, its pending tool row repaints — an
 * initial all-tasks frame, a ~1s heartbeat, and a refresh at each
 * recorded outcome. Rows live in the activity store under the call's
 * run id; the emitted partials are display-only — never the session
 * file or the model's context.
 *
 * Batch-scoped: one board per `delegate` execute, dead with the call.
 * The projection is read-only — frames are built from the store's row
 * snapshots plus the pipeline's notices, and the sanitize/truncate
 * bounds stay authoritative where the data lands (previews and labels
 * capped and ANSI-sanitized in src/activity.ts; per-row tail and label
 * budgets at src/render.ts's liveBoard). Nothing here reads
 * transcripts or history.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ActivityRow } from "./activity.ts";
import type { LiveDispatchDetails } from "./details.ts";

/** Newest tool calls each task carries in a frame (expanded view). */
const RECENT_CALLS = 5;

/** One frame's partial result: notices as content, the live projection
 * as details — the `delegate` tool's partial-update shape. */
export interface BoardFrame {
  content: AgentToolResult<LiveDispatchDetails>["content"];
  details: LiveDispatchDetails;
}

/** The one emit surface the board needs — the host's partial-result
 * callback (`onUpdate`), undefined when partials cannot be painted. */
export type BoardUpdateSink = (frame: BoardFrame) => void;

export interface InlineBoardDependencies {
  /** Undefined when the host cannot paint partials — the board then
   * never emits and never arms its heartbeat. */
  readonly onUpdate: BoardUpdateSink | undefined;
  /** This dispatch's activity-store run id (`inline-<toolCallId>`);
   * undefined for async batches, which never paint a board. */
  readonly syncRunId: string | undefined;
  /** This dispatch's live rows in start order — the board's only store
   * access, and read-only. */
  readonly rows: (runId: string) => readonly ActivityRow[];
}

/**
 * One frame's details, projected read-only from the store's rows: per
 * task its id, label, status, elapsed anchors, and the current
 * (in-flight arg preview) or last tool call's preview.
 */
function liveDetailsOf(
  rows: readonly ActivityRow[],
  notices: readonly string[],
): LiveDispatchDetails {
  return {
    mode: "dispatch",
    async: false,
    live: {
      startedAt: rows[0]!.startedAt,
      tasks: rows.map((row) => {
        const inFlight = row.toolCalls.find((callRow) => callRow.inFlight);
        const last = inFlight ?? row.toolCalls[row.toolCalls.length - 1];
        return {
          id: row.taskId,
          label: row.label,
          status: row.status,
          startedAt: row.startedAt,
          lastEventAt: row.lastEventAt,
          ...(last !== undefined
            ? {
                tool: last.tool,
                preview:
                  inFlight !== undefined ? last.argPreview : last.preview,
              }
            : {}),
          recent: row.toolCalls.slice(-RECENT_CALLS).map((call) => ({
            tool: call.tool,
            preview: call.inFlight ? call.argPreview : call.preview,
            inFlight: call.inFlight,
          })),
        };
      }),
    },
    ...(notices.length > 0 ? { notices: [...notices] } : {}),
  };
}

/**
 * The board's owned lifetime: the notices (filled once when the
 * pipeline returns — settle-driven repaints cannot precede that
 * point), the emit, the settle-time repaint hook, and the heartbeat
 * handle. `dispose` clears the interval on every exit — settle, throw,
 * or abort — so no timer outlives the call.
 */
export class InlineBoard {
  private notices: readonly string[] = [];
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: InlineBoardDependencies) {}

  /** Fill once — when the pipeline returns its notices. */
  setNotices(notices: readonly string[]): void {
    this.notices = notices;
  }

  /** Settle-time repaint — the pipeline's outcome-recorded hook. */
  readonly repaint = (): void => {
    this.emit();
  };

  /**
   * Publish the first frame — it paints every task row as tracked,
   * since by now coordinator.run's synchronous prefix registered them —
   * then arm the ~1s heartbeat for the batch's life. The interval
   * stays unref'd so it can never hold a dying process open.
   */
  start(): void {
    this.emit();
    if (
      this.deps.onUpdate === undefined ||
      this.deps.syncRunId === undefined ||
      this.heartbeat !== undefined
    ) {
      return;
    }
    this.heartbeat = setInterval(() => this.emit(), 1000);
    this.heartbeat.unref?.();
  }

  /**
   * Stop the heartbeat. Idempotent — safe on settle, throw, or abort,
   * and on calls that never armed one.
   */
  dispose(): void {
    if (this.heartbeat === undefined) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * Paint one frame — skipped while there are no rows or the board was
   * never paintable (no partial callback, async batch). The board is
   * display-only; a failed emit never reaches the batch.
   */
  private emit(): void {
    const { onUpdate, syncRunId, rows } = this.deps;
    if (onUpdate === undefined || syncRunId === undefined) return;
    try {
      const live = rows(syncRunId);
      if (live.length === 0) return;
      onUpdate({
        content:
          this.notices.length > 0
            ? [{ type: "text" as const, text: this.notices.join("\n") }]
            : [],
        details: liveDetailsOf(live, this.notices),
      });
    } catch {
      // The board is display-only; a failed emit never reaches the
      // batch.
    }
  }
}

/**
 * Human-facing renderers for the `delegate`/`delegate_ticket`/`delegate_session`
 * tools' results and for the delivered `delegate-result` custom message.
 *
 * Pi's stock result rendering only ever displays the LLM-facing `content`
 * text, which spill-bounds large outputs to a tail plus a file pointer —
 * so expanding a result never revealed the whole output even though
 * SPEC "Recovery" promises it ("a human expanding the result sees it
 * whole"). The expanded views below re-render from `details.results`, the
 * complete recorded outcomes every result and delivered message carries.
 * Ticket results prefer the live store's `fullView` (which adds the ticket
 * header); a replayed transcript whose ticket is gone falls back to the
 * recorded outcomes alone.
 *
 * Collapsed views are their own document (#63), not a truncation of the
 * model-facing text: one status-glyph line per task, a one-line receipt
 * for an async dispatch, a `manual` stub for help, and a bounded first
 * line for receipts and rosters — each with an expand hint. Styling goes
 * through the `theme` argument exclusively: the interactive-mode theme
 * singleton throws when uninitialized, which is exactly the state tests
 * render under.
 */
import { keyText } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  MessageRenderer,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  descriptionLabel,
  formatDispatchResult,
  resumeTagOf,
  truncateLine,
} from "./format.ts";
import { UNBOUNDED_OUTPUT } from "./spill.ts";
import type { TicketStore } from "./tickets.ts";
import type {
  TaskIntegration,
  TaskOutcome,
  TaskStatus,
  Ticket,
  TokenBudgetReport,
} from "./types.ts";
import type { SessionArguments, TicketArguments } from "./validation.ts";

/** Matches the stock tool-result fallback's collapsed preview budget. */
const COLLAPSED_PREVIEW_LINES = 10;
/** How many task previews a delegate call line lists before summarizing. */
const CALL_PREVIEW_TASKS = 4;
/** Display budget for a collapsed one-line task summary. */
const COLLAPSED_LINE_LIMIT = 110;
/** Call-row labels align to the longest shown, never wider than this. */
const CALL_LABEL_WIDTH = 16;
/** Result-line labels truncate so the summary keeps its budget. */
const RESULT_LABEL_LIMIT = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTokenBudgetReport(value: unknown): value is TokenBudgetReport {
  return (
    isRecord(value) &&
    typeof value.limit === "number" &&
    typeof value.consumed === "number" &&
    (value.exhaustedAt === undefined || typeof value.exhaustedAt === "number")
  );
}

function isOutcome(value: unknown): value is TaskOutcome {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === "ok" ||
      value.status === "failed" ||
      value.status === "cancelled" ||
      value.status === "blocked" ||
      value.status === "interrupted" ||
      value.status === "budget-exhausted")
  );
}

/**
 * `t-<uuid>` renders as `t-<first 8 hex>`; anything else passes through.
 * Display only — the id in `details` and correlation keys is untouched.
 */
function shortTicket(id: string): string {
  const match = /^t-([0-9a-f]{8})[0-9a-f-]{24,}$/i.exec(id);
  return match !== null ? `t-${match[1]}` : id;
}

/**
 * A compound `<ticket>#<task>` address shortens the ticket part; a bare
 * task id has nothing to shorten.
 */
function shortTicketAddress(id: string): string {
  const hash = id.indexOf("#");
  if (hash < 0) return shortTicket(id);
  return `${shortTicket(id.slice(0, hash))}${id.slice(hash)}`;
}

/**
 * Inline id shortening for rendered content text (#63 rework): every
 * `t-<uuid>` occurrence collapses to `t-<first 8 hex>` — including the
 * ticket part of a `<ticket>#<task>` address, where `#` ends the match.
 */
function shortenTicketIds(text: string): string {
  return text.replace(/t-([0-9a-f]{8})[0-9a-f-]{24,}/gi, "t-$1");
}

/**
 * The expanded document for a result's or delivered message's `details`,
 * or undefined when it carries no recoverable outcomes — in which case the
 * bounded content text is the most faithful expanded view available.
 */
function expandedText(
  details: unknown,
  tickets: TicketStore,
): string | undefined {
  if (!isRecord(details)) return undefined;
  // A ticket-backed result (a poll/wait view or a delivered message)
  // renders the store's whole view — header, notices, sections — which
  // the recorded outcomes alone cannot reproduce.
  if (typeof details.ticket === "string" && Array.isArray(details.results)) {
    const ticket = tickets.get(details.ticket);
    if (ticket !== undefined) return tickets.fullView(ticket);
    // Only a replayed transcript misses the store; fall through to the
    // outcomes recorded on the result itself.
  }
  // A coalesced wake (SPEC "Wake delivery": simultaneous settlements
  // batch into one message) renders each live ticket's full view in
  // order; a store miss on any of them falls through to the merged
  // recorded outcomes below — the replayed transcript path.
  if (Array.isArray(details.tickets)) {
    const views = (details.tickets as unknown[])
      .filter((id): id is string => typeof id === "string")
      .map((id) => tickets.get(id));
    if (
      views.length > 0 &&
      views.every((ticket) => ticket !== undefined)
    ) {
      return views
        .map((ticket) => tickets.fullView(ticket))
        .join("\n\n");
    }
  }
  if (!Array.isArray(details.results)) return undefined;
  const outcomes = details.results.filter(isOutcome);
  if (outcomes.length === 0) return undefined;
  const sections = formatDispatchResult(
    outcomes,
    [],
    UNBOUNDED_OUTPUT,
    tickets.surface,
    typeof details.brief === "string" ? details.brief : undefined,
    isTokenBudgetReport(details.tokenBudget) ? details.tokenBudget : undefined,
  );
  const notices = Array.isArray(details.notices)
    ? details.notices.filter((n): n is string => typeof n === "string")
    : [];
  return notices.length > 0
    ? `${notices.join("\n")}\n\n${sections}`
    : sections;
}

function styled(text: string, theme: Theme): string {
  return text
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
}

/** Collapse a prompt to a single ~60-char line for the call row. */
function promptPreview(prompt: string): string {
  return truncateLine(prompt.replace(/\s+/g, " ").trim(), 60);
}

function textOf(component: Component | undefined): Text {
  return component instanceof Text ? component : new Text("", 0, 0);
}

/**
 * The muted `(… more, <keys> to expand)` trailer a collapsed view carries
 * when expanding would reveal more.
 */
function expandHint(theme: Theme): string {
  const keys = keyText("app.tools.expand");
  return theme.fg(
    "muted",
    ` (… more${keys !== "" ? `, ${keys} to expand` : ""})`,
  );
}

/**
 * The `delegate` tool's call row: a static `delegate N tasks` header plus
 * up to four task previews (`<label>  <~60 chars of prompt>`; a resume-only
 * task shows its `↻` tag instead). The label is the caller's `description`,
 * else its `id`, else the `agent` name, else `inline` — compact callers
 * cannot set ids, so a positional `task-N` would be noise, not information
 * (#63). Labels pad to a common width so previews align. Empty task lists
 * render `delegate manual`. Deliberately stateless — no spinner, timers,
 * or live state: the row reads identically while the call streams and
 * after it settles, so a human scanning the transcript sees the same call
 * the model made.
 */
export function renderDelegateCall(
  args: {
    readonly tasks?: readonly {
      readonly id?: string;
      readonly description?: string;
      readonly agent?: string;
      readonly prompt?: string;
      readonly resumeFrom?: string;
    }[];
  },
  theme: Theme,
  context: { lastComponent: Component | undefined },
): Component {
  const component = textOf(context.lastComponent);
  const tasks = args.tasks ?? [];
  if (tasks.length === 0) {
    component.setText(theme.fg("toolTitle", theme.bold("delegate manual")));
    return component;
  }
  const shown = tasks.slice(0, CALL_PREVIEW_TASKS).map((task) => ({
    task,
    label: truncateLine(
      descriptionLabel(task.description) ?? task.id ?? task.agent ?? "inline",
      CALL_LABEL_WIDTH,
    ),
  }));
  const width = Math.min(
    CALL_LABEL_WIDTH,
    Math.max(...shown.map((entry) => entry.label.length)),
  );
  const lines = [
    theme.fg(
      "toolTitle",
      theme.bold(`delegate ${tasks.length} task${tasks.length === 1 ? "" : "s"}`),
    ),
  ];
  for (const { task, label } of shown) {
    const preview =
      task.prompt !== undefined && task.prompt.trim() !== ""
        ? promptPreview(task.prompt)
        : task.resumeFrom !== undefined
          ? `↻${resumeTagOf(task.resumeFrom)}`
          : "(no prompt)";
    lines.push(theme.fg("muted", `  ${label.padEnd(width)}  ${preview}`));
  }
  const rest = tasks.length - CALL_PREVIEW_TASKS;
  if (rest > 0) {
    lines.push(theme.fg("muted", `  … and ${rest} more`));
  }
  component.setText(lines.join("\n"));
  return component;
}

/**
 * The `delegate_ticket` tool's call row: the static `delegate_ticket
 * <action>` line plus its target ticket — rendered short (`t-81a83dbe`)
 * since the full UUID is correlation data, not something a human reads —
 * and the task target steer/interrupt/tail/answer name, as a compound
 * `t-81a83dbe#task-1` (#63).
 */
export function renderTicketCall(
  args: TicketArguments,
  theme: Theme,
  context: { lastComponent: Component | undefined },
): Component {
  const component = textOf(context.lastComponent);
  const target =
    args.taskId !== undefined
      ? ` #${shortTicketAddress(
          args.taskId.includes("#") || args.ticket === undefined
            ? args.taskId
            : `${args.ticket}#${args.taskId}`,
        )}`
      : args.ticket !== undefined
        ? ` #${shortTicket(args.ticket)}`
        : Array.isArray(args.tickets) && args.tickets.length > 0
          ? ` ${args.tickets.map((id) => `#${shortTicket(id)}`).join(",")}`
          : "";
  component.setText(
    theme.fg("toolTitle", theme.bold(`delegate_ticket ${args.action}`)) +
      theme.fg("muted", target),
  );
  return component;
}

/**
 * The `delegate_session` tool's call row: the static `delegate_session
 * <action>` line plus the session id a `close` names.
 */
export function renderSessionCall(
  args: SessionArguments,
  theme: Theme,
  context: { lastComponent: Component | undefined },
): Component {
  const component = textOf(context.lastComponent);
  const target = args.sessionId !== undefined ? ` #${args.sessionId}` : "";
  component.setText(
    theme.fg("toolTitle", theme.bold(`delegate_session ${args.action}`)) +
      theme.fg("muted", target),
  );
  return component;
}

function contentText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

/** The label a collapsed task line shows: description, agent, then id. */
interface CollapsedTaskMeta {
  readonly description?: string | undefined;
  readonly agent?: string | undefined;
  readonly id?: string | undefined;
}

function collapsedTaskLabel(
  outcome: TaskOutcome | undefined,
  meta: CollapsedTaskMeta | undefined,
  index: number,
): string {
  // An unsettled slot carries no store/meta label — a positional task-N
  // beats the anonymous "task" the first cut rendered (#63).
  return truncateLine(
    descriptionLabel(meta?.description) ??
      meta?.agent ??
      outcome?.id ??
      meta?.id ??
      `task-${index + 1}`,
    RESULT_LABEL_LIMIT,
  );
}

/**
 * The summary a collapsed task line shows: the first substantive output
 * line — markdown headings/bullets/quotes stripped, `**`/`__` emphasis
 * dropped, and a lead-in ending in ":" ("Here's my report:") skipped in
 * favor of the first non-lead-in line among the first five (#63).
 */
function summaryLine(output: string | undefined): string {
  const lines = (output ?? "")
    .split("\n")
    .map((raw) => raw.replace(/^[#\-*>\s]+/, "").trim())
    .filter((line) => line !== "" && !/^(```|~~~)/.test(line));
  const picked =
    lines.slice(0, 5).find((line) => !line.endsWith(":")) ?? lines[0] ?? "";
  return picked.replace(/\*\*|__/g, "").trim();
}

/**
 * Integration meta for a collapsed task line: file attribution count,
 * statuses a human should see (applied/no_changes stay silent — the
 * interesting states are the exceptional ones), and source drift (#62).
 */
function collapsedOutcomeMeta(
  outcome: TaskOutcome,
): {
  muted: string;
  spans: { text: string; color: "success" | "error" | "warning" }[];
} {
  const files = outcome.attributedFiles?.length ?? 0;
  const muted = files > 0 ? ` · ${files} file${files === 1 ? "" : "s"}` : "";
  const spans: { text: string; color: "success" | "error" | "warning" }[] = [];
  const integration: TaskIntegration | undefined = outcome.integration;
  if (
    integration !== undefined &&
    integration.status !== "applied_unverified" &&
    integration.status !== "no_changes"
  ) {
    spans.push({ text: ` · ${integration.status}`, color: "warning" });
  }
  if (integration?.sourceDrift !== undefined && integration.sourceDrift.length > 0) {
    spans.push({ text: " · source drift", color: "warning" });
  }
  // The verifier profile's parsed verdict rides the same trailer (#63).
  if (outcome.verdict !== undefined) {
    spans.push({
      text: ` · VERDICT ${outcome.verdict}`,
      color:
        outcome.verdict === "PASS"
          ? "success"
          : outcome.verdict === "FAIL"
            ? "error"
            : "warning",
    });
  }
  return { muted, spans };
}

type CollapsedStatus = TaskStatus | "running";

function collapsedGlyph(status: CollapsedStatus): { glyph: string; color: "success" | "error" | "warning" | "muted" } {
  switch (status) {
    case "ok":
      return { glyph: "✓", color: "success" };
    case "failed":
      return { glyph: "✗", color: "error" };
    case "cancelled":
    case "interrupted":
    case "budget-exhausted":
      return { glyph: "⊘", color: "warning" };
    case "blocked":
      return { glyph: "⊘", color: "muted" };
    default:
      return { glyph: "○", color: "muted" };
  }
}

/**
 * One collapsed task line: `{icon} {label}  {summary}{meta}` bounded to
 * ~110 chars — the summary shrinks to keep the meta trailer visible.
 * A null/undefined slot is an unsettled task: `○` and `running`.
 */
function collapsedTaskLine(
  slot: TaskOutcome | undefined | null,
  meta: CollapsedTaskMeta | undefined,
  index: number,
  theme: Theme,
): string {
  const outcome = slot === null ? undefined : slot;
  const { glyph, color } = collapsedGlyph(outcome?.status ?? "running");
  const label = collapsedTaskLabel(outcome, meta, index);
  const extras =
    outcome !== undefined
      ? collapsedOutcomeMeta(outcome)
      : { muted: "", spans: [] };
  const metaText = extras.muted + extras.spans.map((span) => span.text).join("");
  const summary =
    outcome === undefined
      ? "running"
      : outcome.status === "ok"
        ? summaryLine(outcome.output)
        : (outcome.error ?? outcome.status);
  const budget = Math.max(
    20,
    COLLAPSED_LINE_LIMIT - glyph.length - 1 - label.length - 2 - metaText.length,
  );
  const summaryText =
    summary === "" && outcome?.status === "ok"
      ? "no output"
      : truncateLine(summary, budget);
  let line = `${theme.fg(color, glyph)} ${theme.fg("toolTitle", label)}  `;
  line +=
    outcome === undefined ||
    (outcome.status === "ok" && summary === "")
      ? theme.fg("muted", summaryText)
      : theme.fg("toolOutput", summaryText);
  if (extras.muted !== "") line += theme.fg("muted", extras.muted);
  for (const span of extras.spans) line += theme.fg(span.color, span.text);
  return line;
}

/**
 * The `ticket t-81a83dbe · <status> <done>/<total>` header over a live
 * ticket's collapsed task lines; only renderable while the ticket is in
 * the store — a replayed transcript omits it.
 */
function collapsedTicketHeader(ticket: Ticket, theme: Theme): string {
  const status =
    ticket.status === "running" && ticket.paused ? "paused" : ticket.status;
  const done = ticket.outcomes.filter((outcome) => outcome !== undefined).length;
  return theme.fg(
    "muted",
    `ticket ${shortTicket(ticket.id)} · ${status} ${done}/${ticket.totalTasks}`,
  );
}

/**
 * The collapsed body for the details-carrying results: help, async
 * dispatch receipt, sync dispatch outcomes, and ticket poll/wait views —
 * or undefined when none applies and the content preview should render.
 */
function collapsedBody(
  result: AgentToolResult<unknown>,
  tickets: TicketStore,
  theme: Theme,
): string | undefined {
  const details = result.details;
  if (!isRecord(details)) return undefined;
  if (details.mode === "help") {
    // The call row already says "delegate manual" — collapsed carries only
    // the expand hint (#63).
    const keys = keyText("app.tools.expand");
    return theme.fg(
      "muted",
      keys !== "" ? `(${keys} to read)` : "(expand to read)",
    );
  }
  if (
    details.mode === "dispatch" &&
    details.async === true &&
    typeof details.ticket === "string"
  ) {
    const count = Array.isArray(details.tasks) ? details.tasks.length : 0;
    return (
      theme.fg(
        "toolOutput",
        `↳ background ticket ${shortTicket(details.ticket)} · ${count} task${count === 1 ? "" : "s"} · results arrive automatically`,
      ) + expandHint(theme)
    );
  }
  if (Array.isArray(details.results) && details.results.length > 0) {
    const ticket =
      typeof details.ticket === "string"
        ? tickets.get(details.ticket)
        : undefined;
    const syncTasks = Array.isArray(details.tasks)
      ? (details.tasks as readonly CollapsedTaskMeta[])
      : undefined;
    const lines: string[] = [];
    if (ticket !== undefined) lines.push(collapsedTicketHeader(ticket, theme));
    details.results.forEach((slot, index) => {
      const outcome = isOutcome(slot) ? slot : undefined;
      lines.push(
        collapsedTaskLine(
          outcome,
          ticket !== undefined
            ? ticket.tasks[outcome?.index ?? index]
            : syncTasks?.[index],
          index,
          theme,
        ),
      );
    });
    return lines.join("\n") + "\n" + expandHint(theme).trimStart();
  }
  return undefined;
}

/**
 * A bare-poll roster collapses to its entry lines — ids display-shortened,
 * capped at five — plus the other-sessions note a #64-scoped roster
 * appends, rather than the bare `Tickets:` header (#63).
 */
function collapsedRoster(text: string, theme: Theme): string {
  const lines = text.split("\n");
  const entries = lines.filter((line) => line.startsWith("- "));
  const hidden = lines.find((line) =>
    line.includes("from other sessions not shown"),
  );
  const body = [
    ...entries
      .slice(0, 5)
      .map((line) => theme.fg("toolOutput", shortenTicketIds(line))),
    ...(entries.length > 5
      ? [theme.fg("muted", `  … and ${entries.length - 5} more`)]
      : []),
    ...(hidden !== undefined ? [theme.fg("muted", hidden)] : []),
  ];
  return body.join("\n") + expandHint(theme);
}

/**
 * The tool definitions' `renderResult`: collapsed renders the compact
 * per-task/ticket view (#63); expanded renders the complete recorded
 * outcomes from `details.results` — the whole output a human expanding
 * the result is promised.
 */
export function createResultRenderer(tickets: TicketStore) {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: { lastComponent: Component | undefined; isError?: boolean },
  ): Component => {
    const component =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
    if (!options.expanded && context.isError !== true) {
      const collapsed = collapsedBody(result, tickets, theme);
      if (collapsed !== undefined) {
        component.setText(collapsed);
        return component;
      }
      // A roster poll keeps its entry lines — the bare "Tickets:" header
      // alone carries nothing (#63).
      const text = contentText(result);
      if (text.startsWith("Tickets:")) {
        component.setText(collapsedRoster(text, theme));
        return component;
      }
      // Receipts and sessions: the first content line — ticket ids
      // display-shortened — bounded to the collapsed budget, plus the
      // expand hint when more exists.
      const lines = text.split("\n");
      const first = lines.find((line) => line.trim() !== "") ?? "";
      component.setText(
        styled(
          truncateLine(shortenTicketIds(first), COLLAPSED_LINE_LIMIT) +
            (lines.length > 1 ? expandHint(theme) : ""),
          theme,
        ),
      );
      return component;
    }
    let body = options.expanded
      ? (expandedText(result.details, tickets) ?? contentText(result))
      : contentText(result);
    if (!options.expanded) {
      const lines = body.split("\n");
      if (lines.length > COLLAPSED_PREVIEW_LINES) {
        const keys = keyText("app.tools.expand");
        body =
          lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n") +
          theme.fg(
            "muted",
            `\n... (${lines.length - COLLAPSED_PREVIEW_LINES} more lines${keys !== "" ? `, ${keys} to expand` : ""})`,
          );
      }
    }
    component.setText(styled(body, theme));
    return component;
  };
}

/**
 * The delivered `delegate-result` message's renderer: collapsed renders
 * the `[delegate-result]` label plus the same per-task lines a ticket
 * poll would — one header per ticket on coalesced deliveries (#63);
 * expanded renders the complete outcomes — the live ticket's `fullView`
 * (header, notices, sections) when the ticket is still in the store,
 * else the recorded `details.results` sections.
 */
export function createMessageRenderer(tickets: TicketStore): MessageRenderer {
  return (message, options, theme) => {
    const details = message.details;
    if (!options.expanded) {
      const ids: string[] = !isRecord(details)
        ? []
        : Array.isArray(details.tickets)
          ? (details.tickets as unknown[]).filter(
              (id): id is string => typeof id === "string",
            )
          : typeof details.ticket === "string"
            ? [details.ticket]
            : [];
      const lines: string[] = [];
      for (const id of ids) {
        const ticket = tickets.get(id);
        if (ticket === undefined) continue;
        lines.push(collapsedTicketHeader(ticket, theme));
        ticket.outcomes.forEach((outcome, index) => {
          lines.push(
            collapsedTaskLine(outcome, ticket.tasks[index], index, theme),
          );
        });
      }
      // A replayed transcript misses the store: render the recorded
      // merged outcomes once, without per-ticket headers.
      if (
        lines.length === 0 &&
        isRecord(details) &&
        Array.isArray(details.results)
      ) {
        (details.results as unknown[]).forEach((slot, index) => {
          const outcome = isOutcome(slot) ? slot : undefined;
          lines.push(collapsedTaskLine(outcome, undefined, index, theme));
        });
      }
      if (lines.length === 0) return undefined;
      const label = theme.fg(
        "customMessageLabel",
        theme.bold(`[${message.customType}]`),
      );
      const styledBody = lines
        .join("\n")
        .split("\n")
        .map((line) => theme.fg("customMessageText", line))
        .join("\n");
      return new Text(
        `${label}\n${styledBody}\n${expandHint(theme).trimStart()}`,
        options.outputPad,
        0,
      );
    }
    let body = expandedText(details, tickets);
    if (body === undefined) return undefined;
    // Mirror the delivery text's cancelled-ticket suffix — fullView renders
    // the ticket document, not the delivery annotation.
    const anyCancelled =
      isRecord(details) &&
      ((typeof details.ticket === "string" &&
        tickets.get(details.ticket)?.status === "cancelled") ||
        (Array.isArray(details.tickets) &&
          (details.tickets as unknown[]).some(
            (id) =>
              typeof id === "string" &&
              tickets.get(id)?.status === "cancelled",
          )));
    if (anyCancelled) {
      body += "\nCancellation is cooperative; worker cleanup may still be pending.";
    }
    const label = theme.fg(
      "customMessageLabel",
      theme.bold(`[${message.customType}]`),
    );
    const styledBody = body
      .split("\n")
      .map((line) => theme.fg("customMessageText", line))
      .join("\n");
    return new Text(`${label}\n\n${styledBody}`, options.outputPad, 0);
  };
}

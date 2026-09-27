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
 * Collapsed views keep the host's compact contract — a preview of the
 * bounded content with an expand hint, matching the stock fallback's
 * budget. Styling goes through the `theme` argument exclusively: the
 * interactive-mode theme singleton throws when uninitialized, which is
 * exactly the state tests render under.
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
  formatDispatchResult,
  resumeTagOf,
  truncateLine,
} from "./format.ts";
import { UNBOUNDED_OUTPUT } from "./spill.ts";
import type { TicketStore } from "./tickets.ts";
import type { TaskOutcome } from "./types.ts";
import type { SessionArguments, TicketArguments } from "./validation.ts";

/** Matches the stock tool-result fallback's collapsed preview budget. */
const COLLAPSED_PREVIEW_LINES = 10;
/** How many task previews a delegate call line lists before summarizing. */
const CALL_PREVIEW_TASKS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOutcome(value: unknown): value is TaskOutcome {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === "ok" ||
      value.status === "failed" ||
      value.status === "cancelled" ||
      value.status === "blocked")
  );
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
  const sections = formatDispatchResult(outcomes, [], UNBOUNDED_OUTPUT);
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
 * The `delegate` tool's call row: a static `delegate N tasks` header plus
 * up to four task previews (`<id>  <~60 chars of prompt>`; a resume-only
 * task shows its `↻` tag instead). Empty task lists render
 * `delegate manual`. Deliberately stateless — no spinner, timers, or live
 * state: the row reads identically while the call streams and after it
 * settles, so a human scanning the transcript sees the same call the
 * model made.
 */
export function renderDelegateCall(
  args: {
    readonly tasks?: readonly {
      readonly id?: string;
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
  const lines = [
    theme.fg(
      "toolTitle",
      theme.bold(`delegate ${tasks.length} task${tasks.length === 1 ? "" : "s"}`),
    ),
  ];
  tasks.slice(0, CALL_PREVIEW_TASKS).forEach((task, index) => {
    const label = task.id ?? `task-${index + 1}`;
    const preview =
      task.prompt !== undefined && task.prompt.trim() !== ""
        ? promptPreview(task.prompt)
        : task.resumeFrom !== undefined
          ? `↻${resumeTagOf(task.resumeFrom)}`
          : "(no prompt)";
    lines.push(theme.fg("muted", `  ${label}  ${preview}`));
  });
  const rest = tasks.length - CALL_PREVIEW_TASKS;
  if (rest > 0) {
    lines.push(theme.fg("muted", `  … and ${rest} more`));
  }
  component.setText(lines.join("\n"));
  return component;
}

/**
 * The `delegate_ticket` tool's call row: the static `delegate_ticket
 * <action>` line plus its target ticket when the call names one.
 */
export function renderTicketCall(
  args: TicketArguments,
  theme: Theme,
  context: { lastComponent: Component | undefined },
): Component {
  const component = textOf(context.lastComponent);
  const target = args.ticket !== undefined ? ` #${args.ticket}` : "";
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

/**
 * The tool definitions' `renderResult`: collapsed mirrors the stock
 * fallback (a bounded preview of the content); expanded renders the
 * complete recorded outcomes from `details.results` — the whole output a
 * human expanding the result is promised.
 */
export function createResultRenderer(tickets: TicketStore) {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: { lastComponent: Component | undefined },
  ): Component => {
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
    const component =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
    component.setText(styled(body, theme));
    return component;
  };
}

/**
 * The delivered `delegate-result` message's renderer: collapsed returns
 * undefined so the host's default custom-message chrome shows the bounded
 * content as before; expanded renders the complete outcomes — the live
 * ticket's `fullView` (header, notices, sections) when the ticket is
 * still in the store, else the recorded `details.results` sections.
 */
export function createMessageRenderer(tickets: TicketStore): MessageRenderer {
  return (message, options, theme) => {
    if (!options.expanded) return undefined;
    const details = message.details;
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

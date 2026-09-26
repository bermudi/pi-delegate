import {
  Type,
  type Static,
  type TSchemaOptions,
  type TUnsafe,
} from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AdmissionController,
  type AdmissionGrant,
} from "./src/admission.ts";
import {
  loadDelegateConfig,
  resolveAgentDir,
  type DelegateConfig,
} from "./src/config.ts";
import {
  DispatchCoordinator,
  type DispatchOutcome,
} from "./src/coordinator.ts";
import {
  formatDispatchResult,
  serializedNotices,
} from "./src/format.ts";
import {
  hostEnvironment,
  resolveTasks,
  type HostEnvironment,
} from "./src/host.ts";
import {
  dispatchFingerprint,
  OperationStore,
} from "./src/operations.ts";
import { createActivityStore } from "./src/activity.ts";
import { registerSubagentBrowser } from "./src/browser.ts";
import { discoverProfiles } from "./src/profiles.ts";
import {
  createMessageRenderer,
  createResultRenderer,
} from "./src/render.ts";
import { VisibilitySignals } from "./src/visibility.ts";
import { handleSessionRpc, SessionPool } from "./src/sessions.ts";
import { TelemetryStore } from "./src/telemetry.ts";
import { handleTicketRpc, TicketStore } from "./src/tickets.ts";
import {
  Deferred,
  type OutputBounds,
  type ResolvedTask,
  type Ticket,
} from "./src/types.ts";
import {
  MODEL_FIELD_REJECTION,
  THINKING_FIELD_REJECTION,
  validateDispatchCall,
  validateSessionCall,
  validateTicketCall,
  type TaskInput,
} from "./src/validation.ts";
import {
  prepareWorkspaces,
  workspaceNeedsSettlementHold,
  type WorkspacePlan,
} from "./src/workspaces.ts";

function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options: TSchemaOptions,
): TUnsafe<Values[number]> {
  return Type.Unsafe<Values[number]>({
    ...options,
    type: "string",
    enum: [...values],
  });
}

const taskSchema = Type.Object(
  {
    id: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9._-]{1,64}$",
        description: "Optional correlation key; unique within the batch.",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        description:
          "Self-contained task brief; optional only when resumeFrom continues a transcript. Subagents never see this conversation.",
      }),
    ),
    agent: Type.Optional(
      Type.String({
        description:
          "Named profile: 'default' (mirrors the parent), 'scout' (read-only investigation), 'coder' (implementation), 'reviewer' (read-only review), or a user-defined Markdown profile (.pi/agents). Omit for an inline task.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory; relative paths resolve from the parent cwd.",
      }),
    ),
    systemPrompt: Type.Optional(
      Type.String({
        description:
          "Base prompt for the subagent; project context is added separately.",
      }),
    ),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Exact capabilities. '*' = the writer group (read, bash, edit, write); 'ro' = the read-only group (read, grep, find, ls); other entries name one child tool each.",
      }),
    ),
    sessionId: Type.Optional(
      Type.String({
        description:
          "Key for a live reusable session; later tasks with the same id continue it. Its configuration is frozen at first use. List or close pooled sessions with delegate_session.",
      }),
    ),
    resumeFrom: Type.Optional(
      Type.String({
        description: "Absolute path to a .jsonl session transcript.",
      }),
    ),
    deadlineMs: Type.Optional(
      Type.Number({
        description:
          "Positive wall-clock budget in milliseconds, counted from after queueing; omission means no deadline.",
      }),
    ),
    workspace: Type.Optional(
      stringEnum(["shared", "scratch", "isolated"], {
        description:
          "shared/scratch/isolated. 'shared' edits the tree; writers in one repo run one at a time in task order. 'isolated' runs each task in a private Git worktree — same-repo edits run in parallel and merge in order. 'scratch' runs once in a disposable copy and discards every change — for write-capable tasks whose value is the answer, not the edits; read-only tasks cannot use it.",
      }),
    ),
    dependsOn: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Ids of tasks in this batch that must succeed before this one starts; their outputs are handed off.",
      }),
    ),
  },
  { additionalProperties: false },
);

const delegateSchema = Type.Object(
  {
    tasks: Type.Array(taskSchema, {
      minItems: 0,
      description: "Subagent tasks to run; pass [] for the manual.",
    }),
    async: Type.Optional(
      Type.Boolean({
        description:
          "Run the whole batch in the background (default false): returns a ticket immediately and delivers the settled result automatically. Inspect or control it with delegate_ticket.",
      }),
    ),
    workspace: Type.Optional(
      stringEnum(["shared", "scratch", "isolated"], {
        description:
          "Default workspace for every task lacking its own. 'isolated' = parallel same-repo edits. 'scratch' = disposable copy, changes discarded.",
      }),
    ),
    operationId: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9._-]{1,64}$",
        description:
          "Bounded duplicate-safe dispatch key; same key plus the same request reuses the original in-flight or settled result, same key plus a changed request errors.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ticketSchema = Type.Object(
  {
    action: stringEnum(["poll", "wait", "cancel", "pause", "resume", "answer"], {
      description:
        "Ticket operation. poll: one ticket's view, or the roster when ticket is omitted. wait: block until settlement or timeoutMs. cancel: preview, or cooperative cancellation with force: true. pause/resume: hold and release queued work. answer: reply to a worker's pending question.",
    }),
    ticket: Type.Optional(
      Type.String({
        description:
          "Ticket id; required for every action except a roster poll.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description:
          "Maximum wait in milliseconds; only with action 'wait'. A timeout detaches the waiter only — the ticket keeps running.",
      }),
    ),
    force: Type.Optional(
      Type.Boolean({
        description:
          "Only with action 'cancel': true performs the cancellation; omitted or false previews.",
      }),
    ),
    taskId: Type.Optional(
      Type.String({
        description: "Only with action 'answer': the task that asked.",
      }),
    ),
    questionId: Type.Optional(
      Type.String({
        description:
          "Only with action 'answer': the question id shown in the ticket's poll view.",
      }),
    ),
    answer: Type.Optional(
      Type.String({
        description:
          "Only with action 'answer': the nonempty reply sent to the waiting worker.",
      }),
    ),
  },
  { additionalProperties: false },
);

const sessionSchema = Type.Object(
  {
    action: stringEnum(["list", "close"], {
      description:
        "'list' reports live pooled sessions; 'close' aborts, disposes, and removes one.",
    }),
    sessionId: Type.Optional(
      Type.String({
        description:
          "Session id; required with action 'close', rejected with 'list'.",
      }),
    ),
  },
  { additionalProperties: false },
);

type DelegateArguments = Static<typeof delegateSchema>;
type TicketToolArguments = Static<typeof ticketSchema>;
type SessionToolArguments = Static<typeof sessionSchema>;
type DelegateDetails = Record<string, unknown>;
type DelegateResult = AgentToolResult<DelegateDetails>;

/** customType of the custom message that delivers a settled async batch. */
const DELIVERED_MESSAGE_TYPE = "delegate-result";

type TaskSchemaArguments = Static<typeof taskSchema>;

/**
 * Flat-field fold list, derived from the task schema's own keys so a field
 * added to taskSchema participates in boundary recovery without a second
 * hand-maintained list. `model` and `thinking` are deliberately absent:
 * they are not task fields and are rejected outright wherever they appear —
 * folding or echoing them would only disguise the rejection.
 */
const taskFieldNames = Object.keys(
  taskSchema.properties,
) as readonly (keyof TaskSchemaArguments)[];

/**
 * Dispatch-owned fields for sibling-tool guidance checks on
 * delegate_ticket/delegate_session — a stray one means the caller pasted a
 * dispatch call at the wrong tool. `sessionId` is absent: on delegate_ticket
 * it routes to delegate_session guidance, on delegate_session it is native.
 */
const dispatchFieldNames = [
  "tasks",
  "async",
  "workspace",
  "operationId",
  ...taskFieldNames.filter((field) => field !== "sessionId"),
  "context",
] as const;

/** Ticket-owned fields for delegate_session's foreign-field guidance. */
const ticketFieldNames = [
  "ticketAction",
  "ticket",
  "force",
  "timeoutMs",
  "taskId",
  "questionId",
  "answer",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Empty or whitespace-only string. */
function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

/** `null` means "not given" at every level of every tool's arguments. */
function stripNulls(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (record[key] === null) delete record[key];
  }
}

/** A blank value counts as "not given" for the listed optional identifiers. */
function stripBlank(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (isBlank(record[key])) delete record[key];
  }
}

/** Defined and not blank — a value the caller actually gave. */
function isGiven(value: unknown): boolean {
  return value !== undefined && !isBlank(value);
}

function parseArray(value: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTools(value: string): unknown {
  const parsed = parseArray(value);
  if (parsed) return parsed;
  const token = value.trim();
  return token !== "" && !/[\s,]/.test(token) ? [token] : value;
}

const TICKET_ACTIONS = ["poll", "wait", "cancel", "pause", "resume", "answer"];
const SESSION_ACTIONS = ["list", "close"];

/** A `delegate_ticket` example call built from the fields the caller sent. */
function delegateTicketExample(args: Record<string, unknown>): string {
  // Selector values are clamped to the real enum: an example that repeats
  // an invalid action back fails again if the caller follows it.
  const action =
    typeof args.ticketAction === "string" &&
    TICKET_ACTIONS.includes(args.ticketAction)
      ? args.ticketAction
      : typeof args.action === "string" && TICKET_ACTIONS.includes(args.action)
        ? args.action
        : isGiven(args.taskId) ||
            isGiven(args.questionId) ||
            isGiven(args.answer)
          ? "answer"
          : args.force === true
            ? "cancel"
            : "poll";
  const fields = [`action: ${JSON.stringify(action)}`];
  if (typeof args.ticket === "string" && !isBlank(args.ticket)) {
    fields.push(`ticket: ${JSON.stringify(args.ticket)}`);
  }
  if (action === "cancel" && args.force === true) fields.push("force: true");
  if (action === "wait" && typeof args.timeoutMs === "number") {
    fields.push(`timeoutMs: ${JSON.stringify(args.timeoutMs)}`);
  }
  if (action === "answer") {
    for (const key of ["taskId", "questionId", "answer"] as const) {
      if (typeof args[key] === "string" && !isBlank(args[key])) {
        fields.push(`${key}: ${JSON.stringify(args[key])}`);
      }
    }
  }
  return `delegate_ticket({ ${fields.join(", ")} })`;
}

/** A `delegate_session` example call built from the fields the caller sent. */
function delegateSessionExample(args: Record<string, unknown>): string {
  const action =
    typeof args.sessionAction === "string" &&
    SESSION_ACTIONS.includes(args.sessionAction)
      ? args.sessionAction
      : typeof args.action === "string" && SESSION_ACTIONS.includes(args.action)
        ? args.action
        : args.sessionId !== undefined
          ? "close"
          : "list";
  const fields = [`action: ${JSON.stringify(action)}`];
  if (typeof args.sessionId === "string" && !isBlank(args.sessionId)) {
    fields.push(`sessionId: ${JSON.stringify(args.sessionId)}`);
  }
  return `delegate_session({ ${fields.join(", ")} })`;
}

/** A `delegate` dispatch example built from the task fields the caller sent. */
function delegateDispatchExample(args: Record<string, unknown>): string {
  if (Array.isArray(args.tasks)) {
    return `delegate({ tasks: ${JSON.stringify(args.tasks)} })`;
  }
  const task: Record<string, unknown> = {};
  for (const key of taskFieldNames) {
    if (args[key] !== undefined) task[key] = args[key];
  }
  return Object.keys(task).length > 0
    ? `delegate({ tasks: [${JSON.stringify(task)}] })`
    : `delegate({ tasks: [{ prompt: "..." }] })`;
}

/** Run before host schema coercion so obsolete fields receive migration guidance. */
function rejectObsoleteContext(record: Record<string, unknown>): void {
  if (Object.hasOwn(record, "context")) {
    throw new Error(
      'The context field has been removed (including "fresh" and "with-parent-transcript"). ' +
        'Omit context and provide a self-contained task brief; parent conversation history is never shared. ' +
        'Child-owned sessionId and resumeFrom history remain supported.',
    );
  }
}

function normalizeTask(value: unknown, index: number): unknown {
  if (!isRecord(value)) return value;
  const task = { ...value };
  // Presence of `context` rejects even when null — before null stripping.
  rejectObsoleteContext(task);
  stripNulls(task);
  if (task.model !== undefined) {
    throw new Error(`tasks[${index}]: ${MODEL_FIELD_REJECTION}`);
  }
  if (task.thinking !== undefined) {
    throw new Error(`tasks[${index}]: ${THINKING_FIELD_REJECTION}`);
  }
  if (typeof task.tools === "string") task.tools = normalizeTools(task.tools);
  stripBlank(task, ["sessionId", "cwd", "resumeFrom", "agent"]);
  return task;
}

/**
 * Reject ambiguous shapes the host would silently coerce.
 *
 * pi-ai validates tool arguments with typebox 1.x `Value.Convert`, which
 * unconditionally coerces strings on schemas it recognizes — "true"→true,
 * "123"→123, "read, write"→["read, write"]. This schema is built with the
 * same `typebox` package, so it is always recognized: without this pass the
 * host would silently repair shapes SPEC.md does not authorize (its repair
 * list is exactly: stringified task arrays, flat task fields, JSON-array or
 * bare-token `tools` strings, and empty agent names). `prepareArguments` is
 * the only hook that runs before that coercion, so the boundary lives here;
 * a throw surfaces to the caller as a normal whole-call tool error.
 */
function rejectAmbiguousShapes(args: Record<string, unknown>): void {
  if (
    args.operationId !== undefined &&
    typeof args.operationId !== "string"
  ) {
    throw new Error(
      `'operationId' must be a string of 1-64 letters, digits, dots, underscores, or hyphens, not ${JSON.stringify(args.operationId)}.`,
    );
  }
  if (typeof args.async === "string") {
    throw new Error(
      `'async' must be a boolean, not the string ${JSON.stringify(args.async)}.`,
    );
  }
  if (!Array.isArray(args.tasks)) return;
  args.tasks.forEach((task, index) => {
    if (!isRecord(task)) return;
    const where = `tasks[${index}]`;
    // normalizeTask has already repaired JSON-array strings and bare tokens;
    // a surviving string is ambiguous by construction.
    if (typeof task.tools === "string") {
      throw new Error(
        `${where}: 'tools' must be an array of tool names — a JSON array string or one bare name also works — not the ambiguous string ${JSON.stringify(task.tools)}.`,
      );
    }
    if (typeof task.deadlineMs === "string") {
      throw new Error(
        `${where}: 'deadlineMs' must be a positive number, not the string ${JSON.stringify(task.deadlineMs)}.`,
      );
    }
  });
}

/**
 * `delegate` argument normalization, before schema validation: nulls mean
 * "not given", blanks mean "not given" for optional identifiers, fields
 * owned by the sibling tools reject with migration guidance (selector
 * fields first), then the authorized repairs — stringified tasks, flat
 * task fields, string tools, blank agent — run. An absent `tasks` becomes
 * `[]`, so `{}` still returns the manual.
 */
function prepareDispatchArguments(value: unknown): DelegateArguments {
  if (!isRecord(value)) return value as DelegateArguments;

  const args = { ...value };
  // Presence of `context` rejects even when null — before null stripping.
  rejectObsoleteContext(args);
  stripNulls(args);
  stripBlank(args, ["operationId", "sessionId", "cwd", "resumeFrom", "agent"]);

  // Fields the pre-split tool owned: guidance with an example to the right
  // tool beats a bare additionalProperties failure.
  if (
    args.ticketAction !== undefined ||
    args.ticket !== undefined ||
    args.force !== undefined ||
    args.taskId !== undefined ||
    args.questionId !== undefined ||
    args.answer !== undefined
  ) {
    throw new Error(
      `Ticket operations moved to delegate_ticket: ${delegateTicketExample(args)}.`,
    );
  }
  if (args.sessionAction !== undefined) {
    throw new Error(
      `Session operations moved to delegate_session: ${delegateSessionExample(args)}.`,
    );
  }
  if (args.timeoutMs !== undefined) {
    throw new Error(
      `A delegate run waits for every task and cannot be bounded with timeoutMs. ` +
        `Dispatch with async: true, then bound the wait on its ticket: ` +
        `delegate_ticket({ action: "wait", ticket: "<ticket>", timeoutMs: ${JSON.stringify(args.timeoutMs)} }).`,
    );
  }
  if (args.action !== undefined) {
    throw new Error(
      `delegate takes no "action" field. Ticket operations use delegate_ticket({ action: "poll", ... }); ` +
        `session operations use delegate_session({ action: "list" }).`,
    );
  }
  // `model` and `thinking` are invalid wherever a caller puts them — inside
  // a task, folded into one, or stranded at the top level beside an explicit
  // tasks array. Reject them like `context`, before the fold can absorb
  // them.
  if (args.model !== undefined) {
    throw new Error(MODEL_FIELD_REJECTION);
  }
  if (args.thinking !== undefined) {
    throw new Error(THINKING_FIELD_REJECTION);
  }
  if (typeof args.tasks === "string") {
    const parsed = parseArray(args.tasks);
    if (parsed) args.tasks = parsed;
  }

  const hasTasks = Array.isArray(args.tasks) && args.tasks.length > 0;
  if (!hasTasks) {
    const task: Record<string, unknown> = {};
    for (const field of taskFieldNames) {
      if (args[field] !== undefined) {
        task[field] = args[field];
        delete args[field];
      }
    }
    if (Object.keys(task).length > 0) args.tasks = [task];
  } else {
    // Flat fields cannot merge into an explicit batch (SPEC: folding only
    // applies without a task array) — a stray task field beside one is a
    // caller mistake, so name it rather than surfacing a bare
    // additionalProperties error. `workspace` is excluded: it is also a
    // legal top-level batch default.
    const stray = taskFieldNames.filter(
      (field) => field !== "workspace" && args[field] !== undefined,
    );
    if (stray.length > 0) {
      throw new Error(
        `cannot mix top-level task field(s) ${stray
          .map((field) => `'${field}'`)
          .join(", ")} with an explicit tasks array; move them into a task entry or remove tasks.`,
      );
    }
  }
  if (args.tasks === undefined) args.tasks = [];

  if (Array.isArray(args.tasks)) {
    args.tasks = args.tasks.map(normalizeTask);
  }

  rejectAmbiguousShapes(args);

  return args as DelegateArguments;
}

/**
 * `delegate_ticket` normalization: nulls and blanks as above, then
 * pre-split field names and dispatch/session fields get guidance to the
 * right tool, then the string-coercion guards.
 */
function prepareTicketArguments(value: unknown): TicketToolArguments {
  if (!isRecord(value)) return value as TicketToolArguments;

  const args = { ...value };
  stripNulls(args);
  // Blank `answer` survives: only validation may tell a present-but-empty
  // reply from a missing one — a non-answer action must still reject it.
  stripBlank(args, ["ticket", "taskId", "questionId"]);

  if (args.ticketAction !== undefined) {
    throw new Error(
      `The ticket action field is "action", not "ticketAction": ${delegateTicketExample(args)}.`,
    );
  }
  if (args.sessionAction !== undefined || args.sessionId !== undefined) {
    throw new Error(
      `Session operations live on delegate_session, not delegate_ticket: ${delegateSessionExample(args)}.`,
    );
  }
  for (const key of dispatchFieldNames) {
    if (args[key] !== undefined) {
      throw new Error(
        `'${key}' is a delegate dispatch field; task dispatch lives on delegate, not delegate_ticket: ${delegateDispatchExample(args)}.`,
      );
    }
  }
  // A correct-shaped call aimed at the wrong tool routes there instead of
  // hitting a bare enum error on `action`.
  if (
    typeof args.action === "string" &&
    SESSION_ACTIONS.includes(args.action)
  ) {
    throw new Error(
      `"${args.action}" is a delegate_session action, not a delegate_ticket one: ${delegateSessionExample(args)}.`,
    );
  }
  if (args.model !== undefined) {
    throw new Error(MODEL_FIELD_REJECTION);
  }
  if (args.thinking !== undefined) {
    throw new Error(THINKING_FIELD_REJECTION);
  }
  if (typeof args.force === "string") {
    throw new Error(
      `'force' must be a boolean, not the string ${JSON.stringify(args.force)}.`,
    );
  }
  if (typeof args.timeoutMs === "string") {
    throw new Error(
      `'timeoutMs' must be a number, not the string ${JSON.stringify(args.timeoutMs)}.`,
    );
  }

  return args as TicketToolArguments;
}

/**
 * `delegate_session` normalization: nulls and blanks as above, then
 * pre-split field names and dispatch/ticket fields get guidance to the
 * right tool.
 */
function prepareSessionArguments(value: unknown): SessionToolArguments {
  if (!isRecord(value)) return value as SessionToolArguments;

  const args = { ...value };
  stripNulls(args);
  stripBlank(args, ["sessionId"]);

  if (args.sessionAction !== undefined) {
    throw new Error(
      `The session action field is "action", not "sessionAction": ${delegateSessionExample(args)}.`,
    );
  }
  for (const key of ticketFieldNames) {
    if (args[key] !== undefined) {
      throw new Error(
        `Ticket operations live on delegate_ticket, not delegate_session: ${delegateTicketExample(args)}.`,
      );
    }
  }
  for (const key of dispatchFieldNames) {
    if (args[key] !== undefined) {
      throw new Error(
        `'${key}' is a delegate dispatch field; task dispatch lives on delegate, not delegate_session: ${delegateDispatchExample(args)}.`,
      );
    }
  }
  // A correct-shaped call aimed at the wrong tool routes there instead of
  // hitting a bare enum error on `action`.
  if (
    typeof args.action === "string" &&
    TICKET_ACTIONS.includes(args.action)
  ) {
    throw new Error(
      `"${args.action}" is a delegate_ticket action, not a delegate_session one: ${delegateTicketExample(args)}.`,
    );
  }
  if (args.model !== undefined) {
    throw new Error(MODEL_FIELD_REJECTION);
  }
  if (args.thinking !== undefined) {
    throw new Error(THINKING_FIELD_REJECTION);
  }

  return args as SessionToolArguments;
}

const help = `# Delegate Manual

Three sibling tools share Delegate's machinery:
- \`delegate\` dispatches subagent tasks, synchronously or on an async ticket.
- \`delegate_ticket\` operates on async tickets: poll, wait, cancel, pause,
  resume, answer.
- \`delegate_session\` lists and closes pooled subagent sessions.

## delegate — dispatch
- \`tasks\` (required): a non-empty array dispatches work; \`[]\` shows this
  manual. Sync calls wait for every task and return results in input order;
  \`async: true\` returns a ticket immediately — the settled result is
  delivered automatically, so do not poll in a loop.
- Task fields: \`prompt\` (required unless \`resumeFrom\`), \`id\` (correlation
  key), \`agent\` (\`default\`/\`scout\`/\`coder\`/\`reviewer\`; omit for
  inline), \`cwd\`, \`systemPrompt\`, \`tools\` (\`*\` writer group, \`ro\`
  read-only group, or tool names), \`deadlineMs\` (ms),
  \`sessionId\`, \`resumeFrom\`, \`workspace\` (shared/scratch/isolated),
  \`dependsOn\` (task ids to run first).
  A top-level \`workspace\` is the batch default.
- \`dependsOn\` orders tasks in one batch: name earlier task ids (an
  explicit \`id\`, or the generated \`task-1\`, \`task-2\`, ...). A task
  starts only after every prerequisite finished successfully — applied
  isolated work included — and its prompt carries each prerequisite's
  bounded output. A prerequisite that failed, was cancelled, or left its
  isolated proposal unapplied blocks the dependent with a visible reason;
  unrelated branches still run.
- \`operationId\` (1-64 letters/digits/./_/-) makes a dispatch duplicate-safe:
  same id + same request returns the original in-flight or settled result;
  same id + a changed request is an error. Dispatch-only.
- Models and effort: you never pick either — task \`model\` and \`thinking\`
  fields are rejected. Tasks run on the parent's model at the parent's
  effort; a named agent may instead run on the model (and optional
  \`:effort\`) the user configured for it under "models"/"modelsByParent" in
  the user-global delegate.json, or the \`model\`/\`thinking\` frontmatter
  of its Markdown profile.
- Profiles: the four built-ins plus user-defined Markdown agents —
  \`.pi/agents/*.md\` in the nearest project ancestor, then \`agents/*.md\`
  under the user-global agent directory. A profile needs \`name\` and
  \`description\`; \`tools\`, \`thinking\`, and \`model\` are optional
  frontmatter, the body is its system prompt.
- Children never inherit parent conversation history. Supply a self-contained
  brief; project instructions and child-owned pooled/resumed history still apply.

## Workspaces
- \`shared\` (default): the task edits the caller's tree directly. Writers
  whose scope overlaps in one call run one at a time, in task order — each
  sees its predecessor's changes. Use it for dependent edits.
- \`isolated\`: each task works in a detached Git worktree; successful
  changes merge into the source in task order. Independent edits to the
  same repository run in parallel — much faster than shared for
  independent work. Cannot use \`sessionId\` or \`resumeFrom\`.
- \`scratch\`: one task, one disposable copy of the tree (reflinked when
  the filesystem supports it); every change is discarded. Use it for
  tasks that may write or run commands but whose output is the answer,
  not the edits. A read-only task cannot use it — it needs no copy.
  Cannot use \`sessionId\` or \`resumeFrom\`.

## delegate_ticket — tickets
- \`{ action: "poll" }\` — the ticket roster, or one ticket's status with
  \`ticket\`. Never blocks.
- \`{ action: "wait", ticket }\` — block until the ticket settles;
  \`timeoutMs\` (ms) detaches only the waiter, the work continues.
- \`{ action: "cancel", ticket }\` — previews without \`force\`; with
  \`force: true\` the ticket is cancelled now and in-flight tasks are asked
  to stop (cooperative; no rollback).
- \`{ action: "pause" | "resume", ticket }\` — hold and release queued work;
  a paused ticket stays live and keeps its reservations.
- \`{ action: "answer", ticket, taskId, questionId, answer }\` — answer a
  worker's pending \`ask_parent\` question (all four fields required).
  Poll to see outstanding questions. Only async workers can ask.

## delegate_session — sessions
- A task with \`sessionId\` keeps its session live after it finishes; a later
  task with the same id continues that conversation. The session's cwd,
  tools, thinking, model, and base prompt are frozen at first use —
  incompatible reuse is rejected.
- \`{ action: "list" }\` lists live sessions; \`{ action: "close", sessionId }\`
  closes one.

## Telemetry
- Disabled by default; enable only via "telemetry" in delegate.json.
- Local content-free metadata only: batch and task outcome records in a
  SQLite database at telemetry.dbPath, DELEGATE_TELEMETRY_DB, or
  <agentDir>/delegate-usage.db. Failures never block work.
`;

/**
 * A manual trailer listing the user's discovered Markdown profiles, or ""
 * when there are none. Re-discovered per help call so edits show up without
 * a reload.
 */
function customProfileSection(ctx: ExtensionContext): string {
  const catalog = discoverProfiles(ctx.cwd, resolveAgentDir(ctx).dir);
  const custom = [...catalog.profiles.values()].filter(
    (profile) => profile.source !== undefined,
  );
  if (custom.length === 0) return "";
  const lines = custom.map(
    (profile) => `- \`${profile.name}\` — ${profile.description ?? ""}`,
  );
  return `\n## Your agent profiles\n${lines.join("\n")}\n`;
}

export default function delegateExtension(api: ExtensionAPI): void {
  // TicketStore mutates first, visibility reads lazily — the observer arrow
  // only runs on the first mutation, long after both exist.
  const questionContexts = new Map<string, ExtensionContext>();
  const tickets = new TicketStore(() => {
    visibility.sync();
    for (const id of questionContexts.keys()) {
      if (tickets.get(id)?.status !== "running") questionContexts.delete(id);
    }
  }, (ticket, question) => {
    const ctx = questionContexts.get(ticket.id);
    if (ctx === undefined || shuttingDown) return;
    const message = {
      customType: "delegate-question",
      content: `Worker ${question.taskId} on ticket ${ticket.id} asks: ${question.question}\nAnswer with delegate_ticket({ action: "answer", ticket: "${ticket.id}", taskId: "${question.taskId}", questionId: "${question.id}", answer: "..." }). Do not wait on this ticket while it needs your answer.`,
      display: true,
      details: { ticket: ticket.id, taskId: question.taskId, questionId: question.id },
    };
    try {
      const sameLeaf =
        navigationEpoch === ticket.originEpoch &&
        (ticket.originLeafId === null ||
          ctx.sessionManager.getBranch().some((entry) => entry.id === ticket.originLeafId));
      if (sameLeaf) api.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
      else {
        api.sendMessage(message, { triggerTurn: false });
        ctx.ui.notify(`Worker ${question.taskId} asks a question on ticket ${ticket.id}; poll and answer it with delegate_ticket on this branch.`, "info");
      }
    } catch (error) {
      console.error(`[delegate] notifying question ${ticket.id}/${question.id} failed (poll it with delegate_ticket): ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const visibility = new VisibilitySignals(() => tickets.list());
  const admission = new AdmissionController();
  const sessions = new SessionPool();
  const activity = createActivityStore();
  const coordinator = new DispatchCoordinator(tickets, activity);
  const telemetry = new TelemetryStore();
  const operations = new OperationStore<DelegateResult>();
  let callSeq = 0;
  // Owned by this closure: one fallback warning per extension instance, not
  // per call (see resolveAgentDir for why the fallback exists at all).
  let warnedAgentDirFallback = false;
  // Shutdown latch: once the host begins teardown, new dispatches reject and
  // pending results are never delivered.
  let shuttingDown = false;
  // Bumped on every observed tree transition — including a vetoed or
  // cancelled navigation attempt, which conservatively downgrades delivery.
  let navigationEpoch = 0;
  // One "fully quiesced" barrier per live dispatch; shutdown holds until
  // every one resolves (INVARIANTS "Ticket state"). The value is the
  // human-facing name for the shutdown waiting status (COMPATIBILITY
  // "Blocking shutdown" names the tickets): the ticket id for a background
  // batch, the call number for a synchronous dispatch, and a "(preparing)"
  // label in the window before either exists.
  const liveQuiescence = new Map<Promise<void>, string>();

  const trackQuiescence = (
    label: string,
  ): { barrier: Deferred; relabel: (label: string) => void } => {
    const barrier = new Deferred();
    liveQuiescence.set(barrier.promise, label);
    void barrier.promise.then(() => {
      liveQuiescence.delete(barrier.promise);
    });
    return {
      barrier,
      relabel: (next: string) => {
        // A resolved barrier is already untracked; relabeling must not
        // resurrect its entry.
        if (liveQuiescence.has(barrier.promise)) {
          liveQuiescence.set(barrier.promise, next);
        }
      },
    };
  };

  /**
   * The one dispatch pipeline, from barrier tracking to the coordinator
   * handoff, for sync and async batches alike — the optional ticket is the
   * only mode input, and the batch runs on `signal ?? the ticket's
   * cancellation signal` (reached through the store). Mode-specific edges
   * stay with the caller: ticket creation (via `createTicket`, invoked at
   * the one seam between task validation and admission), origin capture,
   * delivery arming, and response formatting all live outside.
   *
   * Barrier ownership (INVARIANTS "Ticket state"): the pipeline owns the
   * barrier's resolve until the coordinator accepts the batch; the
   * coordinator afterwards. The transfer is exhaustive by construction —
   * there is no flag and no second resolution site. The `try` block below
   * ends at the `coordinator.run(...)` invocation: `run` accepts the
   * barrier synchronously before its first await (see DispatchCoordinator),
   * and its rejections are composed into the returned completion instead
   * of re-entering this function's catch. So the catch is provably
   * pre-handoff: `barrier.resolve()` there is only ever reachable while
   * the pipeline still owns the barrier, and after the handoff the
   * coordinator resolves on every path it owns.
   */
  const runDispatchPipeline = async (options: {
    readonly requestedTasks: readonly TaskInput[];
    readonly ctx: ExtensionContext;
    /** The sync caller's host signal; async batches run on the ticket's. */
    readonly signal?: AbortSignal;
    readonly onNotices?: (notices: readonly string[]) => void;
    /**
     * Async mode's edge: creates the ticket once tasks are resolved, so
     * the pipeline spends the rest of the batch under its cancellation
     * signal; the pipeline relabels nothing for it.
     */
    readonly createTicket?: (
      tasks: readonly ResolvedTask[],
      relabel: (label: string) => void,
      config: DelegateConfig,
    ) => Ticket;
  }): Promise<{
    completion: Promise<DispatchOutcome>;
    notices: readonly string[];
    ticket: Ticket | undefined;
    /** Resolved tasks, for settled-render spill labels on the sync path. */
    tasks: readonly ResolvedTask[];
    /** The loaded config's output bounds, for the sync result render. */
    outputBounds: OutputBounds;
  }> => {
    const { requestedTasks, ctx, signal, onNotices, createTicket } = options;
    // The barrier is tracked before anything between here and the handoff
    // can throw or yield: task resolution probes Git for each writer or
    // isolated task's write scope, admission grants reservations, and
    // workspace preparation awaits subprocesses. A shutdown that starts
    // while this dispatch sits anywhere in that range must already count
    // it in the liveQuiescence snapshot, or the session boundary could
    // complete before the dispatch starts workers or releases its
    // reservations.
    const { barrier, relabel } = trackQuiescence(
      createTicket !== undefined
        ? "async dispatch (preparing)"
        : "dispatch (preparing)",
    );
    let ticket: Ticket | undefined;
    let plan: WorkspacePlan | undefined;
    // Everything the failure routine below may still need once admission
    // has run. Admission is synchronous and immediately follows ticket
    // creation, so a ticket that exists at all always has its batch here:
    // a ticket can only be cancelled while this pipeline is parked in an
    // await, and there is none between creation and admission.
    let batch:
      | {
          readonly tasks: readonly ResolvedTask[];
          readonly env: HostEnvironment;
          readonly config: DelegateConfig;
          readonly grant: AdmissionGrant;
          readonly dispatchSignal: AbortSignal | undefined;
          readonly notices: readonly string[];
        }
      | undefined;
    try {
      const agentDirResolution = resolveAgentDir(ctx);
      if (agentDirResolution.source === "cwd" && !warnedAgentDirFallback) {
        warnedAgentDirFallback = true;
        console.warn(
          `[delegate] Falling back to '${agentDirResolution.dir}' as the agent directory: delegate.json will be read from there, and delegate-sessions/, delegate-scratch/, delegate-isolated/ may be created under it. Set DELEGATE_AGENT_DIR to choose an agent directory explicitly. This warning appears once.`,
        );
      }
      const env = hostEnvironment(
        ctx,
        agentDirResolution.dir,
        () => api.getActiveTools(),
      );
      const catalog = discoverProfiles(ctx.cwd, agentDirResolution.dir);
      const config = loadDelegateConfig(
        agentDirResolution.dir,
        catalog.globalNames,
      );
      const tasks = await resolveTasks(requestedTasks, env, config, catalog);
      sessions.validateReuse(tasks);
      ticket = createTicket?.(tasks, relabel, config);
      let owner = ticket?.id;
      if (owner === undefined) {
        callSeq += 1;
        owner = `call-${callSeq}`;
        relabel(owner);
      }
      const dispatchSignal = signal ??
        (ticket ? tickets.cancellationSignal(ticket) : undefined);
      const grant = admission.admit(tasks, owner);
      const notices = serializedNotices(tasks, grant.serialized);
      if (ticket) tickets.setNotices(ticket, notices);
      batch = { tasks, env, config, grant, dispatchSignal, notices };
      onNotices?.(notices);
      const telemetrySpan = telemetry.beginDispatch(
        config.telemetry,
        env.agentDir,
        { async: ticket !== undefined, startedAt: Date.now(), tasks },
      );
      plan = await prepareWorkspaces(
        tasks,
        env.agentDir,
        dispatchSignal,
        telemetrySpan.ownedPaths,
      );
      // The handoff. This invocation is the try block's last statement and
      // the completion it yields is composed and returned, never awaited
      // here — the ownership comment above spells out why that makes the
      // catch below provably pre-handoff.
      const completion = coordinator
        .run(tasks, {
          env,
          config,
          grant,
          sessions,
          signal: dispatchSignal,
          ticket,
          quiescence: barrier,
          preparePhase: (phase) => plan!.preparePhase(phase),
          reconcilePhase: (phase, outcomes) =>
            // The dispatch facts the batch actually holds: plans consume
            // what applies to them (only isolated reconciliation reads
            // this context).
            plan!.reconcilePhase(phase, outcomes, {
              signal: dispatchSignal,
              shouldApplySource: () => !dispatchSignal?.aborted,
              retainedReason: ticket
                ? "The ticket was cancelled before source application."
                : "The call was aborted before source application.",
            }),
          onWorkerQuiesced: (taskIndex) => plan!.cleanupWorker(taskIndex),
        })
        .then((outcome) => {
          telemetrySpan.finish(outcome, ticket?.status);
          return outcome;
        })
        .finally(() => {
          if (ticket) tickets.releaseSettlement(ticket);
        });
      return {
        completion,
        notices,
        ticket,
        tasks,
        outputBounds: config.output,
      };
    } catch (error) {
      // The one pre-handoff failure routine — the pipeline still owns the
      // barrier here. A disposal failure must never erase the root cause:
      // log it and keep the original as the thrown error.
      try {
        await plan?.dispose();
      } catch (cleanupError) {
        console.error(
          `[delegate] workspace disposal after preparation failure failed (root cause preserved): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          cleanupError,
        );
      }
      if (
        ticket !== undefined &&
        ticket.status !== "running" &&
        batch !== undefined
      ) {
        const cancelledTicket = ticket;
        // Preparation raced a cancellation (shutdown or a force-cancel
        // aborting the workspace copy/worktree): the ticket is already
        // terminal cancelled and the caller still gets its id. End the
        // batch through the coordinator's own settle path — the one
        // batch-end implementation, not a hand-rolled copy: under the
        // already-aborted signal `run` records a cancelled outcome for
        // every task, and its finally releases the grant, finishes the
        // gates, and resolves the barrier through the same full-quiescence
        // wiring as any batch. Telemetry records nothing — the span above
        // is never finished for a failed preparation (SPEC.md
        // "Telemetry": failed preparation records nothing).
        console.error(
          `[delegate] async dispatch preparation for ticket ${cancelledTicket.id} aborted after cancellation; settling as cancelled: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          notices: batch.notices,
          ticket: cancelledTicket,
          tasks: batch.tasks,
          outputBounds: batch.config.output,
          completion: coordinator
            .run(batch.tasks, {
              env: batch.env,
              config: batch.config,
              grant: batch.grant,
              sessions,
              signal: batch.dispatchSignal,
              ticket: cancelledTicket,
              quiescence: barrier,
            })
            .finally(() => tickets.releaseSettlement(cancelledTicket)),
        };
      }
      if (ticket !== undefined) {
        // A ticket whose batch never started is removed rather than
        // exposed: the whole call fails with the cause instead.
        tickets.remove(ticket.id);
      }
      batch?.grant.release();
      barrier.resolve();
      throw error;
    }
  };

  // Tree navigation is user-driven and not a session replacement: the
  // runtime and the tickets survive it. The epoch bumps unconditionally —
  // delivery holds results non-waking after any observed transition,
  // "cancelled or not" (see the sameLeaf check at delivery) — and only
  // then does the consent guard ask (issue #24): cancel force-cancels
  // every live ticket and proceeds (the store's onChange observer
  // re-syncs the footer), or stay blocks the transition. Headless hosts
  // and throwing dialogs fail open.
  api.on("session_before_tree", (_event, ctx) => {
    navigationEpoch += 1;
    return visibility.guardTreeNavigation(ctx, () => {
      for (const ticket of tickets.list()) {
        if (ticket.status === "running") tickets.cancel(ticket, true);
      }
    });
  });
  api.on("session_tree", () => {
    navigationEpoch += 1;
  });

  // ── Operator-visibility signals (issue #24) ─────────────────────────────
  // The turn settling with live tickets is the "looks idle but isn't"
  // moment: warn once per ticket; the footer carries it from there.
  api.on("agent_settled", (_event, ctx) => {
    visibility.onSettled(ctx);
  });
  // Session replacements are cancellable — consent before killing live work.
  api.on("session_before_switch", (event, ctx) =>
    visibility.guardReplacement(
      ctx,
      event.reason === "new" ? "Switching sessions" : "Resuming another session",
    ),
  );
  api.on("session_before_fork", (_event, ctx) =>
    visibility.guardReplacement(ctx, "Forking this session"),
  );

  // Delivered results follow the same expanded-view contract as tool
  // results (SPEC "Recovery"): collapsed keeps the host's default
  // custom-message chrome; expanded renders the complete recorded outcomes.
  api.registerMessageRenderer(
    DELIVERED_MESSAGE_TYPE,
    createMessageRenderer(tickets),
  );

  // The live subagent browser: /subagents or Ctrl+Shift+B (TUI only).
  registerSubagentBrowser(api, {
    store: activity,
    controls: {
      pauseTicket: (id) => {
        const ticket = tickets.get(id);
        if (ticket !== undefined) tickets.pause(ticket);
      },
      resumeTicket: (id) => {
        const ticket = tickets.get(id);
        if (ticket !== undefined) tickets.resume(ticket);
      },
      ticketPaused: (id) => {
        const ticket = tickets.get(id);
        return ticket !== undefined && ticket.status === "running" && ticket.paused;
      },
    },
  });

  api.on("session_shutdown", async (event, ctx) => {
    shuttingDown = true;
    // v1's quit/reload traces: name the live work being killed before the
    // force-cancel makes it invisible (quit → stderr; reload → notify).
    visibility.shutdownTrace(
      event.reason,
      ctx,
      tickets.list().filter((ticket) => ticket.status === "running"),
    );
    // Forced cancellation settles every ticket immediately and resolves its
    // waiters; delivery is suppressed by the latch above. Checked-out pooled
    // sessions must get their abort requests before the quiescence wait —
    // their runs own disposal through settle, and the barrier below is what
    // confirms they actually stopped (a worker that ignores the abort holds
    // shutdown for as long as it runs, per COMPATIBILITY.md).
    for (const ticket of tickets.list()) tickets.cancel(ticket, true);
    sessions.shutdown();
    const pending = [...liveQuiescence];
    if (pending.length > 0) {
      // The visible status names what is being waited on, so a worker that
      // ignores its abort is identifiable (its ticket id, or the sync call
      // label) without guessing from a bare count.
      const names = pending.map(([, label]) => label).join(", ");
      try {
        ctx.ui.notify(
          `Delegate: waiting for ${pending.length} dispatch(es) to stop before shutdown (${names})…`,
          "info",
        );
      } catch {
        // The UI may already be gone; the log line below still reports it.
      }
      console.error(
        `[delegate] shutdown waiting for ${pending.length} dispatch(es) to reach quiescence (${names})`,
      );
      await Promise.all(pending.map(([promise]) => promise));
    }
    telemetry.close();
  });

  api.registerTool(
    defineTool<typeof delegateSchema, DelegateDetails>({
      name: "delegate",
      label: "Delegate to Subagents",
      description:
        "Run subagent tasks. Sync returns results in input order; async: true returns a ticket (inspect or control it with delegate_ticket) and delivers the settled result automatically; tasks: [] shows the manual; pooled sessions are managed with delegate_session. Same-repo writers serialize under 'shared'; 'isolated' runs independent edits in parallel; 'scratch' discards a disposable copy's changes.",
      parameters: delegateSchema,
      promptSnippet:
        "Run subagent tasks: synchronous, or async tickets whose results arrive automatically",
      promptGuidelines: [
        "Subagents never see this conversation — give each delegate task a self-contained brief.",
        "Async delegate results arrive automatically — do not poll in a loop; only wait on a ticket when the next step needs its result.",
        'Use workspace "isolated" for independent edits in the same repo.',
        "Split very large task batches across delegate calls; overlong tool calls get truncated.",
      ],
      prepareArguments: prepareDispatchArguments,
      // The stock renderer only displays `content` — which is the
      // spill-bounded projection — so expansion never showed the whole
      // output. This renderer keeps the collapsed preview but renders the
      // complete recorded outcomes from details when expanded.
      renderResult: createResultRenderer(tickets),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const call = validateDispatchCall(params);
        // Every tool call re-arms the footer context (v1 semantics: the
        // execute context carries the full UI surface for our lifetime).
        visibility.captureFooterCtx(ctx);
        if (call.mode === "help") {
          return {
            content: [
              {
                type: "text" as const,
                text: help + customProfileSection(ctx),
              },
            ],
            details: { mode: "help" as const },
          };
        }
        // Only async dispatch needs the saved journal, and ticket creation
        // must be durable before workers spawn; a corrupt or inaccessible
        // journal must not block synchronous work.
        if (call.async) {
          tickets.connect(resolveAgentDir(ctx).dir);
        }

        let operationTicket: Ticket | undefined;
        const executeDispatch = async () => {
          if (shuttingDown) {
            throw new Error(
              "Delegate is shutting down with this session; new dispatches are not accepted. " +
                "Existing tickets remain pollable for the rest of the session's lifetime.",
            );
          }

          // Async edge — background delivery. Armed once the pipeline has
          // handed the batch to the coordinator; it waits for caller
          // settlement AND the finished gate, so the delivered view always
          // carries the safe-to-expose outcome: finalized isolated
          // integrations, retained errors, and (on cancellation) partial
          // results rather than a bare status.
          const deliver = (ticket: Ticket): void => {
            if (shuttingDown) {
              console.error(
                `[delegate] delivery for ticket ${ticket.id} suppressed during shutdown (result remains pollable)`,
              );
              return;
            }
            const cancelled = ticket.status === "cancelled";
            const message = {
              customType: DELIVERED_MESSAGE_TYPE,
              content:
                tickets.view(ticket) +
                (cancelled
                  ? "\nCancellation is cooperative; worker cleanup may still be pending."
                  : ""),
              display: true,
              details: {
                ticket: ticket.id,
                originLeafId: ticket.originLeafId,
                // Complete outcomes — delivery text is spill-bounded.
                results: ticket.outcomes,
                ...(ticket.notices.length > 0
                  ? { notices: ticket.notices }
                  : {}),
              },
            };
            // api.sendMessage is fire-and-forget on the stock
            // ExtensionAPI (returns void): async send rejections surface
            // through the host's extension-error channel, never here.
            // Only synchronous throws — e.g. a torn-down runtime failing
            // assertActive — reach the catch below. Either way,
            // settlement stands and the result stays pollable.
            try {
              // "Same leaf" means same branch: the parent's own turn
              // appends entries after dispatch, so the current leaf is a
              // descendant of the origin leaf — the origin must still lie
              // on the current branch (a null origin is the root, which
              // every branch descends from). The epoch separately rules
              // out any observed transition, cancelled or not. Both are
              // read from the ticket, which captured them at creation.
              const sameLeaf =
                navigationEpoch === ticket.originEpoch &&
                (ticket.originLeafId === null ||
                  ctx.sessionManager
                    .getBranch()
                    .some((entry) => entry.id === ticket.originLeafId));
              if (sameLeaf) {
                // Same leaf, no transition observed: a follow-up wakes an
                // idle parent and queues behind a busy one's tool calls.
                api.sendMessage(message, {
                  deliverAs: "followUp",
                  triggerTurn: true,
                });
              } else {
                // Leaf moved or a transition is in flight: append durably
                // at the current leaf without triggering a turn — it
                // enters model context on the next user turn.
                api.sendMessage(message, { triggerTurn: false });
                try {
                  ctx.ui.notify(
                    `Delegate ticket "${ticket.id}" settled on a different branch; its result was appended to the current branch for the next turn.`,
                    "info",
                  );
                } catch {
                  // The UI may already be gone; the append itself landed.
                }
              }
            } catch (error) {
              // Delivery failure never undoes settlement: the ticket stays
              // terminal and pollable.
              console.error(
                `[delegate] delivering ticket ${ticket.id} failed (result remains pollable): ${error instanceof Error ? error.message : String(error)}`,
              );
              try {
                ctx.ui.notify(
                  `Delegate ticket "${ticket.id}" settled but its result could not be delivered; poll it for the result.`,
                  "error",
                );
              } catch {
                // A stale ctx cannot show the notice; the log line stands.
              }
            }
          };
          const armDelivery = (ticket: Ticket): void => {
            void Promise.all([
              tickets.settledPromise(ticket),
              tickets.finishedPromise(ticket),
            ])
              .then(() => deliver(ticket))
              .catch((error: unknown) => {
                console.error(
                  `[delegate] delivering ticket ${ticket.id} crashed (result remains pollable): ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          };

          const { completion, ticket, notices, tasks, outputBounds } =
            await runDispatchPipeline({
            requestedTasks: call.tasks,
            ctx,
            // One signal source in the pipeline: the caller's host signal
            // for a sync batch, the ticket's cancellation for an async one.
            signal: call.async ? undefined : signal,
            // Surface same-call serialization immediately — a serialized
            // batch of independent writers is the expensive way to learn
            // about "isolated". Async batches carry the notices on the
            // ticket (and its created text) instead.
            onNotices:
              call.async === false
                ? (current) => {
                    if (current.length > 0) {
                      onUpdate?.({
                        content: [
                          { type: "text" as const, text: current.join("\n") },
                        ],
                        details: {},
                      });
                    }
                  }
                : undefined,
            createTicket:
              call.async === false
                ? undefined
                : (tasks, relabel, config) => {
                    const created = tickets.create(tasks, {
                      holdSettlement: workspaceNeedsSettlementHold(tasks),
                      outputBounds: config.output,
                    });
                    operationTicket = created;
                    questionContexts.set(created.id, ctx);
                    // The barrier now has its durable name for the
                    // shutdown status.
                    relabel(`ticket "${created.id}"`);
                    // The session-tree position at dispatch: delivery may
                    // wake the parent only while it is still on this
                    // branch with no tree transition or shutdown observed
                    // since. Recorded on the ticket so delivery
                    // diagnostics can be reconstructed from the ticket
                    // alone.
                    tickets.recordOrigin(created, {
                      leafId: ctx.sessionManager.getLeafId(),
                      epoch: navigationEpoch,
                    });
                    return created;
                  },
          });

          if (ticket !== undefined) {
            void completion
              .then(() => undefined)
              .catch((error: unknown) => {
                // The coordinator's task-quiescence chain owns the barrier
                // and resolves it on this same rejection path; here the
                // ticket just settles failed and the crash is reported.
                tickets.settle(ticket, "failed");
                console.error(
                  `[delegate] background ticket ${ticket.id} crashed: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
            armDelivery(ticket);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Ticket "${ticket.id}" created: ${ticket.totalTasks} task(s) running in the background.\n` +
                    `Results will be delivered automatically when the batch settles; keep working. ` +
                    `delegate_ticket can wait on or cancel it if needed (action "wait" / "cancel").` +
                    (ticket.notices.length > 0
                      ? `\n${ticket.notices.join("\n")}`
                      : ""),
                },
              ],
              details: {
                mode: "dispatch" as const,
                async: true,
                ticket: ticket.id,
                tasks: ticket.tasks.map((task) => task.id),
              },
            };
          }

          const result = await completion;
          // SPEC: error-valued only when every task failed or was blocked —
          // cancelled and partially failed batches are normal results
          // carrying each task's own status, mirroring a ticket's `partial`
          // settlement.
          const allFailed = result.outcomes.every(
            (outcome) =>
              outcome.status === "failed" || outcome.status === "blocked",
          );
          return {
            content: [
              {
                type: "text" as const,
                text:
                  (notices.length > 0 ? `${notices.join("\n")}\n\n` : "") +
                  formatDispatchResult(result.outcomes, tasks, outputBounds),
              },
            ],
            details: {
              mode: "dispatch" as const,
              async: false,
              tasks: result.outcomes.map((outcome) => ({
                id: outcome.id,
                status: outcome.status,
              })),
              // The rendered content is spill-bounded; details keep the
              // complete outcomes for the expanded view and recovery.
              results: result.outcomes,
              ...(notices.length > 0 ? { notices } : {}),
            },
            usage: result.usage,
            isError: allFailed,
          };
        };

        if (call.operationId === undefined) return executeDispatch();
        return operations.run(
          call.operationId,
          dispatchFingerprint({ async: call.async, tasks: call.tasks }),
          executeDispatch,
          () =>
            operationTicket
              ? tickets.finishedPromise(operationTicket)
              : Promise.resolve(),
        );
      },
    }),
  );

  api.registerTool(
    defineTool<typeof ticketSchema, DelegateDetails>({
      name: "delegate_ticket",
      label: "Delegate Tickets",
      description:
        "Operate on a delegate async ticket: poll (the roster, or one ticket), wait for settlement, cancel, pause, resume, or answer a worker question. Dispatch new work with delegate; manage pooled sessions with delegate_session.",
      parameters: ticketSchema,
      promptSnippet:
        "Poll, wait on, cancel, pause/resume, or answer questions for async delegate tickets",
      prepareArguments: prepareTicketArguments,
      renderResult: createResultRenderer(tickets),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const call = validateTicketCall(params);
        visibility.captureFooterCtx(ctx);
        // Ticket RPCs need the saved journal; a corrupt or inaccessible one
        // fails this call visibly but does not affect dispatch or sessions.
        tickets.connect(resolveAgentDir(ctx).dir);
        const result = await handleTicketRpc(call, tickets, signal);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            mode: "ticket" as const,
            action: call.action,
            ticket: result.ticket?.id,
            // The rendered text may be spill-bounded; the record is not —
            // details keep the complete outcomes for the expanded view.
            // Only poll/wait carry them: cancel/pause/resume expand to
            // their action response text, not the ticket document.
            results:
              call.action === "poll" || call.action === "wait"
                ? result.ticket?.outcomes
                : undefined,
            ...(result.ticket !== undefined &&
            result.ticket.notices.length > 0
              ? { notices: result.ticket.notices }
              : {}),
            ...(call.action === "poll" || call.action === "wait"
              ? { questions: result.ticket?.questions }
              : {}),
          },
          isError: result.isError,
        };
      },
    }),
  );

  api.registerTool(
    defineTool<typeof sessionSchema, DelegateDetails>({
      name: "delegate_session",
      label: "Delegate Sessions",
      description:
        "List or close pooled delegate sessions created by task sessionId fields. Dispatch tasks with delegate; operate on async tickets with delegate_ticket.",
      parameters: sessionSchema,
      promptSnippet: "List or close pooled delegate subagent sessions",
      prepareArguments: prepareSessionArguments,
      renderResult: createResultRenderer(tickets),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const call = validateSessionCall(params);
        visibility.captureFooterCtx(ctx);
        const result = handleSessionRpc(call, sessions, admission);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            mode: "session" as const,
            action: call.action,
            sessionId: call.sessionId,
          },
          isError: result.isError,
        };
      },
    }),
  );
}

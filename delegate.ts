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
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import {
  AdmissionController,
  type AdmissionGrant,
} from "./src/admission.ts";
import {
  configuredModelFor,
  loadDelegateConfig,
  resolveAgentDir,
  telemetryConfigHint,
  type DelegateConfig,
  type TelemetryConfig,
} from "./src/config.ts";
import type {
  AsyncDispatchDetails,
  DeliveredDetails,
  HelpDetails,
  QuestionNoticeDetails,
  SessionDetails,
  SyncDispatchDetails,
  TicketDetails,
} from "./src/details.ts";
import {
  DispatchCoordinator,
  type DispatchOutcome,
} from "./src/coordinator.ts";
import {
  aliasNote,
  briefNote,
  budgetNote,
  fieldNotes,
  formatDispatchResult,
  serializedNotices,
} from "./src/format.ts";
import {
  hostEnvironment,
  parentModelRuntime,
  resolveTasks,
  type HostEnvironment,
  type ParentPromptInputs,
  type ParentPromptService,
} from "./src/host.ts";
import {
  dispatchFingerprint,
  OperationStore,
} from "./src/operations.ts";
import { createActivityStore } from "./src/activity.ts";
import { registerSubagentBrowser } from "./src/browser.ts";
import { currentBootId } from "./src/owner.ts";
import { canonicalAgentName, discoverProfiles } from "./src/profiles.ts";
import {
  createMessageRenderer,
  createResultRenderer,
  renderDelegateCall,
  renderSessionCall,
  renderTicketCall,
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
  REASONING_EFFORT_FIELD_REJECTION,
  THINKING_FIELD_REJECTION,
  validateDispatchCall,
  validateSessionCall,
  validateTicketCall,
  type DispatchCall,
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
          "Named profile: 'default' (mirrors the parent), 'explore' (read-only investigation), 'coder' (implementation), 'reviewer' (review with read + bash — runs focused checks; serializes with writers), 'verifier' (claim-check with read + bash; reports a parsed verdict beside file evidence — reporting only, never gating), or a user-defined Markdown profile (.pi/agents). Omit for an inline task.",
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
          "Exact capabilities. '*' = the writer group (read, bash, edit, write); 'ro' = the read-only group (read, grep, find, ls) — read-only tasks admit concurrently, never serialized as writers; other entries name one child tool each.",
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
    // Cross-harness compatibility spellings (SPEC v3 "Reflex meeting"):
    // other harnesses' trained field names normalize onto canonical ones
    // at validation — the receipt and result say so per applied rename.
    subagent_type: Type.Optional(
      Type.String({
        description:
          "Cross-harness spelling of 'agent' (Claude Code Task field): normalizes to agent before resolution, so aliases apply. Both present and differing is an error.",
      }),
    ),
    description: Type.Optional(
      Type.String({
        maxLength: 200,
        description:
          "Cross-harness spelling (Claude Code Task field): a short label shown in place of the task id in call rows and section headers. Not a correlation key — dependsOn, answer, and steer still use id.",
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          "Cross-harness spelling of 'async' (Claude Code Task field): normalizes to the dispatch-level async decision. Conflicting values across fields is an error.",
      }),
    ),
    agent_type: Type.Optional(
      Type.String({
        description:
          "Cross-harness spelling of 'agent' (Minimax/OpenCode Task field): normalizes to agent before resolution, so aliases apply. Both present and differing is an error.",
      }),
    ),
    task_name: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9._-]{1,64}$",
        description:
          "Cross-harness spelling of 'id' (OpenAI Agents/Minimax spawn field): normalizes to the task id. Both present and differing is an error.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description:
          "Cross-harness spelling of 'prompt' when it appears inside a task object, or on a task-shaped flat call (spawn_agent style with 'task_name'). Both present and differing is an error.",
      }),
    ),
  },
  { additionalProperties: false },
);

const delegateSchema = Type.Object(
  {
    tasks: Type.Array(taskSchema, {
      minItems: 0,
      description:
        "Subagent tasks to run; pass [] for the manual. Batch every task in one call — separate concurrent dispatches from one session share admission, and overlapping writers reject.",
    }),
    async: Type.Optional(
      Type.Boolean({
        description:
          "Default depends on cardinality: one task runs synchronously and returns inline; a multi-task batch returns a ticket immediately and delivers the settled result automatically. Pass true to background a single task, false to block on a batch. Inspect or control tickets with delegate_ticket.",
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          "Cross-harness spelling of 'async' (Claude Code Task field): normalizes to the dispatch-level async decision; 'async' wins when both say the same, a value conflict is an error.",
      }),
    ),
    workspace: Type.Optional(
      stringEnum(["shared", "scratch", "isolated"], {
        description:
          "Default workspace for every task lacking its own. 'isolated' = parallel same-repo edits. 'scratch' = disposable copy, changes discarded.",
      }),
    ),
    brief: Type.Optional(
      Type.String({
        description:
          "Shared batch brief — context every task needs (spec, conventions, goal). Prepended to each task's prompt as a delimited preamble; the result header notes it once. Each task's 'prompt' stays required.",
      }),
    ),
    context: Type.Optional(
      Type.String({
        description:
          "Cross-harness spelling of 'brief': normalizes to the shared batch brief; sending both with different text is an error.",
      }),
    ),
    tokenBudget: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Shared token ceiling for the whole batch: once settled tasks' recorded usage reaches it, tasks still queued settle 'budget-exhausted' instead of starting — running tasks always finish.",
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
    action: stringEnum(["poll", "wait", "cancel", "pause", "resume", "answer", "steer", "interrupt", "tail"], {
      description:
        "Ticket operation. poll: one ticket's view, or the roster when ticket is omitted. wait: block until settlement or timeoutMs. cancel: preview, or cooperative cancellation with force: true. pause/resume: hold and release queued work. answer: reply to a worker's pending question. steer: send a message into a running task — the receipt reports steered (merged at its next turn boundary), activated (queued; opens the next turn), duplicate (same steerId replayed), or not-applied. interrupt: abort one task's in-flight turn — the task settles interrupted and stays resumable, unlike cancel's whole-ticket teardown. tail: read a task's clean assistant output incrementally — {text, nextOffset, done, taskState}; offset resumes the stream, waitMs bounds a park that resolves early on new output.",
    }),
    ticket: Type.Optional(
      Type.String({
        description:
          "Ticket id; required for every action except a roster poll — and optional on 'answer'/'steer'/'interrupt'/'tail' when taskId is a '<ticket>#<task>' compound, which carries its own ticket.",
      }),
    ),
    tickets: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Only with action 'wait': watch several tickets — the call resolves on the first to settle and reports the rest still running. 'ticket' and 'tickets' naming different targets is a validation error; a one-entry list is the single-ticket wait under another spelling.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description:
          "Maximum wait in milliseconds; only with action 'wait'. A timeout detaches the waiter only — the ticket keeps running.",
      }),
    ),
    timeout_ms: Type.Optional(
      Type.Number({
        description:
          "Cross-harness spelling of 'timeoutMs': normalizes to it; both present and differing is an error.",
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
        description:
          "Only with actions 'answer', 'steer', 'interrupt', and 'tail': the task to target. With 'steer'/'interrupt' it defaults to the ticket's only still-running task; with 'tail' it also defaults to the ticket's only task. Accepts the canonical '<ticket>#<task>' address — the ticket field is then optional.",
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
    message: Type.Optional(
      Type.String({
        description:
          "Only with action 'steer': the nonempty instruction merged into the task's run.",
      }),
    ),
    steerId: Type.Optional(
      Type.String({
        description:
          "Only with action 'steer': idempotency key — same id + same message + same target replays the original receipt instead of injecting twice; same id + different content is an error. Optional: omitted, one is derived from this tool call and named in the receipt.",
      }),
    ),
    offset: Type.Optional(
      Type.Number({
        description:
          "Only with action 'tail': char offset into the task's accumulated assistant output — pass back a prior nextOffset to continue the stream. Out-of-range values clamp.",
      }),
    ),
    waitMs: Type.Optional(
      Type.Number({
        description:
          "Only with action 'tail': bound the read — the call resolves early when new output lands or the task settles, and never later than this. Omitted or 0 is a pure snapshot.",
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
/**
 * SPEC v3 "Interaction grammar — Wake delivery": "simultaneous
 * settlements batch into one wake." Settled tickets enqueue here and the
 * first enqueue arms one flush — this window trades a small delivery
 * delay for one wake per settlement cluster instead of one turn per
 * ticket. Deliberately not configurable: SPEC "Surface rules" keeps
 * internal timing out of caller reach.
 */
const DELIVERY_FLUSH_MS = 100;

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
  "tokenBudget",
  // `message` is a task field on delegate (spawn_agent's `prompt` spelling)
  // but ticket-owned on delegate_ticket (steer) — it must not bounce there.
  ...taskFieldNames.filter(
    (field) => field !== "sessionId" && field !== "message",
  ),
  "context",
] as const;

/** Ticket-owned fields for delegate_session's foreign-field guidance. */
const ticketFieldNames = [
  "ticketAction",
  "ticket",
  "tickets",
  "force",
  "timeoutMs",
  "timeout_ms",
  "taskId",
  "questionId",
  "answer",
  "message",
  "steerId",
  "offset",
  "waitMs",
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

const TICKET_ACTIONS = ["poll", "wait", "cancel", "pause", "resume", "answer", "steer", "interrupt", "tail"];
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
        : isGiven(args.message) || isGiven(args.steerId)
          ? "steer"
          : typeof args.offset === "number" || typeof args.waitMs === "number"
            ? "tail"
            : Array.isArray(args.tickets) && args.tickets.length > 0
              ? "wait"
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
  if (action === "wait") {
    if (Array.isArray(args.tickets) && args.tickets.length > 0) {
      fields.push(`tickets: ${JSON.stringify(args.tickets)}`);
    }
    const timeout =
      typeof args.timeoutMs === "number" ? args.timeoutMs : args.timeout_ms;
    if (typeof timeout === "number") {
      // Teach the canonical spelling even when `timeout_ms` was sent.
      fields.push(`timeoutMs: ${JSON.stringify(timeout)}`);
    }
  }
  if (action === "answer") {
    for (const key of ["taskId", "questionId", "answer"] as const) {
      if (typeof args[key] === "string" && !isBlank(args[key])) {
        fields.push(`${key}: ${JSON.stringify(args[key])}`);
      }
    }
  }
  if (action === "steer") {
    for (const key of ["taskId", "message", "steerId"] as const) {
      if (typeof args[key] === "string" && !isBlank(args[key])) {
        fields.push(`${key}: ${JSON.stringify(args[key])}`);
      }
    }
  }
  if (action === "interrupt" && typeof args.taskId === "string" && !isBlank(args.taskId)) {
    fields.push(`taskId: ${JSON.stringify(args.taskId)}`);
  }
  if (action === "tail") {
    if (typeof args.taskId === "string" && !isBlank(args.taskId)) {
      fields.push(`taskId: ${JSON.stringify(args.taskId)}`);
    }
    for (const key of ["offset", "waitMs"] as const) {
      if (typeof args[key] === "number") {
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

/**
 * The rest of a mixed call, named so the corrected example does not silently
 * drop it: foreign-field guidance shows one half, but the call fails as a
 * whole — nothing in it ran.
 */
function unrunFieldsNote(
  args: Record<string, unknown>,
  routed: readonly string[],
): string {
  const rest = Object.keys(args).filter((key) => !routed.includes(key));
  return rest.length === 0
    ? ""
    : ` The rest of this call did not run — resend ${rest
        .map((key) => `'${key}'`)
        .join(", ")} separately.`;
}

/** The removed task-level `context` field's trained values (v1 transcript sharing). */
const OBSOLETE_CONTEXT_VALUES = ["fresh", "with-parent-transcript"] as const;

/** Run before host schema coercion so obsolete fields receive migration guidance. */
function rejectObsoleteContext(record: Record<string, unknown>): void {
  if (Object.hasOwn(record, "context")) {
    throw new Error(
      'The context field has been removed (including "fresh" and "with-parent-transcript"). ' +
        'Omit context and provide a self-contained task brief; parent conversation history is never shared. ' +
        'For shared batch context, a top-level "brief" (or "context") prepends a preamble to every task. ' +
        'Child-owned sessionId and resumeFrom history remain supported.',
    );
  }
}

/**
 * Context-sharing spellings trained callers reach for (#56: codex's
 * `fork_turns`/`fork_context`, plus the `history`/`parent_context`
 * cousins). None is an accepted field — each rejects with the same
 * teaching shape as the removed `context`: name the field, restate the
 * invariant (subagents never inherit this conversation), and point at
 * the batch `brief` as the shared-context mechanism. Presence rejects
 * even when the value is null — before null stripping, like `context`.
 */
const FOREIGN_CONTEXT_FIELDS = [
  "fork_turns",
  "fork_context",
  "history",
  "parent_context",
] as const;

function rejectForeignContextFields(record: Record<string, unknown>): void {
  for (const field of FOREIGN_CONTEXT_FIELDS) {
    if (Object.hasOwn(record, field)) {
      throw new Error(
        `The ${field} field is not accepted — subagents never inherit this conversation. ` +
          `For shared context, put it in the batch brief (the top-level "brief" field) so every task starts with it.`,
      );
    }
  }
}

function normalizeTask(value: unknown, index: number): unknown {
  if (!isRecord(value)) return value;
  const task = { ...value };
  // Presence of `context` rejects even when null — before null stripping.
  rejectObsoleteContext(task);
  // Same for the foreign context-sharing spellings (#56).
  rejectForeignContextFields(task);
  stripNulls(task);
  if (task.model !== undefined) {
    throw new Error(`tasks[${index}]: ${MODEL_FIELD_REJECTION}`);
  }
  if (task.thinking !== undefined) {
    throw new Error(`tasks[${index}]: ${THINKING_FIELD_REJECTION}`);
  }
  if (task.reasoning_effort !== undefined) {
    throw new Error(`tasks[${index}]: ${REASONING_EFFORT_FIELD_REJECTION}`);
  }
  if (typeof task.tools === "string") task.tools = normalizeTools(task.tools);
  stripBlank(task, ["sessionId", "cwd", "resumeFrom", "agent", "subagent_type", "agent_type", "task_name", "description"]);
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
  if (typeof args.run_in_background === "string") {
    throw new Error(
      `'run_in_background' must be a boolean, not the string ${JSON.stringify(args.run_in_background)}.`,
    );
  }
  if (typeof args.tokenBudget === "string") {
    throw new Error(
      `'tokenBudget' must be a positive integer, not the string ${JSON.stringify(args.tokenBudget)}.`,
    );
  }
  // The TypeBox Integer schema silently floors a fractional value on
  // coercion — a corrupted ceiling must reject, not narrow (#47).
  if (
    typeof args.tokenBudget === "number" &&
    !Number.isInteger(args.tokenBudget)
  ) {
    throw new Error(
      `'tokenBudget' must be a positive integer, not ${JSON.stringify(args.tokenBudget)}.`,
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
    if (typeof task.run_in_background === "string") {
      throw new Error(
        `${where}: 'run_in_background' must be a boolean, not the string ${JSON.stringify(task.run_in_background)}.`,
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
  // Top-level `context` is the batch `brief` under a cross-harness
  // spelling (#43) — validation folds it with a rename note. The removed
  // task field's trained values still mean transcript sharing and keep
  // the migration error, as does a non-string `context` (its misuse).
  if (
    Object.hasOwn(args, "context") &&
    (typeof args.context !== "string" ||
      (OBSOLETE_CONTEXT_VALUES as readonly string[]).includes(args.context))
  ) {
    rejectObsoleteContext(args);
  }
  // Foreign context-sharing spellings reject at the top level too (#56)
  // — before null stripping, so a `null` presence still teaches.
  rejectForeignContextFields(args);
  stripNulls(args);
  stripBlank(args, ["operationId", "sessionId", "cwd", "resumeFrom", "agent"]);

  // #44 misroute fix: `message` is steer-owned only when the call is not
  // task-shaped. A spawn_agent-shaped call (`task_name`/`message`, or any
  // task field beside it) folds `message` into the task's prompt below —
  // the ticket guidance must not swallow it. `message` alone still bounces.
  const taskShaped =
    (Array.isArray(args.tasks) && args.tasks.length > 0) ||
    taskFieldNames.some(
      (field) =>
        field !== "message" &&
        field !== "run_in_background" &&
        args[field] !== undefined,
    );

  // Fields the pre-split tool owned: guidance with an example to the right
  // tool beats a bare additionalProperties failure.
  if (
    args.ticketAction !== undefined ||
    args.ticket !== undefined ||
    args.tickets !== undefined ||
    args.force !== undefined ||
    args.taskId !== undefined ||
    args.questionId !== undefined ||
    args.answer !== undefined ||
    args.steerId !== undefined ||
    args.offset !== undefined ||
    args.waitMs !== undefined ||
    (args.message !== undefined && !taskShaped)
  ) {
    throw new Error(
      `Ticket operations moved to delegate_ticket: ${delegateTicketExample(args)}.` +
        unrunFieldsNote(args, [
          "ticketAction",
          "ticket",
          "tickets",
          "force",
          "taskId",
          "questionId",
          "answer",
          "message",
          "steerId",
          "offset",
          "waitMs",
        ]),
    );
  }
  if (args.sessionAction !== undefined) {
    throw new Error(
      `Session operations moved to delegate_session: ${delegateSessionExample(args)}.` +
        unrunFieldsNote(args, ["sessionAction"]),
    );
  }
  if (args.timeoutMs !== undefined || args.timeout_ms !== undefined) {
    const sent = args.timeoutMs ?? args.timeout_ms;
    throw new Error(
      `A delegate run waits for every task and cannot be bounded with timeoutMs. ` +
        `Dispatch with async: true, then bound the wait on its ticket: ` +
        `delegate_ticket({ action: "wait", ticket: "<ticket>", timeoutMs: ${JSON.stringify(sent)} }).`,
    );
  }
  if (args.action !== undefined) {
    throw new Error(
      `delegate takes no "action" field. Ticket operations use delegate_ticket({ action: "poll", ... }); ` +
        `session operations use delegate_session({ action: "list" }).` +
        unrunFieldsNote(args, ["action"]),
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
  if (args.reasoning_effort !== undefined) {
    throw new Error(REASONING_EFFORT_FIELD_REJECTION);
  }
  if (typeof args.tasks === "string") {
    const parsed = parseArray(args.tasks);
    if (parsed) args.tasks = parsed;
  }

  const hasTasks = Array.isArray(args.tasks) && args.tasks.length > 0;
  if (!hasTasks) {
    const task: Record<string, unknown> = {};
    for (const field of taskFieldNames) {
      // run_in_background is a task field in the schema (per-task
      // spelling) but a dispatch-level decision in flat calls — it stays
      // top-level so `{run_in_background: true}` alone still fails as
      // "async dispatch requires at least one task".
      if (field === "run_in_background") continue;
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
    // additionalProperties error. `workspace` and `run_in_background` are
    // excluded: both are also legal top-level dispatch fields.
    const stray = taskFieldNames.filter(
      (field) =>
        field !== "workspace" &&
        field !== "run_in_background" &&
        args[field] !== undefined,
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
  // Blank `answer`/`message` survive: only validation may tell a
  // present-but-empty reply or steer from a missing one — a non-owning
  // action must still reject them. `steerId` is an identifier: blank
  // means absent, like `ticket`/`taskId`.
  stripBlank(args, ["ticket", "taskId", "questionId", "steerId"]);

  if (args.ticketAction !== undefined) {
    throw new Error(
      `The ticket action field is "action", not "ticketAction": ${delegateTicketExample(args)}.` +
        unrunFieldsNote(args, ["ticketAction"]),
    );
  }
  if (args.sessionAction !== undefined || args.sessionId !== undefined) {
    throw new Error(
      `Session operations live on delegate_session, not delegate_ticket: ${delegateSessionExample(args)}.` +
        unrunFieldsNote(args, ["sessionAction", "sessionId"]),
    );
  }
  for (const key of dispatchFieldNames) {
    if (args[key] !== undefined) {
      throw new Error(
        `'${key}' is a delegate dispatch field; task dispatch lives on delegate, not delegate_ticket: ${delegateDispatchExample(args)}.` +
          unrunFieldsNote(args, dispatchFieldNames),
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
      `"${args.action}" is a delegate_session action, not a delegate_ticket one: ${delegateSessionExample(args)}.` +
        unrunFieldsNote(args, ["action"]),
    );
  }
  if (args.model !== undefined) {
    throw new Error(MODEL_FIELD_REJECTION);
  }
  if (args.thinking !== undefined) {
    throw new Error(THINKING_FIELD_REJECTION);
  }
  if (args.reasoning_effort !== undefined) {
    throw new Error(REASONING_EFFORT_FIELD_REJECTION);
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
  if (typeof args.timeout_ms === "string") {
    throw new Error(
      `'timeout_ms' must be a number, not the string ${JSON.stringify(args.timeout_ms)}.`,
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
      `The session action field is "action", not "sessionAction": ${delegateSessionExample(args)}.` +
        unrunFieldsNote(args, ["sessionAction"]),
    );
  }
  for (const key of ticketFieldNames) {
    if (args[key] !== undefined) {
      throw new Error(
        `Ticket operations live on delegate_ticket, not delegate_session: ${delegateTicketExample(args)}.` +
          unrunFieldsNote(args, ticketFieldNames),
      );
    }
  }
  for (const key of dispatchFieldNames) {
    if (args[key] !== undefined) {
      throw new Error(
        `'${key}' is a delegate dispatch field; task dispatch lives on delegate, not delegate_session: ${delegateDispatchExample(args)}.` +
          unrunFieldsNote(args, dispatchFieldNames),
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
      `"${args.action}" is a delegate_ticket action, not a delegate_session one: ${delegateTicketExample(args)}.` +
        unrunFieldsNote(args, ["action"]),
    );
  }
  if (args.model !== undefined) {
    throw new Error(MODEL_FIELD_REJECTION);
  }
  if (args.thinking !== undefined) {
    throw new Error(THINKING_FIELD_REJECTION);
  }
  if (args.reasoning_effort !== undefined) {
    throw new Error(REASONING_EFFORT_FIELD_REJECTION);
  }

  return args as SessionToolArguments;
}

const help = `# Delegate Manual

Three sibling tools share Delegate's machinery:
- \`delegate\` dispatches subagent tasks, synchronously or on an async ticket.
- \`delegate_ticket\` operates on async tickets: poll, wait, cancel, pause,
  resume, answer, steer, interrupt, tail.
- \`delegate_session\` lists and closes pooled subagent sessions.

## delegate — dispatch
- \`tasks\` (required): a non-empty array dispatches work; \`[]\` shows this
  manual. The default depends on cardinality: a single task waits and
  returns its result inline; a multi-task batch returns a ticket
  immediately and delivers the settled result automatically, so do not
  poll in a loop. \`async\` overrides both ways: \`true\` backgrounds a
  single task, \`false\` blocks on a batch (results in input order).
- Task fields: \`prompt\` (required unless \`resumeFrom\`), \`id\` (correlation
  key), \`agent\` (\`default\`/\`explore\`/\`coder\`/\`reviewer\`/\`verifier\`;
  omit for inline), \`cwd\`, \`systemPrompt\`, \`tools\` (\`*\` writer group, \`ro\`
  read-only group, or tool names), \`deadlineMs\` (ms),
  \`sessionId\`, \`resumeFrom\`, \`workspace\` (shared/scratch/isolated),
  \`dependsOn\` (task ids to run first). Cross-harness spellings also
  work: \`subagent_type\`/\`agent_type\` → \`agent\`, \`task_name\` →
  \`id\`, \`message\` beside task-shaped fields → \`prompt\`,
  \`description\` labels the task in views, \`run_in_background\`
  (top-level or per task) → \`async\`; each applied rename is reported
  on the result.
  A top-level \`workspace\` is the batch default.
- \`brief\` shares context across the batch: it prepends to every task's
  prompt inside a \`--- batch brief ---\` fence, and the result header
  notes it once. \`context\` is the same field under a cross-harness
  spelling — it normalizes to \`brief\` (a rename note reports it);
  sending both with different text is an error.
- \`tokenBudget\` caps the batch's total recorded token usage (positive
  integer). Settled tasks charge their usage to it; when it is exhausted
  the batch stops starting new tasks — queued ones settle
  \`budget-exhausted\` and dependents block on them — while tasks already
  running finish normally. The result and ticket header report
  \`consumed/limit\`; omit the field for no cap.
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
- Models and effort: you never pick either — task \`model\`, \`thinking\`,
  and \`reasoning_effort\` fields are rejected. Tasks run on the parent's
  model at the parent's effort; a named agent may instead run on the model
  (and optional \`:effort\`) the user configured for it under "models"/"modelsByParent" in
  the user-global delegate.json, or the \`model\`/\`thinking\` frontmatter
  of its Markdown profile.
- Profiles: the five built-ins plus user-defined Markdown agents —
  \`.pi/agents/*.md\` in the nearest project ancestor, then \`agents/*.md\`
  under the user-global agent directory. A profile needs \`name\` and
  \`description\`; \`tools\`, \`thinking\`, and \`model\` are optional
  frontmatter, the body is its system prompt. A discovered profile
  claims its exact name ahead of the alias table — an authored
  \`general.md\` is your agent, not the \`general\` → \`default\` alias.
- Subagents never nest: \`delegate\`, \`delegate_ticket\`, and
  \`delegate_session\` are removed from every child toolset — explicit
  \`tools\`, profile frontmatter \`tools\`, and the mirrored parent
  set alike.
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
  \`timeoutMs\` (ms, \`timeout_ms\` also accepted) detaches only the
  waiter, the work continues. \`tickets: [ids]\` watches several and
  resolves on the first to settle — the result shows that ticket's
  view plus a one-line roster of the rest still running.
- \`{ action: "cancel", ticket }\` — previews without \`force\`; with
  \`force: true\` the ticket is cancelled now and in-flight tasks are asked
  to stop (cooperative; no rollback).
- \`{ action: "pause" | "resume", ticket }\` — hold and release queued work;
  a paused ticket stays live and keeps its reservations.
- \`{ action: "answer", ticket, taskId, questionId, answer }\` — answer a
  worker's pending \`ask_parent\` question (all four fields required).
  Poll to see outstanding questions. Only async workers can ask.
- \`{ action: "steer", ticket, taskId, message, steerId? }\` — send a
  message into a running task: \`taskId\` defaults to the only still-
  running task; \`steerId\` makes it retry-safe (same id + same message +
  same target replays the original receipt; same id + different content
  is an error) — omitted, a key is derived from this call and the receipt
  names it. The receipt says what happened: \`steered\` (merged at
  the child's next turn boundary), \`activated\` (queued, opens the next
  turn), \`duplicate\`, or \`not-applied\` (settled/unknown target).
- \`{ action: "interrupt", ticket, taskId? }\` — abort one task's
  in-flight turn, cooperatively. The task settles \`interrupted\` —
  partial output kept, the worker resumable (a pooled session returns
  reusable; a fresh task keeps its transcript + resume hint). Distinct
  from \`cancel\`, which tears the whole ticket down. \`taskId\`
  defaults to the only still-running task; interrupting a settled,
  already-interrupted, or not-yet-running task receipts \`not-applied\`.
- \`{ action: "tail", ticket, taskId?, offset?, waitMs? }\` — read one
  task's clean assistant output incrementally. Returns \`{text,
  nextOffset, done, taskState}\` in details: \`text\` is the output-so-far
  chunk from \`offset\` (bounded per call like spilled output), and
  \`nextOffset\` is the cursor to pass back for the next chunk —
  concatenating chunks reproduces the stream. \`done\` flips when the
  task settles and \`taskState\` names its state (\`running\`,
  \`queued\`, \`paused\`, or a settled status). \`waitMs\` parks the
  read until new output lands or the task settles, never exceeding the
  bound; omitted or 0 is a pure snapshot. \`taskId\` defaults to the
  only still-running task (or the ticket's only task). Sources: the
  task's durable transcript for file-backed runs, the captured activity
  text for scratch/isolated ones — raw transcripts are never exposed.
- Canonical task addresses: anywhere \`taskId\` is taken it accepts the
  compound \`"<ticket>#<task>"\` — e.g. \`"t-1a2b#task-1"\` — and the
  separate \`ticket\` field is then optional (the address carries it).
  Wakes, receipts, and task sections render tasks this way so the parent
  can copy the address verbatim.
- Restart recovery: saved tickets stay pollable across host restarts, and
  a \`running\` record is interrupted at startup only when its owning
  process is provably gone (different boot, or a dead pid) — \`owning
  session ended before settlement\`. A sibling session's live ticket is
  left alone, and recovery never restarts work.

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
 * a reload — silently: a broken profile file must not scold someone who
 * only asked for help, and this discovery never consumes the session's
 * warn-once budget (the first dispatch still reports the file).
 */
function customProfileSection(ctx: ExtensionContext): string {
  let agentDir: string;
  try {
    agentDir = resolveAgentDir(ctx).dir;
  } catch {
    return "";
  }
  const catalog = discoverProfiles(ctx.cwd, agentDir, {
    warn: () => {},
  });
  const custom = [...catalog.profiles.values()].filter(
    (profile) => profile.source !== undefined,
  );
  if (custom.length === 0) return "";
  // delegate.json pins (issue #51): a discovered profile the config pins
  // names the resolved model/:effort here, so the manual shows the pin
  // before dispatch resolves — or rejects — it. A broken delegate.json
  // fails loudly at dispatch; the manual just loses the pin suffix.
  let config: DelegateConfig | undefined;
  try {
    config = loadDelegateConfig(agentDir, catalog.globalNames);
  } catch {
    config = undefined;
  }
  const parentKey =
    ctx.model === undefined
      ? undefined
      : `${ctx.model.provider}/${ctx.model.id}`.toLowerCase();
  const lines = custom.map((profile) => {
    const pin =
      config === undefined
        ? undefined
        : configuredModelFor(profile.name, parentKey, config);
    const suffix =
      pin === undefined
        ? ""
        : ` · model \`${pin.ref}${pin.thinking !== undefined ? `:${pin.thinking}` : ""}\` (\`${pin.origin}\`)`;
    return `- \`${profile.name}\` — ${profile.description ?? ""}${suffix}`;
  });
  return `\n## Your agent profiles\n${lines.join("\n")}\n`;
}

export default function delegateExtension(api: ExtensionAPI): void {
  // Host-compat probes (issue #9): exercise the reaches into Pi internals
  // that dispatch depends on — the private model-runtime handle and the
  // agent-directory resolution — on the first event that carries a ctx, so
  // a Pi upgrade that breaks either is visible in the log at session start
  // instead of first failing inside a dispatch. Health probe only: a throw
  // here would route through the host's extension-error channel for every
  // session — including chatters who never dispatch — and the model wiring
  // may not even be final this early, so a hard failure could cry wolf. The
  // definitive check stays at dispatch, which fails with the same cause and
  // the same actionable message as before the probe existed.
  api.on("session_start", (_event, ctx) => {
    const probe = (reach: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        console.error(
          `[delegate] session-start probe failed (${reach}): ${error instanceof Error ? error.message : String(error)}. ` +
            `The first delegate dispatch will fail with this cause; every other tool is unaffected.`,
        );
      }
    };
    probe("parent model runtime", () => parentModelRuntime(ctx));
    probe("agent directory resolution", () => resolveAgentDir(ctx));
  });

  // TicketStore mutates first, visibility reads lazily — the observer arrow
  // only runs on the first mutation, long after both exist. The activity
  // store is created before tickets so running polls can read live
  // per-task rows from the same sink the coordinator feeds.
  const questionContexts = new Map<string, ExtensionContext>();
  const activity = createActivityStore();
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
      content: `Worker "${ticket.id}#${question.taskId}" asks: ${question.question}\nAnswer with delegate_ticket({ action: "answer", taskId: "${ticket.id}#${question.taskId}", questionId: "${question.id}", answer: "..." }). Do not wait on this ticket while it needs your answer.`,
      display: true,
      details: ({
        ticket: ticket.id,
        taskId: question.taskId,
        questionId: question.id,
      } satisfies QuestionNoticeDetails),
    };
    try {
      const sameLeaf =
        navigationEpoch === ticket.originEpoch &&
        (ticket.originLeafId === null ||
          ctx.sessionManager.getBranch().some((entry) => entry.id === ticket.originLeafId));
      if (sameLeaf) api.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
      else {
        api.sendMessage(message, { triggerTurn: false });
        ctx.ui.notify(`Worker "${ticket.id}#${question.taskId}" asks a question; poll and answer it with delegate_ticket on this branch.`, "info");
      }
    } catch (error) {
      console.error(`[delegate] notifying question ${ticket.id}/${question.id} failed (poll it with delegate_ticket): ${error instanceof Error ? error.message : String(error)}`);
    }
  }, activity,
  // #57: pooled sessions are declared below; the lookup defers until a
  // steer/interrupt receipt is built, so the binding is safe.
  (sessionId) => sessions.transcriptFileOf(sessionId));
  const visibility = new VisibilitySignals(() => tickets.list());
  const admission = new AdmissionController();
  const sessions = new SessionPool();
  const coordinator = new DispatchCoordinator(tickets, activity);
  const telemetry = new TelemetryStore();
  const operations = new OperationStore<DelegateResult>();
  let callSeq = 0;
  // Owned by this closure: one fallback warning per extension instance, not
  // per call (see resolveAgentDir for why the fallback exists at all).
  let warnedAgentDirFallback = false;
  // Owned by this closure: profile file paths already warned about this
  // session — discovery re-reads the disk per dispatch, but a broken file
  // warns once per chat, not once per run (see discoverProfiles).
  const warnedProfilePaths = new Set<string>();
  // Shutdown latch: once the host begins teardown, new dispatches reject and
  // pending results are never delivered.
  let shuttingDown = false;
  // Bumped on every observed tree transition — including a vetoed or
  // cancelled navigation attempt, which conservatively downgrades delivery.
  let navigationEpoch = 0;

  /**
   * SPEC v3 "Interaction grammar — Wake delivery": settled results
   * inject as follow-up turns, leaf-aware, and simultaneous settlements
   * batch into one wake. `deliver` used to send one message per ticket
   * the moment it settled — a fan-out produced one parent turn per
   * ticket. Now settlement enqueues here; the first enqueue arms one
   * flush timer (DELIVERY_FLUSH_MS), and the flush groups the queued
   * tickets by routing decision and emits one DELIVERED_MESSAGE_TYPE
   * message per group.
   *
   * Once-ness: `enqueuedDeliveries` makes enqueue idempotent for the
   * extension's lifetime — settlement, not delivery, is the source of
   * truth, and a settled ticket stays pollable regardless of what
   * delivery did with it. Entries are never removed: a ticket must
   * never enqueue twice, even across a flush boundary.
   */
  interface QueuedDelivery {
    readonly ticket: Ticket;
    /** The dispatch's own ctx — owner of the leaf check and UI notify. */
    readonly ctx: ExtensionContext;
  }
  const deliveryQueue: QueuedDelivery[] = [];
  const enqueuedDeliveries = new Set<string>();
  let deliveryFlushTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * "Same leaf" means same branch: the parent's own turn appends entries
   * after dispatch, so the current leaf is a descendant of the origin
   * leaf — the origin must still lie on the current branch (a null origin
   * is the root, which every branch descends from). The epoch separately
   * rules out any observed transition, cancelled or not. Both are read
   * from the ticket, which latched them at dispatch (see execute's
   * synchronous prefix). Computed per ticket at flush time, exactly as
   * the old per-ticket deliver did at settle time.
   */
  const sameLeaf = ({ ticket, ctx }: QueuedDelivery): boolean =>
    navigationEpoch === ticket.originEpoch &&
    (ticket.originLeafId === null ||
      ctx.sessionManager
        .getBranch()
        .some((entry) => entry.id === ticket.originLeafId));

  /**
   * The delivered message for one settlement group: content is the
   * concatenation of the group's ticket views (each names its ticket and
   * carries its own spill-bounded sections), details merge the per-ticket
   * ids, the complete outcomes, and the notices. A single-ticket group
   * keeps the historical `ticket`/`originLeafId` shape so the expanded
   * renderer can serve the live `fullView`.
   */
  const deliveredMessage = (group: readonly QueuedDelivery[]) => {
    const anyCancelled = group.some(
      ({ ticket }) => ticket.status === "cancelled",
    );
    const details: DeliveredDetails =
      group.length === 1
        ? {
            ticket: group[0]!.ticket.id,
            originLeafId: group[0]!.ticket.originLeafId,
            results: group[0]!.ticket.outcomes,
          }
        : {
            tickets: group.map(({ ticket }) => ticket.id),
            originLeafIds: group.map(({ ticket }) => ticket.originLeafId),
            results: group.flatMap(({ ticket }) => ticket.outcomes),
          };
    const notices = group.flatMap(({ ticket }) => ticket.notices);
    if (notices.length > 0) details.notices = notices;
    // Verifier verdicts (#49) — {verdict, taskId} per outcome that parsed
    // one, flattened across the delivered group.
    const verdict = group.flatMap(({ ticket }) =>
      ticket.outcomes.flatMap((outcome) =>
        outcome?.verdict !== undefined
          ? [{ verdict: outcome.verdict, taskId: outcome.id }]
          : [],
      ),
    );
    if (verdict.length > 0) details.verdict = verdict;
    return {
      customType: DELIVERED_MESSAGE_TYPE,
      content:
        group.map(({ ticket }) => tickets.view(ticket)).join("\n\n") +
        (anyCancelled
          ? "\nCancellation is cooperative; worker cleanup may still be pending."
          : ""),
      display: true,
      details,
    };
  };

  /**
   * api.sendMessage is fire-and-forget on the stock ExtensionAPI (returns
   * void): async send rejections surface through the host's
   * extension-error channel, never here. Only synchronous throws — e.g.
   * a torn-down runtime failing assertActive — reach the catch below.
   * Either way, settlement stands and the results stay pollable.
   */
  const flushDeliveries = (): void => {
    deliveryFlushTimer = undefined;
    const batch = deliveryQueue.splice(0);
    if (batch.length === 0) return;
    if (shuttingDown) {
      for (const { ticket } of batch) {
        console.error(
          `[delegate] delivery for ticket ${ticket.id} suppressed during shutdown (result remains pollable)`,
        );
      }
      return;
    }
    const wake: QueuedDelivery[] = [];
    const moved: QueuedDelivery[] = [];
    for (const queued of batch) {
      try {
        (sameLeaf(queued) ? wake : moved).push(queued);
      } catch {
        // The leaf check reads guarded ctx accessors; a stale ctx means
        // the owning session was replaced or disposed between settlement
        // and flush — every replacement path that keeps the extension
        // alive fires session_shutdown first, which drains this queue, so
        // reaching here means the session is gone outright. Delivering a
        // computed-wrong or dead message is worse than none: the settled
        // result stays pollable (and journal-recoverable) either way.
        console.error(
          `[delegate] delivery for ticket ${queued.ticket.id} skipped: the dispatch context is no longer active (result remains pollable)`,
        );
      }
    }
    if (wake.length === 0 && moved.length === 0) return;
    const ids = (group: readonly QueuedDelivery[]) =>
      group.map(({ ticket }) => `"${ticket.id}"`).join(", ");
    // Delivery failure never undoes settlement: the tickets stay
    // terminal and pollable. Each group's send is isolated so one
    // failure neither skips nor misreports the other — and only the
    // failed group's tickets are named (the stale-ctx branch's skips
    // already logged their own line and own no working ctx).
    const reportFailure = (
      group: readonly QueuedDelivery[],
      error: unknown,
    ): void => {
      console.error(
        `[delegate] delivering ticket(s) ${ids(group)} failed (results remain pollable): ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        group[0]!.ctx.ui.notify(
          `Delegate ticket(s) ${ids(group)} settled but their results could not be delivered; poll them for the results.`,
          "error",
        );
      } catch {
        // A stale ctx cannot show the notice; the log line stands.
      }
    };
    if (wake.length > 0) {
      try {
        // Same leaf, no transition observed: a follow-up wakes an idle
        // parent and queues behind a busy one's tool calls. One wake per
        // settlement group, not per ticket (SPEC "Wake delivery").
        api.sendMessage(deliveredMessage(wake), {
          deliverAs: "followUp",
          triggerTurn: true,
        });
      } catch (error) {
        reportFailure(wake, error);
      }
    }
    if (moved.length > 0) {
      try {
        // Leaf moved or a transition is in flight: append durably at the
        // current leaf without triggering a turn — it enters model
        // context on the next user turn.
        api.sendMessage(deliveredMessage(moved), { triggerTurn: false });
        try {
          moved[0]!.ctx.ui.notify(
            moved.length === 1
              ? `Delegate ticket ${ids(moved)} settled on a different branch; its result was appended to the current branch for the next turn.`
              : `Delegate tickets ${ids(moved)} settled on a different branch; their results were appended to the current branch for the next turn.`,
            "info",
          );
        } catch {
          // The UI may already be gone; the append itself landed.
        }
      } catch (error) {
        reportFailure(moved, error);
      }
    }
  };

  /**
   * Settlement → delivery edge: enqueue and arm the one flush timer.
   * A shutdown already latched suppresses at enqueue (the queued-at-
   * shutdown case is handled by the shutdown path draining the queue
   * and by the flush's own re-check).
   */
  const enqueueDelivery = (ticket: Ticket, ctx: ExtensionContext): void => {
    if (shuttingDown) {
      console.error(
        `[delegate] delivery for ticket ${ticket.id} suppressed during shutdown (result remains pollable)`,
      );
      return;
    }
    if (enqueuedDeliveries.has(ticket.id)) return;
    enqueuedDeliveries.add(ticket.id);
    deliveryQueue.push({ ticket, ctx });
    if (deliveryFlushTimer === undefined) {
      deliveryFlushTimer = setTimeout(flushDeliveries, DELIVERY_FLUSH_MS);
      // The flush must never hold a dying process open.
      deliveryFlushTimer.unref?.();
    }
  };

  // Owned by this closure: the parent's latest base system-prompt inputs,
  // captured at each turn start. `before_agent_start` carries the normalized
  // structured options, which separate the user-authored fields (custom
  // prompt, appended text) from extension-contributed sections and tool
  // docs — children inherit only the former (SPEC "Child base prompt").
  let parentPromptOptions: NormalizedBuildSystemPromptOptions | undefined;
  let warnedForcedPrompt = false;
  const parentPrompt: ParentPromptService = {
    inputs(): ParentPromptInputs | undefined {
      if (parentPromptOptions === undefined) return undefined;
      return {
        customPrompt: parentPromptOptions.customPrompt,
        appendSystemPrompt: parentPromptOptions.appendSystemPrompt,
        forced: parentPromptOptions.forceSystemPrompt !== undefined,
      };
    },
    warnForcedInheritanceSkip(): void {
      if (warnedForcedPrompt) return;
      warnedForcedPrompt = true;
      console.warn(
        "[delegate] The parent's system prompt was force-replaced by an extension; subagents cannot inherit it safely and run on the stock base prompt instead.",
      );
    },
  };

  // Owned by this closure: one "fully quiesced" barrier per live dispatch;
  // shutdown holds until every one resolves (INVARIANTS "Ticket state").
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
   * Misfire telemetry (SPEC v3 "Observability"): one row per dispatch
   * that ends before execution — validation rejections (including
   * unknown agent names after alias expansion), config-load failures,
   * and admission rejections. The row carries the verbatim
   * caller-visible message and the requested batch shape (post-alias
   * canonical agent names, effective workspaces, the resolved
   * sync/async mode). Telemetry failures must never mask the rejection
   * being recorded — a throw here would rewrite the caller-visible
   * error, so this helper swallows nothing silently but reports and
   * returns.
   */
  const noteMisfire = (
    ctx: ExtensionContext,
    agentDir: string,
    config: TelemetryConfig,
    phase: "config" | "validation" | "admission",
    error: unknown,
    tasks: readonly TaskInput[] | undefined,
    batchWorkspace: "shared" | "scratch" | "isolated" | undefined,
    async: boolean,
  ): void => {
    try {
      telemetry.recordMisfire(config, agentDir, {
        phase,
        message: error instanceof Error ? error.message : String(error),
        taskCount: tasks?.length ?? 0,
        agents: (tasks ?? []).map((task) => {
          // `subagent_type`/`agent_type` are the same field under
          // cross-harness spellings — a rejected call's shape records the
          // name the caller meant, not the spelling's absence from `agent`.
          const named = task.agent ?? task.subagent_type ?? task.agent_type;
          return named === undefined ? "inline" : canonicalAgentName(named);
        }),
        workspaces: (tasks ?? []).map(
          (task) => task.workspace ?? batchWorkspace ?? "shared",
        ),
        async,
        parentCwd: ctx.cwd,
      });
    } catch (recordError) {
      console.error(
        `[delegate] misfire telemetry failed (the dispatch rejection stands): ${recordError instanceof Error ? recordError.message : String(recordError)}`,
      );
    }
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
    /** The shared batch brief (SPEC v3 "Batch brief"), if the call set one. */
    readonly brief?: string;
    /** The shared batch token ceiling (SPEC v3 "Batch token budget"). */
    readonly tokenBudget?: number;
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
    // reservations. (Only async preparation is abortable: sync batches run
    // on the caller's host signal, which shutdown does not abort, so a
    // parked sync dispatch rides out the hold and runs to completion under
    // the barrier. Async batches run on the ticket's cancellation signal,
    // which shutdown force-cancels — their preparation aborts on its own
    // and the catch below settles the ticket as cancelled.)
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
      // Async journal connect: async dispatch needs the saved journal and
      // ticket creation must be durable before workers spawn, but the
      // connect itself is synchronous filesystem setup — it runs here, in
      // the pipeline, rather than in execute's synchronous prefix. A
      // corrupt or inaccessible journal fails async dispatch visibly
      // without blocking synchronous work (which never touches it).
      if (createTicket !== undefined) {
        tickets.connect(resolveAgentDir(ctx).dir);
      }
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
        parentPrompt,
      );
      const catalog = discoverProfiles(ctx.cwd, agentDirResolution.dir, {
        warnedPaths: warnedProfilePaths,
      });
      // Misfire phases (SPEC v3 "Observability"): config-load failures
      // record under "config" (telemetry status salvaged from the raw
      // file — the load itself just failed); task-resolution and
      // pooled-session reuse rejections record under "validation";
      // admission rejections record under "admission".
      let config: DelegateConfig;
      try {
        config = loadDelegateConfig(
          agentDirResolution.dir,
          catalog.globalNames,
        );
      } catch (error) {
        noteMisfire(
          ctx, agentDirResolution.dir,
          telemetryConfigHint(agentDirResolution.dir),
          "config", error, requestedTasks, undefined,
          createTicket !== undefined,
        );
        throw error;
      }
      let tasks: readonly ResolvedTask[];
      try {
        tasks = await resolveTasks(requestedTasks, env, config, catalog);
      } catch (error) {
        noteMisfire(
          ctx, agentDirResolution.dir, config.telemetry,
          "validation", error, requestedTasks, undefined,
          createTicket !== undefined,
        );
        throw error;
      }
      // Shutdown may have begun while resolveTasks awaited a Git scope probe.
      // Neither a pre-ticket async call nor a pre-admission sync call may
      // start a worker after shutdown's snapshot of live work.
      if (shuttingDown) {
        throw new Error(
          "Delegate shut down while this dispatch was preparing; no worker was started.",
        );
      }
      try {
        sessions.validateReuse(tasks);
      } catch (error) {
        noteMisfire(
          ctx, agentDirResolution.dir, config.telemetry,
          "validation", error, requestedTasks, undefined,
          createTicket !== undefined,
        );
        throw error;
      }
      ticket = createTicket?.(tasks, relabel, config);
      let owner = ticket?.id;
      if (owner === undefined) {
        callSeq += 1;
        owner = `call-${callSeq}`;
        relabel(owner);
      }
      const dispatchSignal = signal ??
        (ticket ? tickets.cancellationSignal(ticket) : undefined);
      let grant: AdmissionGrant;
      try {
        grant = admission.admit(tasks, owner, {
          sessionFileOf: (sessionId) => sessions.transcriptFileOf(sessionId),
          // Issue #51: a cross-call rejection names live capacity — the
          // coordinator's in-flight count against this call's configured
          // ceiling — beside the held claims it lists.
          capacity: {
            running: coordinator.runningCount(),
            maxConcurrent: config.maxConcurrent,
          },
        });
      } catch (error) {
        noteMisfire(
          ctx, agentDirResolution.dir, config.telemetry,
          "admission", error, requestedTasks, undefined,
          createTicket !== undefined,
        );
        throw error;
      }
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
          brief: options.brief,
          tokenBudget: options.tokenBudget,
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
      if (ticket !== undefined && tickets.get(ticket.id) !== undefined) {
        // A ticket whose batch never started is removed rather than
        // exposed: the whole call fails with the cause instead. The get
        // guard matters because create() itself removes its registration
        // when its own creation write throws — removing again would
        // delete another ticket's record if the id were ever reused, and
        // journal.remove() on an unsaved id can only throw noise.
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
  // Capture the parent's structured prompt inputs at every turn start.
  // Shallow copy: later handlers mutate the event's object in place, and
  // the strings we read must be the values observed at this turn's start.
  api.on("before_agent_start", (event) => {
    parentPromptOptions = { ...event.systemPromptOptions };
  });
  api.on("session_before_tree", (_event, ctx) => {
    navigationEpoch += 1;
    return visibility.guardTreeNavigation(ctx, () => {
      for (const ticket of tickets.list()) {
        // A recovered `running` record belongs to a live sibling — this
        // host holds nothing to cancel and must not write its journal.
        if (ticket.status === "running" && ticket.recovered !== true) {
          tickets.cancel(ticket, true);
        }
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
    // A delivery flush armed before the latch must not fire after
    // teardown: cancel the timer and drain the queue with the same
    // suppression log the flush itself would have emitted — settlement
    // is the source of truth, and those results stay pollable.
    if (deliveryFlushTimer !== undefined) {
      clearTimeout(deliveryFlushTimer);
      deliveryFlushTimer = undefined;
    }
    for (const { ticket } of deliveryQueue.splice(0)) {
      console.error(
        `[delegate] delivery for ticket ${ticket.id} suppressed during shutdown (result remains pollable)`,
      );
    }
    // v1's quit/reload traces: name the live work being killed before the
    // force-cancel makes it invisible (quit → stderr; reload → notify).
    visibility.shutdownTrace(
      event.reason,
      ctx,
      tickets
        .list()
        .filter(
          (ticket) => ticket.status === "running" && ticket.recovered !== true,
        ),
    );
    // Forced cancellation settles every ticket immediately and resolves its
    // waiters; delivery is suppressed by the latch above. Checked-out pooled
    // sessions must get their abort requests before the quiescence wait —
    // their runs own disposal through settle, and the barrier below is what
    // confirms they actually stopped (a worker that ignores the abort holds
    // shutdown for as long as it runs, per COMPATIBILITY.md).
    for (const ticket of tickets.list()) {
      // Recovered records project a sibling session's journal — nothing
      // here can cancel them, and a settle would overwrite that entry.
      if (ticket.recovered === true) continue;
      tickets.cancel(ticket, true);
    }
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
        "Run subagent tasks. A single task runs synchronously and returns its result inline; a multi-task batch returns a ticket immediately (inspect or control it with delegate_ticket) and delivers the settled result automatically — pass async: false to block on a batch. tasks: [] shows the manual; pooled sessions are managed with delegate_session. Same-repo writers serialize under 'shared'; read-only tasks never serialize — parallel read-side fan-outs want 'ro' tools or the explore agent (the reviewer runs bash, so it serializes as a writer); 'isolated' runs independent edits in parallel; 'scratch' discards a disposable copy's changes.",
      parameters: delegateSchema,
      promptSnippet:
        "Run subagent tasks: one task sync inline, batches backgrounded with automatic results",
      promptGuidelines: [
        "Subagents never see this conversation — give each delegate task a self-contained brief.",
        "Async delegate results arrive automatically — do not poll in a loop; only wait on a ticket when the next step needs its result.",
        'Use workspace "isolated" for independent edits in the same repo.',
        "Split very large task batches across delegate calls; overlong tool calls get truncated.",
      ],
      prepareArguments: prepareDispatchArguments,
      // The call row is static by contract: `delegate N tasks` plus up
      // to four prompt previews — no spinner or live state.
      renderCall: renderDelegateCall,
      // The stock renderer only displays `content` — which is the
      // spill-bounded projection — so expansion never showed the whole
      // output. This renderer keeps the collapsed preview but renders the
      // complete recorded outcomes from details when expanded.
      renderResult: createResultRenderer(tickets),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        // Synchronous prefix: everything before the first await runs in
        // the same microtask as the host's tool dispatch, so a shutdown
        // handler cannot interleave here. A dispatch that arrives after
        // shutdown begins must fail on the latched value — not on a
        // re-read after task-resolution or workspace-preparation awaits,
        // by which time the shutdown handler would already have
        // snapshotted the live set and missed it. The leaf/epoch stamp is
        // likewise read here: stamping at ticket creation would name the
        // branch navigated to mid-preparation and wake the wrong
        // conversation on settlement.
        const shutdownRejected = shuttingDown;
        const dispatchLeafId = ctx.sessionManager.getLeafId();
        const dispatchEpoch = navigationEpoch;
        // Call-shape validation is the earliest rejection phase; its
        // misfire row uses the salvaged telemetry hint because no config
        // has been loaded yet (SPEC v3 "Observability"). The recording
        // path is itself wrapped so a telemetry problem can never mask
        // the caller-visible rejection.
        let call: DispatchCall;
        try {
          call = validateDispatchCall(params);
        } catch (error) {
          try {
            const agentDir = resolveAgentDir(ctx).dir;
            noteMisfire(
              ctx, agentDir, telemetryConfigHint(agentDir),
              "validation", error, params.tasks, params.workspace,
              params.async ??
                params.run_in_background ??
                params.tasks.find((task) => task.run_in_background !== undefined)
                  ?.run_in_background ??
                params.tasks.length > 1,
            );
          } catch {
            // The original rejection stands; nothing here may throw.
          }
          throw error;
        }
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
            details: ({ mode: "help" as const } satisfies HelpDetails),
          };
        }
        let operationTicket: Ticket | undefined;
        const executeDispatch = async () => {
          // Decided in execute's synchronous prefix (same microtask as
          // the host's tool dispatch): a dispatch still preparing when
          // shutdown begins must not start workers after the shutdown
          // handler snapshotted the live set.
          if (shutdownRejected) {
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
          // results rather than a bare status. Delivery itself is the
          // closure-level coalescing queue (SPEC v3 "Wake delivery"):
          // the ticket joins the current flush window rather than
          // sending alone.
          const armDelivery = (ticket: Ticket): void => {
            void Promise.all([
              tickets.settledPromise(ticket),
              tickets.finishedPromise(ticket),
            ])
              .then(() => enqueueDelivery(ticket, ctx))
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
            brief: call.brief,
            tokenBudget: call.tokenBudget,
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
                      // Hold settlement through the coordinator's
                      // finally when the batch has workspace
                      // reconciliation or a token budget — the final
                      // account must land on the record before any
                      // racing `wait` renders the settled view.
                      holdSettlement:
                        workspaceNeedsSettlementHold(tasks) ||
                        call.tokenBudget !== undefined,
                      outputBounds: config.output,
                      // The shared batch brief — persisted on the ticket so
                      // views and post-restart recovery render the header
                      // note (SPEC v3 "Batch brief").
                      brief: call.brief,
                      // #54 owner liveness: the dispatching host's identity
                      // rides the journal record so a later startup
                      // interrupts this ticket only when the owner is
                      // provably dead — a live sibling pane's ticket is
                      // left untouched.
                      owner: {
                        pid: process.pid,
                        bootId: currentBootId(),
                        sessionId: ctx.sessionManager.getSessionId(),
                      },
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
                    // alone (stamped in execute's synchronous prefix).
                    tickets.recordOrigin(created, {
                      leafId: dispatchLeafId,
                      epoch: dispatchEpoch,
                    });
                    return created;
                  },
          });

          if (ticket !== undefined) {
            // The settled ticket's views (and its journal record) carry
            // the final token-budget account — the coordinator persists
            // it inside its own finally, before the settlement hold
            // lifts, so a racing `wait` never misses it.
            void completion.catch((error: unknown) => {
              // The coordinator's task-quiescence chain owns the barrier
              // and resolves it on this same rejection path; here the
              // ticket just settles failed and the crash is reported.
              tickets.settle(ticket, "failed");
              console.error(
                `[delegate] background ticket ${ticket.id} crashed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
            armDelivery(ticket);
            // The teaching notes the settled views carry (SPEC v3
            // "Reflex meeting") must also reach the caller at dispatch —
            // the receipt is the only sync surface an async call has:
            // applied field normalizations (call-level first), then the
            // alias expansions they enabled.
            const teachNotes = [
              ...call.callNotes.map(
                (note) => `field "${note.field}" → "${note.to}"`,
              ),
              ...ticket.tasks.flatMap((task) => [
                ...fieldNotes(task.normalizedFrom).map(
                  (line) => `${task.id}: ${line}`,
                ),
                ...(aliasNote(task.aliasedFrom, task.agent) !== ""
                  ? [`${task.id}: ${aliasNote(task.aliasedFrom, task.agent)}`]
                  : []),
              ]),
            ];
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Ticket "${ticket.id}" created: ${ticket.totalTasks} task(s) running in the background.\n` +
                    (teachNotes.length > 0 ? `${teachNotes.join("\n")}\n` : "") +
                    (briefNote(call.brief) !== undefined
                      ? `${briefNote(call.brief)}\n`
                      : "") +
                    (call.tokenBudget !== undefined
                      ? `${budgetNote({ limit: call.tokenBudget, consumed: 0 })}\n`
                      : "") +
                    `Results will be delivered automatically when the batch settles; keep working. ` +
                    `delegate_ticket can wait on or cancel it if needed (action "wait" / "cancel").` +
                    (ticket.notices.length > 0
                      ? `\n${ticket.notices.join("\n")}`
                      : ""),
                },
              ],
              details: ({
                mode: "dispatch" as const,
                async: true,
                ticket: ticket.id,
                tasks: ticket.tasks.map((task) => task.id),
                ...(call.brief !== undefined ? { brief: call.brief } : {}),
              } satisfies AsyncDispatchDetails),
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
          // Dispatch-level normalizations (e.g. top-level
          // run_in_background → async) precede the admission notices —
          // they were decided before execution (SPEC v3 "Reflex meeting").
          const callNoteLines = call.callNotes.map(
            (note) => `field "${note.field}" → "${note.to}"`,
          );
          const textNotices = [...callNoteLines, ...notices];
          return {
            content: [
              {
                type: "text" as const,
                text:
                  (textNotices.length > 0 ? `${textNotices.join("\n")}\n\n` : "") +
                  formatDispatchResult(result.outcomes, tasks, outputBounds, call.brief, result.tokenBudget),
              },
            ],
            details: ({
              mode: "dispatch" as const,
              async: false,
              tasks: result.outcomes.map((outcome) => ({
                id: outcome.id,
                status: outcome.status,
              })),
              // The batch brief as sent — the replayed/expanded render
              // re-heads the result with it (SPEC v3 "Batch brief").
              ...(call.brief !== undefined ? { brief: call.brief } : {}),
              // SPEC v3 "Batch token budget": the final account —
              // {limit, consumed, exhaustedAt} — when the call set one.
              ...(result.tokenBudget !== undefined
                ? { tokenBudget: result.tokenBudget }
                : {}),
              // The rendered content is spill-bounded; details keep the
              // complete outcomes for the expanded view and recovery.
              results: result.outcomes,
              // SPEC v3 "Observability — Completion evidence": the
              // machine-readable half of the per-task `files:` lines —
              // absolute write/edit paths plus the bash-uncertainty flag.
              attributedFiles: result.outcomes.map((outcome) => ({
                taskId: outcome.id,
                files: [...(outcome.attributedFiles ?? [])],
                uncertain: outcome.uncertainFiles === true,
              })),
              // SPEC v3 "Observability — Completion evidence — verifier
              // verdict" (#49): the machine half of the `verdict:` lines —
              // {verdict, taskId} per verifier task that produced one.
              // Absent when no task carried a verdict.
              ...(() => {
                const verdict = result.outcomes.flatMap((outcome) =>
                  outcome.verdict !== undefined
                    ? [{ verdict: outcome.verdict, taskId: outcome.id }]
                    : [],
                );
                return verdict.length > 0 ? { verdict } : {};
              })(),
              // When any worker's accounting is incomplete the usage total
              // below is a lower bound — the flag lets a machine caller see
              // what the result text's note says in prose.
              ...(result.outcomes.some((outcome) => outcome.quarantined)
                ? { usageLowerBound: true }
                : {}),
              ...(textNotices.length > 0 ? { notices: textNotices } : {}),
            } satisfies SyncDispatchDetails),
            usage: result.usage,
            isError: allFailed,
          };
        };

        if (call.operationId === undefined) return executeDispatch();
        // An operationId/fingerprint conflict rejects synchronously —
        // a dispatch that ends before execution, so it records a
        // validation misfire. `run` returns a promise for the dispatch
        // itself; this catch sees only the synchronous conflict throw,
        // never an execution-phase rejection.
        try {
          return operations.run(
            call.operationId,
            // The fingerprint covers the post-normalization request, so
            // compat spellings (`subagent_type`, `run_in_background`) of
            // the same dispatch dedupe — `normalizedFrom` is teaching
            // metadata, not request content.
            dispatchFingerprint({
              async: call.async,
              // The brief is request content — a call differing only in
              // its brief is a different dispatch, not a duplicate.
              brief: call.brief,
              // Same for the batch token ceiling (#47).
              tokenBudget: call.tokenBudget,
              tasks: call.tasks.map(
                ({ normalizedFrom: _normalized, ...task }) => task,
              ),
            }),
            executeDispatch,
            () =>
              operationTicket
                ? tickets.finishedPromise(operationTicket)
                : Promise.resolve(),
          );
        } catch (error) {
          try {
            const agentDir = resolveAgentDir(ctx).dir;
            noteMisfire(
              ctx, agentDir, telemetryConfigHint(agentDir),
              "validation", error, call.tasks, undefined, call.async,
            );
          } catch {
            // The original rejection stands; nothing here may throw.
          }
          throw error;
        }
      },
    }),
  );

  api.registerTool(
    defineTool<typeof ticketSchema, DelegateDetails>({
      name: "delegate_ticket",
      label: "Delegate Tickets",
      description:
        "Operate on a delegate async ticket: poll (the roster, or one ticket), wait for settlement, cancel, pause, resume, answer a worker question, steer a running task with a message (optional steerId is the retry key — derived from the call when omitted; the receipt reports steered/activated/duplicate/not-applied), interrupt one task's in-flight turn (settles it interrupted, keeping the worker resumable — cancel tears the ticket down instead), or tail a task's assistant output incrementally (offset/nextOffset page a bounded chunk; waitMs parks until new output lands). Dispatch new work with delegate; manage pooled sessions with delegate_session.",
      parameters: ticketSchema,
      promptSnippet:
        "Poll, wait on, cancel, pause/resume, answer questions, steer, interrupt, or tail output of tasks on async delegate tickets",
      prepareArguments: prepareTicketArguments,
      renderCall: renderTicketCall,
      renderResult: createResultRenderer(tickets),

      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const call = validateTicketCall(params);
        visibility.captureFooterCtx(ctx);
        // Ticket RPCs need the saved journal; a corrupt or inaccessible one
        // fails this call visibly but does not affect dispatch or sessions.
        tickets.connect(resolveAgentDir(ctx).dir);
        // `toolCallId` seeds the derived steerId (#44) — an omitted key
        // becomes `steer:<toolCallId>`, so a transport-level retry of the
        // same tool call replays rather than re-injecting.
        const result = await handleTicketRpc(call, tickets, signal, toolCallId);
        const noteText =
          call.notes.length === 0
            ? ""
            : `${fieldNotes(call.notes).join("\n")}\n\n`;
        return {
          content: [{ type: "text" as const, text: `${noteText}${result.text}` }],
          details: ({
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
            // SPEC v3 "Observability — Completion evidence":
            // machine-readable attribution per task — recorded outcomes,
            // plus observed-so-far evidence for tasks still running.
            attributedFiles:
              (call.action === "poll" || call.action === "wait") &&
              result.ticket !== undefined
                ? tickets.attributionDetails(result.ticket)
                : undefined,
            // Verifier verdicts (#49) — {verdict, taskId} per recorded
            // outcome that parsed one; poll/wait only, same as results.
            verdict:
              (call.action === "poll" || call.action === "wait") &&
              result.ticket !== undefined
                ? tickets.verdictDetails(result.ticket)
                : undefined,
            ...(result.ticket !== undefined &&
            result.ticket.notices.length > 0
              ? { notices: result.ticket.notices }
              : {}),
            // SPEC v3 "Batch token budget": the settled batch's final
            // account rides the view (poll/wait), same as the sync result.
            ...(result.ticket?.tokenBudget !== undefined
              ? { tokenBudget: result.ticket.tokenBudget }
              : {}),
            ...(call.action === "poll" || call.action === "wait"
              ? { questions: result.ticket?.questions }
              : {}),
            // SPEC v3 "Steering": the receipt's machine half rides
            // details.steer (status, taskId, replayed original status);
            // an interrupt's rides details.interrupt the same way. A tail
            // read's {text, nextOffset, done, taskState} rides
            // details.tail (#52).
            ...(result.steer !== undefined ? { steer: result.steer } : {}),
            ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
            ...(result.tail !== undefined ? { tail: result.tail } : {}),
          } satisfies TicketDetails),
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
      renderCall: renderSessionCall,
      renderResult: createResultRenderer(tickets),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const call = validateSessionCall(params);
        visibility.captureFooterCtx(ctx);
        const result = handleSessionRpc(call, sessions, admission);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: ({
            mode: "session" as const,
            action: call.action,
            sessionId: call.sessionId,
          } satisfies SessionDetails),
          isError: result.isError,
        };
      },
    }),
  );
}

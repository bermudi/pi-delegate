import { Type, type SchemaOptions } from "@sinclair/typebox";
import { VALID_THINKING_LEVELS } from "./constants.ts";
import type { DelegateArguments } from "./types.ts";

// JSON Schema string enum that keeps the literal union in `Static<>`.
// `Type.String({ enum })` validates identically but widens to `string`;
// `Type.Union([Type.Literal…])` keeps the literals but serializes as `anyOf`,
// which some providers handle poorly. `Type.Unsafe` gives both: the wire
// format stays `{ type: "string", enum: [...] }` and the type stays narrow.
// (TypeBox 0.34's `Type.Enum` targets numeric TS enums, not string arrays, so
// it is not a drop-in replacement here.)
function StringEnum<const T extends readonly string[]>(
  values: T,
  options?: SchemaOptions,
) {
  return Type.Unsafe<T[number]>({
    ...options,
    type: "string",
    enum: [...values],
  });
}

const TASK_ID_PATTERN = "^[A-Za-z0-9._-]{1,64}$";
const TASK_ID_RE = new RegExp(TASK_ID_PATTERN);

export const delegateTaskSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      pattern: TASK_ID_PATTERN,
      minLength: 1,
      maxLength: 64,
      description:
        "Optional task correlation key; 1-64 chars; A-Z a-z 0-9 . _ - only; duplicate ids rejected. Omit for index.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Self-contained task prompt; fresh context cannot see this chat. Omit only for close, list, or resumeFrom.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        "Built-ins: default, scout, coder, reviewer. Reviewer defaults to one-shot scratch. Omit for ad-hoc.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Subagent directory; relative paths use parent cwd.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description:
        "Base system prompt; project resources from the task cwd are added automatically.",
    }),
  ),
  context: Type.Optional(
    StringEnum(["fresh", "with-parent-transcript"], {
      description:
        "fresh omits this chat; with-parent-transcript copies it (token-expensive).",
      default: "fresh",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Model override; omit to inherit parent.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Names/presets: *=read/write/edit/bash (mutating); ro=read/grep/find/ls (read-only). Ad-hoc defaults to *.",
    }),
  ),
  thinking: Type.Optional(
    StringEnum(VALID_THINKING_LEVELS, {
      description:
        "Thinking: off/minimal/low/medium/high/xhigh/max; default=parent; others=agent/off.",
    }),
  ),
  sessionId: Type.Optional(
    Type.String({
      description:
        "Live pool key for multi-turn reuse; omit for one-shot tasks.",
    }),
  ),
  sessionAction: Type.Optional(
    StringEnum(["prompt", "close", "list"], {
      description:
        "Session action; close needs sessionId; list shows active pooled sessions.",
      default: "prompt",
    }),
  ),
  resumeFrom: Type.Optional(
    Type.String({
      description:
        "Exact absolute .jsonl session path from retry output; never a ticket ID.",
    }),
  ),
  deadlineMs: Type.Optional(
    Type.Number({
      description:
        "Wall-clock budget (ms) from run start after queueing. Cooperative abort; side effects remain. Omit disables.",
    }),
  ),
  workspace: Type.Optional(
    StringEnum(["shared", "scratch"], {
      description:
        "shared source; scratch disposable copy, one-shot; not security isolation. Reviewer=scratch; others=shared.",
    }),
  ),
});

// Single source of truth for registration and generated help. The exported
// argument types in types.ts project this canonical schema; providers see
// only these fields.
export const delegateArgumentsSchema = Type.Object({
  ticketAction: Type.Optional(
    StringEnum(["poll", "cancel", "wait"], {
      description:
        "Ticket control: poll=snapshot; wait=block until settled; cancel=abort. Prefer wait; never cancel for time.",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description:
        "Detach work, return a ticket; applies to ALL tasks. Results auto-deliver. Wait only if blocked.",
      default: false,
    }),
  ),
  ticket: Type.Optional(
    Type.String({
      description: "Ticket ID; omit only when polling all tickets.",
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "With cancel: false previews active work; true confirms abort. Completed writes/commands remain.",
      default: false,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Bounds wait (ms); omit to block until settled. Timeout returns a snapshot; do not poll afterward.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(delegateTaskSchema, {
      minItems: 0,
      description:
        "Tasks run concurrently; shared workspaces share files. scratch uses a disposable CoW copy. []=full manual.",
    }),
  ),
});

/** Fields that belong to a task entry. Models sometimes place these at the top
 * level of the arguments; the shim folds them back into a single task. */
const TASK_FIELD_NAMES = [
  "id",
  "prompt",
  "agent",
  "cwd",
  "systemPrompt",
  "context",
  "model",
  "tools",
  "thinking",
  "sessionId",
  "sessionAction",
  "resumeFrom",
  "deadlineMs",
  "workspace",
] as const;

/** Every field a task entry may carry. Anything else is a model mistake —
 * e.g. `async` placed inside a task — and must fail loudly with a
 * corrective message instead of being silently ignored (observed in the
 * wild: a task-level `async: true` the caller believed had backgrounded
 * the work while the call in fact ran synchronously). */
const VALID_TASK_KEYS = new Set<string>(TASK_FIELD_NAMES);

/** Validate the three operation modes after compatibility reshaping. */
export function validateDelegateOperation(
  params: DelegateArguments,
): string | undefined {
  const rawParams = params as Record<string, unknown>;
  if ("action" in rawParams) {
    return (
      "unsupported field 'action'; use 'ticketAction' for poll/cancel/wait " +
      "or 'sessionAction' for prompt/close/list."
    );
  }
  const tasks = params.tasks ?? [];

  const ticketAction = params.ticketAction;
  const isTicketControl = ticketAction !== undefined;

  if (isTicketControl) {
    const taskIntentFields = ([...TASK_FIELD_NAMES, "tasks"] as const).filter(
      (field) => rawParams[field] !== undefined,
    );
    if (taskIntentFields.length) {
      return `ticket control cannot be combined with task-intent field(s) ${taskIntentFields
        .map((field) => `'${field}'`)
        .join(", ")}; call it separately.`;
    }
    if (params.async === true) {
      return "ticket control cannot include async; call it separately.";
    }
    if (ticketAction !== "poll" && !params.ticket) {
      return `ticketAction '${ticketAction}' requires ticket.`;
    }
    if (ticketAction !== "cancel" && params.force === true) {
      return "force is valid only with ticketAction 'cancel'.";
    }
    if (ticketAction !== "wait" && params.timeoutMs !== undefined) {
      return "timeoutMs is valid only with ticketAction 'wait'.";
    }
    return undefined;
  }

  if (params.ticket !== undefined) {
    return "ticket requires ticketAction 'poll', 'cancel', or 'wait'.";
  }
  if (params.force === true)
    return "force is valid only with ticketAction 'cancel'.";
  if (params.timeoutMs !== undefined) {
    return "timeoutMs is valid only with ticketAction 'wait'.";
  }
  if (!tasks.length) {
    return params.async === true
      ? "async dispatch requires at least one task."
      : undefined; // Intentional help request.
  }

  // Reject mixed shapes: flat task fields at the top level alongside a
  // nonempty tasks array. The normalize shim only wraps flat fields when
  // there is no tasks array, so a mixed call silently lets tasks win —
  // a model mistake that should fail loudly.
  if (tasks.length > 0) {
    const flatTaskFields = TASK_FIELD_NAMES.filter(
      (field) => rawParams[field] !== undefined,
    );
    if (flatTaskFields.length) {
      return `cannot mix top-level task field(s) ${flatTaskFields
        .map((field) => `'${field}'`)
        .join(
          ", ",
        )} with an explicit tasks array; move them into a task entry or remove tasks.`;
    }
  }

  for (const [index, task] of tasks.entries()) {
    const rawTask = task as Record<string, unknown>;
    const sessionAction = task.sessionAction;

    const unknownKeys = Object.keys(rawTask).filter(
      (key) => !VALID_TASK_KEYS.has(key),
    );
    if (unknownKeys.length) {
      const asyncHint = unknownKeys.includes("async")
        ? " 'async' is a top-level flag; move it out of the task entry."
        : "";
      return (
        `task ${index + 1}: unknown field(s) ${unknownKeys
          .map((key) => `'${key}'`)
          .join(", ")}.${asyncHint} ` +
        `Valid task fields: ${[...VALID_TASK_KEYS].join(", ")}.`
      );
    }
    if (rawTask.id !== undefined) {
      if (typeof rawTask.id !== "string" || !TASK_ID_RE.test(rawTask.id)) {
        return `task ${index + 1}: id must be 1-64 characters using only A-Z, a-z, 0-9, '.', '_', or '-'.`;
      }
    }
    if (typeof rawTask.deadlineMs === "number" && !(rawTask.deadlineMs > 0)) {
      return `task ${index + 1}: deadlineMs must be a positive number of milliseconds.`;
    }
    if (
      task.workspace === "scratch" &&
      !task.agent &&
      (task.sessionId || task.resumeFrom || sessionAction !== undefined)
    ) {
      return `task ${index + 1}: workspace 'scratch' is one-shot and cannot be combined with sessionId, resumeFrom, or sessionAction. Set workspace: "shared" to use a persistent agent.`;
    }
    if (sessionAction === "close") {
      if (!task.sessionId) {
        return `task ${index + 1}: sessionAction 'close' requires sessionId.`;
      }
      const extras = Object.keys(rawTask).filter(
        (key) => key !== "sessionAction" && key !== "sessionId" && key !== "id",
      );
      if (extras.length) {
        return `task ${index + 1}: sessionAction 'close' accepts only sessionAction and sessionId.`;
      }
    }
    if (sessionAction === "list") {
      const extras = Object.keys(rawTask).filter(
        (key) => key !== "sessionAction" && key !== "id",
      );
      if (extras.length) {
        return `task ${index + 1}: sessionAction 'list' accepts only sessionAction.`;
      }
    }
  }

  return undefined;
}

function parseStringifiedArray(value: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Recover `tools` given as a string: a JSON array string, or a bare group
 * token like "*" / "ro" wrapped into a single-element array. Anything else
 * is left for schema validation to reject. */
function normalizeToolsField(value: string): unknown {
  const parsed = parseStringifiedArray(value);
  if (parsed) return parsed;
  const trimmed = value.trim();
  return trimmed && !/[\s,]/.test(trimmed) ? [trimmed] : value;
}

/** True when `record` carries a top-level ticket-control intent that makes a
 * flat task-field wrap illegitimate: an explicit `ticketAction`, or a bare
 * `ticket` id (which only makes sense with poll/cancel/wait). */
function hasTicketControlIntent(record: Record<string, unknown>): boolean {
  return (
    record.ticketAction === "poll" ||
    record.ticketAction === "cancel" ||
    record.ticketAction === "wait" ||
    record.ticket !== undefined
  );
}

/** Fold top-level task fields into a single `tasks` entry. Only fires when
 * there is no usable tasks array and no ticket-control intent — those calls
 * are legitimately taskless. `sessionAction` is part of `TASK_FIELD_NAMES`,
 * so a top-level `sessionAction` rides along into the wrapped task. */
function wrapFlatTaskFields(record: Record<string, unknown>): void {
  const hasTasks = Array.isArray(record.tasks) && record.tasks.length > 0;
  if (hasTasks || hasTicketControlIntent(record)) return;
  const task: Record<string, unknown> = {};
  for (const key of TASK_FIELD_NAMES) {
    if (record[key] !== undefined) {
      task[key] = record[key];
      delete record[key];
    }
  }
  if (Object.keys(task).length > 0) record.tasks = [task];
}

/** Per-entry recovery for one task: stringified (or bare-token) `tools` → a
 * real array, and `agent: ""` → omitted (ad-hoc). Other malformed input is
 * left for schema validation to reject loudly. */
function normalizeTaskEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as Record<string, unknown>;
  const rawTools = e.tools;
  const fixAgent = e.agent === "";
  if (typeof rawTools !== "string" && !fixAgent) return entry;
  const out = { ...e };
  if (typeof rawTools === "string") {
    out.tools = normalizeToolsField(rawTools);
  }
  if (fixAgent) delete out.agent;
  return out;
}

/** Compatibility shim run by pi before schema validation. Recovers the
 * malformed shapes weaker models emit, instead of letting them silently
 * degrade to the help response (an empty `tasks` returns the manual, which
 * models then misread as "the tool is broken"):
 * - `tasks` as a JSON string instead of an array;
 * - task fields (`prompt`, `systemPrompt`, `tools`, ...) placed at the top
 *   level instead of inside a `tasks` entry — wrapped into a single task;
 * - `tools` as a JSON string (or bare token) inside a task entry;
 * - `agent: ""` inside a task entry — treated as omitted (ad-hoc).
 * All other invalid input is left for normal schema validation to reject
 * loudly.
 *
 * Silent by design: these rewrites are lossless re-shaping, so unlike the
 * model-suffix warning in task-resolution (which fires because thinking
 * intent is discarded), recovery warrants no signal. */
export function normalizeDelegateArguments(args: unknown): DelegateArguments {
  if (!args || typeof args !== "object") return args as DelegateArguments;
  const record: Record<string, unknown> = {
    ...(args as Record<string, unknown>),
  };

  // Stringified `tasks` array → real array.
  if (typeof record.tasks === "string") {
    const parsed = parseStringifiedArray(record.tasks);
    if (parsed) record.tasks = parsed;
  }

  // Flat task fields at the top level → wrap into a single task.
  wrapFlatTaskFields(record);

  // Per-entry recovery: stringified/bare-token `tools` and `agent: ""`.
  if (Array.isArray(record.tasks)) {
    record.tasks = record.tasks.map(normalizeTaskEntry);
  }

  return record as DelegateArguments;
}

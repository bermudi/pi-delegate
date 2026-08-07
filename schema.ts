import { Type, type SchemaOptions } from "@sinclair/typebox";
import { VALID_THINKING_LEVELS } from "./constants.ts";
import type { DelegateArguments } from "./types.ts";

// JSON Schema string enum that keeps the literal union in `Static<>`.
// `Type.String({ enum })` validates identically but widens to `string`;
// `Type.Union([Type.Literal…])` keeps the literals but serializes as `anyOf`,
// which some providers handle poorly. `Type.Unsafe` gives both: the wire
// format stays `{ type: "string", enum: [...] }` and the type stays narrow.
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

export const delegateTaskSchema = Type.Object({
  prompt: Type.Optional(
    Type.String({
      description: "Task prompt; omit only for close, list, or resumeFrom.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        "Use `default`: parent model/thinking/native tools/base prompt. Omit=ad-hoc; unknown fails call.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Subagent directory; relative paths use parent cwd.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description: "Base system prompt; AgentSession adds project resources.",
    }),
  ),
  context: Type.Optional(
    StringEnum(["fresh", "with-parent-transcript"], {
      description:
        "fresh omits parent transcript; with-parent-transcript copies it (token-expensive).",
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
        "`default`=parent natives; ad-hoc=*; *=read/write/edit/bash (mutating); ro=read/grep/find/ls (read-only).",
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
  action: Type.Optional(
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
});

// Single source of truth for registration, generated help, and the
// DelegateArguments/TaskDef projections in types.ts.
export const delegateArgumentsSchema = Type.Object({
  action: Type.Optional(
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
        "True cancels after preview; completed writes/commands remain.",
      default: false,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Bounds wait (ms); omit to block until settled. Timeout never cancels the ticket.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(delegateTaskSchema, {
      minItems: 0,
      description:
        "Fields in entries; tasks run concurrently; separate dependent/shared-file work. []=help.",
    }),
  ),
});

/** Fields that belong to a task entry. Models sometimes place these at the
 * top level of the arguments; the shim folds them back into a single task. */
const TASK_FIELD_NAMES = [
  "prompt",
  "agent",
  "cwd",
  "systemPrompt",
  "context",
  "model",
  "tools",
  "thinking",
  "sessionId",
  "resumeFrom",
] as const;

/** Every field a task entry may carry. Anything else is a model mistake —
 * e.g. `async` placed inside a task — and must fail loudly with a
 * corrective message instead of being silently ignored (observed in the
 * wild: a task-level `async: true` the caller believed had backgrounded
 * the work while the call in fact ran synchronously). */
const VALID_TASK_KEYS = new Set<string>([...TASK_FIELD_NAMES, "action"]);

/** Validate the three operation modes after compatibility reshaping. */
export function validateDelegateOperation(
  params: DelegateArguments,
): string | undefined {
  const tasks = params.tasks ?? [];
  const isTicketControl = params.action !== undefined;

  if (isTicketControl) {
    if (params.tasks !== undefined || params.async === true) {
      return "ticket control cannot include tasks or async; call it separately.";
    }
    if (params.action !== "poll" && !params.ticket) {
      return `action '${params.action}' requires ticket.`;
    }
    if (params.action !== "cancel" && params.force === true) {
      return "force is valid only with action 'cancel'.";
    }
    if (params.action !== "wait" && params.timeoutMs !== undefined) {
      return "timeoutMs is valid only with action 'wait'.";
    }
    return undefined;
  }

  if (params.ticket !== undefined) {
    return "ticket requires action 'poll', 'cancel', or 'wait'.";
  }
  if (params.force === true) return "force is valid only with action 'cancel'.";
  if (params.timeoutMs !== undefined) {
    return "timeoutMs is valid only with action 'wait'.";
  }
  if (!tasks.length) {
    return params.async === true
      ? "async dispatch requires at least one task."
      : undefined; // Intentional help request.
  }

  for (const [index, task] of tasks.entries()) {
    const unknownKeys = Object.keys(task).filter(
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
    if (task.action === "close") {
      if (!task.sessionId) {
        return `task ${index + 1}: action 'close' requires sessionId.`;
      }
      const extras = Object.keys(task).filter(
        (key) => key !== "action" && key !== "sessionId",
      );
      if (extras.length) {
        return `task ${index + 1}: action 'close' accepts only action and sessionId.`;
      }
    }
    if (task.action === "list") {
      const extras = Object.keys(task).filter((key) => key !== "action");
      if (extras.length) {
        return `task ${index + 1}: action 'list' accepts only action.`;
      }
    }
  }

  return undefined;
}

/** Actions that are only valid at task level. The top-level `action` is
 * ticket-scoped (poll/cancel/wait), so a flat close/list/prompt belongs to
 * the wrapped task. */
const TASK_ACTIONS = new Set(["prompt", "close", "list"]);

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

/** Compatibility shim run by pi before schema validation. Recovers the
 * malformed shapes weaker models emit, instead of letting them silently
 * degrade to the help response (an empty `tasks` returns the manual, which
 * models then misread as "the tool is broken"):
 * - `tasks` as a JSON string instead of an array;
 * - task fields (`prompt`, `systemPrompt`, `tools`, ...) placed at the top
 *   level instead of inside a `tasks` entry — wrapped into a single task;
 * - `tools` as a JSON string (or bare token) inside a task entry;
 * - `agent: ""` inside a task entry — treated as omitted (ad-hoc).
 * Skipped when a ticket action is in play. All other invalid input is left
 * for normal schema validation to reject loudly.
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

  // Flat task fields at the top level → wrap into a single task. Only fires
  // when there is no usable tasks array and no ticket action (`ticket`,
  // poll/cancel/wait) — those calls are legitimately taskless.
  const hasTasks = Array.isArray(record.tasks) && record.tasks.length > 0;
  const isTicketAction =
    record.action === "poll" ||
    record.action === "cancel" ||
    record.action === "wait";
  if (!hasTasks && !isTicketAction && record.ticket === undefined) {
    const task: Record<string, unknown> = {};
    for (const key of TASK_FIELD_NAMES) {
      if (record[key] !== undefined) {
        task[key] = record[key];
        delete record[key];
      }
    }
    if (typeof record.action === "string" && TASK_ACTIONS.has(record.action)) {
      task.action = record.action;
      delete record.action;
    }
    if (Object.keys(task).length > 0) record.tasks = [task];
  }

  // Per-entry recovery: stringified (or bare-token) `tools` → real arrays,
  // and `agent: ""` → omitted (models emit an empty string to mean "ad-hoc";
  // without this it only works by truthiness accident downstream).
  if (Array.isArray(record.tasks)) {
    record.tasks = record.tasks.map((entry: unknown) => {
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
    });
  }

  return record as DelegateArguments;
}

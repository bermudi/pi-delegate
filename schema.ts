import { Type, type SchemaOptions } from "@sinclair/typebox";
import { ASYNC_MAX_RUNTIME_MS, VALID_THINKING_LEVELS } from "./constants.ts";
import type { DelegateParams } from "./types.ts";

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

export const delegateTaskParameters = Type.Object({
  prompt: Type.Optional(
    Type.String({
      description: "Task prompt. Optional for close/list or resumeFrom.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description: "Agent name; omit for custom inline agent.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Subagent working directory. Default: parent cwd.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description: "System prompt; inherits from agent or parent.",
    }),
  ),
  context: Type.Optional(
    StringEnum(["fresh", "with-parent-transcript"], {
      description:
        "'with-parent-transcript' includes parent history (token-expensive).",
      default: "fresh",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Model override; inherits parent.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`*`=all; `ro`=read/grep/find/ls. bash mutates; `ro` is read-only.",
    }),
  ),
  thinking: Type.Optional(
    StringEnum(VALID_THINKING_LEVELS, {
      description:
        "Thinking: off/minimal/low/medium/high/xhigh/max; default agent/off",
    }),
  ),
  sessionId: Type.Optional(
    Type.String({
      description: "Persistent session name for multi-turn reuse.",
    }),
  ),
  action: Type.Optional(
    StringEnum(["prompt", "close", "list"], {
      description:
        "Session action; close requires sessionId. list shows history.",
      default: "prompt",
    }),
  ),
  resumeFrom: Type.Optional(
    Type.String({
      description: "Absolute prior .jsonl path; not for async tickets.",
    }),
  ),
});

// Single source of truth for registration, generated help, and the
// DelegateParams/TaskDef projections in types.ts.
export const delegateParameters = Type.Object({
  action: Type.Optional(
    StringEnum(["poll", "cancel", "wait"], {
      description:
        "Poll, cancel, or wait on an async ticket. Prefer wait; do not cancel for time or zero results.",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description:
        "Background work returns a ticket ID. Results delivered automatically; use wait, not polling.",
      default: false,
    }),
  ),
  ticket: Type.Optional(
    Type.String({
      description: "Ticket ID; omit only when polling to list all.",
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set true to cancel; omit for preview. May leave partial effects.",
      default: false,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: ASYNC_MAX_RUNTIME_MS,
      description: "Wait timeout (ms), max ticket runtime.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(delegateTaskParameters, {
      minItems: 0,
      description:
        "Fields belong in entries, never top-level; independent, sequential for shared files. []=help.",
      default: [],
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
 * - `tools` as a JSON string (or bare token) inside a task entry.
 * Skipped when a ticket action is in play. All other invalid input is left
 * for normal schema validation to reject loudly.
 *
 * Silent by design: these rewrites are lossless re-shaping, so unlike the
 * model-suffix warning in task-resolution (which fires because thinking
 * intent is discarded), recovery warrants no signal. */
export function prepareDelegateArguments(args: unknown): DelegateParams {
  if (!args || typeof args !== "object") return args as DelegateParams;
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

  // Stringified (or bare-token) `tools` inside task entries → real arrays.
  if (Array.isArray(record.tasks)) {
    record.tasks = record.tasks.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") return entry;
      const e = entry as Record<string, unknown>;
      if (typeof e.tools !== "string") return entry;
      return { ...e, tools: normalizeToolsField(e.tools) };
    });
  }

  return record as DelegateParams;
}

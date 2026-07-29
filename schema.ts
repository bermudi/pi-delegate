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
      description: "Model override; inherits parent. `:max` sets thinking.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Tool set: '*' (read/write/edit/bash) or 'ro' (read/grep/find/ls).",
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
        "Subagent tasks are independent; shared files/dependencies need sequential calls. Pass [] for help.",
      default: [],
    }),
  ),
});

/** Compatibility shim run by pi before schema validation. Some models send
 * `tasks` as a JSON string instead of an array; recover that shape here and
 * leave all other invalid input for normal schema validation. */
export function prepareDelegateArguments(args: unknown): DelegateParams {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.tasks === "string") {
      try {
        const parsed: unknown = JSON.parse(record.tasks);
        if (Array.isArray(parsed)) {
          return { ...record, tasks: parsed } as DelegateParams;
        }
      } catch {
        // Not JSON — leave as-is for schema validation to reject.
      }
    }
  }
  return args as DelegateParams;
}

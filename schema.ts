import { Type, type SchemaOptions } from "@sinclair/typebox";
import { VALID_THINKING_LEVELS } from "./constants.ts";
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
      description: "Configured agent name; omit for an inline custom agent.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Subagent working directory. Default: parent cwd.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description: "Inline system prompt; otherwise agent or parent prompt.",
    }),
  ),
  context: Type.Optional(
    StringEnum(["fresh", "with-parent-transcript"], {
      description: "Context mode; parent transcript is token-expensive.",
      default: "fresh",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Model override; omit to inherit the parent model.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tool names or '*' (full) / 'ro' (read-only).",
    }),
  ),
  thinking: Type.Optional(
    StringEnum(VALID_THINKING_LEVELS, {
      description: "Thinking level. Default: agent setting or off.",
    }),
  ),
  sessionId: Type.Optional(
    Type.String({
      description: "Persistent session name for multi-turn reuse.",
    }),
  ),
  action: Type.Optional(
    StringEnum(["prompt", "close", "list", "poll", "cancel"], {
      description: "Session action; poll/cancel are legacy ticket aliases.",
      default: "prompt",
    }),
  ),
  resumeFrom: Type.Optional(
    Type.String({
      description: "Absolute previous session .jsonl path to resume.",
    }),
  ),
});

// Single source of truth for registration, generated help, and the
// DelegateParams/TaskDef projections in types.ts.
export const delegateParameters = Type.Object({
  action: Type.Optional(
    StringEnum(["poll", "cancel"], {
      description: "Poll or cancel an async ticket.",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description: "Run in the background and return a ticket ID.",
      default: false,
    }),
  ),
  ticket: Type.Optional(
    Type.String({
      description: "Ticket ID for poll or cancel.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(delegateTaskParameters, {
      minItems: 0,
      description: "Parallel subagent tasks. Pass an empty array for help.",
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

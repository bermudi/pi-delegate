import { Type, type SchemaOptions } from "@sinclair/typebox";
import {
  VALID_THINKING_LEVELS,
  isSessionControlAction,
} from "./constants.ts";
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
        "Optional correlation key; duplicates rejected; omit for index.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Self-contained task prompt; fresh context cannot see this chat. Omit only for resumeFrom.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        "default mirrors the parent's tools; scout/coder/reviewer specialists. Ad-hoc tasks get * tools even when the parent is narrower.",
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
        "off/minimal/low/medium/high/xhigh/max. Omit for agents — it overrides delegate.json tiers; default inherits.",
    }),
  ),
  sessionId: Type.Optional(
    Type.String({
      description:
        "Live pool key for multi-turn reuse; omit for one-shot tasks.",
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
    StringEnum(["shared", "scratch", "isolated"], {
      description:
        "shared edits source; scratch discards; isolated orders Git worktree proposals; none confine access.",
    }),
  ),
});

// Single source of truth for registration and generated help. The exported
// argument types in types.ts project this canonical schema; providers see
// only these fields.
export const delegateArgumentsSchema = Type.Object(
  {
    ticketAction: Type.Optional(
      StringEnum(["poll", "cancel", "wait"], {
        description:
          "Ticket control: poll=snapshot; wait=block until settled; cancel=abort. Prefer wait; never cancel for time.",
      }),
    ),
    sessionAction: Type.Optional(
      StringEnum(["close", "list"], {
        description:
          '"close" ends the named pooled session; "list" lists active ones. Runs instead of tasks.',
      }),
    ),
    sessionId: Type.Optional(
      Type.String({
        description:
          'With "close": the pooled session to end. Alone, a sessionId folds into a task as reuse.',
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
  },
  { additionalProperties: false },
);

/** Fields that belong to a task entry. Models sometimes place these at the top
 * level of the arguments; the normalizer folds them back into a single task.
 * `sessionAction` is NOT here: it was promoted to a top-level field (#32), so
 * top-level presence means session-RPC intent, not task intent — the classifier
 * and its mode validators own it now. */
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

/** Task fields that are known spellings of top-level fields — rejected inside
 * task entries with a corrective hint pointing at their real home. */
const TOP_LEVEL_TASK_KEY_HINTS = new Set(["async", "sessionAction"]);

/** Validate the four operation modes after compatibility reshaping.
 *
 * One classifier with fixed precedence runs first: `ticketAction` → ticket
 * RPC; `sessionAction` → session RPC; non-empty `tasks` → dispatch; otherwise
 * help. Each mode gets a small total validator that rejects foreign fields
 * generically (naming the offending field and the fix), so ordering is no
 * longer load-bearing across checks and a new field costs one schema entry
 * plus one mode check. */
export function validateDelegateOperation(
  params: DelegateArguments,
): string | undefined {
  const rawParams = params as Record<string, unknown>;
  if ("action" in rawParams) {
    return (
      "unsupported field 'action'; use 'ticketAction' for poll/cancel/wait " +
      "or 'sessionAction' for close/list."
    );
  }

  // Mode classification — precedence by selector presence.
  if (params.ticketAction !== undefined) {
    return validateTicketMode(params);
  }
  if (params.sessionAction !== undefined) {
    return validateSessionMode(params);
  }
  return validateDispatchOrHelpMode(params);
}

/** Fields recognized at the top level in session mode: the selector itself
 * plus its target. Anything else (ticket fields, async, tasks, stray task
 * fields) is foreign to session RPC. */
const SESSION_MODE_FIELDS = new Set(["sessionAction", "sessionId"]);

/** Session RPC: one close/list action per call against one pooled session. */
function validateSessionMode(params: DelegateArguments): string | undefined {
  const rawParams = params as Record<string, unknown>;
  const { sessionAction } = params;
  // Nothing strips or defaults anymore; any value besides 'close'/'list'
  // fails closed below rather than misclassifying.
  if (!isSessionControlAction(sessionAction)) {
    return `sessionAction '${String(sessionAction)}' is not a session control action; use 'close' or 'list'.`;
  }
  if (sessionAction === "close" && !params.sessionId) {
    return "sessionAction 'close' requires sessionId.";
  }
  const foreign = Object.keys(rawParams).filter(
    (key) => !SESSION_MODE_FIELDS.has(key),
  );
  if (foreign.length) {
    return `sessionAction '${sessionAction}' cannot be combined with ${foreign
      .map((field) => `'${field}'`)
      .join(", ")}; run it alone — a session action takes only 'sessionAction' (plus 'sessionId' for 'close').`;
  }
  return undefined;
}

/** Ticket RPC: `ticketAction` owns the call; every other field family is
 * foreign. Note `sessionAction` must be listed explicitly: it left
 * `TASK_FIELD_NAMES` when it was promoted to top level, and without owning it
 * here the old task-level exclusion would silently evaporate. */
function validateTicketMode(params: DelegateArguments): string | undefined {
  const rawParams = params as Record<string, unknown>;
  const ticketAction = params.ticketAction;
  const incompatibleFields = (
    [...TASK_FIELD_NAMES, "tasks", "sessionAction"] as const
  ).filter((field) => rawParams[field] !== undefined);
  if (incompatibleFields.length) {
    return `ticket control cannot be combined with field(s) ${incompatibleFields
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

/** Dispatch (non-empty `tasks`) or help (empty/absent). Stray ticket- and
 * session-mode selectors are foreign here and rejected generically. */
function validateDispatchOrHelpMode(
  params: DelegateArguments,
): string | undefined {
  const rawParams = params as Record<string, unknown>;
  const tasks = params.tasks ?? [];

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

  if (params.async && tasks.some((task) => task.workspace === "isolated")) {
    return 'workspace "isolated" is synchronous; remove async.';
  }

  // Reject mixed shapes: flat task fields at the top level alongside a
  // nonempty tasks array. The normalize shim only wraps flat fields when
  // there is no tasks array, so a mixed call silently lets tasks win —
  // a model mistake that should fail loudly.
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

  for (const [index, task] of tasks.entries()) {
    const rawTask = task as Record<string, unknown>;

    const unknownKeys = Object.keys(rawTask).filter(
      (key) => !VALID_TASK_KEYS.has(key),
    );
    if (unknownKeys.length) {
      const misplacedTopLevel = unknownKeys.filter((key) =>
        TOP_LEVEL_TASK_KEY_HINTS.has(key),
      );
      const topLevelHint = misplacedTopLevel.length
        ? ` ${misplacedTopLevel.map((key) => `'${key}'`).join(" and ")} ${misplacedTopLevel.length === 1 ? "is a" : "are"} top-level field${misplacedTopLevel.length === 1 ? "" : "s"}; move ${misplacedTopLevel.length === 1 ? "it" : "them"} out of the task entry.`
        : "";
      return (
        `task ${index + 1}: unknown field(s) ${unknownKeys
          .map((key) => `'${key}'`)
          .join(", ")}.${topLevelHint} ` +
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
      (task.workspace === "scratch" || task.workspace === "isolated") &&
      (task.sessionId || task.resumeFrom)
    ) {
      return `task ${index + 1}: workspace '${task.workspace}' is one-shot and cannot be combined with sessionId or resumeFrom. Set workspace: "shared" to use a persistent agent.`;
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

/** True when `record` carries top-level session-RPC intent: an explicit
 * close/list `sessionAction`. A bare top-level `sessionId` is deliberately
 * NOT session intent — it stays task-intent and wraps into a task as reuse.
 * Only `sessionAction` presence selects the session mode. */
function hasSessionControlIntent(record: Record<string, unknown>): boolean {
  return isSessionControlAction(record.sessionAction);
}

/** Fold top-level task fields into a single `tasks` entry. Only fires when
 * there is no usable tasks array and neither ticket-control intent nor
 * session-control intent makes those calls legitimately taskless.
 * `sessionAction` is not part of `TASK_FIELD_NAMES`: a top-level close/list
 * means session RPC and must reach the classifier unwrapped — wrapping first
 * would swallow stray fields into a task instead of rejecting them. */
function wrapFlatTaskFields(record: Record<string, unknown>): void {
  const hasTasks = Array.isArray(record.tasks) && record.tasks.length > 0;
  if (
    hasTasks ||
    hasTicketControlIntent(record) ||
    hasSessionControlIntent(record)
  ) {
    return;
  }
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
 *   level instead of inside a `tasks` entry — wrapped into a single task,
 *   unless ticket- or session-control intent makes the call legitimately
 *   taskless (see `hasTicketControlIntent` / `hasSessionControlIntent`);
 * - `tools` as a JSON string (or bare token) inside a task entry;
 * - `agent: ""` inside a task entry — treated as omitted (ad-hoc);
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

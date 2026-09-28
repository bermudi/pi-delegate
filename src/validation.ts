import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveDependencyGraph } from "./graph.ts";
import { canonicalAgentName, expandTools } from "./profiles.ts";
import type { FieldNormalization } from "./types.ts";

export interface TaskInput {
  readonly id?: string;
  readonly prompt?: string;
  readonly agent?: string;
  readonly cwd?: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly tools?: string[];
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly sessionId?: string;
  readonly resumeFrom?: string;
  readonly deadlineMs?: number;
  readonly workspace?: "shared" | "scratch" | "isolated";
  readonly dependsOn?: string[];
  // Cross-harness compatibility spellings (SPEC v3 "Reflex meeting") —
  // folded into canonical fields by validateDispatchCall before any
  // semantic read, with each applied rename recorded on normalizedFrom.
  readonly subagent_type?: string;
  readonly agent_type?: string;
  readonly task_name?: string;
  readonly message?: string;
  readonly description?: string;
  readonly run_in_background?: boolean;
  /**
   * Trained effort selector under a second spelling (#44): rejected like
   * `thinking` wherever it appears — callers never pick subagent effort.
   */
  readonly reasoning_effort?: string;
  /**
   * Internal: compat spellings already folded into this task. Stamped by
   * validation, never accepted from the wire (the task schema's
   * additionalProperties: false rejects it there).
   */
  readonly normalizedFrom?: readonly FieldNormalization[];
}

export type DispatchCall =
  | { readonly mode: "help" }
  | {
      readonly mode: "dispatch";
      readonly tasks: readonly TaskInput[];
      readonly async: boolean;
      /**
       * The shared batch brief (SPEC v3 "Batch brief") — normalized: the
       * `context` compat spelling lands here too; a whitespace-only value
       * is absent. Prepended to every task's prompt at dispatch.
       */
      readonly brief: string | undefined;
      readonly operationId: string | undefined;
      /**
       * Applied dispatch-level compat renames (top-level
       * `run_in_background` → `async`); per-task renames ride each
       * task's `normalizedFrom`. Rendered as teaching notes on the
       * result/receipt (SPEC v3 "Reflex meeting").
       */
      readonly callNotes: readonly FieldNormalization[];
    };

/** Post-schema delegate_ticket arguments. */
export interface TicketArguments {
  readonly action:
    | "poll"
    | "wait"
    | "cancel"
    | "pause"
    | "resume"
    | "answer"
    | "steer"
    | "interrupt";
  readonly ticket?: string;
  readonly timeoutMs?: number;
  /** Cross-harness spelling of `timeoutMs`; folds with a rename note. */
  readonly timeout_ms?: number;
  readonly force?: boolean;
  readonly taskId?: string;
  readonly questionId?: string;
  readonly answer?: string;
  readonly message?: string;
  readonly steerId?: string;
}

/** Post-schema delegate_session arguments. */
export interface SessionArguments {
  readonly action: "list" | "close";
  readonly sessionId?: string;
}

/** Post-schema delegate arguments; `tasks` is required by the tool schema. */
export interface DispatchArguments {
  readonly tasks: readonly TaskInput[];
  readonly async?: boolean;
  /** Cross-harness spelling of `async`; normalizes into the dispatch decision. */
  readonly run_in_background?: boolean;
  /** Batch-level workspace default; a task's own `workspace` wins. */
  readonly workspace?: "shared" | "scratch" | "isolated";
  /**
   * Shared batch brief (SPEC v3 "Batch brief"): context every task needs,
   * prepended to each prompt as a delimited preamble.
   */
  readonly brief?: string;
  /** Cross-harness spelling of `brief`; normalizes into it. */
  readonly context?: string;
  readonly operationId?: string;
}

/** A validated delegate_ticket call; blank optionals normalized to absent. */
export interface TicketCall {
  readonly action:
    | "poll"
    | "wait"
    | "cancel"
    | "pause"
    | "resume"
    | "answer"
    | "steer"
    | "interrupt";
  readonly ticket: string | undefined;
  readonly force: boolean;
  readonly timeoutMs: number | undefined;
  readonly taskId: string | undefined;
  readonly questionId: string | undefined;
  readonly answer: string | undefined;
  readonly message: string | undefined;
  readonly steerId: string | undefined;
  /**
   * Applied compat renames on the ticket boundary (currently
   * `timeout_ms` → `timeoutMs`), rendered as teaching notes on the
   * receipt — the same convention as dispatch's `normalizedFrom`.
   */
  readonly notes: readonly FieldNormalization[];
}

/** A validated delegate_session call. */
export interface SessionCall {
  readonly action: "list" | "close";
  readonly sessionId: string | undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Empty or whitespace-only string; presence-shaped requirements treat it as absent. */
function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

/**
 * Callers never select subagent models (SPEC "Dispatch"). The same text
 * rejects `model` wherever it appears — inside a task, folded into one, or
 * stranded at the top level — so it is shared with the boundary layer.
 */
export const MODEL_FIELD_REJECTION =
  `the model field is not accepted — callers do not select subagent models. ` +
  `Remove it: the task runs on the parent's model, or on the model the user ` +
  `configured for its agent under "models" in the delegate.json config.`;

/**
 * The no-caller-effort teaching text, parameterized by the spelling the
 * caller used (SPEC "Dispatch"): effort is user-configured via `:effort`
 * suffixes on "models"/"modelsByParent" entries. `thinking` and
 * `reasoning_effort` (#44) are the two trained names for the same wall —
 * same everywhere-it-appears rejection as `model`, naming its own field.
 */
const effortFieldRejection = (field: string): string =>
  `the ${field} field is not accepted — callers do not select subagent effort. ` +
  `Remove it: the task runs at the configured :effort for its agent, or at ` +
  `the parent's level when it runs on the parent's model.`;

export const THINKING_FIELD_REJECTION = effortFieldRejection("thinking");

/** `reasoning_effort` hits the same wall as `thinking` (SPEC "Dispatch"). */
export const REASONING_EFFORT_FIELD_REJECTION =
  effortFieldRejection("reasoning_effort");

/**
 * Within-tool rules for `delegate_ticket`: `ticket` is required for every
 * action except `poll` (bare poll is the roster), `force` only accompanies
 * `cancel`, `timeoutMs` only `wait`, `taskId` belongs to `answer`,
 * `steer`, and `interrupt`, `questionId`/`answer` belong to `answer` alone
 * — which requires all three — and `message`/`steerId` belong to `steer`,
 * which requires the message (`steerId` is optional — omitted, the ticket
 * boundary derives an idempotency key from the calling tool call).
 * Conditional carries are reported before missing
 * requirements, matching the historical precedence; blank values count as
 * missing.
 */
export function validateTicketCall(args: TicketArguments): TicketCall {
  const ticket = isBlank(args.ticket) ? undefined : args.ticket;
  const taskId = isBlank(args.taskId) ? undefined : args.taskId;
  const questionId = isBlank(args.questionId) ? undefined : args.questionId;
  const answer = isBlank(args.answer) ? undefined : args.answer;
  const message = isBlank(args.message) ? undefined : args.message;
  const steerId = isBlank(args.steerId) ? undefined : args.steerId;
  if (args.force === true && args.action !== "cancel") {
    fail(`force is valid only with action "cancel".`);
  }
  // `timeout_ms` is `timeoutMs` under a cross-harness spelling (SPEC v3
  // "Reflex meeting"): it folds with a rename note; both spellings holding
  // different values conflicts, like the dispatch-level folds.
  const notes: FieldNormalization[] = [];
  if (
    args.timeoutMs !== undefined &&
    args.timeout_ms !== undefined &&
    args.timeoutMs !== args.timeout_ms
  ) {
    fail(
      `'timeoutMs' (${args.timeoutMs}) and 'timeout_ms' (${args.timeout_ms}) disagree — they are the same field under two spellings; send one.`,
    );
  }
  const timeoutMs = args.timeoutMs ?? args.timeout_ms;
  if (args.timeout_ms !== undefined) {
    notes.push({ field: "timeout_ms", to: "timeoutMs" });
  }
  if (timeoutMs !== undefined && args.action !== "wait") {
    fail(
      `${args.timeout_ms !== undefined && args.timeoutMs === undefined ? "timeout_ms" : "timeoutMs"} is valid only with action "wait".`,
    );
  }
  if (
    taskId !== undefined &&
    args.action !== "answer" &&
    args.action !== "steer" &&
    args.action !== "interrupt"
  ) {
    fail(`taskId is valid only with actions "answer", "steer", and "interrupt".`);
  }
  for (const [name, value] of [
    ["questionId", questionId],
    // `answer` uses raw presence: an out-of-place blank reply is a
    // malformed call, not an absent field. Blank = missing only inside
    // action "answer", where it fails the nonempty requirement. `message`
    // and `steerId` follow the same convention for action "steer".
    ["answer", args.answer],
    ["message", args.message],
    ["steerId", args.steerId],
  ] as const) {
    const belongs =
      name === "questionId" || name === "answer"
        ? args.action === "answer"
        : args.action === "steer";
    if (!belongs && value !== undefined) {
      const action = name === "questionId" || name === "answer" ? "answer" : "steer";
      fail(`${name} is valid only with action "${action}".`);
    }
  }
  if (args.action === "answer") {
    if (taskId === undefined) fail(`action "answer" requires taskId.`);
    if (questionId === undefined) fail(`action "answer" requires questionId.`);
    if (answer === undefined) {
      fail(`action "answer" requires a nonempty answer.`);
    }
  }
  if (args.action === "steer") {
    if (message === undefined) {
      fail(`action "steer" requires a nonempty message.`);
    }
    // `steerId` is optional (#44): omitted, the ticket boundary derives
    // `steer:<toolCallId>` — an idempotent key for transport-level retries.
    // Explicit ids stay caller-owned and keep the strict charset; ':' is
    // admitted so a receipt's derived key can be echoed back verbatim.
    if (steerId !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(steerId)) {
      fail(
        `steerId '${steerId}' is outside the id charset (letters, digits, '.', '_', '-', ':', at most 64 chars).`,
      );
    }
  }
  if (args.action !== "poll" && ticket === undefined) {
    fail(`action "${args.action}" requires a ticket id in the ticket field.`);
  }
  return {
    action: args.action,
    ticket,
    force: args.force === true,
    timeoutMs,
    taskId,
    questionId,
    answer,
    message,
    steerId,
    notes,
  };
}

/**
 * Within-tool rules for `delegate_session`: `close` requires `sessionId`
 * and `list` rejects it.
 */
export function validateSessionCall(args: SessionArguments): SessionCall {
  const sessionId = isBlank(args.sessionId) ? undefined : args.sessionId;
  if (args.action === "close") {
    if (sessionId === undefined) fail(`action "close" requires a sessionId.`);
  } else if (sessionId !== undefined) {
    fail(`sessionId is valid only with action "close".`);
  }
  return { action: args.action, sessionId };
}

/**
 * Semantic validation for `delegate`. An empty task list is the manual
 * call — dispatch-owned fields orphaned there are help-mode violations —
 * and a non-empty list is validated whole before any task starts.
 */
export function validateDispatchCall(args: DispatchArguments): DispatchCall {
  if (args.tasks.length === 0) {
    if (args.async === true || args.run_in_background === true) {
      fail(`async dispatch requires at least one task.`);
    }
    if (args.workspace !== undefined) {
      fail(`workspace requires at least one task; it is a dispatch field.`);
    }
    if (args.brief !== undefined || args.context !== undefined) {
      fail(`brief requires at least one task; it is a dispatch field.`);
    }
    if (args.operationId !== undefined) {
      fail(`operationId requires a non-empty dispatch task list.`);
    }
    return { mode: "help" };
  }

  // SPEC v3 "Reflex meeting": cross-harness field spellings fold into the
  // canonical fields here — before agent resolution reads `agent`, so the
  // alias table applies to `subagent_type` values too — and each applied
  // rename records a teaching note on the task's `normalizedFrom`.
  const effectiveTasks = args.tasks.map((task, index) => {
    const where = `tasks[${index}]${task.id ? ` (id '${task.id}')` : ""}`;
    const notes: FieldNormalization[] = [];
    // `agent` has three spellings (SPEC v3 "Reflex meeting"): `agent`,
    // `subagent_type`, `agent_type`. All present spellings must name the
    // same canonical agent; each compat spelling records a rename note.
    const agentSpellings = (
      [
        ["agent", task.agent],
        ["subagent_type", task.subagent_type],
        ["agent_type", task.agent_type],
      ] as readonly (readonly [string, string | undefined])[]
    ).filter((pair): pair is readonly [string, string] => pair[1] !== undefined);
    const distinctAgents = new Set(
      agentSpellings.map(([, value]) => canonicalAgentName(value)),
    );
    if (distinctAgents.size > 1) {
      fail(
        `${where}: ${agentSpellings
          .map(([field, value]) => `'${field}' (${JSON.stringify(value)})`)
          .join(", ")} name different agents — they are the same field under different spellings; send one.`,
      );
    }
    const agent = agentSpellings[0]?.[1];
    for (const [field] of agentSpellings) {
      if (field !== "agent") notes.push({ field, to: "agent" });
    }
    // `task_name`/`message` are spawn_agent's spellings of `id`/`prompt`
    // (#44): same fold — both present and differing is a conflict.
    let id = task.id;
    if (task.task_name !== undefined) {
      if (task.id !== undefined && task.id !== task.task_name) {
        fail(
          `${where}: 'id' (${JSON.stringify(task.id)}) and 'task_name' (${JSON.stringify(task.task_name)}) name different ids — they are the same field under two spellings; send one.`,
        );
      }
      id = task.id ?? task.task_name;
      notes.push({ field: "task_name", to: "id" });
    }
    let prompt = task.prompt;
    if (task.message !== undefined) {
      if (task.prompt !== undefined && task.prompt !== task.message) {
        fail(
          `${where}: 'prompt' and 'message' hold different text — they are the same field under two spellings; send one.`,
        );
      }
      prompt = task.prompt ?? task.message;
      notes.push({ field: "message", to: "prompt" });
    }
    if (task.run_in_background !== undefined) {
      notes.push({ field: "run_in_background", to: "async" });
    }
    const {
      subagent_type: _subagent_type,
      agent_type: _agent_type,
      task_name: _task_name,
      message: _message,
      run_in_background,
      ...rest
    } = task;
    const normalized: TaskInput = {
      ...rest,
      ...(id === undefined ? {} : { id }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(agent === undefined ? {} : { agent }),
    };
    return {
      ...normalized,
      ...(notes.length > 0 ? { normalizedFrom: notes } : {}),
      ...(task.workspace === undefined && args.workspace !== undefined
        ? { workspace: args.workspace }
        : {}),
    };
  });
  validateTasks(effectiveTasks);

  // `run_in_background` is the same dispatch-level `async` under a
  // cross-harness spelling — legal at top level and per task. Every
  // occurrence names one decision, so all must agree; `async` wins when
  // it agrees, and a value conflict names both fields.
  const ribs: { readonly value: boolean; readonly where: string }[] = [];
  if (args.run_in_background !== undefined) {
    ribs.push({ value: args.run_in_background, where: "the top level" });
  }
  args.tasks.forEach((task, index) => {
    if (task.run_in_background !== undefined) {
      ribs.push({ value: task.run_in_background, where: `tasks[${index}]` });
    }
  });
  const firstRib = ribs[0];
  const clash = ribs.find((rib) => rib.value !== firstRib?.value);
  if (firstRib !== undefined && clash !== undefined) {
    fail(
      `'run_in_background' conflicts: ${firstRib.where} sets ${firstRib.value} but ${clash.where} sets ${clash.value} — it is one dispatch-level decision (it normalizes to 'async'); set it once.`,
    );
  }
  if (
    args.async !== undefined &&
    firstRib !== undefined &&
    args.async !== firstRib.value
  ) {
    fail(
      `'async': ${args.async} conflicts with 'run_in_background': ${firstRib.value} — the same dispatch field under two spellings; send one.`,
    );
  }
  // `context` is the batch `brief` under a cross-harness spelling
  // (SPEC v3 "Reflex meeting"): it folds into `brief` with a teaching
  // note, and both spellings holding different text conflicts. A
  // whitespace-only brief prepends nothing — it reads as absent.
  if (
    args.brief !== undefined &&
    args.context !== undefined &&
    args.brief !== args.context
  ) {
    fail(
      `'brief' and 'context' hold different text — they are the same batch field under two spellings; send one.`,
    );
  }
  const rawBrief = args.brief ?? args.context;
  const brief =
    rawBrief !== undefined && rawBrief.trim() !== "" ? rawBrief : undefined;
  const callNotes: FieldNormalization[] = [
    ...(args.run_in_background === undefined
      ? []
      : [{ field: "run_in_background", to: "async" }]),
    ...(args.context === undefined ? [] : [{ field: "context", to: "brief" }]),
  ];
  return {
    mode: "dispatch",
    tasks: effectiveTasks,
    brief,
    // SPEC v3 "Interaction grammar" — cardinality defaults: a single task
    // runs sync inline; a multi-task batch returns a ticket and
    // auto-delivers. `async` (or its run_in_background spelling)
    // overrides in both directions.
    async: args.async ?? firstRib?.value ?? effectiveTasks.length > 1,
    operationId: args.operationId,
    callNotes,
  };
}

/** Batch-level checks over normalized tasks; all run before any task starts. */
function validateTasks(tasks: readonly TaskInput[]): void {
  const ids = new Set<string>();
  const sessionIds = new Set<string>();
  tasks.forEach((task, index) => {
    const where = `tasks[${index}]${task.id ? ` (id '${task.id}')` : ""}`;
    if (task.id !== undefined) {
      if (ids.has(task.id)) {
        fail(`Duplicate task id '${task.id}'; task ids must be unique within a call.`);
      }
      ids.add(task.id);
    }
    if (task.sessionId !== undefined) {
      if (task.sessionId.trim() === "") {
        fail(`${where}: sessionId must be a non-empty string.`);
      }
      if (sessionIds.has(task.sessionId)) {
        fail(
          `Duplicate sessionId '${task.sessionId}'; a session cannot run two tasks at once.`,
        );
      }
      sessionIds.add(task.sessionId);
    }
    if (task.model !== undefined) {
      fail(`${where}: ${MODEL_FIELD_REJECTION}`);
    }
    if (task.thinking !== undefined) {
      fail(`${where}: ${THINKING_FIELD_REJECTION}`);
    }
    if (task.reasoning_effort !== undefined) {
      fail(`${where}: ${REASONING_EFFORT_FIELD_REJECTION}`);
    }
    if (task.prompt !== undefined && task.prompt.trim() === "") {
      fail(`${where}: prompt must be a non-empty string.`);
    }
    if (task.description !== undefined && task.description.length > 200) {
      fail(
        `${where}: description must be at most 200 characters; got ${task.description.length}.`,
      );
    }
    if (task.systemPrompt !== undefined && task.systemPrompt.trim() === "") {
      // Blank stays invalid for non-identifier fields (SPEC "Input
      // recovery"): a blank systemPrompt would otherwise override — and
      // silently erase — the profile's base prompt.
      fail(`${where}: systemPrompt must be a non-empty string.`);
    }
    if (task.prompt === undefined && task.resumeFrom === undefined) {
      fail(`${where}: a task needs a prompt (prompt is optional only with resumeFrom).`);
    }
    if (task.deadlineMs !== undefined && task.deadlineMs <= 0) {
      fail(`${where}: deadlineMs must be positive; got ${task.deadlineMs}.`);
    }
    if (
      (task.workspace === "scratch" || task.workspace === "isolated") &&
      (task.sessionId !== undefined || task.resumeFrom !== undefined)
    ) {
      fail(
        `${where}: workspace "${task.workspace}" is one-shot and cannot be combined with sessionId or resumeFrom.`,
      );
    }
    if (task.resumeFrom !== undefined) {
      if (!isAbsolute(task.resumeFrom) || !task.resumeFrom.endsWith(".jsonl")) {
        fail(
          `${where}: resumeFrom must be an absolute path to a .jsonl session transcript; got '${task.resumeFrom}'.`,
        );
      }
      if (!existsSync(task.resumeFrom)) {
        fail(
          `${where}: resumeFrom transcript does not exist: '${task.resumeFrom}'.`,
        );
      }
    }
    // Agent-name existence is checked at resolution (host.ts), where the
    // discovered Markdown profile catalog is available — validating against
    // built-ins alone here would reject legitimate custom profiles.
    if (task.agent !== undefined && task.agent.trim() === "") {
      fail(`${where}: agent must be a non-empty name.`);
    }
    if (task.tools !== undefined) {
      const expanded = expandTools(task.tools);
      if (typeof expanded === "string") {
        fail(`${where}: ${expanded}`);
      }
    }
  });
  // The whole graph must validate before any task starts: unknown
  // references, self-dependencies, cycles, and ambiguous ids are
  // whole-call errors (SPEC "Dependencies and handoffs").
  resolveDependencyGraph(tasks);
}

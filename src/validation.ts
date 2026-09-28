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
  readonly description?: string;
  readonly run_in_background?: boolean;
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
    | "steer";
  readonly ticket?: string;
  readonly timeoutMs?: number;
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
    | "steer";
  readonly ticket: string | undefined;
  readonly force: boolean;
  readonly timeoutMs: number | undefined;
  readonly taskId: string | undefined;
  readonly questionId: string | undefined;
  readonly answer: string | undefined;
  readonly message: string | undefined;
  readonly steerId: string | undefined;
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
 * Callers never select subagent effort either (SPEC "Dispatch") — effort is
 * user-configured via `:effort` suffixes on "models"/"modelsByParent"
 * entries. Same everywhere-it-appears rejection as `model`.
 */
export const THINKING_FIELD_REJECTION =
  `the thinking field is not accepted — callers do not select subagent effort. ` +
  `Remove it: the task runs at the configured :effort for its agent, or at ` +
  `the parent's level when it runs on the parent's model.`;

/**
 * Within-tool rules for `delegate_ticket`: `ticket` is required for every
 * action except `poll` (bare poll is the roster), `force` only accompanies
 * `cancel`, `timeoutMs` only `wait`, `taskId` belongs to `answer` and
 * `steer`, `questionId`/`answer` belong to `answer` alone — which requires
 * all three — and `message`/`steerId` belong to `steer`, which requires
 * both. Conditional carries are reported before missing requirements,
 * matching the historical precedence; blank values count as missing.
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
  if (args.timeoutMs !== undefined && args.action !== "wait") {
    fail(`timeoutMs is valid only with action "wait".`);
  }
  if (taskId !== undefined && args.action !== "answer" && args.action !== "steer") {
    fail(`taskId is valid only with actions "answer" and "steer".`);
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
    if (steerId === undefined) {
      fail(`action "steer" requires steerId — a caller-chosen idempotency key for safe retry.`);
    }
    // Same charset and length as task correlation ids.
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(steerId)) {
      fail(
        `steerId '${steerId}' is outside the id charset (letters, digits, '.', '_', '-', at most 64 chars).`,
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
    timeoutMs: args.timeoutMs,
    taskId,
    questionId,
    answer,
    message,
    steerId,
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
    let agent = task.agent;
    if (task.subagent_type !== undefined) {
      if (
        task.agent !== undefined &&
        canonicalAgentName(task.agent) !== canonicalAgentName(task.subagent_type)
      ) {
        fail(
          `${where}: 'agent' (${JSON.stringify(task.agent)}) and 'subagent_type' (${JSON.stringify(task.subagent_type)}) name different agents — they are the same field under two spellings; send one.`,
        );
      }
      agent = task.agent ?? task.subagent_type;
      notes.push({ field: "subagent_type", to: "agent" });
    }
    if (task.run_in_background !== undefined) {
      notes.push({ field: "run_in_background", to: "async" });
    }
    const { subagent_type, run_in_background, ...rest } = task;
    const normalized: TaskInput =
      agent === undefined ? { ...rest } : { ...rest, agent };
    if (notes.length > 0) {
      return {
        ...normalized,
        normalizedFrom: notes,
        ...(task.workspace === undefined && args.workspace !== undefined
          ? { workspace: args.workspace }
          : {}),
      };
    }
    return task.workspace === undefined && args.workspace !== undefined
      ? { ...normalized, workspace: args.workspace }
      : normalized;
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
  const callNotes: FieldNormalization[] =
    args.run_in_background === undefined
      ? []
      : [{ field: "run_in_background", to: "async" }];
  return {
    mode: "dispatch",
    tasks: effectiveTasks,
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

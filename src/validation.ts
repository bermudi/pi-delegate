import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveDependencyGraph } from "./graph.ts";
import { expandTools, getBuiltinProfile, knownAgentNames } from "./profiles.ts";

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
}

export type DispatchCall =
  | { readonly mode: "help" }
  | {
      readonly mode: "dispatch";
      readonly tasks: readonly TaskInput[];
      readonly async: boolean;
      readonly operationId: string | undefined;
    };

/** Post-schema delegate_ticket arguments. */
export interface TicketArguments {
  readonly action: "poll" | "wait" | "cancel" | "pause" | "resume" | "answer";
  readonly ticket?: string;
  readonly timeoutMs?: number;
  readonly force?: boolean;
  readonly taskId?: string;
  readonly questionId?: string;
  readonly answer?: string;
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
  /** Batch-level workspace default; a task's own `workspace` wins. */
  readonly workspace?: "shared" | "scratch" | "isolated";
  readonly operationId?: string;
}

/** A validated delegate_ticket call; blank optionals normalized to absent. */
export interface TicketCall {
  readonly action: "poll" | "wait" | "cancel" | "pause" | "resume" | "answer";
  readonly ticket: string | undefined;
  readonly force: boolean;
  readonly timeoutMs: number | undefined;
  readonly taskId: string | undefined;
  readonly questionId: string | undefined;
  readonly answer: string | undefined;
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
 * `cancel`, `timeoutMs` only `wait`, and `taskId`/`questionId`/`answer`
 * belong to `answer` alone — which requires all three. Conditional carries
 * are reported before missing requirements, matching the historical
 * precedence; blank values count as missing.
 */
export function validateTicketCall(args: TicketArguments): TicketCall {
  const ticket = isBlank(args.ticket) ? undefined : args.ticket;
  const taskId = isBlank(args.taskId) ? undefined : args.taskId;
  const questionId = isBlank(args.questionId) ? undefined : args.questionId;
  const answer = isBlank(args.answer) ? undefined : args.answer;
  if (args.force === true && args.action !== "cancel") {
    fail(`force is valid only with action "cancel".`);
  }
  if (args.timeoutMs !== undefined && args.action !== "wait") {
    fail(`timeoutMs is valid only with action "wait".`);
  }
  for (const [name, value] of [
    ["taskId", taskId],
    ["questionId", questionId],
    // `answer` uses raw presence: an out-of-place blank reply is a
    // malformed call, not an absent field. Blank = missing only inside
    // action "answer", where it fails the nonempty requirement.
    ["answer", args.answer],
  ] as const) {
    if (args.action !== "answer" && value !== undefined) {
      fail(`${name} is valid only with action "answer".`);
    }
  }
  if (args.action === "answer") {
    if (taskId === undefined) fail(`action "answer" requires taskId.`);
    if (questionId === undefined) fail(`action "answer" requires questionId.`);
    if (answer === undefined) {
      fail(`action "answer" requires a nonempty answer.`);
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
    if (args.async === true) {
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

  // The batch-level workspace is a default: tasks that name their own keep it.
  const effectiveTasks =
    args.workspace === undefined
      ? args.tasks
      : args.tasks.map((task) =>
          task.workspace === undefined
            ? { ...task, workspace: args.workspace }
            : task,
        );
  validateTasks(effectiveTasks);
  return {
    mode: "dispatch",
    tasks: effectiveTasks,
    async: args.async === true,
    operationId: args.operationId,
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
    if (task.agent !== undefined && getBuiltinProfile(task.agent) === undefined) {
      fail(
        `${where}: unknown agent '${task.agent}'. Known agents: ${knownAgentNames().join(", ")}.`,
      );
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

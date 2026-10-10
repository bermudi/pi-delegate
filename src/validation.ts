import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveDependencyGraph } from "./graph.ts";
import { expandTools } from "./profiles.ts";

export interface TaskInput {
  readonly id?: string;
  readonly prompt?: string;
  readonly agent?: string;
  readonly cwd?: string;
  readonly systemPrompt?: string;
  readonly tools?: string[];
  readonly sessionId?: string;
  readonly resumeFrom?: string;
  readonly workspace?: "shared" | "scratch" | "isolated";
  readonly dependsOn?: string[];
}

export type DispatchCall =
  | { readonly mode: "help" }
  | {
      readonly mode: "dispatch";
      readonly tasks: readonly TaskInput[];
      readonly async: boolean;
      /**
       * The shared batch brief (SPEC v3 "Batch brief"); a whitespace-only
       * value is absent. Prepended to every task's prompt at dispatch.
       */
      readonly brief: string | undefined;
    };

/** Post-schema delegate_ticket arguments. */
export interface TicketArguments {
  readonly action:
    | "poll"
    | "wait"
    | "cancel"
    | "answer"
    | "steer"
    | "interrupt";
  readonly ticket?: string;
  readonly force?: boolean;
  readonly taskId?: string;
  readonly questionId?: string;
  readonly answer?: string;
  readonly message?: string;
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
  /**
   * Shared batch brief (SPEC v3 "Batch brief"): context every task needs,
   * prepended to each prompt as a delimited preamble.
   */
  readonly brief?: string;
  /**
   * Shared batch token ceiling (SPEC v3 "Batch token budget"): settled
   * tasks' recorded usage counts against it; once exhausted, queued tasks
   * settle `budget-exhausted` — running tasks always finish.
   */
  readonly tokenBudget?: number;
}

/** A validated delegate_ticket call; blank optionals normalized to absent. */
export interface TicketCall {
  readonly action:
    | "poll"
    | "wait"
    | "cancel"
    | "answer"
    | "steer"
    | "interrupt";
  readonly ticket: string | undefined;
  readonly force: boolean;
  readonly taskId: string | undefined;
  readonly questionId: string | undefined;
  readonly answer: string | undefined;
  readonly message: string | undefined;
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
 * rejects `model` wherever it appears — inside a task or stranded at the
 * top level — so it is shared with the boundary layer.
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
 * The character cap on each task `prompt` and the shared batch `brief`
 * (#121, the 2026-10-04 stream-livelock incident class). Delegate owns
 * the extreme argument-size tail callers emit — measured maxima reach
 * 923,192 bytes of arguments while legitimate prompts peak under 8k
 * chars — so an inlined-content blob bloats accepted-call context and
 * stretches the fragile tool-argument stream that upstream parser bugs
 * feed on. The remedy the rejection teaches: reference files by path;
 * subagents read the working tree themselves.
 */
export const PROMPT_CHAR_LIMIT = 32_768;

/** The shared teaching tail for oversized prompts and briefs (#121). */
const oversizedPromptRemedy =
  `Reference files by path instead of inlining their contents — ` +
  `the subagent reads the working tree itself.`;

/**
 * Within-tool rules for `delegate_ticket`: `ticket` is required for every
 * action except `poll` (bare poll is the roster), `force` only accompanies
 * `cancel`, `taskId` belongs to `answer`,
 * `steer`, and `interrupt` — a `<ticket>#<task>` compound in it
 * carries its own ticket, making the `ticket` field optional (#53) —
 * `questionId`/`answer` belong to
 * `answer` alone — which requires all three — and `message`
 * belongs to `steer`, which requires the message (the steer key is
 * omitted, the ticket boundary derives an idempotency key from the
 * Conditional carries are reported before missing
 * requirements, matching the historical precedence; blank values count as
 * missing.
 */
export function validateTicketCall(args: TicketArguments): TicketCall {
  let ticket = isBlank(args.ticket) ? undefined : args.ticket;
  const taskId = isBlank(args.taskId) ? undefined : args.taskId;
  const questionId = isBlank(args.questionId) ? undefined : args.questionId;
  const answer = isBlank(args.answer) ? undefined : args.answer;
  const message = isBlank(args.message) ? undefined : args.message;
  if (args.force === true && args.action !== "cancel") {
    fail(`force is valid only with action "cancel".`);
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
        // `steer:<toolCallId>` — an idempotent key for transport-level retries.
    // Explicit ids stay caller-owned and keep the strict charset; ':' is
    // admitted so a receipt's derived key can be echoed back verbatim.
  }
  // A `<ticket>#<task>` compound in taskId carries its own ticket (#53):
  // the ticket field is then optional. "#" never appears in a dispatched
  // task id (the schema's id charset excludes it), so "#" is always the
  // compound separator. With a ticket present the rpc layer still
  // resolves the split — a disagreeing pair conflicts there.
  const compoundShaped = taskId !== undefined && taskId.includes("#");
  if (compoundShaped && ticket === undefined) {
    const hash = taskId.indexOf("#");
    if (taskId.slice(0, hash) === "" || taskId.slice(hash + 1) === "") {
      fail(
        `taskId ${JSON.stringify(taskId)} is malformed — a compound address is "<ticket>#<task>" (e.g. "t-1a2b#task-1").`,
      );
    }
  }
  if (args.action !== "poll" && ticket === undefined && !compoundShaped) {
    fail(
      `action "${args.action}" requires a ticket id in the ticket field.`,
    );
  }
  return {
    action: args.action,
    ticket,
    force: args.force === true,
    taskId,
    questionId,
    answer,
    message,
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
    if (args.brief !== undefined) {
      fail(`brief requires at least one task; it is a dispatch field.`);
    }
    return { mode: "help" };
  }

  const effectiveTasks = args.tasks.map((task) => ({
    ...task,
    ...(task.workspace === undefined && args.workspace !== undefined
      ? { workspace: args.workspace }
      : {}),
  }));
  validateTasks(effectiveTasks);

  // A whitespace-only brief prepends nothing; nonblank text stays verbatim.
  const brief =
    args.brief !== undefined && args.brief.trim() !== "" ? args.brief : undefined;
  // The brief is prepended to every task's prompt, so the prompt cap
  // (#121) binds it too — without this, a giant brief is the cap's
  // workaround. Counts only; the body never echoes.
  if (brief !== undefined && brief.length > PROMPT_CHAR_LIMIT) {
    fail(
      `brief must be at most ${PROMPT_CHAR_LIMIT} characters; got ${brief.length}; it is prepended to every task. ${oversizedPromptRemedy}`,
    );
  }
  // #129: the caller-controlled budget is gone — presence rejects with
  // teaching, the same rule as removed deadlineMs.
  if (Object.hasOwn(args, "tokenBudget")) {
    fail(
      "The tokenBudget field has been removed — batch budgets are not caller-set. " +
        "Remove it; per-batch spend is bounded by task count and the concurrency config.",
    );
  }
  return {
    mode: "dispatch",
    tasks: effectiveTasks,
    brief,
    // Background execution is the default independently of task count.
    async: args.async ?? true,
  };
}

/** Batch-level checks over canonical tasks; all run before any task starts. */
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
    if ("model" in task && task.model !== undefined) {
      fail(`${where}: ${MODEL_FIELD_REJECTION}`);
    }
    if ("thinking" in task && task.thinking !== undefined) {
      fail(`${where}: ${THINKING_FIELD_REJECTION}`);
    }
    if ("reasoning_effort" in task && task.reasoning_effort !== undefined) {
      fail(`${where}: ${REASONING_EFFORT_FIELD_REJECTION}`);
    }
    if (task.prompt !== undefined && task.prompt.trim() === "") {
      fail(`${where}: prompt must be a non-empty string.`);
    }
    if (task.prompt !== undefined && task.prompt.length > PROMPT_CHAR_LIMIT) {
      fail(
        `${where}: prompt must be at most ${PROMPT_CHAR_LIMIT} characters; got ${task.prompt.length}. ${oversizedPromptRemedy}`,
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
      // Syntax check only: `web_search` is a valid name whose
      // availability is provider-scoped (#59) — unknown until the
      // task's model resolves at dispatch. Passing providerExtensions:
      // true defers the availability check to resolveTasks, which
      // re-expands with the resolved provider's real allowlist and
      // reports the same error there.
      const expanded = expandTools(task.tools, {
        providerExtensions: true,
      });
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

/**
 * SPEC v3 "Observability": the machine-readable `details` halves of the
 * delegate tool results and delivered/question messages, as TypeBox
 * schemas.
 *
 * The seam check (issue #51, Phase A): Pi 0.87's `ToolDefinition`
 * (`@earendil-works/pi-coding-agent` dist/core/extensions/types.d.ts)
 * carries no result/details schema field — `parameters` is the only
 * TypeBox slot, and `TDetails` is a type-level generic on `execute`/
 * `renderResult` that never reaches a validator. These schemas therefore
 * cannot attach at the tool seam; they are the exported stabilization
 * artifact instead, pinned two ways: the producing literals satisfy the
 * `Static` types at compile time, and contract tests `Value.Check` the
 * details real dispatches emit.
 *
 * Stabilization only: the schemas describe the shapes as built — no
 * field renames, no shape changes.
 */
import { Type, type Static, type TSchema, type TUnsafe } from "typebox";

/**
 * A required string enum, like delegate.ts's `stringEnum` helper — a
 * literal union spelled as a JSON-schema `enum` (runtime-enforced) whose
 * `Static` is the literal union.
 */
function literalUnion<const Values extends readonly string[]>(
  values: Values,
): TUnsafe<Values[number]> {
  return Type.Unsafe<Values[number]>({ type: "string", enum: [...values] });
}

/**
 * `Type.Array` whose `Static` is `readonly T[]`: `Type.Readonly` marks
 * object properties only and leaves an array's own mutability untouched,
 * while several details fields carry live readonly collections (ticket
 * outcomes, stored notices).
 */
function readonlyArray<T extends TSchema>(
  schema: T,
): TUnsafe<readonly Static<T>[]> {
  return Type.Unsafe<readonly Static<T>[]>({ ...Type.Array(schema) });
}

const taskStatusSchema = literalUnion([
  "ok",
  "failed",
  "cancelled",
  "blocked",
  "interrupted",
  "budget-exhausted",
] as const);

const taskVerdictSchema = literalUnion([
  "PASS",
  "FAIL",
  "AMBIGUOUS",
] as const);

/** pi-ai `Usage`, mirrored — a provider-emitted shape, pinned loosely. */
const usageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});

const taskIntegrationSchema = Type.Object(
  {
    status: literalUnion([
      "applied_unverified",
      "conflict",
      "retained",
      "no_changes",
      "discarded",
      "apply_failed",
    ] as const),
    reason: Type.Optional(Type.String()),
    proposedFiles: readonlyArray(Type.String()),
    appliedFiles: readonlyArray(Type.String()),
    conflicts: Type.Optional(
      readonlyArray(
        Type.Object({ path: Type.String(), reason: Type.String() }),
      ),
    ),
    baselineRef: Type.Optional(Type.String()),
    proposalRef: Type.Optional(Type.String()),
    patchPath: Type.Optional(Type.String()),
    worktreePath: Type.Optional(Type.String()),
    // #62: source-relative paths that changed in the original tree while a
    // shell-capable isolated worker ran — shell effects are unconfined.
    sourceDrift: Type.Optional(readonlyArray(Type.String())),
  },
  { additionalProperties: false },
);

/** A recorded task outcome (`details.results` entries; the journal record). */
export const taskOutcomeDetailsSchema = Type.Object(
  {
    index: Type.Integer(),
    id: Type.String(),
    status: taskStatusSchema,
    output: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    retries: Type.Integer(),
    usage: Type.Optional(usageSchema),
    integration: Type.Optional(taskIntegrationSchema),
    blockedBy: Type.Optional(readonlyArray(Type.String())),
    quarantined: Type.Optional(Type.Boolean()),
    sessionFile: Type.Optional(Type.String()),
    // Byte offset into sessionFile where the run's entries begin —
    // the tail boundary for pooled/resumed transcripts (delegate_ticket
    // tail).
    transcriptStart: Type.Optional(Type.Integer()),
    attributedFiles: Type.Optional(readonlyArray(Type.String())),
    // Overlap-reporting basis while concurrentWriters is non-empty —
    // the write/edit-observed subset of attributedFiles.
    observedFiles: Type.Optional(readonlyArray(Type.String())),
    uncertainFiles: Type.Optional(Type.Boolean()),
    // The task ran a shell regardless of Git coverage — internal
    // source-drift evidence, carried on the record for fidelity.
    shellObserved: Type.Optional(Type.Boolean()),
    // Writers whose work may appear inside the task's Git evidence
    // window ("parent", or "<ticket>#<task>" for a mutating sibling).
    concurrentWriters: Type.Optional(readonlyArray(Type.String())),
    verdict: Type.Optional(taskVerdictSchema),
  },
  { additionalProperties: false },
);

/**
 * A ticket's `outcomes` array as details surfaces it: index-aligned, with
 * `undefined` entries for tasks that have not yet recorded an outcome —
 * `null` after a journal round-trip (a cold-recovered ticket's record).
 */
const outcomeListSchema = readonlyArray(
  Type.Union([taskOutcomeDetailsSchema, Type.Undefined(), Type.Null()]),
);

/** `details.attributedFiles` — SPEC "Observability — Completion evidence". */
export const attributedFilesDetailsSchema = readonlyArray(
  Type.Object(
    {
      taskId: Type.String(),
      files: readonlyArray(Type.String()),
      uncertain: Type.Boolean(),
      // Optional: only a task whose Git window overlapped other writers
      // names them ("parent", or "<ticket>#<task>").
      concurrentWriters: Type.Optional(readonlyArray(Type.String())),
    },
    { additionalProperties: false },
  ),
);

/** `details.verdict` — SPEC "Completion evidence — verifier verdict" (#49). */
export const verdictDetailsSchema = readonlyArray(
  Type.Object(
    { verdict: taskVerdictSchema, taskId: Type.String() },
    { additionalProperties: false },
  ),
);

/** `details.usageLowerBound` — set (literally `true`) only when a
 * quarantined task makes the aggregate usage a lower bound. */
export const usageLowerBoundDetailsSchema = Type.Literal(true);

/** `details.brief` — the batch brief as sent (SPEC "Batch brief"). */
export const briefDetailsSchema = Type.String();

/** `details.notices` — admission/normalization advisory lines. */
export const noticesDetailsSchema = readonlyArray(Type.String());

const steerStatusSchema = literalUnion([
  "activated",
  "steered",
  "duplicate",
  "not-applied",
] as const);

/**
 * SPEC v3 "Interaction grammar — Steering" receipt outcomes. `steered`:
 * the message is on a live run's steering queue and merges at the next
 * turn boundary. `activated`: no run was live, so the message is parked
 * and opens the task's next turn. `duplicate`: an idempotent replay of a
 * recorded steerId. `not-applied`: nothing could or can receive it.
 */
export type SteerStatus = Static<typeof steerStatusSchema>;

/**
 * `details.steer` — machine-readable half of a steer receipt (SPEC v3
 * "Interaction grammar — Steering").
 */
export const steerDetailsSchema = Type.Object(
  {
    steerId: Type.String(),
    ticket: Type.String(),
    taskId: Type.String(),
    status: steerStatusSchema,
    /** On a duplicate receipt: the status the original call returned. */
    replayed: Type.Optional(steerStatusSchema),
    /**
     * The key was derived from the calling tool call (#44) rather than
     * caller-chosen — `steer:<toolCallId>`.
     */
    derived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SteerDetails = Static<typeof steerDetailsSchema>;

/**
 * `details.interrupt` — machine-readable half of an interrupt receipt
 * (delegate_ticket action "interrupt").
 */
export const interruptDetailsSchema = Type.Object(
  {
    ticket: Type.String(),
    taskId: Type.String(),
    status: literalUnion(["interrupted", "not-applied"] as const),
  },
  { additionalProperties: false },
);
export type InterruptDetails = Static<typeof interruptDetailsSchema>;

/**
 * `details.tail` — machine-readable half of a tail read (delegate_ticket
 * action "tail", issue #52): the output-so-far chunk from `offset`
 * (spill-bounded per call), the `nextOffset` cursor for the following
 * call, whether the task settled, and its state.
 */
export const tailDetailsSchema = Type.Object(
  {
    ticket: Type.String(),
    taskId: Type.String(),
    text: Type.String(),
    offset: Type.Integer(),
    nextOffset: Type.Integer(),
    done: Type.Boolean(),
    taskState: literalUnion([
      "queued",
      "running",
      "paused",
      "ok",
      "failed",
      "cancelled",
      "blocked",
      "interrupted",
      "budget-exhausted",
    ] as const),
  },
  { additionalProperties: false },
);
export type TailDetails = Static<typeof tailDetailsSchema>;

/** `details.questions` — unanswered worker questions (SPEC "Worker questions"). */
export const workerQuestionDetailsSchema = readonlyArray(
  Type.Object(
    {
      id: Type.String(),
      taskId: Type.String(),
      question: Type.String(),
    },
    { additionalProperties: false },
  ),
);

/** `delegate` result details for the manual call (`tasks: []`). */
export const helpDetailsSchema = Type.Object(
  { mode: Type.Literal("help") },
  { additionalProperties: false },
);
export type HelpDetails = Static<typeof helpDetailsSchema>;

/** `delegate` result details for an async dispatch (a ticket was created). */
export const asyncDispatchDetailsSchema = Type.Object(
  {
    mode: Type.Literal("dispatch"),
    async: Type.Literal(true),
    ticket: Type.String(),
    tasks: readonlyArray(Type.String()),
    brief: Type.Optional(briefDetailsSchema),
  },
  { additionalProperties: false },
);
export type AsyncDispatchDetails = Static<typeof asyncDispatchDetailsSchema>;

/** `delegate` result details for a synchronous (in-line) dispatch. */
export const syncDispatchDetailsSchema = Type.Object(
  {
    mode: Type.Literal("dispatch"),
    async: Type.Literal(false),
    tasks: readonlyArray(
      Type.Object(
        {
          id: Type.String(),
          status: taskStatusSchema,
          // #63: display labels for the collapsed view — the renderer
          // shows description, then agent, then id.
          agent: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    brief: Type.Optional(briefDetailsSchema),
    results: readonlyArray(taskOutcomeDetailsSchema),
    attributedFiles: attributedFilesDetailsSchema,
    verdict: Type.Optional(verdictDetailsSchema),
    usageLowerBound: Type.Optional(usageLowerBoundDetailsSchema),
    notices: Type.Optional(noticesDetailsSchema),
  },
  { additionalProperties: false },
);
export type SyncDispatchDetails = Static<typeof syncDispatchDetailsSchema>;

/**
 * `delegate` partial-result details for an in-flight synchronous dispatch
 * (#119): the live board the pending tool row renders on each heartbeat —
 * one entry per task with its state, elapsed anchors, and the current
 * (or last) tool call. Display-only: partials never enter the session
 * file or the model's context.
 */
export const liveDispatchDetailsSchema = Type.Object(
  {
    mode: Type.Literal("dispatch"),
    async: Type.Literal(false),
    live: Type.Object(
      {
        startedAt: Type.Number(),
        tasks: readonlyArray(
          Type.Object(
            {
              id: Type.String(),
              label: Type.String(),
              status: literalUnion([
                "queued",
                "running",
                "paused",
                "ok",
                "failed",
                "cancelled",
                "blocked",
                "interrupted",
                "budget-exhausted",
              ] as const),
              startedAt: Type.Number(),
              lastEventAt: Type.Number(),
              tool: Type.Optional(Type.String()),
              preview: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    notices: Type.Optional(noticesDetailsSchema),
  },
  { additionalProperties: false },
);
export type LiveDispatchDetails = Static<typeof liveDispatchDetailsSchema>;

/** `delegate` result details: help or either dispatch mode. */
export const delegateDetailsSchema = Type.Union([
  helpDetailsSchema,
  asyncDispatchDetailsSchema,
  syncDispatchDetailsSchema,
  liveDispatchDetailsSchema,
]);

const ticketActionSchema = literalUnion([
  "poll",
  "wait",
  "cancel",
  "pause",
  "resume",
  "answer",
  "steer",
  "interrupt",
  "tail",
] as const);

/**
 * `delegate_ticket` result details. The store-facing keys (`ticket`,
 * `results`, `attributedFiles`, `verdict`, `questions`) are written on
 * every call — `undefined` when the action does not carry them — while
 * `notices`, `steer`, and `interrupt` appear only when
 * they apply.
 */
export const ticketDetailsSchema = Type.Object(
  {
    mode: Type.Literal("ticket"),
    action: ticketActionSchema,
    ticket: Type.Union([Type.String(), Type.Undefined()]),
    results: Type.Union([outcomeListSchema, Type.Undefined()]),
    attributedFiles: Type.Union([
      attributedFilesDetailsSchema,
      Type.Undefined(),
    ]),
    verdict: Type.Union([verdictDetailsSchema, Type.Undefined()]),
    notices: Type.Optional(noticesDetailsSchema),
    questions: Type.Optional(
      Type.Union([workerQuestionDetailsSchema, Type.Undefined()]),
    ),
    /**
     * The wait tail sentence after the ticket view — a wait-any roster
     * ("still running: …"), a timeout/detached notice, or a
     * pending-question pointer. The collapsed view renders it; without
     * it the compact surface dropped everything past the view.
     */
    note: Type.Optional(Type.String()),
    steer: Type.Optional(steerDetailsSchema),
    interrupt: Type.Optional(interruptDetailsSchema),
    tail: Type.Optional(tailDetailsSchema),
  },
  { additionalProperties: false },
);
export type TicketDetails = Static<typeof ticketDetailsSchema>;

/** `delegate_session` result details. */
export const sessionDetailsSchema = Type.Object(
  {
    mode: Type.Literal("session"),
    action: literalUnion(["list", "close"] as const),
    sessionId: Type.Union([Type.String(), Type.Undefined()]),
  },
  { additionalProperties: false },
);
export type SessionDetails = Static<typeof sessionDetailsSchema>;

const originLeafSchema = Type.Union([
  Type.String(),
  Type.Null(),
  Type.Undefined(),
]);

/**
 * `details` of the delivered "delegate-result" wake message (SPEC
 * "Interaction grammar — Wake delivery"): a single settled ticket keeps
 * the historical `ticket`/`originLeafId` shape; a coalesced flush merges
 * into `tickets`/`originLeafIds`.
 */
export const deliveredDetailsSchema = Type.Union([
  Type.Object(
    {
      ticket: Type.String(),
      originLeafId: originLeafSchema,
      results: outcomeListSchema,
      notices: Type.Optional(noticesDetailsSchema),
      verdict: Type.Optional(verdictDetailsSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tickets: readonlyArray(Type.String()),
      originLeafIds: readonlyArray(originLeafSchema),
      results: outcomeListSchema,
      notices: Type.Optional(noticesDetailsSchema),
      verdict: Type.Optional(verdictDetailsSchema),
    },
    { additionalProperties: false },
  ),
]);
export type DeliveredDetails = Static<typeof deliveredDetailsSchema>;

/** `details` of the "delegate-question" worker-question notification. */
export const questionNoticeDetailsSchema = Type.Object(
  {
    ticket: Type.String(),
    taskId: Type.String(),
    questionId: Type.String(),
  },
  { additionalProperties: false },
);
export type QuestionNoticeDetails = Static<
  typeof questionNoticeDetailsSchema
>;

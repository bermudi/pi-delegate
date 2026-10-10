import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/**
 * Inline-batch live board (issue #119): a synchronous `async:false`
 * dispatch publishes display-only partial results (`tool_execution_update`
 * events) while it runs — an initial all-tasks frame, a ~1s heartbeat, and
 * a refresh as each task settles — so a long-running call never reads as
 * crashed. The partials are operator-facing only: they carry `live`
 * details for the pending tool row and must never land in the model's
 * context or the session record. Driven entirely through the registered
 * `delegate` tool and the harness's session-event stream.
 */

/** A scripted subagent stream that blocks until `release` is invoked. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage("OUTPUT-RELEASED");
  };
  return { release, step };
}

/** Poll until true, bounded — live frames are scheduling-dependent. */
async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 450 && !probe(); i++) await Bun.sleep(10);
  expect(probe(), `${what} (timed out waiting)`).toBe(true);
}

interface LiveTask {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly startedAt: number;
  readonly lastEventAt: number;
  readonly tool?: string;
  readonly preview?: string;
}

interface LiveDetails {
  readonly mode: string;
  readonly async: boolean;
  readonly live: { readonly startedAt: number; readonly tasks: LiveTask[] };
}

interface BoardUpdate {
  readonly toolCallId: string;
  readonly details: LiveDetails;
}

function isLiveDetails(value: unknown): value is LiveDetails {
  if (value === null || typeof value !== "object") return false;
  const details = value as Record<string, unknown>;
  return (
    details.mode === "dispatch" &&
    details.async === false &&
    details.live !== null &&
    typeof details.live === "object" &&
    Array.isArray((details.live as { tasks?: unknown }).tasks)
  );
}

/** The delegate tool's live-board frames, in emission order. */
function boardUpdates(session: TestSession): BoardUpdate[] {
  return session.events.all
    .filter(
      (event) =>
        event.type === "tool_execution_update" && event.toolName === "delegate",
    )
    .map((event) => ({
      toolCallId: (event as { toolCallId: string }).toolCallId,
      details: (event as { partialResult: { details?: unknown } })
        .partialResult.details,
    }))
    .filter((update): update is BoardUpdate => isLiveDetails(update.details));
}

describe("inline dispatch live board (#119)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("a running inline batch publishes board frames with every task row", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = callDelegate(session, {
      async: false,
      tasks: [{ id: "held-task", prompt: "held" }],
    });
    try {
      await waitFor(
        () => boardUpdates(session!).length >= 1,
        "first live board frame",
      );
      const board = boardUpdates(session)[0]!.details;
      expect(board.mode).toBe("dispatch");
      expect(board.async).toBe(false);
      expect(typeof board.live.startedAt).toBe("number");
      expect(board.live.tasks).toHaveLength(1);
      const task = board.live.tasks[0]!;
      expect(task.id).toBe("held-task");
      expect(["queued", "running"]).toContain(task.status);
      expect(task.lastEventAt).toBeGreaterThanOrEqual(task.startedAt);
    } finally {
      release();
    }
    const result = await dispatched;
    expect(result.isError).toBe(false);
  });

  test("heartbeats keep emitting while a task is blocked", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = callDelegate(session, {
      async: false,
      tasks: [{ prompt: "held" }],
    });
    try {
      // Nothing settles while the gate holds: the initial frame plus at
      // least two more emissions prove a periodic heartbeat, not just
      // edge-triggered updates.
      await waitFor(
        () => boardUpdates(session!).length >= 3,
        "three live board frames under a blocked task",
      );
      const updates = boardUpdates(session);
      const ids = new Set(updates.map((update) => update.toolCallId));
      expect(ids.size).toBe(1);
    } finally {
      release();
    }
    await dispatched;
  });

  test("a settling task refreshes the board while the batch runs on", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    // Route by prompt: the held task waits on the gate, the fast task
    // answers immediately — queue order is scheduling, not a contract.
    const routed: FauxResponseFactory = (context, options, state, model) =>
      JSON.stringify(context.messages).includes("HELD-SECOND")
        ? step(context, options, state, model)
        : Promise.resolve(fauxAssistantMessage("FAST-ONE"));
    subagents.respond([routed, routed]);

    const dispatched = callDelegate(session, {
      async: false,
      tasks: [
        { id: "fast", prompt: "quick", tools: "ro" },
        { id: "held", prompt: "HELD-SECOND", tools: "ro" },
      ],
    });
    try {
      await waitFor(
        () =>
          boardUpdates(session!).some((update) =>
            update.details.live.tasks.some(
              (task) => task.id === "fast" && task.status === "ok",
            ),
          ),
        "a board frame showing the fast task settled",
      );
      const board = boardUpdates(session).at(-1)!.details;
      expect(board.live.tasks).toHaveLength(2);
      const held = board.live.tasks.find((task) => task.id === "held")!;
      expect(["queued", "running"]).toContain(held.status);
    } finally {
      release();
    }
    const result = await dispatched;
    expect(result.isError).toBe(false);
  });

  test("a worker's tool activity paints the task row's tail", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    // Step 1 runs a real tool on the worker; step 2 blocks on the gate so
    // frames during the hold carry the tool tail in either phase — the
    // in-flight arg preview or the settled call's result preview.
    subagents.respond([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo HELLO-BOARD" }),
      ]),
      step,
    ]);

    const dispatched = callDelegate(session, {
      async: false,
      tasks: [{ id: "tooling", prompt: "use a tool" }],
    });
    try {
      await waitFor(
        () =>
          boardUpdates(session!).some((update) =>
            update.details.live.tasks.some(
              (task) =>
                task.id === "tooling" &&
                task.tool === "bash" &&
                task.preview?.includes("HELLO-BOARD") === true,
            ),
          ),
        "a board frame carrying the worker's bash tail",
      );
    } finally {
      release();
    }
    const result = await dispatched;
    expect(result.isError).toBe(false);
  });

  test("repeated task ids across dispatches keep separate boards", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("FIRST")]);

    const first = await callDelegate(session, {
      async: false,
      tasks: [{ id: "dup", prompt: "first" }],
    });
    expect(first.isError).toBe(false);

    const { release, step } = gate();
    subagents.respond([step]);
    const second = callDelegate(session, {
      async: false,
      tasks: [{ id: "dup", prompt: "second" }],
    });
    try {
      await waitFor(
        () =>
          boardUpdates(session!).some(
            (update) => update.toolCallId !== "" && update.toolCallId !== first.toolCallId,
          ),
        "the second dispatch's first board frame",
      );
      const secondFrames = boardUpdates(session).filter(
        (update) => update.toolCallId !== first.toolCallId,
      );
      // Dispatch-scoped rows: the second run's board carries only its own
      // task — never the first run's retained row with the same id.
      expect(
        secondFrames.every(
          (frame) => frame.details.live.tasks.length === 1,
        ),
      ).toBe(true);
      expect(secondFrames[0]!.details.live.tasks[0]!.id).toBe("dup");
    } finally {
      release();
    }
    const result = await second;
    expect(result.isError).toBe(false);
  });

  test("an async dispatch emits no board frames", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = await callDelegate(session, {
      async: true,
      tasks: [{ prompt: "bg" }],
    });
    const ticket = ticketIdOf(dispatched.text);
    // Hold past two heartbeat intervals: a ticket-backed run must never
    // publish inline board frames.
    await Bun.sleep(2300);
    expect(boardUpdates(session)).toHaveLength(0);

    release();
    await callDelegateTicket(session, {
      action: "wait",
      ticket,
    });
  });

  test("frames stop once the batch settles and never reach the model", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = callDelegate(session, {
      async: false,
      tasks: [{ prompt: "held" }],
    });
    await waitFor(
      () => boardUpdates(session!).length >= 1,
      "a live board frame",
    );
    release();
    const result = await dispatched;
    expect(result.isError).toBe(false);

    // The heartbeat is cleared on settlement: no frame may arrive after
    // the final result.
    const settled = boardUpdates(session).length;
    await Bun.sleep(1300);
    expect(boardUpdates(session)).toHaveLength(settled);

    // The settled result is the ordinary one — no `live` field, one tool
    // result total (partials are events, never results or messages).
    const details = result.details as Record<string, unknown>;
    expect(details.mode).toBe("dispatch");
    expect(details.async).toBe(false);
    expect(details.live).toBeUndefined();
    expect(
      session.events.toolResultsFor("delegate"),
    ).toHaveLength(1);
    const transcript = JSON.stringify(
      (session.session as AgentSession).sessionManager.getEntries(),
    );
    expect(transcript.includes('"live"')).toBe(false);
    expect(
      session.events.messages.some((message) =>
        JSON.stringify(message).includes('"live"'),
      ),
    ).toBe(false);
  });
});

/**
 * Cancellation/quiescence regressions (v1 evidence: cancellation.test.ts,
 * controller-races.test.ts, pause.test.ts).
 *
 * Determinism notes: `callCount` is incremented synchronously inside the faux
 * provider's streamFunction, before any yields, so `callCount === N` is a hard
 * proof that no further model turn started. Gated factories plus the
 * `maxConcurrent: 1` bound let tests place tasks at exact lifecycle points.
 */
import { afterEach, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  chmodSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TestSession,
  ToolResultRecord,
} from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  callDelegate,
  callDelegateDetached,
  callDelegateTicket,
  configureDelegate,
  delegateTool,
  installSubagentModel,
  openDelegateBoundary,
  registeredTool,
  ticketIdOf,
} from "../support/pi-boundary.js";

let session: TestSession | undefined;

afterEach(() => {
  session?.dispose();
  session = undefined;
});

function writeConcurrency(maxConcurrent: number): void {
  if (!session) throw new Error("session not open");
  configureDelegate(session, { maxConcurrent });
}

/**
 * Probe admission until a dispatch is accepted or the budget expires.
 * Rejection for a still-retained (quarantined) reservation fails inside
 * admission before any task starts, so only an admitted attempt consumes a
 * scripted provider response — making this the public-boundary witness for
 * "the abandoned worker wound down and its reservation was released".
 */
async function dispatchUntilAdmitted(
  session: TestSession,
  arguments_: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<ToolResultRecord> {
  const deadline = Date.now() + timeoutMs;
  let result = await callDelegate(session, arguments_);
  while (result.isError && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    result = await callDelegate(session, arguments_);
  }
  return result;
}

test(
  "a task cancelled while queued behind the concurrency bound never reaches the provider",
  async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    writeConcurrency(1);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("leader done");
    };
    subagents.respond([gated]);

    const dispatched = await callDelegate(session, {
      tasks: [0, 1].map((n) => ({
        prompt: `queued ${n}`,
        agent: "explore",
      })),
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    // The leader must be streaming when the cancel lands — otherwise the
    // cancel can win the race to the first provider call and the count
    // below moves for a reason unrelated to the queue gate under test.
    const started = Date.now() + 5000;
    while (subagents.state.callCount < 1 && Date.now() < started) {
      await new Promise((r) => setImmediate(r));
    }
    const cancelled = await callDelegateTicket(session, {
      action: "cancel",
      ticket,
      force: true,
    });
    expect(cancelled.text).toMatch(/cancel/i);

    // The queued task was cancelled before its turn: exactly one provider
    // call ever happened (the leader's gated stream).
    expect(subagents.state.callCount).toBe(1);

    release();
    const waited = await callDelegateTicket(session, {
      action: "wait",
      ticket,
    });
    expect(waited.text).toMatch(/cancelled/i);
    expect(subagents.state.callCount).toBe(1);
  },
);

// NOTE (#130): the "cancelled while paused between model turns" scenario
// was removed with the model-facing pause/resume actions — its public
// trigger was the RPC. The park machinery itself survives (dashboard-
// owned); a dashboard integration test is the follow-up path for that
// scenario. All non-paused cancellation scenarios below are unchanged.

test(
  "forced cancel settles while worker cleanup is blocked; the reservation releases only after confirmed quiescence",
  async () => {
    // v1 evidence: quiescence-barrier regressions — cancellation must be
    // caller-visible even when worker termination cannot be confirmed, and
    // quarantined resources stay reserved until safety is proven.
    //
    // The faux provider's gated factory ignores the abort signal while it
    // waits: session.abort()'s waitForIdle cannot settle until release().
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    };
    subagents.respond([gated, fauxAssistantMessage("AFTER-QUARANTINE")]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "hold" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    // Wait until the provider call is definitely in flight: callCount is
    // bumped synchronously inside the faux stream function.
    const deadline = Date.now() + 5000;
    while (subagents.state.callCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(1);

    const cancelled = await callDelegateTicket(session, {
      action: "cancel",
      ticket,
      force: true,
    });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.text).toMatch(/cancel/i);

    // While the worker may still mutate, conflicting work rejects.
    const rejected = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "conflict" }],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/conflict|running|overlap|active/i);

    // Confirmed quiescence: the gate releases, the provider sees the abort,
    // the run winds down, and the reservation is released — proven by the
    // same dispatch now being admitted. The intervening wait round-trip
    // drains the worker's microtask cascade before this call is admitted.
    release();
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
    });
    expect(settled.text).toMatch(/cancelled/i);
    // The late worker outcome can never turn cancellation into success.
    expect(settled.text).not.toMatch(/— (completed|ok)/i);

    const admitted = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "after" }],
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("AFTER-QUARANTINE");
  },
);

test(
  "a sync call returns a structured outcome instead of hanging when the worker cannot be confirmed stopped",
  async () => {
    // v1 evidence: unwind-budget regressions — a synchronous dispatch must
    // not wait forever on unconfirmed worker termination. The inactivity
    // watchdog is the deterministic trigger (#118); the gated factory keeps
    // session.abort() pending.
    session = await openDelegateBoundary();
    configureDelegate(session, { stallTimeoutMs: 500 });
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("TOO-LATE");
    };
    subagents.respond([
      gated,
      // Spares: the admission-retry probe below only consumes a script on
      // an admitted attempt, but a mid-flight failure would too.
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage("AFTER-QUARANTINE"),
      ),
    ]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [
        {
          prompt: "hang",
        },
      ],
    });
    // The call returned at all: settlement did not wait for cleanup. The
    // provider call is still gated (callCount proves it was in flight), so
    // the worker's termination is genuinely unconfirmed.
    expect(result.text).toMatch(/stall|cancel/i);
    expect(subagents.state.callCount).toBe(1);

    // The abandoned worker may still mutate: conflicting work rejects.
    const rejected = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "conflict" }],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/conflict|running|overlap|active/i);

    // Releasing the gate lets the worker wind down; only then is the
    // retained reservation released. Wind-down is asynchronous and there is
    // no ticket to wait on, so probe admission until the quarantine is
    // provably gone.
    release();
    const admitted = await dispatchUntilAdmitted(session, {
      async: false,
      tasks: [{ prompt: "after" }],
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("AFTER-QUARANTINE");
  },
);

test(
  "a dependent of a quarantined prerequisite blocks immediately instead of parking on unconfirmed quiescence",
  async () => {
    // The dependency gate waits for confirmed quiescence so a provisional
    // outcome can never unblock downstream work — but a quarantined
    // outcome only exists after cancellation was requested, and a worker
    // truth after cancellation is never a success. Waiting on quiescence
    // that may never arrive would park the whole batch on a worker that
    // may still be mutating.
    session = await openDelegateBoundary();
    configureDelegate(session, { stallTimeoutMs: 500 });
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("TOO-LATE");
    };
    subagents.respond([gated, fauxAssistantMessage("AFTER-QUARANTINE")]);

    // The prerequisite's inactivity watchdog fires while its provider call is gated:
    // it records a quarantined failure while the worker may still run.
    // The dependent must block off that record — not wait on quiescence.
    const result = await callDelegate(session, {
      async: false,
      tasks: [
        { id: "stuck", prompt: "hang" },
        {
          id: "dependent",
          prompt: "never runs",
          agent: "explore",
          dependsOn: ["stuck"],
        },
      ],
    });

    // The call returned while the worker is still gated; the dependent
    // consumed no worker and carries a visible, named block.
    expect(subagents.state.callCount).toBe(1);
    expect(result.text).toMatch(/blocked/i);
    expect(result.text).toMatch(/stuck/);

    // The abandoned worker's write scope stays reserved — the block did
    // not make its quarantined resources eligible for reuse.
    const rejected = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "conflict" }],
    });
    expect(rejected.isError).toBe(true);

    release();
    const admitted = await dispatchUntilAdmitted(session, {
      async: false,
      tasks: [{ prompt: "after" }],
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("AFTER-QUARANTINE");
  },
);

test(
  "a later-phase shared writer waits for an earlier overlapping writer's confirmed quiescence",
  async () => {
    // The phase boundary awaits recorded outcomes, not confirmed
    // quiescence: without a cross-phase predecessor edge, a phase-1
    // writer could start while a quarantined phase-0 writer still
    // mutates the shared root.
    session = await openDelegateBoundary();
    configureDelegate(session, { stallTimeoutMs: 500 });
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let secondStarted = false;
    const turn: FauxResponseFactory = async (context) => {
      const messages = JSON.stringify(context.messages);
      if (messages.includes("stuck writer")) {
        await gate;
        return fauxAssistantMessage("TOO-LATE");
      }
      if (messages.includes("second writer")) {
        secondStarted = true;
        return fauxAssistantMessage("SECOND-DONE");
      }
      return fauxAssistantMessage("PREREQ-DONE");
    };
    subagents.respond([turn, turn, turn]);

    const dispatched = await callDelegate(session, {
      tasks: [
        {
          id: "stuck",
          prompt: "stuck writer",
        },
        { id: "prereq", prompt: "quick read", agent: "explore" },
        {
          id: "second",
          prompt: "second writer",
          dependsOn: ["prereq"],
        },
      ],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    // Phase 0's provider calls are both in flight; let the stall watchdog fire
    // and phase 1 begin. The second writer must stay parked on the stuck
    // writer's confirmed quiescence — no provider call while it is gated.
    const deadline = Date.now() + 5000;
    while (subagents.state.callCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(2);
    await new Promise((r) => setTimeout(r, 900));
    expect(subagents.state.callCount).toBe(2);
    expect(secondStarted).toBe(false);

    // Confirmed quiescence frees the successor, which then runs to ok.
    release();
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
    });
    expect(settled.isError).toBe(false);
    expect(subagents.state.callCount).toBe(3);
    expect(secondStarted).toBe(true);
  },
);

test(
  "a parent abort during an in-flight sync dispatch settles as a cancellation, not a stall or a hang",
  async () => {
    // v1 evidence: caller-abort regressions — the parent's abort reaches the
    // tool through its execute signal and must settle with the parent-abort
    // cause, which outranks stall.
    //
    // The harness's awaited run() cannot express an interruption, but it
    // exposes the raw AgentSession: fire the call detached and abort() the
    // session once the subagent's provider call is demonstrably in flight.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("TOO-LATE");
    };
    subagents.respond([
      gated,
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage("AFTER-QUARANTINE"),
      ),
    ]);

    const pending = callDelegateDetached(session, {
      async: false,
      tasks: [
        {
          prompt: "hang",
        },
      ],
    });

    const deadline = Date.now() + 5000;
    while (subagents.state.callCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(1);

    await (session.session as AgentSession).abort();

    const result = await pending;
    // A structured cancellation; settlement did not wait on the still-
    // gated worker.
    expect(result.text).toMatch(/cancel/i);
    expect(result.text).not.toMatch(/deadline/i);
    expect(subagents.state.callCount).toBe(1);

    // The worker's termination is still unconfirmed: its scope stays
    // reserved until the gate releases and quiescence is proven.
    const rejected = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "conflict" }],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/conflict|running|overlap|active/i);

    release();
    const admitted = await dispatchUntilAdmitted(session, {
      async: false,
      tasks: [{ prompt: "after" }],
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("AFTER-QUARANTINE");
  },
);

test(
  "an all-cancelled sync batch is a normal result, not a tool error",
  async () => {
    // SPEC "Dispatch": a synchronous result is error-valued only when
    // every task FAILED. A batch whose every outcome is cancelled — here
    // by a parent abort mid-flight — reports each task's cancelled status
    // on an ordinary result; the caller's own abort is not a tool error.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("TOO-LATE");
    };
    subagents.respond([gated, gated]);

    const pending = callDelegateDetached(session, {
      async: false,
      tasks: [
        { prompt: "hang one", agent: "explore" },
        { prompt: "hang two", agent: "explore" },
      ],
    });

    // Both provider calls demonstrably in flight before the abort lands.
    const deadline = Date.now() + 5000;
    while (subagents.state.callCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(2);

    await (session.session as AgentSession).abort();

    const result = await pending;
    expect(result.text).toMatch(/cancel/i);
    expect(result.isError).toBe(false);
    const details = result.details as
      | { tasks?: { status?: string }[] }
      | undefined;
    expect(details?.tasks?.every((t) => t.status === "cancelled")).toBe(true);

    release();
  },
);

test(
  "aborting mid-stream is a cancellation, not an error, and no extra turn starts",
  async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("late output");
    };
    subagents.respond([gated]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "streaming",  agent: "explore" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    // The abort must land mid-stream: wait until the worker's provider
    // call is in flight before cancelling, or the cancel can win the
    // race to the first stream and "mid-stream" never happened.
    const started = Date.now() + 5000;
    while (subagents.state.callCount < 1 && Date.now() < started) {
      await new Promise((r) => setImmediate(r));
    }
    const cancelled = await callDelegateTicket(session, {
      action: "cancel",
      ticket,
      force: true,
    });
    expect(cancelled.text).toMatch(/cancel/i);

    release();
    const waited = await callDelegateTicket(session, {
      action: "wait",
      ticket,
    });
    expect(waited.text).toMatch(/cancelled/i);
    expect(subagents.state.callCount).toBe(1);
  },
);

test(
  "a worker silent past stallTimeoutMs settles as a structured stall, not a hang",
  async () => {
    // v1 evidence: runner.ts inactivity watchdog — silence past the
    // configured stall timeout requests cooperative cancellation under the
    // stall cause; SPEC: stall timeouts measure inactivity. The budget
    // comes from delegate.json.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { stallTimeoutMs: 150 });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("TOO-LATE");
    };
    subagents.respond([
      gated,
      // Spares for the admission probe below — only an admitted attempt
      // consumes a scripted response.
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage("AFTER-QUARANTINE"),
      ),
    ]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "hang" }],
    });
    // The call returned at all: settlement did not wait on the still-gated
    // worker. The cause is the inactivity watchdog — not a deadline, not an
    // operator cancellation.
    expect(result.text).toMatch(/stall/i);
    expect(result.text).not.toMatch(/deadline|cancel/i);
    expect(subagents.state.callCount).toBe(1);

    // Termination is unconfirmed while the gate holds: the worker's scope
    // stays reserved, same as any quarantined cancellation.
    const rejected = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "conflict" }],
    });
    expect(rejected.isError).toBe(true);

    release();
    const admitted = await dispatchUntilAdmitted(session, {
      async: false,
      tasks: [{ prompt: "after" }],
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("AFTER-QUARANTINE");
  },
);

// NOTE (#130): the two pause/watchdog scenarios ("parked time behind a
// paused ticket is not inactivity" and "an in-flight silent turn still
// stalls while its ticket is paused") were removed with the model-facing
// pause/resume actions — their public trigger was the RPC. The watchdog
// and park machinery is unchanged and dashboard-owned; a dashboard
// integration test is the follow-up path for both scenarios.

function gitInitForShutdownRace(dir: string): void {
  // An initial commit is required: isolated baselines are built on HEAD.
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir },
  );
}

/**
 * Park a dispatch at a specific Git call, deterministically: a `git` shim
 * first in PATH counts invocations, lets calls below `parkAtCall` through,
 * and blocks call `parkAtCall` (and later ones) until a release file
 * appears — then everything execs the real git by absolute path. The log
 * file records each invocation, witnessing how far the dispatch got:
 * call 1 is the write-scope probe in task resolution, call 2 the
 * repository probe inside prepareIsolated.
 */
function installGitHold(parkAtCall: number): {
  logPath: string;
  releasePath: string;
  shimDir: string;
  restore: () => void;
} {
  const realGit = execSync("command -v git", { encoding: "utf8" }).trim();
  const shimDir = mkdtempSync(join(tmpdir(), "delegate-git-hold-"));
  const logPath = join(shimDir, "invoked");
  const counterPath = join(shimDir, "count");
  const releasePath = join(shimDir, "release");
  const shimPath = join(shimDir, "git");
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      `n=$(cat ${JSON.stringify(counterPath)} 2>/dev/null)`,
      "n=${n:-0}",
      `echo $((n + 1)) > ${JSON.stringify(counterPath)}`,
      `printf '%s\\n' "$PWD $*" >> ${JSON.stringify(logPath)}`,
      `if [ $((n + 1)) -ge ${parkAtCall} ] && [ ! -e ${JSON.stringify(releasePath)} ]; then`,
      `  while [ ! -e ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
      "fi",
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shimPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shimDir}${previousPath ? `:${previousPath}` : ""}`;
  return {
    logPath,
    releasePath,
    shimDir,
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
}

/** Release the hold and drop the shim even on failure paths. */
function teardownGitHold(hold: ReturnType<typeof installGitHold>): void {
  try {
    writeFileSync(hold.releasePath, "");
  } catch {
    // Already released or the directory is gone; nothing more to do.
  }
  hold.restore();
  rmSync(hold.shimDir, { recursive: true, force: true });
}

/** Wait until the shim log has at least `lines` recorded invocations. */
async function untilLogLines(path: string, lines: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const count = existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length
      : 0;
    if (count >= lines) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(
    `shim log never reached ${lines} invocation(s): ${
      existsSync(path) ? readFileSync(path, "utf8") : "(empty)"
    }`,
  );
}

test(
  "shutdown while a sync dispatch is parked in workspace preparation holds the boundary until it quiesces",
  async () => {
    // Same regression on the sync path: there is no ticket to cancel, so
    // after the hold releases the workers run to completion under the
    // barrier and only then may the session boundary settle.
    const repo = mkdtempSync(join(tmpdir(), "delegate-shutdown-prep-"));
    gitInitForShutdownRace(repo);
    const hold = installGitHold(2);
    try {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("SYNC-PREP-DONE")]);

      const pending = callDelegateDetached(session, {
        async: false,
        workspace: "isolated",
        tasks: [{ prompt: "hold at preparation", cwd: repo }],
      });
      // Call 1 (write-scope probe) ran through; call 2 is parked inside
      // prepareIsolated.
      await untilLogLines(hold.logPath, 2);

      let settled = false;
      const shutdown = (session.session as AgentSession).extensionRunner
        .emit({ type: "session_shutdown", reason: "quit" })
        .then(() => {
          settled = true;
        });

      await Promise.race([shutdown, Bun.sleep(200)]);
      expect(settled).toBe(false);

      writeFileSync(hold.releasePath, "");
      const result = await pending;
      expect(result.isError).toBe(false);
      expect(result.text).toContain("SYNC-PREP-DONE");

      await Promise.race([
        shutdown,
        Bun.sleep(15_000).then(() => {
          throw new Error(
            "shutdown never settled after the parked dispatch quiesced",
          );
        }),
      ]);
      expect(settled).toBe(true);
    } finally {
      teardownGitHold(hold);
      rmSync(repo, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "shutdown while an async dispatch is parked in workspace preparation aborts the prep and still returns its ticket",
  async () => {
    // Async preparation runs under the ticket's cancellation signal, so a
    // shutdown force-cancel aborts the parked Git call instead of letting
    // the copy/worktree run to completion. The dispatch still returns its
    // ticket (cancelled, workers never started) and the shutdown barrier
    // resolves without waiting for the release file.
    const repo = mkdtempSync(join(tmpdir(), "delegate-shutdown-prep-"));
    gitInitForShutdownRace(repo);
    const hold = installGitHold(2);
    try {
      session = await openDelegateBoundary();
      await installSubagentModel(session);

      const pending = callDelegateDetached(session, {
        async: true,
        workspace: "isolated",
        tasks: [{ prompt: "hold at preparation", cwd: repo }],
      });
      // Call 1 (write-scope probe) ran through; call 2 is parked inside
      // prepareIsolated.
      await untilLogLines(hold.logPath, 2);

      let settled = false;
      const shutdown = (session.session as AgentSession).extensionRunner
        .emit({ type: "session_shutdown", reason: "quit" })
        .then(() => {
          settled = true;
        });

      // The abort kills the parked Git shim: both the dispatch (Ticket,
      // cancelled) and the shutdown settle without the release file.
      const dispatched = await Promise.race([
        pending,
        Bun.sleep(15_000).then(() => {
          throw new Error("parked async dispatch never aborted its prep");
        }),
      ]);
      expect(dispatched.text).toContain("Ticket");
      const ticket = ticketIdOf(dispatched.text);
      const poll = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(poll.text).toContain("cancelled");

      await Promise.race([
        shutdown,
        Bun.sleep(15_000).then(() => {
          throw new Error(
            "shutdown never settled after the parked dispatch aborted",
          );
        }),
      ]);
      expect(settled).toBe(true);
    } finally {
      teardownGitHold(hold);
      rmSync(repo, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "forced cancellation racing workspace preparation still returns its ticket",
  async () => {
    // The non-shutdown variant of the prep race: force-cancelling the
    // ticket while preparation is parked aborts the prep, and the caller
    // must still get the ticket id with the batch-end bookkeeping done —
    // cancelled outcomes recorded, gates finished (INVARIANTS "Ticket
    // state": a terminal cancellation response must not falsely imply
    // unsafe cleanup completed, and later results stay visible).
    const repo = mkdtempSync(join(tmpdir(), "delegate-shutdown-prep-"));
    gitInitForShutdownRace(repo);
    const hold = installGitHold(2);
    try {
      session = await openDelegateBoundary();
      await installSubagentModel(session);
      // Direct execute of the registered tool: the dispatch must stay
      // parked while a second call force-cancels it, which the awaited
      // session.run API cannot express.
      interface RegisteredTool {
        execute(
          toolCallId: string,
          params: Record<string, unknown>,
          signal: AbortSignal,
          onUpdate: (update: unknown) => void,
          ctx: unknown,
        ): Promise<{
          readonly content: readonly { readonly text?: string }[];
        }>;
      }
      const tool = delegateTool(session) as unknown as RegisteredTool;
      const ticketTool = registeredTool(
        session,
        "delegate_ticket",
      ) as unknown as RegisteredTool;
      const ctx = (session.session as AgentSession).extensionRunner
        .createContext();
      const textOf = (result: {
        readonly content: readonly { readonly text?: string }[];
      }): string => result.content.map((block) => block.text ?? "").join("\n");
      const call = (
        params: Record<string, unknown>,
      ): Promise<string> =>
        tool
          .execute(
            "force-cancel-prep",
            params,
            new AbortController().signal,
            () => {},
            ctx,
          )
          .then(textOf);
      const callTicket = (
        params: Record<string, unknown>,
      ): Promise<string> =>
        ticketTool
          .execute(
            "force-cancel-ticket",
            params,
            new AbortController().signal,
            () => {},
            ctx,
          )
          .then(textOf);

      const dispatched = call({
        async: true,
        workspace: "isolated",
        tasks: [{ prompt: "cancel during prep", cwd: repo }],
      });
      // Call 1 (write-scope probe) ran through; call 2 is parked inside
      // prepareIsolated.
      await untilLogLines(hold.logPath, 2);

      // The dispatch has not returned yet, so the id comes from the roster.
      const roster = await callTicket({ action: "poll" });
      const ticket = ticketIdOf(roster);
      const cancelled = await callTicket({
        action: "cancel",
        ticket,
        force: true,
      });
      expect(cancelled).toMatch(/cancelled/i);

      // The abort kills the parked Git shim: the dispatch settles without
      // the release file, still returning its ticket id.
      const result = await Promise.race([
        dispatched,
        Bun.sleep(15_000).then(() => {
          throw new Error("parked async dispatch never aborted its prep");
        }),
      ]);
      expect(result).toContain(`Ticket "${ticket}"`);
      const poll = await callTicket({ action: "poll", ticket });
      expect(poll).toMatch(/cancelled/);
      expect(poll).toContain("1/1 tasks finished");
    } finally {
      teardownGitHold(hold);
      rmSync(repo, { recursive: true, force: true });
    }
  },
  30_000,
);

/**
 * Fail a dispatch at a specific Git call, deterministically: like
 * installGitHold, but call `failAtCall` (and later ones) exits non-zero
 * instead of parking — a preparation that throws rather than aborts.
 */
function installGitFailure(failAtCall: number): {
  logPath: string;
  shimDir: string;
  restore: () => void;
} {
  const realGit = execSync("command -v git", { encoding: "utf8" }).trim();
  const shimDir = mkdtempSync(join(tmpdir(), "delegate-git-fail-"));
  const logPath = join(shimDir, "invoked");
  const counterPath = join(shimDir, "count");
  const shimPath = join(shimDir, "git");
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      `n=$(cat ${JSON.stringify(counterPath)} 2>/dev/null)`,
      "n=${n:-0}",
      `echo $((n + 1)) > ${JSON.stringify(counterPath)}`,
      `printf '%s\\n' "$PWD $*" >> ${JSON.stringify(logPath)}`,
      `if [ $((n + 1)) -ge ${failAtCall} ]; then`,
      `  echo "git-shim: induced failure" >&2`,
      "  exit 1",
      "fi",
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shimPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shimDir}${previousPath ? `:${previousPath}` : ""}`;
  return {
    logPath,
    shimDir,
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
}

async function expectShutdownSettles(current: TestSession): Promise<void> {
  // A dispatch that ended before the coordinator handoff must have
  // resolved its shutdown barrier: the session boundary may not hang on a
  // batch that never started (INVARIANTS "Ticket state").
  let settled = false;
  const shutdown = (current.session as AgentSession).extensionRunner
    .emit({ type: "session_shutdown", reason: "quit" })
    .then(() => {
      settled = true;
    });
  await Promise.race([
    shutdown,
    Bun.sleep(15_000).then(() => {
      throw new Error("shutdown never settled after the failed preparation");
    }),
  ]);
  expect(settled).toBe(true);
}

test(
  "an async dispatch whose workspace preparation fails exposes no ticket and leaves no barrier",
  async () => {
    // Prep-FAILURE variant of the shutdown-prep races: a copy/worktree
    // error that throws (rather than aborts) must fail the whole call —
    // no phantom ticket left behind — and the dispatch's shutdown barrier
    // must resolve with it.
    const repo = mkdtempSync(join(tmpdir(), "delegate-shutdown-prep-"));
    gitInitForShutdownRace(repo);
    const failure = installGitFailure(2);
    try {
      session = await openDelegateBoundary();
      await installSubagentModel(session);

      // Call 1 (write-scope probe) succeeds; call 2, the repository probe
      // inside prepareIsolated, fails.
      const result = await callDelegate(session, {
        async: true,
        workspace: "isolated",
        tasks: [
          { prompt: "fail at preparation", cwd: repo },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/requires a Git repository/i);
      // The ticket never started, so it is not exposed: the failure text
      // names no ticket id, and the roster is empty.
      expect(result.text).not.toContain('Ticket "');
      const roster = await callDelegateTicket(session, { action: "poll" });
      expect(roster.text).toContain("No tickets");

      await expectShutdownSettles(session);
    } finally {
      failure.restore();
      rmSync(failure.shimDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "a sync dispatch whose workspace preparation fails leaves no barrier",
  async () => {
    // Same failure on the sync path: the call fails with the preparation
    // cause and the session boundary is not held by a batch that never
    // started.
    const repo = mkdtempSync(join(tmpdir(), "delegate-shutdown-prep-"));
    gitInitForShutdownRace(repo);
    const failure = installGitFailure(2);
    try {
      session = await openDelegateBoundary();
      await installSubagentModel(session);

      const result = await callDelegate(session, {
        async: false,
        workspace: "isolated",
        tasks: [
          { prompt: "fail at preparation", cwd: repo },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/requires a Git repository/i);

      await expectShutdownSettles(session);
    } finally {
      failure.restore();
      rmSync(failure.shimDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "tasks have no wall-clock budget at all",
  async () => {
    // INVARIANTS "Cancellation and quiescence": a task carries no
    // wall-clock budget (#118); no
    // configuration default, host default, or implicit mechanism may add
    // one. With the inactivity watchdog disabled too, a worker whose
    // provider call never settles must still be running — nothing else
    // may kill it. (The watchdog is disabled here because it is a real,
    // configured limit — the point is that no OTHER hidden limit exists.)
    session = await openDelegateBoundary();
    configureDelegate(session, { stallTimeoutMs: 0 });
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hanging: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("EVENTUALLY-DONE");
    };
    subagents.respond([hanging]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "hang indefinitely", agent: "explore" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const running = Date.now() + 5000;
    while (subagents.state.callCount < 1 && Date.now() < running) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(1);

    // Advancing wall time must not introduce a task deadline.
    await new Promise((r) => setTimeout(r, 400));
    const midFlight = await callDelegateTicket(session, {
      action: "poll",
      ticket,
    });
    expect(midFlight.text).toMatch(/running/i);
    expect(midFlight.text).not.toMatch(/deadline|stall|cancel|failed/i);

    release();
    const settled = await callDelegateTicket(session, {
      action: "wait",
      ticket,
    });
    expect(settled.text).toContain("EVENTUALLY-DONE");
    expect(settled.text).toMatch(/completed/i);
  },
);

/**
 * Telemetry contention regressions (#142): a real SQLite write lock held by
 * a spawned child process must never stall the dispatch thread — no
 * synchronous lock-wait, retry sleep, or busy spin may sit between a settled
 * dispatch and its caller. Deferred writes land exactly once once the lock
 * releases; loss (busy-window expiry, queue overflow, stale destination) is
 * bounded and loud; close drains pending writes to their deadlines.
 */
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { diagnosticRecords } from "../support/diagnostic-records.ts";
import {
  callDelegate,
  callDelegateTicket,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

const lockHolderScript = resolve(
  import.meta.dirname,
  "../support/telemetry-lock-holder.ts",
);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "delegate-telemetry-contention-"));
}

function rowsOf(dbPath: string, table: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

function userVersionOf(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    return row?.user_version ?? -1;
  } finally {
    db.close();
  }
}

/**
 * Read a table's row count under WAL contention. Readers never block, but a
 * momentarily-missing file or schema reports -1 so polls can retry.
 */
function countRows(dbPath: string, table: string): number {
  if (!existsSync(dbPath)) return -1;
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | { n?: unknown }
      | undefined;
    return typeof row?.n === "number" ? row.n : -1;
  } finally {
    db.close();
  }
}

/** Poll until the table reaches `expected` rows or the deadline expires. */
async function pollRowCount(
  dbPath: string,
  table: string,
  expected: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  let count = -1;
  while (performance.now() < deadline) {
    try {
      count = countRows(dbPath, table);
    } catch {
      count = -1;
    }
    if (count === expected) return count;
    await new Promise((r) => setTimeout(r, 15));
  }
  return count;
}

interface LockHold {
  /** null while the child still runs (and still holds the write lock). */
  readonly exitCode: () => number | null;
  readonly exited: Promise<number>;
  readonly stderr: Promise<string>;
  /** Kill the child if it is still running; await its exit either way. */
  readonly release: () => Promise<void>;
}

/** Spawn the lock holder and wait for its LOCKED banner. Always cleaned up. */
async function acquireLock(dbPath: string, holdMs: number): Promise<LockHold> {
  const child = Bun.spawn(
    [process.execPath, lockHolderScript, dbPath, String(holdMs)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const banner = await reader.read();
  reader.releaseLock();
  if (
    banner.done ||
    !new TextDecoder().decode(banner.value).includes("LOCKED\n")
  ) {
    child.kill();
    await child.exited;
    throw new Error(
      `lock holder did not acquire its write lock; stderr: ${await stderr}`,
    );
  }
  return {
    exitCode: () => child.exitCode,
    exited: child.exited,
    stderr,
    release: async () => {
      if (child.exitCode === null) child.kill();
      await child.exited;
    },
  };
}

/** Scope DELEGATE_TELEMETRY_BUSY_MS; returns the restore callback. */
function withBusyWindow(ms: number): () => void {
  const previous = process.env.DELEGATE_TELEMETRY_BUSY_MS;
  process.env.DELEGATE_TELEMETRY_BUSY_MS = String(ms);
  return () => {
    if (previous === undefined) delete process.env.DELEGATE_TELEMETRY_BUSY_MS;
    else process.env.DELEGATE_TELEMETRY_BUSY_MS = previous;
  };
}

describe("telemetry contention (#142)", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];

  function trackedTempDir(): string {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    session?.dispose();
    session = undefined;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "a held write lock defers the span write without stalling the dispatch thread",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
        stallTimeoutMs: 0,
      });
      const restoreBusyWindow = withBusyWindow(5000);
      let hold: LockHold | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;
      const tickGaps: number[] = [];
      try {
        // Seed the database so the WAL file exists and the destination is
        // already open before the contention begins.
        subagents.respond([fauxAssistantMessage("SEED-OK")]);
        const seed = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "seed" }],
        });
        expect(seed.isError).toBe(false);
        expect(await pollRowCount(dbPath, "calls", 1, 3000)).toBe(1);

        hold = await acquireLock(dbPath, 2000);
        // The probe measured a 20ms heartbeat stalled ~1242ms while a
        // synchronous busy retry slept the calling thread. A deferred
        // writer never produces a gap like that.
        let lastTick = performance.now();
        interval = setInterval(() => {
          const now = performance.now();
          tickGaps.push(now - lastTick);
          lastTick = now;
        }, 20);

        subagents.respond([fauxAssistantMessage("UNDER-LOCK-OK")]);
        const result = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "contended", agent: "explore" }],
        });
        expect(result.isError).toBe(false);
        // Yield one timer round before reading the gaps: an overdue
        // interval fires only on the next macrotask turn, so a stalled
        // heartbeat is only visible after the loop gets to breathe.
        await new Promise((r) => setTimeout(r, 60));
        expect(tickGaps.length).toBeGreaterThan(0);
        expect(Math.max(0, ...tickGaps)).toBeLessThan(400);
        // The dispatch returned while the independent writer still held
        // the database — the write went to the deferred queue, not into a
        // calling-thread sleep.
        expect(hold.exitCode()).toBeNull();

        // The deferred write lands after the lock releases, exactly once.
        await hold.exited;
        expect(await pollRowCount(dbPath, "calls", 2, 3000)).toBe(2);
        expect(userVersionOf(dbPath)).toBe(6);
        const taskIds = rowsOf(dbPath, "tasks").map((row) => String(row.id));
        expect(taskIds).toHaveLength(2);
        expect(new Set(taskIds).size).toBe(2);
      } finally {
        if (interval !== undefined) clearInterval(interval);
        if (hold !== undefined) await hold.release();
        restoreBusyWindow();
      }
    },
    30_000,
  );

  test(
    "ticket cancellation resolves while a telemetry write sits in the deferred queue",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
        stallTimeoutMs: 0,
      });
      const restoreBusyWindow = withBusyWindow(5000);
      let hold: LockHold | undefined;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let markEntered!: () => void;
      const providerEntered = new Promise<void>((r) => (markEntered = r));
      try {
        subagents.respond([fauxAssistantMessage("SEED-OK")]);
        const seed = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "seed" }],
        });
        expect(seed.isError).toBe(false);
        expect(await pollRowCount(dbPath, "calls", 1, 3000)).toBe(1);

        const gated: FauxResponseFactory = async () => {
          markEntered();
          await gate;
          return fauxAssistantMessage("NEVER-RESOLVES");
        };
        subagents.respond([gated]);
        const dispatched = await callDelegate(session, {
          async: true,
          tasks: [{ prompt: "hang", agent: "explore" }],
        });
        expect(dispatched.isError).toBe(false);
        const ticket = ticketIdOf(dispatched.text);
        const enteredDeadline = performance.now() + 5000;
        while (
          subagents.state.callCount < 2 &&
          performance.now() < enteredDeadline
        ) {
          await new Promise((r) => setImmediate(r));
        }
        await providerEntered;

        hold = await acquireLock(dbPath, 2000);
        // ~600ms into a ~2000ms hold: force-cancel settles the batch, which
        // produces a telemetry write that meets the lock mid-flight.
        await new Promise((r) => setTimeout(r, 600));
        const cancelAt = performance.now();
        const cancelled = await callDelegateTicket(session, {
          action: "cancel",
          ticket,
          force: true,
        });
        expect(cancelled.isError).toBe(false);
        expect(cancelled.text).toMatch(/cancel/i);
        const waited = await callDelegateTicket(session, {
          action: "wait",
          ticket,
        });
        expect(waited.isError).toBe(false);
        expect(waited.text).toMatch(/cancel/i);
        // Cancellation completed before the lock released — the deferred
        // span write never entered the ticket RPC's path.
        expect(hold.exitCode()).toBeNull();
        expect(performance.now() - cancelAt).toBeLessThan(1300);

        // The cancelled batch's rows still land once the lock releases.
        await hold.exited;
        expect(await pollRowCount(dbPath, "calls", 2, 3000)).toBe(2);
        const calls = rowsOf(dbPath, "calls");
        expect(calls.some((row) => row.status === "cancelled")).toBe(true);
      } finally {
        release();
        if (hold !== undefined) await hold.release();
        restoreBusyWindow();
      }
    },
    30_000,
  );

  test(
    "a busy-window expiry reports the loss and latches the destination failed",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
        stallTimeoutMs: 0,
      });
      const restoreBusyWindow = withBusyWindow(300);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      let hold: LockHold | undefined;
      try {
        subagents.respond([fauxAssistantMessage("SEED-OK")]);
        const seed = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "seed" }],
        });
        expect(seed.isError).toBe(false);
        expect(await pollRowCount(dbPath, "calls", 1, 3000)).toBe(1);

        hold = await acquireLock(dbPath, 1500);
        subagents.respond([fauxAssistantMessage("CONTENDED-OK")]);
        const contended = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "contended" }],
        });
        expect(contended.isError).toBe(false);
        expect(contended.text).toContain("CONTENDED-OK");

        // The job's 300ms busy window expires well inside the 1500ms hold:
        // the loss is loud, never silent.
        const deadline = performance.now() + 4000;
        let reported = false;
        while (performance.now() < deadline && !reported) {
          reported = diagnosticRecords(errors.mock.calls).some(
            (record) =>
              record.event === "telemetry failed" &&
              record.context.path === dbPath &&
              record.level === "error",
          );
          if (!reported) await new Promise((r) => setTimeout(r, 15));
        }
        expect(reported).toBe(true);

        // Fail-once stands after the lock releases: later dispatches keep
        // returning normally but write nothing new to the failed
        // destination.
        await hold.exited;
        subagents.respond([fauxAssistantMessage("AFTER-LOCK-OK")]);
        const after = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "after" }],
        });
        expect(after.isError).toBe(false);
        expect(after.text).toContain("AFTER-LOCK-OK");
        expect(countRows(dbPath, "calls")).toBe(1);
        expect(countRows(dbPath, "tasks")).toBe(1);
      } finally {
        errors.mockRestore();
        if (hold !== undefined) await hold.release();
        restoreBusyWindow();
      }
    },
    30_000,
  );

  test(
    "session close keeps draining queued writes to their deadlines",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
        stallTimeoutMs: 0,
      });
      const restoreBusyWindow = withBusyWindow(2000);
      let hold: LockHold | undefined;
      try {
        subagents.respond([fauxAssistantMessage("SEED-OK")]);
        const seed = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "seed" }],
        });
        expect(seed.isError).toBe(false);
        expect(await pollRowCount(dbPath, "calls", 1, 3000)).toBe(1);

        hold = await acquireLock(dbPath, 400);
        subagents.respond([fauxAssistantMessage("QUEUED-OK")]);
        const result = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "queued" }],
        });
        expect(result.isError).toBe(false);
        expect(result.text).toContain("QUEUED-OK");

        // Shutdown while the write is still deferred: close is
        // non-blocking and must not truncate the queue the busy-window
        // policy promised to persist.
        const host = session.session as AgentSession;
        const shutdownStarted = performance.now();
        await host.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        expect(performance.now() - shutdownStarted).toBeLessThan(500);

        // The drain survived close — the span rows land once the lock
        // releases.
        await hold.exited;
        expect(await pollRowCount(dbPath, "calls", 2, 3000)).toBe(2);
        expect(countRows(dbPath, "tasks")).toBe(2);
      } finally {
        if (hold !== undefined) await hold.release();
        restoreBusyWindow();
      }
    },
    30_000,
  );

  test(
    "the deferred queue is bounded and its overflow is loud",
    async () => {
      session = await openDelegateBoundary();
      await installSubagentModel(session);
      const dbPath = join(trackedTempDir(), "usage.db");
      configureDelegate(session, {
        telemetry: { enabled: true, dbPath },
        stallTimeoutMs: 0,
      });
      const restoreBusyWindow = withBusyWindow(30_000);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      const warnings = spyOn(console, "warn").mockImplementation(() => {});
      let hold: LockHold | undefined;
      try {
        // Create the database first: a rejected dispatch's misfire write
        // opens it eagerly on the fast path.
        const seed = await callDelegate(session, {
          tasks: [{ prompt: "x", deadlineMs: -5 }],
        });
        expect(seed.isError).toBe(true);
        expect(await pollRowCount(dbPath, "misfires", 1, 3000)).toBe(1);

        // Held long past the loop below; killed early once the overflow
        // is observed, so the loop's pace can never outlive the hold.
        hold = await acquireLock(dbPath, 60_000);
        // Each removed-field rejection produces one validation misfire
        // row; with the lock held they pile into the deferred queue until
        // it reaches its cap.
        let rejected = 0;
        let overflowed = false;
        for (let n = 0; n < 280 && !overflowed; n += 1) {
          const result = await callDelegate(session, {
            tasks: [{ prompt: `misfire ${n}`, deadlineMs: -5 }],
          });
          expect(result.isError).toBe(true);
          rejected += 1;
          overflowed = diagnosticRecords([
            ...errors.mock.calls,
            ...warnings.mock.calls,
          ]).some(
            (record) =>
              record.event === "telemetry write queue overflow" &&
              record.level === "warn",
          );
        }
        expect(overflowed).toBe(true);

        // Bounded and still durably persisted once the lock releases:
        // every queued job lands inside its busy window, but the dropped
        // overflow means strictly fewer rows than rejections were filed.
        await hold.release();
        const deadline = performance.now() + 10_000;
        let count = -1;
        let stable = 0;
        while (performance.now() < deadline && stable < 4) {
          const next = countRows(dbPath, "misfires");
          stable = next === count ? stable + 1 : 0;
          count = next;
          await new Promise((r) => setTimeout(r, 50));
        }
        // The drain landed the bulk of the backlog (seed row included),
        // and overflow dropped at least one of the filed rejections.
        expect(count).toBeGreaterThan(200);
        expect(count).toBeLessThanOrEqual(rejected);
        const sample = rowsOf(dbPath, "misfires")[0];
        expect(sample?.phase).toBe("validation");
        expect(sample?.task_count).toBe(1);
      } finally {
        errors.mockRestore();
        warnings.mockRestore();
        if (hold !== undefined) await hold.release();
        restoreBusyWindow();
      }
    },
    60_000,
  );
});

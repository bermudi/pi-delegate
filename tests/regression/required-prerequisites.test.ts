import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateSession,
  callDelegateTicket,
  configureDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";
import { diagnosticRecords } from "../support/diagnostic-records.ts";
import { gitFixtureEnv } from "../support/git-fixture.ts";

const root = resolve(import.meta.dirname, "../..");
const childScript = resolve(
  import.meta.dirname,
  "../support/transcript-prerequisite-child.ts",
);
const sessionsDirName = `${sep}delegate-sessions${sep}`;
const sessions: TestSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

async function openAt(agentDir?: string): Promise<TestSession> {
  const session = await openDelegateBoundary();
  sessions.push(session);
  if (agentDir) {
    (session.session as AgentSession).sessionManager.getSessionDir = () =>
      join(agentDir, "sessions", "--test--");
  }
  return session;
}

function journalOf(agentDir: string, ticket: string): Record<string, unknown> {
  return objectOf(
    JSON.parse(
      readFileSync(join(agentDir, "delegate-tickets", `${ticket}.json`), "utf8"),
    ),
  );
}

function blockTicketJournal(
  agentDir: string,
  realRename: typeof fs.renameSync,
): { repair: () => void } {
  const ticketsDir = join(agentDir, "delegate-tickets");
  const backup = `${ticketsDir}.saved-${process.pid}-${Date.now()}`;
  realRename.call(fs, ticketsDir, backup);
  writeFileSync(ticketsDir, "BLOCKED", { mode: 0o600 });
  return {
    repair: () => {
      rmSync(ticketsDir, { force: true });
      if (existsSync(backup)) realRename.call(fs, backup, ticketsDir);
    },
  };
}

function blockFirstSharedTranscript(cwd: string): {
  spy: ReturnType<typeof spyOn>;
  blockedPath: () => string | undefined;
} {
  const original = SessionManager.prototype.getSessionFile;
  let planted: string | undefined;
  const spy = spyOn(
    SessionManager.prototype,
    "getSessionFile",
  ).mockImplementation(function (this: SessionManager) {
    const file = original.call(this);
    if (
      planted === undefined &&
      typeof file === "string" &&
      file.includes(sessionsDirName) &&
      file.startsWith(cwd)
    ) {
      planted = file;
      mkdirSync(file, { recursive: true });
    }
    return file;
  });
  return { spy, blockedPath: () => planted };
}

async function shutdownWarnings(session: TestSession): Promise<string[]> {
  const host = session.session as AgentSession;
  const notify = spyOn(host.extensionRunner.createContext().ui, "notify");
  try {
    await host.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    return notify.mock.calls
      .filter(([, kind]) => kind === "warning")
      .map(([text]) => text);
  } finally {
    notify.mockRestore();
  }
}

function expectCleanShutdown(warnings: readonly string[]): void {
  expect(
    warnings.filter((text) =>
      /still stopping|still.*mutat|quiescence.*expir/i.test(text),
    ),
    "shutdown must confirm quiescence, not exit by exhausting its budget",
  ).toEqual([]);
}

function withShortShutdownBudget(): () => void {
  const previous = process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS;
  process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS = "300";
  return () => {
    if (previous === undefined) delete process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS;
    else process.env.DELEGATE_SHUTDOWN_QUIESCENCE_MS = previous;
  };
}

describe("required prerequisites before worker effects (#140/#141 under #138)", () => {
  test("a non-file transcript target fails the shared task before any provider call (#140)", async () => {
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("OK")]);
    const before = readdirSync(session.cwd).sort();
    const { spy, blockedPath } = blockFirstSharedTranscript(session.cwd);
    try {
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "report" }],
      });
      expect(blockedPath()).toBeDefined();
      expect(result.isError).toBe(true);
      expect(subagents.state.callCount).toBe(0);
      const details = JSON.stringify(result.details ?? {});
      expect(details).not.toContain("usage");
      expect(details).not.toContain("sessionFile");
      expect(result.text).not.toContain("session:");
      expect(result.text).not.toContain("resumeFrom");
      expect(result.text).not.toMatch(/no prior messages/i);
      const after = readdirSync(session.cwd).sort();
      expect(
        after.filter((entry) => !before.includes(entry)),
      ).toEqual(["delegate-sessions"]);
      rmSync(join(session.cwd, "delegate-sessions"), {
        recursive: true,
        force: true,
      });
      const readmitted = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "report" }],
      });
      expect(readmitted.isError).toBe(false);
      expect(readmitted.text).toContain("OK");
      expect(subagents.state.callCount).toBe(1);
    } finally {
      spy.mockRestore();
      rmSync(join(session.cwd, "delegate-sessions"), {
        recursive: true,
        force: true,
      });
    }
  });

  test("a required transcript failure leaves the worker settled for a clean shutdown (#140)", async () => {
    const restoreBudget = withShortShutdownBudget();
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("OK")]);
    const { spy, blockedPath } = blockFirstSharedTranscript(session.cwd);
    const originalDispose = AgentSession.prototype.dispose;
    let disposed = 0;
    const disposeSpy = spyOn(
      AgentSession.prototype,
      "dispose",
    ).mockImplementation(function (this: AgentSession) {
      if (this.sessionFile === blockedPath()) disposed += 1;
      return originalDispose.call(this);
    });
    try {
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "report" }],
      });
      expect(result.isError).toBe(true);
      expect(subagents.state.callCount).toBe(0);
      expect(disposed).toBeGreaterThanOrEqual(1);
      expectCleanShutdown(await shutdownWarnings(session));
    } finally {
      disposeSpy.mockRestore();
      spy.mockRestore();
      rmSync(join(session.cwd, "delegate-sessions"), {
        recursive: true,
        force: true,
      });
      restoreBudget();
    }
  });

  test("a missing header-write capability fails the shared task with an actionable error (#140)", async () => {
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("OK"), fauxAssistantMessage("OK")]);
    const proto = SessionManager.prototype as unknown as Record<
      string,
      unknown
    >;
    const saved = proto._rewriteFile;
    try {
      delete proto._rewriteFile;
      const failed = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "report" }],
      });
      expect(subagents.state.callCount).toBe(0);
      expect(failed.isError).toBe(true);
      const text = failed.text;
      expect(text).toContain("unsupported host capability");
      const details = JSON.stringify(failed.details ?? {});
      expect(details).not.toContain("sessionFile");
      expect(text).not.toContain("resumeFrom");
      expect(text).not.toMatch(/no prior messages/i);
      const siblingCwd = join(session.cwd, "sibling");
      mkdirSync(siblingCwd);
      execSync(
        "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
        { cwd: siblingCwd, env: gitFixtureEnv() },
      );
      const sibling = await callDelegate(session, {
        async: false,
        tasks: [
          { prompt: "report", workspace: "isolated", cwd: siblingCwd },
        ],
      });
      expect(sibling.isError).toBe(false);
      expect(sibling.text).toContain("OK");
      expect(subagents.state.callCount).toBe(1);
    } finally {
      proto._rewriteFile = saved;
    }
    const readmitted = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "report" }],
    });
    expect(readmitted.isError).toBe(false);
    expect(readmitted.text).toContain("OK");
    expect(subagents.state.callCount).toBe(2);
  });

  test("a throwing header writer fails without leaking the private error body (#140)", async () => {
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("OK")]);
    const proto = SessionManager.prototype as unknown as Record<
      string,
      unknown
    >;
    const saved = proto._rewriteFile;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      proto._rewriteFile = () => {
        throw new Error("PRIVATE_HEADER_FAILURE_SENTINEL");
      };
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "report" }],
      });
      expect(result.isError).toBe(true);
      expect(subagents.state.callCount).toBe(0);
      expect(result.text).not.toContain("PRIVATE_HEADER_FAILURE_SENTINEL");
      expect(JSON.stringify(result.details ?? {})).not.toContain(
        "PRIVATE_HEADER_FAILURE_SENTINEL",
      );
      expect(JSON.stringify(diagnosticRecords(errors.mock.calls))).not.toContain(
        "PRIVATE_HEADER_FAILURE_SENTINEL",
      );
    } finally {
      proto._rewriteFile = saved;
      errors.mockRestore();
    }
  });

  test("a required transcript-claim save failure settles the ticket failed without prompting (#140)", async () => {
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("OK")]);
    const ticketsDir = join(session.cwd, "delegate-tickets");
    const original = fs.renameSync;
    let matching = 0;
    let fixture: { repair: () => void } | undefined;
    const spy = spyOn(fs, "renameSync").mockImplementation(((
      from: Parameters<typeof fs.renameSync>[0],
      to: Parameters<typeof fs.renameSync>[1],
    ) => {
      const dest = String(to);
      if (dest.startsWith(`${ticketsDir}${sep}`) && dest.endsWith(".json")) {
        matching += 1;
        if (matching === 2) {
          fixture ??= blockTicketJournal(session.cwd, original);
        }
      }
      return original.call(fs, from, to);
    }) as typeof fs.renameSync);
    let ticket = "";
    try {
      const dispatched = await callDelegate(session, {
        async: true,
        tasks: [{ prompt: "report" }],
      });
      expect(dispatched.isError).toBe(false);
      ticket = ticketIdOf(dispatched.text);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
      });
      expect(settled.isError).toBe(false);
      expect(settled.text).toMatch(/failed/i);
      expect(settled.text).not.toContain("OK");
      expect(subagents.state.callCount).toBe(0);
      expect(JSON.stringify(settled.details ?? {})).not.toContain("usage");
    } finally {
      spy.mockRestore();
      fixture?.repair();
    }
    const tasks = journalOf(session.cwd, ticket).tasks;
    expect(Array.isArray(tasks)).toBe(true);
    const readmitted = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "report" }],
    });
    expect(readmitted.isError).toBe(false);
    expect(subagents.state.callCount).toBe(1);
  });

  test(
    "a host killed before the first assistant event leaves a durable claimed transcript (#140)",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "delegate-prereq-"));
      const agentDir = join(scratch, "agent");
      const temp = join(scratch, "tmp");
      mkdirSync(agentDir, { mode: 0o700 });
      mkdirSync(temp, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, childScript], {
        cwd: root,
        env: {
          ...process.env,
          DELEGATE_AGENT_DIR: agentDir,
          TMPDIR: temp,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          TERM: "dumb",
          DELEGATE_SHUTDOWN_QUIESCENCE_MS: "2000",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new Response(child.stderr).text();
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let head = "";
      const rest = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          head += decoder.decode(value, { stream: true });
        }
        return head;
      })();
      let childExited = false;
      void child.exited.then(() => {
        childExited = true;
      });
      let stderrText = "";
      try {
        const deadline = Date.now() + 20_000;
        let ready: string | undefined;
        while (ready === undefined && !childExited && Date.now() < deadline) {
          if (head.includes("\n")) {
            ready = head.split("\n")[0] ?? "";
          } else {
            await Bun.sleep(20);
          }
        }
        if (ready === undefined) {
          throw new Error(
            `fixture host never reported readiness (exited=${childExited})`,
          );
        }
        const message = objectOf(JSON.parse(ready));
        expect(message.type).toBe("ready");
        const ticket = message.ticket;
        if (typeof ticket !== "string" || !ticket.startsWith("t-")) {
          throw new Error("fixture reported a malformed ticket id");
        }
        child.kill("SIGKILL");
        await child.exited;
        const saved = journalOf(agentDir, ticket);
        const tasks = saved.tasks as { sessionFile?: string }[];
        const claimed = tasks[0]?.sessionFile;
        expect(typeof claimed).toBe("string");
        expect(claimed!).toStartWith(join(agentDir, "delegate-sessions"));
        const stat = statSync(claimed!);
        expect(stat.isFile()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o600);
        const lines = readFileSync(claimed!, "utf8").trim().split("\n");
        const entries = lines.map((line) => objectOf(JSON.parse(line)));
        expect(entries[0]?.type).toBe("session");
        expect(
          entries.some(
            (entry) =>
              entry.type === "message" &&
              objectOf(entry.message).role === "assistant",
          ),
        ).toBe(false);
        const messages = entries.filter((entry) => entry.type === "message");
        const recovered = await openAt(agentDir);
        const poll = await callDelegateTicket(recovered, {
          action: "poll",
          ticket,
        });
        expect(poll.isError).toBe(false);
        expect(poll.text).toContain("interrupted");
        expect(poll.text).toContain(`session: ${claimed}`);
        expect(existsSync(claimed!)).toBe(true);
        if (messages.length > 0) {
          expect(poll.text).toContain("resumeFrom");
        } else {
          expect(poll.text).toMatch(/no prior messages/i);
        }
      } finally {
        try {
          child.kill("SIGKILL");
        } catch {}
        await child.exited;
        await rest;
        stderrText = await stderr;
        reader.releaseLock();
        process.stderr.write(`fixture artifacts kept at ${scratch}\n`);
      }
      expect(stderrText).not.toContain("PRIVATE_");
    },
    25_000,
  );

  test("a post-effect journal save failure keeps the successful outcome with a stale-save notice (#140)", async () => {
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    const ticketsDir = join(session.cwd, "delegate-tickets");
    const original = fs.renameSync;
    let armed = false;
    let fixture: { repair: () => void } | undefined;
    const spy = spyOn(fs, "renameSync").mockImplementation(((
      from: Parameters<typeof fs.renameSync>[0],
      to: Parameters<typeof fs.renameSync>[1],
    ) => {
      const dest = String(to);
      if (
        armed &&
        fixture === undefined &&
        dest.startsWith(`${ticketsDir}${sep}`) &&
        dest.endsWith(".json")
      ) {
        fixture = blockTicketJournal(session.cwd, original);
      }
      return original.call(fs, from, to);
    }) as typeof fs.renameSync);
    try {
      subagents.respond([
        fauxAssistantMessage([
          fauxText("EFFECT-TURN"),
          fauxToolCall("bash", { command: "printf EFFECT > effect.txt" }),
        ]),
        () => {
          armed = true;
          return fauxAssistantMessage("OK");
        },
      ]);
      const dispatched = await callDelegate(session, {
        async: true,
        tasks: [{ prompt: "report" }],
      });
      expect(dispatched.isError).toBe(false);
      const ticket = ticketIdOf(dispatched.text);
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
      });
      expect(settled.isError).toBe(false);
      expect(settled.text).toContain("OK");
      expect(settled.text).toMatch(/recovery save failed|stale/i);
      expect(readFileSync(join(session.cwd, "effect.txt"), "utf8")).toBe(
        "EFFECT",
      );
      expect(subagents.state.callCount).toBe(2);
    } finally {
      spy.mockRestore();
      fixture?.repair();
    }
  });

  test("a failed clearAllQueues on a resident pooled session evicts instead of reusing (#141)", async () => {
    const restoreBudget = withShortShutdownBudget();
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("OK")]);
    const seen: AgentSession[] = [];
    const originalPrompt = AgentSession.prototype.prompt;
    const promptSpy = spyOn(
      AgentSession.prototype,
      "prompt",
    ).mockImplementation(function (
      this: AgentSession,
      ...args: Parameters<AgentSession["prompt"]>
    ) {
      if (
        typeof this.sessionFile === "string" &&
        this.sessionFile.includes(sessionsDirName)
      ) {
        seen.push(this);
      }
      return originalPrompt.apply(this, args);
    });
    try {
      const first = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "report", sessionId: "s1" }],
      });
      expect(first.isError).toBe(false);
      const child = seen.at(-1);
      expect(child).toBeDefined();
      child!.agent.steer({
        role: "user",
        content: [{ type: "text", text: "STALE-QUEUE-MARKER" }],
        timestamp: Date.now(),
      });
      const disposeSpy = spyOn(child!, "dispose");
      const clearSpy = spyOn(child!.agent, "clearAllQueues").mockImplementation(
        () => {
          throw new Error("synthetic clearAllQueues failure");
        },
      );
      try {
        const second = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "report", sessionId: "s1" }],
        });
        expect(second.isError).toBe(true);
        expect(subagents.state.callCount).toBe(1);
        expect(JSON.stringify(second.details ?? {})).not.toContain("usage");
        const listed = await callDelegateSession(session, {
          action: "list",
        });
        expect(listed.text).not.toContain('"s1"');
        expect(disposeSpy).toHaveBeenCalled();
      } finally {
        clearSpy.mockRestore();
        disposeSpy.mockRestore();
      }
      subagents.respond([
        (context) =>
          fauxAssistantMessage(
            JSON.stringify(context.messages).includes("STALE-QUEUE-MARKER")
              ? "STALE-SEEN"
              : "STALE-ABSENT",
          ),
      ]);
      const third = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "report", sessionId: "s1" }],
      });
      expect(third.isError).toBe(false);
      expect(third.text).toContain("STALE-ABSENT");
      expectCleanShutdown(await shutdownWarnings(session));
    } finally {
      promptSpy.mockRestore();
      restoreBudget();
    }
  });

  test("a failed clearAllQueues on a reloaded pooled session evicts; siblings still complete (#141)", async () => {
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { sessions: { maxIdle: 0 } });
    subagents.respond([fauxAssistantMessage("OK")]);
    const first = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "report", sessionId: "s2" }],
    });
    expect(first.isError).toBe(false);
    const listed = await callDelegateSession(session, { action: "list" });
    expect(listed.text).toContain('"s2"');
    const parentAgent = (session.session as AgentSession).agent;
    const originalClear = Agent.prototype.clearAllQueues;
    const receivers: Agent[] = [];
    const clearSpy = spyOn(
      Agent.prototype,
      "clearAllQueues",
    ).mockImplementation(function (this: Agent) {
      if (this === parentAgent || receivers.length > 0) {
        return originalClear.call(this);
      }
      receivers.push(this);
      throw new Error("synthetic clearAllQueues failure");
    });
    try {
      subagents.respond([fauxAssistantMessage("OK")]);
      const second = await callDelegate(session, {
        async: false,
        tasks: [
          { id: "pooled", prompt: "report", sessionId: "s2" },
          { id: "sibling", prompt: "report", agent: "explore" },
        ],
      });
      expect(receivers).toHaveLength(1);
      expect(receivers[0]).not.toBe(parentAgent);
      expect(second.text).toContain("OK");
      expect(second.text).toMatch(/fail/i);
      expect(subagents.state.callCount).toBe(2);
      const after = await callDelegateSession(session, { action: "list" });
      expect(after.text).not.toContain('"s2"');
    } finally {
      clearSpy.mockRestore();
    }
    subagents.respond([fauxAssistantMessage("OK")]);
    const third = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "report", sessionId: "s2" }],
    });
    expect(third.isError).toBe(false);
    expect(third.text).toContain("OK");
  });

  test("a disposal fault during queue-failure eviction logs but still evicts (#141)", async () => {
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("OK")]);
    const seen: AgentSession[] = [];
    const originalPrompt = AgentSession.prototype.prompt;
    const promptSpy = spyOn(
      AgentSession.prototype,
      "prompt",
    ).mockImplementation(function (
      this: AgentSession,
      ...args: Parameters<AgentSession["prompt"]>
    ) {
      if (
        typeof this.sessionFile === "string" &&
        this.sessionFile.includes(sessionsDirName)
      ) {
        seen.push(this);
      }
      return originalPrompt.apply(this, args);
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "report", sessionId: "s3" }],
      });
      expect(first.isError).toBe(false);
      const child = seen.at(-1);
      expect(child).toBeDefined();
      const originalDispose = AgentSession.prototype.dispose;
      const disposeSpy = spyOn(
        AgentSession.prototype,
        "dispose",
      ).mockImplementation(function (this: AgentSession) {
        if (this !== child) return originalDispose.call(this);
        throw new Error("synthetic dispose failure");
      });
      const clearSpy = spyOn(
        child!.agent,
        "clearAllQueues",
      ).mockImplementation(() => {
        throw new Error("synthetic clearAllQueues failure");
      });
      try {
        const second = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "report", sessionId: "s3" }],
        });
        expect(second.isError).toBe(true);
        expect(subagents.state.callCount).toBe(1);
        const listed = await callDelegateSession(session, { action: "list" });
        expect(listed.text).not.toContain('"s3"');
        expect(
          diagnosticRecords(errors.mock.calls).some(
            (record) => record.event === "session cleanup failed",
          ),
        ).toBe(true);
      } finally {
        clearSpy.mockRestore();
        disposeSpy.mockRestore();
      }
    } finally {
      promptSpy.mockRestore();
      errors.mockRestore();
    }
  });

  test("shared, pooled, and resumed transcripts keep appending after the durable header (#140)", async () => {
    const session = await openAt();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("OK")]);
    const fresh = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "report" }],
    });
    expect(fresh.isError).toBe(false);
    const sessionsDir = join(session.cwd, "delegate-sessions");
    const freshFiles = readdirSync(sessionsDir);
    expect(freshFiles).toHaveLength(1);
    const freshText = readFileSync(join(sessionsDir, freshFiles[0]!), "utf8");
    expect(freshText).toContain('"session"');
    expect(freshText).toContain("report");
    expect(freshText).toContain("OK");

    subagents.respond([fauxAssistantMessage("OK"), fauxAssistantMessage("OK")]);
    const pooled1 = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "report", sessionId: "s4" }],
    });
    expect(pooled1.isError).toBe(false);
    const pooled2 = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "report", sessionId: "s4" }],
    });
    expect(pooled2.isError).toBe(false);
    const pooledFiles = readdirSync(sessionsDir).filter(
      (name) => !freshFiles.includes(name),
    );
    expect(pooledFiles).toHaveLength(1);
    const pooledText = readFileSync(join(sessionsDir, pooledFiles[0]!), "utf8");
    expect(
      (pooledText.match(/report/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);

    const prior = join(session.cwd, "prior.jsonl");
    writeFileSync(
      prior,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "prior",
          timestamp: new Date().toISOString(),
          cwd: session.cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: "PRIOR-INSTRUCTION" }],
            timestamp: Date.now(),
          },
        }),
      ].join("\n") + "\n",
    );
    subagents.respond([fauxAssistantMessage("OK")]);
    const resumed = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "report", resumeFrom: prior }],
    });
    expect(resumed.isError).toBe(false);
    const resumedText = readFileSync(prior, "utf8");
    expect(resumedText).toContain("PRIOR-INSTRUCTION");
    expect(resumedText).toContain("report");
    expect(resumedText).toContain("OK");
  });
});

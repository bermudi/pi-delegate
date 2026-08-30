import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import delegateExtension from "./extension.ts";
import { createDelegateRuntime, getDefaultDelegateRuntime } from "./runtime.ts";
import type {
  AsyncTicket,
  DelegateDetails,
  DelegateToolResult,
  ResolvedTask,
} from "./types.ts";

function makeFakeSession(): AgentSession {
  return {
    abort: () => Promise.resolve(),
    dispose: () => {},
  } as unknown as AgentSession;
}

function makeFakeManager(): SessionManager {
  return {} as unknown as SessionManager;
}

function fakeModel(): Model<Api> {
  return { provider: "openai", id: "gpt-fake" } as Model<Api>;
}

function fakeFrozenConfig() {
  return {
    systemPrompt: "test",
    model: fakeModel(),
    thinking: "normal" as const,
    tools: ["bash"],
    cwd: "/tmp",
    providerExtensions: "",
  };
}

function fakeTicket(id: string, sessionId: string | undefined): AsyncTicket {
  return {
    id,
    created: Date.now(),
    tasks: [],
    resolved: sessionId
      ? [
          {
            sessionId,
            agentName: "default",
            prompt: "p",
            cwd: "/tmp",
            tools: ["bash"],
            thinking: "normal" as const,
            model: fakeModel(),
            systemPrompt: "s",
          } as ResolvedTask,
        ]
      : [],
    status: "running",
    results: [],
    progress: [],
    controller: new AbortController(),
    parentModelId: undefined,
    spawnLeafId: undefined,
    workersSettled: false,
  };
}

describe("runtime", () => {
  test("createDelegateRuntime returns a fresh isolated runtime", () => {
    const a = createDelegateRuntime();
    const b = createDelegateRuntime();
    expect(a).not.toBe(b);
    expect(a.pool).not.toBe(b.pool);
    expect(a.tickets).not.toBe(b.tickets);
  });

  test("getDefaultDelegateRuntime returns the same default runtime", () => {
    const a = getDefaultDelegateRuntime();
    const b = getDefaultDelegateRuntime();
    expect(a).toBe(b);
    expect(a.pool).toBe(b.pool);
    expect(a.tickets).toBe(b.tickets);
  });

  test("runtimes do not share pooled sessions", () => {
    const a = createDelegateRuntime();
    const b = createDelegateRuntime();

    a.pool.commit("session-a", {
      session: makeFakeSession(),
      sessionManager: makeFakeManager(),
      sessionFile: "/tmp/session-a.jsonl",
      frozen: fakeFrozenConfig(),
      tokens: 0,
    });

    expect(a.pool.configFor("session-a")).toBeDefined();
    expect(b.pool.configFor("session-a")).toBeUndefined();
  });

  test("runtimes do not share tickets or busy indexes", () => {
    const a = createDelegateRuntime();
    const b = createDelegateRuntime();

    const ticketA = fakeTicket("ticket-a", "session-a");
    a.tickets.set(ticketA.id, ticketA);

    const ticketB = fakeTicket("ticket-b", "session-b");
    b.tickets.set(ticketB.id, ticketB);

    expect(a.tickets.get("ticket-a")).toBe(ticketA);
    expect(b.tickets.get("ticket-a")).toBeUndefined();
    expect(a.tickets.get("ticket-b")).toBeUndefined();
    expect(b.tickets.get("ticket-b")).toBe(ticketB);

    expect(a.tickets.isSessionBusy("session-a")).toBe("ticket-a");
    expect(b.tickets.isSessionBusy("session-a")).toBeNull();
    expect(b.tickets.isSessionBusy("session-b")).toBe("ticket-b");
  });

  test("session close/list and shutdown affect only the selected runtime", async () => {
    const a = createDelegateRuntime();
    const b = createDelegateRuntime();

    a.pool.commit("session-a", {
      session: makeFakeSession(),
      sessionManager: makeFakeManager(),
      sessionFile: "/tmp/session-a.jsonl",
      frozen: fakeFrozenConfig(),
      tokens: 0,
    });

    b.pool.commit("session-b", {
      session: makeFakeSession(),
      sessionManager: makeFakeManager(),
      sessionFile: "/tmp/session-b.jsonl",
      frozen: fakeFrozenConfig(),
      tokens: 0,
    });

    const aList = a.pool.listPooledAgents();
    const bList = b.pool.listPooledAgents();
    expect(aList.some((line) => line.includes("session-a"))).toBe(true);
    expect(aList.some((line) => line.includes("session-b"))).toBe(false);
    expect(bList.some((line) => line.includes("session-b"))).toBe(true);
    expect(bList.some((line) => line.includes("session-a"))).toBe(false);

    await a.pool.closeAllPooledAgents();
    expect(a.pool.configFor("session-a")).toBeUndefined();
    expect(b.pool.configFor("session-b")).toBeDefined();
  });

  test("ticket lifecycle stays attached to the creating runtime", () => {
    const a = createDelegateRuntime();
    const ticket = fakeTicket("t1", "s1");
    a.tickets.set(ticket.id, ticket);
    a.tickets.requestTicketCancel(ticket);

    expect(ticket.status).toBe("cancelling");
    expect(a.tickets.isSessionBusy("s1")).toBe("t1");

    a.tickets.settleTicket(ticket, { status: "cancelled" });
    expect(ticket.completedAt).toBeNumber();
    expect(a.tickets.isSessionBusy("s1")).toBeNull();

    const b = createDelegateRuntime();
    expect(b.tickets.isSessionBusy("s1")).toBeNull();
  });
});

type FakePiHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

type CapturedTool = {
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<DelegateDetails> | undefined,
    ctx: ExtensionContext,
  ) => Promise<DelegateToolResult>;
};

function makeFakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, FakePiHandler[]>;
} {
  const handlers = new Map<string, FakePiHandler[]>();
  let capturedTool: CapturedTool | undefined;

  const pi = {
    on(event: string, handler: FakePiHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: unknown) {
      capturedTool = tool as CapturedTool;
    },
    get tool() {
      return capturedTool;
    },
    registerMessageRenderer() {},
    getThinkingLevel() {
      return "normal";
    },
    getActiveTools() {
      return ["bash"];
    },
    sendMessage() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerEntryRenderer() {},
    exec() {
      return Promise.resolve({ ok: true, stdout: "", stderr: "", exitCode: 0 });
    },
    getCommands() {
      return [];
    },
    setModel() {
      return Promise.resolve(false);
    },
    setThinkingLevel() {},
    registerProvider() {},
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    appendEntry() {},
    sendUserMessage() {},
    getAllTools() {
      return [];
    },
  } as unknown as ExtensionAPI;

  return { pi, handlers };
}

const fakeUi = {
  notify() {},
  setStatus() {},
  setWorkingMessage() {},
  select() {
    return Promise.resolve(undefined);
  },
  confirm() {
    return Promise.resolve(true);
  },
  input() {
    return Promise.resolve(undefined);
  },
  onTerminalInput() {
    return () => {};
  },
} as unknown as ExtensionUIContext;

const fakeModelInstance = {
  provider: "openai",
  id: "gpt-fake",
} as unknown as Model<Api>;

const fakeModelRegistry = {
  find() {
    return fakeModelInstance;
  },
  hasConfiguredAuth() {
    return true;
  },
  getAvailable() {
    return [];
  },
  getApiKeyAndHeaders() {
    return { apiKey: "fake", headers: {} };
  },
} as unknown as ModelRegistry;

function makeFakeExtensionContext(cwd: string): ExtensionContext {
  return {
    cwd,
    model: fakeModelInstance,
    modelRegistry: fakeModelRegistry,
    sessionManager: undefined as unknown as SessionManager,
    scopedModels: [],
    getSystemPrompt: () => "You are a test.",
    hasUI: false,
    mode: "tui" as const,
    ui: fakeUi,
    isIdle: () => true,
    isProjectTrusted: () => false,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
  } as unknown as ExtensionContext;
}

describe("delegateExtension runtime injection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "delegate-runtime-ext-"));
    const defaultRuntime = getDefaultDelegateRuntime();
    defaultRuntime.pool.resetForTesting();
    defaultRuntime.tickets.clear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    const defaultRuntime = getDefaultDelegateRuntime();
    defaultRuntime.pool.resetForTesting();
    defaultRuntime.tickets.clear();
  });

  test("sessionAction list, ticket poll, and shutdown use the injected runtime without touching the default", async () => {
    const custom = createDelegateRuntime();
    const defaultRt = getDefaultDelegateRuntime();

    custom.pool.commit("custom-session", {
      session: makeFakeSession(),
      sessionManager: makeFakeManager(),
      sessionFile: "/tmp/custom-session.jsonl",
      frozen: fakeFrozenConfig(),
      tokens: 0,
    });

    defaultRt.pool.commit("default-session", {
      session: makeFakeSession(),
      sessionManager: makeFakeManager(),
      sessionFile: "/tmp/default-session.jsonl",
      frozen: fakeFrozenConfig(),
      tokens: 0,
    });

    const customTicket = fakeTicket("custom-ticket", "custom-session");
    custom.tickets.set(customTicket.id, customTicket);

    const defaultTicket = fakeTicket("default-ticket", "default-session");
    defaultRt.tickets.set(defaultTicket.id, defaultTicket);

    const { pi, handlers } = makeFakePi();
    delegateExtension(pi, custom);

    const tool = (pi as unknown as { tool?: CapturedTool }).tool;
    expect(tool).toBeDefined();

    const ctx = makeFakeExtensionContext(tmpDir);

    // 1. Session RPC list sees only the custom pool.
    const listResult = await tool!.execute(
      "list-1",
      { sessionAction: "list" },
      undefined,
      () => {},
      ctx,
    );
    const listText = (listResult as DelegateToolResult).content[0].text;
    expect(listText).toContain("custom-session");
    expect(listText).not.toContain("default-session");

    // 2. Ticket poll sees only the custom registry.
    const pollResult = await tool!.execute(
      "poll-1",
      { ticketAction: "poll" },
      undefined,
      () => {},
      ctx,
    );
    const pollText = (pollResult as DelegateToolResult).content[0].text;
    expect(pollText).toContain("custom-ticket");
    expect(pollText).not.toContain("default-ticket");

    // 3. Shutdown drains only the custom runtime.
    const shutdownHandlers = handlers.get("session_shutdown");
    expect(shutdownHandlers).toBeDefined();
    expect(shutdownHandlers!.length).toBeGreaterThan(0);
    for (const h of shutdownHandlers!) {
      await h({ reason: "quit" }, ctx);
    }

    expect(custom.pool.configFor("custom-session")).toBeUndefined();
    expect(defaultRt.pool.configFor("default-session")).toBeDefined();
    expect(customTicket.status).toBe("cancelled");
    expect(defaultTicket.status).toBe("running");
  });
});

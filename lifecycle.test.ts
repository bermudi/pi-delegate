/**
 * Integration tests for delegate extension's task execution lifecycle.
 *
 * These tests exercise the full execute() → acquireAgentSession → runAgentSession path,
 * verifying that tasks actually create sessions and produce output (or correct errors).
 *
 * Strategy:
 * - Use pi-test-harness to create a real session with the delegate extension loaded.
 * - Use the runner's createContext() to get a proper ExtensionContext with model, registry, etc.
 * - Patch modelRegistry.getApiKeyAndHeaders to return fake auth.
 * - Mock @earendil-works/pi-ai's streamSimple to return canned responses.
 * - This means the sub-agent's streamFn calls our mock instead of hitting a real API.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestSession } from "@marcfargas/pi-test-harness";
// The test harness loads the extension via jiti. Under bun, jiti shares its
// module graph with native imports, so the `ticketRegistry`/
// `_setHostRetryBaseMsForTesting`/`_resetPoolForTesting` imported below are the
// SAME instances the extension uses — verified empirically (an inserted pooled
// session is visible to execute()'s list action; the retry-base override reaches
// the extension's createAgentSession). We clear them in afterEach to avoid
// leaking between runs.
import { cancelTicketForShutdown, ticketRegistry } from "./delegate.ts";
import {
  _setHostRetryBaseMsForTesting,
  _setModelRuntimeFactoryForTesting,
} from "./host.ts";
import {
  _setRunAgentSessionForTesting,
  _setAcquireAgentSessionForTesting,
  _setCreateScratchWorkspaceForTesting,
  _setQuarantinePooledSessionDetachForTesting,
  _setWholeTaskRetryForTesting,
  isModelAttributableError,
  runResolvedTask,
} from "./lifecycle.ts";
import {
  _resetPoolForTesting,
  commit,
  configFor,
  listPooledAgents,
} from "./pool.ts";
import { emptyUsage } from "./usage.ts";
import {
  _resetQuarantineRegistryForTesting,
  markSessionQuarantined,
  quarantinedTasks,
  sessionQuarantineOf,
  withResumeTranscriptLock,
} from "./session-quarantine.ts";
import {
  _resetTelemetryForTesting,
  _setTelemetryForTesting,
  type TaskRecord,
} from "./telemetry.ts";
import type {
  ResolvedTask,
  TaskRunEnv,
  TaskProgress,
  AgentProgressUpdate,
  FileAttribution,
} from "./types.ts";
import { formatResumeTag, resumeMarker } from "./format.ts";

const EXTENSION = path.resolve(import.meta.dirname, "./delegate.ts");

// ── Helpers ────────────────────────────────────────────────────────────────

type TestSession = Awaited<ReturnType<typeof createTestSession>>;

/** Create a canned LLM response stream that completes immediately. */
function mockStream(text: string) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "test",
    model: "mock",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message });
  });
  return stream;
}

/** A streamSimple override installed on a model runtime to intercept subagent
 *  streaming. pi 0.80.9 AgentSession streams via `modelRuntime.streamSimple` (a
 *  bound method hitting the real provider SDK), NOT the module-level streamSimple
 *  these mocks replace — so `patchAuth` installs the returned override on the
 *  runtime. Passed explicitly (not via a module global) so every `patchAuth`
 *  call is provably paired with the stream mock it applies. */
type StreamFn = (...args: unknown[]) => unknown;

/** Set up mock.module to intercept streamSimple, and return the factory's
 *  streamSimple override (for `patchAuth` to install on the runtime). The main
 *  package entry is used by delegate's imports; pi-coding-agent 0.80+ imports
 *  streamSimple from the `/compat` subpath. Mock both so no test path can hit
 *  the network. The returned override covers the runtime path. */
function mockPiAiStream(
  factory: (orig: any) => Record<string, unknown>,
): StreamFn {
  mock.module("@earendil-works/pi-ai", factory as never);
  // pi-coding-agent 0.80+ imports streamSimple from "@earendil-works/pi-ai/compat"
  // (not the main entry), so the compat subpath must be mocked too or the
  // AgentSession streamFn calls the real, network-hitting streamSimple.
  mock.module("@earendil-works/pi-ai/compat", factory as never);
  return factory({}).streamSimple as StreamFn;
}

/** Install a stream mock returning a canned response; returns the override. */
function installStreamMock(responseText: string): StreamFn {
  return mockPiAiStream((orig) => ({
    ...orig,
    streamSimple: () => mockStream(responseText),
  }));
}

/** Patch model-runtime auth so sub-agents skip real auth.
 *  Since pi 0.80.8, AgentSession consults a `modelRuntime` (not the old
 *  `_modelRegistry`): it calls `hasConfiguredAuth`/`checkAuth` before streaming
 *  and `getAuth` to resolve credentials. We patch all of them on the parent
 *  session's runtime, then install it as the subagent runtime via the host deps
 *  test seam — subagents no longer share the parent's registry by default. */
function patchAuth(ts: TestSession, stream: StreamFn): void {
  const rt = ts.session.modelRuntime as {
    getAuth: (...a: unknown[]) => Promise<unknown>;
    hasConfiguredAuth: (...a: unknown[]) => boolean;
    isUsingOAuth: (...a: unknown[]) => boolean;
    checkAuth: (...a: unknown[]) => Promise<unknown>;
    streamSimple: (...a: unknown[]) => unknown;
  };
  rt.getAuth = async () => ({ auth: { apiKey: "test-key" } });
  rt.hasConfiguredAuth = () => true;
  rt.isUsingOAuth = () => false;
  rt.checkAuth = async () => ({ type: "api_key" }) as never;
  // pi 0.80.9 streams via modelRuntime.streamSimple; install the passed mock so
  // the subagent (reusing this runtime via the host seam) skips real providers.
  rt.streamSimple = stream;
  _setModelRuntimeFactoryForTesting(async () => ts.session.modelRuntime);
}

/** Get delegate tool definition from the test session. */
function getDelegateTool(ts: TestSession) {
  const runner = ts.session.extensionRunner;
  if (!runner) throw new Error("No extensionRunner on session");
  const toolDef = runner.getToolDefinition("delegate");
  if (!toolDef) throw new Error("delegate tool not found");
  return toolDef;
}

/** Create a proper ExtensionContext from the test session's runner. */
function getExecContext(ts: TestSession) {
  const runner = ts.session.extensionRunner;
  if (!runner) throw new Error("No extensionRunner on session");
  return runner.createContext();
}

/** Minimal ResolvedTask factory for direct runResolvedTask tests. Tests
 *  bypass `resolveTasks`, so mirror its invariant: when `resumeFrom` is set,
 *  freeze `resumeFromDisplay` from it unless the override provided one. */
function makeBaseTask(overrides: Partial<ResolvedTask> = {}): ResolvedTask {
  const base: ResolvedTask = {
    id: undefined,
    prompt: "test prompt",
    agent: undefined,
    model: { id: "test-model", api: "openai" } as never,
    tools: ["read", "write", "edit", "bash"],
    thinking: "off",
    systemPrompt: "",
    cwd: process.cwd(),
    agentName: "ad-hoc",
    warnings: [],
    ...overrides,
  };
  if (base.resumeFrom && base.resumeFromDisplay === undefined) {
    base.resumeFromDisplay = formatResumeTag(base.resumeFrom);
  }
  return base;
}

/** Minimal TaskRunEnv for direct runResolvedTask tests. */
function makeTestEnv(overrides: Partial<TaskRunEnv> = {}): TaskRunEnv {
  return {
    signal: undefined,
    modelRegistry: { resolveModel: () => undefined } as never,
    delegateStartedAt: Date.now(),
    onProgress: () => {},
    ...overrides,
  };
}

/** Progress callback that captures the latest TaskProgress. */
function makeProgressCapture(): {
  latest: () => TaskProgress | undefined;
  onProgress: (p: TaskProgress, u: AgentProgressUpdate) => void;
} {
  let current: TaskProgress | undefined;
  return {
    latest: () => current,
    onProgress: (p: TaskProgress) => {
      current = p;
    },
  };
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe("session acquisition cancellation", () => {
  afterEach(() => {
    _setAcquireAgentSessionForTesting(undefined);
    _setCreateScratchWorkspaceForTesting(undefined);
    _resetQuarantineRegistryForTesting();
  });

  test("deadline abandons a hung acquisition and disposes a session that materializes late", async () => {
    let resolveAcquisition!: (value: any) => void;
    let disposed = 0;
    _setAcquireAgentSessionForTesting(
      () =>
        new Promise((resolve) => {
          resolveAcquisition = resolve;
        }),
    );
    const task = makeBaseTask({ deadlineMs: 20 });

    try {
      const result = await runResolvedTask(
        makeTestEnv(),
        task,
        {
          index: 0,
          agent: task.agentName,
          task: task.prompt,
          status: "pending",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
        0,
      );

      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");

      resolveAcquisition({
        session: { dispose: () => disposed++ },
        sessionManager: undefined,
        sessionFile: undefined,
        lifecycleOwnsSession: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(1);
    } finally {
      _setAcquireAgentSessionForTesting(undefined);
    }
  });

  test("parent cancellation abandons a hung acquisition", async () => {
    const controller = new AbortController();
    _setAcquireAgentSessionForTesting(() => new Promise(() => {}));
    const task = makeBaseTask();

    setTimeout(() => controller.abort(), 20);
    const result = await runResolvedTask(
      makeTestEnv({ signal: controller.signal }),
      task,
      {
        index: 0,
        agent: task.agentName,
        task: task.prompt,
        status: "pending",
        durationMs: 0,
        tokens: 0,
        toolUses: 0,
        activities: [],
      },
      0,
    );

    expect(result.error).toBe("Aborted");
    expect(sessionQuarantineOf(result)).toBeDefined();
  });

  test("scratch cleanup waits for hung acquisition settlement and async late disposal", async () => {
    let resolveAcquisition!: (value: any) => void;
    let resolveDisposal!: () => void;
    let disposalStarted = 0;
    let cleaned = 0;
    _setAcquireAgentSessionForTesting(
      () =>
        new Promise((resolve) => {
          resolveAcquisition = resolve;
        }),
    );
    _setCreateScratchWorkspaceForTesting(async (sourceCwd) => ({
      sourceRoot: sourceCwd,
      sourceCwd,
      scratchRoot: "/scratch-hung-acquisition",
      cwd: "/scratch-hung-acquisition",
      mapPathToSource: (candidate: string) => candidate,
      resolveReportedPath: async (candidate: string) => candidate,
      resolveAttributedPath: async (candidate: string) => candidate,
      isDisposablePath: async () => true,
      cleanup: async () => {
        cleaned++;
      },
    }));
    const task = makeBaseTask({ workspace: "scratch", deadlineMs: 20 });

    const result = await runResolvedTask(
      makeTestEnv(),
      task,
      {
        index: 0,
        agent: task.agentName,
        task: task.prompt,
        status: "pending",
        durationMs: 0,
        tokens: 0,
        toolUses: 0,
        activities: [],
      },
      0,
    );

    const quarantine = sessionQuarantineOf(result);
    expect(result.failureKind).toBe("deadline_exceeded");
    expect(quarantine).toBeDefined();
    expect(cleaned).toBe(0);
    expect(quarantinedTasks()).toHaveLength(1);

    resolveAcquisition({
      session: {
        dispose: () => {
          disposalStarted++;
          return new Promise<void>((resolve) => {
            resolveDisposal = resolve;
          });
        },
      },
      sessionManager: undefined,
      sessionFile: undefined,
      lifecycleOwnsSession: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(disposalStarted).toBe(1);
    expect(cleaned).toBe(0);
    expect(quarantinedTasks()).toHaveLength(1);

    resolveDisposal();
    await quarantine!.safe;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleaned).toBe(1);
    expect(quarantinedTasks()).toHaveLength(0);
  });
});

describe("delegate task lifecycle integration", () => {
  let ts: TestSession | undefined;

  beforeEach(() => {
    _resetPoolForTesting();
    ticketRegistry.clear();
  });

  afterEach(() => {
    mock.restore();
    _resetPoolForTesting();
    ticketRegistry.clear();
    _setModelRuntimeFactoryForTesting(undefined);
    ts?.dispose();
    ts = undefined;
  });

  test("fresh task (no sessionId, no resumeFrom) creates agent and returns output", async () => {
    const stream = installStreamMock("I completed the task successfully.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-fresh-1",
      { tasks: [{ prompt: "say hello" }] },
      undefined,
      undefined,
      ctx,
    );

    // Should succeed — not "no agent acquired" or "no model available"
    const details = (result as any).details as {
      results: Array<{
        output?: string;
        error?: string;
        agent?: string;
        tokens?: number;
      }>;
    };

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain(
      "completed the task successfully",
    );
    expect(details.results[0]?.tokens).toBeGreaterThan(0);
    expect(details.results[0]?.agent).toBe("ad-hoc");
  });

  test("built-in default forwards the live parent thinking level and native tools", async () => {
    const stream = installStreamMock("Default configuration inherited.");
    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);
    // The harness model defaults to non-reasoning. Mark this test model as
    // reasoning-capable so the public setter can represent a live high-thinking
    // parent without being clamped back to off.
    if (!ts.session.model) throw new Error("test session has no model");
    ts.session.model.reasoning = true;
    ts.session.setThinkingLevel("high");
    expect(ts.session.thinkingLevel).toBe("high");
    ts.session.setActiveToolsByName(["read", "grep", "delegate"]);

    let childThinking: string | undefined;
    let childTools: string[] | undefined;
    const originalPrompt = AgentSession.prototype.prompt;
    AgentSession.prototype.prompt = async function promptWithConfigCapture(
      this: AgentSession,
      ...args: Parameters<AgentSession["prompt"]>
    ) {
      childThinking = this.thinkingLevel;
      childTools = this.getActiveToolNames();
      return originalPrompt.apply(this, args);
    };

    try {
      const result = await getDelegateTool(ts).execute(
        "tc-default-parent-config",
        { tasks: [{ agent: "default", prompt: "do work" }] },
        undefined,
        undefined,
        getExecContext(ts),
      );
      const details = (result as any).details as {
        results: Array<{ agent?: string; error?: string }>;
      };

      expect(details.results[0]?.error).toBeUndefined();
      expect(details.results[0]?.agent).toBe("default");
      expect(childThinking).toBe("high");
      expect(childTools).toEqual(["read", "grep"]);
    } finally {
      AgentSession.prototype.prompt = originalPrompt;
    }
  });

  test("disposes a fresh stateless session after successful completion", async () => {
    const stream = installStreamMock("Disposed after success.");
    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    let disposals = 0;
    const originalDispose = AgentSession.prototype.dispose;
    AgentSession.prototype.dispose = function disposeForTest(
      this: AgentSession,
    ) {
      disposals++;
      originalDispose.call(this);
    };

    try {
      const result = await getDelegateTool(ts).execute(
        "tc-dispose-success",
        { tasks: [{ prompt: "do work" }] },
        undefined,
        undefined,
        getExecContext(ts),
      );
      const details = (result as any).details as {
        results: Array<{ error?: string }>;
      };

      expect(details.results[0]?.error).toBeUndefined();
      expect(disposals).toBe(1);
    } finally {
      AgentSession.prototype.dispose = originalDispose;
    }
  });

  test("ad-hoc prompt inherits the parent base but not global AGENTS.md", async () => {
    const projectInstruction = "SPAWN_PROMPT_HYGIENE_PROJECT_CONTEXT";
    const globalInstruction = "SPAWN_PROMPT_HYGIENE_GLOBAL_CONTEXT";
    let capturedSystemPrompt = "";
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: (_model: unknown, context: { systemPrompt?: string }) => {
        capturedSystemPrompt = context.systemPrompt ?? "";
        return mockStream("Prompt captured.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const taskCwd = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-prompt-"));
    try {
      fs.writeFileSync(
        path.join(taskCwd, "AGENTS.md"),
        projectInstruction,
        "utf-8",
      );

      const toolDef = getDelegateTool(ts);
      const ctx = getExecContext(ts);
      (ctx as any).getSystemPrompt = () =>
        [
          "PARENT_EFFECTIVE_PROMPT_SHOULD_BE_INHERITED",
          "- delegate: verbose parent tool docs",
          "",
          "<project_context>",
          "",
          "Project-specific instructions and guidelines:",
          "",
          `<project_instructions path="${path.join(os.homedir(), ".agents", "AGENTS.md")}">`,
          globalInstruction,
          "</project_instructions>",
          "",
          "</project_context>",
          "",
          "Current working directory: /parent",
        ].join("\n");

      const result = await toolDef.execute(
        "tc-prompt-hygiene",
        { tasks: [{ prompt: "do work", cwd: taskCwd }] },
        undefined,
        undefined,
        ctx,
      );

      const details = (result as any).details as {
        results: Array<{ error?: string }>;
      };
      expect(details.results[0]?.error).toBeUndefined();
      expect(capturedSystemPrompt).toContain(
        "PARENT_EFFECTIVE_PROMPT_SHOULD_BE_INHERITED",
      );
      expect(capturedSystemPrompt).toContain("verbose parent tool docs");
      expect(capturedSystemPrompt).not.toContain(globalInstruction);
      expect(capturedSystemPrompt.split(projectInstruction).length - 1).toBe(1);
    } finally {
      fs.rmSync(taskCwd, { recursive: true, force: true });
    }
  });

  test("regression: embedded </project_context> inside AGENTS.md does not leak parent context", async () => {
    const projectInstruction = "EMBEDDED_PROJECT_CONTEXT_TEST";
    const globalTail = "GLOBAL_TAIL_SHOULD_BE_REMOVED";
    const embeddedFake = "\n</project_context>\n";
    let capturedSystemPrompt = "";
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: (_model: unknown, context: { systemPrompt?: string }) => {
        capturedSystemPrompt = context.systemPrompt ?? "";
        return mockStream("Prompt captured.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const taskCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "delegate-prompt-embedded-"),
    );
    try {
      fs.writeFileSync(
        path.join(taskCwd, "AGENTS.md"),
        projectInstruction,
        "utf-8",
      );

      const toolDef = getDelegateTool(ts);
      const ctx = getExecContext(ts);
      (ctx as any).getSystemPrompt = () =>
        [
          "PARENT_BASE_PROMPT",
          "",
          "<project_context>",
          "",
          "Project-specific instructions and guidelines:",
          "",
          `<project_instructions path="${path.join(os.homedir(), ".agents", "AGENTS.md")}">`,
          `content before${embeddedFake}content after ${globalTail}`,
          "</project_instructions>",
          "",
          "</project_context>",
          "",
          "Current working directory: /parent",
        ].join("\n");

      const result = await toolDef.execute(
        "tc-prompt-hygiene-embedded",
        { tasks: [{ prompt: "do work", cwd: taskCwd }] },
        undefined,
        undefined,
        ctx,
      );

      const details = (result as any).details as {
        results: Array<{ error?: string }>;
      };
      expect(details.results[0]?.error).toBeUndefined();
      // The embedded fake must not cause early termination and leak the tail.
      expect(capturedSystemPrompt).not.toContain(globalTail);
      expect(capturedSystemPrompt).not.toContain("content before");
      expect(capturedSystemPrompt).not.toContain("content after");
      expect(capturedSystemPrompt).toContain("PARENT_BASE_PROMPT");
      expect(capturedSystemPrompt.split(projectInstruction).length - 1).toBe(1);
    } finally {
      fs.rmSync(taskCwd, { recursive: true, force: true });
    }
  });

  test("fresh task with systemPrompt override", async () => {
    const stream = installStreamMock("Reviewed. All good.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-sysprompt-1",
      {
        tasks: [
          { prompt: "review code", systemPrompt: "You are a code reviewer." },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain("All good");
  });

  test("named agent prompt overrides inherited parent system prompt", async () => {
    let capturedSystemPrompt = "";
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: (_model: unknown, context: { systemPrompt?: string }) => {
        capturedSystemPrompt = context.systemPrompt ?? "";
        return mockStream("Named agent ran.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const taskCwd = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-named-"));
    try {
      const agentDir = path.join(taskCwd, ".pi", "agents");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "named-reviewer.md"),
        [
          "---",
          "name: named-reviewer",
          "description: Reviews code",
          "tools: *",
          "---",
          "NAMED_AGENT_SYSTEM_PROMPT",
        ].join("\n"),
        "utf-8",
      );

      const toolDef = getDelegateTool(ts);
      const baseCtx = getExecContext(ts);
      const ctx = Object.create(baseCtx) as typeof baseCtx;
      Object.defineProperty(ctx, "cwd", { value: taskCwd });
      Object.defineProperty(ctx, "getSystemPrompt", {
        value: () => "PARENT_PROMPT_SHOULD_NOT_WIN",
      });

      const result = await toolDef.execute(
        "tc-named-prompt",
        { tasks: [{ agent: "named-reviewer", prompt: "review" }] },
        undefined,
        undefined,
        ctx,
      );

      const details = (result as any).details as {
        results: Array<{ error?: string }>;
      };
      expect(details.results[0]?.error).toBeUndefined();
      expect(capturedSystemPrompt).toContain("NAMED_AGENT_SYSTEM_PROMPT");
      expect(capturedSystemPrompt).not.toContain(
        "PARENT_PROMPT_SHOULD_NOT_WIN",
      );
    } finally {
      fs.rmSync(taskCwd, { recursive: true, force: true });
    }
  });

  test("named agent discovery is parent-scoped, not per-task cwd", async () => {
    // Agent discovery uses ctx.cwd (parent session), not the per-task cwd.
    // A .pi/agents/ghost.md placed in the per-task cwd must NOT be discovered.
    const stream = installStreamMock("Should never run.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const perTaskCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "delegate-discovery-"),
    );
    try {
      const agentDir = path.join(perTaskCwd, ".pi", "agents");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "ghost.md"),
        [
          "---",
          "name: ghost",
          "description: Should not be discovered via per-task cwd",
          "---",
          "GHOST_PROMPT",
        ].join("\n"),
        "utf-8",
      );

      const toolDef = getDelegateTool(ts);
      // Parent ctx.cwd left at default (no .pi/agents/ghost.md).
      const ctx = getExecContext(ts);

      const result = await toolDef.execute(
        "tc-discovery-scope",
        { tasks: [{ agent: "ghost", prompt: "boo", cwd: perTaskCwd }] },
        undefined,
        undefined,
        ctx,
      );

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Unknown agent");
      expect(text).toContain("ghost");
    } finally {
      fs.rmSync(perTaskCwd, { recursive: true, force: true });
    }
  });

  test("parent model with no auth falls back to available alternative", async () => {
    // Track which model the sub-agent actually used.
    let usedModelId: string | undefined;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: (model: any) => {
        usedModelId = model.id;
        return mockStream("Used alternative model.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    // Stub the runtime's auth + stream so the sub-agent runs without real
    // credentials or network. This is separate from the facade patching below,
    // which only governs model *selection* in task-resolution.
    patchAuth(ts, stream);

    // Set up the parent model: same id as the alternative, but with
    // a provider that has no configured auth. The registry should
    // have a fallback model with the same id under a different provider.
    // ctx.modelRegistry is the facade task-resolution reads (pi 0.80.9 dropped
    // the old `session._modelRegistry` field for `session.modelRuntime`).
    const ctx = getExecContext(ts);
    const reg = (ctx as any).modelRegistry;

    // Patch hasConfiguredAuth: the parent model has no auth, the alt does.
    reg.hasConfiguredAuth = (m: any) => {
      return m.provider === "opencode-go";
    };

    // Patch getApiKeyAndHeaders: only works for the alt provider.
    reg.getApiKeyAndHeaders = async (m: any) => {
      if (m.provider === "opencode-go") {
        return { ok: true, apiKey: "test-key" };
      }
      return { ok: false, error: "No API key for provider" };
    };

    // Inject an alternative model with the same id but different provider.
    // The parent's model is whatever the harness set up (openai/gpt-4o).
    // We need to register a model with the same id under a different provider.
    const harnessModel = ts.session.model;
    if (!harnessModel) throw new Error("Harness has no model");

    const altModel = {
      ...harnessModel,
      provider: "opencode-go",
    };

    // Override getAll to include the alternative.
    const origGetAll = reg.getAll?.bind(reg);
    reg.getAll = () => [harnessModel, altModel];
    reg.getAvailable = () =>
      [harnessModel, altModel].filter((m) => reg.hasConfiguredAuth(m));

    // The parent's model has no auth (provider is "openai", not "opencode-go").
    // The alternative has auth. The sub-agent should use the alternative.
    const toolDef = getDelegateTool(ts);

    const result = await toolDef.execute(
      "tc-model-fallback",
      { tasks: [{ prompt: "test" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain("Used alternative model");
    // The sub-agent should have used the alternative provider
    expect(usedModelId).toBe(harnessModel.id);
  });

  test("multiple fresh tasks run in parallel and all succeed", async () => {
    let callCount = 0;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStream(`Task ${callCount} done.`);
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);
    const updates: any[] = [];

    const result = await toolDef.execute(
      "tc-parallel-1",
      {
        tasks: [
          { prompt: "task A", tools: ["read"] },
          { prompt: "task B", tools: ["read"] },
          { prompt: "task C", tools: ["read"] },
        ],
      },
      undefined,
      (update: any) => updates.push(update),
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results).toHaveLength(3);
    expect(
      updates.some((update) =>
        update.details?.progress?.some((progress: any) =>
          progress.warnings?.some((warning: string) =>
            warning.includes("UNSAFE SHARED WRITES ENABLED"),
          ),
        ),
      ),
    ).toBe(false);
    for (const r of details.results) {
      expect(r.error).toBeUndefined();
      expect(r.output).toContain("done");
    }
    expect(callCount).toBe(3);
  });

  test("task with sessionId creates pooled session on first use", async () => {
    const stream = installStreamMock("Pooled task done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-pool-create-1",
      { tasks: [{ prompt: "first turn", sessionId: "my-session" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string; sessionFile?: string }>;
    };

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain("Pooled task done");

    // Verify pool state via the list action (goes through the extension's own pool)
    const listResult = await toolDef.execute(
      "tc-pool-create-1-list",
      { sessionAction: "list" },
      undefined,
      undefined,
      ctx,
    );
    const listDetails = (listResult as any).details as {
      results: Array<{ output?: string }>;
    };
    expect(listDetails.results[0]?.output).toContain("my-session");
  });

  test("task with sessionId reuses pooled session on second call", async () => {
    let callCount = 0;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStream(`Response ${callCount}`);
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    // First call — creates the pool
    const r1 = await toolDef.execute(
      "tc-pool-reuse-1",
      { tasks: [{ prompt: "first", sessionId: "reuse-sess" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(callCount).toBe(1);
    const d1 = (r1 as any).details as { results: Array<{ output?: string }> };
    expect(d1.results[0]?.output).toContain("Response 1");

    // Second call — reuses the pool
    const result = await toolDef.execute(
      "tc-pool-reuse-2",
      { tasks: [{ prompt: "second", sessionId: "reuse-sess" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain("Response 2");
    expect(callCount).toBe(2);

    // Verify the pool shows the session with 2 prompts via list action
    const listResult = await toolDef.execute(
      "tc-pool-reuse-2-list",
      { sessionAction: "list" },
      undefined,
      undefined,
      ctx,
    );
    const listText = (listResult as any).details.results[0]?.output as string;
    expect(listText).toContain("reuse-sess");
    expect(listText).toContain("2 prompts");
  });

  test("failed pooled prompt still updates pool usage statistics", async () => {
    let callCount = 0;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return callCount === 1
          ? mockStream("Seed pooled session")
          : mockStreamError("invalid api key");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);
    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    await toolDef.execute(
      "tc-pool-failed-use-seed",
      { tasks: [{ prompt: "seed", sessionId: "failed-use" }] },
      undefined,
      undefined,
      ctx,
    );
    const failed = await toolDef.execute(
      "tc-pool-failed-use",
      { tasks: [{ prompt: "fail", sessionId: "failed-use" }] },
      undefined,
      undefined,
      ctx,
    );
    expect((failed as any).details.results[0]?.error).toContain(
      "invalid api key",
    );

    const listed = await toolDef.execute(
      "tc-pool-failed-use-list",
      { sessionAction: "list" },
      undefined,
      undefined,
      ctx,
    );
    const listText = (listed as any).details.results[0]?.output as string;
    expect(listText).toContain("failed-use");
    expect(listText).toContain("2 prompts");
  });

  test("failed pool miss is disposed and never inserted", async () => {
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => mockStreamError("invalid api key"),
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);
    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const failed = await toolDef.execute(
      "tc-pool-failed-miss",
      { tasks: [{ prompt: "fail", sessionId: "never-pooled" }] },
      undefined,
      undefined,
      ctx,
    );
    expect((failed as any).details.results[0]?.error).toContain(
      "invalid api key",
    );

    const listed = await toolDef.execute(
      "tc-pool-failed-miss-list",
      { sessionAction: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect((listed as any).details.results[0]?.output).not.toContain(
      "never-pooled",
    );
  });

  test("close action tears down pooled session", async () => {
    const stream = installStreamMock("Done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    // Create
    await toolDef.execute(
      "tc-close-1",
      { tasks: [{ prompt: "init", sessionId: "close-me" }] },
      undefined,
      undefined,
      ctx,
    );

    // Verify it's there
    const listBefore = await toolDef.execute(
      "tc-close-1-list",
      { sessionAction: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect((listBefore as any).details.results[0]?.output).toContain(
      "close-me",
    );

    // Close
    const result = await toolDef.execute(
      "tc-close-2",
      { sessionAction: "close", sessionId: "close-me" },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results[0]?.output).toContain("closed");

    // Verify it's gone
    const listAfter = await toolDef.execute(
      "tc-close-2-list",
      { sessionAction: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect((listAfter as any).details.results[0]?.output).not.toContain(
      "close-me",
    );
  });

  test("list action shows active sessions", async () => {
    const stream = installStreamMock("Done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    // Create a session
    await toolDef.execute(
      "tc-list-1",
      { tasks: [{ prompt: "init", sessionId: "list-me" }] },
      undefined,
      undefined,
      ctx,
    );

    // List
    const result = await toolDef.execute(
      "tc-list-2",
      { sessionAction: "list" },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results[0]?.output).toContain("list-me");
  });

  test("list with a stray sessionId succeeds even when that session is busy", async () => {
    // A list call should never attach sessionId to the internal bridge task:
    // validateTasks would treat it as a real session key and fail with
    // "Session(s) already in use" if that session is claimed by a running
    // async ticket. Use a hanging stream so the async task stays running.
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        const s = createAssistantMessageEventStream();
        // Never push done — keeps the async worker running and the session busy.
        return s;
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    // Start an async task with a named session — this makes "busy-list"
    // busy in the ticket busy-index.
    const dispatch = await toolDef.execute(
      "tc-busy-list-1",
      {
        async: true,
        tasks: [
          { prompt: "long work", sessionId: "busy-list", tools: ["read"] },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    const ticketId = (dispatch.details as any).ticketId;
    expect(ticketId).toBeDefined();
    const ticket = ticketRegistry.get(ticketId);

    try {
      if (!ticket?.completion) throw new Error("async ticket has no completion");

      // list with the same sessionId must succeed — list does not target a
      // specific session, so the sessionId is a no-op caller mistake.
      const listResult = await toolDef.execute(
        "tc-busy-list-2",
        { sessionAction: "list", sessionId: "busy-list" },
        undefined,
        undefined,
        ctx,
      );
      const listText = (listResult as any).content[0]?.text as string;
      // A busy-session rejection would surface as a notice here — the fix
      // ensures list never attaches sessionId to the bridge task.
      expect(listText).not.toContain("already in use");
      expect(listText).not.toContain("quarantined");
      expect(listText).toContain("Active sessions");
    } finally {
      if (ticket) {
        cancelTicketForShutdown(ticket);
        await ticket.completion;
      }
    }
  });

  test("async read-only tasks avoid overlapping-writer rejection and remain pollable", async () => {
    const stream = installStreamMock("Async task done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const dispatch = await toolDef.execute(
      "tc-async-1",
      {
        async: true,
        tasks: [
          { prompt: "async work A", tools: ["read"] },
          { prompt: "async work B", tools: ["read"] },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const ticketId = (dispatch.details as any).ticketId;
    expect(ticketId).toBeDefined();
    expect(dispatch.content[0]?.text).not.toContain("Rejected before dispatch");
    expect((dispatch.details as any).progress).toHaveLength(2);

    // Poll until settled
    let pollResult: any;
    for (let i = 0; i < 50; i++) {
      pollResult = await toolDef.execute(
        `tc-async-1-poll-${i}`,
        { ticketAction: "poll", ticket: ticketId },
        undefined,
        undefined,
        ctx,
      );
      const details = pollResult.details as {
        status?: string;
        results?: Array<{ error?: string }>;
      };
      if (details.status === "done" || details.status === "failed") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const finalDetails = pollResult.details as {
      status: string;
      results: Array<{ output?: string; error?: string }>;
    };

    // Status is at the top level of details, not nested
    const text = pollResult.content[0]?.text ?? "";
    expect(text).not.toContain("PENDING");
    expect(text).toContain("Async task done");
    expect(finalDetails.results[0]?.output).toContain("Async task done");
    expect(finalDetails.results[0]?.error).toBeUndefined();
    expect(finalDetails.results[1]?.output).toContain("Async task done");
    expect(finalDetails.results[1]?.error).toBeUndefined();
  });

  test("unknown agent name produces clear error", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-unknown-agent",
      { tasks: [{ prompt: "do stuff", agent: "nonexistent-xyz-abc" }] },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("Unknown agent");
    expect(text).toContain("nonexistent-xyz-abc");
  });

  test("named agent without tools field inherits the full agent set (*)", async () => {
    const stream = installStreamMock("Inherited tools, ran fine.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const taskCwd = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-notools-"));
    try {
      const agentDir = path.join(taskCwd, ".pi", "agents");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "notools.md"),
        [
          "---",
          "name: notools",
          "description: Agent with no tools field",
          "---",
          "Prompt.",
        ].join("\n"),
        "utf-8",
      );

      const toolDef = getDelegateTool(ts);
      const baseCtx = getExecContext(ts);
      const ctx = Object.create(baseCtx) as typeof baseCtx;
      Object.defineProperty(ctx, "cwd", { value: taskCwd });

      // Omitted `tools:` now inherits * (DEFAULT_TOOLS), matching CC/OpenCode/
      // Devin — so the agent runs instead of being rejected.
      const result = await toolDef.execute(
        "tc-no-tools",
        { tasks: [{ agent: "notools", prompt: "do stuff" }] },
        undefined,
        undefined,
        ctx,
      );
      const details = (result as any).details as {
        results: Array<{ output?: string; error?: string }>;
      };
      expect(details.results[0]?.error).toBeUndefined();
      expect(details.results[0]?.output).toContain(
        "Inherited tools, ran fine.",
      );
    } finally {
      fs.rmSync(taskCwd, { recursive: true, force: true });
    }
  });

  test("task without prompt (and not close/list/resume) throws", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    await expect(
      toolDef.execute(
        "tc-no-prompt",
        { tasks: [{ systemPrompt: "test" }] },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("prompt is required");
  });

  test("resumeFrom rehydrates from a previous session file", async () => {
    const stream = installStreamMock("Resumed and continued.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    // Create a minimal session file with a prior conversation.
    const sessionFile = path.resolve(ts.cwd, "resume-test.jsonl");
    const sessionId = "019ebcfc-0000-7000-8000-000000000001";
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: ts.cwd,
      }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "Previous task" }],
          timestamp: Date.now(),
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Previous response." }],
          api: "openai-responses",
          provider: "test",
          model: "mock",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      }),
    ];
    fs.writeFileSync(sessionFile, lines.join("\n") + "\n");

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-resume-1",
      {
        tasks: [
          {
            prompt: "continue from where you left off",
            resumeFrom: sessionFile,
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string; sessionFile?: string }>;
    };

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain("Resumed and continued");
    // sessionFile should be the resumed file
    expect(details.results[0]?.sessionFile).toContain("resume-test.jsonl");
  });

  test("resumeFrom display tag stays bound to the caller's alias after canonicalization", async () => {
    // Regression: lifecycle replaces `resumeFrom` with the canonical transcript
    // path for locking/acquisition. A symlink whose basename differs from its
    // target used to leak the canonical basename into the settled row's
    // `resumedFrom`, disagreeing with the live progress row and `agentName`
    // (both derived from the caller's alias) and defeating `resumeMarker`'s
    // no-duplication rule. The display tag must follow the caller's alias.
    const stream = installStreamMock("Resumed via alias.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const target = path.resolve(ts.cwd, "real-transcript.jsonl");
    const alias = path.resolve(ts.cwd, "alias-link.jsonl");
    const sessionId = "019ebcfc-0000-7000-8000-000000000002";
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: ts.cwd,
      }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "Previous task" }],
          timestamp: Date.now(),
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Previous response." }],
          api: "openai-responses",
          provider: "test",
          model: "mock",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      }),
    ];
    fs.writeFileSync(target, lines.join("\n") + "\n");
    fs.symlinkSync(target, alias);

    try {
      const toolDef = getDelegateTool(ts);
      const ctx = getExecContext(ts);

      const result = await toolDef.execute(
        "tc-resume-alias",
        {
          tasks: [
            {
              prompt: "continue from where you left off",
              resumeFrom: alias,
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const details = (result as any).details as {
        results: Array<{
          output?: string;
          error?: string;
          agent?: string;
          resumedFrom?: string;
          sessionFile?: string;
        }>;
        progress: Array<{ agent: string; resumedFrom?: string }>;
      };

      expect(details.results[0]?.error).toBeUndefined();
      const aliasTag = formatResumeTag(alias);
      // The settled row keeps the caller's alias tag, not the canonical target.
      expect(details.results[0]?.resumedFrom).toBe(aliasTag);
      expect(details.results[0]?.agent).toBe(`resume:${aliasTag}`);
      // The live progress row and the settled row share one display tag, so
      // `resumeMarker` does not double-mark the revival.
      expect(details.progress[0]?.resumedFrom).toBe(aliasTag);
      expect(details.progress[0]?.agent).toBe(`resume:${aliasTag}`);
      expect(
        resumeMarker({
          agent: details.results[0]!.agent!,
          resumedFrom: details.results[0]!.resumedFrom,
        }),
      ).toBe("");
      // Acquisition still used the canonical target path.
      expect(details.results[0]?.sessionFile).toBe(target);
    } finally {
      fs.rmSync(alias, { force: true });
    }
  });

  test("resumeFrom with nonexistent file returns error", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-resume-404",
      {
        tasks: [
          { prompt: "resume", resumeFrom: "/nonexistent/path/session.jsonl" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ error?: string }>;
    };

    expect(details.results[0]?.error).toContain("file not found");
  });

  test("resumeFrom with placeholder string returns invalid path error", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-resume-invalid",
      {
        tasks: [
          {
            prompt: "resume",
            resumeFrom:
              "polling-state-needed-for-async-orchestration-but-this-task-is-incomplete-please-retry-the-tool-call-with-action-poll-instead.-Action:-poll",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ error?: string }>;
    };

    expect(details.results[0]?.error).toContain("invalid session path");
    expect(details.results[0]?.error).not.toContain("file not found");
  });

  test("session config mismatch rejects with actionable message", async () => {
    const stream = installStreamMock("Init.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    // Create with default tools
    await toolDef.execute(
      "tc-mismatch-1",
      {
        tasks: [{ prompt: "init", sessionId: "mismatch-me", tools: ["read"] }],
      },
      undefined,
      undefined,
      ctx,
    );

    // Try to reuse with different tools — should mismatch
    const result = await toolDef.execute(
      "tc-mismatch-2",
      {
        tasks: [{ prompt: "reuse", sessionId: "mismatch-me", tools: ["bash"] }],
      },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ error?: string }>;
    };

    expect(details.results[0]?.error).toContain("config mismatch");

    // The base system prompt is frozen in a live AgentSession. An explicit
    // override must fail rather than being silently ignored.
    const promptMismatch = await toolDef.execute(
      "tc-mismatch-prompt",
      {
        tasks: [
          {
            prompt: "reuse",
            sessionId: "mismatch-me",
            tools: ["read"],
            systemPrompt: "A different base prompt",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    const promptDetails = (promptMismatch as any).details as {
      results: Array<{ error?: string }>;
    };
    expect(promptDetails.results[0]?.error).toContain("config mismatch");
    expect(promptDetails.results[0]?.error).toContain("systemPrompt");
  });
});

// ── Retry & Error Recovery ───────────────────────────────────────────────────

/** Mock stream that returns a failed assistant message (triggers retry). */
function mockStreamError(message: string) {
  const stream = createAssistantMessageEventStream();
  const errorMsg = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: message }],
    api: "openai-responses" as const,
    provider: "test",
    model: "mock",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage: message,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "error", message: errorMsg });
  });
  return stream;
}

/** Mock that errors on the first N calls, then returns a success stream.
 *  Returns the override (for `patchAuth`). */
function installFailingThenSuccess(
  failCount: number,
  failMessage: string,
  successText: string,
): StreamFn {
  let callCount = 0;
  return mockPiAiStream((orig) => ({
    ...orig,
    streamSimple: () => {
      callCount++;
      if (callCount <= failCount) {
        return mockStreamError(failMessage);
      }
      return mockStream(successText);
    },
  }));
}

describe("delegate retry and error recovery", () => {
  let ts: TestSession | undefined;
  const realRandom = Math.random;

  beforeEach(() => {
    // AgentSession owns retry (strip-and-continue + exponential backoff read
    // from the shared settingsManager). Shrink backoff to 1ms so retries don't
    // sleep real seconds; zero jitter via Math.random stub.
    Math.random = () => 0;
    _setHostRetryBaseMsForTesting(1);
    // Shrink whole-task retry delay too (1ms base) so multi-retry tests don't
    // sleep real seconds in the delegate-level backoff loop.
    _setWholeTaskRetryForTesting({ maxRetries: 3, baseDelayMs: 1 });
  });

  afterEach(() => {
    mock.restore();
    _resetPoolForTesting();
    ticketRegistry.clear();
    _setModelRuntimeFactoryForTesting(undefined);
    Math.random = realRandom;
    ts?.dispose();
    ts = undefined;
    _setHostRetryBaseMsForTesting(undefined);
    _setWholeTaskRetryForTesting(undefined);
  });

  test("transient error → retry → success", async () => {
    const stream = installFailingThenSuccess(
      1,
      "connection refused",
      "Recovered successfully.",
    );

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-retry-1",
      { tasks: [{ prompt: "do work" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string; tokens?: number }>;
    };

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain("Recovered successfully");
    expect(details.results[0]?.tokens).toBeGreaterThan(0);
  });

  test("rate-limit error → retry → success", async () => {
    const stream = installFailingThenSuccess(
      1,
      "rate limit exceeded, try again later",
      "Rate limit cleared.",
    );

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-retry-rate",
      { tasks: [{ prompt: "do work" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain("Rate limit cleared");
  });

  test("transient final failure → fresh whole-task retry → success", async () => {
    let callCount = 0;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        // AgentSession consumes the first 4 calls (initial + 3 internal
        // retries). The 5th call proves delegate started a fresh whole-task
        // attempt after the final transient 429.
        if (callCount <= 4) {
          return mockStreamError(
            '429: {"code":"1305","message":"The service may be temporarily overloaded"}',
          );
        }
        return mockStream("Recovered on fresh task attempt.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-whole-task-retry",
      { tasks: [{ prompt: "do work" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{
        output?: string;
        error?: string;
        tokens?: number;
        usage?: { totalTokens: number };
      }>;
      progress: Array<{ tokens: number }>;
    };

    expect(callCount).toBe(5);
    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain(
      "Recovered on fresh task attempt",
    );
    // Four failed provider calls (the first AgentSession attempt) and one
    // successful call (the fresh whole-task attempt) all count. The final
    // result and progress row must expose that same accumulated total.
    expect(details.results[0]?.usage?.totalTokens).toBe(150);
    expect(details.results[0]?.tokens).toBe(150);
    expect(details.results[0]?.tokens).toBe(
      details.results[0]?.usage?.totalTokens,
    );
    expect(details.progress[0]?.tokens).toBe(150);
  });

  test("abort during whole-task retry backoff keeps tokens aligned with usage", async () => {
    // Let one fresh whole-task retry complete, then cancel while the next
    // retry is sleeping. This exercises the branch that used to replace only
    // usage and leave tokens at the last attempt's value.
    _setWholeTaskRetryForTesting({ maxRetries: 3, baseDelayMs: 200 });
    const controller = new AbortController();
    let callCount = 0;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        if (callCount === 8) {
          abortTimer = setTimeout(() => controller.abort(), 50);
        }
        return mockStreamError("connection refused");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    try {
      const toolDef = getDelegateTool(ts);
      const ctx = getExecContext(ts);
      const result = await toolDef.execute(
        "tc-whole-task-retry-abort",
        { tasks: [{ prompt: "do work" }] },
        controller.signal,
        undefined,
        ctx,
      );

      const details = (result as any).details as {
        results: Array<{
          error?: string;
          tokens?: number;
          usage?: { totalTokens: number };
        }>;
        progress: Array<{ tokens: number }>;
      };

      expect(callCount).toBe(8);
      expect(details.results[0]?.error).toBe("Aborted");
      expect(details.results[0]?.usage?.totalTokens).toBe(240);
      expect(details.results[0]?.tokens).toBe(240);
      expect(details.results[0]?.tokens).toBe(
        details.results[0]?.usage?.totalTokens,
      );
      expect(details.progress[0]?.tokens).toBe(240);
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
  });

  test("non-retryable error → immediate failure, no retry", async () => {
    let callCount = 0;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStreamError("invalid api key");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-retry-nonretryable",
      { tasks: [{ prompt: "do work" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(callCount).toBe(1); // No retry attempted
    expect(details.results[0]?.error).toBeDefined();
  });

  test("model-attributable error (usage limit) → failureKind model_error, no whole-task retry, model-swap hint", async () => {
    // A session/account usage limit is NOT transient for the resolved model.
    // delegate must: tag it model_error, skip same-model whole-task retry, and
    // surface a "retry with a different model" hint so the parent resumes on
    // another model instead of burning retries into the same wall.
    let callCount = 0;
    const usageLimitMsg =
      '429 "you (bermudi) have reached your session usage limit, upgrade for higher limits: https://ollama.com/upgrade (ref: 521d2571)"';
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStreamError(usageLimitMsg);
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-model-error",
      { tasks: [{ prompt: "do work" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{
        error?: string;
        failureKind?: string;
        sessionFile?: string;
      }>;
    };
    const content = (result as any).content as Array<{
      type: string;
      text: string;
    }>;
    const contentText = content.map((c) => c.text).join("\n");

    expect(details.results[0]?.error).toContain("usage limit");
    expect(details.results[0]?.failureKind).toBe("model_error");
    // No whole-task retry: callCount is at most AgentSession's internal retry
    // budget for one attempt (4), NOT 4×(1+maxRetries)=16 as a transient error
    // would produce. This proves canRetryWholeTask excluded model_error.
    expect(callCount).toBeLessThanOrEqual(4);
    // The LLM-facing content must steer the parent at the `model` field.
    expect(contentText).toContain("To retry with a different model");
    expect(contentText).toContain("model:");
  });

  test("max retries exhausted → returns last error", async () => {
    let callCount = 0;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStreamError("connection refused");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-retry-exhaust",
      { tasks: [{ prompt: "do work" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    // AgentSession internal retry (4 calls/attempt) × whole-task retries (4
    // attempts at default maxRetries=3) = up to 16 calls. Just verify > 1.
    expect(callCount).toBeGreaterThan(1);
    expect(details.results[0]?.error).toContain("connection refused");
  });

  test("succeeds after multiple retries (clean transcript via strip-and-continue)", async () => {
    let callCount = 0;
    // Track message count on each call. AgentSession's retry removes only the
    // trailing failed assistant message (strip-and-continue), so the count stays
    // roughly flat across retries — it does NOT grow by the failed response each
    // time. If strip were broken, counts would grow by 1-2 per retry.
    const messageCounts: number[] = [];
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: (_model: unknown, context: any) => {
        callCount++;
        messageCounts.push(context.messages.length);
        if (callCount <= 2) {
          return mockStreamError("network error");
        }
        return mockStream("Done after retries.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-retry-clean",
      { tasks: [{ prompt: "do work" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(callCount).toBe(3); // 2 failures + 1 success
    expect(details.results[0]?.error).toBeUndefined();
    expect(details.results[0]?.output).toContain("Done after retries");

    // Verify strip-and-continue: AgentSession removes the trailing failed
    // assistant message before each retry, so the transcript does NOT grow
    // across retries. Allow small drift (the re-added user prompt on retry).
    if (messageCounts.length >= 2) {
      const first = messageCounts[0]!;
      const second = messageCounts[1]!;
      const third = messageCounts[2]!;
      expect(Math.abs(second - first)).toBeLessThanOrEqual(1);
      expect(Math.abs(third - second)).toBeLessThanOrEqual(1);
      expect(Math.abs(third - first)).toBeLessThanOrEqual(2);
    }
  });

  test("failed first-call run still reports a resumable sessionFile on disk", async () => {
    // Reproduces the Cloudflare-524 scenario: the upstream model never
    // responds, every attempt fails, retries are exhausted. Previously the
    // reported sessionFile pointed at a file that was never written (upstream
    // SessionManager only persists after the first assistant message, and the
    // failure flush was skipped), so the parent would fabricate a resumeFrom
    // against a nonexistent path. Now the failure path force-flushes the
    // header so the path is real and resumable.
    let callCount = 0;
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        // A retryable transient error — retries will fire and exhaust.
        return mockStreamError(
          "524 https://developers.cloudflare.com/.../524-a-timeout-occurred",
        );
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const result = await toolDef.execute(
      "tc-fail-flush",
      { tasks: [{ prompt: "do work" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ error?: string; sessionFile?: string }>;
    };

    expect(callCount).toBeGreaterThan(1); // Retries fired and exhausted.
    expect(details.results[0]?.error).toContain("524");

    // The reported sessionFile MUST exist on disk — no phantom paths.
    const sessionFile = details.results[0]?.sessionFile;
    expect(sessionFile).toBeDefined();
    expect(fs.existsSync(sessionFile!)).toBe(true);

    // The persisted file is a valid session file: header line present, and
    // because AgentSession records the user prompt + failed assistant attempts
    // before retries exhaust, it also carries restorable messages — so it is
    // genuinely resumable via resumeFrom (not a header-only dead path).
    const firstLine = fs.readFileSync(sessionFile!, "utf8").split("\n")[0]!;
    const parsed = JSON.parse(firstLine);
    expect(parsed.type).toBe("session");
    const text = (result.content as Array<{ type: string; text: string }>)[0]!
      .text;
    expect(text).toContain("→ To retry: delegate(");
  });
});

// ── Abort Behavior ───────────────────────────────────────────────────────────

describe("delegate abort behavior", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    mock.restore();
    _resetPoolForTesting();
    ticketRegistry.clear();
    _setModelRuntimeFactoryForTesting(undefined);
    ts?.dispose();
    ts = undefined;
  });

  test("abort signal stops all tasks and returns Aborted status (no undefined holes)", async () => {
    // Mock that hangs so the abort signal has time to fire.
    const stream = mockPiAiStream((orig) => ({
      ...orig,
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        // Never push a done event — simulates a hung LLM call.
        return stream;
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const controller = new AbortController();
    controller.abort();

    const result = await toolDef.execute(
      "tc-abort",
      {
        tasks: [
          { prompt: "task A", tools: ["read"] },
          { prompt: "task B", tools: ["read"] },
          { prompt: "task C", tools: ["read"] },
        ],
      },
      controller.signal,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    // All 3 tasks should be present (no undefined holes) and report Aborted.
    expect(details.results).toHaveLength(3);
    for (const r of details.results) {
      expect(r.error).toBe("Aborted");
    }
  });
});

// ── Pool-Miss + ResumeFrom + SessionId Combination ──────────────────────────

describe("delegate pool-miss with resumeFrom and sessionId", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    mock.restore();
    _resetPoolForTesting();
    ticketRegistry.clear();
    _setModelRuntimeFactoryForTesting(undefined);
    ts?.dispose();
    ts = undefined;
  });

  test("sessionId not in pool + resumeFrom set → resumes and pools for reuse", async () => {
    const stream = installStreamMock("Resumed and pooled.");

    const tmpDir = fs.mkdtempSync("/tmp/delegate-pool-resume-");
    const sessionFile = path.resolve(tmpDir, "pool-resume.jsonl");
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "pool-resume-session",
        timestamp: new Date().toISOString(),
        cwd: tmpDir,
      }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "Original task" }],
          timestamp: Date.now(),
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Original response." }],
          api: "openai-responses",
          provider: "test",
          model: "mock",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      }),
    ];
    fs.writeFileSync(sessionFile, lines.join("\n") + "\n");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    // First call: sessionId is new (pool miss) + resumeFrom set.
    // The extension should resume from the file and pool the session.
    const r1 = await toolDef.execute(
      "tc-pool-resume-1",
      {
        tasks: [
          {
            prompt: "continue from resume",
            sessionId: "new-pooled-session",
            resumeFrom: sessionFile,
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const d1 = (r1 as any).details as {
      results: Array<{ output?: string; error?: string; sessionFile?: string }>;
    };

    expect(d1.results[0]?.error).toBeUndefined();
    expect(d1.results[0]?.output).toContain("Resumed and pooled");

    // Second call: same sessionId should be a pool hit.
    const r2 = await toolDef.execute(
      "tc-pool-resume-2",
      {
        tasks: [
          { prompt: "continue in pool", sessionId: "new-pooled-session" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const d2 = (r2 as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(d2.results[0]?.error).toBeUndefined();
    expect(d2.results[0]?.output).toContain("Resumed and pooled");

    // Verify the session is in the pool with 2 prompts.
    const listResult = await toolDef.execute(
      "tc-pool-resume-list",
      { sessionAction: "list" },
      undefined,
      undefined,
      ctx,
    );
    const listText = (listResult as any).details.results[0]?.output as string;
    expect(listText).toContain("new-pooled-session");
    expect(listText).toContain("2 prompts");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("task telemetry boundary", () => {
  // Telemetry rows are recorded exactly once per runResolvedTask, at the
  // outermost boundary, on the final result — not per attempt and not
  // provisionally inside the scratch wrapper (which used to force a second
  // correction write). These tests pin that invariant with an injected
  // recorder.
  const mkTask = (overrides: Partial<ResolvedTask> = {}) => {
    const base = {
      prompt: "do work",
      model: { id: "m", provider: "p", api: "openai-responses" } as never,
      tools: ["read"],
      thinking: "default",
      systemPrompt: "",
      cwd: process.cwd(),
      agentName: "inline",
      warnings: [],
      ...overrides,
    } as ResolvedTask;
    if (base.resumeFrom && base.resumeFromDisplay === undefined) {
      base.resumeFromDisplay = formatResumeTag(base.resumeFrom);
    }
    return base as never;
  };

  const mkProgressRow = () =>
    ({
      index: 0,
      agent: "inline",
      task: "do work",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    }) as never;

  const mkEnv = () =>
    ({
      signal: undefined,
      modelRegistry: {} as never,
      delegateStartedAt: Date.now(),
      telemetryCallId: "tc-telemetry-once",
      onProgress: () => {},
    }) as never;

  test("runResolvedTask records exactly one task row, on the final result", async () => {
    const taskRows: TaskRecord[] = [];
    _setTelemetryForTesting({
      recordCall: () => {},
      recordTask: (r) => taskRows.push(r),
    });

    let runCalls = 0;
    _setRunAgentSessionForTesting(async () => {
      runCalls++;
      return {
        output: "ok",
        durationMs: 5,
        tokens: 7,
        usage: { ...emptyUsage(), totalTokens: 7 },
        touchedFiles: [],
        attributedFiles: [],
      } as never;
    });

    try {
      const result = await runResolvedTask(
        mkEnv(),
        mkTask(),
        mkProgressRow(),
        0,
      );

      expect(result.error).toBeUndefined();
      expect(runCalls).toBe(1);
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0]!.call_id).toBe("tc-telemetry-once");
      expect(taskRows[0]!.outcome).toBe("success");
      expect(taskRows[0]!.tokens).toBe(7);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _resetTelemetryForTesting();
    }
  });

  test("a throwing status observer preserves the result and records telemetry", async () => {
    const taskRows: TaskRecord[] = [];
    _setTelemetryForTesting({
      recordCall: () => {},
      recordTask: (r) => taskRows.push(r),
    });
    _setRunAgentSessionForTesting(
      async () =>
        ({
          output: "ok",
          durationMs: 5,
          tokens: 7,
          usage: { ...emptyUsage(), totalTokens: 7 },
          touchedFiles: [],
          attributedFiles: [],
        }) as never,
    );

    let statusCalls = 0;
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const result = await runResolvedTask(
        {
          ...mkEnv(),
          onStatusChange: () => {
            statusCalls++;
            throw new Error("status observer failed");
          },
        },
        mkTask(),
        mkProgressRow(),
        0,
      );

      expect(statusCalls).toBe(1);
      expect(result.error).toBeUndefined();
      expect(result.output).toBe("ok");
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0]!.outcome).toBe("success");
    } finally {
      console.error = originalConsoleError;
      _setRunAgentSessionForTesting(undefined);
      _resetTelemetryForTesting();
    }
  });

  test("scratch success records its mapped final result once and cleans up", async () => {
    const taskRows: TaskRecord[] = [];
    _setTelemetryForTesting({
      recordCall: () => {},
      recordTask: (r) => taskRows.push(r),
    });

    let cleanupCalls = 0;
    _setCreateScratchWorkspaceForTesting(
      async () =>
        ({
          cwd: "/scratch/project",
          resolveReportedPath: async (file: string) =>
            file.replace("/scratch/project", "/source/project"),
          resolveAttributedPath: async (file: string) =>
            file.startsWith("/scratch/") ? undefined : `/canonical${file}`,
          cleanup: async () => {
            cleanupCalls++;
          },
        }) as never,
    );
    _setRunAgentSessionForTesting(
      async () =>
        ({
          output: "finished in scratch",
          durationMs: 5,
          tokens: 7,
          usage: { ...emptyUsage(), totalTokens: 7 },
          touchedFiles: ["/scratch/project/result.txt"],
          attributedFiles: ["/scratch/project/result.txt", "/host/result.txt"],
        }) as never,
    );

    try {
      const result = await runResolvedTask(
        mkEnv(),
        mkTask({ workspace: "scratch" }),
        mkProgressRow(),
        0,
      );

      expect(result.error).toBeUndefined();
      expect(result.workspace).toBe("scratch");
      expect(result.touchedFiles).toEqual(["/source/project/result.txt"]);
      expect(result.attributedFiles).toEqual(["/canonical/host/result.txt"]);
      expect(cleanupCalls).toBe(1);
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0]!.outcome).toBe("success");
      expect(taskRows[0]!.retries).toBe(0);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setCreateScratchWorkspaceForTesting(undefined);
      _resetTelemetryForTesting();
    }
  });

  test("scratch settles path projections independently and preserves failed external evidence", async () => {
    _setCreateScratchWorkspaceForTesting(
      async () =>
        ({
          cwd: "/scratch/project",
          mapPathToSource: (file: string) =>
            file.replace("/scratch/project", "/source/project"),
          resolveReportedPath: async (file: string) => {
            if (file.startsWith("/host/")) throw new Error("race");
            return file.replace("/scratch/project", "/source/project");
          },
          resolveAttributedPath: async (file: string) => file,
          resolveFileAttribution: async (entry: FileAttribution) => {
            if (entry.lexicalPath.startsWith("/host/")) {
              throw new Error("external projection failed");
            }
            return undefined;
          },
          cleanup: async () => {},
        }) as never,
    );
    _setRunAgentSessionForTesting(
      async () =>
        ({
          output: "paid-for output",
          durationMs: 5,
          tokens: 4,
          usage: { ...emptyUsage(), totalTokens: 4 },
          touchedFiles: ["/scratch/project/internal.txt", "/host/external.txt"],
          attributedFiles: ["/host/external.txt"],
          fileAttributions: [
            {
              lexicalPath: "/scratch/project/internal.txt",
              preExecutionPhysicalPath: "/scratch/project/internal.txt",
              provenance: "write",
              uncertain: false,
            },
            {
              lexicalPath: "/host/external.txt",
              preExecutionPhysicalPath: "/host/external.txt",
              provenance: "edit",
              uncertain: false,
            },
          ],
        }) as never,
    );
    const log = spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await runResolvedTask(
        mkEnv(),
        mkTask({ workspace: "scratch" }),
        mkProgressRow(),
        0,
      );

      expect(result.error).toBeUndefined();
      expect(result.output).toBe("paid-for output");
      expect(result.attributedFiles).toEqual(["/host/external.txt"]);
      expect(result.fileAttributions).toHaveLength(1);
      expect(result.fileAttributions?.[0]?.uncertain).toBe(true);
      expect(result.touchedFiles).toContain("/host/external.txt");
      expect(String(log.mock.calls[0]?.[0])).toContain(
        "scratch attribution projection failed",
      );
    } finally {
      log.mockRestore();
      _setRunAgentSessionForTesting(undefined);
      _setCreateScratchWorkspaceForTesting(undefined);
    }
  });

  test("scratch outer projection failure retains every original evidence channel as uncertain", async () => {
    _setCreateScratchWorkspaceForTesting(
      async () =>
        ({
          cwd: "/scratch/project",
          mapPathToSource: () => {
            throw new Error("lexical projection unavailable");
          },
          resolveReportedPath: async (file: string) => file,
          resolveAttributedPath: async (file: string) => file,
          resolveFileAttribution: async () => {
            throw new Error("structured projection unavailable");
          },
          cleanup: async () => {},
        }) as never,
    );
    const originalTouched = [
      "/scratch/project/touched.txt",
      "/host/touched.txt",
    ];
    const originalAttributed = [
      "/scratch/project/direct.txt",
      "/host/direct.txt",
    ];
    _setRunAgentSessionForTesting(
      async () =>
        ({
          output: "paid-for output",
          durationMs: 5,
          tokens: 9,
          usage: { ...emptyUsage(), totalTokens: 9 },
          touchedFiles: originalTouched,
          attributedFiles: originalAttributed,
          fileAttributions: [
            {
              lexicalPath: "/scratch/project/direct.txt",
              preExecutionPhysicalPath: "/scratch/project/direct.txt",
              provenance: "write",
              uncertain: false,
            },
            {
              lexicalPath: "/host/direct.txt",
              preExecutionPhysicalPath: "/host/direct.txt",
              provenance: "edit",
              uncertain: false,
            },
          ],
        }) as never,
    );
    const log = spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await runResolvedTask(
        mkEnv(),
        mkTask({ workspace: "scratch" }),
        mkProgressRow(),
        0,
      );

      expect(result.error).toContain(
        "Scratch evidence projection failed: lexical projection unavailable",
      );
      expect(result.output).toBe("paid-for output");
      expect(result.tokens).toBe(9);
      expect(result.touchedFiles).toEqual(originalTouched);
      expect(result.attributedFiles).toEqual(originalAttributed);
      expect(result.fileAttributions).toHaveLength(2);
      expect(result.fileAttributions?.every((entry) => entry.uncertain)).toBe(
        true,
      );
      expect(
        result.fileAttributions?.map((entry) => entry.lexicalPath),
      ).toEqual(originalAttributed);
    } finally {
      log.mockRestore();
      _setRunAgentSessionForTesting(undefined);
      _setCreateScratchWorkspaceForTesting(undefined);
    }
  });

  test("scratch correction records one final failed row after cleanup failure and retry", async () => {
    _setWholeTaskRetryForTesting({ maxRetries: 1, baseDelayMs: 0 });
    const taskRows: TaskRecord[] = [];
    _setTelemetryForTesting({
      recordCall: () => {},
      recordTask: (r) => taskRows.push(r),
    });

    let cleanupCalls = 0;
    _setCreateScratchWorkspaceForTesting(
      async () =>
        ({
          cwd: "/scratch/project",
          mapPathToSource: (file: string) =>
            file.replace("/scratch/project", "/source/project"),
          resolveReportedPath: async () => {
            throw new Error("could not map scratch path");
          },
          resolveAttributedPath: async () => undefined,
          cleanup: async () => {
            cleanupCalls++;
            throw new Error("lease remains");
          },
        }) as never,
    );
    let runCalls = 0;
    _setRunAgentSessionForTesting(async () => {
      runCalls++;
      return runCalls === 1
        ? ({
            output: "",
            error: "connection refused",
            durationMs: 5,
            tokens: 3,
            usage: { ...emptyUsage(), totalTokens: 3 },
            touchedFiles: [],
            attributedFiles: [],
          } as never)
        : ({
            output: "will need correction",
            durationMs: 5,
            tokens: 4,
            usage: { ...emptyUsage(), totalTokens: 4 },
            touchedFiles: ["/scratch/project/result.txt"],
            attributedFiles: [],
          } as never);
    });

    const consoleError = console.error;
    console.error = () => {};
    let statusCalls = 0;
    try {
      const result = await runResolvedTask(
        {
          ...mkEnv(),
          onStatusChange: () => {
            statusCalls++;
            throw new Error("status observer failed");
          },
        },
        mkTask({ workspace: "scratch" }),
        mkProgressRow(),
        0,
      );

      expect(runCalls).toBe(2);
      expect(result.error).not.toContain("could not map scratch path");
      expect(result.error).toContain(
        "Scratch workspace cleanup failed: lease remains",
      );
      expect(result.touchedFiles).toContain("/source/project/result.txt");
      expect(cleanupCalls).toBe(1);
      // Retry start, core completion, and scratch correction all notify; none
      // may escape this throwing observer or prevent the final telemetry row.
      expect(statusCalls).toBe(3);
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0]!.outcome).toBe("failed");
      expect(taskRows[0]!.retries).toBe(1);
      expect(taskRows[0]!.tokens).toBe(7);
    } finally {
      console.error = consoleError;
      _setRunAgentSessionForTesting(undefined);
      _setCreateScratchWorkspaceForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
      _resetTelemetryForTesting();
    }
  });

  test("a whole-task retry still records one row, carrying the retry count", async () => {
    _setWholeTaskRetryForTesting({ maxRetries: 1, baseDelayMs: 0 });
    const taskRows: TaskRecord[] = [];
    _setTelemetryForTesting({
      recordCall: () => {},
      recordTask: (r) => taskRows.push(r),
    });

    let runCalls = 0;
    _setRunAgentSessionForTesting(async () => {
      runCalls++;
      return runCalls === 1
        ? ({
            output: "",
            error: "connection refused",
            durationMs: 5,
            tokens: 3,
            usage: { ...emptyUsage(), totalTokens: 3 },
            touchedFiles: [],
            attributedFiles: [],
          } as never)
        : ({
            output: "ok",
            durationMs: 5,
            tokens: 4,
            usage: { ...emptyUsage(), totalTokens: 4 },
            touchedFiles: [],
            attributedFiles: [],
          } as never);
    });

    try {
      const result = await runResolvedTask(
        mkEnv(),
        mkTask(),
        mkProgressRow(),
        0,
      );

      expect(result.error).toBeUndefined();
      expect(runCalls).toBe(2);
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0]!.retries).toBe(1);
      expect(taskRows[0]!.outcome).toBe("success");
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
      _resetTelemetryForTesting();
    }
  });
});

describe("whole-task retry gating", () => {
  test("does not retry when a bash tool activity is observed", async () => {
    const task = {
      prompt: "do work",
      model: { id: "m", provider: "p", api: "openai-responses" } as never,
      tools: ["bash", "read"],
      thinking: "default",
      systemPrompt: "",
      cwd: process.cwd(),
      agentName: "inline",
      warnings: [],
    } as never;

    const progressRow = {
      index: 0,
      agent: "inline",
      task: "do work",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [] as Array<{
        id: string;
        name: string;
        args: { command: string };
        startTime: number;
        endTime?: number;
      }>,
    };

    let runAttempts = 0;
    let bashMarker = 0;

    _setRunAgentSessionForTesting(
      async (_s, _p, _c, _signal, onProgressCallback) => {
        runAttempts += 1;
        bashMarker += 1;
        onProgressCallback({
          tokens: 10,
          toolUses: 1,
          durationMs: 10,
          lastActivityAt: Date.now(),
          activities: [
            {
              id: "call-1",
              name: "bash",
              args: { command: "echo hi" },
              startTime: Date.now(),
            },
          ],
        });
        return {
          output: "",
          error: "connection refused",
          durationMs: 10,
          tokens: 10,
          usage: {
            input: 0,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          touchedFiles: [],
          attributedFiles: [],
        } as never;
      },
    );

    const env = {
      signal: undefined,
      modelRegistry: {} as never,
      delegateStartedAt: Date.now(),
      onProgress: (
        p: {
          activities: Array<{
            id: string;
            name: string;
            args: Record<string, unknown>;
            startTime: number;
          }>;
        },
        u: {
          tokens: number;
          toolUses: number;
          durationMs: number;
          lastActivityAt?: number;
          activities: Array<{
            id: string;
            name: string;
            args: { command: string };
            startTime: number;
            endTime?: number;
          }>;
          failureKind?: "stalled" | "model_error";
        },
      ) => {
        p.activities = u.activities;
        p.tokens = u.tokens;
        p.toolUses = u.toolUses;
        p.durationMs = u.durationMs;
        p.lastActivityAt = u.lastActivityAt;
      },
      onStatusChange: () => {},
    } as never;

    _setWholeTaskRetryForTesting({
      maxRetries: 3,
      baseDelayMs: 0,
    });

    try {
      const result = await runResolvedTask(env, task, progressRow as never, 0);

      expect(result.error).toBe("connection refused");
      expect(result.tokens).toBe(10);
      expect(runAttempts).toBe(1);
      expect(bashMarker).toBe(1);
      expect(
        progressRow.activities.some((activity) => activity.name === "bash"),
      ).toBe(true);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
    }
  });

  test("aggregates monotonic progress across retry attempts", async () => {
    const task = {
      prompt: "do work",
      model: { id: "m", provider: "p", api: "openai-responses" } as never,
      tools: ["read"],
      thinking: "default",
      systemPrompt: "",
      cwd: process.cwd(),
      agentName: "inline",
      warnings: [],
    } as never;

    const progressRow = {
      index: 0,
      agent: "inline",
      task: "do work",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [] as Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
        startTime: number;
        endTime?: number;
      }>,
    };
    const updateSamples: Array<{ tokens: number; toolUses: number }> = [];

    let runAttempts = 0;
    _setRunAgentSessionForTesting(
      async (_s, _p, _c, _signal, onProgressCallback) => {
        runAttempts += 1;
        const attempt = runAttempts;
        onProgressCallback({
          tokens: 10,
          toolUses: 1,
          durationMs: 5,
          lastActivityAt: Date.now(),
          activities: [
            {
              id: `activity-${attempt}`,
              name: attempt === 1 ? "read" : "write",
              args: { path: `file-${attempt}.txt` },
              startTime: Date.now(),
            },
          ],
        });

        if (attempt === 1) {
          return {
            output: "",
            error: "connection refused",
            durationMs: 5,
            tokens: 10,
            usage: {
              input: 0,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 10,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            touchedFiles: [],
            attributedFiles: [],
          } as never;
        }

        return {
          output: "Recovered on retry",
          error: undefined,
          durationMs: 5,
          tokens: 10,
          usage: {
            input: 0,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          touchedFiles: [],
          attributedFiles: [],
        } as never;
      },
    );

    const env = {
      signal: undefined,
      modelRegistry: {} as never,
      delegateStartedAt: Date.now(),
      onProgress: (
        p: {
          activities: Array<{
            id: string;
            name: string;
            args: Record<string, unknown>;
            startTime: number;
          }>;
        },
        u: {
          tokens: number;
          toolUses: number;
          durationMs: number;
          lastActivityAt?: number;
          activities: Array<{
            id: string;
            name: string;
            args: Record<string, unknown>;
            startTime: number;
            endTime?: number;
          }>;
          failureKind?: "stalled" | "model_error";
        },
      ) => {
        p.activities = [...p.activities, ...u.activities];
        p.tokens = u.tokens;
        p.toolUses = u.toolUses;
        p.durationMs = u.durationMs;
        p.lastActivityAt = u.lastActivityAt;
        updateSamples.push({ tokens: u.tokens, toolUses: u.toolUses });
      },
      onStatusChange: () => {},
    } as never;

    _setWholeTaskRetryForTesting({
      maxRetries: 1,
      baseDelayMs: 25,
    });

    try {
      const result = await runResolvedTask(env, task, progressRow as never, 0);

      expect(runAttempts).toBe(2);
      expect(result.error).toBeUndefined();
      expect(result.output).toBe("Recovered on retry");
      expect(result.usage.totalTokens).toBe(20);
      expect(result.tokens).toBe(20);
      expect(result.tokens).toBe(progressRow.tokens);
      expect(progressRow.toolUses).toBe(2);
      expect(progressRow.activities.map((activity) => activity.id)).toEqual([
        "activity-1",
        "activity-2",
      ]);
      expect(updateSamples.map((sample) => sample.tokens)).toEqual([10, 20]);
      expect(updateSamples.map((sample) => sample.toolUses)).toEqual([1, 2]);
      expect(progressRow.durationMs).toBeGreaterThanOrEqual(25);
      expect(progressRow.durationMs).toBe(result.durationMs);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
    }
  });

  test("keeps wall-time and counters when abort happens during backoff", async () => {
    const task = {
      prompt: "do work",
      model: { id: "m", provider: "p", api: "openai-responses" } as never,
      tools: ["read"],
      thinking: "default",
      systemPrompt: "",
      cwd: process.cwd(),
      agentName: "inline",
      warnings: [],
    } as never;

    const progressRow = {
      index: 0,
      agent: "inline",
      task: "do work",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [] as Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
        startTime: number;
        endTime?: number;
      }>,
    };

    let runAttempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let resolveFirstProgress!: () => void;
    const firstProgress = new Promise<void>((resolve) => {
      resolveFirstProgress = resolve;
    });

    _setRunAgentSessionForTesting(
      async (_s, _p, _c, _signal, onProgressCallback) => {
        runAttempts += 1;
        onProgressCallback({
          tokens: 15,
          toolUses: 1,
          durationMs: 5,
          lastActivityAt: Date.now(),
          activities: [
            {
              id: "activity-1",
              name: "read",
              args: { path: "read.txt" },
              startTime: Date.now(),
            },
          ],
        });
        return {
          output: "",
          error: "connection refused",
          durationMs: 5,
          tokens: 15,
          usage: {
            input: 0,
            output: 15,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          touchedFiles: [],
          attributedFiles: [],
        } as never;
      },
    );

    const env = {
      signal: controller.signal,
      modelRegistry: {} as never,
      delegateStartedAt: Date.now(),
      onProgress: (
        p: {
          activities: Array<{
            id: string;
            name: string;
            args: Record<string, unknown>;
            startTime: number;
          }>;
        },
        u: {
          tokens: number;
          toolUses: number;
          durationMs: number;
          lastActivityAt?: number;
          activities: Array<{
            id: string;
            name: string;
            args: Record<string, unknown>;
            startTime: number;
            endTime?: number;
          }>;
          failureKind?: "stalled" | "model_error";
        },
      ) => {
        p.activities = u.activities;
        p.tokens = u.tokens;
        p.toolUses = u.toolUses;
        p.durationMs = u.durationMs;
        p.lastActivityAt = u.lastActivityAt;
        if (runAttempts === 1) {
          resolveFirstProgress();
        }
      },
      onStatusChange: () => {},
    } as never;

    _setWholeTaskRetryForTesting({
      maxRetries: 3,
      // Large enough that the abort below reliably lands inside the backoff.
      // The abort cuts the wait short, so the test does not pay this cost.
      baseDelayMs: 2000,
    });

    try {
      const running = runResolvedTask(env, task, progressRow as never, 0);
      await firstProgress;
      timer = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }, 15);

      const result = await running;

      expect(result.error).toBe("Aborted");
      expect(runAttempts).toBe(1);
      expect(result.tokens).toBe(15);
      expect(result.usage.totalTokens).toBe(15);
      expect(result.tokens).toBe(progressRow.tokens);
      expect(progressRow.durationMs).toBeGreaterThanOrEqual(10);
      expect(progressRow.durationMs).toBe(result.durationMs);
    } finally {
      if (timer) clearTimeout(timer);
      _setRunAgentSessionForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
    }
  });
});

describe("delegate retry and deadline", () => {
  test("wakes from retry backoff before the full delay when the deadline passes first", async () => {
    const task = makeBaseTask({ deadlineMs: 100 });
    const env = makeTestEnv();

    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    const { onProgress, latest } = makeProgressCapture();
    env.onProgress = onProgress;

    let runAttempts = 0;
    _setWholeTaskRetryForTesting({ maxRetries: 2, baseDelayMs: 2000 });
    _setRunAgentSessionForTesting(async () => {
      runAttempts += 1;
      await new Promise((r) => setTimeout(r, 5));
      return {
        output: "",
        error: "connection refused",
        durationMs: 5,
        tokens: 5,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
      } as never;
    });

    try {
      const result = await runResolvedTask(env, task, progress as never, 0);
      expect(runAttempts).toBe(1);
      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(result.error).not.toBe("connection refused");
      expect(result.tokens).toBe(5);
      expect(result.durationMs).toBeLessThan(500);
    } finally {
      _setWholeTaskRetryForTesting(undefined);
      _setRunAgentSessionForTesting(undefined);
    }
  });

  test("does not whole-task retry a deadline_exceeded result", async () => {
    const task = makeBaseTask();
    const env = makeTestEnv();
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    let runAttempts = 0;
    _setWholeTaskRetryForTesting({ maxRetries: 3, baseDelayMs: 0 });
    _setRunAgentSessionForTesting(async () => {
      runAttempts++;
      return {
        output: "",
        error:
          "Deadline exceeded: task exceeded its 1ms wall-clock budget and was cooperatively aborted (not a hard kill).",
        durationMs: 1,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
        failureKind: "deadline_exceeded",
        prompted: false,
      } as never;
    });

    try {
      const result = await runResolvedTask(env, task, progress as never, 0);
      expect(runAttempts).toBe(1);
      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
    } finally {
      _setWholeTaskRetryForTesting(undefined);
      _setRunAgentSessionForTesting(undefined);
    }
  });
});

// ── Pre-prompt deadline vs. mid-prompt deadline ───────────────────────────
// Runner surfaces a `prompted` flag on deadline_exceeded. Lifecycle must keep
// an existing pooled session intact when the deadline fired before prompt(), and
// must still dispose it when the session was actually prompted.

describe("delegate pre-prompt deadline and pool", () => {
  function makeFakeAgentSession(sessionFile: string): AgentSession {
    return {
      subscribe: () => () => {},
      prompt: async () => {},
      abort: async () => {},
      dispose: () => {},
      abortCompaction: () => {},
      abortBranchSummary: () => {},
      get isIdle() {
        return true;
      },
      get isCompacting() {
        return false;
      },
      get messages() {
        return [];
      },
      get state() {
        return {};
      },
      getSessionStats: () => ({
        sessionFile,
        sessionId: "test",
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        cost: 0,
      }),
    } as unknown as AgentSession;
  }

  function makeFakeSessionManager(sessionFile: string): SessionManager {
    return {
      getSessionFile: () => sessionFile,
      _rewriteFile: () => {},
    } as unknown as SessionManager;
  }

  test("provider-extension pool mismatch reports only that the field changed", async () => {
    _resetPoolForTesting();
    const tmpDir = fs.mkdtempSync("/tmp/delegate-provider-ext-mismatch-");
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "");
    const frozenSource =
      "git:https://user:frozen-secret@example.invalid/extension.git";
    const requestedSource =
      "git:https://user:requested-secret@example.invalid/extension.git";
    const task = makeBaseTask({
      sessionId: "provider-ext-mismatch",
      cwd: tmpDir,
      providerExtensionSources: requestedSource,
    });

    try {
      commit("provider-ext-mismatch", {
        session: makeFakeAgentSession(sessionFile),
        sessionManager: makeFakeSessionManager(sessionFile),
        sessionFile,
        frozen: {
          systemPrompt: task.systemPrompt,
          model: task.model,
          thinking: task.thinking,
          tools: task.tools,
          cwd: task.cwd,
          providerExtensions: frozenSource,
        },
        tokens: 0,
      });

      const result = await runResolvedTask(
        makeTestEnv(),
        task,
        {
          index: 0,
          agent: "ad-hoc",
          task: task.prompt,
          status: "pending",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
        0,
      );

      expect(result.error).toContain("providerExtensions: changed");
      expect(result.error).not.toContain("frozen-secret");
      expect(result.error).not.toContain("requested-secret");
      expect(result.error).not.toContain("https://");
    } finally {
      _resetPoolForTesting();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pre-expired deadline during acquisition keeps a pooled session intact and reusable", async () => {
    _resetPoolForTesting();
    const tmpDir = fs.mkdtempSync("/tmp/delegate-pre-prompt-pool-");
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "");

    const task = makeBaseTask({
      sessionId: "pre-prompt-pool",
      cwd: tmpDir,
    });

    const fakeSession = makeFakeAgentSession(sessionFile);
    const fakeSessionManager = makeFakeSessionManager(sessionFile);

    let runCalls = 0;
    _setRunAgentSessionForTesting(
      async (session, _prompt, _config, _signal, _onProgress) => {
        runCalls++;
        if (runCalls === 1) {
          // Simulates a deadline that fires before the runner ever calls
          // session.prompt() (e.g., during getHostDeps or git baseline).
          expect(session).toBe(fakeSession);
          return {
            output: "(no output)",
            error:
              "Deadline exceeded: task exceeded its 0ms wall-clock budget and was cooperatively aborted (not a hard kill).",
            durationMs: 0,
            tokens: 0,
            usage: emptyUsage(),
            touchedFiles: [],
            attributedFiles: [],
            failureKind: "deadline_exceeded",
            prompted: false,
          } as never;
        }
        expect(session).toBe(fakeSession);
        return {
          output: "reused",
          durationMs: 1,
          tokens: 5,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
        } as never;
      },
    );

    const env = makeTestEnv();
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    try {
      const inserted = commit("pre-prompt-pool", {
        session: fakeSession,
        sessionManager: fakeSessionManager,
        sessionFile,
        frozen: {
          systemPrompt: task.systemPrompt,
          model: task.model,
          thinking: task.thinking,
          tools: task.tools,
          cwd: task.cwd,
          providerExtensions: "",
        },
        tokens: 0,
      });
      expect(inserted).toBe(true);

      const firstResult = await runResolvedTask(
        env,
        task,
        progress as never,
        0,
      );
      expect(firstResult.failureKind).toBe("deadline_exceeded");
      expect(firstResult.error).toContain("Deadline exceeded");
      expect(configFor("pre-prompt-pool")).toBeDefined();
      expect(
        listPooledAgents().some((line) => line.includes("pre-prompt-pool")),
      ).toBe(true);

      const secondProgress = { ...progress };
      const secondResult = await runResolvedTask(
        env,
        task,
        secondProgress as never,
        0,
      );
      expect(secondResult.error).toBeUndefined();
      expect(secondResult.output).toBe("reused");
      expect(secondResult.tokens).toBe(5);
      expect(configFor("pre-prompt-pool")).toBeDefined();
      expect(
        listPooledAgents().some((line) => line.includes("pre-prompt-pool")),
      ).toBe(true);
      expect(runCalls).toBe(2);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _resetPoolForTesting();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("mid-prompt deadline still disposes a pooled session", async () => {
    _resetPoolForTesting();
    const tmpDir = fs.mkdtempSync("/tmp/delegate-mid-prompt-pool-");
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "");

    const task = makeBaseTask({
      sessionId: "mid-prompt-pool",
      cwd: tmpDir,
    });

    const fakeSession = makeFakeAgentSession(sessionFile);
    const fakeSessionManager = makeFakeSessionManager(sessionFile);

    _setRunAgentSessionForTesting(async () => {
      // Simulates a deadline that fires after session.prompt() was called.
      return {
        output: "partial",
        error:
          "Deadline exceeded: task exceeded its wall-clock budget and was cooperatively aborted (not a hard kill).",
        durationMs: 1,
        tokens: 3,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
        failureKind: "deadline_exceeded",
        prompted: true,
      } as never;
    });

    const env = makeTestEnv();
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    try {
      commit("mid-prompt-pool", {
        session: fakeSession,
        sessionManager: fakeSessionManager,
        sessionFile,
        frozen: {
          systemPrompt: task.systemPrompt,
          model: task.model,
          thinking: task.thinking,
          tools: task.tools,
          cwd: task.cwd,
          providerExtensions: "",
        },
        tokens: 0,
      });

      const result = await runResolvedTask(env, task, progress as never, 0);
      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(configFor("mid-prompt-pool")).toBeUndefined();
      expect(
        listPooledAgents().every((line) => !line.includes("mid-prompt-pool")),
      ).toBe(true);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _resetPoolForTesting();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pre-prompt deadline on a pooled session does not record usage or bump its prompt count", async () => {
    _resetPoolForTesting();
    const tmpDir = fs.mkdtempSync("/tmp/delegate-pre-prompt-pool-usage-");
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "");

    const task = makeBaseTask({
      sessionId: "pre-prompt-pool-usage",
      cwd: tmpDir,
    });

    const fakeSession = makeFakeAgentSession(sessionFile);
    const fakeSessionManager = makeFakeSessionManager(sessionFile);

    let runCalls = 0;
    _setRunAgentSessionForTesting(
      async (session, _prompt, _config, _signal, _onProgress) => {
        runCalls++;
        expect(session).toBe(fakeSession);
        if (runCalls === 1) {
          return {
            output: "(no output)",
            error:
              "Deadline exceeded: task exceeded its 0ms wall-clock budget and was cooperatively aborted (not a hard kill).",
            durationMs: 0,
            tokens: 0,
            usage: emptyUsage(),
            touchedFiles: [],
            attributedFiles: [],
            failureKind: "deadline_exceeded",
            prompted: false,
          } as never;
        }
        return {
          output: "reused",
          durationMs: 1,
          tokens: 5,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
        } as never;
      },
    );

    const env = makeTestEnv();
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    try {
      const inserted = commit("pre-prompt-pool-usage", {
        session: fakeSession,
        sessionManager: fakeSessionManager,
        sessionFile,
        frozen: {
          systemPrompt: task.systemPrompt,
          model: task.model,
          thinking: task.thinking,
          tools: task.tools,
          cwd: task.cwd,
          providerExtensions: "",
        },
        tokens: 100,
      });
      expect(inserted).toBe(true);

      const firstResult = await runResolvedTask(
        env,
        task,
        progress as never,
        0,
      );
      expect(firstResult.failureKind).toBe("deadline_exceeded");
      expect(firstResult.error).toContain("Deadline exceeded");

      const listText = listPooledAgents().find((line) =>
        line.includes("pre-prompt-pool-usage"),
      );
      expect(listText).toBeDefined();
      expect(listText).toContain("1 prompts");
      expect(listText).toContain("100 tokens");

      const secondProgress = { ...progress };
      const secondResult = await runResolvedTask(
        env,
        task,
        secondProgress as never,
        0,
      );
      expect(secondResult.error).toBeUndefined();
      expect(secondResult.output).toBe("reused");
      expect(secondResult.tokens).toBe(5);
      expect(runCalls).toBe(2);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _resetPoolForTesting();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("mid-prompt deadline on a pooled session disposes the session", async () => {
    _resetPoolForTesting();
    const tmpDir = fs.mkdtempSync("/tmp/delegate-mid-prompt-pool-dispose-");
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "");

    const task = makeBaseTask({
      sessionId: "mid-prompt-pool-dispose",
      cwd: tmpDir,
    });

    let disposed = false;
    const fakeSession = {
      ...makeFakeAgentSession(sessionFile),
      dispose: () => {
        disposed = true;
      },
    } as unknown as AgentSession;
    const fakeSessionManager = makeFakeSessionManager(sessionFile);

    _setRunAgentSessionForTesting(
      async () =>
        ({
          output: "partial",
          error:
            "Deadline exceeded: task exceeded its 0ms wall-clock budget and was cooperatively aborted (not a hard kill).",
          durationMs: 1,
          tokens: 3,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
          failureKind: "deadline_exceeded",
          prompted: true,
        }) as never,
    );

    const env = makeTestEnv();
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    try {
      commit("mid-prompt-pool-dispose", {
        session: fakeSession,
        sessionManager: fakeSessionManager,
        sessionFile,
        frozen: {
          systemPrompt: task.systemPrompt,
          model: task.model,
          thinking: task.thinking,
          tools: task.tools,
          cwd: task.cwd,
          providerExtensions: "",
        },
        tokens: 0,
      });

      const result = await runResolvedTask(env, task, progress as never, 0);
      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(disposed).toBe(true);
      expect(configFor("mid-prompt-pool-dispose")).toBeUndefined();
      expect(
        listPooledAgents().every(
          (line) => !line.includes("mid-prompt-pool-dispose"),
        ),
      ).toBe(true);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _resetPoolForTesting();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parent abort of a pooled session disposes it and does not record use", async () => {
    _resetPoolForTesting();
    const tmpDir = fs.mkdtempSync("/tmp/delegate-parent-abort-pool-");
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "");

    const task = makeBaseTask({
      sessionId: "parent-abort-pool",
      cwd: tmpDir,
    });

    let disposed = false;
    const fakeSession = {
      ...makeFakeAgentSession(sessionFile),
      dispose: () => {
        disposed = true;
      },
    } as unknown as AgentSession;
    const fakeSessionManager = makeFakeSessionManager(sessionFile);

    _setRunAgentSessionForTesting(
      async () =>
        ({
          output: "partial",
          error: "Aborted",
          durationMs: 1,
          tokens: 5,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
          // Parent abort is structured separately from provider error text;
          // the prompt was invoked and may have mutated the conversation.
          failureKind: "cancelled",
          prompted: true,
        }) as never,
    );

    const env = makeTestEnv();
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    try {
      const inserted = commit("parent-abort-pool", {
        session: fakeSession,
        sessionManager: fakeSessionManager,
        sessionFile,
        frozen: {
          systemPrompt: task.systemPrompt,
          model: task.model,
          thinking: task.thinking,
          tools: task.tools,
          cwd: task.cwd,
          providerExtensions: "",
        },
        tokens: 0,
      });
      expect(inserted).toBe(true);

      const result = await runResolvedTask(env, task, progress as never, 0);
      expect(result.error).toBe("Aborted");
      expect(result.failureKind).toBe("cancelled");
      expect(disposed).toBe(true);
      expect(configFor("parent-abort-pool")).toBeUndefined();
      expect(
        listPooledAgents().every((line) => !line.includes("parent-abort-pool")),
      ).toBe(true);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _resetPoolForTesting();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Deadline on a pool miss (lifecycle-owned session) ─────────────────────
// A sessionId that is not yet in the pool must not be inserted if the run
// hits a deadline; the lifecycle-owned session must be disposed instead.

describe("delegate deadline on pool miss", () => {
  test("deadline_exceeded on a pool miss is not inserted and the session is disposed", async () => {
    _resetPoolForTesting();
    const tmpDir = fs.mkdtempSync("/tmp/delegate-pool-miss-deadline-");

    const task = makeBaseTask({
      sessionId: "pool-miss-deadline",
      cwd: tmpDir,
    });

    let runCalls = 0;
    _setRunAgentSessionForTesting(async () => {
      runCalls++;
      return {
        output: "(no output)",
        error:
          "Deadline exceeded: task exceeded its 0ms wall-clock budget and was cooperatively aborted (not a hard kill).",
        durationMs: 0,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
        failureKind: "deadline_exceeded",
        prompted: false,
      } as never;
    });

    let disposed = 0;
    const originalDispose = AgentSession.prototype.dispose;
    AgentSession.prototype.dispose = function disposeForTest(
      this: AgentSession,
    ) {
      disposed++;
      return originalDispose.call(this);
    };

    const env = makeTestEnv();
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    _setWholeTaskRetryForTesting({ maxRetries: 3, baseDelayMs: 0 });

    try {
      const result = await runResolvedTask(env, task, progress as never, 0);
      expect(runCalls).toBe(1);
      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(configFor("pool-miss-deadline")).toBeUndefined();
      expect(
        listPooledAgents().every(
          (line) => !line.includes("pool-miss-deadline"),
        ),
      ).toBe(true);
      expect(disposed).toBeGreaterThanOrEqual(1);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
      _resetPoolForTesting();
      AgentSession.prototype.dispose = originalDispose;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Lifecycle-level deadline and abort races ─────────────────────────────
// These tests pin the seams where the wall-clock deadline, the parent abort
// signal, and the whole-task retry budget intersect.

describe("lifecycle-level deadline and abort races", () => {
  test("pre-attempt deadline returns deadline_exceeded before the first runAttempt", async () => {
    const task = makeBaseTask({ deadlineMs: 5 });
    const env = makeTestEnv({ delegateStartedAt: 0 });
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    let runAttempts = 0;
    _setWholeTaskRetryForTesting({ maxRetries: 3, baseDelayMs: 0 });
    _setRunAgentSessionForTesting(async () => {
      runAttempts++;
      return {
        output: "should not run",
        durationMs: 0,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
      } as never;
    });

    const originalDateNow = Date.now;
    try {
      let callCount = 0;
      Date.now = () => {
        callCount++;
        const base = originalDateNow();
        if (callCount === 2) return base + 10;
        return base;
      };

      const result = await runResolvedTask(env, task, progress as never, 0);
      expect(runAttempts).toBe(0);
      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      // The deadline is detected before any attempt starts, but wall-clock
      // bookkeeping can still advance by a millisecond between Date.now()
      // reads.
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(100);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
      Date.now = originalDateNow;
    }
  });

  test("parent abort before the deadline during retry sleep returns Aborted", async () => {
    const controller = new AbortController();
    const task = makeBaseTask({ deadlineMs: 200 });
    const env = makeTestEnv({ signal: controller.signal });
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    let runAttempts = 0;
    _setWholeTaskRetryForTesting({ maxRetries: 3, baseDelayMs: 2000 });
    _setRunAgentSessionForTesting(async () => {
      runAttempts++;
      return {
        output: "",
        error: "connection refused",
        durationMs: 5,
        tokens: 5,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
      } as never;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const running = runResolvedTask(env, task, progress as never, 0);
      timer = setTimeout(() => controller.abort(), 50);
      const result = await running;

      expect(runAttempts).toBe(1);
      expect(result.error).toBe("Aborted");
      expect(result.failureKind).toBe("cancelled");
      expect(result.tokens).toBe(5);
      expect(result.durationMs).toBeLessThan(200);
    } finally {
      if (timer) clearTimeout(timer);
      _setRunAgentSessionForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
    }
  });

  test("parent abort before runAttempt returns Aborted and skips session acquisition", async () => {
    const controller = new AbortController();
    controller.abort();

    const task = makeBaseTask();
    const env = makeTestEnv({ signal: controller.signal });
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    let runAttempts = 0;
    _setRunAgentSessionForTesting(async () => {
      runAttempts++;
      return {
        output: "should not run",
        durationMs: 0,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
      } as never;
    });

    try {
      const result = await runResolvedTask(env, task, progress as never, 0);
      expect(runAttempts).toBe(0);
      expect(result.error).toBe("Aborted");
      expect(result.failureKind).toBe("cancelled");
    } finally {
      _setRunAgentSessionForTesting(undefined);
    }
  });

  test("parent abort during the first attempt wins over a later deadline", async () => {
    const controller = new AbortController();
    const task = makeBaseTask({ deadlineMs: 300 });
    const env = makeTestEnv({ signal: controller.signal });
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    let runAttempts = 0;
    _setRunAgentSessionForTesting(async () => {
      runAttempts++;
      await new Promise((r) => setTimeout(r, 50));
      return {
        output: "partial",
        durationMs: 50,
        tokens: 5,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
      } as never;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const running = runResolvedTask(env, task, progress as never, 0);
      timer = setTimeout(() => controller.abort(), 30);
      const result = await running;

      expect(runAttempts).toBe(1);
      expect(result.error).toBe("Aborted");
      expect(result.failureKind).toBe("cancelled");
      expect(result.tokens).toBe(5);
      expect(result.durationMs).toBeLessThan(300);
    } finally {
      if (timer) clearTimeout(timer);
      _setRunAgentSessionForTesting(undefined);
    }
  });

  test("deadline before a later parent abort during retry sleep returns deadline_exceeded", async () => {
    const controller = new AbortController();
    const task = makeBaseTask({ deadlineMs: 50 });
    const env = makeTestEnv({ signal: controller.signal });
    const progress = {
      index: 0,
      agent: "ad-hoc",
      task: "test prompt",
      status: "pending" as const,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    } as TaskProgress;

    let runAttempts = 0;
    _setWholeTaskRetryForTesting({ maxRetries: 3, baseDelayMs: 2000 });
    _setRunAgentSessionForTesting(async () => {
      runAttempts++;
      return {
        output: "",
        error: "connection refused",
        durationMs: 5,
        tokens: 5,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
      } as never;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const running = runResolvedTask(env, task, progress as never, 0);
      timer = setTimeout(() => controller.abort(), 500);
      const result = await running;

      expect(runAttempts).toBe(1);
      expect(result.failureKind).toBe("deadline_exceeded");
      expect(result.error).toContain("Deadline exceeded");
      expect(result.error).not.toBe("Aborted");
      expect(result.tokens).toBe(5);
    } finally {
      if (timer) clearTimeout(timer);
      _setRunAgentSessionForTesting(undefined);
      _setWholeTaskRetryForTesting(undefined);
    }
  });
});

describe("quiescence-abandoned session ownership", () => {
  afterEach(() => {
    _resetQuarantineRegistryForTesting();
  });

  function progress(task: ResolvedTask): TaskProgress {
    return {
      index: 0,
      agent: task.agentName,
      task: task.prompt,
      status: "pending",
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    };
  }

  function deferred(): {
    promise: Promise<void>;
    resolve: () => void;
  } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function abandonedRun(safe: Promise<void>) {
    return markSessionQuarantined(
      {
        output: "partial",
        error: "Stalled: cancellation could not prove quiescence",
        failureKind: "stalled" as const,
        incomplete: "quiescence_abandoned" as const,
        durationMs: 1,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
        prompted: true,
      },
      { safe },
    );
  }

  test("fresh shared ownership defers disposal until safety confirmation", async () => {
    const safety = deferred();
    let disposed = 0;
    const session = { dispose: () => disposed++ } as unknown as AgentSession;
    _setAcquireAgentSessionForTesting(async () => ({
      session,
      sessionManager: undefined,
      sessionFile: undefined,
      lifecycleOwnsSession: true,
    }));
    _setRunAgentSessionForTesting(async () => abandonedRun(safety.promise));
    const task = makeBaseTask({ workspace: "shared" });

    try {
      const result = await runResolvedTask(
        makeTestEnv(),
        task,
        progress(task),
        0,
      );
      expect(sessionQuarantineOf(result)?.safe).toBe(safety.promise);
      expect(disposed).toBe(0);
      safety.resolve();
      await safety.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(1);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setAcquireAgentSessionForTesting(undefined);
    }
  });

  test("pool hit is detached immediately but not disposed before safety", async () => {
    _resetPoolForTesting();
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "delegate-quarantine-pool-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    fs.writeFileSync(sessionFile, "");
    const safety = deferred();
    let disposed = 0;
    const session = { dispose: () => disposed++ } as unknown as AgentSession;
    const manager = {
      getSessionFile: () => sessionFile,
    } as unknown as SessionManager;
    const task = makeBaseTask({
      workspace: "shared",
      cwd: root,
      sessionId: "quarantined-hit",
    });
    commit("quarantined-hit", {
      session,
      sessionManager: manager,
      sessionFile,
      frozen: {
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.tools,
        cwd: task.cwd,
        providerExtensions: "",
      },
      tokens: 0,
    });
    _setRunAgentSessionForTesting(async () => abandonedRun(safety.promise));

    try {
      const result = await runResolvedTask(
        makeTestEnv(),
        task,
        progress(task),
        0,
      );
      expect(sessionQuarantineOf(result)).toBeDefined();
      expect(configFor("quarantined-hit")).toBeUndefined();
      expect(disposed).toBe(0);
      safety.resolve();
      await safety.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(1);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _resetPoolForTesting();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("failed pooled detachment blocks reuse until safe without disposing the indexed session", async () => {
    _resetPoolForTesting();
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "delegate-quarantine-detach-failure-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    fs.writeFileSync(sessionFile, "");
    const safety = deferred();
    let disposed = 0;
    const session = { dispose: () => disposed++ } as unknown as AgentSession;
    const manager = {
      getSessionFile: () => sessionFile,
    } as unknown as SessionManager;
    const task = makeBaseTask({
      workspace: "shared",
      cwd: root,
      sessionId: "detach-invariant-failure",
    });
    commit("detach-invariant-failure", {
      session,
      sessionManager: manager,
      sessionFile,
      frozen: {
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.tools,
        cwd: task.cwd,
        providerExtensions: "",
      },
      tokens: 0,
    });
    _setRunAgentSessionForTesting(async () => abandonedRun(safety.promise));
    _setQuarantinePooledSessionDetachForTesting(() => false);

    try {
      const result = await runResolvedTask(
        makeTestEnv(),
        task,
        progress(task),
        0,
      );
      expect(sessionQuarantineOf(result)).toBeDefined();
      expect(configFor("detach-invariant-failure")).toBeDefined();
      expect(disposed).toBe(0);

      const blocked = await runResolvedTask(
        makeTestEnv(),
        task,
        progress(task),
        0,
      );
      expect(blocked.error).toContain("is quarantined");
      expect(disposed).toBe(0);

      safety.resolve();
      await safety.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(configFor("detach-invariant-failure")).toBeDefined();
      expect(disposed).toBe(0);

      _setRunAgentSessionForTesting(async () => ({
        output: "reused safely",
        durationMs: 1,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
        prompted: true,
      }));
      const reused = await runResolvedTask(
        makeTestEnv(),
        task,
        progress(task),
        0,
      );
      expect(reused.error).toBeUndefined();
      expect(reused.output).toBe("reused safely");
      expect(disposed).toBe(0);
    } finally {
      _setQuarantinePooledSessionDetachForTesting(undefined);
      _setRunAgentSessionForTesting(undefined);
      _resetPoolForTesting();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing resume transcript keeps its lexical lock if created by a queued caller", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "delegate-quarantine-resume-missing-"),
    );
    const transcript = path.join(root, "later.jsonl");
    const firstGate = deferred();
    let firstEntered = false;
    let secondEntered = false;

    try {
      const first = withResumeTranscriptLock(transcript, async (identity) => {
        firstEntered = true;
        expect(identity?.lexicalPath).toBe(transcript);
        expect(identity?.canonicalPath).toBeUndefined();
        expect(identity?.exists).toBe(false);
        await firstGate.promise;
        return "missing";
      });
      while (!firstEntered) await Promise.resolve();

      fs.writeFileSync(transcript, "{}\n");
      const second = withResumeTranscriptLock(transcript, async (identity) => {
        secondEntered = true;
        expect(identity?.canonicalPath).toBe(transcript);
        expect(identity?.exists).toBe(true);
        return "created";
      });
      await Promise.resolve();
      expect(secondEntered).toBe(false);

      firstGate.resolve();
      expect(await first).toBe("missing");
      expect(await second).toBe("created");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("retargeted resume aliases keep one acquisition and quarantine identity", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "delegate-quarantine-resume-lock-"),
    );
    const transcript = path.join(root, "session.jsonl");
    const runningRetarget = path.join(root, "running-retarget.jsonl");
    const waitingRetarget = path.join(root, "waiting-retarget.jsonl");
    const runningAlias = path.join(root, "running-alias.jsonl");
    const waitingAlias = path.join(root, "waiting-alias.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    fs.writeFileSync(runningRetarget, "{}\n");
    fs.writeFileSync(waitingRetarget, "{}\n");
    fs.symlinkSync(transcript, runningAlias);
    fs.symlinkSync(transcript, waitingAlias);
    const safety = deferred();
    const runGate = deferred();
    let runs = 0;
    const acquiredPaths: Array<string | undefined> = [];
    let disposed = 0;
    _setAcquireAgentSessionForTesting(async (_env, acquiredTask) => {
      acquiredPaths.push(acquiredTask.resumeFrom);
      return {
        session: { dispose: () => disposed++ } as unknown as AgentSession,
        sessionManager: undefined,
        sessionFile: transcript,
        lifecycleOwnsSession: true,
      };
    });
    _setRunAgentSessionForTesting(async () => {
      runs++;
      await runGate.promise;
      return abandonedRun(safety.promise);
    });
    const firstTask = makeBaseTask({
      workspace: "shared",
      resumeFrom: runningAlias,
    });
    const queuedAliasTask = makeBaseTask({
      workspace: "shared",
      resumeFrom: waitingAlias,
    });

    try {
      const first = runResolvedTask(
        makeTestEnv(),
        firstTask,
        progress(firstTask),
        0,
      );
      while (runs === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const queued = runResolvedTask(
        makeTestEnv(),
        queuedAliasTask,
        progress(queuedAliasTask),
        0,
      );
      await Promise.resolve();
      expect(acquiredPaths).toEqual([transcript]);

      fs.unlinkSync(runningAlias);
      fs.symlinkSync(runningRetarget, runningAlias);
      fs.unlinkSync(waitingAlias);
      fs.symlinkSync(waitingRetarget, waitingAlias);

      runGate.resolve();
      const firstResult = await first;
      const queuedResult = await queued;
      expect(sessionQuarantineOf(firstResult)).toBeDefined();
      expect(queuedResult.error).toContain("resumeFrom transcript");
      expect(queuedResult.error).toContain("is quarantined");
      expect(acquiredPaths).toEqual([transcript]);

      safety.resolve();
      await safety.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(1);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setAcquireAgentSessionForTesting(undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("scratch path projection failure preserves evidence, quarantine, and deferred cleanup", async () => {
    const safety = deferred();
    let disposed = 0;
    let cleaned = 0;
    const session = { dispose: () => disposed++ } as unknown as AgentSession;
    _setAcquireAgentSessionForTesting(async () => ({
      session,
      sessionManager: undefined,
      sessionFile: undefined,
      lifecycleOwnsSession: true,
    }));
    _setRunAgentSessionForTesting(async () =>
      markSessionQuarantined(
        {
          ...abandonedRun(safety.promise),
          touchedFiles: ["/scratch/result.txt"],
        },
        { safe: safety.promise },
      ),
    );
    _setCreateScratchWorkspaceForTesting(async (sourceCwd) => ({
      sourceRoot: sourceCwd,
      sourceCwd,
      scratchRoot: "/scratch",
      cwd: "/scratch",
      mapPathToSource: (candidate: string) => candidate,
      resolveReportedPath: async () => {
        throw new Error("projection failed");
      },
      resolveAttributedPath: async (candidate: string) => candidate,
      isDisposablePath: async () => true,
      cleanup: async () => {
        cleaned++;
      },
    }));
    const task = makeBaseTask({ workspace: "scratch" });

    try {
      const result = await runResolvedTask(
        makeTestEnv(),
        task,
        progress(task),
        0,
      );
      expect(result.error).toContain("quiescence");
      expect(result.error).not.toContain("projection failed");
      expect(result.touchedFiles).toContain("/scratch/result.txt");
      expect(result.incomplete).toBe("quiescence_abandoned");
      expect(sessionQuarantineOf(result)?.safe).toBe(safety.promise);
      expect(disposed).toBe(0);
      expect(cleaned).toBe(0);

      safety.resolve();
      await safety.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(1);
      expect(cleaned).toBe(1);
    } finally {
      _setCreateScratchWorkspaceForTesting(undefined);
      _setRunAgentSessionForTesting(undefined);
      _setAcquireAgentSessionForTesting(undefined);
    }
  });

  test("scratch keeps its tree and fresh session until safety confirmation", async () => {
    const safety = deferred();
    let disposed = 0;
    let cleaned = 0;
    const scratchRoot = path.join(os.tmpdir(), "delegate-quarantined-scratch");
    const session = { dispose: () => disposed++ } as unknown as AgentSession;
    _setAcquireAgentSessionForTesting(async () => ({
      session,
      sessionManager: undefined,
      sessionFile: undefined,
      lifecycleOwnsSession: true,
    }));
    _setRunAgentSessionForTesting(async () => abandonedRun(safety.promise));
    _setCreateScratchWorkspaceForTesting(async (sourceCwd) => ({
      sourceRoot: sourceCwd,
      sourceCwd,
      scratchRoot,
      cwd: scratchRoot,
      mapPathToSource: (candidate: string) => candidate,
      resolveReportedPath: async (candidate: string) => candidate,
      resolveAttributedPath: async (candidate: string) => candidate,
      isDisposablePath: async () => true,
      cleanup: async () => {
        cleaned++;
      },
    }));
    const task = makeBaseTask({ workspace: "scratch" });

    try {
      const result = await runResolvedTask(
        makeTestEnv(),
        task,
        progress(task),
        0,
      );
      expect(sessionQuarantineOf(result)).toBeDefined();
      expect(disposed).toBe(0);
      expect(cleaned).toBe(0);
      safety.resolve();
      await safety.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(1);
      expect(cleaned).toBe(1);
    } finally {
      _setCreateScratchWorkspaceForTesting(undefined);
      _setRunAgentSessionForTesting(undefined);
      _setAcquireAgentSessionForTesting(undefined);
    }
  });
});

// ── isModelAttributableError ─────────────────────────────────────────────
// Pure classifier: distinguishes account-level/model-attributable failures
// (usage limit, quota, auth) from transient errors (bare 429, 5xx, network)
// that same-model retry can fix. Getting this boundary right is the crux of
// Option B — a false positive suppresses a legitimate retry; a false negative
// burns retries into a usage-limited account.

describe("isModelAttributableError", () => {
  test("usage limit / quota / upgrade wording → true", () => {
    expect(
      isModelAttributableError(
        '429 "you have reached your session usage limit, upgrade for higher limits"',
      ),
    ).toBe(true);
    expect(isModelAttributableError("You exceeded your quota.")).toBe(true);
    expect(isModelAttributableError("insufficient credit")).toBe(true);
    expect(isModelAttributableError("billing required")).toBe(true);
  });

  test("auth / credential failures → true", () => {
    expect(isModelAttributableError("401 Unauthorized")).toBe(true);
    expect(isModelAttributableError("403 Forbidden")).toBe(true);
    expect(isModelAttributableError("Invalid API key")).toBe(true);
    expect(isModelAttributableError("authentication failed")).toBe(true);
  });

  test("transient errors → false (same-model retry is appropriate)", () => {
    expect(isModelAttributableError("connection refused")).toBe(false);
    expect(isModelAttributableError("network error")).toBe(false);
    expect(isModelAttributableError("timeout")).toBe(false);
    expect(isModelAttributableError("temporarily overloaded")).toBe(false);
    // A bare per-minute rate-limit 429 (no account-level wording) is transient.
    expect(isModelAttributableError("429 Too Many Requests")).toBe(false);
    expect(
      isModelAttributableError("rate limit exceeded, try again later"),
    ).toBe(false);
  });

  test("abort errors → false (not a model failure)", () => {
    expect(isModelAttributableError("Aborted")).toBe(false);
    expect(isModelAttributableError("request aborted by user")).toBe(false);
  });

  test("word-boundary status codes avoid false positives on substrings", () => {
    // A port like 4019 or a count like 4031 must NOT match 401/403.
    expect(isModelAttributableError("listening on port 4019")).toBe(false);
    expect(isModelAttributableError("processed 4031 lines")).toBe(false);
  });

  test("empty / undefined → false", () => {
    expect(isModelAttributableError(undefined)).toBe(false);
    expect(isModelAttributableError("")).toBe(false);
  });
});

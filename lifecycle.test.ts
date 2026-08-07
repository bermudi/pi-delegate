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

import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createTestSession } from "@marcfargas/pi-test-harness";
// The test harness loads the extension via jiti. Under bun, jiti shares its
// module graph with native imports, so the `ticketRegistry`/
// `_setHostRetryBaseMsForTesting`/`_resetPoolForTesting` imported below are the
// SAME instances the extension uses — verified empirically (an inserted pooled
// session is visible to execute()'s list action; the retry-base override reaches
// the extension's createAgentSession). We clear them in afterEach to avoid
// leaking between runs.
import { ticketRegistry } from "./delegate.ts";
import {
  _setHostRetryBaseMsForTesting,
  _setModelRuntimeFactoryForTesting,
} from "./host.ts";
import {
  _setRunAgentSessionForTesting,
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

// ── Test Suite ─────────────────────────────────────────────────────────────

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
        path.join(agentDir, "reviewer.md"),
        [
          "---",
          "name: reviewer",
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
        { tasks: [{ agent: "reviewer", prompt: "review" }] },
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

    const result = await toolDef.execute(
      "tc-parallel-1",
      {
        tasks: [
          { prompt: "task A" },
          { prompt: "task B" },
          { prompt: "task C" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results).toHaveLength(3);
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
      { tasks: [{ action: "list" }] },
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
      { tasks: [{ action: "list" }] },
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
      { tasks: [{ action: "list" }] },
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
      { tasks: [{ action: "list" }] },
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
      { tasks: [{ action: "list" }] },
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
      { tasks: [{ action: "close", sessionId: "close-me" }] },
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
      { tasks: [{ action: "list" }] },
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
      { tasks: [{ action: "list" }] },
      undefined,
      undefined,
      ctx,
    );

    const details = (result as any).details as {
      results: Array<{ output?: string; error?: string }>;
    };

    expect(details.results[0]?.output).toContain("list-me");
  });

  test("async task completes and results are pollable", async () => {
    const stream = installStreamMock("Async task done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts, stream);

    const toolDef = getDelegateTool(ts);
    const ctx = getExecContext(ts);

    const dispatch = await toolDef.execute(
      "tc-async-1",
      { async: true, tasks: [{ prompt: "async work" }] },
      undefined,
      undefined,
      ctx,
    );

    const ticketId = (dispatch.details as any).ticketId;
    expect(ticketId).toBeDefined();

    // Poll until settled
    let pollResult: any;
    for (let i = 0; i < 50; i++) {
      pollResult = await toolDef.execute(
        `tc-async-1-poll-${i}`,
        { action: "poll", ticket: ticketId },
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
    expect(finalDetails.results[0]?.output).toContain("Async task done");
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
          { prompt: "task A" },
          { prompt: "task B" },
          { prompt: "task C" },
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
      { tasks: [{ action: "list" }] },
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
        } as never;
      },
    );

    const env = {
      signal: undefined,
      modelRegistry: {} as never,
      parentSessionManager: undefined,
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
        } as never;
      },
    );

    const env = {
      signal: undefined,
      modelRegistry: {} as never,
      parentSessionManager: undefined,
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
        } as never;
      },
    );

    const env = {
      signal: controller.signal,
      modelRegistry: {} as never,
      parentSessionManager: undefined,
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
      baseDelayMs: 40,
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

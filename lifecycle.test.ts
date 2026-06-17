/**
 * Integration tests for delegate extension's task execution lifecycle.
 *
 * These tests exercise the full execute() → acquireAgentSession → runAgent path,
 * verifying that tasks actually create agents and produce output (or correct errors).
 *
 * Strategy:
 * - Use pi-test-harness to create a real session with the delegate extension loaded.
 * - Use the runner's createContext() to get a proper ExtensionContext with model, registry, etc.
 * - Patch modelRegistry.getApiKeyAndHeaders to return fake auth.
 * - Mock @mariozechner/pi-ai's streamSimple to return canned responses.
 * - This means the sub-agent's streamFn calls our mock instead of hitting a real API.
 */

import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createTestSession } from "@marcfargas/pi-test-harness";
// NOTE: The test harness loads the extension via jiti, creating a separate module
// instance. The imported `agentPool` and `ticketRegistry` are the TEST MODULE's
// copies, NOT the extension's. To observe the extension's internal state, we must
// go through execute() (e.g., list action for pool state, poll for tickets).
// We import these only for cleanup in afterEach (clearing our own module's maps
// to avoid leaking between test file runs).
import { agentPool, ticketRegistry } from "./delegate.ts";

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

/** Set up mock.module to intercept streamSimple with a canned response. */
function installStreamMock(responseText: string) {
  mock.module("@mariozechner/pi-ai", (orig) => ({
    ...orig,
    streamSimple: () => mockStream(responseText),
  }));
}

/** Patch model registry auth so sub-agents skip real auth. */
function patchAuth(ts: TestSession) {
  const reg = (ts.session as any)._modelRegistry;
  reg.getApiKeyAndHeaders = async () => ({
    ok: true,
    apiKey: "test-key",
  });
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
    agentPool.clear();
    ticketRegistry.clear();
  });

  afterEach(() => {
    mock.restore();
    agentPool.clear();
    ticketRegistry.clear();
    ts?.dispose();
    ts = undefined;
  });

  test("fresh task (no sessionId, no resumeFrom) creates agent and returns output", async () => {
    installStreamMock("I completed the task successfully.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    expect(details.results[0]?.agent).toBe("inline");
  });

  test("ad-hoc prompt inherits parent system prompt and appends AGENTS.md", async () => {
    const projectInstruction = "SPAWN_PROMPT_HYGIENE_PROJECT_CONTEXT";
    let capturedSystemPrompt = "";
    mock.module("@mariozechner/pi-ai", (orig) => ({
      ...orig,
      streamSimple: (_model: unknown, context: { systemPrompt?: string }) => {
        capturedSystemPrompt = context.systemPrompt ?? "";
        return mockStream("Prompt captured.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
      expect(capturedSystemPrompt.split(projectInstruction).length - 1).toBe(1);
    } finally {
      fs.rmSync(taskCwd, { recursive: true, force: true });
    }
  });

  test("fresh task with systemPrompt override", async () => {
    installStreamMock("Reviewed. All good.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    mock.module("@mariozechner/pi-ai", (orig) => ({
      ...orig,
      streamSimple: (_model: unknown, context: { systemPrompt?: string }) => {
        capturedSystemPrompt = context.systemPrompt ?? "";
        return mockStream("Named agent ran.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
      expect(capturedSystemPrompt).not.toContain("PARENT_PROMPT_SHOULD_NOT_WIN");
    } finally {
      fs.rmSync(taskCwd, { recursive: true, force: true });
    }
  });

  test("named agent discovery is parent-scoped, not per-task cwd", async () => {
    // Agent discovery uses ctx.cwd (parent session), not the per-task cwd.
    // A .pi/agents/ghost.md placed in the per-task cwd must NOT be discovered.
    installStreamMock("Should never run.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    mock.module("@mariozechner/pi-ai", (orig) => ({
      ...orig,
      streamSimple: (model: any) => {
        usedModelId = model.id;
        return mockStream("Used alternative model.");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });

    // Set up the parent model: same id as the alternative, but with
    // a provider that has no configured auth. The registry should
    // have a fallback model with the same id under a different provider.
    const reg = (ts.session as any)._modelRegistry;

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
    const ctx = getExecContext(ts);

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
    mock.module("@mariozechner/pi-ai", (orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStream(`Task ${callCount} done.`);
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    installStreamMock("Pooled task done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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

    // Verify pool state via the list action (goes through the extension's own agentPool)
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
    mock.module("@mariozechner/pi-ai", (orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStream(`Response ${callCount}`);
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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

  test("close action tears down pooled session", async () => {
    installStreamMock("Done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    installStreamMock("Done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    installStreamMock("Async task done.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    installStreamMock("Resumed and continued.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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

  test("session config mismatch rejects with actionable message", async () => {
    installStreamMock("Init.");

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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

/** Mock that errors on the first N calls, then returns a success stream. */
function installFailingThenSuccess(
  failCount: number,
  failMessage: string,
  successText: string,
) {
  let callCount = 0;
  mock.module("@mariozechner/pi-ai", (orig) => ({
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

  beforeEach(() => {
    // Make retries fast — 0ms base, 0ms jitter via Math.random stub.
    Math.random = () => 0;
  });

  afterEach(() => {
    mock.restore();
    agentPool.clear();
    ticketRegistry.clear();
    ts?.dispose();
    ts = undefined;
  });

  test("transient error → retry → success", async () => {
    installFailingThenSuccess(
      1,
      "connection refused",
      "Recovered successfully.",
    );

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    installFailingThenSuccess(
      1,
      "rate limit exceeded, try again later",
      "Rate limit cleared.",
    );

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
  }, 60_000); // 30s base backoff + overhead

  test("non-retryable error → immediate failure, no retry", async () => {
    let callCount = 0;
    mock.module("@mariozechner/pi-ai", (orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStreamError("invalid api key");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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

  test("max retries exhausted → returns last error", async () => {
    let callCount = 0;
    mock.module("@mariozechner/pi-ai", (orig) => ({
      ...orig,
      streamSimple: () => {
        callCount++;
        return mockStreamError("connection refused");
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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

    // Default maxRetries is 3, so 1 initial + 3 retries = 4 calls
    expect(callCount).toBeGreaterThan(1);
    expect(details.results[0]?.error).toContain("connection refused");
  }, 30_000); // 2s + 4s + 8s backoff delays

  test("succeeds after multiple retries (clean transcript via snapshot/restore)", async () => {
    let callCount = 0;
    // Track message count on each call. If snapshot/restore works,
    // the count stays roughly the same across retries — only the user
    // prompt is re-added, failed assistant responses are rolled back.
    const messageCounts: number[] = [];
    mock.module("@mariozechner/pi-ai", (orig) => ({
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
    patchAuth(ts);

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

    // Verify snapshot/restore: message count should NOT grow across
    // retries (failed assistant responses were rolled back).
    // If snapshot/restore were broken, counts would grow by 1-2 per retry.
    if (messageCounts.length >= 2) {
      const first = messageCounts[0]!;
      const second = messageCounts[1]!;
      const third = messageCounts[2]!;
      // Allow at most 1 message difference (the re-added user prompt).
      expect(Math.abs(second - first)).toBeLessThanOrEqual(1);
      expect(Math.abs(third - second)).toBeLessThanOrEqual(1);
      expect(Math.abs(third - first)).toBeLessThanOrEqual(2);
    }
  }, 15_000); // 2s + 4s backoff delays
});

// ── Abort Behavior ───────────────────────────────────────────────────────────

describe("delegate abort behavior", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    mock.restore();
    agentPool.clear();
    ticketRegistry.clear();
    ts?.dispose();
    ts = undefined;
  });

  test("abort signal stops all tasks and returns Aborted status (no undefined holes)", async () => {
    // Mock that hangs so the abort signal has time to fire.
    mock.module("@mariozechner/pi-ai", (orig) => ({
      ...orig,
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        // Never push a done event — simulates a hung LLM call.
        return stream;
      },
    }));

    ts = await createTestSession({ extensions: [EXTENSION] });
    patchAuth(ts);

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
    agentPool.clear();
    ticketRegistry.clear();
    ts?.dispose();
    ts = undefined;
  });

  test("sessionId not in pool + resumeFrom set → resumes and pools for reuse", async () => {
    installStreamMock("Resumed and pooled.");

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
    patchAuth(ts);

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

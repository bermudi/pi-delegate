import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "./agents.ts";
import {
  _setGlobalConcurrencyLimitForTesting,
  _resetGlobalConcurrencyForTesting,
} from "./concurrency.ts";
import {
  _setAcquireAgentSessionForTesting,
  _setRunAgentSessionForTesting,
} from "./lifecycle.ts";
import { _resetPoolForTesting, commit } from "./pool.ts";
import { emptyUsage } from "./usage.ts";
import {
  dispatchAsync,
  dispatchDelegate,
  dispatchSync,
  initProgress,
} from "./dispatch.ts";
import {
  _setBeforeSourceApplyHookForTesting,
  _setIsolatedArtifactRootForTesting,
} from "./isolated-workspace.ts";
import { recordTreeNavigation, resetLeafTracking } from "./leaf.ts";
import {
  _resetDelegateStatusForTesting,
  syncDelegateStatus,
} from "./status.ts";
import {
  cancelTicketForShutdown,
  requestTicketCancel,
  ticketRegistry,
} from "./tickets.ts";
import {
  _resetTelemetryForTesting,
  _setTelemetryForTesting,
  beginCall,
  type CallRecord,
  type TaskRecord,
} from "./telemetry.ts";
import {
  _setDelegateConfigForTesting,
  _resetDelegateConfigForTesting,
  getDelegateConfigSnapshot,
  type DelegateConfig,
} from "./config.ts";
import {
  _resetQuarantineRegistryForTesting,
  markSessionQuarantined,
  quarantinedTasks,
  reserveSessionQuarantine,
} from "./session-quarantine.ts";
import type { ResolvedTask, TaskDef, TaskProgress } from "./types.ts";
import { firstText, taskResultAt } from "./test-harness.ts";

describe("progress preview sanitization", () => {
  test("flattens prompt newlines and removes ANSI and terminal controls before storage", () => {
    const prompt =
      "first \x1b[31mred\x1b[0m\r\nforged\x00\x07 row \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\";
    const [progress] = initProgress([
      {
        prompt,
        agentName: "scout",
        warnings: [],
      } as unknown as ResolvedTask,
    ]);

    expect(progress?.task).toBe("first red forged row link");
    expect(progress?.task).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(progress?.task).not.toContain("\n");
    expect(progress?.task).not.toContain("\x1b");
  });
});

function commitFiles(cwd: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(cwd, name), content);
  }
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ],
    { cwd },
  );
}

function asyncIsolatedInput(
  cwd: string,
  prompts: string[],
  pi: unknown = { sendMessage: () => {} },
): Parameters<typeof dispatchDelegate>[0] {
  const model = { provider: "test", id: "model" } as never;
  return {
    pi: pi as never,
    params: {
      async: true,
      tasks: prompts.map((prompt) => ({ prompt, cwd, workspace: "isolated" })),
    },
    ctx: {
      cwd,
      model,
      modelRegistry: {
        getAvailable: () => [model],
        find: () => model,
        hasConfiguredAuth: () => true,
      },
      getSystemPrompt: () => "parent",
    } as never,
    agents: new Map(),
    parentModelId: "model",
    parentDefaults: {
      thinking: "off",
      tools: ["read", "write", "edit", "bash"],
    },
    signal: undefined,
    onUpdate: undefined,
  };
}

interface FakeSession {
  touchedFiles: string[];
  attributedFiles: string[];
  subscribe: () => () => void;
  prompt: () => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  isIdle: boolean;
  isCompacting: boolean;
  messages: unknown[];
  state: Record<string, unknown>;
  getSessionStats: () => {
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
    cost: number;
  };
}

describe("dispatch-time shared-write gate", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetQuarantineRegistryForTesting();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "delegate-write-gate-"));
    execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
    ticketRegistry.clear();
    _resetDelegateConfigForTesting();
  });

  afterEach(() => {
    _setBeforeSourceApplyHookForTesting(undefined);
    _resetQuarantineRegistryForTesting();
    ticketRegistry.clear();
    _resetDelegateConfigForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rejects an overlapping writer while an abandoned writer is quarantined, then releases it after safe", async () => {
    let confirmSafe!: () => void;
    const safe = new Promise<void>((resolve) => {
      confirmSafe = resolve;
    });
    reserveSessionQuarantine(
      {
        prompt: "abandoned writer",
        cwd: tmpDir,
        workspace: "shared",
        tools: ["write"],
        agentName: "coder",
      } as unknown as ResolvedTask,
      { safe },
      undefined,
    );

    const model = { provider: "test", id: "model" } as any;
    const result = await dispatchDelegate({
      pi: {} as any,
      params: { tasks: [{ prompt: "new writer", cwd: tmpDir }] },
      ctx: {
        cwd: tmpDir,
        model,
        modelRegistry: {
          getAvailable: () => [model],
          find: () => model,
          hasConfiguredAuth: () => true,
        },
        getSystemPrompt: () => "parent",
      } as any,
      agents: new Map(),
      parentModelId: model.id,
      parentDefaults: {
        thinking: "off",
        tools: ["read", "write", "edit", "bash"],
      },
      signal: undefined,
      onUpdate: undefined,
    });

    expect(firstText(result)).toContain(
      "Rejected before dispatch; no tasks were started.",
    );
    expect(firstText(result)).toContain("quarantined coder task");
    expect(quarantinedTasks()).toHaveLength(1);

    confirmSafe();
    await safe;
    await Promise.resolve();
    expect(quarantinedTasks()).toHaveLength(0);
  });

  test.each([
    ["sync", false],
    ["async", true],
  ] as const)(
    "rejects quarantined sessionId reuse before %s dispatch",
    async (_mode, asyncMode) => {
      reserveSessionQuarantine(
        {
          prompt: "abandoned session",
          sessionId: "unsafe-session",
          cwd: tmpDir,
          workspace: "shared",
          tools: ["read"],
          agentName: "scout",
        } as unknown as ResolvedTask,
        { safe: new Promise<void>(() => {}) },
        undefined,
      );
      const model = { provider: "test", id: "model" } as any;
      const result = await dispatchDelegate({
        pi: {} as any,
        params: {
          async: asyncMode,
          tasks: [
            {
              prompt: "reuse",
              sessionId: "unsafe-session",
              cwd: tmpDir,
            },
          ],
        },
        ctx: {
          cwd: tmpDir,
          model,
          modelRegistry: {
            getAvailable: () => [model],
            find: () => model,
            hasConfiguredAuth: () => true,
          },
          getSystemPrompt: () => "parent",
        } as any,
        agents: new Map(),
        parentModelId: model.id,
        parentDefaults: { thinking: "off", tools: ["read"] },
        signal: undefined,
        onUpdate: undefined,
      });

      expect(firstText(result)).toContain(
        "SessionId(s) quarantined after abandonment",
      );
      expect(result.details.progress).toEqual([]);
      expect(ticketRegistry.size).toBe(0);
    },
  );

  test("hung acquisition keeps shared-write admission reserved until late disposal", async () => {
    let resolveAcquisition!: (value: any) => void;
    let disposed = 0;
    _setAcquireAgentSessionForTesting(
      () =>
        new Promise((resolve) => {
          resolveAcquisition = resolve;
        }),
    );
    const model = { provider: "test", id: "model" } as any;
    const input = (prompt: string, deadlineMs?: number) => ({
      pi: {} as any,
      params: {
        tasks: [
          {
            prompt,
            cwd: tmpDir,
            workspace: "shared" as const,
            tools: ["write"],
            deadlineMs,
          },
        ],
      },
      ctx: {
        cwd: tmpDir,
        model,
        modelRegistry: {
          getAvailable: () => [model],
          find: () => model,
          hasConfiguredAuth: () => true,
        },
        getSystemPrompt: () => "parent",
      } as any,
      agents: new Map(),
      parentModelId: model.id,
      parentDefaults: {
        thinking: "off" as const,
        tools: ["read", "write", "edit", "bash"],
      },
      signal: undefined,
      onUpdate: undefined,
    });

    try {
      const first = await dispatchDelegate(input("hung writer", 20));
      expect(taskResultAt(first.details.results, 0).failureKind).toBe(
        "deadline_exceeded",
      );
      expect(quarantinedTasks()).toHaveLength(1);

      const blocked = await dispatchDelegate(input("overlapping writer"));
      expect(firstText(blocked)).toContain(
        "Rejected before dispatch; no tasks were started.",
      );
      expect(firstText(blocked)).toContain("quarantined inline task");

      resolveAcquisition({
        session: { dispose: () => disposed++ },
        sessionManager: undefined,
        sessionFile: undefined,
        lifecycleOwnsSession: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(1);
      expect(quarantinedTasks()).toHaveLength(0);
    } finally {
      _setAcquireAgentSessionForTesting(undefined);
    }
  });

  test.each([
    ["sync", false],
    ["async", true],
  ] as const)(
    "rejects same-root writers before %s dispatch creates progress or a ticket",
    async (_mode, asyncMode) => {
      const model = { provider: "test", id: "model" } as any;
      let updates = 0;
      const finishes: Array<Record<string, unknown>> = [];
      const result = await dispatchDelegate({
        pi: {} as any,
        params: {
          async: asyncMode,
          tasks: [
            { id: "one", prompt: "one", cwd: tmpDir },
            { id: "two", prompt: "two", cwd: tmpDir },
          ],
        },
        ctx: {
          cwd: tmpDir,
          model,
          modelRegistry: {
            getAvailable: () => [model],
            find: () => model,
            hasConfiguredAuth: () => true,
          },
          getSystemPrompt: () => "parent",
        } as any,
        agents: new Map(),
        parentModelId: model.id,
        parentDefaults: {
          thinking: "off",
          tools: ["read", "write", "edit", "bash"],
        },
        signal: undefined,
        onUpdate: (() => {
          updates += 1;
        }) as any,
        callSpan: {
          startedAt: Date.now(),
          finish: (record: Record<string, unknown>) => finishes.push(record),
        } as any,
      });

      expect(firstText(result)).toContain(
        "Rejected before dispatch; no tasks were started.",
      );
      expect(firstText(result)).toContain("Task 1#one, Task 2#two");
      expect(firstText(result)).toContain(tmpDir);
      expect(firstText(result)).not.toContain("delegate.json");
      expect(firstText(result)).not.toContain("allowUnsafeSharedWrites");
      expect(firstText(result)).toContain('workspace: "scratch"');
      expect(result.details.results).toEqual([]);
      expect(result.details.progress).toEqual([]);
      expect(updates).toBe(0);
      expect(ticketRegistry.size).toBe(0);
      expect(finishes).toHaveLength(1);
      expect(finishes[0]).toMatchObject({
        status: "failed",
        totalTokens: 0,
        totalCost: 0,
      });
    },
  );

  test.each([
    ["sync", false],
    ["async", true],
  ])(
    "one task with an unknown tool name rejects the whole %s call before any dispatch",
    async (_mode, asyncMode) => {
      const model = { provider: "test", id: "model" } as any;
      let ran = 0;
      _setRunAgentSessionForTesting(async () => {
        ran += 1;
        return {
          output: "done",
          durationMs: 1,
          tokens: 0,
          toolUses: 0,
          files: [],
          usage: emptyUsage(),
        } as any;
      });

      const finishes: Array<Record<string, unknown>> = [];
      const result = await dispatchDelegate({
        pi: {} as any,
        params: {
          async: asyncMode,
          tasks: [
            { id: "ok", prompt: "one", cwd: tmpDir, tools: ["read"] },
            { id: "typo", prompt: "two", cwd: tmpDir, tools: ["read", "fnd"] },
          ],
        },
        ctx: {
          cwd: tmpDir,
          model,
          modelRegistry: {
            getAvailable: () => [model],
            find: () => model,
            hasConfiguredAuth: () => true,
          },
          getSystemPrompt: () => "parent",
        } as any,
        agents: new Map(),
        parentModelId: model.id,
        parentDefaults: { thinking: "off", tools: ["read"] },
        signal: undefined,
        onUpdate: undefined,
        callSpan: {
          startedAt: Date.now(),
          finish: (record: Record<string, unknown>) => finishes.push(record),
        } as any,
      });

      expect(firstText(result)).toContain("Task 2#typo: unknown tool(s): fnd");
      expect(firstText(result)).toContain(
        "Available: read, write, edit, bash, grep, find, ls",
      );
      expect(result.details.results).toEqual([]);
      expect(result.details.progress).toEqual([]);
      expect(ran).toBe(0);
      expect(ticketRegistry.size).toBe(0);
      expect(finishes).toHaveLength(1);
      expect(finishes[0]).toMatchObject({
        status: "failed",
        totalTokens: 0,
        totalCost: 0,
      });
      _setRunAgentSessionForTesting(undefined);
    },
  );

  test.each([
    ["sync", false],
    ["async", true],
  ])(
    "unknown tools from a custom agent's frontmatter reject the whole %s call before any dispatch",
    async (_mode, asyncMode) => {
      // The unknown name lives in the agent profile, not the task: the task
      // carries no tools override, so resolution picks up the frontmatter list.
      mkdirSync(path.join(tmpDir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        path.join(tmpDir, ".pi", "agents", "typo-agent.md"),
        `---\nname: typo-agent\ndescription: Agent with a typo'd tool\ntools: read, fnd\n---\nBody.\n`,
      );
      const model = { provider: "test", id: "model" } as any;
      let ran = 0;
      _setRunAgentSessionForTesting(async () => {
        ran += 1;
        return {
          output: "done",
          durationMs: 1,
          tokens: 0,
          toolUses: 0,
          files: [],
          usage: emptyUsage(),
        } as any;
      });

      const finishes: Array<Record<string, unknown>> = [];
      const result = await dispatchDelegate({
        pi: {} as any,
        params: {
          async: asyncMode,
          tasks: [
            { id: "ok", prompt: "one", cwd: tmpDir, tools: ["read"] },
            { id: "typo", prompt: "two", cwd: tmpDir, agent: "typo-agent" },
          ],
        },
        ctx: {
          cwd: tmpDir,
          model,
          modelRegistry: {
            getAvailable: () => [model],
            find: () => model,
            hasConfiguredAuth: () => true,
          },
          getSystemPrompt: () => "parent",
        } as any,
        agents: discoverAgents(tmpDir),
        parentModelId: model.id,
        parentDefaults: { thinking: "off", tools: ["read"] },
        signal: undefined,
        onUpdate: undefined,
        callSpan: {
          startedAt: Date.now(),
          finish: (record: Record<string, unknown>) => finishes.push(record),
        } as any,
      });

      expect(firstText(result)).toContain("Task 2#typo: unknown tool(s): fnd");
      expect(firstText(result)).toContain(
        "Available: read, write, edit, bash, grep, find, ls",
      );
      expect(result.details.results).toEqual([]);
      expect(result.details.progress).toEqual([]);
      expect(ran).toBe(0);
      expect(ticketRegistry.size).toBe(0);
      expect(finishes).toHaveLength(1);
      expect(finishes[0]).toMatchObject({
        status: "failed",
        totalTokens: 0,
        totalCost: 0,
      });
      _setRunAgentSessionForTesting(undefined);
    },
  );

  test("an operator config flag authorizes unsafe shared writers with a visible warning", async () => {
    _setDelegateConfigForTesting({ allowUnsafeSharedWrites: true });
    const model = { provider: "test", id: "model" } as any;
    _setRunAgentSessionForTesting(async () => ({
      output: "done",
      durationMs: 1,
      tokens: 0,
      usage: emptyUsage(),
      touchedFiles: [],
      attributedFiles: [],
      fileAttributions: [],
      prompted: true,
    }));

    const result = await dispatchDelegate({
      pi: {} as any,
      params: {
        tasks: [
          { prompt: "one", cwd: tmpDir },
          { prompt: "two", cwd: tmpDir },
        ],
      },
      ctx: {
        cwd: tmpDir,
        model,
        modelRegistry: {
          getAvailable: () => [model],
          find: () => model,
          hasConfiguredAuth: () => true,
        },
        getSystemPrompt: () => "parent",
      } as any,
      agents: new Map(),
      parentModelId: model.id,
      parentDefaults: {
        thinking: "off",
        tools: ["read", "write", "edit", "bash"],
      },
      signal: undefined,
      onUpdate: undefined,
    });

    expect(firstText(result)).toContain("UNSAFE SHARED WRITES ENABLED");
    expect(firstText(result)).toContain("no isolation or rollback");
    expect(result.details.results).toHaveLength(2);
    _setRunAgentSessionForTesting(undefined);
  });

  test("same-root isolated writers run concurrently and reconcile into the source", async () => {
    writeFileSync(path.join(tmpDir, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ],
      { cwd: tmpDir },
    );
    const model = { provider: "test", id: "model" } as any;
    _setRunAgentSessionForTesting(async (_session, prompt, config) => {
      const index = prompt === "one" ? 0 : 1;
      writeFileSync(path.join(config.cwd, `${index}.txt`), `task ${index}\n`);
      return {
        output: "done",
        durationMs: 1,
        tokens: 0,
        toolUses: 0,
        touchedFiles: [path.join(config.cwd, `${index}.txt`)],
        attributedFiles: [path.join(config.cwd, `${index}.txt`)],
        fileAttributions: [],
        usage: emptyUsage(),
        prompted: true,
      };
    });
    const artifactRoot = `${tmpDir}-artifacts`;
    _setIsolatedArtifactRootForTesting(artifactRoot);

    try {
      const result = await dispatchDelegate({
        pi: {} as any,
        params: {
          tasks: [
            { prompt: "one", cwd: tmpDir, workspace: "isolated" },
            { prompt: "two", cwd: tmpDir, workspace: "isolated" },
          ],
        },
        ctx: {
          cwd: tmpDir,
          model,
          modelRegistry: {
            getAvailable: () => [model],
            find: () => model,
            hasConfiguredAuth: () => true,
          },
          getSystemPrompt: () => "parent",
        } as any,
        agents: new Map(),
        parentModelId: model.id,
        parentDefaults: {
          thinking: "off",
          tools: ["read", "write", "edit", "bash"],
        },
        signal: undefined,
        onUpdate: undefined,
      });

      expect(firstText(result)).not.toContain("Rejected before dispatch");
      expect(firstText(result)).toContain("applied_unverified");
      expect(firstText(result)).toContain(
        "Changes were applied but not verified",
      );
      expect(result.details.results).toHaveLength(2);
      expect(
        result.details.results.map((entry) =>
          "integration" in entry ? entry.integration?.status : undefined,
        ),
      ).toEqual(["applied_unverified", "applied_unverified"]);
      expect(
        result.details.results.map((entry) =>
          "touchedFiles" in entry ? entry.touchedFiles : [],
        ),
      ).toEqual([[path.join(tmpDir, "0.txt")], [path.join(tmpDir, "1.txt")]]);
      expect(readFileSync(path.join(tmpDir, "0.txt"), "utf8")).toBe("task 0\n");
      expect(readFileSync(path.join(tmpDir, "1.txt"), "utf8")).toBe("task 1\n");
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setIsolatedArtifactRootForTesting(undefined);
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  test("sync parent cancellation retains a completed proposal before source apply", async () => {
    commitFiles(tmpDir, { "base.txt": "base\n" });
    _setRunAgentSessionForTesting(async (_session, _prompt, config) => {
      writeFileSync(path.join(config.cwd, "base.txt"), "proposal\n");
      return {
        output: "done",
        durationMs: 1,
        tokens: 0,
        toolUses: 0,
        touchedFiles: [path.join(config.cwd, "base.txt")],
        attributedFiles: [path.join(config.cwd, "base.txt")],
        fileAttributions: [],
        usage: emptyUsage(),
        prompted: true,
      };
    });
    const controller = new AbortController();
    _setBeforeSourceApplyHookForTesting(() => controller.abort());
    const artifactRoot = `${tmpDir}-sync-cancel-artifacts`;
    _setIsolatedArtifactRootForTesting(artifactRoot);

    try {
      const input = asyncIsolatedInput(tmpDir, ["one"]);
      input.params.async = false;
      input.signal = controller.signal;
      const result = await dispatchDelegate(input);

      expect(firstText(result)).toContain("INTEGRATION: retained");
      expect(firstText(result)).toContain("0/1 tasks completed successfully");
      expect(readFileSync(path.join(tmpDir, "base.txt"), "utf8")).toBe(
        "base\n",
      );
      expect(taskResultAt(result.details.results, 0).integration?.status).toBe(
        "retained",
      );
    } finally {
      _setBeforeSourceApplyHookForTesting(undefined);
      _setRunAgentSessionForTesting(undefined);
      _setIsolatedArtifactRootForTesting(undefined);
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  test("async isolated writers reconcile before the ticket settles", async () => {
    commitFiles(tmpDir, { "base.txt": "base\n" });
    _setRunAgentSessionForTesting(async (_session, prompt, config) => {
      const fileName = `${prompt}.txt`;
      writeFileSync(path.join(config.cwd, fileName), `${prompt}\n`);
      return {
        output: "done",
        durationMs: 1,
        tokens: 0,
        toolUses: 0,
        touchedFiles: [path.join(config.cwd, fileName)],
        attributedFiles: [path.join(config.cwd, fileName)],
        fileAttributions: [],
        usage: emptyUsage(),
        prompted: true,
      };
    });
    const artifactRoot = `${tmpDir}-async-artifacts`;
    _setIsolatedArtifactRootForTesting(artifactRoot);

    try {
      const result = await dispatchDelegate(
        asyncIsolatedInput(tmpDir, ["one", "two"]),
      );

      expect(firstText(result)).toContain("Async ticket:");
      const ticket = ticketRegistry.get(result.details.ticketId!);
      expect(ticket).toBeDefined();
      await ticket!.completion;

      expect(ticket!.status).toBe("done");
      expect(ticket!.workersSettled).toBe(true);
      expect(
        ticket!.results.map((entry) => entry?.integration?.status),
      ).toEqual(["applied_unverified", "applied_unverified"]);
      expect(readFileSync(path.join(tmpDir, "one.txt"), "utf8")).toBe("one\n");
      expect(readFileSync(path.join(tmpDir, "two.txt"), "utf8")).toBe("two\n");
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setIsolatedArtifactRootForTesting(undefined);
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  test("user cancellation retains a completed async proposal before source apply", async () => {
    commitFiles(tmpDir, { "base.txt": "base\n" });
    _setRunAgentSessionForTesting(async (_session, _prompt, config) => {
      writeFileSync(path.join(config.cwd, "base.txt"), "proposal\n");
      return {
        output: "done",
        durationMs: 1,
        tokens: 0,
        toolUses: 0,
        touchedFiles: [path.join(config.cwd, "base.txt")],
        attributedFiles: [path.join(config.cwd, "base.txt")],
        fileAttributions: [],
        usage: emptyUsage(),
        prompted: true,
      };
    });
    let sourceApplyReached!: () => void;
    let releaseSourceApply!: () => void;
    const reached = new Promise<void>((resolve) => {
      sourceApplyReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSourceApply = resolve;
    });
    _setBeforeSourceApplyHookForTesting(async () => {
      sourceApplyReached();
      await release;
    });
    const artifactRoot = `${tmpDir}-cancel-artifacts`;
    _setIsolatedArtifactRootForTesting(artifactRoot);

    try {
      const result = await dispatchDelegate(
        asyncIsolatedInput(tmpDir, ["one"]),
      );
      const ticket = ticketRegistry.get(result.details.ticketId!);
      expect(ticket).toBeDefined();
      await reached;
      requestTicketCancel(ticket!);
      releaseSourceApply();
      await ticket!.completion;

      expect(ticket!.status).toBe("cancelled");
      expect(readFileSync(path.join(tmpDir, "base.txt"), "utf8")).toBe(
        "base\n",
      );
      expect(ticket!.results[0]?.integration?.status).toBe("retained");
      if (ticket!.results[0]?.integration?.status !== "retained") {
        throw new Error("proposal was not retained");
      }
      expect(existsSync(ticket!.results[0].integration!.patchPath)).toBe(true);
    } finally {
      _setBeforeSourceApplyHookForTesting(undefined);
      _setRunAgentSessionForTesting(undefined);
      _setIsolatedArtifactRootForTesting(undefined);
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  test("async isolated reconciliation conflicts fail the ticket after applying earlier proposals", async () => {
    commitFiles(tmpDir, { "base.txt": "base\n" });
    _setRunAgentSessionForTesting(async (_session, prompt, config) => {
      writeFileSync(path.join(config.cwd, "base.txt"), `${prompt}\n`);
      return {
        output: "done",
        durationMs: 1,
        tokens: 0,
        toolUses: 0,
        touchedFiles: [path.join(config.cwd, "base.txt")],
        attributedFiles: [path.join(config.cwd, "base.txt")],
        fileAttributions: [],
        usage: emptyUsage(),
        prompted: true,
      };
    });
    const artifactRoot = `${tmpDir}-conflict-artifacts`;
    _setIsolatedArtifactRootForTesting(artifactRoot);

    try {
      const result = await dispatchDelegate(
        asyncIsolatedInput(tmpDir, ["one", "two"]),
      );
      const ticket = ticketRegistry.get(result.details.ticketId!);
      expect(ticket).toBeDefined();
      await ticket!.completion;

      expect(ticket!.status).toBe("failed");
      expect(
        ticket!.results.map((entry) => entry?.integration?.status),
      ).toEqual(["applied_unverified", "conflict"]);
      expect(readFileSync(path.join(tmpDir, "base.txt"), "utf8")).toBe("one\n");
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setIsolatedArtifactRootForTesting(undefined);
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  test("async isolated setup failure settles the ticket without starting workers", async () => {
    commitFiles(tmpDir, {
      "base.txt": "base\n",
      ".gitmodules": '[submodule "x"]\n',
    });
    let ran = 0;
    const delivered: string[] = [];
    _setRunAgentSessionForTesting(async () => {
      ran += 1;
      throw new Error("worker should not start");
    });
    try {
      const result = await dispatchDelegate(
        asyncIsolatedInput(tmpDir, ["one"], {
          sendMessage: (message: { content?: string }) =>
            delivered.push(message.content ?? ""),
        }),
      );

      const ticket = ticketRegistry.get(result.details.ticketId!);
      expect(ticket).toBeDefined();
      await ticket!.completion;

      expect(ran).toBe(0);
      expect(ticket!.status).toBe("failed");
      expect(ticket!.error).toContain(
        "does not yet support repositories with submodules",
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain("Isolated workspace setup failed");
      expect(delivered[0]).toContain("no subagents were started");
    } finally {
      _setRunAgentSessionForTesting(undefined);
    }
  });

  test("shutdown cancellation does not apply an async isolated worker", async () => {
    commitFiles(tmpDir, { "base.txt": "base\n" });
    let workerEntered!: () => void;
    let releaseWorker!: () => void;
    const entered = new Promise<void>((resolve) => {
      workerEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    _setRunAgentSessionForTesting(async (_session, _prompt, config) => {
      writeFileSync(path.join(config.cwd, "base.txt"), "proposal\n");
      workerEntered();
      await release;
      return {
        output: "done",
        durationMs: 1,
        tokens: 0,
        toolUses: 0,
        touchedFiles: [path.join(config.cwd, "base.txt")],
        attributedFiles: [path.join(config.cwd, "base.txt")],
        fileAttributions: [],
        usage: emptyUsage(),
        prompted: true,
      };
    });
    const artifactRoot = `${tmpDir}-shutdown-artifacts`;
    _setIsolatedArtifactRootForTesting(artifactRoot);
    let deliveries = 0;

    try {
      const result = await dispatchDelegate(
        asyncIsolatedInput(tmpDir, ["one"], {
          sendMessage: () => {
            deliveries += 1;
          },
        }),
      );
      const ticket = ticketRegistry.get(result.details.ticketId!);
      expect(ticket).toBeDefined();
      await entered;
      cancelTicketForShutdown(ticket!);
      releaseWorker();
      await ticket!.completion;

      expect(ticket!.status).toBe("cancelled");
      expect(readFileSync(path.join(tmpDir, "base.txt"), "utf8")).toBe(
        "base\n",
      );
      expect(ticket!.results[0]?.integration?.status).toBe("discarded");
      expect(deliveries).toBe(0);
    } finally {
      _setRunAgentSessionForTesting(undefined);
      _setIsolatedArtifactRootForTesting(undefined);
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  test("reports an abort, not a safety failure, when the turn aborts during preflight", async () => {
    const model = { provider: "test", id: "model" } as any;
    const finishes: Array<Record<string, unknown>> = [];
    // Pre-aborted: execFile rejects before git can answer, which is exactly
    // the mid-preflight cancellation the gate must not misreport.
    const controller = new AbortController();
    controller.abort();
    const result = await dispatchDelegate({
      pi: {} as any,
      params: {
        tasks: [
          { id: "one", prompt: "one", cwd: tmpDir },
          { id: "two", prompt: "two", cwd: tmpDir },
        ],
      },
      ctx: {
        cwd: tmpDir,
        model,
        modelRegistry: {
          getAvailable: () => [model],
          find: () => model,
          hasConfiguredAuth: () => true,
        },
        getSystemPrompt: () => "parent",
      } as any,
      agents: new Map(),
      parentModelId: model.id,
      parentDefaults: {
        thinking: "off",
        tools: ["read", "write", "edit", "bash"],
      },
      signal: controller.signal,
      onUpdate: (() => {}) as any,
      callSpan: {
        startedAt: Date.now(),
        finish: (record: Record<string, unknown>) => finishes.push(record),
      } as any,
    });

    expect(firstText(result)).toBe(
      "Aborted before dispatch; no tasks were started.",
    );
    expect(result.details.results).toEqual([]);
    expect(ticketRegistry.size).toBe(0);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      status: "cancelled",
      totalTokens: 0,
      totalCost: 0,
    });
  });

  test("rejects a writer that overlaps a still-running async ticket", async () => {
    const model = { provider: "test", id: "model" } as any;
    ticketRegistry.set("live1234", {
      id: "live1234",
      created: Date.now(),
      tasks: [{ id: "old", prompt: "old", cwd: tmpDir }],
      resolved: [
        {
          id: "old",
          prompt: "old",
          model,
          tools: ["write"],
          thinking: "off",
          systemPrompt: "",
          cwd: tmpDir,
          workspace: "shared",
          agentName: "coder",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: [
        {
          id: "old",
          index: 0,
          agent: "coder",
          task: "old",
          status: "running",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      workersSettled: false,
    });

    const result = await dispatchDelegate({
      pi: {} as any,
      params: {
        async: true,
        tasks: [{ id: "new", prompt: "new", cwd: tmpDir }],
      },
      ctx: {
        cwd: tmpDir,
        model,
        modelRegistry: {
          getAvailable: () => [model],
          find: () => model,
          hasConfiguredAuth: () => true,
        },
        getSystemPrompt: () => "parent",
      } as any,
      agents: new Map(),
      parentModelId: model.id,
      parentDefaults: {
        thinking: "off",
        tools: ["read", "write", "edit", "bash"],
      },
      signal: undefined,
      onUpdate: undefined,
    });

    expect(firstText(result)).toContain(
      "Task 1#new, async ticket 'live1234' task 1#old",
    );
    expect(firstText(result)).toContain("Rejected before dispatch");
    expect(ticketRegistry.size).toBe(1);
  });

  test("rejects a writer that overlaps a still-running sync dispatch", async () => {
    const model = { provider: "test", id: "model" } as any;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let releaseWorker!: () => void;
    const workerReleased = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    _setRunAgentSessionForTesting(async () => {
      announceStarted();
      await workerReleased;
      return {
        output: "done",
        durationMs: 1,
        tokens: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        attributedFiles: [],
        fileAttributions: [],
        prompted: true,
      };
    });
    const invoke = (prompt: string) =>
      dispatchDelegate({
        pi: {} as any,
        params: { tasks: [{ prompt, cwd: tmpDir }] },
        ctx: {
          cwd: tmpDir,
          model,
          modelRegistry: {
            getAvailable: () => [model],
            find: () => model,
            hasConfiguredAuth: () => true,
          },
          getSystemPrompt: () => "parent",
        } as any,
        agents: new Map(),
        parentModelId: model.id,
        parentDefaults: {
          thinking: "off",
          tools: ["read", "write", "edit", "bash"],
        },
        signal: undefined,
        onUpdate: undefined,
      });

    const active = invoke("active");
    try {
      await started;
      const rejected = await invoke("incoming");
      expect(firstText(rejected)).toContain(
        "Rejected before dispatch; no tasks were started.",
      );
      expect(firstText(rejected)).toContain("active sync task 1");
    } finally {
      releaseWorker();
      await active;
      _setRunAgentSessionForTesting(undefined);
    }
  });
});

function makeFakeSession(
  touchedFiles: string[],
  attributedFiles = touchedFiles,
): FakeSession {
  return {
    touchedFiles,
    attributedFiles,
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
    isIdle: true,
    isCompacting: false,
    messages: [],
    state: {},
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
  };
}

function makeFakeSessionManager(file: string) {
  return { getSessionFile: () => file } as any;
}

describe("dispatchSync touched-file overlap warning", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetPoolForTesting();
    _resetQuarantineRegistryForTesting();
    _setGlobalConcurrencyLimitForTesting(10);
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "delegate-dispatch-"));
    _setRunAgentSessionForTesting(
      async (session: any, _prompt, _config, _signal, _onProgress) => {
        return {
          output: "done",
          durationMs: 1,
          tokens: 1,
          usage: emptyUsage(),
          touchedFiles: session.touchedFiles ?? [],
          attributedFiles: session.attributedFiles ?? [],
        } as any;
      },
    );
  });

  afterEach(() => {
    _setRunAgentSessionForTesting(undefined);
    _resetGlobalConcurrencyForTesting();
    _resetPoolForTesting();
    _resetQuarantineRegistryForTesting();
    _resetTelemetryForTesting();
    _resetDelegateConfigForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupTask(
    sessionId: string,
    agentName: string,
    touchedFiles: string[],
    taskId?: string,
    attributedFiles = touchedFiles,
  ): { resolved: ResolvedTask; progress: TaskProgress } {
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, '{"type":"session"}\n');
    const session = makeFakeSession(touchedFiles, attributedFiles);
    const manager = makeFakeSessionManager(sessionFile);
    commit(sessionId, {
      session: session as unknown as Parameters<typeof commit>[1]["session"],
      sessionManager: manager,
      sessionFile,
      frozen: {
        systemPrompt: "",
        model: { provider: "test", id: "m" } as any,
        thinking: "off",
        tools: [],
        cwd: tmpDir,
        providerExtensions: "",
      },
      tokens: 1,
    });

    return {
      resolved: {
        id: taskId,
        sessionId,
        agentName,
        prompt: `${agentName} work`,
        cwd: tmpDir,
        thinking: "off",
        tools: [],
        systemPrompt: "",
        model: { provider: "test", id: "m" } as any,
      } as unknown as ResolvedTask,
      progress: {
        id: taskId,
        index: 0,
        agent: agentName,
        task: `${agentName} work`,
        status: "running",
        durationMs: 0,
        tokens: 0,
        toolUses: 0,
        activities: [],
      } as TaskProgress,
    };
  }

  test("omits top-level usage when abandoned accounting is incomplete", async () => {
    const task = setupTask("abandoned-usage", "coder", []);
    let confirmSafe!: () => void;
    const safe = new Promise<void>((resolve) => {
      confirmSafe = resolve;
    });
    _setRunAgentSessionForTesting(async () =>
      markSessionQuarantined(
        {
          output: "partial",
          error: "Stalled",
          failureKind: "stalled",
          incomplete: "quiescence_abandoned",
          durationMs: 1,
          tokens: 1,
          usage: { ...emptyUsage(), totalTokens: 1 },
          touchedFiles: [],
          attributedFiles: [],
          fileAttributions: [],
          prompted: true,
        },
        { safe },
      ),
    );

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "work" }],
      resolved: [task.resolved],
      progress: [task.progress],
      parentModelId: "m",
      dispatchConfig: getDelegateConfigSnapshot(),
      signal: undefined,
      fire: () => {},
    });

    expect(taskResultAt(result.details.results, 0).incomplete).toBe(
      "quiescence_abandoned",
    );
    expect("usage" in result).toBe(false);
    expect(firstText(result)).toContain(
      "token usage, and cost are lower bounds",
    );

    confirmSafe();
    await safe;
    await Promise.resolve();
  });

  test("emits overlap warning when two tasks touch the same path", async () => {
    const shared = path.join(tmpDir, "shared.txt");
    const a = setupTask("s1", "a", [shared]);
    const b = setupTask("s2", "b", [shared]);

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }, { prompt: "b" }] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      dispatchConfig: getDelegateConfigSnapshot(),
      signal: undefined,
      fire: () => {},
    });

    const text = firstText(result);
    expect(text).toContain("touched (best-effort): shared.txt");
    expect(text).toContain(shared);
    expect(text).toContain("does not isolate or serialize file access");
    expect(text).toContain("does not roll back completed writes");
  });

  test("omits overlap warning when tasks touch distinct paths", async () => {
    const a = setupTask("s1", "a", [path.join(tmpDir, "a.txt")]);
    const b = setupTask("s2", "b", [path.join(tmpDir, "b.txt")]);

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }, { prompt: "b" }] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      dispatchConfig: getDelegateConfigSnapshot(),
      signal: undefined,
      fire: () => {},
    });

    const text = firstText(result);
    expect(text).not.toContain("does not isolate or serialize file access");
    expect(text).not.toContain("does not roll back completed writes");
  });

  test("omits overlap warning when git-derived touchedFiles overlap but attributedFiles do not", async () => {
    const aFile = path.join(tmpDir, "a.txt");
    const bFile = path.join(tmpDir, "b.txt");
    // Each task's post-run git snapshot sees both files, but only one was
    // directly written by each subagent.
    const a = setupTask("s1", "a", [aFile, bFile], undefined, [aFile]);
    const b = setupTask("s2", "b", [aFile, bFile], undefined, [bFile]);

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }, { prompt: "b" }] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      dispatchConfig: getDelegateConfigSnapshot(),
      signal: undefined,
      fire: () => {},
    });

    const text = firstText(result);
    // Display still reports the best-effort union for each task.
    expect(text).toContain("touched (best-effort): a.txt, b.txt");
    // Overlap is computed only from directly attributable files.
    expect(text).not.toContain("does not isolate or serialize file access");
    expect(text).not.toContain("does not roll back completed writes");
  });

  test("carries caller-provided task id onto result and progress", async () => {
    const a = setupTask("s1", "a", [], "task-a");
    const b = setupTask("s2", "b", [], "task-b");

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [
        { id: "task-a", prompt: "a" },
        { id: "task-b", prompt: "b" },
      ] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      dispatchConfig: getDelegateConfigSnapshot(),
      signal: undefined,
      fire: () => {},
    });

    expect(taskResultAt(result.details.results, 0).id).toBe("task-a");
    expect(taskResultAt(result.details.results, 1).id).toBe("task-b");
    expect(result.details.progress[0]!.id).toBe("task-a");
    expect(result.details.progress[1]!.id).toBe("task-b");
    // Result arrays stay index-aligned; ids are per-entry, not keys.
    expect(result.details.results).toHaveLength(2);
  });

  test("shutdown records usage from a worker that settles after cancellation", async () => {
    const calls: CallRecord[] = [];
    const tasks: TaskRecord[] = [];
    _setTelemetryForTesting({
      recordCall: (record) => calls.push(record),
      recordTask: (record) => tasks.push(record),
    });

    let workerEntered!: () => void;
    let releaseWorker!: () => void;
    const entered = new Promise<void>((resolve) => {
      workerEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    _setRunAgentSessionForTesting(async () => {
      workerEntered();
      await release;
      return {
        output: "late result",
        durationMs: 10,
        tokens: 23,
        usage: {
          input: 10,
          output: 13,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 23,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.23,
          },
        },
        touchedFiles: [],
        attributedFiles: [],
      } as any;
    });

    const task = setupTask("late-shutdown", "late", []);
    const callSpan = beginCall({
      parentModel: "model",
      mode: "async",
      taskCount: 1,
    });
    let deliveries = 0;
    const acknowledgment = dispatchAsync({
      pi: {
        sendMessage: () => {
          deliveries++;
        },
      } as any,
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "late work" }] as TaskDef[],
      resolved: [task.resolved],
      progress: [task.progress],
      parentModelId: "model",
      dispatchConfig: getDelegateConfigSnapshot(),
      callSpan,
    });
    const ticket = ticketRegistry.get(acknowledgment.details.ticketId!);
    if (!ticket) throw new Error("async ticket was not registered");
    const completion = ticket.completion;
    if (!completion) throw new Error("async ticket has no completion promise");

    // Ensure shutdown happens while the worker is inside the delayed run.
    await entered;
    cancelTicketForShutdown(ticket);
    expect(calls.at(-1)?.status).toBe("cancelled");
    expect(calls.at(-1)?.total_tokens).toBe(0);

    // The completion handler must wait for this late result and rewrite the
    // cancelled call row, but must not send a stale follow-up UI message.
    releaseWorker();
    await completion;

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.tokens).toBe(23);
    expect(calls.at(-1)?.status).toBe("cancelled");
    expect(calls.at(-1)?.total_tokens).toBe(23);
    expect(calls.at(-1)?.total_cost).toBe(0.23);
    expect(deliveries).toBe(0);
  });

  test("deadlineMs is measured from run start, not dispatch time", async () => {
    _setGlobalConcurrencyLimitForTesting(1);
    _setRunAgentSessionForTesting(
      async (
        _session,
        _prompt,
        _config,
        _signal,
        _onProgress,
        _gitBaseline,
        _start,
        deadlineAt,
      ) => {
        if (deadlineAt === undefined) {
          await new Promise((r) => setTimeout(r, 80));
          return {
            output: "a done",
            durationMs: 80,
            tokens: 1,
            usage: emptyUsage(),
            touchedFiles: [],
            attributedFiles: [],
          } as any;
        }
        await new Promise((r) => setTimeout(r, 10));
        return {
          output: "b done",
          durationMs: 10,
          tokens: 1,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
        } as any;
      },
    );

    const a = setupTask("s1", "a", []);
    const b = setupTask("s2", "b", []);
    (b.resolved as any).deadlineMs = 50;

    const result = await dispatchSync({
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }, { prompt: "b", deadlineMs: 50 }] as TaskDef[],
      resolved: [a.resolved, b.resolved],
      progress: [a.progress, b.progress],
      parentModelId: "m",
      dispatchConfig: getDelegateConfigSnapshot(),
      signal: undefined,
      fire: () => {},
    });

    expect(result.details.results[0]!.error).toBeUndefined();
    expect(result.details.results[1]!.error).toBeUndefined();
    expect(taskResultAt(result.details.results, 1).output).toBe("b done");
  });

  test("async ticket and runner capture a dispatch-scoped config snapshot", async () => {
    const a = setupTask("s1", "a", []);
    let capturedConfig: DelegateConfig | undefined;
    let releaseWorker!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      _setRunAgentSessionForTesting(async (...args: unknown[]) => {
        capturedConfig = args[8] as DelegateConfig;
        resolve();
        await new Promise<void>((r) => (releaseWorker = r));
        return {
          output: "done",
          durationMs: 1,
          tokens: 1,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
          prompted: true,
        } as any;
      });
    });

    _setDelegateConfigForTesting({
      retry: { wholeTaskMaxRetries: 7, wholeTaskBaseDelayMs: 250 },
      stallTimeoutMs: 12345,
    });
    const dispatchConfig = getDelegateConfigSnapshot();

    const callSpan = beginCall({
      parentModel: "m",
      mode: "async",
      taskCount: 1,
    });
    const ack = dispatchAsync({
      pi: { sendMessage: () => {} } as any,
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      } as any,
      tasks: [{ prompt: "a" }] as any,
      resolved: [a.resolved],
      progress: [a.progress],
      parentModelId: "m",
      callSpan,
      dispatchConfig,
    });

    const ticket = ticketRegistry.get(ack.details.ticketId!);
    expect(ticket?.config?.retry?.wholeTaskMaxRetries).toBe(7);
    expect(ticket?.config?.stallTimeoutMs).toBe(12345);

    await workerStarted;

    // Mutate the global singleton while the worker is still inside runAgentSession.
    _setDelegateConfigForTesting({
      retry: { wholeTaskMaxRetries: 1, wholeTaskBaseDelayMs: 0 },
      stallTimeoutMs: 999,
    });

    releaseWorker();
    await ticket?.completion;

    // The runner must have used the snapshot captured at dispatch, not the
    // new global values.
    expect(capturedConfig?.retry?.wholeTaskMaxRetries).toBe(7);
    expect(capturedConfig?.stallTimeoutMs).toBe(12345);
  });
});

// Issue #30: an async ticket must remember the session-tree leaf it was
// spawned on, so a result that arrives after /tree navigation does not wake
// the parent agent on a branch the task was never part of.
describe("dispatchAsync leaf affinity", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetPoolForTesting();
    _setGlobalConcurrencyLimitForTesting(10);
    resetLeafTracking();
    _resetDelegateStatusForTesting();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "delegate-leaf-"));
    _setRunAgentSessionForTesting(
      async () =>
        ({
          output: "done",
          durationMs: 1,
          tokens: 1,
          usage: emptyUsage(),
          touchedFiles: [],
          attributedFiles: [],
        }) as any,
    );
  });

  afterEach(() => {
    _setRunAgentSessionForTesting(undefined);
    _resetGlobalConcurrencyForTesting();
    _resetPoolForTesting();
    ticketRegistry.clear();
    resetLeafTracking();
    _resetDelegateStatusForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(sendMessage?: (message: any, options: any) => void): {
    sent: { message: any; options: any }[];
    notified: string[];
    ticketId: string;
  } {
    const sent: { message: any; options: any }[] = [];
    const notified: string[] = [];
    const uiCtx = {
      hasUI: true,
      ui: {
        setStatus: () => {},
        notify: (message: string) => notified.push(message),
      },
    } as any;
    // Prime the ctx status.ts caches for its event-driven notifications;
    // dispatchAsync itself only calls syncDelegateStatus() without a ctx.
    syncDelegateStatus(uiCtx);

    const result = dispatchAsync({
      pi: {
        sendMessage:
          sendMessage ??
          ((message: any, options: any) => sent.push({ message, options })),
      } as any,
      ctx: {
        cwd: tmpDir,
        model: { provider: "test", id: "m" } as any,
        modelRegistry: {} as any,
        sessionManager: undefined,
      },
      tasks: [{ prompt: "a" }] as TaskDef[],
      resolved: [
        {
          agentName: "a",
          prompt: "a work",
          cwd: tmpDir,
          thinking: "off",
          tools: [],
          systemPrompt: "",
          model: { provider: "test", id: "m" } as any,
        } as unknown as ResolvedTask,
      ],
      progress: [
        {
          index: 0,
          agent: "a",
          task: "a work",
          status: "running",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        } as TaskProgress,
      ],
      parentModelId: "m",
      dispatchConfig: getDelegateConfigSnapshot(),
    });
    const ticketId = result.details.ticketId!;
    return { sent, notified, ticketId };
  }

  async function settled(ticketId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (ticketRegistry.get(ticketId)?.completedAt) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`ticket ${ticketId} never settled`);
  }

  test("stamps the current leaf and delivers normally when it has not changed", async () => {
    recordTreeNavigation("leaf-1");
    const { sent, notified, ticketId } = run();
    expect(ticketRegistry.get(ticketId)!.spawnLeafId).toBe("leaf-1");

    await settled(ticketId);
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(notified).toEqual([]);
  });

  test("navigating away before completion defers delivery and warns the human", async () => {
    recordTreeNavigation("leaf-1");
    const { sent, notified, ticketId } = run();

    // The user opens /tree and moves while the subagent is still working.
    recordTreeNavigation("leaf-2");
    await settled(ticketId);

    expect(sent[0]!.options).toEqual({ deliverAs: "nextTurn" });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain(ticketId);
  });

  test("sendMessage failure is logged without changing worker settlement", async () => {
    const deliveryError = new Error("parent session unavailable");
    const logged = mock((..._args: unknown[]) => {});
    const originalError = console.error;
    console.error = logged as unknown as typeof console.error;

    try {
      const { ticketId } = run(() => {
        throw deliveryError;
      });
      const ticket = ticketRegistry.get(ticketId);
      if (!ticket?.completion)
        throw new Error("async ticket has no completion promise");

      await ticket.completion;

      // The worker settled normally; failed unsolicited delivery leaves the
      // completed result available to poll rather than re-entering .catch().
      expect(ticket.status).toBe("done");
      expect(ticket.completedAt).toBeDefined();
      expect(ticket.results[0]!.output).toBe("done");
      expect(logged).toHaveBeenCalledWith(
        `[delegate] failed to deliver results for ticket '${ticketId}'; it remains pollable`,
        deliveryError,
      );
    } finally {
      console.error = originalError;
    }
  });
});

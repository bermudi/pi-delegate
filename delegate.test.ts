import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
  _resetPoolForTesting,
  _setPoolAbortTimeoutForTesting,
  recordUse,
} from "./pool.ts";
import {
  _resetDelegateConfigForTesting,
  _setDelegateConfigForTesting,
} from "./config.ts";
import {
  inFlightActivity,
  latestActivity,
  formatActivityLabel,
  compactActivity,
  taskMetaBase,
  waitingLabel,
  relativeTouchedSummary,
  findTouchedOverlaps,
  formatTouchedOverlapWarning,
} from "./format.ts";

import {
  parseFrontmatter,
  findProjectRoot,
  loadAgentFile,
  loadClaudeAgentFile,
  discoverAgents,
  buildParentTranscript,
  extractTextContent,
  resolveModel,
  resolveModelRequest,
  findAvailableAlternative,
  resolveModelSpec,
  extractOutput,
  extractUsage,
  fmtDuration,
  fmtTokens,
  trunc,
  truncLine,
  tree,
  indent,
  shortenPath,
  formatFailedTask,
  formatCompletedTask,
  getActivityAge,
  DEFAULT_TOOLS,
  READONLY_TOOLS,
  VALID_THINKING,
  TOOL_FACTORIES,
  resolveToolGroups,
  extractTouchedFromActivities,
  checkout,
  commit,
  configFor,
  closePooledAgent,
  closeAllPooledAgents,
  listPooledAgents,
  withSessionLock,
  getHostDeps,
  invalidateHostDepsCache,
  readDelegateSettingsFile,
  loadDelegateSettings,
  getConcurrencyLimit,
  getMaxAsyncTickets,
  getStallTimeoutMs,
  type AgentConfig,
  type DelegateConfig,
  type TaskProgress,
  type TaskResult,
  type ToolActivity,
  ticketRegistry,
  type AsyncTicket,
  sweepTickets,
  cancelTicketForShutdown,
  isSessionBusy,
  handlePoll,
  handleCancel,
  handleWait,
  notifyWaiters,
  deliverTicketResults,
  resolveFinalTicketStatus,
  formatCompletedTicket,
  resolveCwd,
} from "./delegate.ts";
import {
  _setHostRetryBaseMsForTesting,
  _resetHostDepsCacheForTesting,
} from "./host.ts";
import { resolveTasks, validateTasks } from "./task-resolution.ts";
import { recordTreeNavigation, resetLeafTracking } from "./leaf.ts";

// ── Integration test imports ──────────────────────────────────────────────

import {
  createTestSession,
  when,
  calls,
  says,
} from "@marcfargas/pi-test-harness";
import { resolve } from "node:path";

const EXTENSION = resolve(import.meta.dirname, "./delegate.ts");

type TestSession = Awaited<ReturnType<typeof createTestSession>>;

function getToolDef(ts: TestSession, name: string) {
  const runner = ts.session.extensionRunner;
  if (!runner) throw new Error("No extensionRunner on session");
  return runner.getToolDefinition(name);
}

function getTasksArraySchema(schema: any): any {
  const tasks = schema.properties.tasks;
  if (tasks.type === "array") return tasks;
  const branches = tasks.anyOf ?? tasks.oneOf ?? [];
  return branches.find((branch: any) => branch.type === "array");
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(prefix = "delegate-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function writeAgent(dir: string, filename: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), content, "utf-8");
}

// ── parseFrontmatter ──────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses YAML-ish frontmatter", () => {
    const content = `---
name: scout
description: A scout agent
---
You are a scout.
`;
    const result = parseFrontmatter(content);
    expect(result.data.name).toBe("scout");
    expect(result.data.description).toBe("A scout agent");
    expect(result.body).toBe("You are a scout.");
  });

  test("handles CRLF line endings", () => {
    const content = `---\r\nname: worker\r\ndescription: A worker\r\n---\r\nDo work.\r\n`;
    const result = parseFrontmatter(content);
    expect(result.data.name).toBe("worker");
    expect(result.body).toBe("Do work.");
  });

  test("returns empty data when no frontmatter", () => {
    const result = parseFrontmatter("Just body text.");
    expect(Object.keys(result.data)).toHaveLength(0);
    expect(result.body).toBe("Just body text.");
  });

  test("treats a stray non-key line as a parse error, not a crash", () => {
    // A line that looks like an implicit map key with no value is malformed
    // YAML. The real parser surfaces it (logged) instead of silently
    // absorbing it; callers skip the file via the name/description check.
    const content = `---
name: agent
bad line without colon
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.name).toBeUndefined();
  });

  test("trims keys and values", () => {
    const content = `---
  name  :   spaced agent  
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.name).toBe("spaced agent");
  });

  test("handles empty body", () => {
    const content = `---
name: agent
description: desc
---
`;
    const result = parseFrontmatter(content);
    expect(result.body).toBe("");
  });

  test("values containing colons parse correctly", () => {
    const content = `---
name: scout
description: Fix the bug in agents.ts:42 and retry
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.description).toBe(
      "Fix the bug in agents.ts:42 and retry",
    );
  });

  test("handles colon-space in unquoted scalar values", () => {
    const content = `---
name: scout
description: Use when: X, not for: Y
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.description).toBe("Use when: X, not for: Y");
  });

  test("multiline block scalars parse", () => {
    const content = `---
name: scout
description: |
  line one
  line two: with a colon
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.description).toBe("line one\nline two: with a colon\n");
  });

  test("quoted strings with special chars parse verbatim", () => {
    const content = `---
name: scout
description: "a: b [c] {d}"
model: "anthropic/claude-sonnet-4:beta"
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.description).toBe("a: b [c] {d}");
    expect(result.data.model).toBe("anthropic/claude-sonnet-4:beta");
  });

  test("drops keys with an empty value", () => {
    const content = `---
name: agent
empty key without colon:
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.name).toBe("agent");
    expect(result.data["empty key without colon"]).toBeUndefined();
  });

  test("logs and skips a genuinely malformed frontmatter block", () => {
    const content = `---
name: a
  : b
  c
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.name).toBeUndefined();
    expect(result.body).toBe(content.trim());
  });

  test("bare `tools: *` is recovered as the full-agent shorthand", () => {
    const content = `---
name: star
description: All tools
tools: *
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.tools).toBe("*");
  });

  test("recovers bare `tools: *` with a trailing YAML comment", () => {
    const content = `---
name: star
description: All tools
tools: * # Full agent
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.tools).toBe("*");
  });

  test("recovers commented bare `tools: *` with CRLF line endings", () => {
    const content = `---\r
name: star\r
description: All tools\r
tools: * # Full agent\r
---\r
Body.\r
`;
    const result = parseFrontmatter(content);
    expect(result.data.tools).toBe("*");
  });

  test("nested map values are JSON-stringified, not '[object Object]'", () => {
    const content = `---
name: nested
description: Has a nested block
meta:
  k: v
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.name).toBe("nested");
    expect(result.data.meta).toBe('{"k":"v"}');
  });
});

// ── findProjectRoot ───────────────────────────────────────────────────────

describe("findProjectRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test("finds .pi/agents directory", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(path.join(projectDir, ".pi", "agents"), { recursive: true });
    expect(findProjectRoot(projectDir)).toBe(projectDir);
  });

  test("walks up the directory tree", () => {
    const projectDir = path.join(tmpDir, "project");
    const nested = path.join(projectDir, "src", "deep");
    mkdirSync(path.join(projectDir, ".pi", "agents"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(projectDir);
  });

  test("returns null when not found", () => {
    expect(findProjectRoot(tmpDir)).toBeNull();
  });

  test("stops at filesystem root", () => {
    expect(findProjectRoot("/")).toBeNull();
  });
});

// ── loadAgentFile ─────────────────────────────────────────────────────────

describe("loadAgentFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test("returns null for non-existent file", () => {
    expect(loadAgentFile(path.join(tmpDir, "nonexistent.md"))).toBeNull();
  });

  test("parses a complete agent file", () => {
    const filePath = path.join(tmpDir, "scout.md");
    writeFileSync(
      filePath,
      `---
name: scout
description: Fast reconnaissance agent
model: anthropic/claude-haiku-4-5
thinking: low
tools: read, grep
---
You are a scout. Be concise.
`,
    );
    const cfg = loadAgentFile(filePath)!;
    expect(cfg.name).toBe("scout");
    expect(cfg.description).toBe("Fast reconnaissance agent");
    expect(cfg.model).toBe("anthropic/claude-haiku-4-5");
    expect(cfg.thinking).toBe("low");
    expect(cfg.tools).toEqual(["read", "grep"]);
    expect(cfg.systemPrompt).toBe("You are a scout. Be concise.");
  });

  test("named agent without tools field inherits the full agent set (*)", () => {
    const filePath = path.join(tmpDir, "no-tools.md");
    writeFileSync(
      filePath,
      `---
name: no-tools
description: No tools agent
---
Prompt.
`,
    );
    const cfg = loadAgentFile(filePath)!;
    // Matches CC/OpenCode/Devin: omitted tools → inherit all (DEFAULT_TOOLS).
    expect(cfg.tools).toEqual(DEFAULT_TOOLS);
  });

  test("defaults thinking to off when invalid", () => {
    const filePath = path.join(tmpDir, "bad-thinking.md");
    writeFileSync(
      filePath,
      `---
name: bad-thinking
description: Bad thinking
thinking: super-duper-high
---
Prompt.
`,
    );
    const cfg = loadAgentFile(filePath)!;
    expect(cfg.thinking).toBe("off");
  });

  test("returns null when name is missing", () => {
    const filePath = path.join(tmpDir, "no-name.md");
    writeFileSync(
      filePath,
      `---
description: No name here
---
Prompt.
`,
    );
    expect(loadAgentFile(filePath)).toBeNull();
  });

  test("returns null when description is missing", () => {
    const filePath = path.join(tmpDir, "no-desc.md");
    writeFileSync(
      filePath,
      `---
name: no-desc
---
Prompt.
`,
    );
    expect(loadAgentFile(filePath)).toBeNull();
  });

  test("trims and filters empty tools", () => {
    const filePath = path.join(tmpDir, "spaced-tools.md");
    writeFileSync(
      filePath,
      `---
name: spaced
description: Spaced tools
tools: read, , write , , grep
---
Prompt.
`,
    );
    const cfg = loadAgentFile(filePath)!;
    expect(cfg.tools).toEqual(["read", "write", "grep"]);
  });

  test("expands * to the full agent set (not every registered tool)", () => {
    const filePath = path.join(tmpDir, "star-tools.md");
    writeFileSync(
      filePath,
      `---
name: star-agent
description: All tools agent
tools: *
---
Prompt.
`,
    );
    const cfg = loadAgentFile(filePath)!;
    expect(cfg.tools).toEqual(DEFAULT_TOOLS);
  });

  test("expands ro to the read-only scout set", () => {
    const filePath = path.join(tmpDir, "ro-tools.md");
    writeFileSync(
      filePath,
      `---
name: ro-agent
description: Read-only agent
tools: ro
---
Prompt.
`,
    );
    const cfg = loadAgentFile(filePath)!;
    expect(cfg.tools).toEqual(READONLY_TOOLS);
  });
});

// ── expandToolsStar ──────────────────────────────────────────────────────

describe("resolveToolGroups", () => {
  test("passes through arrays without shorthands", () => {
    expect(resolveToolGroups(["read", "bash"])).toEqual(["read", "bash"]);
  });

  test("expands * to the full agent set", () => {
    expect(resolveToolGroups(["*"])).toEqual(DEFAULT_TOOLS);
  });

  test("expands ro to the read-only scout set", () => {
    expect(resolveToolGroups(["ro"])).toEqual(READONLY_TOOLS);
  });

  test("expands * and keeps additional tools (deduped)", () => {
    const result = resolveToolGroups(["*", "read"]);
    expect(result.sort()).toEqual(
      [...new Set([...DEFAULT_TOOLS, "read"])].sort(),
    );
  });

  test("returns empty array as-is", () => {
    expect(resolveToolGroups([])).toEqual([]);
  });

  test("does not throw on Object.prototype-named tool names", () => {
    expect(resolveToolGroups(["constructor"])).toEqual(["constructor"]);
    expect(resolveToolGroups(["toString"])).toEqual(["toString"]);
    expect(resolveToolGroups(["__proto__"])).toEqual(["__proto__"]);
  });
});

// ── discoverAgents ────────────────────────────────────────────────────────

describe("discoverAgents", () => {
  let tmpDir: string;
  let originalHomedir: () => string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    originalHomedir = os.homedir;
    mock.module("node:os", () => ({
      ...os,
      homedir: () => tmpDir,
    }));
  });

  afterEach(() => {
    mock.module("node:os", () => os);
    cleanup(tmpDir);
  });

  test("discovers agents from project dir", () => {
    const projectDir = path.join(tmpDir, "project");
    writeAgent(
      path.join(projectDir, ".pi", "agents"),
      "project.md",
      `---
name: project-agent
description: Project agent
---
Prompt.
`,
    );
    const agents = discoverAgents(projectDir);
    expect(agents.has("project-agent")).toBe(true);
  });

  test("discovers agents from global ~/.pi/agent/agents/", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeAgent(
      path.join(tmpDir, ".pi", "agent", "agents"),
      "global.md",
      `---
name: global-agent
description: Global agent
---
Prompt.
`,
    );
    const agents = discoverAgents(projectDir);
    expect(agents.has("global-agent")).toBe(true);
    expect(agents.get("global-agent")!.scope).toBe("global");
  });

  test("discovers agents from legacy ~/.agents/", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeAgent(
      path.join(tmpDir, ".agents"),
      "legacy.md",
      `---
name: legacy-agent
description: Legacy agent
---
Prompt.
`,
    );
    const agents = discoverAgents(projectDir);
    expect(agents.has("legacy-agent")).toBe(true);
    expect(agents.get("legacy-agent")!.scope).toBe("global");
  });

  test("project agents override global on name collision", () => {
    const projectDir = path.join(tmpDir, "project");
    writeAgent(
      path.join(projectDir, ".pi", "agents"),
      "shared.md",
      `---
name: shared-agent
description: Project wins
---
Project prompt.
`,
    );
    writeAgent(
      path.join(tmpDir, ".pi", "agent", "agents"),
      "shared.md",
      `---
name: shared-agent
description: Global loses
---
Global prompt.
`,
    );
    const agents = discoverAgents(projectDir);
    expect(agents.has("shared-agent")).toBe(true);
    expect(agents.get("shared-agent")!.systemPrompt).toBe("Project prompt.");
    expect(agents.get("shared-agent")!.scope).toBe("project");
  });

  test("returns empty map when no agent directories exist", () => {
    const agents = discoverAgents("/nonexistent");
    // Custom agents are defined inline or persisted as Markdown files. There
    // are no built-in defaults.
    expect(agents.size).toBe(0);
  });

  test("ignores a persisted profile named default because the built-in is reserved", () => {
    writeAgent(
      path.join(tmpDir, ".pi", "agent", "agents"),
      "default.md",
      `---
name: default
description: Must not shadow the built-in
---
Custom prompt.
`,
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      const agents = discoverAgents("/nonexistent");
      expect(agents.has("default")).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("name is reserved");
  });

  test("skips .chain.md files", () => {
    writeAgent(
      path.join(tmpDir, ".pi", "agent", "agents"),
      "chain.chain.md",
      `---
name: chain
description: Chain agent
---
Prompt.
`,
    );
    const agents = discoverAgents("/nonexistent");
    expect(agents.has("chain")).toBe(false);
  });

  test("skips non-markdown files", () => {
    const dir = path.join(tmpDir, ".pi", "agent", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "readme.txt"),
      `---
name: txt
description: TXT
---
Prompt.
`,
    );
    const agents = discoverAgents("/nonexistent");
    expect(agents.has("txt")).toBe(false);
  });

  test("returns empty map when no user agents found", () => {
    const agents = discoverAgents(tmpDir);
    expect(agents.size).toBe(0);
  });

  // ── Project Markdown discovery ─────────────────────────────────────────

  test("discovers a user Markdown custom agent by name", () => {
    const projectDir = path.join(tmpDir, "project");
    writeAgent(
      path.join(projectDir, ".pi", "agents"),
      "scout.md",
      `---
name: scout
description: My custom scout
tools: read
---
Custom scout body.
`,
    );
    const agents = discoverAgents(projectDir);
    const scout = agents.get("scout")!;
    expect(scout.description).toBe("My custom scout");
    expect(scout.systemPrompt).toBe("Custom scout body.");
    expect(scout.scope).toBe("project");
  });

  // ── Claude Code interchange ────────────────────────────────────────────

  test("discovers agents from project .claude/agents/", () => {
    const projectDir = path.join(tmpDir, "project");
    writeAgent(
      path.join(projectDir, ".claude", "agents"),
      "claudey.md",
      `---
name: claudey
description: Imported from Claude Code
tools: Read, Bash, Glob
---
Claude body.
`,
    );
    const agents = discoverAgents(projectDir);
    const c = agents.get("claudey")!;
    expect(c).toBeDefined();
    expect(c.scope).toBe("claude");
    // Capitalized names are normalized: Read→read, Bash→bash, Glob→find.
    expect(c.tools.sort()).toEqual(["bash", "find", "read"]);
  });

  test("claude tool names are mapped and unmappable tools are dropped", () => {
    const fp = path.join(tmpDir, "claude-only.md");
    writeFileSync(
      fp,
      `---
name: claude-only
description: Mixed mappable + unmappable tools
tools: Read, WebSearch, WebFetch, TodoWrite
---
Body.
`,
    );
    const c = loadClaudeAgentFile(fp)!;
    // Only Read maps; the rest (WebSearch/WebFetch/TodoWrite) are dropped.
    expect(c.tools).toEqual(["read"]);
  });

  test("claude agent with only unmappable tools gets no tools and warns", () => {
    const fp = path.join(tmpDir, "web-only.md");
    writeFileSync(
      fp,
      `---
name: web-only
description: Only web tools, nothing maps
tools: WebSearch, WebFetch
---
Body.
`,
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      const c = loadClaudeAgentFile(fp)!;
      // Nothing mappable → an explicit allowlist that maps to nothing means the
      // agent gets no tools, plus a warning to the author.
      expect(c.tools).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("no mappable tools");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("native pi agents take precedence over same-named .claude/agents", () => {
    const projectDir = path.join(tmpDir, "project");
    writeAgent(
      path.join(projectDir, ".pi", "agents"),
      "shared.md",
      `---
name: shared
description: Pi wins
---
Pi body.
`,
    );
    writeAgent(
      path.join(projectDir, ".claude", "agents"),
      "shared.md",
      `---
name: shared
description: Claude loses
tools: Read
---
Claude body.
`,
    );
    const agents = discoverAgents(projectDir);
    expect(agents.get("shared")!.description).toBe("Pi wins");
    expect(agents.get("shared")!.scope).toBe("project");
  });

  // ── Claude model: inherit + disallowedTools ────────────────────────────

  test("claude model:inherit is stripped so the agent inherits the parent model", () => {
    const fp = path.join(tmpDir, "inherit.md");
    writeFileSync(
      fp,
      `---
name: inherit
description: Uses Claude's default model
tools: Read
model: inherit
---
Body.
`,
    );
    const c = loadClaudeAgentFile(fp)!;
    // `inherit` is Claude's "use parent" sentinel. If passed through verbatim,
    // resolveModel("inherit") throws. Must be stripped → undefined.
    expect(c.model).toBeUndefined();
  });

  test("claude model:INHERIT is case-insensitive", () => {
    const fp = path.join(tmpDir, "inherit-upper.md");
    writeFileSync(
      fp,
      `---
name: inherit-upper
description: Uppercase inherit
tools: Read
model: INHERIT
---
Body.
`,
    );
    expect(loadClaudeAgentFile(fp)!.model).toBeUndefined();
  });

  test("claude disallowedTools removes tools from the inherited set (security)", () => {
    // The dangerous case: a reviewer that denies Write/Edit but specifies no
    // `tools` (intending read-only). Without denylist handling it would import
    // as full-tools inherit-*. The denylist must subtract from the base set.
    const fp = path.join(tmpDir, "deny-only.md");
    writeFileSync(
      fp,
      `---
name: deny-only
description: Read-only via denylist
disallowedTools: Write, Edit
---
Body.
`,
    );
    const c = loadClaudeAgentFile(fp)!;
    // DEFAULT_TOOLS (read,write,edit,bash) minus {write,edit} = read, bash.
    expect(c.tools.sort()).toEqual(["bash", "read"]);
  });

  test("claude disallowedTools layers on top of an explicit allowlist", () => {
    const fp = path.join(tmpDir, "allow-plus-deny.md");
    writeFileSync(
      fp,
      `---
name: allow-plus-deny
description: Allowlist with denylist
tools: Read, Write, Bash
disallowedTools: Write, Edit
---
Body.
`,
    );
    const c = loadClaudeAgentFile(fp)!;
    // Allow {read,write,bash} minus deny {write,edit} = read, bash.
    expect(c.tools.sort()).toEqual(["bash", "read"]);
  });

  test("claude disallowedTools with only unmappable names is a no-op", () => {
    const fp = path.join(tmpDir, "deny-unmappable.md");
    writeFileSync(
      fp,
      `---
name: deny-unmappable
description: Denylist references non-delegate tools
tools: Read
disallowedTools: WebSearch, NotebookEdit
---
Body.
`,
    );
    const c = loadClaudeAgentFile(fp)!;
    // None of the denied names map → denylist is empty → allowlist untouched.
    expect(c.tools).toEqual(["read"]);
  });
});

// ── buildParentTranscript ─────────────────────────────────────────────────

describe("buildParentTranscript", () => {
  test("returns null on empty entries", () => {
    expect(buildParentTranscript([], null)).toBeNull();
  });

  test("formats user and assistant messages", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi there" }],
        },
      },
    ] as any[];
    const result = buildParentTranscript(entries, undefined);
    expect(result).toContain("**User:** Hello");
    expect(result).toContain("**Assistant:** Hi there");
  });

  test("filters out non-text content blocks", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "image", source: "data:image/png;base64,abc" },
            { type: "text", text: "Describe this image" },
          ],
        },
      },
    ] as any[];
    const result = buildParentTranscript(entries, undefined);
    expect(result).toBe("**User:** Describe this image");
  });

  test("returns null when buildSessionContext throws", () => {
    // Invalid entries should cause buildSessionContext to throw
    const result = buildParentTranscript(null as any, null);
    expect(result).toBeNull();
  });
});

// ── extractTextContent ────────────────────────────────────────────────────

describe("extractTextContent", () => {
  test("returns string content as-is", () => {
    expect(extractTextContent("hello")).toBe("hello");
  });

  test("extracts text blocks from array", () => {
    expect(
      extractTextContent([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ).toBe("helloworld");
  });

  test("skips non-text blocks", () => {
    expect(
      extractTextContent([
        { type: "image", source: "base64" },
        { type: "text", text: "only text" },
      ]),
    ).toBe("only text");
  });

  test("skips text blocks without string text", () => {
    expect(
      extractTextContent([
        { type: "text" },
        { type: "text", text: "valid" },
        { type: "text", text: 123 as any },
      ]),
    ).toBe("valid");
  });

  test("returns empty string for non-array non-string", () => {
    expect(extractTextContent(123 as any)).toBe("");
    expect(extractTextContent(null as any)).toBe("");
  });
});

// ── resolveModel ──────────────────────────────────────────────────────────

describe("resolveModel", () => {
  const parentModel = { provider: "anthropic", id: "claude-sonnet-4" } as any;

  function makeRegistry(models: Array<{ provider: string; id: string }>) {
    return {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((m) => m.provider === provider && m.id === id) ?? null,
    } as any;
  }

  test("returns parent model when spec is undefined", () => {
    expect(resolveModel(undefined, makeRegistry([]), parentModel)).toBe(
      parentModel,
    );
  });

  test("finds bare id in available models", () => {
    const registry = makeRegistry([
      { provider: "openai", id: "gpt-5" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
    ]);
    const result = resolveModel("gpt-5", registry, parentModel);
    expect(result).toEqual({ provider: "openai", id: "gpt-5" });
  });

  test("finds provider/id spec", () => {
    const registry = makeRegistry([{ provider: "openai", id: "gpt-5" }]);
    const result = resolveModel("openai/gpt-5", registry, parentModel);
    expect(result).toEqual({ provider: "openai", id: "gpt-5" });
  });

  test("returns undefined when bare id not found", () => {
    const registry = makeRegistry([{ provider: "openai", id: "gpt-5" }]);
    expect(resolveModel("nonexistent", registry, parentModel)).toBeUndefined();
  });

  test("returns undefined when provider/id not found", () => {
    const registry = makeRegistry([{ provider: "openai", id: "gpt-5" }]);
    expect(
      resolveModel("anthropic/claude-sonnet-4", registry, parentModel),
    ).toBeUndefined();
  });

  test("handles spec with multiple slashes gracefully", () => {
    const registry = makeRegistry([
      { provider: "openrouter", id: "qwen/qwen3-coder" },
    ]);
    const result = resolveModel(
      "openrouter/qwen/qwen3-coder",
      registry,
      parentModel,
    );
    expect(result).toEqual({ provider: "openrouter", id: "qwen/qwen3-coder" });
  });

  test("tolerates a Pi-style thinking suffix for resolution only", () => {
    const registry = makeRegistry([
      { provider: "openai-codex", id: "gpt-5.6-luna" },
    ]);
    const result = resolveModelRequest(
      "openai-codex/gpt-5.6-luna:max",
      registry,
      parentModel,
    );

    // The suffix lets the reference resolve; it is reported (not honored here)
    // so the caller can use it as a last-resort thinking default.
    expect(result.model).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6-luna",
    });
    expect(result.strippedSuffix).toBe("max");
    expect("thinking" in result).toBe(false);
  });

  test("prefers an exact model ID containing a colon", () => {
    const colonModel = { provider: "openrouter", id: "model:exacto" };
    const registry = makeRegistry([colonModel]);

    expect(
      resolveModelRequest("openrouter/model:exacto", registry, parentModel),
    ).toEqual({ model: colonModel });
  });

  test("built-in default mirrors the live parent and bypasses delegate model defaults", () => {
    const parent = {
      provider: "openrouter",
      id: "muse-spark-1.2-contributor",
    } as any;
    _setDelegateConfigForTesting({
      agent: { default: "openai/should-not-be-used" },
    });

    try {
      const [task] = resolveTasks(
        [{ prompt: "instrument file operations", agent: "default" }] as any,
        {
          cwd: process.cwd(),
          model: parent,
          modelRegistry: {
            hasConfiguredAuth: () => true,
            getAvailable: () => [],
          },
          sessionManager: undefined,
          getSystemPrompt: () => "live parent base prompt",
        } as any,
        new Map(),
        {
          thinking: "high",
          tools: ["read", "grep", "delegate", "extension-tool"],
        },
      );

      expect(task!.agentName).toBe("default");
      expect(task!.model).toBe(parent);
      expect(task!.thinking).toBe("high");
      expect(task!.tools).toEqual(["read", "grep"]);
      expect(task!.systemPrompt).toBe("live parent base prompt");
    } finally {
      _resetDelegateConfigForTesting();
    }
  });

  test("built-in default is valid without custom agent profiles", () => {
    expect(
      validateTasks(
        [{ prompt: "inspect", agent: "default" }] as any,
        new Map(),
        "parent-model",
      ),
    ).toBeNull();
  });

  test("resolveTasks honors a model suffix as the thinking fallback", () => {
    const selectedModel = {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
    } as any;
    const registry = makeRegistry([selectedModel]);
    const [task] = resolveTasks(
      [
        {
          prompt: "audit the project",
          model: "openai-codex/gpt-5.6-luna:max",
        },
      ] as any,
      {
        cwd: process.cwd(),
        model: parentModel,
        modelRegistry: registry,
        sessionManager: undefined,
        getSystemPrompt: () => "parent prompt",
      } as any,
      new Map(),
      { thinking: "off", tools: DEFAULT_TOOLS },
    );

    expect(task!.model).toBe(selectedModel);
    // No `thinking` field set, so the `:max` suffix is honored as the
    // last-resort default — intent preserved, no warning.
    expect(task!.thinking).toBe("max");
    expect(task!.warnings).toHaveLength(0);
  });

  test("resolveTasks resolves a relative task cwd from the parent cwd", () => {
    const [task] = resolveTasks(
      [{ prompt: "inspect", cwd: "../web" }] as any,
      {
        cwd: "/repo/apps/api",
        model: parentModel,
        modelRegistry: {
          hasConfiguredAuth: () => true,
          getAvailable: () => [],
        },
        sessionManager: undefined,
      } as any,
      new Map(),
      { thinking: "off", tools: DEFAULT_TOOLS },
    );

    expect(task!.cwd).toBe("/repo/apps/web");
  });

  test("resolveTasks warns when a model suffix is overridden by the thinking field", () => {
    const selectedModel = {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
    } as any;
    const registry = makeRegistry([selectedModel]);
    const [task] = resolveTasks(
      [
        {
          prompt: "audit the project",
          model: "openai-codex/gpt-5.6-luna:max",
          thinking: "high",
        },
      ] as any,
      {
        cwd: process.cwd(),
        model: parentModel,
        modelRegistry: registry,
        sessionManager: undefined,
        getSystemPrompt: () => "parent prompt",
      } as any,
      new Map(),
      { thinking: "off", tools: DEFAULT_TOOLS },
    );

    // The explicit field wins; the suffix had no effect → warn (not silently).
    expect(task!.thinking).toBe("high");
    expect(task!.warnings).toHaveLength(1);
    expect(task!.warnings[0]).toContain(":max");
    expect(task!.warnings[0]).toContain("resolved to 'high'");
  });
});

describe("findAvailableAlternative", () => {
  const brokenModel = { provider: "deepseek", id: "deepseek-v4-pro" } as any;
  const workingAlt = { provider: "opencode-go", id: "deepseek-v4-pro" } as any;

  function makeRegistry(available: any[], authMap: Map<string, boolean>) {
    return {
      hasConfiguredAuth: (m: any) =>
        authMap.get(`${m.provider}/${m.id}`) ?? false,
      getAvailable: () => available,
    } as any;
  }

  test("returns undefined when model is undefined", () => {
    const registry = makeRegistry([], new Map());
    expect(findAvailableAlternative(undefined, registry)).toBeUndefined();
  });

  test("returns model as-is when it has configured auth", () => {
    const authMap = new Map([["deepseek/deepseek-v4-pro", true]]);
    const registry = makeRegistry([brokenModel], authMap);
    expect(findAvailableAlternative(brokenModel, registry)).toBe(brokenModel);
  });

  test("returns alternative with same id but different provider when original has no auth", () => {
    const authMap = new Map([
      ["deepseek/deepseek-v4-pro", false],
      ["opencode-go/deepseek-v4-pro", true],
    ]);
    const registry = makeRegistry([brokenModel, workingAlt], authMap);
    expect(findAvailableAlternative(brokenModel, registry)).toBe(workingAlt);
  });

  test("returns undefined when no alternative is available", () => {
    const authMap = new Map([["deepseek/deepseek-v4-pro", false]]);
    const registry = makeRegistry([brokenModel], authMap);
    expect(findAvailableAlternative(brokenModel, registry)).toBeUndefined();
  });
});

// ── resolveModelSpec (precedence chain) ───────────────────────────────────

describe("resolveModelSpec", () => {
  const baseConfig: DelegateConfig = {
    agent: { default: "config-default", coder: "config-coder" },
    concurrency: { default: 3 },
  };

  test("task model takes highest precedence", () => {
    const result = resolveModelSpec({
      taskModel: "task-model",
      agentType: "coder",
      frontmatterModel: "frontmatter",
      config: baseConfig,
    });
    expect(result).toBe("task-model");
  });

  test("config per-type is second precedence", () => {
    const result = resolveModelSpec({
      agentType: "coder",
      frontmatterModel: "frontmatter",
      config: baseConfig,
    });
    expect(result).toBe("config-coder");
  });

  test("config default is third precedence", () => {
    const result = resolveModelSpec({
      agentType: "unknown-type",
      frontmatterModel: "frontmatter",
      config: baseConfig,
    });
    expect(result).toBe("config-default");
  });

  test("frontmatter model is fourth precedence", () => {
    const result = resolveModelSpec({
      agentType: "unknown-type",
      frontmatterModel: "frontmatter",
      config: { agent: { default: null }, concurrency: { default: 3 } },
    });
    expect(result).toBe("frontmatter");
  });

  test("no explicit spec returns undefined — parent inheritance is the caller's job", () => {
    // resolveModelSpec no longer has a parent tier: when nothing explicit
    // is set it returns undefined, and the caller uses ctx.model directly.
    // This prevents re-resolving a composite parent id (e.g. OpenRouter's
    // "deepseek/deepseek-v4-flash") through the registry, which would
    // misroute auth to the upstream provider name.
    const result = resolveModelSpec({
      agentType: "unknown-type",
      config: { agent: { default: null }, concurrency: { default: 3 } },
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when all sources empty", () => {
    const result = resolveModelSpec({
      agentType: "unknown-type",
      config: { agent: { default: null }, concurrency: { default: 3 } },
    });
    expect(result).toBeUndefined();
  });

  test("skips empty string overrides — falls through to undefined", () => {
    const result = resolveModelSpec({
      agentType: "coder",
      config: {
        agent: { default: "", coder: "" },
        concurrency: { default: 3 },
      },
    });
    expect(result).toBeUndefined();
  });
});

// ── getConcurrencyLimit ──────────────────────────────────────────────────
// No config mutators ship (delegate.json is the only write path), so these
// tests inject config objects directly to exercise the precedence chain.

describe("getStallTimeoutMs", () => {
  const config = (stallTimeoutMs: unknown): DelegateConfig =>
    ({
      agent: { default: null },
      concurrency: { default: 1 },
      stallTimeoutMs,
    }) as DelegateConfig;

  test("uses a configured finite non-negative value, including zero", () => {
    expect(getStallTimeoutMs(config(1234))).toBe(1234);
    expect(getStallTimeoutMs(config(0))).toBe(0);
  });

  test("falls back safely for malformed values", () => {
    expect(getStallTimeoutMs(config(-1))).toBe(15 * 60 * 1000);
    expect(getStallTimeoutMs(config(Infinity))).toBe(15 * 60 * 1000);
    expect(getStallTimeoutMs(config("nope"))).toBe(15 * 60 * 1000);
  });
});

describe("getConcurrencyLimit", () => {
  test("returns default when no per-model or per-provider config", () => {
    const config: DelegateConfig = {
      agent: { default: null },
      concurrency: { default: 3 },
    };
    expect(getConcurrencyLimit("anthropic/claude-sonnet-4", config)).toBe(3);
  });

  test("per-model limit takes precedence", () => {
    const config: DelegateConfig = {
      agent: { default: null },
      concurrency: { default: 3, models: { "llamacpp/4b": 1 } },
    };
    expect(getConcurrencyLimit("llamacpp/4b", config)).toBe(1);
    // Other models still get default
    expect(getConcurrencyLimit("anthropic/claude-sonnet-4", config)).toBe(3);
  });

  test("per-provider limit is second precedence", () => {
    const config: DelegateConfig = {
      agent: { default: null },
      concurrency: { default: 3, providers: { llamacpp: 2 } },
    };
    expect(getConcurrencyLimit("llamacpp/4b", config)).toBe(2);
    expect(getConcurrencyLimit("llamacpp/7b", config)).toBe(2);
    // Other providers still get default
    expect(getConcurrencyLimit("anthropic/claude-sonnet-4", config)).toBe(3);
  });

  test("per-model overrides per-provider", () => {
    const config: DelegateConfig = {
      agent: { default: null },
      concurrency: {
        default: 3,
        providers: { llamacpp: 2 },
        models: { "llamacpp/4b": 4 },
      },
    };
    expect(getConcurrencyLimit("llamacpp/4b", config)).toBe(4);
    // Sibling model under same provider falls through to per-provider
    expect(getConcurrencyLimit("llamacpp/7b", config)).toBe(2);
  });
});

// ── extractOutput ─────────────────────────────────────────────────────────

describe("extractOutput", () => {
  test("extracts text from assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    ] as any;
    expect(extractOutput(messages)).toBe("hello\n\nworld");
  });

  test("ignores non-assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: [{ type: "text", text: "sys" }] },
    ] as any;
    expect(extractOutput(messages)).toBe("");
  });

  test("ignores non-text blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "bash" },
          { type: "text", text: "result" },
        ],
      },
    ] as any;
    expect(extractOutput(messages)).toBe("result");
  });

  test("handles string content", () => {
    const messages = [{ role: "assistant", content: "plain string" }] as any;
    expect(extractOutput(messages)).toBe("");
  });
});

// ── extractUsage ──────────────────────────────────────────────────────────

describe("extractUsage", () => {
  test("sums usage across assistant messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: { input: 10, output: 5, total: 15 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "world" }],
        usage: { input: 8, output: 4, total: 12 },
      },
    ] as any;
    expect(extractUsage(messages)).toEqual({
      input: 18,
      output: 9,
      cacheRead: 0,
      total: 27,
    });
  });

  test("falls back to input+output when total missing", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input: 3, output: 2 },
      },
    ] as any;
    expect(extractUsage(messages)).toEqual({
      input: 3,
      output: 2,
      cacheRead: 0,
      total: 5,
    });
  });

  test("includes cacheRead when present", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input: 10, output: 5, cacheRead: 20, total: 35 },
      },
    ] as any;
    expect(extractUsage(messages)).toEqual({
      input: 10,
      output: 5,
      cacheRead: 20,
      total: 35,
    });
  });

  test("returns zeros for no messages", () => {
    expect(extractUsage([])).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      total: 0,
    });
  });

  test("ignores messages without usage", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ] as any;
    expect(extractUsage(messages)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      total: 0,
    });
  });

  test("rejects NaN usage values", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input: NaN, output: 2 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input: 5, output: 3 },
      },
    ] as any;
    expect(extractUsage(messages)).toEqual({
      input: 5,
      output: 3,
      cacheRead: 0,
      total: 8,
    });
  });

  test("rejects infinite usage values", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input: Infinity, output: 2 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input: 1, output: 1 },
      },
    ] as any;
    expect(extractUsage(messages)).toEqual({
      input: 1,
      output: 1,
      cacheRead: 0,
      total: 2,
    });
  });
});

// ── Formatting utilities ──────────────────────────────────────────────────

describe("fmtDuration", () => {
  test("formats milliseconds", () => {
    expect(fmtDuration(500)).toBe("500ms");
    expect(fmtDuration(999)).toBe("999ms");
  });

  test("formats seconds", () => {
    expect(fmtDuration(1000)).toBe("1.0s");
    expect(fmtDuration(5500)).toBe("5.5s");
    expect(fmtDuration(59999)).toBe("60.0s");
  });

  test("formats minutes and seconds", () => {
    expect(fmtDuration(60000)).toBe("1m0s");
    expect(fmtDuration(125000)).toBe("2m5s");
    expect(fmtDuration(3600000)).toBe("60m0s");
  });
});

describe("fmtTokens", () => {
  test("returns raw number under 1000", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  test("formats with one decimal between 1k and 10k", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(5500)).toBe("5.5k");
    expect(fmtTokens(9999)).toBe("10.0k");
  });

  test("rounds above 10k", () => {
    expect(fmtTokens(10000)).toBe("10k");
    expect(fmtTokens(15500)).toBe("16k");
  });
});

describe("truncLine", () => {
  test("returns short text unchanged", () => {
    expect(truncLine("hello", 10)).toBe("hello");
  });

  test("truncates ASCII text", () => {
    expect(truncLine("hello world", 8)).toBe("hello w…");
  });

  test("preserves ANSI codes and applies them to ellipsis", () => {
    const red = "\x1b[31mhello world\x1b[0m";
    const result = truncLine(red, 8);
    expect(result).toContain("\x1b[31m");
    expect(result).toContain("…");
    // The reset code is dropped when truncating; active style is re-applied to ellipsis
    // Visible width should not exceed 8
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped.length).toBeLessThanOrEqual(8);
  });

  test("counts CJK characters as width 2", () => {
    const text = "你好世界"; // 4 CJK chars = width 8
    expect(truncLine(text, 8)).toBe("你好世界");
    expect(truncLine(text, 7)).toBe("你好世…");
    expect(truncLine(text, 5)).toBe("你好…");
  });

  test("counts emoji as width 2", () => {
    const text = "😀🎉👍"; // 3 emoji = width 6
    expect(truncLine(text, 6)).toBe("😀🎉👍");
    expect(truncLine(text, 5)).toBe("😀🎉…");
  });

  test("handles mixed ASCII, CJK, and emoji", () => {
    const text = "a你好😀b"; // 1 + 4 + 2 + 1 = width 8
    expect(truncLine(text, 8)).toBe("a你好😀b");
    // "a你好😀…" would be width 8, exceeding maxWidth=7
    expect(truncLine(text, 7)).toBe("a你好…");
  });

  test("handles combining characters as one unit", () => {
    const text = "café"; // e + combining acute = one grapheme
    expect(truncLine(text, 4)).toBe("café");
    expect(truncLine(text, 3)).toBe("ca…");
  });

  test("returns empty string for maxWidth <= 0", () => {
    expect(truncLine("hello", 0)).toBe("");
    expect(truncLine("hello", -1)).toBe("");
  });

  test("handles flag emoji (surrogate pairs + ZWJ)", () => {
    const text = "🇺🇸🇬🇧"; // 2 flag emoji = width 4
    expect(truncLine(text, 4)).toBe("🇺🇸🇬🇧");
    expect(truncLine(text, 3)).toBe("🇺🇸…");
  });

  test("handles ANSI + CJK mix", () => {
    const red = "\x1b[31m你好世界\x1b[0m";
    const result = truncLine(red, 5);
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped.length).toBeLessThanOrEqual(5);
    expect(stripped).toContain("…");
  });

  test("handles ZWJ emoji sequences (family and skin tone)", () => {
    const family = "👨‍👩‍👧‍👦"; // single ZWJ family grapheme, width 2
    expect(truncLine(family, 2)).toBe(family);
    expect(truncLine(family, 1)).toBe("…");

    const thumbs = "👍🏻"; // base emoji + skin-tone modifier, width 2
    expect(truncLine(thumbs, 2)).toBe(thumbs);
    expect(truncLine(thumbs, 1)).toBe("…");
  });

  test("handles variation selectors as a single grapheme", () => {
    const heart = "❤️"; // U+2764 + U+FE0F variation selector
    expect(truncLine(heart, 1)).toBe(heart);
    expect(truncLine(heart, 0)).toBe("");
  });

  test("handles ANSI reset and active-style edge cases", () => {
    // Active styles are re-applied to the ellipsis and then closed.
    const red = "\x1b[31mhello\x1b[0m";
    const redResult = truncLine(red, 2);
    expect(redResult).toContain("\x1b[31m");
    expect(redResult).toContain("…");
    expect(redResult.endsWith("\x1b[0m")).toBe(true);
    const redStripped = redResult.replace(/\x1b\[[0-9;]*m/g, "");
    expect(redStripped).toBe("h…");

    // Multiple active styles accumulate and are re-applied.
    const multi = "\x1b[31m\x1b[1mbold red\x1b[0m";
    const multiResult = truncLine(multi, 5);
    expect(multiResult).toContain("\x1b[31m");
    expect(multiResult).toContain("\x1b[1m");
    expect(multiResult.endsWith("\x1b[0m")).toBe(true);
    const multiStripped = multiResult.replace(/\x1b\[[0-9;]*m/g, "");
    expect(multiStripped).toBe("bold…");

    // A reset before the truncation point clears active styles.
    const cleared = "\x1b[31mred\x1b[0mgreen";
    const clearedResult = truncLine(cleared, 6);
    const clearedStripped = clearedResult.replace(/\x1b\[[0-9;]*m/g, "");
    expect(clearedStripped).toBe("redgr…");
    expect(clearedResult.indexOf("\x1b[0m")).toBeLessThan(
      clearedResult.indexOf("…"),
    );
  });

  test("handles width boundaries correctly", () => {
    expect(truncLine("hello", 1)).toBe("…");
    expect(truncLine("hello", 2)).toBe("h…");
    expect(truncLine("h", 2)).toBe("h");
    expect(truncLine("", 1)).toBe("");
    expect(truncLine("你", 1)).toBe("…");
    expect(truncLine("你", 2)).toBe("你");
  });
});

describe("trunc", () => {
  test("returns short strings unchanged", () => {
    expect(trunc("hello", 10)).toBe("hello");
  });

  test("truncates long strings with ellipsis", () => {
    expect(trunc("hello world", 8)).toBe("hello w…");
  });

  test("handles exact length", () => {
    expect(trunc("hello", 5)).toBe("hello");
  });
});

describe("tree", () => {
  test("returns ├─ for non-last items", () => {
    expect(tree(0, 3)).toBe("├─");
    expect(tree(1, 3)).toBe("├─");
  });

  test("returns └─ for last item", () => {
    expect(tree(2, 3)).toBe("└─");
    expect(tree(0, 1)).toBe("└─");
  });
});

describe("indent", () => {
  test("returns │   for non-last items", () => {
    expect(indent(0, 3)).toBe("│  ");
  });

  test("returns three spaces for last item", () => {
    expect(indent(2, 3)).toBe("   ");
  });
});

// ── shortenPath ──────────────────────────────────────────────────────────

describe("shortenPath", () => {
  test("replaces HOME with ~", () => {
    const home = process.env.HOME;
    if (home && home !== "/") {
      expect(shortenPath(home)).toBe("~");
      expect(shortenPath(home + "/projects/my-app")).toBe("~/projects/my-app");
    }
  });

  test("does not match overlapping home prefixes", () => {
    const home = process.env.HOME;
    if (home && home !== "/") {
      // /home/alice should not match /home/alice2/file
      expect(shortenPath(home + "2/file")).toBe(home + "2/file");
    }
  });

  test("handles trailing slash in HOME", () => {
    const homeRaw = process.env.HOME;
    if (homeRaw && homeRaw !== "/") {
      const homeWithSlash = homeRaw.endsWith("/") ? homeRaw : homeRaw + "/";
      // shortenPath reads from process.env.HOME, not the argument,
      // so we test that HOME with or without trailing slash works
      expect(shortenPath(homeRaw + "/project")).toContain("~/project");
    }
  });

  test("returns non-home paths unchanged", () => {
    expect(shortenPath("/usr/local/bin")).toBe("/usr/local/bin");
    expect(shortenPath("/tmp/stuff")).toBe("/tmp/stuff");
  });
});

// ── formatFailedTask ────────────────────────────────────────────────────
// Single source of truth for the [FAILED: …] + retry-hint rendering used by
// both the sync (execute) and async (formatCompletedTicket) paths. Previously
// duplicated, the two copies had drifted into reporting a sessionFile that
// didn't exist on disk. These tests pin the deduped behavior.

describe("formatFailedTask", () => {
  type ResultLike = Parameters<typeof formatFailedTask>[0];

  test("emits retry hint only when sessionFile has restorable messages", () => {
    // A header-only .jsonl (produced when the first model call dies before any
    // assistant message and the failure path force-flushed the header) is real
    // on disk but rejected by resumeFrom as "empty session". It must NOT
    // advertise a retry hint — the parent would chase a dead resume.
    const dir = mkdtempSync(path.join(tmpdir(), "delegate-fmt-"));
    const headerOnly = path.join(dir, "2026-01-01T00-00-00Z_hdr.jsonl");
    const withMessages = path.join(dir, "2026-01-01T00-00-00Z_msg.jsonl");
    try {
      writeFileSync(headerOnly, '{"type":"session"}\n');
      writeFileSync(
        withMessages,
        [
          JSON.stringify({ type: "session", id: "s1", version: 3 }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            message: {
              role: "user",
              content: [{ type: "text", text: "hi" }],
              timestamp: 0,
            },
          }),
        ].join("\n") + "\n",
      );

      const base: Omit<ResultLike, "sessionFile"> = {
        agent: "scout",
        output: "",
        error: "524 cloudflare timeout",
        durationMs: 1000,
        tokens: 0,
        touchedFiles: [],
      };

      // Header-only → no retry hint, explicit re-dispatch notice.
      const headerLines = formatFailedTask({
        ...base,
        sessionFile: headerOnly,
      });
      expect(headerLines[0]).toBe(
        `[FAILED: 524 cloudflare timeout · session: ${shortenPath(headerOnly)}]`,
      );
      expect(headerLines[1]).toBe(
        "[no resumable session — re-dispatch as a fresh task]",
      );
      expect(headerLines.some((l) => l.includes("resumeFrom"))).toBe(false);

      // File with messages → retry hint with JSON-stringified path.
      const msgLines = formatFailedTask({
        ...base,
        sessionFile: withMessages,
      });
      expect(msgLines[0]).toBe(
        `[FAILED: 524 cloudflare timeout · session: ${shortenPath(withMessages)}]`,
      );
      expect(msgLines[1]).toContain("→ To retry: delegate(");
      expect(msgLines[1]).toContain(JSON.stringify(withMessages));
      expect(msgLines[1]).toContain("resumeFrom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("emits explicit notice when sessionFile is set but absent — no fabricated resume", () => {
    // The bug: a nonexistent path was printed in [FAILED:] but no guidance was
    // given, leaving the parent to fabricate a resumeFrom. Now we say so plainly.
    const r: ResultLike = {
      agent: "scout",
      output: "",
      error: "524 cloudflare timeout",
      durationMs: 1000,
      tokens: 0,
      sessionFile: "/nonexistent/path/ghost.jsonl",
      touchedFiles: [],
    };
    const lines = formatFailedTask(r);
    expect(lines[0]).toContain("[FAILED: 524 cloudflare timeout · session:");
    expect(lines[0]).toContain("ghost.jsonl");
    expect(lines[1]).toBe(
      "[no resumable session — re-dispatch as a fresh task]",
    );
    // Must NOT emit a resume hint pointing at a nonexistent file.
    expect(lines.some((l) => l.includes("resumeFrom"))).toBe(false);
  });

  test("emits FAILED line only when no sessionFile", () => {
    const r: ResultLike = {
      agent: "scout",
      output: "",
      error: "sessionAction='close' requires sessionId.",
      durationMs: 0,
      tokens: 0,
      touchedFiles: [],
    };
    expect(formatFailedTask(r)).toEqual([
      "[FAILED: sessionAction='close' requires sessionId.]",
    ]);
  });

  test("falls back to 'unknown error' when error is empty", () => {
    const r: ResultLike = {
      agent: "scout",
      output: "",
      error: "",
      durationMs: 0,
      tokens: 0,
      touchedFiles: [],
    };
    expect(formatFailedTask(r)).toEqual(["[FAILED: unknown error]"]);
  });

  test("labels aborts as ABORTED and surfaces touched files + partial output", () => {
    const r: ResultLike = {
      agent: "scout",
      output: "partial output here",
      error: "Aborted",
      durationMs: 1000,
      tokens: 42,
      touchedFiles: ["/home/daniel/build/pi-delegate/src/foo.ts"],
    };
    const lines = formatFailedTask(r, "/home/daniel/build/pi-delegate");
    expect(lines[0]).toContain("[ABORTED: Aborted");
    expect(lines[0]).toContain("touched (best-effort): src/foo.ts");
    expect(lines.some((l) => l.includes("partial output here"))).toBe(true);
  });

  test("model_error failure → hint names the model field for resume-on-different-model", () => {
    // A model-attributable failure (usage limit, auth, quota) must point the
    // parent at the `model` field so it resumes the same conversation on a
    // different model — not the generic same-model retry hint.
    const dir = mkdtempSync(path.join(tmpdir(), "delegate-fmt-"));
    const withMessages = path.join(dir, "2026-01-01T00-00-00Z_msg.jsonl");
    try {
      writeFileSync(
        withMessages,
        [
          JSON.stringify({ type: "session", id: "s1", version: 3 }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            message: {
              role: "user",
              content: [{ type: "text", text: "hi" }],
              timestamp: 0,
            },
          }),
        ].join("\n") + "\n",
      );

      const r: ResultLike = {
        agent: "scout",
        output: "",
        error:
          '429 "you have reached your session usage limit, upgrade for higher limits"',
        failureKind: "model_error",
        durationMs: 1000,
        tokens: 0,
        sessionFile: withMessages,
        touchedFiles: [],
      };
      const lines = formatFailedTask(r);
      const hint = lines.find((l) => l.includes("→ To retry"));
      expect(hint).toBeDefined();
      expect(hint).toContain("To retry with a different model");
      expect(hint).toContain("model:");
      expect(hint).toContain(JSON.stringify(withMessages));
      expect(hint).toContain("resumeFrom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-model_error failure → generic retry hint (no model field)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "delegate-fmt-"));
    const withMessages = path.join(dir, "2026-01-01T00-00-00Z_msg.jsonl");
    try {
      writeFileSync(
        withMessages,
        [
          JSON.stringify({ type: "session", id: "s1", version: 3 }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            message: {
              role: "user",
              content: [{ type: "text", text: "hi" }],
              timestamp: 0,
            },
          }),
        ].join("\n") + "\n",
      );

      const r: ResultLike = {
        agent: "scout",
        output: "",
        error: "connection reset",
        durationMs: 1000,
        tokens: 0,
        sessionFile: withMessages,
        touchedFiles: [],
      };
      const lines = formatFailedTask(r);
      const hint = lines.find((l) => l.includes("→ To retry"));
      expect(hint).toBeDefined();
      expect(hint).not.toContain("different model");
      expect(hint).not.toContain("model:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── formatCompletedTask ──────────────────────────────────────────────────

describe("formatCompletedTask", () => {
  type TaskLike = Parameters<typeof formatCompletedTask>[0];
  type ResultLike = Parameters<typeof formatCompletedTask>[1];

  // `model` is the only field formatCompletedTask never reads; cast a stub so
  // tests don't need to construct a full Model<Api>.
  function makeTask(over: Partial<TaskLike> = {}): TaskLike {
    return {
      prompt: "do the thing",
      model: {} as TaskLike["model"],
      tools: [],
      thinking: "low",
      systemPrompt: "",
      cwd: "/home/daniel/build/pi-delegate",
      agentName: "scout",
      warnings: [],
      ...over,
    } as TaskLike;
  }

  function makeResult(over: Partial<ResultLike> = {}): ResultLike {
    return {
      agent: "scout",
      output: "all done",
      durationMs: 1500,
      tokens: 42,
      touchedFiles: [],
      ...over,
    };
  }

  test("renders header + OK metadata + output for a successful task", () => {
    const lines = formatCompletedTask(makeTask(), makeResult());
    expect(lines[0]).toBe("=== scout: do the thing ===");
    expect(lines[1]).toBe(
      `[OK | ${fmtDuration(1500)} | ${fmtTokens(42)} tokens]\n\nall done`,
    );
    expect(lines).toHaveLength(2);
  });

  test("emits a [WARNING:] line per task warning, before the body", () => {
    const lines = formatCompletedTask(
      makeTask({ warnings: ["unknown tool: foo", "model fallback"] }),
      makeResult(),
    );
    expect(lines[0]).toBe("=== scout: do the thing ===");
    expect(lines[1]).toBe("[WARNING: unknown tool: foo]");
    expect(lines[2]).toBe("[WARNING: model fallback]");
    expect(lines[3]).toBe(
      `[OK | ${fmtDuration(1500)} | ${fmtTokens(42)} tokens]\n\nall done`,
    );
  });

  test("includes sessionFile (shortened) and touched files in OK metadata", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "delegate-fct-"));
    try {
      mkdirSync(path.join(cwd, "src"), { recursive: true });
      const touched = path.join(cwd, "src/a.ts");
      const session = path.join(cwd, "2026-01-01T00-00-00Z.jsonl");
      writeFileSync(touched, "");
      writeFileSync(session, '{"type":"session"}\n');

      const lines = formatCompletedTask(
        makeTask({ cwd }),
        makeResult({ sessionFile: session, touchedFiles: [touched] }),
      );
      const ok = lines[lines.length - 1]!;
      // OK metadata includes the shortened session path (no "session:" label —
      // that prefix is reserved for the FAILED line) and touched files.
      expect(ok).toContain(shortenPath(session));
      expect(ok).toContain("touched (best-effort): src/a.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("drops touched files outside the task cwd", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "delegate-fct-"));
    try {
      const inside = path.join(cwd, "inside.ts");
      const outside = path.join(tmpdir(), "delegate-fct-out", "outside.ts");
      writeFileSync(inside, "");

      const lines = formatCompletedTask(
        makeTask({ cwd }),
        makeResult({ touchedFiles: [inside, outside] }),
      );
      const ok = lines[lines.length - 1]!;
      expect(ok).toContain("touched (best-effort): inside.ts");
      expect(ok).not.toContain("outside.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("delegates failure rendering to formatFailedTask", () => {
    const r = makeResult({
      error: "524 cloudflare timeout",
      output: "",
      sessionFile: "/nonexistent/ghost.jsonl",
    });
    const task = makeTask();
    const lines = formatCompletedTask(task, r);
    // Header first, then exactly what formatFailedTask would emit.
    expect(lines[0]).toBe("=== scout: do the thing ===");
    expect(lines.slice(1)).toEqual(formatFailedTask(r, task.cwd));
  });

  test("truncates the prompt in the header to 80 chars", () => {
    const long = "x".repeat(120);
    const lines = formatCompletedTask(makeTask({ prompt: long }), makeResult());
    expect(lines[0]).toBe(`=== scout: ${trunc(long, 80)} ===`);
    expect(lines[0]!.length).toBeLessThan(long.length);
  });

  test("falls back to sessionAction when prompt is empty (action-only tasks)", () => {
    // Sync path uses `t.prompt || t.sessionAction` — action-only tasks (close/list)
    // rely on this fallback. The helper preserves it.
    const lines = formatCompletedTask(
      makeTask({ prompt: "", sessionAction: "close" }),
      makeResult(),
    );
    expect(lines[0]).toBe("=== scout: close ===");
  });

  test("renders #<id> in the header when the task has an id", () => {
    const lines = formatCompletedTask(
      makeTask({ id: "task-1" }),
      makeResult({ id: "task-1" }),
    );
    expect(lines[0]).toBe("=== scout #task-1: do the thing ===");
  });

  test("omits id in the header when the task has no id", () => {
    const lines = formatCompletedTask(makeTask(), makeResult());
    expect(lines[0]).toBe("=== scout: do the thing ===");
  });
});

// ── output spill (integration via formatCompletedTask / formatCompletedTicket) ──
// The spill mechanism (spill.ts) is unit-tested in spill.test.ts. Here we
// verify the wiring: the LLM-facing `content` is bounded (head spilled, tail
// kept) while `details.results[i].output` still carries the FULL output — the
// one-source-two-projections invariant. Production thresholds come from config
// (default 8000/2000), so fixtures exceed them.

describe("output spill integration", () => {
  type TaskLike = Parameters<typeof formatCompletedTask>[0];
  type ResultLike = Parameters<typeof formatCompletedTask>[1];

  function makeTask(over: Partial<TaskLike> = {}): TaskLike {
    return {
      prompt: "do the thing",
      model: {} as TaskLike["model"],
      tools: [],
      thinking: "low",
      systemPrompt: "",
      cwd: "/home/daniel/build/pi-delegate",
      agentName: "scout",
      warnings: [],
      ...over,
    } as TaskLike;
  }
  function makeResult(over: Partial<ResultLike> = {}): ResultLike {
    return {
      agent: "scout",
      output: "all done",
      durationMs: 1500,
      tokens: 42,
      touchedFiles: [],
      ...over,
    } as ResultLike;
  }

  afterEach(() => {
    // Clean spill files dropped in the system tmpdir by production code.
    const dir = os.tmpdir();
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith("delegate-output-")) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  });

  test("formatCompletedTask: over-threshold output → content has tail + pointer, NOT the head", () => {
    const head = "HEADMARKER" + "a".repeat(4000);
    const tail = "b".repeat(4000) + "TAILMARKER"; // total > 8000 default threshold
    const output = head + tail;

    const lines = formatCompletedTask(makeTask(), makeResult({ output }));
    const content = lines.join("\n");

    // Tail kept, head spilled away.
    expect(content).toContain("…");
    expect(content).toContain("TAILMARKER");
    expect(content).not.toContain("HEADMARKER");
    expect(content).toContain("spilled to");
    expect(content).toContain("above is the tail");
    // The pointer names a real file containing the FULL output.
    const m = content.match(/spilled to (.+?) —/);
    expect(m).not.toBeNull();
    expect(fs.existsSync(m![1]!)).toBe(true);
    expect(fs.readFileSync(m![1]!, "utf8")).toBe(output);
  });

  test("formatCompletedTask: under-threshold output is unchanged (no spill)", () => {
    const output = "small result, well under threshold";
    const lines = formatCompletedTask(makeTask(), makeResult({ output }));
    const content = lines.join("\n");
    expect(content).toContain(output);
    expect(content).not.toContain("spilled to");
  });
});

// ── getActivityAge ───────────────────────────────────────────────────────

describe("resolveCwd", () => {
  test("passes through absolute paths", () => {
    expect(resolveCwd("/home/daniel/build/litespec")).toBe(
      "/home/daniel/build/litespec",
    );
  });

  test("resolves relative paths against the supplied parent cwd", () => {
    const parentCwd = "/repo/apps/api";
    expect(resolveCwd("../web", parentCwd)).toBe("/repo/apps/web");
  });

  test("expands tilde to homedir", () => {
    const home = os.homedir();
    expect(resolveCwd("~/build/litespec")).toBe(
      path.join(home, "build/litespec"),
    );
  });

  test("bare tilde resolves to homedir", () => {
    expect(resolveCwd("~")).toBe(os.homedir());
  });

  test("tilde with trailing slash", () => {
    expect(resolveCwd("~/")).toBe(os.homedir());
  });

  test("dot resolves to the supplied parent cwd", () => {
    expect(resolveCwd(".", "/repo/apps/api")).toBe("/repo/apps/api");
  });
});

describe("getActivityAge", () => {
  test("returns empty for undefined", () => {
    expect(getActivityAge(undefined)).toBe("");
  });

  test("returns active now for recent activity", () => {
    expect(getActivityAge(Date.now())).toBe("active now");
    expect(getActivityAge(Date.now() - 500)).toBe("active now");
  });

  test("returns seconds ago", () => {
    const result = getActivityAge(Date.now() - 5000);
    expect(result).toMatch(/^active \d+s ago$/);
  });

  test("returns minutes ago", () => {
    const result = getActivityAge(Date.now() - 120000);
    expect(result).toMatch(/^active \d+m ago$/);
  });

  test("clamps future timestamps to active now", () => {
    // Clock skew or backdated timers should not produce negative ages
    expect(getActivityAge(Date.now() + 60_000)).toBe("active now");
  });

  test("boundary: 999ms is active now, 1000ms is seconds", () => {
    expect(getActivityAge(Date.now() - 999)).toBe("active now");
    expect(getActivityAge(Date.now() - 1000)).toMatch(/^active \d+s ago$/);
  });
});

// ── File Tracking ───────────────────────────────────────────────────────

describe("extractTouchedFromActivities", () => {
  const cwd = "/home/user/project";

  test("extracts paths from edit and write tool calls", () => {
    const activities = [
      {
        id: "1",
        name: "edit",
        args: { path: "src/foo.ts" },
        startTime: 0,
        result: { content: [], isError: false },
      },
      {
        id: "2",
        name: "write",
        args: { path: "src/bar.ts", content: "..." },
        startTime: 0,
        result: { content: [], isError: false },
      },
      { id: "3", name: "read", args: { path: "src/baz.ts" }, startTime: 0 },
    ];
    const result = extractTouchedFromActivities(activities as any, cwd);
    expect(result).toEqual([
      path.resolve(cwd, "src/foo.ts"),
      path.resolve(cwd, "src/bar.ts"),
    ]);
  });

  test("returns empty array when no mutating tools", () => {
    const activities = [
      { id: "1", name: "read", args: { path: "src/foo.ts" }, startTime: 0 },
      { id: "2", name: "bash", args: { command: "ls" }, startTime: 0 },
    ];
    expect(extractTouchedFromActivities(activities as any, cwd)).toEqual([]);
  });

  test("deduplicates paths", () => {
    const activities = [
      {
        id: "1",
        name: "edit",
        args: { path: "src/foo.ts" },
        startTime: 0,
        result: { content: [], isError: false },
      },
      {
        id: "2",
        name: "write",
        args: { path: "src/foo.ts" },
        startTime: 0,
        result: { content: [], isError: false },
      },
    ];
    expect(extractTouchedFromActivities(activities as any, cwd)).toEqual([
      path.resolve(cwd, "src/foo.ts"),
    ]);
  });

  test("handles missing path gracefully", () => {
    const activities = [
      { id: "1", name: "edit", args: {}, startTime: 0 },
      { id: "2", name: "write", args: { path: null }, startTime: 0 },
      { id: "3", name: "edit", args: { path: "" }, startTime: 0 },
    ];
    expect(extractTouchedFromActivities(activities as any, cwd)).toEqual([]);
  });

  test("handles args with filePath key", () => {
    const activities = [
      {
        id: "1",
        name: "edit",
        args: { filePath: "src/qux.ts" },
        startTime: 0,
        result: { content: [], isError: false },
      },
    ];
    expect(extractTouchedFromActivities(activities as any, cwd)).toEqual([
      path.resolve(cwd, "src/qux.ts"),
    ]);
  });

  test("returns empty for empty activities", () => {
    expect(extractTouchedFromActivities([], cwd)).toEqual([]);
  });
});

// ── Constants ─────────────────────────────────────────────────────────────

describe("constants", () => {
  test("DEFAULT_TOOLS has 4 core tools", () => {
    expect(DEFAULT_TOOLS).toHaveLength(4);
    expect(DEFAULT_TOOLS).toContain("read");
    expect(DEFAULT_TOOLS).toContain("write");
    expect(DEFAULT_TOOLS).toContain("edit");
    expect(DEFAULT_TOOLS).toContain("bash");
  });

  test("READONLY_TOOLS has the 4 read-only scout tools", () => {
    expect(READONLY_TOOLS).toHaveLength(4);
    expect(READONLY_TOOLS).toContain("read");
    expect(READONLY_TOOLS).toContain("grep");
    expect(READONLY_TOOLS).toContain("find");
    expect(READONLY_TOOLS).toContain("ls");
  });

  test("VALID_THINKING contains all expected levels", () => {
    expect(VALID_THINKING.has("off")).toBe(true);
    expect(VALID_THINKING.has("minimal")).toBe(true);
    expect(VALID_THINKING.has("low")).toBe(true);
    expect(VALID_THINKING.has("medium")).toBe(true);
    expect(VALID_THINKING.has("high")).toBe(true);
    expect(VALID_THINKING.has("xhigh")).toBe(true);
    expect(VALID_THINKING.has("max")).toBe(true);
    expect(VALID_THINKING.has("invalid")).toBe(false);
  });

  test("TOOL_FACTORIES has factory for each DEFAULT_TOOL", () => {
    for (const name of DEFAULT_TOOLS) {
      expect(TOOL_FACTORIES[name]).toBeFunction();
    }
  });

  test("TOOL_FACTORIES registers the 7 core tools", () => {
    expect(Object.keys(TOOL_FACTORIES).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    for (const name of ["grep", "find", "ls"] as const) {
      expect(TOOL_FACTORIES[name]).toBeFunction();
    }
  });

  test("TOOL_FACTORIES does not report Object.prototype property names as members", () => {
    expect(Object.hasOwn(TOOL_FACTORIES, "constructor")).toBe(false);
    expect(Object.hasOwn(TOOL_FACTORIES, "toString")).toBe(false);
    expect(Object.hasOwn(TOOL_FACTORIES, "__proto__")).toBe(false);
  });
});

// ── Settings Overrides ──────────────────────────────────────────────────────

describe("readDelegateSettingsFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  test("returns null for nonexistent file", () => {
    expect(
      readDelegateSettingsFile(path.join(tmpDir, "nonexistent.json")),
    ).toBeNull();
  });

  test("parses valid JSON settings", () => {
    const file = path.join(tmpDir, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        delegate: {
          agentOverrides: { reviewer: { model: "zai/glm-5-turbo" } },
        },
      }),
    );
    const result = readDelegateSettingsFile(file);
    expect(result?.delegate).toBeDefined();
  });

  test("returns null for invalid JSON", () => {
    const file = path.join(tmpDir, "bad.json");
    writeFileSync(file, "not json");
    expect(readDelegateSettingsFile(file)).toBeNull();
  });
});

describe("loadDelegateSettings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    mock.module("node:os", () => ({ ...os, homedir: () => tmpDir }));
  });

  afterEach(() => {
    mock.module("node:os", () => os);
    cleanup(tmpDir);
  });

  test("returns null when no settings files exist", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    expect(loadDelegateSettings(projectDir)).toBeNull();
  });

  test("loads user settings from ~/.pi/agent/settings.json", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const userSettingsDir = path.join(tmpDir, ".pi", "agent");
    mkdirSync(userSettingsDir, { recursive: true });
    writeFileSync(
      path.join(userSettingsDir, "settings.json"),
      JSON.stringify({
        delegate: {
          agentOverrides: { reviewer: { model: "zai/glm-5-turbo" } },
        },
      }),
    );
    const result = loadDelegateSettings(projectDir);
    expect(result?.agentOverrides?.reviewer?.model).toBe("zai/glm-5-turbo");
  });

  test("project settings override user settings", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({
        delegate: { agentOverrides: { reviewer: { model: "project/model" } } },
      }),
    );

    const userDir = path.join(tmpDir, ".pi", "agent");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      path.join(userDir, "settings.json"),
      JSON.stringify({
        delegate: { agentOverrides: { reviewer: { model: "user/model" } } },
      }),
    );

    const result = loadDelegateSettings(projectDir);
    expect(result?.agentOverrides?.reviewer?.model).toBe("project/model");
  });
});

// ── Integration: tool registration ────────────────────────────────────────

describe("delegate extension integration", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ts?.dispose();
    ts = undefined;
  });

  test("registers the delegate tool", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    expect(toolDef).toBeDefined();
    expect(toolDef!.name).toBe("delegate"); // lookup key — hard contract
    // label is human-facing; assert shape, not exact wording (copy can drift).
    expect(typeof toolDef!.label).toBe("string");
    expect(toolDef!.label!.trim().length).toBeGreaterThan(0);
    // Tool-level description is concise and non-empty.
    expect(typeof toolDef!.description).toBe("string");
    expect(toolDef!.description!.trim().length).toBeGreaterThan(0);
  });

  test("has tasks array parameter with minItems 0 (allows help mode)", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const schema = toolDef!.parameters as any;
    const tasksArraySchema = getTasksArraySchema(schema);
    expect(schema.type).toBe("object");
    expect(tasksArraySchema.type).toBe("array");
    expect(tasksArraySchema.minItems).toBe(0);
  });

  test("wires prepareArguments to recover stringified tasks arrays", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const prepare = toolDef!.prepareArguments;
    expect(prepare).toBeDefined();

    // Stringified JSON array (the documented gotcha) → recovered to a real array.
    const recovered = prepare!({ tasks: '[{"prompt":"hi"}]', async: true });
    expect(recovered).toEqual({ tasks: [{ prompt: "hi" }], async: true });

    // Flat task fields at the top level → wrapped into a single task instead
    // of silently degrading to the help response.
    expect(prepare!({ prompt: "hi", tools: '["*"]' })).toEqual({
      tasks: [{ prompt: "hi", tools: ["*"] }],
    });

    // Already-correct arguments pass through unchanged in content.
    const good = { tasks: [{ prompt: "hi" }] };
    expect(prepare!(good)).toEqual(good as never);

    // Non-JSON string and non-array JSON are left for schema validation to reject.
    const notJson = { tasks: "not json" };
    expect(prepare!(notJson)).toEqual(notJson as never);
    const notArray = { tasks: '{"prompt":"hi"}' };
    expect(prepare!(notArray)).toEqual(notArray as never);

    // Non-object inputs pass through untouched.
    expect(prepare!(null)).toBe(null as never);
  });

  test("stays out of the system prompt but self-describes in the schema", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    // System-prompt stealth: no snippet, no guidelines.
    expect(toolDef!.promptSnippet).toBeUndefined();
    expect(toolDef!.promptGuidelines ?? []).toEqual([]);
    // Schema self-description: every top-level property and every task
    // field carries a description so the model can call correctly without
    // fetching the manual first.
    const schema = toolDef!.parameters as any;
    const topProperties = Object.entries<any>(schema.properties);
    for (const [key, prop] of topProperties) {
      expect(typeof prop.description, `top-level '${key}'`).toBe("string");
    }
    const tasksArraySchema = getTasksArraySchema(schema);
    const taskProperties = Object.entries<any>(
      tasksArraySchema.items.properties,
    );
    for (const [key, prop] of taskProperties) {
      expect(typeof prop.description, `task field '${key}'`).toBe("string");
    }

    // Critical conditional semantics that JSON Schema cannot express cheaply
    // remain available at call-time without restoring B's prose-heavy schema.
    expect(toolDef!.description).toContain("parallel subagents");
    expect(toolDef!.description).toContain("tasks:[{prompt}]");
    expect(toolDef!.description).toContain("tasks:[]=full manual");
    expect(schema.properties.ticket.description).toContain("polling all");
    expect(tasksArraySchema.items.properties.agent.description).toContain(
      "`default`",
    );
    expect(tasksArraySchema.items.properties.agent.description).toContain(
      "parent model/thinking/native tools/base prompt",
    );
    expect(tasksArraySchema.items.properties.prompt.description).toContain(
      "cannot see this chat",
    );
    expect(tasksArraySchema.items.properties.context.description).toContain(
      "token-expensive",
    );
    expect(
      tasksArraySchema.items.properties.systemPrompt.description,
    ).not.toContain("AgentSession");
    expect(tasksArraySchema.items.properties.tools.description).toContain(
      "read/write/edit/bash",
    );
    expect(tasksArraySchema.items.properties.tools.description).toContain(
      "read-only",
    );
    expect(
      tasksArraySchema.items.properties.sessionAction.description,
    ).toContain("list shows active pooled sessions");
    expect(tasksArraySchema.items.properties.resumeFrom.description).toContain(
      "never a ticket ID",
    );
    expect(tasksArraySchema.items.properties.id.description).toContain(
      "correlation",
    );
    expect(tasksArraySchema.items.properties.id.description).toContain(
      "duplicate",
    );

    // Orchestration invariants from #27 are model-visible in the schema.
    expect(toolDef!.description).toContain("Sync");
    expect(toolDef!.description).toContain("async");
    expect(schema.properties.tasks.description).toContain("real filesystem");
    expect(schema.properties.tasks.description).toContain("run concurrently");
    expect(schema.properties.tasks.description).toContain("[]=full manual");
    expect(schema.properties.async.description).toContain("auto-deliver");
    expect(schema.properties.async.description).toContain("Wait");
    expect(schema.properties.ticketAction.description).toContain("Prefer wait");
    expect(schema.properties.force.description).toContain(
      "previews active work",
    );
    expect(schema.properties.force.description).toContain("confirms abort");
    expect(schema.properties.force.description).toContain(
      "writes/commands remain",
    );
    expect(tasksArraySchema.items.properties.sessionAction.enum).toEqual([
      "prompt",
      "close",
      "list",
    ]);

    // Descriptions are a tokenizer-independent proxy for the repeated provider
    // tool-definition payload. Keep truthful model-facing guidance compact but
    // informative — the budget fits the current copy with ~50 chars of headroom.
    // Raise it only when new model-visible semantics justify their repeated
    // provider payload; do not mutilate useful copy merely to preserve a stale
    // number.
    const descriptions = [
      toolDef!.description!,
      ...topProperties.map(([, prop]) => prop.description as string),
      ...taskProperties.map(([, prop]) => prop.description as string),
    ];
    expect(
      Math.max(...descriptions.map((description) => description.length)),
    ).toBeLessThanOrEqual(110);
    expect(
      descriptions.reduce(
        (total, description) => total + description.length,
        0,
      ),
    ).toBeLessThanOrEqual(1_900);
  });

  test("rejects mixed dispatch, ticket, and session-control shapes", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const invalidCalls = [
      { ticketAction: "poll", tasks: [{ prompt: "stray" }] },
      { ticket: "t1", tasks: [{ prompt: "stray" }] },
      { async: true },
      { timeoutMs: 10, tasks: [{ prompt: "stray" }] },
      { force: true, tasks: [{ prompt: "stray" }] },
      { tasks: [{ sessionAction: "list", prompt: "stray" }] },
      { tasks: [{ sessionAction: "close", sessionId: "s1", prompt: "stray" }] },
      { tasks: [{ prompt: "x", deadlineMs: 0 }] },
      { tasks: [{ prompt: "x", deadlineMs: -5 }] },
    ];

    for (const params of invalidCalls) {
      const result = await toolDef!.execute(
        "tc-invalid-shape",
        params as never,
        undefined,
        undefined,
        ts.session.extensionRunner as any,
      );
      const text = result.content[0].text;
      expect(text).toContain("Invalid delegate call");
      if ((params as any).tasks?.[0]?.deadlineMs !== undefined) {
        expect(text).toContain("deadlineMs must be a positive number");
      }
      expect(result.details.results).toEqual([]);
      expect(result.details.progress).toEqual([]);
    }
  });

  test("execute returns help when tasks is empty", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    const result = await toolDef!.execute(
      "tc-help",
      { tasks: [] },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );

    const text = result.content[0].text;
    expect(text).toContain("Delegate Tool Manual");
    expect(text).toContain("Available Custom Agents");
    expect(text).toContain("Task Fields");
    expect(text).toContain("Top-level Fields");
    expect(text).toContain("**ticket**");
    expect(text).toContain("**sessionId**");
    expect(text).toContain("**resumeFrom**");
    expect(text).toContain("cannot call `delegate` recursively");
    expect(text).toContain(
      "Parent-global `AGENTS.md` instructions are also excluded",
    );
    expect(text).toContain("validation is batch-wide");
    const schema = toolDef!.parameters as any;
    for (const key of Object.keys(schema.properties)) {
      expect(text).toContain(`| \`${key}\` |`);
    }
    for (const key of Object.keys(
      getTasksArraySchema(schema).items.properties,
    )) {
      expect(text).toContain(`| \`${key}\` |`);
    }
    expect(text).toContain(
      '| `context` | `"fresh" \\| "with-parent-transcript"` | `"fresh"` |',
    );
    expect(text).toContain("| `async` | `boolean` | `false` |");
    expect(text).toContain("```markdown");
  });

  test("task schema has prompt as required string", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const tasksArraySchema = getTasksArraySchema(toolDef!.parameters as any);
    const taskSchema = tasksArraySchema.items;
    expect(taskSchema.type).toBe("object");
    expect(taskSchema.properties.prompt.type).toBe("string");
    // prompt is optional — required only for non-close/list actions (enforced at runtime).
    expect(taskSchema.required ?? []).not.toContain("prompt");
  });

  test("task schema has optional fields", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const tasksArraySchema = getTasksArraySchema(toolDef!.parameters as any);
    const taskSchema = tasksArraySchema.items;
    const optionalFields = [
      "agent",
      "model",
      "tools",
      "thinking",
      "systemPrompt",
      "cwd",
      "context",
      "sessionId",
      "sessionAction",
      "deadlineMs",
    ];
    for (const field of optionalFields) {
      expect(taskSchema.properties[field]).toBeDefined();
    }
    expect(taskSchema.properties.deadlineMs).toBeDefined();
    // Legacy aliases remain type/runtime compatible but are intentionally absent
    // from the provider-visible schema so models see only canonical namespaces.
    expect(taskSchema.properties.action).toBeUndefined();
    expect((toolDef!.parameters as any).properties.action).toBeUndefined();
    // No required fields at the TypeBox level; runtime validation enforces constraints.
    expect(taskSchema.required).toBeUndefined();
  });

  test("task schema exposes Pi's max thinking level", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const tasksArraySchema = getTasksArraySchema(toolDef!.parameters as any);

    expect(tasksArraySchema.items.properties.thinking.enum).toContain("max");
  });

  test("execute rejects unknown agents and suggests help", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    const result = await toolDef!.execute(
      "tc-1",
      { tasks: [{ prompt: "do something", agent: "nonexistent-agent-xyz" }] },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );

    const text = result.content[0].text;
    expect(text).toContain("Unknown agent");
    expect(text).toContain("nonexistent-agent-xyz");
    expect(text).toContain("Available: default");
    expect(text).toContain("Call delegate with an empty tasks array for help");
  });

  test("execute falls back to hardcoded prompt when no systemPrompt, no agent, no getSystemPrompt", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    // Test harness has no getSystemPrompt and no model — so we get past
    // system prompt resolution (hardcoded fallback) and fail at model resolution.
    try {
      await toolDef!.execute(
        "tc-2",
        { tasks: [{ prompt: "do something" }] },
        undefined,
        undefined,
        ts.session.extensionRunner as any,
      );
    } catch (err: any) {
      // Must NOT be the old "no system prompt" error — that means fallback failed.
      expect(err.message).not.toContain("no system prompt");
      // Must be the expected model resolution error — proves we got past system prompt.
      expect(err.message).toContain("no model available");
      return;
    }
    expect.unreachable("should have thrown at model resolution");
  });

  test("inherits parent model as-is when its id is a composite OpenRouter-style id (no re-resolution)", async () => {
    // Regression for the bug where omitting a task model fell back to the
    // parent's model *id string*, which resolveModel split on "/" and
    // re-resolved through the registry. For OpenRouter ids like
    // "deepseek/deepseek-v4-flash" that splits to provider="deepseek",
    // misrouting auth to an upstream provider with no key.
    //
    // Fix: resolveModelSpec has no parent tier; when nothing explicit is
    // set it returns undefined, and resolveModel's undefined-guard returns
    // ctx.model directly (no registry lookup, no id splitting).
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    const parentModel = {
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash",
    } as any;
    // The trap: a deepseek-provider variant with the bare id exists in the
    // registry. The OLD code would split the parent id and resolve to this
    // (unauthenticated) model. The registry reports no auth for it so a
    // regression surfaces as a fast auth failure rather than a network call.
    const deepseekVariant = {
      provider: "deepseek",
      id: "deepseek-v4-flash",
    } as any;
    const mockRegistry = {
      getAvailable: () => [deepseekVariant],
      find: (provider: string, id: string) =>
        provider === "deepseek" && id === "deepseek-v4-flash"
          ? deepseekVariant
          : null,
      hasConfiguredAuth: () => false,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({
        ok: false,
        error: "No API key for provider: deepseek",
      }),
    } as any;

    const result = await toolDef!.execute(
      "tc-parent-inherit",
      { tasks: [{ prompt: "hello", sessionAction: "prompt" }] },
      undefined,
      undefined,
      // Custom ctx: composite-id parent + trap registry. No explicit task model.
      {
        model: parentModel,
        modelRegistry: mockRegistry,
        cwd: ts.cwd,
        sessionManager: undefined,
      } as any,
    );

    const progress = (result.details as any).progress as Array<{
      model?: string;
      status: string;
      error?: string;
    }>;
    // The resolved model must be the parent object as-is: its full composite id,
    // NOT the split bare id "deepseek-v4-flash" the old code resolved to.
    expect(progress[0].model).toBe("deepseek/deepseek-v4-flash");
    expect(progress[0].model).not.toBe("deepseek-v4-flash");
    // Runner reaches auth and fails fast (no network) — proves the model was
    // wired through to execution rather than short-circuited.
    expect(progress[0].error).toContain("No API key");
  });
});

// ── Integration: renderers ────────────────────────────────────────────────

describe("delegate renderers", () => {
  let ts: TestSession | undefined;

  beforeEach(() => {
    // `__delegateConfig` auto-loads from the developer's on-disk
    // `~/.pi/agent/delegate.json`, whose `maxConcurrent` (e.g. 6) would
    // otherwise defeat the cap-sensitive `queued (N running)` assertions.
    // Reset to compiled defaults so the renderers are deterministic.
    _resetDelegateConfigForTesting();
  });

  afterEach(() => {
    _resetDelegateConfigForTesting();
    ts?.dispose();
    ts = undefined;
  });

  function mockTheme() {
    return {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => `**${text}**`,
    } as any;
  }

  function createMockText() {
    let captured = "";
    return {
      setText: (text: string) => {
        captured = text;
      },
      getText: () => captured,
      invalidate: () => {},
    };
  }

  function mockRenderCtx(overrides: any = {}) {
    return {
      state: {},
      executionStarted: false,
      lastComponent: createMockText(),
      invalidate: () => {},
      ...overrides,
    } as any;
  }

  test("renderCall shows task count", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderCall(
      { tasks: [{ prompt: "task 1" }, { prompt: "task 2" }] },
      theme,
      ctx,
    );
    expect((text as any).getText()).toContain("delegate 2 tasks");
  });

  test("renderCall shows task count for single task", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderCall(
      { tasks: [{ prompt: "do work", agent: "worker" }] },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    // renderCall shows task count; agent name appears in renderResult.
    expect(rendered).toContain("delegate 1 task");
  });

  test("renderCall does not count characters in stringified tasks", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderCall(
      { tasks: '[{"prompt":"do work"}]' },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("delegate invalid tasks");
    expect(rendered).not.toContain("22 tasks");
  });

  test("renderCall does not bloat with long prompts", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const longPrompt = "a".repeat(100);
    const text = toolDef!.renderCall(
      { tasks: [{ prompt: longPrompt }] },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    // renderCall is minimal — just the task count. No prompt preview.
    expect(rendered).toContain("delegate 1 task");
    expect(rendered.length).toBeLessThan(longPrompt.length);
  });

  test("renderResult shows progress when partial", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 0,
            tokens: 0,
            toolUses: 0,
            activities: [],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("0/1 done");
    expect(rendered).toContain("thinking…");
  });

  test("renderResult shows done status when complete", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [
          { agent: "inline", output: "result", durationMs: 1200, tokens: 42 },
        ],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "done",
            durationMs: 1200,
            tokens: 42,
            toolUses: 1,
            activities: [],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("✓");
    expect(rendered).toContain("1/1 completed");
  });

  test("renderResult hides output and tool summary in collapsed final mode", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [{ agent: "inline", output: lines, durationMs: 0, tokens: 0 }],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "done",
            durationMs: 0,
            tokens: 0,
            toolUses: 0,
            activities: [],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    // Collapsed: a one-line preview surfaces the first content line (friction
    // #1), but the full body and any "more lines" affordance stay hidden.
    expect(rendered).toContain("✓");
    expect(rendered).toContain("line1");
    expect(rendered).not.toContain("line15");
    expect(rendered).not.toContain("more lines");
  });

  test("renderResult shows all lines when expanded", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [
          {
            agent: "inline",
            output: "line1\nline2\nline3\nline4\nline5",
            durationMs: 0,
            tokens: 0,
          },
        ],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "done",
            durationMs: 0,
            tokens: 0,
            toolUses: 0,
            activities: [],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: true },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).not.toContain("more lines");
    expect(rendered).toContain("line5");
  });

  test("renderResult shows running tool activities in partial mode", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 500,
            tokens: 120,
            toolUses: 2,
            activities: [
              {
                id: "tc1",
                name: "read",
                args: { path: "src/config.ts" },
                startTime: 0,
                endTime: 100,
                result: {
                  content: [{ type: "text", text: "config" }],
                  isError: false,
                },
              },
              {
                id: "tc2",
                name: "bash",
                args: { command: "git status" },
                startTime: 150,
              },
            ],
          },
        ],
      },
    };

    // Collapsed: compact activity + Ctrl+O hint
    const compact = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      theme,
      ctx,
    );
    const compactText = (compact as any).getText();
    expect(compactText).toContain("Ctrl+O for detail");
    // Current in-flight tool shown compactly
    expect(compactText).toContain("$ git status");
    expect(compactText).not.toContain("→ read src/config.ts");

    // Expanded: recent activities including completed ones
    const expanded = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: true },
      theme,
      ctx,
    );
    const expandedText = (expanded as any).getText();
    expect(expandedText).toContain("> $ git status |");
    expect(expandedText).toContain("→ read src/config.ts");
  });

  test("renderResult hides tool summary but shows output preview in collapsed final mode", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [
          {
            agent: "inline",
            output: "all good",
            durationMs: 1000,
            tokens: 200,
          },
        ],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "done",
            durationMs: 1000,
            tokens: 200,
            toolUses: 1,
            activities: [
              {
                id: "tc1",
                name: "read",
                args: { path: "src/config.ts" },
                startTime: 0,
                endTime: 100,
                result: {
                  content: [{ type: "text", text: "line1\nline2\nline3" }],
                  isError: false,
                },
              },
            ],
          },
        ],
      },
    };

    // Collapsed: tool summary hidden, but a one-line output preview surfaces the
    // payoff so a human doesn't have to expand every task (friction #1 fix).
    const text = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("✓");
    expect(rendered).not.toContain("1 tool: read");
    expect(rendered).toContain("all good");
    // Preview is a single line (no full multiline body in collapsed mode).
    expect(rendered).not.toContain("line1\nline2");

    // Expanded: tool summary and full output visible.
    const expanded = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: true },
      theme,
      ctx,
    );
    const expandedRendered = (expanded as any).getText();
    expect(expandedRendered).toContain("1 tool: read");
    expect(expandedRendered).toContain("all good");
  });

  test("renderResult expands tool results when expanded is true", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [
          { agent: "inline", output: "done", durationMs: 1000, tokens: 200 },
        ],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "done",
            durationMs: 1000,
            tokens: 200,
            toolUses: 1,
            activities: [
              {
                id: "tc1",
                name: "read",
                args: { path: "src/config.ts" },
                startTime: 0,
                endTime: 100,
                result: {
                  content: [{ type: "text", text: "alpha\nbeta\ngamma" }],
                  isError: false,
                },
              },
            ],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: true },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    // Agent output is rendered as markdown; individual tool dumps are gone.
    expect(rendered).toContain("done");
    expect(rendered).toContain("1 tool: read");
    expect(rendered).not.toContain("lines hidden");
  });

  test("renderResult shows error and hides tool summary in collapsed final mode", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [
          {
            agent: "inline",
            output: "",
            error: "bad cmd",
            durationMs: 500,
            tokens: 50,
          },
        ],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "failed",
            durationMs: 500,
            tokens: 50,
            toolUses: 1,
            activities: [
              {
                id: "tc1",
                name: "bash",
                args: { command: "bad-cmd" },
                startTime: 0,
                endTime: 50,
                result: {
                  content: [{ type: "text", text: "not found" }],
                  isError: true,
                },
              },
            ],
          },
        ],
      },
    };

    // Collapsed: error icon and error message shown; tool summary hidden.
    const text = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("✗");
    expect(rendered).not.toContain("1 tool: bash");
    expect(rendered).toContain("bad cmd");

    // Expanded: tool summary and error visible.
    const expanded = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: true },
      theme,
      ctx,
    );
    const expandedRendered = (expanded as any).getText();
    expect(expandedRendered).toContain("1 tool: bash");
    expect(expandedRendered).toContain("✗");
  });

  test("renderResult shows activities for completed subagent in partial mode", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }, { prompt: "task2" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "done",
            durationMs: 1000,
            tokens: 500,
            toolUses: 2,
            activities: [
              {
                id: "tc1",
                name: "read",
                args: { path: "a.ts" },
                startTime: 0,
                endTime: 50,
                result: {
                  content: [{ type: "text", text: "ok" }],
                  isError: false,
                },
              },
            ],
          },
          {
            index: 1,
            agent: "inline",
            task: "task2",
            status: "running",
            durationMs: 500,
            tokens: 100,
            toolUses: 1,
            activities: [
              {
                id: "tc2",
                name: "bash",
                args: { command: "ls" },
                startTime: 0,
              },
            ],
          },
        ],
      },
    };

    // Collapsed: activities hidden, compact hints for running
    const compact = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      theme,
      ctx,
    );
    const compactText = (compact as any).getText();
    expect(compactText).toContain("Ctrl+O for detail");
    expect(compactText).not.toContain("→ read a.ts");
    expect(compactText).toContain("├─");

    // Expanded: activities visible for both done and running
    const expanded = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: true },
      theme,
      ctx,
    );
    const expandedText = (expanded as any).getText();
    expect(expandedText).toContain("→ read a.ts");
    expect(expandedText).toContain("$ ls");
  });

  test("partial render shows last 5 activities in expanded mode", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const activities = [
      {
        id: "tc0",
        name: "read",
        args: { path: "0.ts" },
        startTime: -10,
        endTime: 0,
        result: { content: [{ type: "text", text: "z" }], isError: false },
      },
      {
        id: "tc1",
        name: "read",
        args: { path: "1.ts" },
        startTime: 0,
        endTime: 10,
        result: { content: [{ type: "text", text: "a" }], isError: false },
      },
      {
        id: "tc2",
        name: "read",
        args: { path: "2.ts" },
        startTime: 20,
        endTime: 30,
        result: { content: [{ type: "text", text: "b" }], isError: false },
      },
      {
        id: "tc3",
        name: "read",
        args: { path: "3.ts" },
        startTime: 40,
        endTime: 50,
        result: { content: [{ type: "text", text: "c" }], isError: false },
      },
      { id: "tc4", name: "read", args: { path: "4.ts" }, startTime: 60 },
    ];

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 500,
            tokens: 100,
            toolUses: 4,
            activities,
          },
        ],
      },
    };

    // Collapsed: only the current in-flight tool (4.ts)
    const compact = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      theme,
      ctx,
    );
    const compactText = (compact as any).getText();
    expect(compactText).toContain("Ctrl+O for detail");
    expect(compactText).toContain("read 4.ts");
    expect(compactText).not.toContain("1.ts");

    // Expanded: last 5 activities shown (all 5 in this case)
    const expanded = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: true },
      theme,
      ctx,
    );
    const expandedText = (expanded as any).getText();
    expect(expandedText).toContain("4.ts");
    expect(expandedText).toContain("0.ts");
    expect(expandedText).toContain("1.ts");
    expect(expandedText).toContain("2.ts");
    expect(expandedText).toContain("3.ts");
  });

  test("formatToolCallShort: various tool types render correctly", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const activities = [
      {
        id: "t1",
        name: "read",
        args: { path: "src/file.ts", offset: 10, limit: 5 },
        startTime: 0,
        endTime: 1,
        result: { content: [{ type: "text", text: "x" }], isError: false },
      },
      {
        id: "t1b",
        name: "read",
        args: { file_path: "alt.ts" },
        startTime: 0,
        endTime: 1,
        result: { content: [{ type: "text", text: "x" }], isError: false },
      },
      {
        id: "t2",
        name: "write",
        args: { path: "out.ts", content: "line1\nline2\nline3" },
        startTime: 0,
        endTime: 1,
        result: { content: [{ type: "text", text: "ok" }], isError: false },
      },
      {
        id: "t3",
        name: "edit",
        args: { path: "fix.ts" },
        startTime: 0,
        endTime: 1,
        result: { content: [{ type: "text", text: "done" }], isError: false },
      },
      {
        id: "t4",
        name: "bash",
        args: { command: "git status" },
        startTime: 0,
        endTime: 1,
        result: { content: [{ type: "text", text: "clean" }], isError: false },
      },
      {
        id: "t5",
        name: "custom_tool",
        args: { query: "search term" },
        startTime: 0,
        endTime: 1,
        result: { content: [{ type: "text", text: "custom" }], isError: false },
      },
    ];

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [
          { agent: "inline", output: "ok", durationMs: 100, tokens: 50 },
        ],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "done",
            durationMs: 100,
            tokens: 50,
            toolUses: 6,
            activities,
          },
        ],
      },
    };

    // Expanded final now shows compact tool summary, not individual calls.
    // Test formatToolCallShort indirectly via partial mode (current tool only).
    const mkPartial = (activities: any[]) => ({
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 100,
            tokens: 50,
            toolUses: activities.length,
            activities,
          },
        ],
      },
    });
    const renderPartial = (activities: any[]) =>
      (
        toolDef!.renderResult(
          mkPartial(activities),
          { isPartial: true, expanded: true },
          theme,
          ctx,
        ) as any
      ).getText();

    expect(
      renderPartial([
        {
          id: "t1",
          name: "read",
          args: { path: "src/file.ts", offset: 10, limit: 5 },
          startTime: 0,
        },
      ]),
    ).toContain("read src/file.ts:10-14");
    expect(
      renderPartial([
        {
          id: "t1b",
          name: "read",
          args: { file_path: "alt.ts" },
          startTime: 0,
        },
      ]),
    ).toContain("read alt.ts");
    expect(
      renderPartial([
        {
          id: "t2",
          name: "write",
          args: { path: "out.ts", content: "line1\nline2\nline3" },
          startTime: 0,
        },
      ]),
    ).toContain("write out.ts (3 lines)");
    expect(
      renderPartial([
        { id: "t3", name: "edit", args: { path: "fix.ts" }, startTime: 0 },
      ]),
    ).toContain("edit fix.ts");
    expect(
      renderPartial([
        {
          id: "t4",
          name: "bash",
          args: { command: "git status" },
          startTime: 0,
        },
      ]),
    ).toContain("$ git status");
    expect(
      renderPartial([
        {
          id: "t5",
          name: "custom_tool",
          args: { query: "search term" },
          startTime: 0,
        },
      ]),
    ).toContain("custom_tool search term");
  });

  test("renderResult shows activity age for running tasks", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 5000,
            tokens: 200,
            toolUses: 3,
            lastActivityAt: Date.now() - 3000,
            activities: [
              {
                id: "tc1",
                name: "read",
                args: { path: "src/x.ts" },
                startTime: Date.now() - 3000,
                endTime: Date.now() - 2500,
                result: {
                  content: [{ type: "text", text: "ok" }],
                  isError: false,
                },
              },
            ],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("active ");
    expect(rendered).toContain("s ago");
  });

  test("renderResult surfaces cooperative stall cancellation before settlement", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "ad-hoc",
            task: "task",
            status: "running",
            durationMs: 5000,
            tokens: 0,
            toolUses: 0,
            failureKind: "stalled",
            lastActivityAt: Date.now() - 5000,
            activities: [],
          },
        ],
      },
    };

    const component = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      mockTheme(),
      mockRenderCtx(),
    );
    const rendered = (component as any).getText();
    expect(rendered).toContain("stall detected");
    expect(rendered).toContain("cancellation pending");
  });

  test("collapsed running shows ⎿ with current tool and Ctrl+O hint", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 500,
            tokens: 100,
            toolUses: 2,
            activities: [
              {
                id: "tc1",
                name: "read",
                args: { path: "done.ts" },
                startTime: 0,
                endTime: 100,
                result: {
                  content: [{ type: "text", text: "ok" }],
                  isError: false,
                },
              },
              {
                id: "tc2",
                name: "bash",
                args: { command: "npm test" },
                startTime: 150,
              },
            ],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("Ctrl+O for detail");
    expect(rendered).toContain("⎿");
    // Current in-flight tool shown compactly
    expect(rendered).toContain("$ npm test");
    // Completed tool NOT shown in collapsed mode
    expect(rendered).not.toContain("done.ts");
  });

  test("collapsed running shows thinking… when no current tool", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 500,
            tokens: 100,
            toolUses: 0,
            activities: [],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("thinking…");
    expect(rendered).toContain("Ctrl+O for detail");
  });

  test("expanded running shows current tool with elapsed duration", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 5000,
            tokens: 200,
            toolUses: 3,
            activities: [
              {
                id: "tc1",
                name: "read",
                args: { path: "a.ts" },
                startTime: Date.now() - 5000,
                endTime: Date.now() - 4500,
                result: {
                  content: [{ type: "text", text: "file contents" }],
                  isError: false,
                },
              },
              {
                id: "tc2",
                name: "bash",
                args: { command: "npm test" },
                startTime: Date.now() - 1000,
              },
            ],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: true },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    // Current in-flight tool with elapsed indicator
    expect(rendered).toContain("> $ npm test |");
    // Completed tools also shown in expanded running
    expect(rendered).toContain("→ read a.ts");
    expect(rendered).toContain("✓");
    // Ctrl+O hint only in collapsed running
    expect(rendered).not.toContain("Ctrl+O for detail");
  });

  test("expanded running shows live output from tool_execution_update", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "running",
            durationMs: 5000,
            tokens: 200,
            toolUses: 2,
            activities: [
              {
                id: "tc1",
                name: "read",
                args: { path: "a.ts" },
                startTime: Date.now() - 5000,
                endTime: Date.now() - 4500,
                result: {
                  content: [{ type: "text", text: "file contents" }],
                  isError: false,
                },
              },
              {
                id: "tc2",
                name: "bash",
                args: { command: "npm test" },
                startTime: Date.now() - 1000,
                liveOutput:
                  "Test suite running...\nPASS src/utils.test.ts\nFAIL src/broken.test.ts",
              },
            ],
          },
        ],
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: true },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    // Live output lines shown indented under the in-flight bash tool
    expect(rendered).toContain("PASS src/utils.test.ts");
    expect(rendered).toContain("FAIL src/broken.test.ts");
    // Carriage returns resolved (progress bars show final state)
    expect(rendered).not.toContain("\r");
    // Ctrl+O hint not shown in expanded
    expect(rendered).not.toContain("Ctrl+O for detail");
  });

  test("collapsed done hides activities, expanded shows them", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [],
        progress: [
          {
            index: 0,
            agent: "inline",
            task: "task",
            status: "done",
            durationMs: 1000,
            tokens: 200,
            toolUses: 1,
            activities: [
              {
                id: "tc1",
                name: "bash",
                args: { command: "cargo build" },
                startTime: 0,
                endTime: 500,
                result: {
                  content: [{ type: "text", text: "compiled" }],
                  isError: false,
                },
              },
            ],
          },
        ],
      },
    };

    // Collapsed: no activity details
    const compact = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: false },
      theme,
      ctx,
    );
    expect((compact as any).getText()).not.toContain("cargo build");

    // Expanded: activities visible
    const expanded = toolDef!.renderResult(
      result,
      { isPartial: true, expanded: true },
      theme,
      ctx,
    );
    expect((expanded as any).getText()).toContain("cargo build");
  });

  // ── UX-REVIEW tasks: warnings, async/ticket render, queue position ───────

  test("renderResult surfaces task warnings in the TUI (final and partial)", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [{ agent: "ad-hoc", output: "ok", durationMs: 0, tokens: 0 }],
        progress: [
          {
            index: 0,
            agent: "ad-hoc",
            task: "task",
            status: "done",
            durationMs: 0,
            tokens: 0,
            toolUses: 0,
            activities: [],
            warnings: ["Unknown tool(s) ignored: frobnicate"],
          },
        ],
      },
    };

    const finalText = (
      toolDef!.renderResult(
        result,
        { isPartial: false, expanded: false },
        theme,
        ctx,
      ) as any
    ).getText();
    expect(finalText).toContain("⚠");
    expect(finalText).toContain("Unknown tool(s) ignored: frobnicate");

    // Also visible while running.
    const partialText = (
      toolDef!.renderResult(
        { ...result, details: { ...result.details, results: [] } },
        {
          ...{ isPartial: true, expanded: false },
          ...{ executionStarted: true },
        } as any,
        theme,
        { ...ctx, state: {}, isPartial: true } as any,
      ) as any
    ).getText();
    expect(partialText).toContain("⚠");
  });

  test("renderResult shows a running-ticket banner for non-terminal async state", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    // Simulates poll({ ticket }) on a still-running ticket: progress carries
    // running/pending statuses and details.ticketId is set.
    const result = {
      content: [{ type: "text", text: "RUNNING" }],
      details: {
        tasks: [{ prompt: "investigate" }, { prompt: "build" }],
        results: [],
        status: "running",
        progress: [
          {
            index: 0,
            agent: "scout",
            task: "investigate",
            status: "running",
            durationMs: 0,
            tokens: 10,
            toolUses: 1,
            activities: [],
          },
          {
            index: 1,
            agent: "worker",
            task: "build",
            status: "pending",
            durationMs: 0,
            tokens: 0,
            toolUses: 0,
            activities: [],
          },
        ],
        ticketId: "abc12345",
      },
    };

    const text = toolDef!.renderResult(
      result,
      { isPartial: false, expanded: false },
      theme,
      ctx,
    );
    const rendered = (text as any).getText();
    // Ticket banner frames it as background work, not a finished result.
    expect(rendered).toContain("⏳");
    expect(rendered).toContain("ticket abc12345");
    expect(rendered).toContain("running in background");
    expect(rendered).toContain("scout");
    // Running + pending tasks render with their glyphs, never ✗ for still-live work.
    expect(rendered).toContain("◐");
    expect(rendered).not.toContain("✗");
  });

  test("renderResult shows ticket banner end-to-end via handlePoll (real integration)", async () => {
    // Exercises the real poll path — handlePoll must thread ticketId into
    // details so the banner appears (not a hand-constructed details object).
    const ticket: AsyncTicket = {
      id: "poll45678",
      created: Date.now(),
      tasks: [{ prompt: "investigate" }],
      resolved: [
        {
          prompt: "investigate",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "investigate",
          status: "running",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };
    ticketRegistry.set("poll45678", ticket);
    try {
      ts = await createTestSession({ extensions: [EXTENSION] });
      const toolDef = getToolDef(ts, "delegate");
      const theme = mockTheme();
      const ctx = mockRenderCtx();

      const pollResult = handlePoll({ ticket: "poll45678" }, {} as any);
      // details must carry the ticketId — this is the gap the test guards.
      expect(pollResult.details.ticketId).toBe("poll45678");

      const rendered = (
        toolDef!.renderResult(
          pollResult,
          { isPartial: false, expanded: false },
          theme,
          ctx,
        ) as any
      ).getText();
      expect(rendered).toContain("⏳");
      expect(rendered).toContain("ticket poll45678");
      expect(rendered).toContain("running in background");
      // Live tasks use placeholder { error: "PENDING..." } results for index
      // alignment; the renderer must not surface that placeholder as an error.
      expect(rendered).not.toContain("PENDING");
      expect(rendered).not.toContain("result not available");
    } finally {
      ticketRegistry.delete("poll45678");
    }
  });

  test("collapsed final preview strips markdown noise from the first content line", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "task" }],
        results: [
          {
            agent: "ad-hoc",
            output:
              "# Heading\n\n- bullet\n1. step one\nThe real finding: X is broken.",
            durationMs: 0,
            tokens: 0,
          },
        ],
        progress: [
          {
            index: 0,
            agent: "ad-hoc",
            task: "task",
            status: "done",
            durationMs: 0,
            tokens: 0,
            toolUses: 0,
            activities: [],
          },
        ],
      },
    };

    const rendered = (
      toolDef!.renderResult(
        result,
        { isPartial: false, expanded: false },
        theme,
        ctx,
      ) as any
    ).getText();
    // Preview skips the heading/bullet/numbered-list lines and surfaces the
    // first real line, with the leading "#" stripped so it reads as content.
    expect(rendered).toContain("Heading");
    expect(rendered).not.toContain("bullet");
    expect(rendered).not.toContain("step one");
  });

  test("queue position shown for pending tasks when concurrency cap is saturated", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx({ executionStarted: true });

    // 3 running (== default MAX_CONCURRENCY) + 1 pending → pending is queued.
    const mk = (agent: string, status: any) => ({
      index: 0,
      agent,
      task: "t",
      status,
      durationMs: 0,
      tokens: 0,
      toolUses: 0,
      activities: [],
    });
    const result = {
      content: [{ type: "text", text: "Running" }],
      details: {
        tasks: [{}, {}, {}, {}],
        results: [],
        progress: [
          mk("a", "running"),
          mk("b", "running"),
          mk("c", "running"),
          mk("d", "pending"),
        ],
      },
    };

    const rendered = (
      toolDef!.renderResult(
        result,
        { isPartial: true, expanded: false } as any,
        theme,
        ctx,
      ) as any
    ).getText();
    expect(rendered).toContain("queued (3 running)");
  });

  test("renderResult shows the overlap warning after the progress trees", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    // Make the terminal wide enough so the safety warning is not truncated.
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 220;

    const shared = "/tmp/shared.txt";
    const results = [
      {
        agent: "a",
        output: "done",
        durationMs: 100,
        tokens: 10,
        attributedFiles: [shared],
      },
      {
        agent: "b",
        output: "done",
        durationMs: 100,
        tokens: 10,
        attributedFiles: [shared],
      },
    ];
    const overlapWarning = formatTouchedOverlapWarning(
      findTouchedOverlaps(results),
    );
    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        tasks: [{ prompt: "a" }, { prompt: "b" }],
        results,
        progress: [
          {
            index: 0,
            agent: "a",
            task: "a",
            status: "done",
            durationMs: 100,
            tokens: 10,
            toolUses: 0,
            activities: [],
          },
          {
            index: 1,
            agent: "b",
            task: "b",
            status: "done",
            durationMs: 100,
            tokens: 10,
            toolUses: 0,
            activities: [],
          },
        ],
        overlapWarning,
      },
    };

    try {
      const rendered = (
        toolDef!.renderResult(
          result,
          { isPartial: false, expanded: false } as any,
          theme,
          ctx,
        ) as any
      ).getText();
      expect(rendered).toContain("2/2 completed");
      expect(rendered).toContain(shared);
      expect(rendered).toContain("does not isolate or serialize file access");
      expect(rendered).toContain("does not roll back completed writes");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });
});

// ── Pool tests ────────────────────────────────────────────────────────────

describe("delegate pool", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    _resetPoolForTesting();
    ts?.dispose();
    ts = undefined;
  });

  test("prompt is optional for close and list actions", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    // list without prompt should work
    const listResult = await toolDef!.execute(
      "tc-pool-1",
      { tasks: [{ sessionAction: "list" }] },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );
    expect(listResult.content[0].text).toContain("Active sessions");

    // close without prompt should work (even if session doesn't exist)
    const closeResult = await toolDef!.execute(
      "tc-pool-2",
      {
        tasks: [{ sessionAction: "close", sessionId: "nonexistent" }],
      },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );
    expect(closeResult.content[0].text).toContain("not found");
  });

  test("missing prompt throws for non-close/list actions", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    await expect(
      toolDef!.execute(
        "tc-pool-3",
        { tasks: [{ systemPrompt: "test" }] },
        undefined,
        undefined,
        ts.session.extensionRunner as any,
      ),
    ).rejects.toThrow("prompt is required");
  });

  test("close sessionAction requires sessionId", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    const result = await toolDef!.execute(
      "tc-pool-4",
      { tasks: [{ sessionAction: "close", systemPrompt: "test" }] },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );
    expect(result.content[0].text).toContain(
      "sessionAction 'close' requires sessionId",
    );
  });

  test("closePooledAgent aborts, disposes, and removes a live session", async () => {
    const calls: string[] = [];
    // Insert via the public mutator — the raw Map is private. commit on a fresh
    // sessionId stores the frozen config + material.
    commit("test-session", {
      session: {
        async abort() {
          calls.push("abort");
        },
        dispose() {
          calls.push("dispose");
        },
      } as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/test.jsonl",
      frozen: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      tokens: 0,
    });
    expect(configFor("test-session")).toBeDefined();
    expect(await closePooledAgent("test-session")).toBe(true);
    expect(calls).toEqual(["abort", "dispose"]);
    expect(configFor("test-session")).toBeUndefined();
    expect(await closePooledAgent("test-session")).toBe(false);
  });

  test("closePooledAgent disposes and removes after abort timeout", async () => {
    _setPoolAbortTimeoutForTesting(1);
    let disposed = false;
    commit("stalled-close", {
      session: {
        abort: () => new Promise<void>(() => {}),
        dispose() {
          disposed = true;
        },
      } as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/stalled-close.jsonl",
      frozen: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      tokens: 0,
    });

    try {
      let thrown: unknown;
      try {
        await closePooledAgent("stalled-close");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect(String((thrown as AggregateError).errors[0])).toContain(
        "Timed out",
      );
      expect(disposed).toBe(true);
      expect(configFor("stalled-close")).toBeUndefined();
    } finally {
      _setPoolAbortTimeoutForTesting(undefined);
    }
  });

  test("checkout rejects explicit frozen model and prompt changes", () => {
    const frozenModel = { provider: "test", id: "frozen" } as any;
    commit("intent-check", {
      session: {} as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/intent-check.jsonl",
      frozen: {
        systemPrompt: "frozen prompt",
        model: frozenModel,
        thinking: "off" as any,
        tools: ["read"],
        cwd: "/tmp",
      },
      tokens: 0,
    });

    const result = checkout("intent-check", {
      cwd: "/tmp",
      thinking: "off" as any,
      tools: ["read"],
      model: { provider: "test", id: "other" } as any,
      systemPrompt: "different prompt",
    });
    expect(result.status).toBe("mismatch");
    if (result.status !== "mismatch") throw new Error("expected mismatch");
    expect(result.mismatches.map((m) => m.field)).toEqual([
      "model",
      "systemPrompt",
    ]);
  });

  test("closeAllPooledAgents disposes every live session", async () => {
    const disposed: string[] = [];
    for (const id of ["one", "two"]) {
      commit(id, {
        session: {
          async abort() {
            disposed.push(`abort:${id}`);
          },
          dispose() {
            disposed.push(`dispose:${id}`);
          },
        } as any,
        sessionManager: {} as any,
        sessionFile: `/tmp/${id}.jsonl`,
        frozen: {
          systemPrompt: "test",
          model: {} as any,
          thinking: "off" as any,
          tools: [],
          cwd: "/tmp",
        },
        tokens: 0,
      });
    }

    await closeAllPooledAgents();
    expect(disposed).toHaveLength(4);
    expect(disposed.indexOf("abort:one")).toBeLessThan(
      disposed.indexOf("dispose:one"),
    );
    expect(disposed.indexOf("abort:two")).toBeLessThan(
      disposed.indexOf("dispose:two"),
    );
    expect(listPooledAgents()).toEqual(["_(no active sessions)_"]);
  });

  test("closePooledAgent waits for an active lifecycle lock before disposal", async () => {
    const calls: string[] = [];
    const payload = {
      session: {
        async abort() {
          calls.push("abort");
        },
        dispose() {
          calls.push("dispose");
        },
      } as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/close-race.jsonl",
      frozen: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      tokens: 0,
    };
    commit("close-race", payload);

    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const inFlight = withSessionLock("close-race", async () => {
      markEntered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await entered;

    const close = closePooledAgent("close-race");

    // The live lock should block the close until we release it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);

    release();
    await Promise.all([inFlight, close]);
    expect(calls).toEqual(["abort", "dispose"]);
  });

  test("closeAllPooledAgents requests abort under active lock, disposes after release", async () => {
    const calls: string[] = [];
    const payload = {
      session: {
        async abort() {
          calls.push("abort");
        },
        dispose() {
          calls.push("dispose");
        },
      } as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/shutdown-race.jsonl",
      frozen: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      tokens: 0,
    };
    commit("shutdown-race", payload);

    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const inFlight = withSessionLock("shutdown-race", async () => {
      markEntered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      // Mirrors a successful lifecycle committing after shutdown has requested
      // cancellation but before it can acquire this session's lock.
      commit("shutdown-race", payload);
    });
    await entered;

    const closing = closeAllPooledAgents();

    // The live lock should block shutdown disposal, but abort should still be
    // requested immediately while the lock is held.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual(["abort"]);
    expect(configFor("shutdown-race")).toBeDefined();

    release();
    await Promise.all([inFlight, closing]);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(["abort", "dispose"]);
    expect(calls.indexOf("abort")).toBeLessThan(calls.indexOf("dispose"));
    expect(configFor("shutdown-race")).toBeUndefined();
  });

  test("public close waits for shutdown and returns false", async () => {
    const calls: string[] = [];
    const payload = {
      session: {
        async abort() {
          calls.push("abort");
        },
        dispose() {
          calls.push("dispose");
        },
      } as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/public-close-during-shutdown.jsonl",
      frozen: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      tokens: 0,
    };
    commit("public-close-shutdown", payload);

    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const inFlight = withSessionLock("public-close-shutdown", async () => {
      markEntered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await entered;

    const closing = closeAllPooledAgents();
    const publicClose = closePooledAgent("public-close-shutdown");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual(["abort"]);

    release();
    const result = await publicClose;
    await closing;

    expect(result).toBe(false);
    expect(calls).toEqual(["abort", "dispose"]);
    expect(calls.indexOf("abort")).toBeLessThan(calls.indexOf("dispose"));
    expect(listPooledAgents()).toEqual(["_(no active sessions)_"]);
    await Promise.all([inFlight]);
  });

  test("closeAllPooledAgents is idempotent", async () => {
    const calls: string[] = [];
    commit("idempotent", {
      session: {
        async abort() {
          calls.push("abort");
        },
        dispose() {
          calls.push("dispose");
        },
      } as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/idempotent.jsonl",
      frozen: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      tokens: 0,
    });

    const a = closeAllPooledAgents();
    const b = closeAllPooledAgents();
    await Promise.all([a, b]);
    expect(calls).toEqual(["abort", "dispose"]);
    expect(listPooledAgents()).toEqual(["_(no active sessions)_"]);
  });

  test("closeAllPooledAgents concurrent callers receive shared failure outcome", async () => {
    const calls: string[] = [];
    commit("failure-share", {
      session: {
        async abort() {
          calls.push("abort");
        },
        dispose() {
          calls.push("dispose");
          throw new Error("dispose failed");
        },
      } as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/failure-share.jsonl",
      frozen: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      tokens: 0,
    });

    const first = closeAllPooledAgents();
    const second = closeAllPooledAgents();
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes[0].status).toBe("rejected");
    expect(outcomes[1].status).toBe("rejected");
    expect(calls).toEqual(["abort", "dispose"]);
    expect((outcomes[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      AggregateError,
    );
    expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      AggregateError,
    );
    // Shared completion path means both callers observe the same failure contract.
    expect(listPooledAgents()).toEqual(["_(no active sessions)_"]);
  });

  test("shutdown rejects late commit inserts", async () => {
    const calls: string[] = [];
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const inFlight = withSessionLock("pool-miss-race", async () => {
      markEntered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await entered;

    const closing = closeAllPooledAgents();

    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await inFlight;

    const committed = commit("pool-miss-race", {
      session: {
        abort: async () => {
          calls.push("abort");
        },
        dispose() {
          calls.push("dispose");
        },
      } as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/pool-miss-race.jsonl",
      frozen: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      tokens: 0,
    });

    await closing;
    expect(committed).toBe(false);
    expect(configFor("pool-miss-race")).toBeUndefined();
    // Lifecycle owns late materialization commits during shutdown and must dispose
    // the session itself when commit returns false.
    expect(calls).toEqual([]);
  });

  test("listPooledAgents shows stats for live sessions", () => {
    _resetPoolForTesting();
    expect(listPooledAgents()).toEqual(["_(no active sessions)_"]);

    // Three completed prompts on the same live session ID.
    // The first inserts; the next two are pool hits recorded as additional
    // uses against the existing entry.
    const base = {
      session: {} as any,
      sessionManager: {} as any,
      sessionFile: "/home/user/.pi/agent/sessions/test.jsonl",
      frozen: {
        systemPrompt: "test",
        model: { id: "test-model" } as any,
        thinking: "off" as any,
        tools: ["read"],
        cwd: "/tmp",
      },
    };
    commit("session-a", { ...base, tokens: 412 });
    recordUse("session-a", 412);
    recordUse("session-a", 410);
    const lines = listPooledAgents();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("session-a");
    expect(lines[0]).toContain("3 prompts");
    expect(lines[0]).toContain("1.2k tokens");
    expect(lines[0]).toContain("test.jsonl"); // shortened path
  });

  test("withSessionLock serializes concurrent access", async () => {
    const order: string[] = [];
    const p1 = withSessionLock("mutex-test", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-end");
      return "a";
    });
    const p2 = withSessionLock("mutex-test", async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("b-end");
      return "b";
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    // a must complete before b starts
    expect(order.indexOf("a-end")).toBeLessThan(order.indexOf("b-start"));
  });

  test("withSessionLock queues multiple waiters without thundering herd", async () => {
    const order: string[] = [];
    const p1 = withSessionLock("herd-test", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-end");
      return "a";
    });
    const p2 = withSessionLock("herd-test", async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("b-end");
      return "b";
    });
    const p3 = withSessionLock("herd-test", async () => {
      order.push("c-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("c-end");
      return "c";
    });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(r3).toBe("c");
    // Only one task should ever be running at a time
    let running = 0;
    let maxConcurrent = 0;
    for (const entry of order) {
      if (entry.endsWith("-start")) running++;
      else if (entry.endsWith("-end")) running--;
      maxConcurrent = Math.max(maxConcurrent, running);
    }
    expect(maxConcurrent).toBe(1);
  });
});

// delegate pool describe closes above
// ── Async Ticket Tests ────────────────────────────────────────────────────

describe("async ticket registry", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ticketRegistry.clear();
    // Leaf tracking is module-level and feeds deliverTicketResults; a leaked
    // navigation would silently flip delivery to the cross-leaf path.
    resetLeafTracking();
    _resetPoolForTesting();
    ts?.dispose();
    ts = undefined;
  });

  test("sweepTickets leaves long-running tickets alone", () => {
    const controller = new AbortController();
    const ticket: AsyncTicket = {
      id: "long-running",
      created: Date.now() - 31 * 60 * 1000,
      tasks: [],
      resolved: [],
      status: "running",
      results: [],
      progress: [],
      controller,
      parentModelId: undefined,
    };
    ticketRegistry.set("long-running", ticket);
    sweepTickets();
    expect(ticket.status).toBe("running");
    expect(ticketRegistry.has("long-running")).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  test("sweepTickets cleans up completed tickets after TTL", () => {
    const ticket: AsyncTicket = {
      id: "expired",
      created: Date.now() - 60 * 60 * 1000,
      completedAt: Date.now() - 31 * 60 * 1000, // completed 31 min ago
      tasks: [],
      resolved: [],
      status: "done",
      results: [],
      progress: [],
      controller: new AbortController(),
      parentModelId: undefined,
    };
    ticketRegistry.set("expired", ticket);
    sweepTickets();
    expect(ticketRegistry.has("expired")).toBe(false);
  });

  test("sweepTickets keeps recent completed tickets", () => {
    const ticket: AsyncTicket = {
      id: "recent",
      created: Date.now() - 5000,
      completedAt: Date.now() - 1000,
      tasks: [],
      resolved: [],
      status: "done",
      results: [],
      progress: [],
      controller: new AbortController(),
      parentModelId: undefined,
    };
    ticketRegistry.set("recent", ticket);
    sweepTickets();
    expect(ticketRegistry.has("recent")).toBe(true);
  });

  test("isSessionBusy returns null when no tickets running", () => {
    expect(isSessionBusy("auth")).toBeNull();
  });

  test("isSessionBusy returns ticket id when session is in use", () => {
    const ticket: AsyncTicket = {
      id: "tkt1",
      created: Date.now(),
      tasks: [],
      resolved: [
        {
          prompt: "test",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "inline",
          warnings: [],
          sessionId: "auth",
        },
      ],
      status: "running",
      results: [],
      progress: [],
      controller: new AbortController(),
      parentModelId: undefined,
    };
    ticketRegistry.set("tkt1", ticket);
    expect(isSessionBusy("auth")).toBe("tkt1");
    expect(isSessionBusy("other")).toBeNull();
  });

  test("isSessionBusy treats cancelling tickets as still in use", () => {
    const ticket: AsyncTicket = {
      id: "tkt1",
      created: Date.now(),
      tasks: [],
      resolved: [
        {
          prompt: "test",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "inline",
          warnings: [],
          sessionId: "auth",
        },
      ],
      status: "cancelling",
      results: [],
      progress: [],
      controller: new AbortController(),
      parentModelId: undefined,
    };
    ticketRegistry.set("tkt1", ticket);
    expect(isSessionBusy("auth")).toBe("tkt1");
  });

  test("isSessionBusy ignores non-running tickets", () => {
    const ticket: AsyncTicket = {
      id: "tkt1",
      created: Date.now(),
      tasks: [],
      resolved: [
        {
          prompt: "test",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "inline",
          warnings: [],
          sessionId: "auth",
        },
      ],
      status: "done",
      completedAt: Date.now(),
      results: [],
      progress: [],
      controller: new AbortController(),
      parentModelId: undefined,
    };
    ticketRegistry.set("tkt1", ticket);
    expect(isSessionBusy("auth")).toBeNull();
  });
});

describe("async delegate integration", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ticketRegistry.clear();
    // Leaf tracking is module-level and feeds deliverTicketResults; a leaked
    // navigation would silently flip delivery to the cross-leaf path.
    resetLeafTracking();
    _resetPoolForTesting();
    ts?.dispose();
    ts = undefined;
  });

  test("poll with no tickets returns empty message", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const result = await toolDef!.execute(
      "tc-poll-1",
      { ticketAction: "poll", async: undefined, ticket: undefined },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );
    expect(result.content[0].text).toContain("No async tickets");
  });

  test("poll with no tickets includes a discovery hint", () => {
    const result = handlePoll({ tasks: [], ticket: undefined }, {} as any);
    // Dead-end must self-correct: a confused `ticketAction: "poll"` should point
    // the caller at the spawn syntax and the help path, not strand them.
    expect(result.content[0].text).toContain("No async tickets");
    expect(result.content[0].text).toContain("tasks: [{ agent, prompt }]");
    expect(result.content[0].text).toContain("tasks: []");
  });

  test("poll lists running tickets", () => {
    const ticket: AsyncTicket = {
      id: "abc12345",
      created: Date.now(),
      tasks: [{ prompt: "investigate" }],
      resolved: [
        {
          prompt: "investigate",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "investigate",
          status: "running",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };
    ticketRegistry.set("abc12345", ticket);
    const result = handlePoll({ tasks: [], ticket: undefined }, {} as any);
    expect(result.content[0].text).toContain("abc12345");
    expect(result.content[0].text).toContain("running");
    // Enriched list: agent roster + copy-pasteable poll/cancel controls.
    expect(result.content[0].text).toContain("scout");
    expect(result.content[0].text).toContain(
      'delegate({ ticketAction: "cancel", ticket: "abc12345", force: true })',
    );

    ticket.status = "cancelling";
    const cancellingResult = handlePoll(
      { tasks: [], ticket: undefined },
      {} as any,
    );
    expect(cancellingResult.content[0].text).toContain(
      'delegate({ ticketAction: "poll", ticket: "abc12345" })',
    );
    expect(cancellingResult.content[0].text).not.toContain(
      'delegate({ ticketAction: "cancel", ticket: "abc12345", force: true })',
    );
  });

  test("poll with specific ticket returns progress", () => {
    const ticket: AsyncTicket = {
      id: "xyz98765",
      created: Date.now(),
      tasks: [{ prompt: "check auth" }],
      resolved: [
        {
          prompt: "check auth",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "check auth",
          status: "running",
          durationMs: 1000,
          tokens: 500,
          toolUses: 2,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };
    ticketRegistry.set("xyz98765", ticket);
    const result = handlePoll({ tasks: [], ticket: "xyz98765" }, {} as any);
    expect(result.content[0].text).toContain("xyz98765");
    expect(result.content[0].text).toContain("RUNNING");
  });

  test("poll with cancelling ticket returns CANCELLING status", () => {
    const ticket: AsyncTicket = {
      id: "cancelling1",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "cancelling",
      results: [undefined],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "task-a",
          status: "running",
          durationMs: 1000,
          tokens: 500,
          toolUses: 2,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };
    ticketRegistry.set("cancelling1", ticket);
    const result = handlePoll({ tasks: [], ticket: "cancelling1" }, {} as any);
    expect(result.content[0].text).toContain("cancelling1");
    expect(result.content[0].text).toContain("CANCELLING");
    expect(result.content[0].text).toContain("Cancellation requested");
  });

  test("poll running ticket suppresses the (no output) placeholder for failed tasks", () => {
    const ticket: AsyncTicket = {
      id: "failed-no-output",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [
        {
          agent: "scout",
          output: "(no output)",
          error: "Aborted",
          durationMs: 1000,
          tokens: 0,
          touchedFiles: [],
        },
      ],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "task-a",
          status: "failed",
          durationMs: 1000,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };
    ticketRegistry.set("failed-no-output", ticket);
    const result = handlePoll(
      { tasks: [], ticket: "failed-no-output" },
      {} as any,
    );
    expect(result.content[0].text).toContain("Aborted");
    expect(result.content[0].text).not.toContain("(no output)");
  });

  test("poll returns completed results for running ticket", () => {
    const ticket: AsyncTicket = {
      id: "partial1",
      created: Date.now(),
      tasks: [
        { prompt: "task-a" },
        { prompt: "task-b", id: "task-b" },
        { prompt: "task-c" },
      ],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          id: "task-b",
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "worker",
          warnings: [],
        },
        {
          prompt: "task-c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "runner",
          warnings: [],
        },
      ],
      status: "running",
      results: [
        {
          agent: "scout",
          output: "found it",
          durationMs: 1000,
          tokens: 50,
          touchedFiles: [],
        },
        undefined,
        {
          agent: "runner",
          output: "",
          error: "timeout",
          durationMs: 2000,
          tokens: 0,
          touchedFiles: [],
        },
      ],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "task-a",
          status: "done",
          durationMs: 1000,
          tokens: 50,
          toolUses: 1,
          activities: [],
        },
        {
          index: 1,
          agent: "worker",
          task: "task-b",
          status: "running",
          durationMs: 0,
          tokens: 100,
          toolUses: 3,
          activities: [],
        },
        {
          index: 2,
          agent: "runner",
          task: "task-c",
          status: "failed",
          durationMs: 2000,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };
    ticketRegistry.set("partial1", ticket);

    const result = handlePoll({ ticket: "partial1" }, {} as any);
    const text = result.content[0].text;

    // Header shows finalized count (done + failed) and active count for the
    // still-running task; failed tasks are also called out separately.
    expect(text).toContain("2/3 finalized");
    expect(text).toContain("1 active");
    expect(text).toContain("1 failed");
    // Completed task output is present
    expect(text).toContain("found it");
    // Failed task error is present
    expect(text).toContain("timeout");
    // Running task still shows as running
    expect(text).toContain("worker");

    // details.results is index-aligned — same length as progress
    // Pending results are filled with placeholder TaskResult objects carrying
    // the task id and agent, not sparse holes or bare error objects.
    // The placeholder carries a machine-visible pending marker so consumers
    // checking result.error can tell the task is not yet successful.
    expect(result.details.results).toHaveLength(3);
    expect(result.details.results![0]!.agent).toBe("scout");
    expect(result.details.results![1]).toMatchObject({
      id: "task-b",
      agent: "worker",
      output: "",
      error: "PENDING — result not available",
    });
    expect(result.details.results![2]!.agent).toBe("runner");
  });

  test("poll running-ticket header distinguishes succeeded from failed counts", () => {
    // A running ticket with 2 succeeded, 2 failed, 1 still running.
    // The header must not count failed tasks toward the "done" tally.
    const ticket: AsyncTicket = {
      id: "mixed-running",
      created: Date.now(),
      tasks: [],
      resolved: [],
      status: "running",
      results: [
        mkResult(),
        mkResult(),
        mkResult("err-a"),
        mkResult("err-b"),
        undefined,
      ],
      progress: mkProgress(["done", "done", "failed", "failed", "running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("mixed-running", ticket);

    const result = handlePoll({ ticket: "mixed-running" }, {} as any);
    const text = result.content[0].text;

    // 4 finalized out of 5 (2 succeeded + 2 failed), with 1 still active.
    // The header must not report only the 2 succeeded tasks.
    expect(text).toContain("4/5 finalized");
    expect(text).toContain("1 active");
    expect(text).toContain("2 failed");
    expect(text).not.toContain("2/5 finalized");
  });

  test("poll running ticket surfaces partial overlap warning from completed tasks", () => {
    const shared = "/tmp/shared.txt";
    const ticket: AsyncTicket = {
      id: "partial-overlap",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }, { prompt: "task-c" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "a",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "b",
          warnings: [],
        },
        {
          prompt: "task-c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "c",
          warnings: [],
        },
      ],
      status: "running",
      results: [
        {
          agent: "a",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        {
          agent: "b",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        undefined,
      ],
      progress: [
        {
          index: 0,
          agent: "a",
          task: "task-a",
          status: "done",
          durationMs: 100,
          tokens: 10,
          toolUses: 1,
          activities: [],
        },
        {
          index: 1,
          agent: "b",
          task: "task-b",
          status: "done",
          durationMs: 100,
          tokens: 10,
          toolUses: 1,
          activities: [],
        },
        {
          index: 2,
          agent: "c",
          task: "task-c",
          status: "running",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };
    ticketRegistry.set("partial-overlap", ticket);

    const result = handlePoll({ ticket: "partial-overlap" }, {} as any);

    // The two completed tasks already share an attributed file; the warning must
    // be surfaced in the poll view before the third task settles.
    expect(result.details.overlapWarning).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(shared);
    expect(result.content[0].text).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.content[0].text).toContain(shared);
  });

  test("poll with unknown ticket returns not found", () => {
    const result = handlePoll({ tasks: [], ticket: "nonexistent" }, {} as any);
    expect(result.content[0].text).toContain("not found");
  });

  test("cancel without force returns a non-destructive preview", () => {
    const controller = new AbortController();
    const ticket: AsyncTicket = {
      id: "cancel1",
      created: Date.now(),
      tasks: [],
      resolved: [],
      status: "running",
      results: [],
      progress: [],
      controller,
      parentModelId: undefined,
    };
    ticketRegistry.set("cancel1", ticket);
    const result = handleCancel({ tasks: [], ticket: "cancel1" });
    expect(result.content[0].text).toContain("cancellation preview");
    expect(result.content[0].text).toContain("NOT rolled back");
    expect(result.content[0].text).toContain("force: true");
    expect(ticket.status).toBe("running");
    expect(controller.signal.aborted).toBe(false);
  });

  test("cancel with force aborts a running ticket and transitions to cancelling", () => {
    const controller = new AbortController();
    const ticket: AsyncTicket = {
      id: "cancel1",
      created: Date.now(),
      tasks: [],
      resolved: [],
      status: "running",
      results: [],
      progress: [],
      controller,
      parentModelId: undefined,
    };
    ticketRegistry.set("cancel1", ticket);
    const result = handleCancel({ tasks: [], ticket: "cancel1", force: true });
    expect(result.content[0].text).toContain("cancelling");
    expect(ticket.status).toBe("cancelling");
    expect(ticket.completedAt).toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
  });

  test("cancel without force surfaces partial overlap warning from completed tasks", () => {
    const shared = "/tmp/shared-cancel-preview.txt";
    const controller = new AbortController();
    const ticket: AsyncTicket = {
      id: "cancel-preview-overlap",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }, { prompt: "task-c" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "a",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "b",
          warnings: [],
        },
        {
          prompt: "task-c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "c",
          warnings: [],
        },
      ],
      status: "running",
      results: [
        {
          agent: "a",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        {
          agent: "b",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        undefined,
      ],
      progress: mkProgress(["done", "done", "running"]),
      controller,
      parentModelId: "m",
    };
    ticketRegistry.set("cancel-preview-overlap", ticket);

    const result = handleCancel({ ticket: "cancel-preview-overlap" });

    expect(result.content[0].text).toContain("cancellation preview");
    expect(result.content[0].text).toContain(shared);
    expect(result.content[0].text).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(shared);
    expect(ticket.status).toBe("running");
    expect(controller.signal.aborted).toBe(false);
  });

  test("cancel with force surfaces partial overlap warning from completed tasks", () => {
    const shared = "/tmp/shared-cancel-force.txt";
    const controller = new AbortController();
    const ticket: AsyncTicket = {
      id: "cancel-force-overlap",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }, { prompt: "task-c" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "a",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "b",
          warnings: [],
        },
        {
          prompt: "task-c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "c",
          warnings: [],
        },
      ],
      status: "running",
      results: [
        {
          agent: "a",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        {
          agent: "b",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        undefined,
      ],
      progress: mkProgress(["done", "done", "running"]),
      controller,
      parentModelId: "m",
    };
    ticketRegistry.set("cancel-force-overlap", ticket);

    const result = handleCancel({
      ticket: "cancel-force-overlap",
      force: true,
    });

    expect(result.content[0].text).toContain("cancelling");
    expect(result.content[0].text).toContain(shared);
    expect(result.content[0].text).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(shared);
    expect(ticket.status).toBe("cancelling");
    expect(controller.signal.aborted).toBe(true);
  });

  test("cancel requires ticket ID", () => {
    const result = handleCancel({ tasks: [], ticket: undefined });
    expect(result.content[0].text).toContain("requires a ticket ID");
  });

  test("cancel on already completed ticket returns status", () => {
    const ticket: AsyncTicket = {
      id: "done1",
      created: Date.now(),
      completedAt: Date.now(),
      tasks: [],
      resolved: [],
      status: "done",
      results: [],
      progress: [],
      controller: new AbortController(),
      parentModelId: undefined,
    };
    ticketRegistry.set("done1", ticket);
    const result = handleCancel({ tasks: [], ticket: "done1" });
    expect(result.content[0].text).toContain("already done");
  });

  test("formatCompletedTicket preserves index alignment for cancelled ticket with partial results", () => {
    const ticket: AsyncTicket = {
      id: "cancelled-partial",
      created: Date.now() - 2000,
      completedAt: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }, { prompt: "task-c" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          id: "task-b",
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "worker",
          warnings: [],
        },
        {
          id: "task-c",
          prompt: "task-c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "runner",
          warnings: [],
        },
      ],
      status: "cancelled",
      results: [
        {
          agent: "scout",
          output: "done early",
          durationMs: 500,
          tokens: 10,
          touchedFiles: [],
        },
        undefined, // task-b never started
        undefined, // task-c never started
      ],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "task-a",
          status: "done",
          durationMs: 500,
          tokens: 10,
          toolUses: 0,
          activities: [],
        },
        {
          index: 1,
          agent: "worker",
          task: "task-b",
          status: "pending",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
        {
          index: 2,
          agent: "runner",
          task: "task-c",
          status: "running",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };
    ticketRegistry.set("cancelled-partial", ticket);

    // Simulate poll after cancellation
    const result = handlePoll({ ticket: "cancelled-partial" }, {} as any);
    const text = result.content[0].text;

    // Text output handles undefined results gracefully for cancelled tickets.
    expect(text).toContain("done early");
    expect(text).toContain("CANCELLED — task not started");
    expect(text).toContain(
      "CANCELLED — task aborted mid-run, partial effects possible",
    );

    // details.results is index-aligned — same length as tasks
    // Undefined results are filled with full TaskResult placeholders carrying
    // the task id, agent, and the cancelled-pending error message.
    expect(result.details.results).toHaveLength(3);
    expect(result.details.results![0]!.agent).toBe("scout");
    expect(result.details.results![1]).toMatchObject({
      id: "task-b",
      agent: "worker",
      output: "",
      error: "CANCELLED — task not started",
    });
    expect(result.details.results![2]).toMatchObject({
      id: "task-c",
      agent: "runner",
      output: "",
      error: "CANCELLED — task aborted mid-run, partial effects possible",
    });
  });

  test("execute rejects top-level cancel without a ticket", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    const result = await toolDef!.execute(
      "tc-cancel-frontdoor",
      { ticketAction: "cancel" },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain(
      "ticketAction 'cancel' requires ticket",
    );
  });

  test("deliverTicketResults sends formatted task output", () => {
    const sent: any[] = [];
    const ticket: AsyncTicket = {
      id: "done2",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "find the bug" }],
      resolved: [
        {
          prompt: "find the bug",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "done",
      results: [
        {
          agent: "scout",
          output: "found the bug",
          durationMs: 1234,
          tokens: 42,
          touchedFiles: [],
        },
      ],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "find the bug",
          status: "done",
          durationMs: 1234,
          tokens: 42,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "test-model",
    };

    deliverTicketResults(
      {
        sendMessage: (message: any, options: any) =>
          sent.push({ message, options }),
      } as any,
      ticket,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].message.content).toContain("1/1 tasks completed");
    expect(sent[0].message.content).toContain("found the bug");
    expect(sent[0].message.details.ticketId).toBe("done2");
    expect(sent[0].message.details.status).toBe("done");
    expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  // ── resolveFinalTicketStatus: status resolution for settled batches ──────
  // Regression coverage for the bug where partial/failed tickets were
  // mislabeled as "done" (the dead `else` branch in execute()'s .then()).
  // A ticket is "done" only when every task settled successfully.
  const mkProgress = (
    statuses: Array<"done" | "failed" | "running" | "pending">,
  ): TaskProgress[] =>
    statuses.map((status, index) => ({
      index,
      agent: "scout",
      task: `task-${index}`,
      status,
      durationMs: 100,
      tokens: 10,
      toolUses: 0,
      activities: [],
    }));

  const mkResult = (error?: string): TaskResult => ({
    agent: "scout",
    output: error ? "" : "ok",
    error,
    durationMs: 100,
    tokens: 10,
    touchedFiles: [],
  });

  const mkActivity = (
    name: string,
    args: Record<string, unknown>,
    result?: {
      content: Array<{ type: string; text?: string }>;
      isError: boolean;
    },
    startOffset = 0,
  ): ToolActivity => ({
    id: Math.random().toString(36).slice(2, 10),
    name,
    args,
    startTime: Date.now() - startOffset,
    endTime: result ? Date.now() - startOffset + 100 : undefined,
    result,
  });

  test("resolveFinalTicketStatus: all tasks succeed => done", () => {
    const ticket: AsyncTicket = {
      id: "all-ok",
      created: Date.now(),
      tasks: [],
      resolved: [],
      status: "running",
      results: [mkResult(), mkResult()],
      progress: mkProgress(["done", "done"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    expect(resolveFinalTicketStatus(ticket)).toBe("done");
  });

  test("resolveFinalTicketStatus: one task failed => failed", () => {
    const ticket: AsyncTicket = {
      id: "one-fail",
      created: Date.now(),
      tasks: [],
      resolved: [],
      status: "running",
      results: [mkResult(), mkResult("timeout")],
      progress: mkProgress(["done", "failed"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    expect(resolveFinalTicketStatus(ticket)).toBe("failed");
  });

  test("resolveFinalTicketStatus: partial (not all settled) => failed, not done", () => {
    // Reproduces the original bug: a partially-settled batch (e.g. aborted
    // mid-flight, leaving a progress row still "running") was labeled "done".
    // It must be "failed" so incomplete work is never masked as complete.
    const ticket: AsyncTicket = {
      id: "partial",
      created: Date.now(),
      tasks: [],
      resolved: [],
      status: "running",
      results: [mkResult(), undefined],
      progress: mkProgress(["done", "running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    expect(resolveFinalTicketStatus(ticket)).toBe("failed");
  });

  test("resolveFinalTicketStatus: all pending (nothing ran) => failed", () => {
    const ticket: AsyncTicket = {
      id: "nothing-ran",
      created: Date.now(),
      tasks: [],
      resolved: [],
      status: "running",
      results: [undefined, undefined],
      progress: mkProgress(["pending", "pending"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    expect(resolveFinalTicketStatus(ticket)).toBe("failed");
  });

  test("resolveFinalTicketStatus: empty batch => done (vacuously all settled)", () => {
    const ticket: AsyncTicket = {
      id: "empty",
      created: Date.now(),
      tasks: [],
      resolved: [],
      status: "running",
      results: [],
      progress: [],
      controller: new AbortController(),
      parentModelId: "m",
    };
    expect(resolveFinalTicketStatus(ticket)).toBe("done");
  });

  test("formatCompletedTicket surfaces FAILED status tag for failed ticket", () => {
    const ticket: AsyncTicket = {
      id: "failed-ticket",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "worker",
          warnings: [],
        },
      ],
      status: "failed",
      results: [mkResult(), mkResult("boom")],
      progress: mkProgress(["done", "failed"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    const result = formatCompletedTicket(ticket);
    const text = result.content[0]!.text;
    // Header must announce failure, not just "1/2 tasks completed"
    expect(text).toContain("FAILED");
    expect(text).toContain("1/2 tasks completed");
    // Failed task body is still present
    expect(text).toContain("boom");
  });

  test("formatCompletedTicket surfaces CANCELLED status tag for cancelled ticket", () => {
    const ticket: AsyncTicket = {
      id: "cancelled-ticket",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "cancelled",
      results: [mkResult()],
      progress: mkProgress(["done"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    const result = formatCompletedTicket(ticket);
    const text = result.content[0]!.text;
    expect(text).toContain("CANCELLED");
  });

  test("formatCompletedTicket omits status tag for done ticket", () => {
    const ticket: AsyncTicket = {
      id: "done-ticket",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "done",
      results: [mkResult()],
      progress: mkProgress(["done"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    const result = formatCompletedTicket(ticket);
    const text = result.content[0]!.text;
    // No status tag for a successful ticket — header stays as before
    expect(text).not.toContain("FAILED");
    expect(text).not.toContain("CANCELLED");
    expect(text).toContain("1/1 tasks completed");
  });

  test("formatCompletedTicket overwrites pending placeholder with a human-readable label", () => {
    // The pending placeholder carries a machine-visible marker, but the final
    // formatted delivery must replace it with a human-readable message so the
    // LLM/TUI sees a descriptive status rather than an internal constant.
    const ticket: AsyncTicket = {
      id: "failed-with-pending",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "worker",
          warnings: [],
        },
      ],
      status: "failed",
      results: [mkResult("boom"), undefined],
      progress: mkProgress(["failed", "pending"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    const result = formatCompletedTicket(ticket);

    expect(result.details.results).toHaveLength(2);
    expect(result.details.results![0]!.error).toBe("boom");
    expect(result.details.results![1]!.error).toBe(
      "PENDING — result not available",
    );
    expect(result.content[0]!.text).toContain("PENDING — result not available");
  });

  test("formatCompletedTicket keeps FULL output in details.results[i].output even when spilled from content", () => {
    // The one-source-two-projections invariant: the LLM-facing `content` is
    // bounded (tail + pointer), but `details.results[i].output` still carries
    // the full unmodified output for the human's expanded TUI view.
    const head = "HEADMARKER" + "a".repeat(4000);
    const tail = "b".repeat(4000) + "TAILMARKER"; // total > 8000 default threshold
    const fullOutput = head + tail;
    const ticket: AsyncTicket = {
      id: "spill-invariant-ticket",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "big-task" }],
      resolved: [
        {
          prompt: "big-task",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "done",
      results: [
        {
          agent: "scout",
          output: fullOutput,
          durationMs: 100,
          tokens: 10,
          touchedFiles: [],
        },
      ],
      progress: mkProgress(["done"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    const result = formatCompletedTicket(ticket);
    const text = result.content[0]!.text;
    // Content is bounded: tail present, head absent, pointer present.
    expect(text).toContain("TAILMARKER");
    expect(text).not.toContain("HEADMARKER");
    expect(text).toContain("spilled to");
    // THE INVARIANT: details carries the full, unmodified output.
    const detailResult = result.details.results[0] as TaskResult;
    expect(detailResult.output).toBe(fullOutput);
    // Clean up the spill file the production path wrote.
    const m = text.match(/spilled to (.+?) —/);
    if (m) {
      try {
        fs.rmSync(m[1]!, { force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  test("help text includes async mode section", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const result = await toolDef!.execute(
      "tc-help-async",
      { tasks: [], async: undefined, ticket: undefined },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );
    expect(result.content[0].text).toContain("Async Mode");
    expect(result.content[0].text).toContain("async: true");
    expect(result.content[0].text).toContain("poll");
    expect(result.content[0].text).toContain("cancel");
    expect(result.content[0].text).toContain("timeoutMs: 600000");
    expect(result.content[0].text).not.toContain("timeoutMs: 600_000");
  });

  test("poll running ticket exposes activity, tool and token counts", () => {
    const now = Date.now();
    const ticket: AsyncTicket = {
      id: "active-tool",
      created: now - 60_000,
      tasks: [{ prompt: "work" }],
      resolved: [
        {
          prompt: "work",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "work",
          status: "running",
          durationMs: 5000,
          tokens: 1234,
          toolUses: 3,
          lastActivityAt: now - 2000,
          activities: [
            mkActivity(
              "read",
              { path: "/tmp/foo" },
              { content: [], isError: false },
              5000,
            ),
            mkActivity("bash", { command: "echo hi" }, undefined, 2000),
          ],
        },
      ],
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("active-tool", ticket);

    const result = handlePoll({ ticket: "active-tool" }, {} as any);
    const text = result.content[0].text;

    // Header: finalized/active counts plus aggregate work performed.
    expect(text).toContain("0/1 finalized");
    expect(text).toContain("1 active");
    expect(text).toContain("3 tools");
    expect(text).toContain("1.2k tokens");
    // Running row: current in-flight tool, counts, and activity freshness.
    expect(text).toContain("$ echo hi");
    expect(text).not.toContain("last:");
    expect(text).toMatch(/active \d+s ago/);
  });

  test("poll running ticket shows last completed tool when reasoning", () => {
    const now = Date.now();
    const ticket: AsyncTicket = {
      id: "reasoning",
      created: now - 60_000,
      tasks: [{ prompt: "think" }],
      resolved: [
        {
          prompt: "think",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "think",
          status: "running",
          durationMs: 3000,
          tokens: 500,
          toolUses: 2,
          lastActivityAt: now - 500,
          activities: [
            mkActivity(
              "write",
              { path: "/tmp/bar", content: "x" },
              { content: [], isError: false },
              500,
            ),
          ],
        },
      ],
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("reasoning", ticket);

    const result = handlePoll({ ticket: "reasoning" }, {} as any);
    const text = result.content[0].text;

    // Between tool calls the latest completed activity is surfaced, not blank.
    expect(text).toContain("0/1 finalized");
    expect(text).toContain("1 active");
    expect(text).toContain("last: write /tmp/bar");
    expect(text).toContain("2 tools");
    expect(text).toContain("500 tokens");
  });

  test("poll running ticket shows genuinely inactive task", () => {
    const now = Date.now();
    const ticket: AsyncTicket = {
      id: "inactive",
      created: now - 60_000,
      tasks: [{ prompt: "stuck" }],
      resolved: [
        {
          prompt: "stuck",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "stuck",
          status: "running",
          durationMs: 60_000,
          tokens: 0,
          toolUses: 0,
          lastActivityAt: now - 5 * 60 * 1000,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("inactive", ticket);

    const result = handlePoll({ ticket: "inactive" }, {} as any);
    const text = result.content[0].text;

    // No tool has ever started, but the row still reports the stale activity age.
    expect(text).toContain("0/1 finalized");
    expect(text).toContain("thinking");
    expect(text).toMatch(/active \d+m ago/);
    expect(text).not.toContain("last:");
  });

  test("poll running ticket header counts finalized, active, queued, and failed", () => {
    const now = Date.now();
    const ticket: AsyncTicket = {
      id: "mixed-phases",
      created: now - 60_000,
      tasks: [
        { prompt: "a" },
        { prompt: "b" },
        { prompt: "c" },
        { prompt: "d" },
      ],
      resolved: [
        {
          prompt: "a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          prompt: "b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          prompt: "c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          prompt: "d",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [mkResult(), mkResult("boom"), undefined, undefined],
      progress: [
        {
          ...mkProgress(["done"])[0]!,
          toolUses: 2,
          tokens: 100,
          activities: [
            mkActivity(
              "read",
              { path: "/tmp/a" },
              { content: [], isError: false },
              10_000,
            ),
          ],
        },
        {
          ...mkProgress(["failed"])[0]!,
          toolUses: 1,
          tokens: 50,
          activities: [
            mkActivity(
              "bash",
              { command: "x" },
              { content: [], isError: true },
              5000,
            ),
          ],
        },
        {
          ...mkProgress(["running"])[0]!,
          tokens: 0,
          toolUses: 0,
          lastActivityAt: now - 1000,
          activities: [],
        },
        {
          ...mkProgress(["pending"])[0]!,
          tokens: 0,
          toolUses: 0,
        },
      ],
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("mixed-phases", ticket);

    const result = handlePoll({ ticket: "mixed-phases" }, {} as any);
    const text = result.content[0].text;

    expect(text).toContain("2/4 finalized");
    expect(text).toContain("1 active");
    expect(text).toContain("1 queued");
    expect(text).toContain("1 failed");
    expect(text).toContain("3 tools");
    expect(text).toContain("150 tokens");
  });

  test("per-task sessionAction enum does not advertise poll or cancel", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const tasksArraySchema = getTasksArraySchema(toolDef!.parameters as any);
    const taskSchema = tasksArraySchema.items;
    const sessionActionEnum = taskSchema.properties.sessionAction.enum;
    expect(sessionActionEnum).not.toContain("poll");
    expect(sessionActionEnum).not.toContain("cancel");
    expect(sessionActionEnum).toEqual(["prompt", "close", "list"]);
  });

  test("top-level ticketAction enum includes wait", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const schema = toolDef!.parameters as any;
    expect(schema.properties.ticketAction.enum).toContain("wait");
  });

  test("parameter schema includes top-level async ticket controls", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const schema = toolDef!.parameters as any;
    expect(schema.properties.ticketAction.enum).toEqual([
      "poll",
      "cancel",
      "wait",
    ]);
    expect(schema.properties.async).toBeDefined();
    expect(schema.properties.ticket).toBeDefined();
    expect(schema.properties.timeoutMs).toBeDefined();
    expect(schema.properties.timeoutMs.minimum).toBe(0);
    expect(schema.properties.timeoutMs.maximum).toBeUndefined();
    expect(schema.required ?? []).not.toContain("tasks");
  });

  // ── wait tests ───────────────────────────────────────────────────────────

  test("wait requires a ticket ID", async () => {
    const result = await handleWait(
      { ticket: undefined },
      undefined,
      undefined,
      {
        model: { id: "test-model" },
      } as any,
    );
    expect(result.content[0].text).toContain("requires a ticket ID");
  });

  test("wait on unknown ticket returns not found", async () => {
    const result = await handleWait(
      { ticket: "missing" },
      undefined,
      undefined,
      { model: { id: "test-model" } } as any,
    );
    expect(result.content[0].text).toContain("not found");
  });

  test("wait on already-done ticket returns immediately", async () => {
    const ticket: AsyncTicket = {
      id: "done-wait",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "done",
      results: [mkResult()],
      progress: mkProgress(["done"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("done-wait", ticket);

    const result = await handleWait(
      { ticket: "done-wait" },
      undefined,
      undefined,
      {} as any,
    );
    expect(result.content[0].text).toContain("1/1 tasks completed");
  });

  test("wait on already-failed ticket returns immediately", async () => {
    const ticket: AsyncTicket = {
      id: "failed-wait",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "failed",
      results: [mkResult("boom")],
      progress: mkProgress(["failed"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("failed-wait", ticket);

    const result = await handleWait(
      { ticket: "failed-wait" },
      undefined,
      undefined,
      {} as any,
    );
    expect(result.content[0].text).toContain("FAILED");
    expect(result.content[0].text).toContain("boom");
  });

  test("wait does not expire an old running ticket", async () => {
    const controller = new AbortController();
    const ticket: AsyncTicket = {
      id: "old-running-wait",
      created: Date.now() - 31 * 60 * 1000,
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller,
      parentModelId: "m",
    };
    ticketRegistry.set("old-running-wait", ticket);

    const result = await handleWait(
      { ticket: "old-running-wait", timeoutMs: 0 },
      undefined,
      undefined,
      {} as any,
    );
    expect(result.content[0].text).toContain("wait timed out");
    expect(ticket.status).toBe("running");
    expect(controller.signal.aborted).toBe(false);
  });

  test("wait details fill sparse result holes with placeholder TaskResult objects", async () => {
    // Reproduce the sparse-array bug: dispatchAsync pre-allocates results with
    // `new Array(resolved.length)`, leaving holes for pending tasks. Wait/poll
    // details must be a dense array where placeholders carry the task id and
    // agent instead of bare `undefined` or error-only objects.
    const results: (TaskResult | undefined)[] = [mkResult()];
    results.length = 2; // sparse hole at index 1

    const ticket: AsyncTicket = {
      id: "wait-details-placeholder",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b", id: "task-b" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          id: "task-b",
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "worker",
          warnings: [],
        },
      ],
      status: "running",
      results,
      progress: mkProgress(["done", "pending"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("wait-details-placeholder", ticket);

    const result = await handleWait(
      { ticket: "wait-details-placeholder", timeoutMs: 0 },
      undefined,
      undefined,
      {} as any,
    );

    // details.results is index-aligned and dense — the sparse hole is filled.
    // The placeholder carries a machine-visible pending marker; wait/poll
    // consumers can distinguish pending entries from successful ones.
    expect(result.details.results).toHaveLength(2);
    expect(result.details.results![0]).toBe(results[0]);
    const placeholder = result.details.results![1] as TaskResult;
    expect(placeholder).toBeDefined();
    expect(placeholder.id).toBe("task-b");
    expect(placeholder.agent).toBe("worker");
    expect(placeholder.output).toBe("");
    expect(placeholder.error).toBe("PENDING — result not available");
    expect(placeholder.durationMs).toBe(0);
    expect(placeholder.tokens).toBe(0);
    expect(placeholder.touchedFiles).toEqual([]);
    expect(placeholder.attributedFiles).toEqual([]);
  });

  test("wait resolves when ticket completes", async () => {
    const ticket: AsyncTicket = {
      id: "complete-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("complete-wait", ticket);

    // Complete the ticket after a brief delay, mimicking the async dispatch path.
    setTimeout(() => {
      ticket.results = [mkResult()];
      ticket.progress = mkProgress(["done"]);
      ticket.status = "done";
      ticket.completedAt = Date.now();
      deliverTicketResults({ sendMessage: () => {} } as any, ticket);
    }, 10);

    const result = await handleWait(
      { ticket: "complete-wait" },
      undefined,
      undefined,
      {} as any,
    );
    expect(result.content[0].text).toContain("1/1 tasks completed");
  });

  test("wait on cancelling ticket resolves when shutdown finalizes it", async () => {
    const ticket: AsyncTicket = {
      id: "cancel-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "worker",
          warnings: [],
        },
      ],
      status: "cancelling",
      results: [
        {
          agent: "scout",
          output: "done early",
          durationMs: 500,
          tokens: 10,
          touchedFiles: [],
        },
        undefined,
      ],
      progress: [
        {
          index: 0,
          agent: "scout",
          task: "task-a",
          status: "done",
          durationMs: 500,
          tokens: 10,
          toolUses: 0,
          activities: [],
        },
        {
          index: 1,
          agent: "worker",
          task: "task-b",
          status: "pending",
          durationMs: 0,
          tokens: 0,
          toolUses: 0,
          activities: [],
        },
      ],
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("cancel-wait", ticket);

    setTimeout(() => {
      cancelTicketForShutdown(ticket);
    }, 10);

    const result = await handleWait(
      { ticket: "cancel-wait" },
      undefined,
      undefined,
      {} as any,
    );
    expect(result.content[0].text).toContain("CANCELLED");
    expect(result.content[0].text).toContain("CANCELLED — task not started");
    expect(result.details.status).toBe("cancelled");
    expect(ticket.completedAt).toBeDefined();
    expect(ticket.controller.signal.aborted).toBe(true);
  });

  test("wait timeout returns running status and does not cancel ticket", async () => {
    const controller = new AbortController();
    const ticket: AsyncTicket = {
      id: "timeout-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller,
      parentModelId: "m",
    };
    ticketRegistry.set("timeout-wait", ticket);

    const result = await handleWait(
      { ticket: "timeout-wait", timeoutMs: 10 },
      undefined,
      undefined,
      {} as any,
    );
    expect(result.content[0].text).toContain("still running");
    expect(result.content[0].text).toContain("timed out");
    expect(ticket.status).toBe("running");
    expect(controller.signal.aborted).toBe(false);
  });

  test("wait chunks oversized timeouts instead of firing immediately", async () => {
    const ticket: AsyncTicket = {
      id: "oversized-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("oversized-wait", ticket);

    const parentController = new AbortController();
    setTimeout(() => parentController.abort(), 10);
    const result = await handleWait(
      { ticket: "oversized-wait", timeoutMs: 2 ** 31 },
      parentController.signal,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("aborted");
    expect(result.content[0].text).not.toContain("timed out");
    expect(ticket.status).toBe("running");
  });

  test("wait parent abort returns running status and does not cancel ticket", async () => {
    const controller = new AbortController();
    const parentController = new AbortController();
    const ticket: AsyncTicket = {
      id: "abort-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller,
      parentModelId: "m",
    };
    ticketRegistry.set("abort-wait", ticket);

    setTimeout(() => {
      parentController.abort();
    }, 10);

    const result = await handleWait(
      { ticket: "abort-wait" },
      parentController.signal,
      undefined,
      {} as any,
    );
    expect(result.content[0].text).toContain("aborted");
    expect(ticket.status).toBe("running");
    expect(controller.signal.aborted).toBe(false);
  });

  test("wait forwards progress updates via onUpdate", async () => {
    const ticket: AsyncTicket = {
      id: "progress-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("progress-wait", ticket);

    const updates: any[] = [];
    const onUpdate = (update: any) => updates.push(update);

    const promise = handleWait(
      { ticket: "progress-wait", timeoutMs: 50 },
      undefined,
      onUpdate,
      {} as any,
    );

    // Simulate a progress update from the async dispatch path.
    ticket.progress[0]!.toolUses = 3;
    ticket.progress[0]!.tokens = 150;
    notifyWaiters(ticket);

    await promise;
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]!.details.ticketId).toBe("progress-wait");
    expect(updates.some((u) => u.details.progress[0]!.toolUses === 3)).toBe(
      true,
    );
  });

  test("throwing wait progress callbacks do not fail the ticket or strand waiters", async () => {
    const ticket: AsyncTicket = {
      id: "throwing-progress-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set(ticket.id, ticket);

    let healthyUpdates = 0;
    const throwingWait = handleWait(
      { ticket: ticket.id },
      undefined,
      () => {
        throw new Error("progress observer failed");
      },
      {} as any,
    );
    const healthyWait = handleWait(
      { ticket: ticket.id },
      undefined,
      () => {
        healthyUpdates++;
      },
      {} as any,
    );

    // The bad observer must not escape notifyWaiters, fail the ticket, or
    // prevent the next waiter from receiving its immediate frame.
    expect(ticket.status).toBe("running");
    expect(healthyUpdates).toBe(1);
    expect(ticket.waiters).toHaveLength(2);

    ticket.results = [mkResult()];
    ticket.progress = mkProgress(["done"]);
    ticket.status = "done";
    ticket.completedAt = Date.now();
    deliverTicketResults({ sendMessage: () => {} } as any, ticket);

    const [throwingResult, healthyResult] = await Promise.all([
      throwingWait,
      healthyWait,
    ]);
    expect(throwingResult.details.status).toBe("done");
    expect(healthyResult.details.status).toBe("done");
    expect(ticket.waiters).toBeUndefined();
  });

  test("notifyWaiters progress frame counts finalized as done + failed", () => {
    const ticket: AsyncTicket = {
      id: "finalized-count",
      created: Date.now(),
      tasks: [{ prompt: "a" }, { prompt: "b" }],
      resolved: [
        {
          prompt: "a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
        {
          prompt: "b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "runner",
          warnings: [],
        },
      ],
      status: "running",
      results: [mkResult(), mkResult("boom")],
      progress: mkProgress(["done", "failed"]),
      controller: new AbortController(),
      parentModelId: "m",
    };

    const updates: any[] = [];
    const waiter = {
      settled: false,
      onUpdate: (update: any) => updates.push(update),
    };
    ticket.waiters = [waiter as any];
    notifyWaiters(ticket);

    expect(updates[0]!.content[0]!.text).toContain("2/2 finalized");
    expect(updates[0]!.content[0]!.text).toContain("1 failed");
    expect(updates[0]!.content[0]!.text).not.toContain("1/2 finalized");
  });

  test("notifyWaiters does not emit RUNNING updates for terminal tickets", () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      const ticket: AsyncTicket = {
        id: `terminal-${status}`,
        created: Date.now(),
        tasks: [{ prompt: "task-a" }],
        resolved: [
          {
            prompt: "task-a",
            model: {} as any,
            tools: [],
            thinking: "off",
            systemPrompt: "",
            cwd: "/tmp",
            agentName: "scout",
            warnings: [],
          },
        ],
        status,
        results: [status === "failed" ? mkResult("boom") : mkResult()],
        progress: mkProgress([status === "failed" ? "failed" : "done"]),
        controller: new AbortController(),
        parentModelId: "m",
      };

      const updates: any[] = [];
      ticket.waiters = [
        {
          settled: false,
          onUpdate: (update: any) => updates.push(update),
        } as any,
      ];
      notifyWaiters(ticket);

      expect(updates).toHaveLength(0);
      expect(ticket.waiters.length).toBe(1);
    }
  });

  test("notifyWaiters emits a CANCELLING update for a cancelling ticket", () => {
    const ticket: AsyncTicket = {
      id: "cancelling-notify",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "cancelling",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };

    const updates: any[] = [];
    ticket.waiters = [
      {
        settled: false,
        onUpdate: (update: any) => updates.push(update),
      } as any,
    ];
    notifyWaiters(ticket);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.content[0]!.text).toContain("CANCELLING");
  });

  test("wait resolves with terminal result and suppresses automatic follow-up", async () => {
    const sent: any[] = [];
    const pi = {
      sendMessage: (message: any, options: any) =>
        sent.push({ message, options }),
    } as any;
    const ticket: AsyncTicket = {
      id: "suppressed-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("suppressed-wait", ticket);

    const promise = handleWait(
      { ticket: "suppressed-wait" },
      undefined,
      undefined,
      {} as any,
    );

    setTimeout(() => {
      ticket.results = [mkResult()];
      ticket.progress = mkProgress(["done"]);
      ticket.status = "done";
      ticket.completedAt = Date.now();
      deliverTicketResults(pi, ticket);
    }, 10);

    const result = await promise;
    expect(result.content[0].text).toContain("1/1 tasks completed");
    expect(sent).toHaveLength(0);
  });

  test("deliverTicketResults sends follow-up when no caller waits", async () => {
    const sent: any[] = [];
    const pi = {
      sendMessage: (message: any, options: any) =>
        sent.push({ message, options }),
    } as any;
    const ticket: AsyncTicket = {
      id: "followup-wait",
      created: Date.now() - 1000,
      completedAt: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "done",
      results: [mkResult()],
      progress: mkProgress(["done"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("followup-wait", ticket);

    deliverTicketResults(pi, ticket);

    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  test("wait resolves when completion races waiter registration", async () => {
    const ticket: AsyncTicket = {
      id: "race-wait",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "scout",
          warnings: [],
        },
      ],
      status: "running",
      results: [undefined],
      progress: mkProgress(["running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("race-wait", ticket);

    const promise = handleWait(
      { ticket: "race-wait" },
      undefined,
      undefined,
      {} as any,
    );

    // Complete synchronously in the same event-loop turn as handleWait returned.
    ticket.results = [mkResult()];
    ticket.progress = mkProgress(["done"]);
    ticket.status = "done";
    ticket.completedAt = Date.now();
    deliverTicketResults({ sendMessage: () => {} } as any, ticket);

    const result = await promise;
    expect(result.content[0].text).toContain("1/1 tasks completed");
  });

  test("wait progress update surfaces partial overlap warning from completed tasks", () => {
    const shared = "/tmp/shared-wait-update.txt";
    const ticket: AsyncTicket = {
      id: "wait-overlap-update",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }, { prompt: "task-c" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "a",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "b",
          warnings: [],
        },
        {
          prompt: "task-c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "c",
          warnings: [],
        },
      ],
      status: "running",
      results: [
        {
          agent: "a",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        {
          agent: "b",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        undefined,
      ],
      progress: mkProgress(["done", "done", "running"]),
      controller: new AbortController(),
      parentModelId: "m",
    };
    ticketRegistry.set("wait-overlap-update", ticket);

    const updates: any[] = [];
    ticket.waiters = [
      {
        settled: false,
        onUpdate: (update: any) => updates.push(update),
      } as any,
    ];
    notifyWaiters(ticket);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.content[0]!.text).toContain("2/3 finalized");
    expect(updates[0]!.content[0]!.text).toContain(shared);
    expect(updates[0]!.content[0]!.text).toContain(
      "does not isolate or serialize file access",
    );
    expect(updates[0]!.details.overlapWarning).toContain(
      "does not isolate or serialize file access",
    );
    expect(updates[0]!.details.overlapWarning).toContain(shared);
  });

  test("wait timeout surfaces partial overlap warning from completed tasks", async () => {
    const shared = "/tmp/shared-wait-timeout.txt";
    const controller = new AbortController();
    const ticket: AsyncTicket = {
      id: "wait-overlap-timeout",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }, { prompt: "task-c" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "a",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "b",
          warnings: [],
        },
        {
          prompt: "task-c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "c",
          warnings: [],
        },
      ],
      status: "running",
      results: [
        {
          agent: "a",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        {
          agent: "b",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        undefined,
      ],
      progress: mkProgress(["done", "done", "running"]),
      controller,
      parentModelId: "m",
    };
    ticketRegistry.set("wait-overlap-timeout", ticket);

    const result = await handleWait(
      { ticket: "wait-overlap-timeout", timeoutMs: 0 },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("wait timed out");
    expect(result.content[0].text).toContain(shared);
    expect(result.content[0].text).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(shared);
    expect(ticket.status).toBe("running");
    expect(controller.signal.aborted).toBe(false);
  });

  test("wait abort surfaces partial overlap warning from completed tasks", async () => {
    const shared = "/tmp/shared-wait-abort.txt";
    const controller = new AbortController();
    const parentController = new AbortController();
    parentController.abort();
    const ticket: AsyncTicket = {
      id: "wait-overlap-abort",
      created: Date.now(),
      tasks: [{ prompt: "task-a" }, { prompt: "task-b" }, { prompt: "task-c" }],
      resolved: [
        {
          prompt: "task-a",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "a",
          warnings: [],
        },
        {
          prompt: "task-b",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "b",
          warnings: [],
        },
        {
          prompt: "task-c",
          model: {} as any,
          tools: [],
          thinking: "off",
          systemPrompt: "",
          cwd: "/tmp",
          agentName: "c",
          warnings: [],
        },
      ],
      status: "running",
      results: [
        {
          agent: "a",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        {
          agent: "b",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        undefined,
      ],
      progress: mkProgress(["done", "done", "running"]),
      controller,
      parentModelId: "m",
    };
    ticketRegistry.set("wait-overlap-abort", ticket);

    const result = await handleWait(
      { ticket: "wait-overlap-abort" },
      parentController.signal,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("aborted");
    expect(result.content[0].text).toContain(shared);
    expect(result.content[0].text).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(
      "does not isolate or serialize file access",
    );
    expect(result.details.overlapWarning).toContain(shared);
    expect(ticket.status).toBe("running");
    expect(controller.signal.aborted).toBe(false);
  });
});

// ── getHostDeps: extension policy and host-dependency isolation ───────────
// Subagents are headless workers and must not load the parent's interactive
// extensions. A narrow provider allowlist is the only exception. Extension-
// bearing loaders are session-local because AgentSession hands each loader's
// extensionsResult.runtime to an ExtensionRunner whose bindCore() overwrites
// mutable runtime methods.

describe("getHostDeps extension policy and isolation", () => {
  beforeEach(() => {
    _resetHostDepsCacheForTesting();
    _resetDelegateConfigForTesting();
  });
  afterEach(() => {
    _resetHostDepsCacheForTesting();
    _setHostRetryBaseMsForTesting(undefined);
    _resetDelegateConfigForTesting();
  });

  test("resourceLoader reports zero extensions", async () => {
    const deps = await getHostDeps({ cwd: process.cwd() });
    const ext = deps.resourceLoader.getExtensions();
    expect(ext.extensions).toHaveLength(0);
  });

  test("resourceLoader excludes global context but keeps project context", async () => {
    const cwd = makeTempDir("pi-delegate-context-cwd-");
    const agentDir = makeTempDir("pi-delegate-context-agent-");
    const projectContext = "PROJECT_CONTEXT_REACHES_SUBAGENT";
    const globalContext = "GLOBAL_CONTEXT_MUST_NOT_REACH_SUBAGENT";
    writeFileSync(path.join(cwd, "AGENTS.md"), projectContext, "utf-8");
    const globalContextSource = path.join(agentDir, "global-context-source.md");
    writeFileSync(globalContextSource, globalContext, "utf-8");
    symlinkSync(globalContextSource, path.join(agentDir, "AGENTS.md"));

    try {
      const deps = await getHostDeps({ cwd, agentDir });
      const files = deps.resourceLoader.getAgentsFiles().agentsFiles;

      expect(files.map(({ path: filePath }) => path.resolve(filePath))).toEqual(
        [path.resolve(cwd, "AGENTS.md")],
      );
      expect(files.map(({ content }) => content)).toEqual([projectContext]);
      expect(files.map(({ content }) => content)).not.toContain(globalContext);
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("resourceLoader is cached/shared across calls for same cwd", async () => {
    const a = await getHostDeps({ cwd: process.cwd() });
    const b = await getHostDeps({ cwd: process.cwd() });
    // Same cached instance — the documented optimization. Safe because no
    // extensions means no handlers bind to the shared runtime.
    expect(b.resourceLoader).toBe(a.resourceLoader);
    expect(b.resourceLoader.getExtensions().extensions).toHaveLength(0);
  });

  test("a new dispatch generation rebuilds cached host dependencies", async () => {
    const first = await getHostDeps({ cwd: process.cwd() });
    invalidateHostDepsCache();
    const second = await getHostDeps({ cwd: process.cwd() });

    expect(second).not.toBe(first);
    expect(second.modelRuntime).not.toBe(first.modelRuntime);
    expect(second.resourceLoader).not.toBe(first.resourceLoader);
  });

  test("distinguishes an explicit empty prompt from prompt discovery", async () => {
    const discovered = await getHostDeps({ cwd: process.cwd() });
    const explicitEmpty = await getHostDeps({
      cwd: process.cwd(),
      systemPrompt: "",
    });

    expect(explicitEmpty.resourceLoader).not.toBe(discovered.resourceLoader);
    expect(
      (
        await getHostDeps({
          cwd: process.cwd(),
          systemPrompt: "",
        })
      ).resourceLoader,
    ).toBe(explicitEmpty.resourceLoader);
  });

  test("registers parent-owned providers without loading extensions", async () => {
    const deps = await getHostDeps({
      cwd: process.cwd(),
      providerConfigs: [
        [
          "parent-provider",
          { baseUrl: "https://example.invalid", apiKey: "test-key" },
        ],
      ],
    });
    expect(deps.modelRuntime.getRegisteredProviderIds()).toContain(
      "parent-provider",
    );
    expect(deps.resourceLoader.getExtensions().extensions).toHaveLength(0);
  });

  test("does not reuse host deps across different agent directories", async () => {
    const firstAgentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-dir-a-"),
    );
    const secondAgentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-dir-b-"),
    );

    try {
      const first = await getHostDeps({
        cwd: process.cwd(),
        agentDir: firstAgentDir,
      });
      const second = await getHostDeps({
        cwd: process.cwd(),
        agentDir: secondAgentDir,
      });

      expect(second).not.toBe(first);
      expect(second.settingsManager).not.toBe(first.settingsManager);
      expect(second.modelRuntime).not.toBe(first.modelRuntime);
    } finally {
      cleanup(firstAgentDir);
      cleanup(secondAgentDir);
    }
  });

  test("does not reuse host deps when provider config values differ", async () => {
    const first = await getHostDeps({
      cwd: process.cwd(),
      providerConfigs: [
        [
          "parent-provider-a",
          { baseUrl: "https://first.example.invalid", apiKey: "first-key" },
        ],
      ],
    });
    const second = await getHostDeps({
      cwd: process.cwd(),
      providerConfigs: [
        [
          "parent-provider-a",
          { baseUrl: "https://second.example.invalid", apiKey: "second-key" },
        ],
      ],
    });

    expect(second).not.toBe(first);
    expect(second.modelRuntime).not.toBe(first.modelRuntime);
    expect(
      second.modelRuntime.getRegisteredProviderConfig("parent-provider-a")
        ?.baseUrl,
    ).toBe("https://second.example.invalid");
  });

  test("loads openai-codex compaction extension when provider matches", async () => {
    const userCandidate = path.join(
      os.homedir(),
      ".pi",
      "agent",
      "npm",
      "node_modules",
      "@ogulcancelik",
      "pi-codex-compaction",
    );
    // This environment-dependent check must not treat a project installation
    // as a valid substitute: project packages are intentionally rejected.
    if (!fs.existsSync(userCandidate)) return;

    const deps = await getHostDeps({
      cwd: process.cwd(),
      modelProvider: "openai-codex",
    });

    const ext = deps.resourceLoader.getExtensions();
    const hasCodexCompaction = ext.extensions.some((entry) =>
      entry.path.includes("@ogulcancelik/pi-codex-compaction"),
    );
    expect(hasCodexCompaction).toBe(true);
  });

  test("defaults to projectTrusted=false when loading host deps", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-npm-trust-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-npm-trust-"),
    );
    const projectSettingsDir = path.join(cwd, ".pi");
    const projectMarker = path.join(projectSettingsDir, "project-command-ran");
    const projectCommand = path.join(
      projectSettingsDir,
      "project-npm-command.js",
    );
    const source = "npm:@example-org/missing-project-package";
    const fakeNpmRoot = path.join(
      os.tmpdir(),
      "pi-delegate-npm-command-root",
      Date.now().toString(),
    );

    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({}),
      "utf-8",
    );

    // This command simulates a project-trusted input. In safe mode, getHostDeps
    // should ignore it and proceed; the marker remains unset.
    writeFileSync(
      projectCommand,
      `
        const fs = require("node:fs");
        fs.writeFileSync(${JSON.stringify(projectMarker)}, "ran");
        const root = ${JSON.stringify(fakeNpmRoot)};
        const pkgDir = require("node:path").join(root, "node_modules", ${JSON.stringify(source.slice(4))});
        require("node:fs").mkdirSync(pkgDir, { recursive: true });
      `,
      "utf-8",
    );
    writeFileSync(
      path.join(projectSettingsDir, "settings.json"),
      JSON.stringify({
        packages: [source],
        npmCommand: [process.execPath, projectCommand],
      }),
      "utf-8",
    );

    try {
      await expect(
        getHostDeps({
          cwd,
          agentDir,
        }),
      ).resolves.toBeDefined();
      expect(fs.existsSync(projectMarker)).toBe(false);

      // Sanity proof: same fixture executes the marker when project trust is
      // explicitly enabled.
      const trustedSettingsManager = piCodingAgent.SettingsManager.create(
        cwd,
        agentDir,
        { projectTrusted: true },
      );
      const trustedPackageManager = new piCodingAgent.DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager: trustedSettingsManager,
      });
      trustedPackageManager.getInstalledPath(source, "user");
      expect(fs.existsSync(projectMarker)).toBe(true);
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
      cleanup(fakeNpmRoot);
    }
  });

  test("loads provider extensions from configurable allowlist", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-delegate-project-config-"));
    const agentDir = path.join(cwd, ".pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const customSource = "npm:@example-org/pi-codex-compaction-test";
    const customPath = path.join(agentDir, "custom-codex-extension");
    mkdirSync(customPath, { recursive: true });
    writeFileSync(
      path.join(customPath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );

    _setDelegateConfigForTesting({
      providerExtensions: {
        "openai-codex": [customSource],
      },
    });

    const originalGetInstalledPath =
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath;
    piCodingAgent.DefaultPackageManager.prototype.getInstalledPath = ((
      source: string,
    ) => {
      if (source === customSource) return customPath;
      return undefined;
    }) as typeof originalGetInstalledPath;

    try {
      const deps = await getHostDeps({
        cwd,
        agentDir,
        modelProvider: "openai-codex",
      });
      const secondDeps = await getHostDeps({
        cwd,
        agentDir,
        modelProvider: "openai-codex",
      });
      const ext = deps.resourceLoader.getExtensions();
      expect(
        ext.extensions.some((entry) =>
          entry.path.includes("custom-codex-extension"),
        ),
      ).toBe(true);
      // The extension runtime is mutable and bound to an AgentSession, so
      // extension-bearing host deps must never be shared across sessions.
      expect(secondDeps).not.toBe(deps);
      expect(secondDeps.resourceLoader).not.toBe(deps.resourceLoader);
    } finally {
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath =
        originalGetInstalledPath;
      cleanup(cwd);
    }
  });

  test("validates Git origin, pinned commit/tag, and parser pin metadata", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-git-source-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-git-source-"),
    );
    const packagePath = path.join(
      agentDir,
      "git",
      "github.com",
      "example",
      "git-extension",
    );
    const sourceBase = "git:https://github.com/example/git-extension";
    mkdirSync(packagePath, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: packagePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: packagePath,
    });
    execFileSync("git", ["config", "user.name", "Pi Delegate Test"], {
      cwd: packagePath,
    });
    execFileSync("git", ["remote", "add", "origin", sourceBase.slice(4)], {
      cwd: packagePath,
    });
    writeFileSync(
      path.join(packagePath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );
    execFileSync("git", ["add", "index.ts"], { cwd: packagePath });
    execFileSync("git", ["commit", "--quiet", "-m", "test"], {
      cwd: packagePath,
    });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packagePath,
      encoding: "utf8",
    }).trim();
    const source = `${sourceBase}@${commit}`;
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });

    try {
      const deps = await getHostDeps({
        cwd,
        agentDir,
        modelProvider: "custom-provider",
      });
      expect(deps.resourceLoader.getExtensions().extensions).toHaveLength(1);

      // A pinned source must reject a checkout whose HEAD diverged after the
      // configured commit/tag, rather than merely proving that the ref exists.
      execFileSync("git", ["tag", "configured-release", commit], {
        cwd: packagePath,
      });
      writeFileSync(
        path.join(packagePath, "second.ts"),
        "export const second = true;\n",
        "utf-8",
      );
      execFileSync("git", ["add", "second.ts"], { cwd: packagePath });
      execFileSync("git", ["commit", "--quiet", "-m", "diverge"], {
        cwd: packagePath,
      });
      await expect(
        getHostDeps({ cwd, agentDir, modelProvider: "custom-provider" }),
      ).rejects.toThrow("not checked out at its configured Git source or ref");

      _setDelegateConfigForTesting({
        providerExtensions: {
          "custom-provider": [`${sourceBase}@configured-release`],
        },
      });
      await expect(
        getHostDeps({ cwd, agentDir, modelProvider: "custom-provider" }),
      ).rejects.toThrow("not checked out at its configured Git source or ref");

      // Origin identity is independently mandatory even at the right commit.
      execFileSync("git", ["reset", "--hard", "--quiet", commit], {
        cwd: packagePath,
      });
      execFileSync(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          "https://github.com/example/different-extension",
        ],
        { cwd: packagePath },
      );
      _setDelegateConfigForTesting({
        providerExtensions: { "custom-provider": [source] },
      });
      await expect(
        getHostDeps({ cwd, agentDir, modelProvider: "custom-provider" }),
      ).rejects.toThrow("not checked out at its configured Git source or ref");

      // Pi's parser is a private compatibility seam. If it says a source is
      // pinned but stops exposing the ref, fail closed instead of silently
      // treating the configured source as unpinned.
      execFileSync(
        "git",
        ["remote", "set-url", "origin", sourceBase.slice(4)],
        {
          cwd: packagePath,
        },
      );
      const packageManagerPrototype = piCodingAgent.DefaultPackageManager
        .prototype as unknown as {
        parseSource(source: string): unknown;
      };
      const originalParseSource = packageManagerPrototype.parseSource;
      packageManagerPrototype.parseSource = function (candidate: string) {
        const parsed = originalParseSource.call(this, candidate);
        if (candidate !== source || typeof parsed !== "object" || !parsed) {
          return parsed;
        }
        const { ref: _omitted, ...withoutRef } = parsed as Record<
          string,
          unknown
        >;
        return withoutRef;
      };
      try {
        await expect(
          getHostDeps({ cwd, agentDir, modelProvider: "custom-provider" }),
        ).rejects.toThrow(
          "not checked out at its configured Git source or ref",
        );
      } finally {
        packageManagerPrototype.parseSource = originalParseSource;
      }
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("verifies a Git origin and hash ref in shorthand syntax", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-git-hash-ref-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-git-hash-ref-"),
    );
    const packagePath = path.join(
      agentDir,
      "git",
      "github.com",
      "example",
      "git-hash-extension",
    );
    const sourceBase = "git:github.com/example/git-hash-extension";
    mkdirSync(packagePath, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: packagePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: packagePath,
    });
    execFileSync("git", ["config", "user.name", "Pi Delegate Test"], {
      cwd: packagePath,
    });
    execFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/example/git-hash-extension",
      ],
      { cwd: packagePath },
    );
    writeFileSync(
      path.join(packagePath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );
    execFileSync("git", ["add", "index.ts"], { cwd: packagePath });
    execFileSync("git", ["commit", "--quiet", "-m", "test"], {
      cwd: packagePath,
    });
    execFileSync("git", ["tag", "v1.0.0"], { cwd: packagePath });
    const source = `${sourceBase}#v1.0.0`;
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });

    try {
      const deps = await getHostDeps({
        cwd,
        agentDir,
        modelProvider: "custom-provider",
      });
      expect(deps.resourceLoader.getExtensions().extensions).toHaveLength(1);
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("uses Pi's Git ref parsing for encoded refs", async () => {
    const sources = [
      "git:github.com/example/git-encoded-extension@feature%2Ffoo",
      "git:https://github.com/example/git-encoded-extension@feature%2Ffoo",
    ];

    for (const source of sources) {
      const cwd = mkdtempSync(
        path.join(tmpdir(), "pi-delegate-project-git-encoded-ref-"),
      );
      const agentDir = mkdtempSync(
        path.join(tmpdir(), "pi-delegate-agent-git-encoded-ref-"),
      );
      const packagePath = path.join(
        agentDir,
        "git",
        "github.com",
        "example",
        "git-encoded-extension",
      );
      mkdirSync(packagePath, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: packagePath });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: packagePath,
      });
      execFileSync("git", ["config", "user.name", "Pi Delegate Test"], {
        cwd: packagePath,
      });
      execFileSync(
        "git",
        [
          "remote",
          "add",
          "origin",
          "https://github.com/example/git-encoded-extension",
        ],
        { cwd: packagePath },
      );
      writeFileSync(
        path.join(packagePath, "index.ts"),
        "export default function(_api: unknown) {}\n",
        "utf-8",
      );
      execFileSync("git", ["add", "index.ts"], { cwd: packagePath });
      execFileSync("git", ["commit", "--quiet", "-m", "test"], {
        cwd: packagePath,
      });
      execFileSync("git", ["checkout", "-q", "-b", "feature/foo"], {
        cwd: packagePath,
      });
      _setDelegateConfigForTesting({
        providerExtensions: { "custom-provider": [source] },
      });

      try {
        const deps = await getHostDeps({
          cwd,
          agentDir,
          modelProvider: "custom-provider",
        });
        expect(deps.resourceLoader.getExtensions().extensions).toHaveLength(1);
      } finally {
        cleanup(cwd);
        cleanup(agentDir);
      }
    }
  });

  test("accepts a generic-host Git # path when the origin matches", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-git-generic-fragment-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-git-generic-fragment-"),
    );
    const packagePath = path.join(
      agentDir,
      "git",
      "code.example.com",
      "example",
      "git-generic-fragment-extension#release",
    );
    const source =
      "git:code.example.com/example/git-generic-fragment-extension#release";
    mkdirSync(packagePath, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: packagePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: packagePath,
    });
    execFileSync("git", ["config", "user.name", "Pi Delegate Test"], {
      cwd: packagePath,
    });
    execFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "git@code.example.com:example/git-generic-fragment-extension#release",
      ],
      { cwd: packagePath },
    );
    writeFileSync(
      path.join(packagePath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );
    execFileSync("git", ["add", "index.ts"], { cwd: packagePath });
    execFileSync("git", ["commit", "--quiet", "-m", "test"], {
      cwd: packagePath,
    });
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });

    try {
      const deps = await getHostDeps({
        cwd,
        agentDir,
        modelProvider: "custom-provider",
      });
      expect(deps.resourceLoader.getExtensions().extensions).toHaveLength(1);
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("rejects an SCP-style Git source when its literal # path is omitted", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-git-scp-fragment-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-git-scp-fragment-"),
    );
    const packagePath = path.join(
      agentDir,
      "git",
      "code.example.com",
      "org",
      "repo#release",
    );
    const source = "git:git@code.example.com:org/repo#release";
    mkdirSync(packagePath, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: packagePath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: packagePath,
    });
    execFileSync("git", ["config", "user.name", "Pi Delegate Test"], {
      cwd: packagePath,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@code.example.com:org/repo"],
      { cwd: packagePath },
    );
    writeFileSync(
      path.join(packagePath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );
    execFileSync("git", ["add", "index.ts"], { cwd: packagePath });
    execFileSync("git", ["commit", "--quiet", "-m", "test"], {
      cwd: packagePath,
    });
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });

    try {
      await expect(
        getHostDeps({
          cwd,
          agentDir,
          modelProvider: "custom-provider",
        }),
      ).rejects.toThrow("not checked out at its configured Git source or ref");
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("verifies an npm version constraint before loading the extension", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-versioned-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-versioned-"),
    );
    const source = "npm:@example-org/versioned-extension@1.2.3";
    const packagePath = path.join(
      agentDir,
      "npm",
      "node_modules",
      "@example-org",
      "versioned-extension",
    );
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      path.join(packagePath, "package.json"),
      JSON.stringify({
        name: "@example-org/versioned-extension",
        version: "1.2.3",
        pi: { extensions: ["index.ts"] },
      }),
      "utf-8",
    );
    writeFileSync(
      path.join(packagePath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });

    try {
      const deps = await getHostDeps({
        cwd,
        agentDir,
        modelProvider: "custom-provider",
      });
      expect(deps.resourceLoader.getExtensions().extensions).toHaveLength(1);
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("rejects an installed npm package that misses the configured version", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-stale-version-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-stale-version-"),
    );
    const source = "npm:@example-org/stale-extension@1.2.3";
    const packagePath = path.join(
      agentDir,
      "npm",
      "node_modules",
      "@example-org",
      "stale-extension",
    );
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      path.join(packagePath, "package.json"),
      JSON.stringify({
        name: "@example-org/stale-extension",
        version: "2.0.0",
        pi: { extensions: ["index.ts"] },
      }),
      "utf-8",
    );
    writeFileSync(
      path.join(packagePath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });

    try {
      await expect(
        getHostDeps({ cwd, agentDir, modelProvider: "custom-provider" }),
      ).rejects.toThrow("does not match the installed user-scope package");
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("rejects an npm dist-tag that cannot verify an installed version", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-delegate-project-tagged-"));
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-tagged-"),
    );
    const source = "npm:@example-org/tagged-extension@latest";
    const packagePath = path.join(
      agentDir,
      "npm",
      "node_modules",
      "@example-org",
      "tagged-extension",
    );
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      path.join(packagePath, "package.json"),
      JSON.stringify({
        name: "@example-org/tagged-extension",
        version: "1.0.0",
        pi: { extensions: ["index.ts"] },
      }),
      "utf-8",
    );
    writeFileSync(
      path.join(packagePath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });

    try {
      await expect(
        getHostDeps({ cwd, agentDir, modelProvider: "custom-provider" }),
      ).rejects.toThrow(
        "uses an npm tag rather than a verifiable semver range",
      );
    } finally {
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("fails when an allowlisted package exposes no extension", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-no-extension-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-no-extension-"),
    );
    const packagePath = path.join(agentDir, "no-extension-package");
    const source = "npm:@example-org/no-extension-package";
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      path.join(packagePath, "package.json"),
      JSON.stringify({
        name: "no-extension-package",
        version: "1.0.0",
        pi: { skills: [] },
      }),
      "utf-8",
    );
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });
    const originalGetInstalledPath =
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath;
    piCodingAgent.DefaultPackageManager.prototype.getInstalledPath = (() =>
      packagePath) as typeof originalGetInstalledPath;

    try {
      await expect(
        getHostDeps({ cwd, agentDir, modelProvider: "custom-provider" }),
      ).rejects.toThrow("Failed to load 1 allowlisted provider extension(s)");
    } finally {
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath =
        originalGetInstalledPath;
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("fails clearly when a required provider extension is absent", async () => {
    const originalGetInstalledPath =
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath;
    piCodingAgent.DefaultPackageManager.prototype.getInstalledPath = (() =>
      undefined) as typeof originalGetInstalledPath;
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-delegate-hostdeps-"));

    try {
      await expect(
        getHostDeps({
          cwd,
          agentDir: cwd,
          modelProvider: "openai-codex",
        }),
      ).rejects.toThrow(
        "Provider extension(s) for openai-codex are not installed in the user scope",
      );
    } finally {
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath =
        originalGetInstalledPath;
      cleanup(cwd);
    }
  });

  test("does not echo credentials from a missing extension source", async () => {
    const sensitiveSource =
      "https://user:super-secret@example.invalid/provider-extension.git";
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [sensitiveSource] },
    });
    const originalGetInstalledPath =
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath;
    piCodingAgent.DefaultPackageManager.prototype.getInstalledPath = (() =>
      undefined) as typeof originalGetInstalledPath;

    try {
      const error = await getHostDeps({
        cwd: process.cwd(),
        modelProvider: "custom-provider",
      }).catch((caught: unknown) => String(caught));
      expect(error).not.toContain("super-secret");
      expect(error).toContain("not installed in the user scope");
    } finally {
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath =
        originalGetInstalledPath;
    }
  });

  test("rejects a user-scope symlink that escapes into the project", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-delegate-project-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "pi-delegate-agent-"));
    const outsidePath = path.join(cwd, "project-extension");
    const linkedPath = path.join(agentDir, "provider-extension");
    mkdirSync(outsidePath, { recursive: true });
    symlinkSync(outsidePath, linkedPath, "dir");
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": ["./provider-extension"] },
    });
    const originalGetInstalledPath =
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath;
    piCodingAgent.DefaultPackageManager.prototype.getInstalledPath = ((
      _source: string,
      scope: "user" | "project",
    ) =>
      scope === "user"
        ? linkedPath
        : undefined) as typeof originalGetInstalledPath;

    try {
      await expect(
        getHostDeps({
          cwd,
          agentDir,
          modelProvider: "custom-provider",
        }),
      ).rejects.toThrow("outside the user agent directory");
    } finally {
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath =
        originalGetInstalledPath;
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("rejects a managed-package symlink into a sibling of a nested task cwd", async () => {
    const projectRoot = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-managed-project-"),
    );
    const cwd = path.join(projectRoot, "packages", "app");
    const agentDir = path.join(projectRoot, ".trusted-agent");
    const targetPath = path.join(projectRoot, "extensions", "pkg");
    const linkedPath = path.join(
      agentDir,
      "npm",
      "node_modules",
      "@example-org",
      "project-extension",
    );
    mkdirSync(cwd, { recursive: true });
    mkdirSync(targetPath, { recursive: true });
    mkdirSync(path.dirname(linkedPath), { recursive: true });
    writeFileSync(
      path.join(targetPath, "index.ts"),
      "export default function(_api: unknown) {}\n",
      "utf-8",
    );
    symlinkSync(targetPath, linkedPath, "dir");
    execFileSync("git", ["init", "--quiet"], { cwd: projectRoot });

    const source = "npm:@example-org/project-extension";
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });
    const originalGetInstalledPath =
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath;
    piCodingAgent.DefaultPackageManager.prototype.getInstalledPath = (() =>
      linkedPath) as typeof originalGetInstalledPath;

    try {
      await expect(
        getHostDeps({ cwd, agentDir, modelProvider: "custom-provider" }),
      ).rejects.toThrow("resolves inside the project directory");
    } finally {
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath =
        originalGetInstalledPath;
      cleanup(projectRoot);
    }
  });

  test("fails when an allowlisted provider extension cannot be loaded", async () => {
    const cwd = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-project-hostdeps-"),
    );
    const agentDir = mkdtempSync(
      path.join(tmpdir(), "pi-delegate-agent-hostdeps-"),
    );
    const brokenPath = path.join(agentDir, "broken-extension");
    mkdirSync(brokenPath, { recursive: true });
    writeFileSync(
      path.join(brokenPath, "index.ts"),
      "export default function(_api: unknown) { throw new Error('broken extension'); }\n",
      "utf-8",
    );
    const source = "npm:@example-org/broken-extension";
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": [source] },
    });
    const originalGetInstalledPath =
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath;
    piCodingAgent.DefaultPackageManager.prototype.getInstalledPath = ((
      _source: string,
      scope: "user" | "project",
    ) =>
      scope === "user"
        ? brokenPath
        : undefined) as typeof originalGetInstalledPath;

    try {
      await expect(
        getHostDeps({
          cwd,
          agentDir,
          modelProvider: "custom-provider",
        }),
      ).rejects.toThrow("Failed to load 1 allowlisted provider extension(s)");
    } finally {
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath =
        originalGetInstalledPath;
      cleanup(cwd);
      cleanup(agentDir);
    }
  });

  test("never probes or loads a project-scoped provider extension", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-delegate-hostdeps-"));
    const projectPath = path.join(cwd, "project-extension");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(
      path.join(projectPath, "index.ts"),
      "export default function(_api: unknown) { throw new Error('should not load'); }\n",
      "utf-8",
    );
    const scopes: string[] = [];
    const originalGetInstalledPath =
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath;
    piCodingAgent.DefaultPackageManager.prototype.getInstalledPath = ((
      _source: string,
      scope: "user" | "project",
    ) => {
      scopes.push(scope);
      return scope === "project" ? projectPath : undefined;
    }) as typeof originalGetInstalledPath;

    try {
      await expect(
        getHostDeps({
          cwd,
          agentDir: cwd,
          modelProvider: "openai-codex",
        }),
      ).rejects.toThrow("project-local installations are not allowed");
      expect(scopes).toEqual(["user"]);
    } finally {
      piCodingAgent.DefaultPackageManager.prototype.getInstalledPath =
        originalGetInstalledPath;
      cleanup(cwd);
    }
  });

  test("returns zero extensions for providers not in the allowlist", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-delegate-hostdeps-"));
    const deps = await getHostDeps({
      cwd,
      agentDir: cwd,
      modelProvider: "provider-with-no-compaction",
    });
    const ext = deps.resourceLoader.getExtensions();
    expect(ext.extensions).toHaveLength(0);
  });
});

// ── shared live-progress row helpers (format.ts) ─────────────────────────
// Pure helpers deduped across the LLM poll view (tickets.handlePoll) and the
// TUI branches (render-branches). Tested directly so the dedup is verified at
// the helper level even where the renderers themselves aren't.

describe("shared live-progress row helpers", () => {
  test("relativeTouchedSummary relativizes under cwd, drops outsiders", () => {
    const cwd = "/home/user/proj";
    expect(
      relativeTouchedSummary([`${cwd}/src/a.ts`, `${cwd}/src/b.ts`], cwd),
    ).toBe("src/a.ts, src/b.ts");
    // outsider (../../etc) is dropped; insider survives
    expect(
      relativeTouchedSummary([`${cwd}/src/a.ts`, "/etc/passwd"], cwd),
    ).toBe("src/a.ts");
    expect(relativeTouchedSummary(["/etc/passwd"], cwd)).toBeNull();
    expect(relativeTouchedSummary([], cwd)).toBeNull();
  });

  test("taskMetaBase returns [duration, tokens]", () => {
    const r = { durationMs: 1500, tokens: 42 } as any;
    expect(taskMetaBase(r)).toEqual([
      fmtDuration(1500),
      `${fmtTokens(42)} tokens`,
    ]);
  });

  test("waitingLabel queues at/over the cap, waits below", () => {
    expect(waitingLabel(0, 4)).toBe("waiting…");
    expect(waitingLabel(3, 4)).toBe("waiting…");
    expect(waitingLabel(4, 4)).toBe("queued (4 running)");
    expect(waitingLabel(5, 4)).toBe("queued (5 running)");
  });

  test("inFlightActivity returns the last activity lacking a result", () => {
    const done = { id: "1", result: { content: [], isError: false } } as any;
    const live = { id: "2" } as any;
    const liveFirst = { id: "3" } as any;
    const doneLast = {
      id: "4",
      result: { content: [], isError: false },
    } as any;
    expect(inFlightActivity({ activities: [done, live] } as any)).toBe(live);
    // Parallel execution: an earlier-started tool can still be in-flight after
    // a later-started one finishes. findLast must skip completed entries.
    expect(inFlightActivity({ activities: [liveFirst, doneLast] } as any)).toBe(
      liveFirst,
    );
    expect(inFlightActivity({ activities: [done] } as any)).toBeNull();
    expect(inFlightActivity({ activities: [] } as any)).toBeNull();
  });

  test("latestActivity returns the last activity, in-flight or completed", () => {
    const a = { id: "1", result: { content: [], isError: false } } as any;
    const b = { id: "2" } as any;
    const c = { id: "3", result: { content: [], isError: false } } as any;
    expect(latestActivity({ activities: [a, b] } as any)).toBe(b);
    expect(latestActivity({ activities: [a, c] } as any)).toBe(c);
    expect(latestActivity({ activities: [c] } as any)).toBe(c);
    expect(latestActivity({ activities: [] } as any)).toBeNull();
  });

  test("formatActivityLabel shows in-flight tool call", () => {
    const p = {
      activities: [{ id: "1", name: "bash", args: { command: "ls" } }],
    } as any;
    expect(formatActivityLabel(p)).toBe("$ ls");
  });

  test("formatActivityLabel prefers an earlier in-flight tool over a later completed one", () => {
    const p = {
      activities: [
        { id: "1", name: "bash", args: { command: "a" } },
        {
          id: "2",
          name: "read",
          args: { path: "/tmp/foo" },
          result: { content: [], isError: false },
        },
      ],
    } as any;
    // Under parallel execution the first tool may still be running when the
    // second one finishes. The label must show the in-flight tool, not "last:".
    expect(formatActivityLabel(p)).toBe("$ a");
    expect(formatActivityLabel(p)).not.toContain("last:");
  });

  test("formatActivityLabel shows last completed tool with prefix", () => {
    const p = {
      activities: [
        {
          id: "1",
          name: "bash",
          args: { command: "a" },
          result: { content: [], isError: false },
        },
        {
          id: "2",
          name: "read",
          args: { path: "/tmp/foo" },
          result: { content: [], isError: false },
        },
      ],
    } as any;
    expect(formatActivityLabel(p)).toBe("last: read /tmp/foo");
  });

  test("formatActivityLabel returns thinking when no activity", () => {
    expect(formatActivityLabel({ activities: [] } as any)).toBe("thinking");
  });

  test("compactActivity shows in-flight tool with elapsed time", () => {
    const p = {
      activities: [
        {
          id: "1",
          name: "bash",
          args: { command: "sleep" },
          startTime: Date.now() - 500,
        },
      ],
    } as any;
    expect(compactActivity(p)).toMatch(/^\$ sleep \| \d+ms$/);
  });

  test("compactActivity prefers an earlier in-flight tool over a later completed one", () => {
    const p = {
      activities: [
        {
          id: "1",
          name: "bash",
          args: { command: "a" },
          startTime: Date.now() - 500,
        },
        {
          id: "2",
          name: "read",
          args: { path: "/tmp/foo" },
          result: { content: [], isError: false },
        },
      ],
    } as any;
    // Parallel execution: the first tool is still running when the second
    // finishes. compactActivity must show the in-flight tool and its age.
    expect(compactActivity(p)).toMatch(/^\$ a \| \d+ms$/);
    expect(compactActivity(p)).not.toContain("✓");
  });

  test("compactActivity shows completed tool with success icon", () => {
    const p = {
      activities: [
        {
          id: "1",
          name: "read",
          args: { path: "/tmp/foo" },
          result: { content: [], isError: false },
        },
      ],
    } as any;
    expect(compactActivity(p)).toBe("read /tmp/foo ✓");
  });

  test("compactActivity shows error icon for failed tool", () => {
    const p = {
      activities: [
        {
          id: "1",
          name: "bash",
          args: { command: "fail" },
          result: { content: [], isError: true },
        },
      ],
    } as any;
    expect(compactActivity(p)).toBe("$ fail ✗");
  });

  test("compactActivity returns thinking when no activity", () => {
    expect(compactActivity({ activities: [] } as any)).toBe("thinking…");
  });
});

// ── touched-file overlap and best-effort labeling (issue #33) ───────────────

describe("touched-file overlap warning", () => {
  test("findTouchedOverlaps returns empty when tasks touch distinct files", () => {
    expect(
      findTouchedOverlaps([
        { attributedFiles: ["/tmp/a.txt"] },
        { attributedFiles: ["/tmp/b.txt"] },
      ]),
    ).toEqual([]);
  });

  test("findTouchedOverlaps returns overlapping paths and ignores singletons", () => {
    expect(
      findTouchedOverlaps([
        { attributedFiles: ["/tmp/a.txt", "/tmp/shared.txt"] },
        { attributedFiles: ["/tmp/b.txt", "/tmp/shared.txt"] },
        { attributedFiles: ["/tmp/c.txt"] },
      ]),
    ).toEqual(["/tmp/shared.txt"]);
  });

  test("findTouchedOverlaps ignores touchedFiles and uses only attributedFiles", () => {
    expect(
      findTouchedOverlaps([
        {
          attributedFiles: ["/tmp/a.txt"],
          touchedFiles: ["/tmp/a.txt", "/tmp/b.txt"],
        },
        {
          attributedFiles: ["/tmp/b.txt"],
          touchedFiles: ["/tmp/a.txt", "/tmp/b.txt"],
        },
      ]),
    ).toEqual([]);
  });

  test("formatTouchedOverlapWarning is null when there is no overlap", () => {
    expect(formatTouchedOverlapWarning([])).toBeNull();
  });

  test("formatTouchedOverlapWarning names paths and does not claim isolation or rollback", () => {
    const warning = formatTouchedOverlapWarning(["/tmp/shared.txt"]);
    expect(warning).toContain("/tmp/shared.txt");
    expect(warning).toContain("does not isolate or serialize file access");
    expect(warning).toContain("does not roll back completed writes");
  });

  test("formatCompletedTicket emits overlap warning for identical touched paths", () => {
    const shared = "/tmp/shared.txt";
    const ticket: AsyncTicket = {
      id: "overlap",
      created: 0,
      status: "done",
      tasks: [{ prompt: "a" }, { prompt: "b" }] as any,
      resolved: [
        {
          agentName: "a",
          cwd: "/tmp",
          prompt: "a",
        },
        {
          agentName: "b",
          cwd: "/tmp",
          prompt: "b",
        },
      ] as any,
      progress: [],
      results: [
        {
          agent: "a",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
        {
          agent: "b",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: [shared],
          attributedFiles: [shared],
        },
      ],
      controller: new AbortController(),
      parentModelId: "m",
    };
    const result = formatCompletedTicket(ticket);
    const text = result.content[0]!.text;
    expect(text).toContain("touched (best-effort):");
    expect(text).toContain(shared);
    expect(text).toContain("does not isolate or serialize file access");
    expect(result.details.overlapWarning).toContain(
      "does not isolate or serialize file access",
    );
  });

  test("formatCompletedTicket omits overlap warning when touched paths are distinct", () => {
    const ticket: AsyncTicket = {
      id: "no-overlap",
      created: 0,
      status: "done",
      tasks: [{ prompt: "a" }, { prompt: "b" }] as any,
      resolved: [
        { agentName: "a", cwd: "/tmp", prompt: "a" },
        { agentName: "b", cwd: "/tmp", prompt: "b" },
      ] as any,
      progress: [],
      results: [
        {
          agent: "a",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: ["/tmp/a.txt"],
          attributedFiles: ["/tmp/a.txt"],
        },
        {
          agent: "b",
          output: "done",
          durationMs: 100,
          tokens: 10,
          usage: { totalTokens: 10, cost: { total: 0 } } as any,
          touchedFiles: ["/tmp/b.txt"],
          attributedFiles: ["/tmp/b.txt"],
        },
      ],
      controller: new AbortController(),
      parentModelId: "m",
    };
    const result = formatCompletedTicket(ticket);
    const text = result.content[0]!.text;
    expect(text).not.toContain("does not isolate or serialize file access");
    expect(result.details.overlapWarning).toBeUndefined();
  });
});

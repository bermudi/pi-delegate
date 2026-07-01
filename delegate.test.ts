import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  parseFrontmatter,
  findProjectRoot,
  loadAgentFile,
  loadClaudeAgentFile,
  discoverAgents,
  buildParentTranscript,
  extractTextContent,
  loadSkill,
  loadAgentsMdFiles,
  resolveModel,
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
  getActivityAge,
  DEFAULT_TOOLS,
  READONLY_TOOLS,
  VALID_THINKING,
  TOOL_FACTORIES,
  resolveToolGroups,
  extractTouchedFromActivities,
  agentPool,
  closePooledAgent,
  sweepPool,
  listPooledAgents,
  withSessionLock,
  getHostDeps,
  readDelegateSettingsFile,
  loadDelegateSettings,
  getConcurrencyLimit,
  getMaxAsyncTickets,
  type AgentConfig,
  type DelegateConfig,
  ticketRegistry,
  type AsyncTicket,
  sweepTickets,
  isSessionBusy,
  handlePoll,
  handleCancel,
  deliverTicketResults,
  resolveCwd,
} from "./delegate.ts";
import {
  _setHostRetryBaseMsForTesting,
  _resetHostDepsCacheForTesting,
} from "./host.ts";

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

function collectSchemaDescriptions(schema: unknown): string[] {
  const descriptions: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.description === "string") {
      descriptions.push(record.description);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(schema);
  return descriptions;
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

  test("ignores lines without colon", () => {
    const content = `---
name: agent
bad line without colon
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result.data.name).toBe("agent");
    expect(result.data["bad line without colon"]).toBeUndefined();
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

  test("returns built-in defaults when no .pi/agents directory exists", () => {
    const agents = discoverAgents("/nonexistent");
    // No user agents, but the three built-ins (scout/reviewer/workhorse) are
    // always seeded so the tool works out of the box.
    expect(agents.has("scout")).toBe(true);
    expect(agents.has("reviewer")).toBe(true);
    expect(agents.has("workhorse")).toBe(true);
    for (const a of agents.values()) expect(a.scope).toBe("builtin");
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

  test("returns only built-in defaults when no user agents found", () => {
    const agents = discoverAgents(tmpDir);
    expect(agents.size).toBe(3);
    expect(agents.has("scout")).toBe(true);
  });

  // ── Built-in supersession ──────────────────────────────────────────────

  test("user markdown supersedes a same-named built-in", () => {
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
    // The other built-ins survive untouched.
    expect(agents.get("reviewer")!.scope).toBe("builtin");
    expect(agents.get("workhorse")!.scope).toBe("builtin");
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

  test("claude tool names are mapped, unmappable tools dropped, empty inherits *", () => {
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

  test("claude agent with only unmappable tools inherits the full agent set", () => {
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
    const c = loadClaudeAgentFile(fp)!;
    // Nothing mappable → inherit * (DEFAULT_TOOLS), not an empty toolset.
    expect(c.tools).toEqual(DEFAULT_TOOLS);
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

// ── loadSkill ─────────────────────────────────────────────────────────────

describe("loadSkill", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    mock.module("node:os", () => ({
      ...os,
      homedir: () => tmpDir,
    }));
  });

  afterEach(() => {
    mock.module("node:os", () => os);
    cleanup(tmpDir);
  });

  test("loads skill from project .agents/skills/", () => {
    const skillDir = path.join(tmpDir, ".agents", "skills", "web-content");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "# Web Content\nSearch the web.",
      "utf-8",
    );
    expect(loadSkill("web-content", tmpDir)).toBe(
      "# Web Content\nSearch the web.",
    );
  });

  test("loads skill from project .pi/skills/", () => {
    const skillDir = path.join(tmpDir, ".pi", "skills", "custom");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "Custom skill.", "utf-8");
    expect(loadSkill("custom", tmpDir)).toBe("Custom skill.");
  });

  test("returns null when skill not found", () => {
    expect(loadSkill("nonexistent", tmpDir)).toBeNull();
  });

  test("searches user dirs after project dirs", () => {
    // Project dir has no skill
    // User dir has it
    const userSkillDir = path.join(tmpDir, ".pi", "agent", "skills", "shared");
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(path.join(userSkillDir, "SKILL.md"), "User skill.", "utf-8");
    expect(loadSkill("shared", tmpDir)).toBe("User skill.");
  });
});

// ── loadAgentsMdFiles ────────────────────────────────────────────────────

describe("loadAgentsMdFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    mock.module("node:os", () => ({
      ...os,
      homedir: () => tmpDir,
    }));
  });

  afterEach(() => {
    mock.module("node:os", () => os);
    cleanup(tmpDir);
  });

  test("returns empty array when no AGENTS.md files exist", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    expect(loadAgentsMdFiles(projectDir)).toEqual([]);
  });

  test("loads AGENTS.md from cwd", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, "AGENTS.md"),
      "Project instructions.",
      "utf-8",
    );
    expect(loadAgentsMdFiles(projectDir)).toEqual(["Project instructions."]);
  });

  test("loads global AGENTS.md from ~/.pi/agent/", () => {
    const agentDir = path.join(tmpDir, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "AGENTS.md"),
      "Global instructions.",
      "utf-8",
    );
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const result = loadAgentsMdFiles(projectDir);
    expect(result).toContain("Global instructions.");
  });

  test("loads both global and project AGENTS.md", () => {
    const agentDir = path.join(tmpDir, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "AGENTS.md"),
      "Global instructions.",
      "utf-8",
    );
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, "AGENTS.md"),
      "Project instructions.",
      "utf-8",
    );
    const result = loadAgentsMdFiles(projectDir);
    expect(result).toEqual(["Global instructions.", "Project instructions."]);
  });

  test("walks ancestor directories", () => {
    const parentDir = path.join(tmpDir, "parent");
    const childDir = path.join(parentDir, "child");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      path.join(parentDir, "AGENTS.md"),
      "Parent instructions.",
      "utf-8",
    );
    writeFileSync(
      path.join(childDir, "AGENTS.md"),
      "Child instructions.",
      "utf-8",
    );
    const result = loadAgentsMdFiles(childDir);
    expect(result).toEqual(["Parent instructions.", "Child instructions."]);
  });

  test("falls back to CLAUDE.md when AGENTS.md is empty", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "AGENTS.md"), "", "utf-8");
    writeFileSync(
      path.join(projectDir, "CLAUDE.md"),
      "Claude instructions.",
      "utf-8",
    );
    expect(loadAgentsMdFiles(projectDir)).toEqual(["Claude instructions."]);
  });

  test("falls back to CLAUDE.md when AGENTS.md is whitespace-only", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "AGENTS.md"), "   \n\t\n  ", "utf-8");
    writeFileSync(
      path.join(projectDir, "CLAUDE.md"),
      "Claude instructions.",
      "utf-8",
    );
    expect(loadAgentsMdFiles(projectDir)).toEqual(["Claude instructions."]);
  });

  test("prefers AGENTS.md over CLAUDE.md when both have content", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "AGENTS.md"), "Agents win.", "utf-8");
    writeFileSync(path.join(projectDir, "CLAUDE.md"), "Claude loses.", "utf-8");
    expect(loadAgentsMdFiles(projectDir)).toEqual(["Agents win."]);
  });

  test("loads CLAUDE.md when AGENTS.md does not exist", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, "CLAUDE.md"),
      "Claude instructions.",
      "utf-8",
    );
    expect(loadAgentsMdFiles(projectDir)).toEqual(["Claude instructions."]);
  });

  test("skips filesystem root", () => {
    const projectDir = path.join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    // Intentionally write to root — should be ignored
    try {
      writeFileSync("/AGENTS.md", "Root instructions.", "utf-8");
    } catch {
      // skip if no permission
    }
    const result = loadAgentsMdFiles(projectDir);
    expect(result).not.toContain("Root instructions.");
    // cleanup
    try {
      fs.unlinkSync("/AGENTS.md");
    } catch {
      /* ignore */
    }
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
      error: "action='close' requires sessionId.",
      durationMs: 0,
      tokens: 0,
      touchedFiles: [],
    };
    expect(formatFailedTask(r)).toEqual([
      "[FAILED: action='close' requires sessionId.]",
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
});

// ── getActivityAge ───────────────────────────────────────────────────────

describe("resolveCwd", () => {
  test("passes through absolute paths", () => {
    expect(resolveCwd("/home/daniel/build/litespec")).toBe(
      "/home/daniel/build/litespec",
    );
  });

  test("resolves relative paths against process.cwd", () => {
    const result = resolveCwd("../build/litespec");
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve("../build/litespec"));
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

  test("dot resolves to process.cwd", () => {
    expect(resolveCwd(".")).toBe(process.cwd());
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
      { id: "1", name: "edit", args: { path: "src/foo.ts" }, startTime: 0 },
      {
        id: "2",
        name: "write",
        args: { path: "src/bar.ts", content: "..." },
        startTime: 0,
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
      { id: "1", name: "edit", args: { path: "src/foo.ts" }, startTime: 0 },
      { id: "2", name: "write", args: { path: "src/foo.ts" }, startTime: 0 },
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
      { id: "1", name: "edit", args: { filePath: "src/qux.ts" }, startTime: 0 },
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
    // Description is a plain string — exact wording is not a contract.
    // Stealth hygiene is enforced by the sibling test below (no schema
    // descriptions, no prompt snippet).
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

  test("uses stealth registration metadata and schema", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    expect(toolDef!.promptSnippet).toBeUndefined();
    expect(toolDef!.promptGuidelines ?? []).toEqual([]);
    expect(collectSchemaDescriptions(toolDef!.parameters)).toEqual([]);
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
    expect(text).toContain("Available Agents");
    expect(text).toContain("Task Fields");
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
      "action",
    ];
    for (const field of optionalFields) {
      expect(taskSchema.properties[field]).toBeDefined();
    }
    // No required fields at the TypeBox level; runtime validation enforces constraints.
    expect(taskSchema.required).toBeUndefined();
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
      { tasks: [{ prompt: "hello", action: "prompt" }] },
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

  afterEach(() => {
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
        results: [
          { agent: "ad-hoc", output: "ok", durationMs: 0, tokens: 0 },
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
});

// ── Pool tests ────────────────────────────────────────────────────────────

describe("delegate pool", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    agentPool.clear();
    ts?.dispose();
    ts = undefined;
  });

  test("prompt is optional for close and list actions", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    // list without prompt should work
    const listResult = await toolDef!.execute(
      "tc-pool-1",
      { tasks: [{ action: "list", systemPrompt: "test" }] },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );
    expect(listResult.content[0].text).toContain("Active sessions");

    // close without prompt should work (even if session doesn't exist)
    const closeResult = await toolDef!.execute(
      "tc-pool-2",
      {
        tasks: [
          { action: "close", sessionId: "nonexistent", systemPrompt: "test" },
        ],
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

  test("close action requires sessionId", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    const result = await toolDef!.execute(
      "tc-pool-4",
      { tasks: [{ action: "close", systemPrompt: "test" }] },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );
    const details = (result as any).details as {
      results: Array<{ error?: string }>;
    };
    expect(details.results[0].error).toContain(
      "action='close' requires sessionId",
    );
  });

  test("closePooledAgent removes agent from pool", () => {
    // Inject a fake pooled agent
    agentPool.set("test-session", {
      session: {} as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/test.jsonl",
      config: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      lastUsed: Date.now(),
      createdAt: Date.now(),
      totalTokens: 0,
      promptCount: 0,
    });
    expect(agentPool.has("test-session")).toBe(true);
    expect(closePooledAgent("test-session")).toBe(true);
    expect(agentPool.has("test-session")).toBe(false);
    expect(closePooledAgent("test-session")).toBe(false);
  });

  test("sweepPool evicts idle agents", () => {
    const now = Date.now();
    agentPool.set("fresh", {
      session: {} as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/fresh.jsonl",
      config: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      lastUsed: now,
      createdAt: now,
      totalTokens: 0,
      promptCount: 0,
    });
    agentPool.set("stale", {
      session: {} as any,
      sessionManager: {} as any,
      sessionFile: "/tmp/stale.jsonl",
      config: {
        systemPrompt: "test",
        model: {} as any,
        thinking: "off" as any,
        tools: [],
        cwd: "/tmp",
      },
      lastUsed: now - 11 * 60 * 1000, // 11 minutes ago
      createdAt: now - 11 * 60 * 1000,
      totalTokens: 0,
      promptCount: 0,
    });
    sweepPool();
    expect(agentPool.has("fresh")).toBe(true);
    expect(agentPool.has("stale")).toBe(false);
    // cleanup
    agentPool.delete("fresh");
  });

  test("listPooledAgents shows stats and sweeps stale", () => {
    agentPool.clear();
    expect(listPooledAgents()).toEqual(["_(no active sessions)_"]);

    const now = Date.now();
    agentPool.set("session-a", {
      session: {} as any,
      sessionManager: {} as any,
      sessionFile: "/home/user/.pi/agent/sessions/test.jsonl",
      config: {
        systemPrompt: "test",
        model: { id: "test-model" } as any,
        thinking: "off" as any,
        tools: ["read"],
        cwd: "/tmp",
      },
      lastUsed: now,
      createdAt: now - 5000,
      totalTokens: 1234,
      promptCount: 3,
    });
    const lines = listPooledAgents();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("session-a");
    expect(lines[0]).toContain("3 prompts");
    expect(lines[0]).toContain("1.2k tokens");
    expect(lines[0]).toContain("test.jsonl"); // shortened path
    agentPool.clear();
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
    agentPool.clear();
    ts?.dispose();
    ts = undefined;
  });

  test("sweepTickets aborts tickets exceeding max runtime", () => {
    const controller = new AbortController();
    const now = Date.now();
    const ticket: AsyncTicket = {
      id: "timeout1",
      created: now - 31 * 60 * 1000, // 31 minutes ago
      tasks: [],
      resolved: [],
      status: "running",
      results: [],
      progress: [],
      controller,
      parentModelId: undefined,
    };
    ticketRegistry.set("timeout1", ticket);
    sweepTickets();
    expect(ticket.status).toBe("failed");
    expect(ticket.error).toBe("Exceeded maximum runtime");
    expect(ticket.completedAt).toBeDefined();
    expect(controller.signal.aborted).toBe(true);
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
    agentPool.clear();
    ts?.dispose();
    ts = undefined;
  });

  test("poll with no tickets returns empty message", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const result = await toolDef!.execute(
      "tc-poll-1",
      { action: "poll", async: undefined, ticket: undefined },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );
    expect(result.content[0].text).toContain("No async tickets");
  });

  test("poll with no tickets includes a discovery hint", () => {
    const result = handlePoll({ tasks: [], ticket: undefined }, {} as any);
    // Dead-end must self-correct: a confused `action: "poll"` should point
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
      'delegate({ action: "cancel", ticket: "abc12345" })',
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

  test("poll returns completed results for running ticket", () => {
    const ticket: AsyncTicket = {
      id: "partial1",
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

    // Header shows partial completion
    expect(text).toContain("2/3 done");
    // Completed task output is present
    expect(text).toContain("found it");
    // Failed task error is present
    expect(text).toContain("timeout");
    // Running task still shows as running
    expect(text).toContain("worker");

    // details.results is index-aligned — same length as progress
    // Undefined results are filled with error objects to match DelegateDetails type
    expect(result.details.results).toHaveLength(3);
    expect(result.details.results![0]!.agent).toBe("scout");
    expect(result.details.results![1]).toEqual({
      error: "PENDING — result not available",
    });
    expect(result.details.results![2]!.agent).toBe("runner");
  });

  test("poll with unknown ticket returns not found", () => {
    const result = handlePoll({ tasks: [], ticket: "nonexistent" }, {} as any);
    expect(result.content[0].text).toContain("not found");
  });

  test("cancel aborts a running ticket", () => {
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
    expect(result.content[0].text).toContain("cancelled");
    expect(ticket.status).toBe("cancelled");
    expect(ticket.completedAt).toBeDefined();
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
          status: "pending",
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

    // Text output handles undefined results gracefully
    expect(text).toContain("done early");
    expect(text).toContain("PENDING — result not available");

    // details.results is index-aligned — same length as tasks
    // Undefined results are filled with error objects to match DelegateDetails type
    expect(result.details.results).toHaveLength(3);
    expect(result.details.results![0]!.agent).toBe("scout");
    expect(result.details.results![1]).toEqual({
      error: "PENDING — result not available",
    });
    expect(result.details.results![2]).toEqual({
      error: "PENDING — result not available",
    });
  });

  test("execute routes top-level cancel without tasks", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");

    const result = await toolDef!.execute(
      "tc-cancel-frontdoor",
      { action: "cancel" },
      undefined,
      undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain("requires a ticket ID");
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
  });

  test("action enum includes poll and cancel", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const tasksArraySchema = getTasksArraySchema(toolDef!.parameters as any);
    const taskSchema = tasksArraySchema.items;
    const actionEnum = taskSchema.properties.action.enum;
    expect(actionEnum).toContain("poll");
    expect(actionEnum).toContain("cancel");
  });

  test("parameter schema includes top-level async ticket controls", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "delegate");
    const schema = toolDef!.parameters as any;
    expect(schema.properties.action.enum).toEqual(["poll", "cancel"]);
    expect(schema.properties.async).toBeDefined();
    expect(schema.properties.ticket).toBeDefined();
    expect(schema.required ?? []).not.toContain("tasks");
  });
});

// ── getHostDeps: extensions disabled for subagents ───────────────────────
// Subagents are headless workers and must not load the parent's interactive
// extensions. Beyond intent, this neutralizes the shared-runtime cross-wiring
// risk: AgentSession hands the loader's shared extensionsResult.runtime to a
// new ExtensionRunner whose bindCore() overwrites mutable runtime methods.
// With no extensions loaded there are no handlers bound to those methods, so
// the cached loader is safe to share across live sessions.

describe("getHostDeps disables extensions for subagents", () => {
  beforeEach(() => {
    _resetHostDepsCacheForTesting();
  });
  afterEach(() => {
    _resetHostDepsCacheForTesting();
    _setHostRetryBaseMsForTesting(undefined);
  });

  test("resourceLoader reports zero extensions", async () => {
    const deps = await getHostDeps({ cwd: process.cwd() });
    const ext = deps.resourceLoader.getExtensions();
    expect(ext.extensions).toHaveLength(0);
  });

  test("resourceLoader is cached/shared across calls for same cwd", async () => {
    const a = await getHostDeps({ cwd: process.cwd() });
    const b = await getHostDeps({ cwd: process.cwd() });
    // Same cached instance — the documented optimization. Safe because no
    // extensions means no handlers bind to the shared runtime.
    expect(b.resourceLoader).toBe(a.resourceLoader);
    expect(b.resourceLoader.getExtensions().extensions).toHaveLength(0);
  });
});

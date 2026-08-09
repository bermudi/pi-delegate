import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  buildSubagentSystemPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  loadClaudeAgentFile,
} from "./agents.ts";
import { DEFAULT_TOOLS } from "./constants.ts";

// Pure-function tests for the subagent prompt resolver. These pin the
// precedence and freeze contracts that the integration tests in
// lifecycle.test.ts only exercise indirectly through the streamSimple mock.
//
// Skills and AGENTS.md are intentionally NOT part of this resolver —
// AgentSession's resource loader owns their discovery and appends them via
// _rebuildSystemPrompt. There is nothing to assert about them here.

describe("buildSubagentSystemPrompt", () => {
  // ── Precedence: task > agent > parent > default ───────────────────────

  test("task prompt wins over agent, parent, and default", () => {
    const prompt = buildSubagentSystemPrompt({
      taskSystemPrompt: "TASK_PROMPT",
      agentSystemPrompt: "AGENT_PROMPT",
      parentSystemPrompt: "PARENT_PROMPT",
    });
    expect(prompt.startsWith("TASK_PROMPT")).toBe(true);
    expect(prompt).not.toContain("AGENT_PROMPT");
    expect(prompt).not.toContain("PARENT_PROMPT");
  });

  test("agent prompt wins when no task prompt", () => {
    const prompt = buildSubagentSystemPrompt({
      agentSystemPrompt: "AGENT_PROMPT",
      parentSystemPrompt: "PARENT_PROMPT",
    });
    expect(prompt.startsWith("AGENT_PROMPT")).toBe(true);
    expect(prompt).not.toContain("PARENT_PROMPT");
  });

  test("parent prompt wins when no task or agent prompt", () => {
    const prompt = buildSubagentSystemPrompt({
      parentSystemPrompt: "PARENT_PROMPT",
    });
    expect(prompt.startsWith("PARENT_PROMPT")).toBe(true);
  });

  test("falls back to default when nothing is set", () => {
    const prompt = buildSubagentSystemPrompt({});
    expect(prompt).toBe(DEFAULT_SUBAGENT_SYSTEM_PROMPT);
  });

  // ── Blank handling in precedence chain ────────────────────────────────

  test("blank task prompt is skipped, agent wins", () => {
    const prompt = buildSubagentSystemPrompt({
      taskSystemPrompt: "   \n  ",
      agentSystemPrompt: "AGENT_PROMPT",
    });
    expect(prompt.startsWith("AGENT_PROMPT")).toBe(true);
  });

  // ── Pooled prompt freezes everything ──────────────────────────────────

  test("pooled prompt returned verbatim, ignoring all other inputs", () => {
    const prompt = buildSubagentSystemPrompt({
      taskSystemPrompt: "TASK_SHOULD_NOT_WIN",
      agentSystemPrompt: "AGENT_SHOULD_NOT_WIN",
      parentSystemPrompt: "PARENT_SHOULD_NOT_WIN",
      pooledSystemPrompt: "POOLED_FROZEN_PROMPT",
    });
    expect(prompt).toBe("POOLED_FROZEN_PROMPT");
    expect(prompt).not.toContain("TASK_SHOULD_NOT_WIN");
  });

  test("blank pooled prompt does not trigger freeze", () => {
    const prompt = buildSubagentSystemPrompt({
      pooledSystemPrompt: "   ",
      taskSystemPrompt: "TASK_PROMPT",
    });
    expect(prompt.startsWith("TASK_PROMPT")).toBe(true);
  });

  // ── Parent default prompt sanitization (issue #35) ───────────────────────

  test("strips inherited parent default tool inventory before reuse", () => {
    const parentPrompt = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      "",
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute bash commands",
      "- edit: Make precise file edits",
      "- write: Create or overwrite files",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      "- Use bash for file operations like ls, rg, find",
      "- Use read to examine files instead of cat or sed.",
      "- Be concise in your responses",
      "",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /some/path/README.md",
      "",
      "Current working directory: /parent",
    ].join("\n");

    const prompt = buildSubagentSystemPrompt({
      parentSystemPrompt: parentPrompt,
    });

    // The rest of the parent prompt is preserved.
    expect(prompt).toContain(
      "You are an expert coding assistant operating inside pi",
    );
    expect(prompt).toContain("Pi documentation");
    expect(prompt).toContain("- Main documentation: /some/path/README.md");

    // The parent's tool inventory, guidelines, and parent cwd are stripped; the
    // child will get its own cwd line from AgentSession.
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).not.toContain("Current working directory: /parent");
    expect(prompt).not.toContain("- bash:");
    expect(prompt).not.toContain("- edit:");
    expect(prompt).not.toContain("- write:");
    expect(prompt).not.toContain("Guidelines:");
    expect(prompt).not.toContain("Use bash for file operations");
  });

  test("does not rewrite a custom parent prompt that mentions tool names", () => {
    const parentPrompt =
      "You are a reviewer. You may use bash, write, or edit only with permission.";

    const prompt = buildSubagentSystemPrompt({
      parentSystemPrompt: parentPrompt,
    });

    // Custom prompts are intentionally authored and are left untouched.
    expect(prompt).toBe(parentPrompt);
  });

  test("strips parent cwd but does not strip a child cwd line from task prompts", () => {
    const parentPrompt = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      "",
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute bash commands",
      "",
      "Guidelines:",
      "- Use bash for file operations like ls, rg, find",
      "",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /some/path/README.md",
      "",
      "Current working directory: /parent",
    ].join("\n");

    const childCwdLine = "Current working directory: /child";
    const taskPrompt = `Run in the child.\n\n${childCwdLine}`;

    const prompt = buildSubagentSystemPrompt({
      taskSystemPrompt: taskPrompt,
      parentSystemPrompt: parentPrompt,
    });

    // Task prompt wins and its cwd line is preserved.
    expect(prompt).toBe(taskPrompt);
    expect(prompt).toContain(childCwdLine);
    expect(prompt).not.toContain("Current working directory: /parent");
  });

  test("read-only child receives a read/search-only capability intro", () => {
    const parentPrompt = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      "",
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute bash commands",
      "- edit: Make precise file edits",
      "- write: Create or overwrite files",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      "- Use bash for file operations like ls, rg, find",
      "- Use read to examine files instead of cat or sed.",
      "- Be concise in your responses",
      "",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /some/path/README.md",
      "",
      "Current working directory: /parent",
    ].join("\n");

    const prompt = buildSubagentSystemPrompt({
      parentSystemPrompt: parentPrompt,
      tools: ["ro"],
    });

    expect(prompt).toContain(
      "You are an expert coding assistant operating inside pi",
    );
    expect(prompt).toContain("Pi documentation");
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).not.toContain("executing commands");
    expect(prompt).not.toContain("editing code");
    expect(prompt).not.toContain("writing new files");
    expect(prompt).toContain("reading files");
    expect(prompt).toContain("searching code");
    expect(prompt).toContain("listing directories");
  });

  test("mutating child keeps the full capability intro", () => {
    const parentPrompt = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      "",
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute bash commands",
      "- edit: Make precise file edits",
      "- write: Create or overwrite files",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      "- Use bash for file operations like ls, rg, find",
      "- Use read to examine files instead of cat or sed.",
      "- Be concise in your responses",
      "",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /some/path/README.md",
      "",
      "Current working directory: /parent",
    ].join("\n");

    const prompt = buildSubagentSystemPrompt({
      parentSystemPrompt: parentPrompt,
      tools: ["*"],
    });

    expect(prompt).toContain(
      "You are an expert coding assistant operating inside pi",
    );
    expect(prompt).toContain("Pi documentation");
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).toContain("executing commands");
    expect(prompt).toContain("editing code");
    expect(prompt).toContain("writing new files");
    expect(prompt).not.toContain("searching code");
    expect(prompt).not.toContain("listing directories");
  });
});

// ── Claude Code tool allowlist import tests ───────────────────────────────

describe("loadClaudeAgentFile", () => {
  function loadWithWarnings(content: string): {
    config: ReturnType<typeof loadClaudeAgentFile>;
    warnings: string[];
  } {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));

    const dir = mkdtempSync(path.join(tmpdir(), "delegate-claude-test-"));
    const filePath = path.join(dir, "agent.md");
    writeFileSync(filePath, content, "utf-8");

    try {
      return { config: loadClaudeAgentFile(filePath), warnings };
    } finally {
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("only unsupported tools leaves the agent with no tools and warns", () => {
    const { config, warnings } = loadWithWarnings(`---
name: web-only
description: Only unsupported Claude tools
tools: WebSearch, WebFetch
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("no mappable tools");
  });

  test("mappable + unmappable resolves to only the mappable tools", () => {
    const { config, warnings } = loadWithWarnings(`---
name: mixed
description: Mixed mappable and unmappable
tools: Read, WebSearch, WebFetch, TodoWrite
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual(["read"]);
    expect(warnings).toHaveLength(0);
  });

  test("no tools field still inherits the full default set", () => {
    const { config, warnings } = loadWithWarnings(`---
name: no-tools
description: No tools field
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual(DEFAULT_TOOLS);
    expect(warnings).toHaveLength(0);
  });

  test("denying Bash from an explicit allowlist does not restore extra search tools", () => {
    const { config } = loadWithWarnings(`---
name: no-shell-scout
description: No shell but file search is fine
tools: Bash, Read
disallowedTools: Bash
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual(["read"]);
  });

  test("denying Bash with only Bash in the allowlist yields no tools", () => {
    const { config } = loadWithWarnings(`---
name: bash-denied
description: Bash subsumed search tools
tools: Bash
disallowedTools: Bash
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual([]);
  });

  test("denying Bash does not duplicate an already listed search tool", () => {
    const { config } = loadWithWarnings(`---
name: bash-plus-grep
description: Bash plus grep, with bash denied
tools: Bash, Grep
disallowedTools: Bash
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual(["grep"]);
  });

  test("denying Bash when it was never allowed does not restore search tools", () => {
    const { config } = loadWithWarnings(`---
name: read-only
description: Read only, bash was never allowed
tools: Read
disallowedTools: Bash
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual(["read"]);
  });

  test("denying Bash and an explicitly denied search tool does not restore it", () => {
    const { config } = loadWithWarnings(`---
name: no-shell-no-grep
description: No shell and no grep
tools: Bash
disallowedTools: Bash, Grep
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual([]);
  });

  test("denying Bash from an omitted allowlist restores the search tools it subsumed", () => {
    const { config, warnings } = loadWithWarnings(`---
name: no-shell-inherited
description: Inherited full set with bash denied
disallowedTools: Bash
---
Body.
`);
    expect(config).toBeDefined();
    expect(config!.tools).toEqual([
      "read",
      "write",
      "edit",
      "grep",
      "find",
      "ls",
    ]);
    expect(warnings).toHaveLength(0);
  });
});

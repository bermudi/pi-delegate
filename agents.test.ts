import { describe, expect, test } from "bun:test";

import {
  buildSubagentSystemPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  parseFrontmatter,
} from "./agents.ts";

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
});

describe("parseFrontmatter", () => {
  // ── The brittle cases the real YAML parser now handles ────────────────

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

  test("values containing colons parse correctly", () => {
    // The old regex split on the first colon and silently truncated the value.
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

  test("returns empty data when no frontmatter", () => {
    const result = parseFrontmatter("Just body text.");
    expect(Object.keys(result.data)).toHaveLength(0);
    expect(result.body).toBe("Just body text.");
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

  test("drops keys with an empty value", () => {
    // An empty value (`key:`) parses to YAML null and is dropped rather than
    // kept as a blank string — blank fields simply don't carry information.
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
    // `*` alone is a YAML alias indicator (invalid as a scalar). The loader
    // quotes it so it parses as the string "*", which resolveFrontmatterTools
    // then expands via TOOL_GROUPS.
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

  test("nested map values are JSON-stringified, not '[object Object]'", () => {
    // The agent frontmatter schema is flat by convention, but a stray nested
    // map must not silently degrade to the useless String() output.
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

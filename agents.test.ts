import { describe, expect, test } from "bun:test";

import {
  buildSubagentSystemPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
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

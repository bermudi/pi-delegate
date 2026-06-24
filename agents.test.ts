import { describe, expect, test } from "bun:test";

import {
  buildSubagentSystemPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
} from "./agents.ts";

// Pure-function tests for the subagent prompt resolver. These pin the
// precedence and freeze contracts that the integration tests in
// lifecycle.test.ts only exercise indirectly through the streamSimple mock.

describe("buildSubagentSystemPrompt", () => {
  const empty = { skillBodies: [], agentsMdFiles: [] };

  // ── Precedence: task > agent > parent > default ───────────────────────

  test("task prompt wins over agent, parent, and default", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
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
      ...empty,
      agentSystemPrompt: "AGENT_PROMPT",
      parentSystemPrompt: "PARENT_PROMPT",
    });
    expect(prompt.startsWith("AGENT_PROMPT")).toBe(true);
    expect(prompt).not.toContain("PARENT_PROMPT");
  });

  test("parent prompt wins when no task or agent prompt", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
      parentSystemPrompt: "PARENT_PROMPT",
    });
    expect(prompt.startsWith("PARENT_PROMPT")).toBe(true);
  });

  test("falls back to default when nothing is set", () => {
    const prompt = buildSubagentSystemPrompt(empty);
    expect(prompt).toBe(DEFAULT_SUBAGENT_SYSTEM_PROMPT);
  });

  // ── Blank handling in precedence chain ────────────────────────────────

  test("blank task prompt is skipped, agent wins", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
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
      skillBodies: ["SKILL_SHOULD_NOT_APPEND"],
      agentsMdFiles: ["AGENTS_MD_SHOULD_NOT_APPEND"],
    });
    expect(prompt).toBe("POOLED_FROZEN_PROMPT");
    expect(prompt).not.toContain("TASK_SHOULD_NOT_WIN");
    expect(prompt).not.toContain("SKILL_SHOULD_NOT_APPEND");
    expect(prompt).not.toContain("AGENTS_MD_SHOULD_NOT_APPEND");
  });

  test("blank pooled prompt does not trigger freeze", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
      pooledSystemPrompt: "   ",
      taskSystemPrompt: "TASK_PROMPT",
    });
    expect(prompt.startsWith("TASK_PROMPT")).toBe(true);
  });

  // ── Skills / AGENTS no longer appended here ────────────────────────────
  // buildSubagentSystemPrompt now returns only the base prompt. AgentSession's
  // resource loader owns skill + AGENTS.md discovery and appends them via
  // _rebuildSystemPrompt. These tests pin that skills/AGENTS.md passed in are
  // NOT appended (would double-count with AgentSession's own discovery).

  test("skills and AGENTS.md are NOT appended (AgentSession owns them)", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
      taskSystemPrompt: "BASE",
      skillBodies: ["SKILL_A", "SKILL_B"],
      agentsMdFiles: ["AGENTS_MD"],
    });
    expect(prompt).toBe("BASE");
    expect(prompt).not.toContain("SKILL_A");
    expect(prompt).not.toContain("SKILL_B");
    expect(prompt).not.toContain("AGENTS_MD");
  });

  test("multiple AGENTS.md files are not appended", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
      taskSystemPrompt: "BASE",
      agentsMdFiles: ["FILE_ONE", "FILE_TWO"],
    });
    expect(prompt).toBe("BASE");
    expect(prompt).not.toContain("FILE_ONE");
    expect(prompt).not.toContain("FILE_TWO");
  });

  test("base prompt is returned verbatim regardless of skill/AGENTS inputs", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
      taskSystemPrompt: "BASE",
      skillBodies: ["", "  \n  ", "REAL_SKILL"],
      agentsMdFiles: [],
    });
    expect(prompt).toBe("BASE");
    expect(prompt).not.toContain("REAL_SKILL");
  });

  test("skills do not append when pooled prompt is set", () => {
    const prompt = buildSubagentSystemPrompt({
      pooledSystemPrompt: "POOLED",
      skillBodies: ["SKILL_A", "SKILL_B"],
      agentsMdFiles: ["AGENTS_MD"],
    });
    expect(prompt).toBe("POOLED");
  });
});

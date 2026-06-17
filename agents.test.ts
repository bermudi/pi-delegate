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

  // ── Skills / AGENTS append once, in order ─────────────────────────────

  test("skills and AGENTS.md append after base, in order", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
      taskSystemPrompt: "BASE",
      skillBodies: ["SKILL_A", "SKILL_B"],
      agentsMdFiles: ["AGENTS_MD"],
    });
    expect(prompt.indexOf("BASE")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("SKILL_A")).toBeGreaterThan(prompt.indexOf("BASE"));
    expect(prompt.indexOf("SKILL_B")).toBeGreaterThan(prompt.indexOf("SKILL_A"));
    expect(prompt.indexOf("AGENTS_MD")).toBeGreaterThan(prompt.indexOf("SKILL_B"));
  });

  test("multiple AGENTS.md files are both appended after base, in order", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
      taskSystemPrompt: "BASE",
      agentsMdFiles: ["FILE_ONE", "FILE_TWO"],
    });
    // Order via indexOf so the test doesn't depend on how the joined files
    // are split by blank lines (split("\n\n") would miscount on real
    // AGENTS.md content containing paragraph breaks).
    expect(prompt.indexOf("BASE")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("FILE_ONE")).toBeGreaterThan(prompt.indexOf("BASE"));
    expect(prompt.indexOf("FILE_TWO")).toBeGreaterThan(prompt.indexOf("FILE_ONE"));
  });

  test("blank skill/AGENTS sections are skipped", () => {
    const prompt = buildSubagentSystemPrompt({
      ...empty,
      taskSystemPrompt: "BASE",
      skillBodies: ["", "  \n  ", "REAL_SKILL"],
      agentsMdFiles: [],
    });
    expect(prompt).toBe("BASE\n\nREAL_SKILL");
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

import { describe, expect, test } from "bun:test";
import { prepareDelegateArguments } from "./schema.ts";
import { getSubagentManualMarkdown } from "./manual.ts";

describe("prepareDelegateArguments", () => {
  test("passes well-formed arguments through unchanged", () => {
    const args = { tasks: [{ prompt: "hi", tools: ["read"] }], async: false };
    expect(prepareDelegateArguments(args)).toEqual(args);
  });

  test("recovers a stringified tasks array", () => {
    const result = prepareDelegateArguments({ tasks: '[{"prompt":"hi"}]' });
    expect(result.tasks).toEqual([{ prompt: "hi" }]);
  });

  test("leaves an unparseable tasks string for schema validation", () => {
    const result = prepareDelegateArguments({ tasks: "not json" });
    expect((result as Record<string, unknown>).tasks).toBe("not json");
  });

  test("wraps flat task fields into a single task", () => {
    const result = prepareDelegateArguments({
      prompt: "do the thing",
      systemPrompt: "you are helpful",
      context: "fresh",
      tools: '["*"]',
    });
    expect(result.tasks).toEqual([
      {
        prompt: "do the thing",
        systemPrompt: "you are helpful",
        context: "fresh",
        tools: ["*"],
      },
    ]);
    // Task fields are removed from the top level.
    for (const key of ["prompt", "systemPrompt", "context", "tools"]) {
      expect(key in result).toBe(false);
    }
  });

  test("preserves top-level async alongside the wrapped task", () => {
    const result = prepareDelegateArguments({ async: true, prompt: "bg" });
    expect(result.async).toBe(true);
    expect(result.tasks).toEqual([{ prompt: "bg" }]);
  });

  test("folds a flat task-level close action into the wrapped task", () => {
    const result = prepareDelegateArguments({
      action: "close",
      sessionId: "s1",
    });
    expect(result.tasks).toEqual([{ action: "close", sessionId: "s1" }]);
    expect(result.action).toBeUndefined();
  });

  test("does not wrap when a ticket action is present", () => {
    for (const action of ["poll", "cancel", "wait"] as const) {
      const result = prepareDelegateArguments({ action, prompt: "stray" });
      expect(result.tasks).toBeUndefined();
      expect(result.action).toBe(action);
      expect("prompt" in result).toBe(true);
    }
  });

  test("does not wrap when a ticket id is present", () => {
    const result = prepareDelegateArguments({ ticket: "t1", prompt: "stray" });
    expect(result.tasks).toBeUndefined();
    expect(result.ticket).toBe("t1");
  });

  test("a valid tasks array wins over flat fields", () => {
    const result = prepareDelegateArguments({
      tasks: [{ prompt: "real" }],
      prompt: "stray",
    });
    expect(result.tasks).toEqual([{ prompt: "real" }]);
  });

  test("flat fields recover even when tasks is an empty array", () => {
    const result = prepareDelegateArguments({ tasks: [], prompt: "hi" });
    expect(result.tasks).toEqual([{ prompt: "hi" }]);
  });

  test("parses stringified tools inside existing task entries", () => {
    const result = prepareDelegateArguments({
      tasks: [{ prompt: "a", tools: '["read","grep"]' }, { prompt: "b" }],
    });
    expect(result.tasks).toEqual([
      { prompt: "a", tools: ["read", "grep"] },
      { prompt: "b" },
    ]);
  });

  test("wraps a bare tools group token into an array", () => {
    const result = prepareDelegateArguments({
      tasks: [{ prompt: "a", tools: "ro" }],
    });
    expect(result.tasks).toEqual([{ prompt: "a", tools: ["ro"] }]);
  });

  test("leaves a multi-token tools string for schema validation", () => {
    const result = prepareDelegateArguments({
      tasks: [{ prompt: "a", tools: "read, write" }],
    });
    expect(result.tasks).toEqual([{ prompt: "a", tools: "read, write" }]);
  });

  test("non-object input passes through untouched", () => {
    expect(prepareDelegateArguments(undefined)).toBeUndefined();
    expect(prepareDelegateArguments(null as unknown)).toBeNull();
    expect(prepareDelegateArguments("junk" as unknown)).toBe("junk");
  });

  test("empty calls stay empty so help still works", () => {
    expect(prepareDelegateArguments({}).tasks).toBeUndefined();
    expect(prepareDelegateArguments({ tasks: [] }).tasks).toEqual([]);
  });
});

describe("getSubagentManualMarkdown", () => {
  test("opens by explaining it was returned because the call had no tasks", () => {
    const manual = getSubagentManualMarkdown(new Map());
    const intro = manual.split("\n\n", 3).join("\n\n");
    expect(intro).toContain("no tasks");
    expect(intro).toContain("Nothing is broken");
    expect(intro).toContain("tasks: [{ ... }]");
  });
});

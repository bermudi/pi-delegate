import { describe, expect, test } from "bun:test";
import {
  normalizeDelegateArguments,
  validateDelegateOperation,
} from "./schema.ts";
import { getSubagentManualMarkdown } from "./manual.ts";
import type { DelegateArguments } from "./types.ts";

describe("normalizeDelegateArguments", () => {
  test("passes well-formed arguments through unchanged", () => {
    const args = { tasks: [{ prompt: "hi", tools: ["read"] }], async: false };
    expect(normalizeDelegateArguments(args)).toEqual(args);
  });

  test("recovers a stringified tasks array", () => {
    const result = normalizeDelegateArguments({ tasks: '[{"prompt":"hi"}]' });
    expect(result.tasks).toEqual([{ prompt: "hi" }]);
  });

  test("leaves an unparseable tasks string for schema validation", () => {
    const result = normalizeDelegateArguments({ tasks: "not json" });
    expect((result as Record<string, unknown>).tasks).toBe("not json");
  });

  test("wraps flat task fields into a single task", () => {
    const result = normalizeDelegateArguments({
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
    const result = normalizeDelegateArguments({ async: true, prompt: "bg" });
    expect(result.async).toBe(true);
    expect(result.tasks).toEqual([{ prompt: "bg" }]);
  });

  test("folds a flat task-level close action into the wrapped task", () => {
    const result = normalizeDelegateArguments({
      action: "close",
      sessionId: "s1",
    });
    expect(result.tasks).toEqual([{ action: "close", sessionId: "s1" }]);
    expect(result.action).toBeUndefined();
  });

  test("does not wrap when a ticket action is present", () => {
    for (const action of ["poll", "cancel", "wait"] as const) {
      const result = normalizeDelegateArguments({ action, prompt: "stray" });
      expect(result.tasks).toBeUndefined();
      expect(result.action).toBe(action);
      expect("prompt" in result).toBe(true);
    }
  });

  test("does not wrap when a ticket id is present", () => {
    const result = normalizeDelegateArguments({
      ticket: "t1",
      prompt: "stray",
    });
    expect(result.tasks).toBeUndefined();
    expect(result.ticket).toBe("t1");
  });

  test("a valid tasks array wins over flat fields", () => {
    const result = normalizeDelegateArguments({
      tasks: [{ prompt: "real" }],
      prompt: "stray",
    });
    expect(result.tasks).toEqual([{ prompt: "real" }]);
  });

  test("flat fields recover even when tasks is an empty array", () => {
    const result = normalizeDelegateArguments({ tasks: [], prompt: "hi" });
    expect(result.tasks).toEqual([{ prompt: "hi" }]);
  });

  test("parses stringified tools inside existing task entries", () => {
    const result = normalizeDelegateArguments({
      tasks: [{ prompt: "a", tools: '["read","grep"]' }, { prompt: "b" }],
    });
    expect(result.tasks).toEqual([
      { prompt: "a", tools: ["read", "grep"] },
      { prompt: "b" },
    ]);
  });

  test("wraps a bare tools group token into an array", () => {
    const result = normalizeDelegateArguments({
      tasks: [{ prompt: "a", tools: "ro" }],
    });
    expect(result.tasks).toEqual([{ prompt: "a", tools: ["ro"] }]);
  });

  test("leaves a multi-token tools string for schema validation", () => {
    const result = normalizeDelegateArguments({
      tasks: [{ prompt: "a", tools: "read, write" }],
    });
    expect(result.tasks).toEqual([{ prompt: "a", tools: "read, write" }]);
  });

  test("non-object input passes through untouched", () => {
    expect(normalizeDelegateArguments(undefined)).toBeUndefined();
    expect(normalizeDelegateArguments(null as unknown)).toBeNull();
    expect(normalizeDelegateArguments("junk" as unknown)).toBe("junk");
  });

  test("empty calls stay empty so help still works", () => {
    expect(normalizeDelegateArguments({}).tasks).toBeUndefined();
    expect(normalizeDelegateArguments({ tasks: [] }).tasks).toEqual([]);
  });

  test('treats agent:"" as omitted inside task entries', () => {
    const result = normalizeDelegateArguments({
      tasks: [
        { prompt: "a", agent: "" },
        { prompt: "b", agent: "reviewer" },
      ],
    });
    expect(result.tasks).toEqual([
      { prompt: "a" },
      { prompt: "b", agent: "reviewer" },
    ]);
  });

  test('strips a flat top-level agent:"" after folding', () => {
    const result = normalizeDelegateArguments({ prompt: "x", agent: "" });
    expect(result.tasks).toEqual([{ prompt: "x" }]);
    expect("agent" in result).toBe(false);
  });

  test("preserves the built-in default agent selector", () => {
    expect(
      normalizeDelegateArguments({ prompt: "x", agent: "default" }).tasks,
    ).toEqual([{ prompt: "x", agent: "default" }]);
  });
});

describe("validateDelegateOperation task-field whitelist", () => {
  test("rejects a task-level async flag with a corrective hint", () => {
    const err = validateDelegateOperation({
      tasks: [{ prompt: "x", async: true }],
    } as unknown as DelegateArguments);
    expect(err).toContain("task 1: unknown field(s) 'async'");
    expect(err).toContain("top-level flag");
  });

  test("rejects misspelled task fields and lists the valid set", () => {
    const err = validateDelegateOperation({
      tasks: [{ prompt: "x", promtp: "y" }],
    } as unknown as DelegateArguments);
    expect(err).toContain("task 1: unknown field(s) 'promtp'");
    expect(err).toContain("prompt");
    expect(err).toContain("resumeFrom");
    expect(err).not.toContain("top-level flag");
  });

  test("indexes the offending task", () => {
    const err = validateDelegateOperation({
      tasks: [{ prompt: "ok" }, { prompt: "x", bogus: 1 }],
    } as unknown as DelegateArguments);
    expect(err).toContain("task 2: unknown field(s) 'bogus'");
  });

  test("accepts a task using every valid field", () => {
    const err = validateDelegateOperation({
      tasks: [
        {
          prompt: "x",
          agent: "a",
          cwd: "/tmp",
          systemPrompt: "s",
          context: "fresh",
          model: "m",
          tools: ["ro"],
          thinking: "low",
          sessionId: "s1",
          action: "prompt",
          resumeFrom: "/tmp/s.jsonl",
        },
      ],
    });
    expect(err).toBeUndefined();
  });

  test("an unknown key on close reports the key, not the extras rule", () => {
    const err = validateDelegateOperation({
      tasks: [{ action: "close", sessionId: "s1", bogus: 1 }],
    } as unknown as DelegateArguments);
    expect(err).toContain("unknown field(s) 'bogus'");
  });

  test("a known-but-disallowed field on close still hits the extras rule", () => {
    const err = validateDelegateOperation({
      tasks: [{ action: "close", sessionId: "s1", prompt: "x" }],
    });
    expect(err).toContain("accepts only action and sessionId");
  });

  test("ticket-control calls skip task checks", () => {
    expect(validateDelegateOperation({ action: "poll" })).toBeUndefined();
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

  test("documents the built-in default agent with a canonical call", () => {
    const manual = getSubagentManualMarkdown(new Map());
    expect(manual).toContain("## Built-in Agent");
    expect(manual).toContain('agent: "default"');
    expect(manual).toContain("live parent model");
    expect(manual).toContain("extension/MCP tools are not copied");
  });
});

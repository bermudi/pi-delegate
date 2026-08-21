import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  delegateArgumentsSchema,
  delegateTaskSchema,
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

  test("does not wrap when a ticket action is present", () => {
    for (const ticketAction of ["poll", "cancel", "wait"] as const) {
      const result = normalizeDelegateArguments({
        ticketAction,
        prompt: "stray",
      });
      expect(result.tasks).toBeUndefined();
      expect(result.ticketAction).toBe(ticketAction);
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

  test("folds a flat top-level sessionAction into the wrapped task", () => {
    const result = normalizeDelegateArguments({
      sessionAction: "close",
      sessionId: "s1",
    });
    expect(result.tasks).toEqual([{ sessionAction: "close", sessionId: "s1" }]);
    expect("sessionAction" in result).toBe(false);
    expect("sessionId" in result).toBe(false);
    expect(
      validateDelegateOperation(result as DelegateArguments),
    ).toBeUndefined();
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
  test("provider schema rejects the removed top-level unsafe bypass", () => {
    expect(
      Value.Check(delegateArgumentsSchema, {
        unsafeSharedWrites: true,
        tasks: [{ prompt: "x" }],
      }),
    ).toBe(false);
  });

  test("rejects the removed top-level action field", () => {
    const cases = [
      { action: "poll" },
      { action: "poll", tasks: [{ prompt: "work" }] },
      { action: "close", sessionId: "s1" },
    ];

    for (const params of cases) {
      const err = validateDelegateOperation(
        normalizeDelegateArguments(params) as DelegateArguments,
      );
      expect(err).toContain("unsupported field 'action'");
      expect(err).toContain("ticketAction");
      expect(err).toContain("sessionAction");
    }
  });

  test("rejects a task-level async flag with a corrective hint", () => {
    const err = validateDelegateOperation({
      tasks: [{ prompt: "x", async: true }],
    } as unknown as DelegateArguments);
    expect(err).toContain("task 1: unknown field(s) 'async'");
    expect(err).toContain("top-level flag");
  });

  test("rejects the removed unsafeSharedWrites task field", () => {
    const misplaced = validateDelegateOperation({
      tasks: [{ prompt: "x", unsafeSharedWrites: true }],
    } as unknown as DelegateArguments);
    expect(misplaced).toContain(
      "task 1: unknown field(s) 'unsafeSharedWrites'",
    );
    expect(misplaced).not.toContain("top-level flag");
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
          id: "task-1",
          prompt: "x",
          agent: "a",
          cwd: "/tmp",
          systemPrompt: "s",
          context: "fresh",
          model: "m",
          tools: ["ro"],
          thinking: "low",
          sessionId: "s1",
          sessionAction: "prompt",
          resumeFrom: "/tmp/s.jsonl",
          deadlineMs: 1000,
          workspace: "shared",
        },
      ],
    });
    expect(err).toBeUndefined();
  });

  test("rejects scratch workspace with persistent sessions or resume", () => {
    expect(
      validateDelegateOperation({
        tasks: [{ prompt: "x", workspace: "scratch", sessionId: "s1" }],
      }),
    ).toContain("workspace 'scratch' is one-shot");
    expect(
      validateDelegateOperation({
        tasks: [
          { prompt: "x", workspace: "scratch", resumeFrom: "/tmp/s.jsonl" },
        ],
      }),
    ).toContain("workspace 'scratch' is one-shot");
    expect(
      validateDelegateOperation({
        tasks: [{ prompt: "x", workspace: "scratch", sessionAction: "prompt" }],
      }),
    ).toContain("workspace 'scratch' is one-shot");
  });

  test("rejects async or persistent isolated workspaces", () => {
    expect(
      validateDelegateOperation({
        async: true,
        tasks: [{ prompt: "x", workspace: "isolated" }],
      }),
    ).toContain('workspace "isolated" is synchronous');
    expect(
      validateDelegateOperation({
        tasks: [
          {
            prompt: "x",
            workspace: "isolated",
            sessionId: "persistent",
          },
        ],
      }),
    ).toContain("one-shot");
  });

  test("rejects non-positive deadlineMs", () => {
    expect(
      validateDelegateOperation({
        tasks: [{ prompt: "x", deadlineMs: 0 }],
      } as unknown as DelegateArguments),
    ).toContain("deadlineMs must be a positive number");
    expect(
      validateDelegateOperation({
        tasks: [{ prompt: "x", deadlineMs: -10 }],
      } as unknown as DelegateArguments),
    ).toContain("deadlineMs must be a positive number");
    expect(
      validateDelegateOperation({
        tasks: [{ prompt: "x", deadlineMs: NaN }],
      } as unknown as DelegateArguments),
    ).toContain("deadlineMs must be a positive number");
  });

  test("rejects deadlineMs on close and list actions", () => {
    expect(
      validateDelegateOperation({
        tasks: [{ sessionAction: "close", sessionId: "s1", deadlineMs: 100 }],
      } as unknown as DelegateArguments),
    ).toContain("accepts only sessionAction and sessionId");

    expect(
      validateDelegateOperation({
        tasks: [{ sessionAction: "list", deadlineMs: 100 }],
      } as unknown as DelegateArguments),
    ).toContain("accepts only sessionAction");
  });

  test("an unknown key on close reports the key, not the extras rule", () => {
    const err = validateDelegateOperation({
      tasks: [{ sessionAction: "close", sessionId: "s1", bogus: 1 }],
    } as unknown as DelegateArguments);
    expect(err).toContain("unknown field(s) 'bogus'");
  });

  test("a known-but-disallowed field on close still hits the extras rule", () => {
    const err = validateDelegateOperation({
      tasks: [{ sessionAction: "close", sessionId: "s1", prompt: "x" }],
    });
    expect(err).toContain("accepts only sessionAction and sessionId");
  });

  test("allows id on close tasks", () => {
    const err = validateDelegateOperation({
      tasks: [{ id: "cleanup", sessionAction: "close", sessionId: "s1" }],
    });
    expect(err).toBeUndefined();
  });

  test("allows id on list tasks", () => {
    const err = validateDelegateOperation({
      tasks: [{ id: "list-all", sessionAction: "list" }],
    });
    expect(err).toBeUndefined();
  });

  test("ticket-control calls skip task checks", () => {
    expect(validateDelegateOperation({ ticketAction: "poll" })).toBeUndefined();
  });

  test("rejects ticket control combined with prompt", () => {
    const err = validateDelegateOperation({
      ticketAction: "poll",
      prompt: "continue work",
    } as unknown as DelegateArguments);
    expect(err).toContain(
      "ticket control cannot be combined with task-intent field(s) 'prompt'",
    );
    expect(err).toContain("call it separately");
  });

  test("rejects ticket control combined with tasks", () => {
    const err = validateDelegateOperation({
      ticketAction: "poll",
      tasks: [{ prompt: "x" }],
    });
    expect(err).toContain(
      "ticket control cannot be combined with task-intent field(s) 'tasks'",
    );
    expect(err).toContain("call it separately");
  });

  test("rejects ticket control combined with sessionId", () => {
    const err = validateDelegateOperation({
      ticketAction: "poll",
      sessionId: "s1",
    } as unknown as DelegateArguments);
    expect(err).toContain(
      "ticket control cannot be combined with task-intent field(s) 'sessionId'",
    );
    expect(err).toContain("call it separately");
  });

  test("rejects ticket control combined with sessionAction", () => {
    const err = validateDelegateOperation({
      ticketAction: "poll",
      sessionAction: "prompt",
    } as unknown as DelegateArguments);
    expect(err).toContain(
      "ticket control cannot be combined with task-intent field(s) 'sessionAction'",
    );
    expect(err).toContain("call it separately");
  });

  test("allows a ticket-only wait call", () => {
    expect(
      validateDelegateOperation({
        ticketAction: "wait",
        ticket: "t1",
        timeoutMs: 1000,
      }),
    ).toBeUndefined();
  });

  test("allows a task-only call", () => {
    expect(
      validateDelegateOperation({ tasks: [{ prompt: "x" }] }),
    ).toBeUndefined();
  });

  test("rejects the review ticket/task ambiguity cases", () => {
    const cases = [
      [{ ticketAction: "poll", cwd: "/tmp" }, "cwd"],
      [{ ticketAction: "poll", agent: "default" }, "agent"],
      [{ ticketAction: "wait", ticket: "t", tools: ["ro"] }, "tools"],
      [{ ticketAction: "cancel", ticket: "t", deadlineMs: 5 }, "deadlineMs"],
    ] as const;
    for (const [args, field] of cases) {
      const err = validateDelegateOperation(
        args as unknown as DelegateArguments,
      );
      expect(err).toContain(
        `ticket control cannot be combined with task-intent field(s) '${field}'`,
      );
      expect(err).toContain("call it separately");
    }
  });

  test("allows legitimate ticket-only calls", () => {
    expect(validateDelegateOperation({ ticketAction: "poll" })).toBeUndefined();
    expect(
      validateDelegateOperation({ ticketAction: "poll", ticket: "t1" }),
    ).toBeUndefined();
    expect(
      validateDelegateOperation({
        ticketAction: "wait",
        ticket: "t1",
        timeoutMs: 1000,
      }),
    ).toBeUndefined();
    expect(
      validateDelegateOperation({
        ticketAction: "cancel",
        ticket: "t1",
        force: true,
      }),
    ).toBeUndefined();
  });

  test("rejects canonical flat task fields mixed with an explicit tasks array", () => {
    const err = validateDelegateOperation({
      sessionAction: "close",
      sessionId: "s1",
      tasks: [{ prompt: "work" }],
    } as unknown as DelegateArguments);
    expect(err).toContain("cannot mix top-level task field(s)");
    expect(err).toContain("'sessionId'");
    expect(err).toContain("'sessionAction'");
    expect(err).toContain("explicit tasks array");
  });

  test("rejects any flat task field mixed with an explicit tasks array", () => {
    const err = validateDelegateOperation({
      prompt: "stray",
      tasks: [{ prompt: "real" }],
    } as unknown as DelegateArguments);
    expect(err).toContain("cannot mix top-level task field(s) 'prompt'");
    expect(err).toContain("explicit tasks array");
  });

  test("allows flat task fields when no tasks array is present", () => {
    expect(
      validateDelegateOperation(
        normalizeDelegateArguments({
          prompt: "do the thing",
          tools: ["ro"],
        }) as DelegateArguments,
      ),
    ).toBeUndefined();
  });

  test("allows a canonical tasks-only call", () => {
    expect(
      validateDelegateOperation({
        tasks: [{ prompt: "work" }],
      }),
    ).toBeUndefined();
  });

  test("allows flat task fields with an empty tasks array", () => {
    expect(
      validateDelegateOperation(
        normalizeDelegateArguments({
          tasks: [],
          prompt: "help",
        }) as DelegateArguments,
      ),
    ).toBeUndefined();
  });
});

describe("task id validation", () => {
  test("accepts valid task ids", () => {
    for (const id of ["a", "A", "0", "task-1", "a.b_c-1", "x".repeat(64)]) {
      expect(validateDelegateOperation({ tasks: [{ id, prompt: "x" }] })).toBe(
        undefined,
      );
      expect(Value.Check(delegateTaskSchema, { id, prompt: "x" })).toBe(true);
    }
  });

  test("rejects an empty task id", () => {
    const err = validateDelegateOperation({
      tasks: [{ id: "", prompt: "x" }],
    } as unknown as DelegateArguments);
    expect(err).toContain("task 1");
    expect(err).toContain("id must be 1-64");
  });

  test("rejects a too-long task id", () => {
    const long = "x".repeat(65);
    const opErr = validateDelegateOperation({
      tasks: [{ id: long, prompt: "x" }],
    });
    expect(opErr).toContain("task 1");
    expect(opErr).toContain("id must be 1-64");
    expect(Value.Check(delegateTaskSchema, { id: long, prompt: "x" })).toBe(
      false,
    );
  });

  test("rejects task ids with newlines, control, unicode, or disallowed punctuation", () => {
    for (const id of [
      "task\n1",
      "task\t1",
      "task\x001",
      "täsk",
      "task 1",
      "task+1",
      "task/1",
      "task@1",
    ]) {
      expect(
        validateDelegateOperation({
          tasks: [{ id, prompt: "x" }],
        } as unknown as DelegateArguments),
      ).toContain("id must be 1-64");
      expect(Value.Check(delegateTaskSchema, { id, prompt: "x" })).toBe(false);
    }
  });

  test("valid task ids pass the schema", () => {
    expect(Value.Check(delegateTaskSchema, { id: "task-1", prompt: "x" })).toBe(
      true,
    );
    expect(
      Value.Check(delegateTaskSchema, { id: "a".repeat(64), prompt: "" }),
    ).toBe(true);
  });

  test("invalid task ids fail the schema", () => {
    expect(Value.Check(delegateTaskSchema, { id: "a\nb", prompt: "" })).toBe(
      false,
    );
    expect(
      Value.Check(delegateTaskSchema, { id: "a".repeat(65), prompt: "" }),
    ).toBe(false);
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

  test("documents that async usage is excluded from parent totals", () => {
    const manual = getSubagentManualMarkdown(new Map());
    expect(manual).toContain(
      "cannot fold their usage into the parent session total",
    );
  });

  test("documents that isolated workspaces are synchronous and one-shot", () => {
    const manual = getSubagentManualMarkdown(new Map());
    expect(manual).toContain('synchronous one-shot `workspace: "isolated"`');
    expect(delegateTaskSchema.properties.workspace.description).toContain(
      "isolated=sync one-shot",
    );
  });
});

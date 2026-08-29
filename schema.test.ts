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

  test("session intent at top level never wraps (case 1: close)", () => {
    // Flipped consciously from the #32 promotion's old pinned behavior, which
    // folded top-level sessionAction into a wrapped task. Top-level presence
    // now MEANS session RPC; only bare sessionId stays task-intent.
    const result = normalizeDelegateArguments({
      sessionAction: "close",
      sessionId: "s1",
    });
    expect(result.tasks).toBeUndefined();
    expect(result.sessionAction).toBe("close");
    expect(result.sessionId).toBe("s1");
    expect(
      validateDelegateOperation(result as DelegateArguments),
    ).toBeUndefined();
  });

  test("session intent at top level never wraps (case 2: list)", () => {
    const result = normalizeDelegateArguments({ sessionAction: "list" });
    expect(result.tasks).toBeUndefined();
    expect(result.sessionAction).toBe("list");
    expect(
      validateDelegateOperation(result as DelegateArguments),
    ).toBeUndefined();
  });

  test("bare top-level sessionId stays task-intent and wraps (case 3)", () => {
    const result = normalizeDelegateArguments({
      sessionId: "s1",
      prompt: "continue",
    });
    expect(result.tasks).toEqual([{ sessionId: "s1", prompt: "continue" }]);
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
    expect(err).toContain("top-level field");
  });

  test("rejects the removed unsafeSharedWrites task field", () => {
    const misplaced = validateDelegateOperation({
      tasks: [{ prompt: "x", unsafeSharedWrites: true }],
    } as unknown as DelegateArguments);
    expect(misplaced).toContain(
      "task 1: unknown field(s) 'unsafeSharedWrites'",
    );
    expect(misplaced).not.toContain("top-level field");
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
  });

  test("a task-level sessionAction is an unknown key with a top-level hint", () => {
    // Direct call bypassing the normalizer: post-#32 the schema has no
    // task-level sessionAction, so the whitelist owns it and points at the
    // promoted top-level field.
    const err = validateDelegateOperation({
      tasks: [{ prompt: "x", sessionAction: "prompt" }],
    } as unknown as DelegateArguments);
    expect(err).toContain("unknown field(s) 'sessionAction'");
    expect(err).toContain("'sessionAction' is a top-level field");
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
    expect(
      validateDelegateOperation({
        tasks: [
          {
            agent: "coder",
            prompt: "x",
            workspace: "isolated",
            resumeFrom: "/tmp/s.jsonl",
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

  test("a task-level close/list entry rejects as an unknown field with the top-level hint", () => {
    // Post-#42 end-state: no hoist — the entry reaches the dispatch
    // validator's whitelist. `sessionId` and `deadlineMs` are valid task
    // fields, so the only unknown key is 'sessionAction', named as a
    // top-level field.
    for (const entry of [
      { sessionAction: "close", sessionId: "s1", deadlineMs: 100 },
      { sessionAction: "list", deadlineMs: 100 },
    ]) {
      const err = validateDelegateOperation(
        normalizeDelegateArguments({ tasks: [entry] }) as DelegateArguments,
      );
      expect(err).toContain("unknown field(s) 'sessionAction'");
      expect(err).toContain("'sessionAction' is a top-level field");
    }
  });

  test("a task-level close entry with stray keys rejects both unknown fields together", () => {
    // Flipped consciously from the #32 shim window (solo entries hoisted
    // whole, session mode owning stray keys): no hoist remains — the
    // whitelist rejects 'sessionAction' and 'bogus' in one message, with the
    // top-level hint.
    const err = validateDelegateOperation(
      normalizeDelegateArguments({
        tasks: [{ sessionAction: "close", sessionId: "s1", bogus: 1 }],
      }) as DelegateArguments,
    );
    expect(err).toContain("'bogus'");
    expect(err).toContain("unknown field(s) 'sessionAction', 'bogus'");
    expect(err).toContain("'sessionAction' is a top-level field");
  });

  test("rejects a work task mixed with a task-level session-control entry", () => {
    const err = validateDelegateOperation({
      tasks: [
        { prompt: "do work" },
        { sessionAction: "close", sessionId: "s1" },
      ],
    });
    expect(err).toContain("task 2");
    expect(err).toContain("unknown field(s) 'sessionAction'");
    expect(err).toContain("'sessionAction' is a top-level field");
  });

  test("rejects a task-level list entry mixed with work tasks", () => {
    const err = validateDelegateOperation({
      tasks: [{ prompt: "a" }, { sessionAction: "list" }, { prompt: "b" }],
    });
    expect(err).toContain("task 2");
    expect(err).toContain("unknown field(s) 'sessionAction'");
    expect(err).toContain("'sessionAction' is a top-level field");
  });

  test("rejects multi-entry task-level control batches as unknown fields", () => {
    // Flipped consciously: #32 promoted one sessionAction per call, and #42
    // removed the shim/fence that corrected legacy batches — each entry now
    // fails the whitelist naming 'sessionAction' as a top-level field.
    const err = validateDelegateOperation({
      tasks: [
        { sessionAction: "close", sessionId: "s1" },
        { sessionAction: "list" },
      ],
    });
    expect(err).toContain("task 1");
    expect(err).toContain("unknown field(s) 'sessionAction'");
    expect(err).toContain("'sessionAction' is a top-level field");
  });

  test("rejects async calls with task-level session-control entries", () => {
    for (const tasks of [
      [{ sessionAction: "list" }],
      [
        { sessionAction: "close", sessionId: "s1" },
        { sessionAction: "close", sessionId: "s2" },
      ],
    ]) {
      const err = validateDelegateOperation({
        async: true,
        tasks,
      } as unknown as DelegateArguments);
      expect(err).toContain("unknown field(s) 'sessionAction'");
      expect(err).toContain("'sessionAction' is a top-level field");
    }
  });

  test("task-level sessionAction 'prompt' no longer strips; entries reject (case 9)", () => {
    // Flipped consciously from the shim window's silent strip (#42): the
    // normalizer leaves the shape intact and the whitelist rejects
    // 'sessionAction' with the top-level hint.
    for (const entry of [
      { prompt: "x", sessionAction: "prompt", sessionId: "s1" },
      { sessionAction: "prompt" },
    ]) {
      const result = normalizeDelegateArguments({ tasks: [entry] });
      expect(result.tasks).toEqual([entry]);
      const err = validateDelegateOperation(result as DelegateArguments);
      expect(err).toContain("unknown field(s) 'sessionAction'");
      expect(err).toContain("'sessionAction' is a top-level field");
    }
  });

  test("flat top-level sessionAction 'prompt' stays; session mode rejects the value", () => {
    // Flipped consciously from the silent strip (#42): 'prompt' is not
    // session intent, so the flat `prompt` still wraps into a task — but
    // `sessionAction` is not a task field, so it stays top-level, and
    // classifier precedence hands the call to session mode, which fails
    // closed on the dead value.
    const result = normalizeDelegateArguments({
      prompt: "x",
      sessionAction: "prompt",
    });
    expect(result).toEqual({
      sessionAction: "prompt",
      tasks: [{ prompt: "x" }],
    });
    expect(validateDelegateOperation(result as DelegateArguments)).toContain(
      "sessionAction 'prompt' is not a session control action",
    );
  });

  test("ticketAction precedence lists stray sessionAction as incompatible", () => {
    // Flipped consciously: no shim strips the dead 'prompt' value anymore —
    // ticket mode owns the rejection and names 'sessionAction' as foreign.
    const result = normalizeDelegateArguments({
      ticketAction: "poll",
      sessionAction: "prompt",
    });
    expect(result.sessionAction).toBe("prompt");
    expect(validateDelegateOperation(result as DelegateArguments)).toContain(
      "ticket control cannot be combined with field(s) 'sessionAction'",
    );
  });

  test("flat top-level control shape reaches session mode unwrapped", () => {
    // Rewritten for #32: the d2a513d insurance pinned WRAPPING; promotion cut
    // that seam, and the pin now guards the replacement behavior — top-level
    // close/list is never degraded into a task or the help manual. (Case 2
    // pins shape on the normalizer side; this pins classification.)
    expect(
      validateDelegateOperation(
        normalizeDelegateArguments({ sessionAction: "list" }),
      ),
    ).toBeUndefined();
  });

  test("flat top-level prompt+sessionAction rejects the stray prompt", () => {
    // Case 4 — the dangerous direction: wrapping first would swallow `prompt`
    // into a task and silently run it next to a close.
    const err = validateDelegateOperation(
      normalizeDelegateArguments({ prompt: "x", sessionAction: "list" }),
    );
    expect(err).toContain("'prompt'");
    expect(err).toContain("run it alone");
  });

  test("session mode tolerates default-valued fields (async:false, force:false, tasks:[])", () => {
    // A caller (or a schema validator that materialises defaults) may spell
    // out the default value of an optional field. These are no-ops and must
    // not be treated as foreign to session RPC.
    expect(
      validateDelegateOperation({
        sessionAction: "list",
        async: false,
      } as unknown as DelegateArguments),
    ).toBeUndefined();
    expect(
      validateDelegateOperation({
        sessionAction: "close",
        sessionId: "s1",
        force: false,
      } as unknown as DelegateArguments),
    ).toBeUndefined();
    expect(
      validateDelegateOperation({
        sessionAction: "list",
        tasks: [],
      } as unknown as DelegateArguments),
    ).toBeUndefined();
  });

  test("session mode still rejects meaningful foreign values", () => {
    // Default-valued fields are tolerated, but a real value on a foreign
    // field is still rejected — session RPC runs alone.
    expect(
      validateDelegateOperation({
        sessionAction: "list",
        async: true,
      } as unknown as DelegateArguments),
    ).toContain("'async'");
    expect(
      validateDelegateOperation({
        sessionAction: "list",
        tasks: [{ prompt: "work" }],
      } as unknown as DelegateArguments),
    ).toContain("'tasks'");
    expect(
      validateDelegateOperation({
        sessionAction: "list",
        force: true,
      } as unknown as DelegateArguments),
    ).toContain("'force'");
  });

  test("session mode does not suppress false or empty arrays for other fields", () => {
    expect(
      validateDelegateOperation({
        sessionAction: "list",
        prompt: false,
      } as unknown as DelegateArguments),
    ).toContain("'prompt'");
    expect(
      validateDelegateOperation({
        sessionAction: "list",
        tools: [],
      } as unknown as DelegateArguments),
    ).toContain("'tools'");
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
      "ticket control cannot be combined with field(s) 'prompt'",
    );
    expect(err).toContain("call it separately");
  });

  test("rejects ticket control combined with tasks", () => {
    const err = validateDelegateOperation({
      ticketAction: "poll",
      tasks: [{ prompt: "x" }],
    });
    expect(err).toContain(
      "ticket control cannot be combined with field(s) 'tasks'",
    );
    expect(err).toContain("call it separately");
  });

  test("rejects ticket control combined with sessionId", () => {
    const err = validateDelegateOperation({
      ticketAction: "poll",
      sessionId: "s1",
    } as unknown as DelegateArguments);
    expect(err).toContain(
      "ticket control cannot be combined with field(s) 'sessionId'",
    );
    expect(err).toContain("call it separately");
  });

  test("ticket control owns promoted top-level sessionAction as foreign (case 8)", () => {
    // Rewritten for #32: the exclusion used to ride TASK_FIELD_NAMES; after
    // promotion the ticket validator must own it explicitly or the check
    // silently evaporates once the task field disappears.
    const err = validateDelegateOperation({
      ticketAction: "poll",
      sessionAction: "close",
    } as unknown as DelegateArguments);
    expect(err).toContain(
      "ticket control cannot be combined with field(s) 'sessionAction'",
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
        `ticket control cannot be combined with field(s) '${field}'`,
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

  test("session precedence wins over tasks, which become foreign (case 10)", () => {
    // Rewritten for #32: pre-promotion this asserted the generic flat-fields
    // mix rejection; post-promotion the classifier routes by precedence and
    // `tasks` is simply not a legal companion of session RPC.
    const err = validateDelegateOperation(
      normalizeDelegateArguments({
        sessionAction: "close",
        sessionId: "s1",
        tasks: [{ prompt: "work" }],
      }) as DelegateArguments,
    );
    expect(err).toContain("'tasks'");
    expect(err).toContain("run it alone");
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

// The #32 promotion's test contract: every case from the approved
// normalizer matrix, pinned in one place. Cases 1-4 exercise intent
// detection; 5-7 and 9 the removed migration shim's legacy shapes, which
// since #42 reject as plain unknown fields; 8-10 classifier precedence.
describe("#32 normalizer case matrix", () => {
  const validate = (args: unknown) =>
    validateDelegateOperation(
      normalizeDelegateArguments(args) as DelegateArguments,
    );

  test("case 1: top-level close+sessionId is session mode, no wrap", () => {
    const result = normalizeDelegateArguments({
      sessionAction: "close",
      sessionId: "s1",
    });
    expect(result.tasks).toBeUndefined();
    expect(validate({ sessionAction: "close", sessionId: "s1" })).toBe(
      undefined,
    );
  });

  test("case 2: top-level list is session mode, no wrap", () => {
    const result = normalizeDelegateArguments({ sessionAction: "list" });
    expect(result.tasks).toBeUndefined();
    expect(validate({ sessionAction: "list" })).toBeUndefined();
  });

  test("case 3: bare sessionId + prompt still wraps into a task", () => {
    const result = normalizeDelegateArguments({
      sessionId: "s1",
      prompt: "continue",
    });
    expect(result.tasks).toEqual([{ sessionId: "s1", prompt: "continue" }]);
  });

  test("case 4: close+sessionId+prompt unwrapped; validator rejects stray prompt", () => {
    // Wrapping first would swallow the prompt into a task next to a close.
    expect(
      validate({ sessionAction: "close", sessionId: "s1", prompt: "x" }),
    ).toContain("'prompt'");
  });

  test("case 5: solo legacy control entry stays in tasks; whitelist rejects it", () => {
    // Flipped consciously from the hoist (#42 removed it): no solo entry is
    // lifted to the top level anymore — the entry travels intact (id and
    // all) and 'sessionAction' fails as an unknown task field with the
    // top-level hint.
    const entry = { id: "cleanup", sessionAction: "close", sessionId: "s1" };
    const result = normalizeDelegateArguments({ tasks: [entry] });
    expect(result.sessionAction).toBeUndefined();
    expect(result.tasks).toEqual([entry]);
    const err = validate({ tasks: [entry] });
    expect(err).toContain("unknown field(s) 'sessionAction'");
    expect(err).toContain("'sessionAction' is a top-level field");
  });

  test("case 6: task-level control inside a mixed batch is rejected as unknown", () => {
    const err = validateDelegateOperation({
      async: false,
      tasks: [{ prompt: "do work" }, { sessionAction: "list" }],
    });
    expect(err).toContain("task 2");
    expect(err).toContain("unknown field(s) 'sessionAction'");
    expect(err).toContain("'sessionAction' is a top-level field");
  });

  test("case 7: task-level control alongside async is rejected as unknown", () => {
    // The normalizer leaves the entry intact (shape pin held over from the
    // shim window); the whitelist owns the rejection — no async-specific
    // session copy anymore.
    const entry = { sessionAction: "close", sessionId: "s1" };
    const result = normalizeDelegateArguments({ async: true, tasks: [entry] });
    expect(result.tasks).toEqual([entry]);
    const err = validate({ async: true, tasks: [entry] });
    expect(err).toContain("unknown field(s) 'sessionAction'");
    expect(err).toContain("'sessionAction' is a top-level field");
  });

  test("case 9: task-level 'prompt' no longer strips; entries reject as unknown", () => {
    // Flipped consciously from the silent strip (#42): the dead default
    // value survives normalization and fails the whitelist with the hint.
    expect(
      normalizeDelegateArguments({
        tasks: [{ sessionAction: "prompt", prompt: "x" }],
      }),
    ).toEqual({ tasks: [{ sessionAction: "prompt", prompt: "x" }] });
    expect(
      validate({ tasks: [{ sessionAction: "prompt", prompt: "x" }] }),
    ).toContain("unknown field(s) 'sessionAction'");
    expect(
      normalizeDelegateArguments({ tasks: [{ sessionAction: "prompt" }] }),
    ).toEqual({ tasks: [{ sessionAction: "prompt" }] });
    expect(validate({ tasks: [{ sessionAction: "prompt" }] })).toContain(
      "'sessionAction' is a top-level field",
    );
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
      "orders Git worktree proposals",
    );
  });
});

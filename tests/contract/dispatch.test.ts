import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
  callDelegateTicket,
} from "../support/pi-boundary.ts";

describe("delegate dispatch contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "synchronous dispatch returns per-task results in task input order",
    async () => {
      // v1 evidence: lifecycle.test.ts "multiple fresh tasks run in parallel
      // and all succeed"; SPEC: synchronous results preserve task input order.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("OUTPUT-ALPHA"),
        fauxAssistantMessage("OUTPUT-BETA"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "first" },
          { prompt: "second" },
        ],
      });

      expect(result.isError).toBe(false);
      const alpha = result.text.indexOf("OUTPUT-ALPHA");
      const beta = result.text.indexOf("OUTPUT-BETA");
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(beta).toBeGreaterThan(alpha);
    },
  );

  test(
    "a failed task reports its own failure without failing its siblings",
    async () => {
      // v1 evidence: delegate.test.ts resolveFinalTicketStatus matrix;
      // failure is a per-task outcome, not a whole-call throw.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("OUTPUT-OK"),
        fauxAssistantMessage("boom", {
          stopReason: "error",
          errorMessage: "provider exploded",
        }),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "fine" },
          { prompt: "doomed" },
        ],
      });

      // The call itself completes; the failing task is reported as failed and
      // the sibling's output is still returned. A mixed batch is a result,
      // not a tool error — same semantics as an async ticket's `partial`.
      expect(result.isError).toBe(false);
      expect(result.text).toContain("OUTPUT-OK");
      expect(result.text).toMatch(/fail|error|exploded/i);
    },
  );

  test("a synchronous batch where every task failed is a tool error", async () => {
    // Issue #6's sync analog: an all-failure batch is error-valued like a
    // ticket settling `failed`; a partial batch is not (see above).
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider exploded",
      }),
    ]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "doomed" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/exploded/i);
  });

  test(
    "caller-provided task ids appear on results for correlation",
    async () => {
      // v1 evidence: dispatch.test.ts "carries caller-provided task id onto
      // result and progress".
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("OUTPUT-ID")]);

      const result = await callDelegate(session, {
        tasks: [{ id: "corr-1", prompt: "x" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("corr-1");
      expect(result.text).toContain("OUTPUT-ID");
    },
  );

  test(
    "synchronous results carry aggregate usage when the host supports it",
    async () => {
      // v1 evidence: usage.test.ts nested usage accounting; SPEC: synchronous
      // results include aggregate usage. Pi 0.81+ persists usage on the
      // toolResult message, so read it off the session event.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("done")]);

      await callDelegate(session, {
        tasks: [{ prompt: "x" }],
      });

      const end = session.events.all
        .filter(
          (e) => e.type === "tool_execution_end" && e.toolName === "delegate",
        )
        .at(-1);
      const result = (end as { result?: Record<string, unknown> } | undefined)
        ?.result;
      expect(result).toBeDefined();
      // Usage may live on the result or its details; either is the contract.
      const serialized = JSON.stringify(result);
      expect(serialized).toMatch(/usage|tokens/i);
    },
  );

  test(
    "async dispatch returns a ticket and the batch completes in background",
    async () => {
      // v1 evidence: delegate.test.ts async delegate integration; SPEC:
      // async:true returns a ticket immediately and auto-delivers the result.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("OUTPUT-ASYNC")]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg" }],
        async: true,
      });
      expect(dispatched.isError).toBe(false);
      const ticket = ticketIdOf(dispatched.text);

      const polled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(polled.isError).toBe(false);
      expect(polled.text).toContain("OUTPUT-ASYNC");
    },
  );

  test(
    "the configured concurrency bound limits simultaneous subagent work",
    async () => {
      // v1 evidence: concurrency.test.ts mapConcurrentByModel bound tests.
      // The session agent dir is the test cwd, so delegate.json there is the
      // user-global config a real Pi process would read. Read-only tools keep
      // the tasks out of shared-write serialization so the concurrency
      // limiter is what is actually measured.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { maxConcurrent: 1 });

      let active = 0;
      let maxActive = 0;
      const gated: FauxResponseFactory = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        return fauxAssistantMessage("done");
      };
      subagents.respond([gated, gated, gated]);

      const result = await callDelegate(session, {
        tasks: [0, 1, 2].map((n) => ({
          prompt: `task ${n}`,
          tools: ["read"],
        })),
      });

      expect(result.isError).toBe(false);
      expect(maxActive).toBe(1);
    },
  );

  test(
    "a later call re-reads the configured bound, both lower and higher",
    async () => {
      // The limit is per-call configuration: a coordinator must honour a
      // bound that changes between calls, in either direction, regardless of
      // how many permits are active or queued when it is applied.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { maxConcurrent: 1 });

      let active = 0;
      let maxActive = 0;
      const gated: FauxResponseFactory = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return fauxAssistantMessage("done");
      };

      subagents.respond([gated, gated, gated]);
      await callDelegate(session, {
        tasks: [0, 1, 2].map((n) => ({
          prompt: `low ${n}`,
          tools: ["read"],
        })),
      });
      expect(maxActive).toBe(1);

      configureDelegate(session, { maxConcurrent: 2 });
      active = 0;
      maxActive = 0;
      subagents.respond([gated, gated, gated, gated]);
      await callDelegate(session, {
        tasks: [0, 1, 2, 3].map((n) => ({
          prompt: `high ${n}`,
          tools: ["read"],
        })),
      });
      expect(maxActive).toBe(2);
    },
  );

  test(
    "a per-model concurrency bound serializes tasks on that model",
    async () => {
      // SPEC: concurrency limits are global and per-model. A model-scoped
      // bound of 1 must hold even when the global bound allows more.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        maxConcurrent: 3,
        concurrency: { models: { "delegate-faux/faux-1": 1 } },
      });

      let active = 0;
      let maxActive = 0;
      const gated: FauxResponseFactory = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        return fauxAssistantMessage("done");
      };
      subagents.respond([gated, gated, gated]);

      const result = await callDelegate(session, {
        tasks: [0, 1, 2].map((n) => ({
          prompt: `task ${n}`,
          tools: ["read"],
        })),
      });
      expect(result.isError).toBe(false);
      expect(maxActive).toBe(1);
      expect(subagents.state.callCount).toBe(3);
    },
  );

  test(
    "a task model field is rejected with guidance before any task starts",
    async () => {
      // SPEC: callers never select subagent models — callers are reliably
      // bad at picking models. A task `model` field (any value, even one the
      // registry knows) fails the whole call before tasks start and points
      // at the user-side config instead.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "nope", model: subagents.spec }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("model field is not accepted");
      expect(result.text).toContain("delegate.json");
      expect(subagents.state.callCount).toBe(0); // nothing started
    },
  );

  test(
    "a named agent's configured model overrides the inherited parent model",
    async () => {
      // SPEC: inline/default tasks mirror the parent's model — always. Only
      // a named agent with a delegate.json "models" entry runs elsewhere.
      // The parent session itself runs on the primary faux model (set by
      // installSubagentModel), so the inline task's provider call proves
      // inheritance while the scout task's proves the override.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        models: { scout: subagents.alt.spec },
      });
      subagents.respond([fauxAssistantMessage("INLINE-INHERITS-PARENT")]);
      subagents.alt.respond([fauxAssistantMessage("SCOUT-RUNS-CONFIGURED")]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "look around", agent: "scout" },
          { prompt: "plain work" },
        ],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("INLINE-INHERITS-PARENT");
      expect(result.text).toContain("SCOUT-RUNS-CONFIGURED");
      expect(subagents.state.callCount).toBe(1); // inline → parent model
      expect(subagents.alt.state.callCount).toBe(1); // scout → configured
    },
  );

  test(
    "a configured reference that does not resolve in the registry rejects the call",
    async () => {
      // SPEC: a configured reference that cannot resolve in the session's
      // model registry fails the whole call. The error names the config
      // entry so the human fixes delegate.json, not the caller.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        models: { scout: "ghost-provider/model-x" },
      });
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", agent: "scout" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("ghost-provider/model-x");
      expect(result.text).toContain("not available");
      expect(result.text).toContain("delegate.json");
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a parent-scoped modelsByParent pin wins over the unscoped models entry (#32)",
    async () => {
      // SPEC: a modelsByParent entry keyed by the parent's exact
      // provider/model-id — matched case-insensitively, hence the shouting
      // key — wins over the unscoped "models" pin for the same agent. The
      // scoped pin targets the parent's own model, so the win shows as a
      // primary-provider call instead of an alt-provider call.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        models: { scout: subagents.alt.spec },
        modelsByParent: {
          "Delegate-Faux/FAUX-1": { scout: subagents.spec },
        },
      });
      subagents.respond([fauxAssistantMessage("SCOPED-PARENT-MODEL")]);
      subagents.alt.respond([fauxAssistantMessage("UNSCOPED-LOSES")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "look around", agent: "scout" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("SCOPED-PARENT-MODEL");
      expect(subagents.state.callCount).toBe(1); // scoped pin → parent model
      expect(subagents.alt.state.callCount).toBe(0); // unscoped pin ignored
    },
  );

  test(
    "a non-matching modelsByParent key falls back to the unscoped entry (#32)",
    async () => {
      // SPEC: a modelsByParent key names an exact parent provider/model-id;
      // when the parent does not match, the unscoped "models" pin applies.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        models: { scout: subagents.alt.spec },
        modelsByParent: {
          "other-provider/other-model": { scout: subagents.spec },
        },
      });
      subagents.alt.respond([fauxAssistantMessage("UNSCOPED-APPLIES")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "look around", agent: "scout" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("UNSCOPED-APPLIES");
      expect(subagents.alt.state.callCount).toBe(1);
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a :effort pin sets the child's thinking; a bare pin uses the model default; an unpinned task mirrors the parent (#32)",
    async () => {
      // SPEC: effort is user-configured only. A configured :effort reaches
      // the provider as the request's reasoning level; a pin without one
      // does not inherit the parent's (it runs at the model's default);
      // a task on the parent's model mirrors the parent's live level.
      // dependsOn chains the three tasks into phases so the captured
      // reasoning order is the task order; "low" is a level the faux model
      // supports (xhigh/max require a thinkingLevelMap).
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      (session.session as AgentSession).setThinkingLevel("low");
      configureDelegate(session, {
        models: {
          scout: `${subagents.alt.spec}:high`,
          reviewer: subagents.alt.spec,
        },
      });
      const reasoning: unknown[] = [];
      const capture =
        (reply: string): FauxResponseFactory =>
        (_context, options) => {
          reasoning.push(options?.reasoning);
          return fauxAssistantMessage(reply);
        };
      subagents.alt.respond([capture("SCOUT-EFFORT"), capture("REVIEWER-BARE")]);
      subagents.respond([capture("INLINE-PARENT")]);

      const result = await callDelegate(session, {
        tasks: [
          { id: "a", prompt: "a", agent: "scout" },
          { id: "b", prompt: "b", agent: "reviewer", dependsOn: ["a"] },
          { id: "c", prompt: "c", dependsOn: ["b"] },
        ],
      });

      expect(result.isError).toBe(false);
      expect(reasoning).toEqual([
        "high", // configured :effort wins
        // Bare pin to a different model: the model's own default, never the
        // parent's "low" — whatever the default resolves to, it is not the
        // inherited level.
        "medium",
        "low", // unpinned inline task mirrors the parent's level
      ]);
    },
  );

  test(
    "modelsByParent keys that could never match a parent fail at config load",
    async () => {
      // Review of #32: a key that could never match a parent provider /
      // full model id — empty halves, doubled slashes, or internal
      // whitespace (a single extra slash is now legal: slash-bearing model
      // ids like openrouter/anthropic/claude-sonnet-4) — is rejected at
      // load with the same message as the other dead shapes instead of
      // sitting in the config silently never matching.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);
      for (const key of [
        "delegate-faux/faux-1//extra",
        "delegate-faux//faux-1",
        "delegate-faux//",
        "/faux-1",
        "delegate-faux/",
        "delegate-faux/fa ux-1",
      ]) {
        configureDelegate(session, {
          modelsByParent: { [key]: { scout: subagents.spec } },
        });
        const result = await callDelegate(session, {
          tasks: [{ prompt: "look", agent: "scout" }],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("must be an exact provider/model-id");
        expect(result.text).toContain(key);
      }
      // The config never loaded, so nothing started.
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "modelsByParent keys that collide after normalization fail at config load",
    async () => {
      // Keys normalize to trimmed lowercase, so spellings differing only in
      // case or surrounding whitespace name the same parent; silently
      // overwriting the earlier pin would pick one at random. The second
      // key is a config error naming the normalized key.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);
      configureDelegate(session, {
        modelsByParent: {
          "delegate-faux/faux-1": { scout: subagents.spec },
          "DELEGATE-FAUX/FAUX-1": { scout: subagents.spec },
        },
      });

      const result = await callDelegate(session, {
        tasks: [{ prompt: "look", agent: "scout" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("duplicates 'delegate-faux/faux-1'");
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a colon-bearing model id pins and matches verbatim (Ollama-style tags)",
    async () => {
      // SPEC: only a trailing KNOWN thinking level strips as :effort — any
      // other `:segment` belongs to the model id itself
      // (`ollama/qwen2.5:32b`, `openrouter/...:free`), so a colon-bearing
      // pin resolves verbatim and a modelsByParent key can name a
      // colon-bearing parent (matched case-insensitively, like elsewhere).
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const tagged = fauxProvider({
        provider: "delegate-faux-tag",
        models: [{ id: "faux-t:32b", reasoning: true }],
      });
      const runtime = (session.session as AgentSession).modelRuntime;
      runtime.registerNativeProvider(tagged.provider);
      await runtime.setRuntimeApiKey("delegate-faux-tag", "test-key");
      const parentModel = runtime.getModel("delegate-faux-tag", "faux-t:32b");
      if (!parentModel) {
        throw new Error("tagged faux model did not register");
      }
      await (session.session as AgentSession).setModel(parentModel);
      configureDelegate(session, {
        // Unscoped pin to the colon id resolves verbatim; the scoped key —
        // shouted like the other modelsByParent test — must still match the
        // colon-bearing parent and win for scout.
        models: { reviewer: "delegate-faux-tag/faux-t:32b" },
        modelsByParent: {
          "DELEGATE-FAUX-TAG/FAUX-T:32B": { scout: subagents.alt.spec },
        },
      });
      subagents.alt.respond([fauxAssistantMessage("SCOPED-ALT")]);
      tagged.setResponses([
        fauxAssistantMessage("TAGGED-PIN"),
        fauxAssistantMessage("TAGGED-INHERITED"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { id: "a", prompt: "a", agent: "scout" },
          { id: "b", prompt: "b", agent: "reviewer", dependsOn: ["a"] },
          { id: "c", prompt: "c", dependsOn: ["b"] },
        ],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("SCOPED-ALT");
      expect(result.text).toContain("TAGGED-PIN");
      expect(result.text).toContain("TAGGED-INHERITED");
      expect(subagents.alt.state.callCount).toBe(1); // scoped key matched
      expect(tagged.state.callCount).toBe(2); // reviewer pin + inline inherit
    },
  );

  test(
    "a modelsByParent key names provider plus a slash-bearing model id (OpenRouter-style)",
    async () => {
      // Regression: real OpenRouter ids are provider + "/" + an id that
      // itself contains a slash (openrouter/anthropic/claude-sonnet-4), so
      // the key must split on the FIRST slash; a single-slash-only shape
      // rejects it at config load and blocks dispatch.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        modelsByParent: {
          "openrouter/anthropic/claude-sonnet-4": {
            scout: subagents.spec,
          },
        },
      });
      subagents.respond([fauxAssistantMessage("SLASH-ID-KEY-LOADS")]);
      const result = await callDelegate(session, {
        tasks: [{ prompt: "look", agent: "scout" }],
      });
      // The scoped key simply never matches this parent; dispatch
      // succeeds and the task inherits the parent model.
      expect(result.isError).toBe(false);
      expect(result.text).toContain("SLASH-ID-KEY-LOADS");
      expect(subagents.state.callCount).toBe(1);
    },
  );

  test(
    "a pinned model equal to the parent's modulo case still mirrors the parent's effort",
    async () => {
      // Review of #32: config matching is case-insensitive, so the
      // parent-mirror comparison must be too — a host-set parent model whose
      // provider/id casing differs from the registry's must not silently
      // drop the parent's live effort level onto the model's default.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const host = session.session as AgentSession;
      const canonical = host.model;
      if (canonical === undefined) throw new Error("test session has no parent model");
      // A case-only variant of the parent model, as an embedded host could
      // set it. The runtime resolves providers case-sensitively, so its
      // auth preflight is taught the shouting spelling (the same instance
      // patch the harness applies to the registry facade); setModel would
      // re-authenticate and rewrite the thinking level, so the state field
      // is assigned directly (test-local host seam, like the fault
      // injections elsewhere in this suite).
      const runtime = host.modelRuntime;
      const canonicalAuth = runtime.hasConfiguredAuth.bind(runtime);
      runtime.hasConfiguredAuth = (providerId: string) =>
        providerId.toLowerCase() === canonical.provider ||
        canonicalAuth(providerId);
      (host as unknown as { agent: { state: { model: unknown } } }).agent.state.model =
        {
          ...canonical,
          provider: canonical.provider.toUpperCase(),
          id: canonical.id.toUpperCase(),
        };
      host.setThinkingLevel("low");
      // The pin names the registry's canonical casing; it resolves to the
      // same model the parent runs, differing only in case.
      configureDelegate(session, { models: { scout: subagents.spec } });
      let seenReasoning: unknown;
      subagents.respond([
        (_context, options) => {
          seenReasoning = options?.reasoning;
          return fauxAssistantMessage("CASE-MIRROR");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "look", agent: "scout" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("CASE-MIRROR");
      expect(seenReasoning).toBe("low"); // the parent's level survives
    },
  );

  test("normal dispatch never injects parent conversation history", async () => {
    // Issue #14: replaces the former parent-sharing contract by user decision.
    // The contract is asserted by content: the subagent sees exactly the
    // self-contained brief. (Pi >= 0.87 reads the parent transcript itself in
    // its post-run compaction check, so "getEntries was never called" stopped
    // being a delegate-only signal; delegate's sole parent read is getLeafId,
    // an opaque id, not conversation content.)
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    let observed = "";
    subagents.respond([(context) => {
      observed = JSON.stringify(context.messages);
      return fauxAssistantMessage("FRESH-CHILD");
    }]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "SELF-CONTAINED-BRIEF", tools: [] }],
    });
    expect(result.isError).toBe(false);
    expect(observed).toContain("SELF-CONTAINED-BRIEF");
    expect(observed).not.toContain("delegate contract call");
    expect(observed).not.toContain("parent-session");
  });

  for (const context of ["with-parent-transcript", "fresh", "everything", null]) {
    for (const async of [false, true]) {
      test(`obsolete context ${context} rejects the whole ${async ? "async" : "sync"} batch`, async () => {
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        const result = await callDelegate(session, {
          async,
          tasks: [
            { prompt: "valid sibling", tools: [] },
            { prompt: "obsolete request", context },
          ],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/omit context/i);
        expect(result.text).toContain("self-contained");
        expect(subagents.state.callCount).toBe(0);
      });
    }
  }

  test("flat and stringified obsolete context requests receive migration guidance", async () => {
    for (const args of [
      { prompt: "flat", context: "with-parent-transcript" },
      { prompt: "flat", context: "fresh" },
      { tasks: JSON.stringify([{ prompt: "encoded", context: "with-parent-transcript" }]) },
      { tasks: [{ prompt: "valid" }], context: "fresh" },
    ]) {
      session?.dispose();
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const result = await callDelegate(session, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/omit context/i);
      expect(subagents.state.callCount).toBe(0);
    }
  });
});

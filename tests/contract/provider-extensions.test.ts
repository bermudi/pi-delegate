import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateTicket,
  configureDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");
const parentWebSearchPath = join(
  fixturesDir,
  "parent-web-search-ext",
  "index.ts",
);
const usageListenerPath = join(
  import.meta.dirname,
  "..",
  "support",
  "usage-listener.ts",
);

/**
 * Copy the web-search provider extension into a directory under the
 * session's agent dir (= the harness cwd) and return the directory —
 * the shape a user-scope local source takes. User-scope resolution is
 * what providerExtensions trusts; project-local paths are rejected by
 * construction, so the fixture must live under the agent dir.
 */
function installWebSearchFixture(
  session: TestSession,
  name = "web-search",
): string {
  const dir = join(session.cwd, "user-ext", name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(
    join(fixturesDir, "web-search-ext", "index.ts"),
    join(dir, "index.ts"),
  );
  return dir;
}

function installBrokenFixture(session: TestSession): string {
  const dir = join(session.cwd, "user-ext", "broken");
  mkdirSync(dir, { recursive: true });
  copyFileSync(
    join(fixturesDir, "broken-ext", "index.ts"),
    join(dir, "index.ts"),
  );
  return dir;
}

/**
 * A third faux provider named `openai-codex` — the shipped
 * providerExtensions default targets exactly that provider id, so
 * exercising it takes a provider with the real name. Named agents reach
 * it through a delegate.json `models` pin.
 */
async function installCodexProvider(
  session: TestSession,
): Promise<FauxProviderHandle> {
  const codex = fauxProvider({
    provider: "openai-codex",
    models: [{ id: "faux-1", reasoning: true }],
  });
  const runtime = (session.session as AgentSession).modelRuntime;
  runtime.registerNativeProvider(codex.provider);
  await runtime.setRuntimeApiKey("openai-codex", "test-key");
  return codex;
}

function usageEventLines(session: TestSession): string[] {
  const file = join(session.cwd, "DELEGATE_USAGE.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

describe("providerExtensions (#59)", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
    setSystemTime();
  });

  test(
    "malformed providerExtensions values fail loudly naming the key",
    async () => {
      // v1 evidence: config.test.ts:103-137 — v1 dropped malformed
      // shapes silently. v2 fails loudly like the other config blocks:
      // a half-applied allowlist is worse than an error.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("UNREACHABLE")]);

      configureDelegate(session, { providerExtensions: "nope" });
      const notObject = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "x" }],
      });
      expect(notObject.isError).toBe(true);
      expect(notObject.text).toContain(
        "providerExtensions must be an object",
      );

      configureDelegate(session, {
        providerExtensions: { "delegate-faux": "npm:x" },
      });
      const notArray = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "x" }],
      });
      expect(notArray.isError).toBe(true);
      expect(notArray.text).toContain(
        "must be an array of extension source strings",
      );

      configureDelegate(session, {
        providerExtensions: { "delegate-faux": ["npm:x", 42] },
      });
      const badEntry = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "x" }],
      });
      expect(badEntry.isError).toBe(true);
      expect(badEntry.text).toContain(
        "must be a non-empty source string",
      );

      configureDelegate(session, {
        providerExtensions: {
          "Delegate-Faux": ["a"],
          "delegate-faux": ["b"],
        },
      });
      const duplicate = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "x" }],
      });
      expect(duplicate.isError).toBe(true);
      expect(duplicate.text).toContain("duplicates");
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a missing required source fails the dispatch closed before any child starts",
    async () => {
      // v1 evidence: provider-extensions.ts resolution rejects the whole
      // dispatch on a user-configured source that is not installed in
      // the user scope — nothing may run without it.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("UNREACHABLE")]);
      configureDelegate(session, {
        providerExtensions: {
          "delegate-faux": ["npm:@zzz-missing-scope/missing-pkg-zzz"],
        },
      });
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "x" }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not installed in the user scope");
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "the shipped openai-codex default is best-effort and degrades silently when uninstalled",
    async () => {
      // v1 evidence: config.ts:471-473 ships
      // openai-codex → npm:@bermudi/pi-codex;
      // provider-extensions.ts:370-375 — a missing default is skipped
      // silently and the child runs extension-free.
      session = await openDelegateBoundary();
      await installSubagentModel(session);
      const codex = await installCodexProvider(session);
      codex.setResponses([fauxAssistantMessage("CODEX-OK")]);
      configureDelegate(session, {
        models: { coder: "openai-codex/faux-1" },
      });
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ agent: "coder", prompt: "x", tools: ["read"] }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("CODEX-OK");
      expect(codex.state.callCount).toBeGreaterThan(0);
    },
  );

  test(
    "re-listing the shipped default makes it required — a missing install fails closed",
    async () => {
      // v1 evidence: provenance is config presence, never string
      // identity — an exact re-list of the shipped source expresses
      // intent, so it becomes required and fails closed.
      session = await openDelegateBoundary();
      await installSubagentModel(session);
      const codex = await installCodexProvider(session);
      codex.setResponses([fauxAssistantMessage("UNREACHABLE")]);
      configureDelegate(session, {
        models: { coder: "openai-codex/faux-1" },
        providerExtensions: { "openai-codex": ["npm:@bermudi/pi-codex"] },
      });
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ agent: "coder", prompt: "x", tools: ["read"] }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not installed in the user scope");
      expect(codex.state.callCount).toBe(0);
    },
  );

  test(
    "an empty providerExtensions array neither errors nor disables the shipped default",
    async () => {
      // v1 evidence: config.ts:437-460 — arrays with no usable entries
      // are ignored; the shipped default still applies (best-effort).
      session = await openDelegateBoundary();
      await installSubagentModel(session);
      const codex = await installCodexProvider(session);
      codex.setResponses([fauxAssistantMessage("CODEX-OK")]);
      configureDelegate(session, {
        models: { coder: "openai-codex/faux-1" },
        providerExtensions: { "openai-codex": [] },
      });
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ agent: "coder", prompt: "x", tools: ["read"] }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("CODEX-OK");
    },
  );

  test(
    "required sources constrain only their own provider — other providers stay untouched",
    async () => {
      // v1 evidence: the allowlist is per-provider; a delegate-faux
      // child is unaffected by an openai-codex entry it can never load.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      await installCodexProvider(session);
      subagents.respond([fauxAssistantMessage("FAUX-OK")]);
      configureDelegate(session, {
        providerExtensions: { "openai-codex": ["npm:@bermudi/pi-codex"] },
      });
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "x", tools: ["read"] }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("FAUX-OK");
    },
  );

  test(
    "explicit web_search is rejected for a provider without an extension allowlist",
    async () => {
      // v1 evidence: web_search is not a built-in child tool — it
      // exists only when a provider extension supplies it.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("UNREACHABLE")]);
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "x", tools: ["web_search"] }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not available to subagents");
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a user-configured extension loads into the child and its web_search executes",
    async () => {
      // v1 evidence: delegate.test.ts:594 — the child's tool registry
      // carries web_search when the provider extension supplies it;
      // tools activate only after the verified allowlist loads.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const extensionDir = installWebSearchFixture(session);
      configureDelegate(session, {
        providerExtensions: { "delegate-faux": [extensionDir] },
      });
      subagents.respond([
        fauxAssistantMessage([fauxToolCall("web_search", { query: "q" })]),
        fauxAssistantMessage("CHILD-DONE"),
      ]);
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "x", tools: ["web_search"] }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("CHILD-DONE");
      expect(
        readFileSync(join(session.cwd, "WEB_SEARCH_MARKER.txt"), "utf8"),
      ).toBe("provider-ext-search");
    },
  );

  test(
    "children never inherit the parent's extension inventory",
    async () => {
      // v1 evidence: noExtensions children — a parent's own web_search
      // must not leak in. Two pins: without an allowlist the mirrored
      // name is stripped (the call errors, no marker); with an
      // allowlist the child runs ITS OWN copy (marker says which
      // registry executed it — "provider-ext-search", not
      // "parent-ext-search").
      session = await openDelegateBoundary({
        leadingExtensions: [parentWebSearchPath],
      });
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage([fauxToolCall("web_search", { query: "x" })]),
        fauxAssistantMessage("DONE"),
      ]);
      const stripped = await callDelegate(session, {
        async: false,
        tasks: [{ agent: "default", prompt: "a" }],
      });
      expect(stripped.isError).toBe(false);
      expect(
        existsSync(join(session.cwd, "WEB_SEARCH_MARKER.txt")),
      ).toBe(false);

      const extensionDir = installWebSearchFixture(session);
      configureDelegate(session, {
        providerExtensions: { "delegate-faux": [extensionDir] },
      });
      subagents.respond([
        fauxAssistantMessage([fauxToolCall("web_search", { query: "x" })]),
        fauxAssistantMessage("DONE-TWO"),
      ]);
      const own = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "b", tools: ["web_search"] }],
      });
      expect(own.isError).toBe(false);
      expect(
        readFileSync(join(session.cwd, "WEB_SEARCH_MARKER.txt"), "utf8"),
      ).toBe("provider-ext-search");
    },
  );

  test(
    "a configured extension that fails to load fails the whole dispatch before any child starts",
    async () => {
      // v1 evidence: load-failure partition — fatal roots abort rather
      // than running without the configured integration. SPEC #59 makes
      // the rejection whole-dispatch and pre-execution: a resolved,
      // healthy sibling on another provider must never start, and the
      // failure is a config rejection — not an internal dispatch error.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const codex = await installCodexProvider(session);
      const extensionDir = installBrokenFixture(session);
      configureDelegate(session, {
        models: { coder: "openai-codex/faux-1" },
        providerExtensions: { "delegate-faux": [extensionDir] },
      });
      subagents.respond([fauxAssistantMessage("UNREACHABLE")]);
      codex.setResponses([fauxAssistantMessage("UNREACHABLE-CODEX")]);
      const result = await callDelegate(session, {
        tasks: [
          // Resolves cleanly (its shipped default is uninstalled,
          // best-effort-skipped); under per-task semantics it would run.
          { agent: "coder", prompt: "a", tools: ["read"] },
          { prompt: "b" },
        ],
        async: false,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Failed to load");
      expect(result.text).toContain("allowlisted provider extension");
      expect(result.text).not.toContain("internal dispatch error");
      expect(subagents.state.callCount).toBe(0);
      expect(codex.state.callCount).toBe(0);
    },
  );

  test(
    "a providerExtensions change invalidates a pooled session's frozen configuration",
    async () => {
      // v1 evidence: the allowlist signature rides the session-pool
      // freeze so a delegate.json edit can never silently reuse a
      // session that already loaded different extension code.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const extensionDir = installWebSearchFixture(session);
      configureDelegate(session, {
        providerExtensions: { "delegate-faux": [extensionDir] },
      });
      subagents.respond([fauxAssistantMessage("S1")]);
      const first = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "a", sessionId: "s-1" }],
      });
      expect(first.isError).toBe(false);

      // A different WORKING source changes the allowlist signature
      // without tripping the resolve-time load probe — the freeze check
      // is what this test pins; a broken entry would reject on load
      // first, and a second copy of the same fixture would collide on
      // the web_search tool name.
      configureDelegate(session, {
        providerExtensions: {
          "delegate-faux": [installWebSearchFixture(session, "web-search-alt")],
        },
      });
      subagents.respond([fauxAssistantMessage("S2")]);
      const second = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "b", sessionId: "s-1" }],
      });
      expect(second.text).toContain("providerExtensions: changed");
    },
  );
});

describe("delegate:usage events (#60)", () => {
  let session: TestSession | undefined;
  afterEach(() => {
    session?.dispose();
    session = undefined;
    setSystemTime();
  });

  test(
    "task settlement emits the usage payload; same-window settlements throttle to one",
    async () => {
      // Issue #60: settlement emits {provider, model, tokens} on
      // pi.events, throttled to one emission per 30s per instance —
      // inside the window later settlements are silent, after it the
      // next one reports again.
      session = await openDelegateBoundary({
        leadingExtensions: [usageListenerPath],
      });
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("A1")]);
      const first = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "a" }],
      });
      expect(first.isError).toBe(false);
      let lines = usageEventLines(session);
      expect(lines.length).toBe(1);
      const payload = objectOf(JSON.parse(lines[0]!), "usage payload");
      expect(payload.provider).toBe("delegate-faux");
      expect(payload.model).toBe("faux-1");
      expect(payload.taskId).toBe("task-1");
      expect(typeof payload.totalTokens).toBe("number");
      expect(typeof payload.inputTokens).toBe("number");
      expect(typeof payload.outputTokens).toBe("number");
      // A sync dispatch carries no ticket — the field is omitted.
      expect(payload.ticketId).toBeUndefined();

      subagents.respond([fauxAssistantMessage("A2")]);
      const second = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "b" }],
      });
      expect(second.isError).toBe(false);
      lines = usageEventLines(session);
      expect(lines.length).toBe(1);

      // After the throttle window the next settlement reports again.
      setSystemTime(Date.now() + 31_000);
      subagents.respond([fauxAssistantMessage("A3")]);
      const third = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "c" }],
      });
      expect(third.isError).toBe(false);
      lines = usageEventLines(session);
      expect(lines.length).toBe(2);
    },
  );

  test(
    "a ticketed batch settlement carries ticketId and taskId on the payload",
    async () => {
      // Issue #60: batch tasks settle through the same emission path —
      // the first settlement inside the window reports both identifiers.
      session = await openDelegateBoundary({
        leadingExtensions: [usageListenerPath],
      });
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("B1"),
        fauxAssistantMessage("B2"),
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "a" }, { prompt: "b" }],
        async: true,
      });
      expect(dispatched.isError).toBe(false);
      const ticket = ticketIdOf(dispatched.text);
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.isError).toBe(false);

      const lines = usageEventLines(session);
      // One emission inside the window — the second task's settlement
      // and the batch aggregate are throttled behind it.
      expect(lines.length).toBe(1);
      const payload = objectOf(JSON.parse(lines[0]!), "usage payload");
      expect(payload.ticketId).toBe(ticket);
      expect(payload.provider).toBe("delegate-faux");
      expect(payload.model).toBe("faux-1");
      expect(typeof payload.taskId).toBe("string");
    },
  );
});

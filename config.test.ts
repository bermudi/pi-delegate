import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  _resetDelegateConfigForTesting,
  _setDelegateConfigForTesting,
  getAgentOverrides,
  getAgentOverridesByParentModel,
  getSubagentProviderExtensionMap,
  getSubagentProviderExtensionsForProvider,
  getSubagentProviderExtensionSourcesForProvider,
  getProviderExtensionSignature,
  getTelemetryConfig,
  type DelegateConfig,
} from "./config.ts";

/**
 * `normalizeProviderExtensions` is the boundary validator for user-edited
 * `delegate.json` input. It's module-private, so these tests drive it through
 * the public `_setDelegateConfigForTesting` seam (which runs input through the
 * same normalizer that `loadDelegateConfig` uses) and read results back via
 * `getSubagentProviderExtensionMap`. The merge over `DEFAULT_PROVIDER_EXTENSIONS`
 * is part of the contract under test (replace-per-provider, empty-array no-op).
 */
describe("providerExtensions normalization (via public seam)", () => {
  beforeEach(() => _resetDelegateConfigForTesting());
  afterEach(() => _resetDelegateConfigForTesting());

  test("ships the codex remote-compaction default", () => {
    expect(getSubagentProviderExtensionMap()["openai-codex"]).toEqual([
      "npm:@bermudi/pi-codex",
    ]);
  });

  test("replace semantics: a provider's list substitutes the default, not appended", () => {
    _setDelegateConfigForTesting({
      providerExtensions: { "openai-codex": ["npm:my-custom"] },
    });
    expect(getSubagentProviderExtensionMap()["openai-codex"]).toEqual([
      "npm:my-custom",
    ]);
  });

  test("empty array is ignored so the default persists (no config-only disable)", () => {
    _setDelegateConfigForTesting({
      providerExtensions: { "openai-codex": [] },
    });
    expect(getSubagentProviderExtensionMap()["openai-codex"]).toEqual([
      "npm:@bermudi/pi-codex",
    ]);
  });

  test("non-array entries are dropped (provider omitted entirely)", () => {
    _setDelegateConfigForTesting({
      providerExtensions: {
        "rogue-provider": "npm:not-an-array",
      } as unknown as { "rogue-provider": readonly string[] },
    });
    expect(getSubagentProviderExtensionMap()["rogue-provider"]).toBeUndefined();
  });

  test("non-string entries are filtered out", () => {
    _setDelegateConfigForTesting({
      providerExtensions: {
        "custom-provider": ["npm:valid", 123, null, { bad: true }, "  "],
      } as unknown as { "custom-provider": readonly string[] },
    });
    expect(getSubagentProviderExtensionMap()["custom-provider"]).toEqual([
      "npm:valid",
    ]);
  });

  test("duplicate entries are deduped (first-seen order preserved)", () => {
    _setDelegateConfigForTesting({
      providerExtensions: {
        "custom-provider": ["npm:a", "npm:b", "npm:a"],
      },
    });
    expect(getSubagentProviderExtensionMap()["custom-provider"]).toEqual([
      "npm:a",
      "npm:b",
    ]);
  });

  test("provider keys are case-normalized (trimmed + lowercased)", () => {
    _setDelegateConfigForTesting({
      providerExtensions: { "  Custom-Provider  ": ["npm:x"] },
    });
    expect(getSubagentProviderExtensionMap()["custom-provider"]).toEqual([
      "npm:x",
    ]);
    // The original (un-normalized) key is not retained.
    expect(
      getSubagentProviderExtensionMap()["  Custom-Provider  "],
    ).toBeUndefined();
  });

  test("malformed top-level (non-object) is ignored, defaults persist", () => {
    _setDelegateConfigForTesting({
      providerExtensions: "nope" as unknown as {
        [provider: string]: readonly string[];
      },
    });
    expect(getSubagentProviderExtensionMap()["openai-codex"]).toEqual([
      "npm:@bermudi/pi-codex",
    ]);
  });
});

describe("telemetry config normalization", () => {
  beforeEach(() => _resetDelegateConfigForTesting());
  afterEach(() => _resetDelegateConfigForTesting());

  test("rejects string booleans instead of treating them as enabled", () => {
    _setDelegateConfigForTesting({
      telemetry: { enabled: "false" } as unknown as { enabled: boolean },
    });
    expect(getTelemetryConfig().enabled).toBe(false);
  });

  test("rejects malformed telemetry blocks", () => {
    _setDelegateConfigForTesting({
      telemetry: "false" as unknown as { enabled: boolean },
    });
    expect(getTelemetryConfig().enabled).toBe(false);
  });

  test("keeps valid telemetry settings", () => {
    _setDelegateConfigForTesting({
      telemetry: { enabled: true, dbPath: " /tmp/delegate.db " },
    });
    expect(getTelemetryConfig()).toEqual({
      enabled: true,
      dbPath: " /tmp/delegate.db ",
    });
  });
});

describe("getSubagentProviderExtensionsForProvider", () => {
  beforeEach(() => _resetDelegateConfigForTesting());
  afterEach(() => _resetDelegateConfigForTesting());

  test("case-insensitive lookup against the resolved map", () => {
    _setDelegateConfigForTesting({
      providerExtensions: { "custom-provider": ["npm:x"] },
    });
    expect(getSubagentProviderExtensionsForProvider("Custom-Provider")).toEqual(
      ["npm:x"],
    );
    expect(getSubagentProviderExtensionsForProvider("custom-provider")).toEqual(
      ["npm:x"],
    );
  });

  test("undefined / blank provider → []", () => {
    expect(getSubagentProviderExtensionsForProvider(undefined)).toEqual([]);
    expect(getSubagentProviderExtensionsForProvider("   ")).toEqual([]);
  });

  test("unknown provider → []", () => {
    expect(
      getSubagentProviderExtensionsForProvider("not-a-known-provider"),
    ).toEqual([]);
  });

  test("does not resolve inherited Object.prototype keys", () => {
    expect(getSubagentProviderExtensionsForProvider("constructor")).toEqual([]);
    expect(getSubagentProviderExtensionsForProvider("hasOwnProperty")).toEqual(
      [],
    );
  });

  test("normalizes an explicitly injected config too", () => {
    const config = {
      providerExtensions: { "  Custom-Provider  ": ["npm:x"] },
    } as DelegateConfig;
    expect(
      getSubagentProviderExtensionsForProvider("CUSTOM-PROVIDER", config),
    ).toEqual(["npm:x"]);
  });

  test("resolves the shipped default for openai-codex", () => {
    expect(getSubagentProviderExtensionsForProvider("openai-codex")).toEqual([
      "npm:@bermudi/pi-codex",
    ]);
  });
});

describe("getSubagentProviderExtensionSourcesForProvider", () => {
  beforeEach(() => _resetDelegateConfigForTesting());
  afterEach(() => _resetDelegateConfigForTesting());

  test("tags shipped defaults as best-effort", () => {
    expect(
      getSubagentProviderExtensionSourcesForProvider("openai-codex"),
    ).toEqual([{ source: "npm:@bermudi/pi-codex", required: false }]);
  });

  test("tags user-configured sources as required, replacing defaults", () => {
    _setDelegateConfigForTesting({
      providerExtensions: { "openai-codex": ["npm:@example/ext"] },
    });
    expect(
      getSubagentProviderExtensionSourcesForProvider("openai-codex"),
    ).toEqual([{ source: "npm:@example/ext", required: true }]);
  });

  test("a user re-listing the exact default source is required, not best-effort", () => {
    // Classification is config presence, never string identity: typing the
    // source into delegate.json expresses intent, so it stops being a
    // best-effort default and starts failing closed when missing.
    _setDelegateConfigForTesting({
      providerExtensions: { "openai-codex": ["npm:@bermudi/pi-codex"] },
    });
    expect(
      getSubagentProviderExtensionSourcesForProvider("openai-codex"),
    ).toEqual([{ source: "npm:@bermudi/pi-codex", required: true }]);
  });

  test("normalizes provider case and whitespace", () => {
    expect(
      getSubagentProviderExtensionSourcesForProvider(" OpenAI-Codex "),
    ).toEqual([{ source: "npm:@bermudi/pi-codex", required: false }]);
  });

  test("undefined / blank / unknown providers resolve to no sources", () => {
    expect(getSubagentProviderExtensionSourcesForProvider(undefined)).toEqual(
      [],
    );
    expect(getSubagentProviderExtensionSourcesForProvider("   ")).toEqual([]);
    expect(
      getSubagentProviderExtensionSourcesForProvider("other-provider"),
    ).toEqual([]);
  });

  test("does not resolve inherited Object.prototype keys (constructor/__proto__)", () => {
    expect(
      getSubagentProviderExtensionSourcesForProvider("constructor"),
    ).toEqual([]);
    expect(getSubagentProviderExtensionSourcesForProvider("__proto__")).toEqual(
      [],
    );
    expect(
      getSubagentProviderExtensionSourcesForProvider("hasOwnProperty"),
    ).toEqual([]);
  });

  test("normalizes an explicitly injected, unnormalized config", () => {
    const config = {
      providerExtensions: { "  Custom-Provider  ": ["npm:x"] },
    } as DelegateConfig;
    expect(
      getSubagentProviderExtensionSourcesForProvider("custom-provider", config),
    ).toEqual([{ source: "npm:x", required: true }]);
    expect(
      getSubagentProviderExtensionSourcesForProvider(
        "  CUSTOM-PROVIDER ",
        config,
      ),
    ).toEqual([{ source: "npm:x", required: true }]);
  });
});

describe("getProviderExtensionSignature", () => {
  beforeEach(() => _resetDelegateConfigForTesting());
  afterEach(() => _resetDelegateConfigForTesting());

  test("returns an opaque deterministic digest", () => {
    const sensitiveSource =
      "git:https://user:super-secret@example.invalid/provider-extension.git";
    _setDelegateConfigForTesting({
      providerExtensions: { custom: [sensitiveSource] },
    });

    const signature = getProviderExtensionSignature("custom");
    expect(signature).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(getProviderExtensionSignature("custom")).toBe(signature);
    expect(signature).not.toContain(sensitiveSource);
    expect(signature).not.toContain("super-secret");
    expect(getProviderExtensionSignature("unknown")).toBe("");
  });

  test("distinguishes required re-listings from best-effort defaults", () => {
    const defaultSignature = getProviderExtensionSignature("openai-codex");
    _setDelegateConfigForTesting({
      providerExtensions: { "openai-codex": ["npm:@bermudi/pi-codex"] },
    });

    expect(getProviderExtensionSignature("openai-codex")).not.toBe(
      defaultSignature,
    );
  });

  test("preserves configured extension order", () => {
    _setDelegateConfigForTesting({
      providerExtensions: { custom: ["npm:first", "npm:second"] },
    });
    const first = getProviderExtensionSignature("custom");
    _setDelegateConfigForTesting({
      providerExtensions: { custom: ["npm:second", "npm:first"] },
    });

    expect(getProviderExtensionSignature("custom")).not.toBe(first);
  });
});

/**
 * `agentOverrides` / `agentOverridesByParentModel` normalization, driven
 * through the public `_setDelegateConfigForTesting` seam (which runs input
 * through the same normalizers `loadDelegateConfig` uses) and read back via
 * the getters `task-resolution.ts` consumes. File-loading behavior (the
 * mocked-homedir path) is covered in `delegate.test.ts`.
 */
describe("agentOverrides normalization (via public seam)", () => {
  beforeEach(() => _resetDelegateConfigForTesting());
  afterEach(() => _resetDelegateConfigForTesting());

  test("absent blocks read back undefined", () => {
    expect(getAgentOverrides()).toBeUndefined();
    expect(getAgentOverridesByParentModel()).toBeUndefined();
  });

  test("valid overrides pass through with trimmed keys", () => {
    _setDelegateConfigForTesting({
      agentOverrides: { " scout ": { model: " zai/glm-5-turbo " } },
    });
    expect(getAgentOverrides()?.scout?.model).toBe("zai/glm-5-turbo");
  });

  test("model is trimmed; empty model drops the entry", () => {
    _setDelegateConfigForTesting({
      agentOverrides: { scout: { model: "   " } },
    });
    expect(getAgentOverrides()?.scout).toBeUndefined();
  });

  test("unknown fields drop the entry whole (no partial application)", () => {
    _setDelegateConfigForTesting({
      agentOverrides: {
        // @ts-expect-error -- deliberately malformed
        scout: { model: "a/b", bogus: true },
      },
    });
    expect(getAgentOverrides()?.scout).toBeUndefined();
  });

  test("parent-model map normalizes inner entries and keys are not lowercased", () => {
    _setDelegateConfigForTesting({
      agentOverridesByParentModel: {
        " openai-codex/GPT-5.6-Sol ": { scout: { thinking: "high" } },
      },
    });
    // Exact `provider/model-id` semantics: case is preserved.
    expect(
      getAgentOverridesByParentModel()?.["openai-codex/GPT-5.6-Sol"]?.scout
        ?.thinking,
    ).toBe("high");
  });

  test("override maps are null-prototype (no Object.prototype inheritance)", () => {
    _setDelegateConfigForTesting({
      agentOverrides: { scout: { model: "a/b" } },
      agentOverridesByParentModel: {
        "openai-codex/gpt-5.6-sol": { scout: { model: "a/b" } },
      },
    });
    const overrides = getAgentOverrides() as unknown as Record<string, unknown>;
    const byParent = getAgentOverridesByParentModel() as unknown as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(overrides)).toBeNull();
    expect(Object.getPrototypeOf(byParent)).toBeNull();
    // Prototype members must not masquerade as configured agents.
    expect(overrides["hasOwnProperty"]).toBeUndefined();
    expect(overrides["constructor"]).toBeUndefined();
    expect(byParent["toString"]).toBeUndefined();
  });
});

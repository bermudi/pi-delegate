import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  _resetDelegateConfigForTesting,
  _setDelegateConfigForTesting,
  getSubagentProviderExtensionMap,
  getSubagentProviderExtensionsForProvider,
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
      "npm:@ogulcancelik/pi-codex-compaction",
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
      "npm:@ogulcancelik/pi-codex-compaction",
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
      "npm:@ogulcancelik/pi-codex-compaction",
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
      "npm:@ogulcancelik/pi-codex-compaction",
    ]);
  });
});

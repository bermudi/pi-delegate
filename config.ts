import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  MAX_ASYNC_TICKETS,
  MAX_CONCURRENCY,
  OUTPUT_SPILL_TAIL_CHARS,
  OUTPUT_SPILL_THRESHOLD_CHARS,
  VALID_THINKING,
} from "./constants.ts";

export interface AgentOverride {
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
}

const DELEGATE_CONFIG_SOURCE = "delegate.json";

/** Validate one agentOverrides entry. A malformed entry is dropped whole
 *  (warn) rather than partially applied — a half-parsed override that
 *  silently changes only `thinking` is worse than a loud no-op. */
function normalizeAgentOverride(
  raw: unknown,
  agentName: string,
): AgentOverride | null {
  if (!isRecord(raw)) {
    console.warn(
      `[delegate] ignoring malformed agentOverrides entry for agent '${agentName}' in ${DELEGATE_CONFIG_SOURCE}: expected an object.`,
    );
    return null;
  }

  const result: AgentOverride = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "model") {
      if (typeof value !== "string" || value.trim().length === 0) {
        console.warn(
          `[delegate] ignoring malformed agentOverrides entry for agent '${agentName}' in ${DELEGATE_CONFIG_SOURCE}: model must be a nonempty string.`,
        );
        return null;
      }
      result.model = value.trim();
    } else if (key === "thinking") {
      if (typeof value !== "string" || !VALID_THINKING.has(value)) {
        console.warn(
          `[delegate] ignoring malformed agentOverrides entry for agent '${agentName}' in ${DELEGATE_CONFIG_SOURCE}: thinking must be a supported level.`,
        );
        return null;
      }
      result.thinking = value as ThinkingLevel;
    } else if (key === "tools") {
      if (
        !Array.isArray(value) ||
        value.some((tool) => typeof tool !== "string")
      ) {
        console.warn(
          `[delegate] ignoring malformed agentOverrides entry for agent '${agentName}' in ${DELEGATE_CONFIG_SOURCE}: tools must be a string array.`,
        );
        return null;
      }
      result.tools = [...value];
    } else if (key === "skills") {
      console.warn(
        `[delegate] ignoring unsupported skills override for agent '${agentName}' in ${DELEGATE_CONFIG_SOURCE}: per-agent skill filtering is not supported.`,
      );
      return null;
    } else {
      console.warn(
        `[delegate] ignoring malformed agentOverrides entry for agent '${agentName}' in ${DELEGATE_CONFIG_SOURCE}: unknown field '${key}'.`,
      );
      return null;
    }
  }
  return result;
}

/** Normalize the `agentOverrides` map (agent name → override). Keys are
 *  trimmed; collisions after trimming keep the first entry and warn. Returns
 *  undefined when the block is absent. */
function normalizeAgentOverrides(
  raw: unknown,
): Record<string, AgentOverride> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    console.warn(
      `[delegate] ignoring malformed agentOverrides in ${DELEGATE_CONFIG_SOURCE}: expected an object.`,
    );
    return undefined;
  }

  // Null-prototype map so config keys such as `constructor` and `__proto__`
  // cannot resolve to Object.prototype members during normalization.
  const out = Object.create(null) as Record<string, AgentOverride>;
  const seenNames = new Map<string, string>();
  for (const [agentName, value] of Object.entries(raw)) {
    const normalizedAgentName = agentName.trim();
    if (normalizedAgentName.length === 0) {
      console.warn(
        `[delegate] ignoring malformed agentOverrides entry in ${DELEGATE_CONFIG_SOURCE}: agent name must be nonempty.`,
      );
      continue;
    }
    const previousName = seenNames.get(normalizedAgentName);
    if (previousName !== undefined) {
      console.warn(
        `[delegate] ignoring duplicate agentOverrides entry in ${DELEGATE_CONFIG_SOURCE}: agent keys '${previousName}' and '${agentName}' both normalize to '${normalizedAgentName}'.`,
      );
      continue;
    }
    seenNames.set(normalizedAgentName, agentName);
    const override = normalizeAgentOverride(value, normalizedAgentName);
    if (override) out[normalizedAgentName] = override;
  }
  return out;
}

/** Normalize `agentOverridesByParentModel` (`provider/model-id` → agent →
 *  override). Model keys are trimmed, not lowercased: they must match the
 *  parent's exact `provider/model-id`. Returns undefined when absent. */
function normalizeAgentOverridesByParentModel(
  raw: unknown,
): Record<string, Record<string, AgentOverride>> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    console.warn(
      `[delegate] ignoring malformed agentOverridesByParentModel in ${DELEGATE_CONFIG_SOURCE}: expected an object.`,
    );
    return undefined;
  }

  const out = Object.create(null) as Record<
    string,
    Record<string, AgentOverride>
  >;
  const seenModels = new Map<string, string>();
  for (const [parentModel, overrides] of Object.entries(raw)) {
    const normalizedParentModel = parentModel.trim();
    if (normalizedParentModel.length === 0) {
      console.warn(
        `[delegate] ignoring malformed parent-model override in ${DELEGATE_CONFIG_SOURCE}: model key must be nonempty.`,
      );
      continue;
    }
    const previousModel = seenModels.get(normalizedParentModel);
    if (previousModel !== undefined) {
      console.warn(
        `[delegate] ignoring duplicate parent-model override in ${DELEGATE_CONFIG_SOURCE}: model keys '${previousModel}' and '${parentModel}' both normalize to '${normalizedParentModel}'.`,
      );
      continue;
    }
    seenModels.set(normalizedParentModel, parentModel);
    const inner = normalizeAgentOverrides(overrides);
    out[normalizedParentModel] =
      inner ?? (Object.create(null) as Record<string, AgentOverride>);
  }
  return out;
}

export interface TelemetryConfig {
  /** Whether to record delegate calls to the local SQLite store. Default true. */
  enabled?: boolean;
  /** Path to the SQLite database. Defaults to `~/.pi/agent/delegate-usage.db`. */
  dbPath?: string;
}

const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/** Validate numeric and nested-object fields before they reach the config
 *  singleton. Malformed values in `delegate.json` must not replace a valid
 *  snapshot with a half-parsed object that later produces `NaN` concurrency
 *  limits and deadlocks the global semaphore. */
function validateNumericAndNestedFields(
  raw: Record<string, unknown>,
): string | null {
  if ("agent" in raw && raw.agent !== undefined && !isRecord(raw.agent)) {
    return "agent must be an object";
  }
  if (
    "concurrency" in raw &&
    raw.concurrency !== undefined &&
    !isRecord(raw.concurrency)
  ) {
    return "concurrency must be an object";
  }
  if ("retry" in raw && raw.retry !== undefined && !isRecord(raw.retry)) {
    return "retry must be an object";
  }
  if ("output" in raw && raw.output !== undefined && !isRecord(raw.output)) {
    return "output must be an object";
  }

  if ("maxConcurrent" in raw && !isPositiveInteger(raw.maxConcurrent)) {
    return `maxConcurrent must be a positive integer; got ${JSON.stringify(
      raw.maxConcurrent,
    )}`;
  }
  if ("maxAsyncTickets" in raw && !isPositiveInteger(raw.maxAsyncTickets)) {
    return `maxAsyncTickets must be a positive integer; got ${JSON.stringify(
      raw.maxAsyncTickets,
    )}`;
  }
  if ("stallTimeoutMs" in raw && !isNonNegativeInteger(raw.stallTimeoutMs)) {
    return `stallTimeoutMs must be a non-negative integer; got ${JSON.stringify(
      raw.stallTimeoutMs,
    )}`;
  }

  const concurrency = raw.concurrency;
  if (concurrency) {
    const c = concurrency as Record<string, unknown>;
    if ("default" in c && !isPositiveInteger(c.default)) {
      return `concurrency.default must be a positive integer; got ${JSON.stringify(
        c.default,
      )}`;
    }
    if ("providers" in c) {
      const providers = c.providers;
      if (!isRecord(providers)) {
        return "concurrency.providers must be an object";
      }
      for (const [key, value] of Object.entries(providers)) {
        if (!isPositiveInteger(value)) {
          return `concurrency.providers.${key} must be a positive integer; got ${JSON.stringify(
            value,
          )}`;
        }
      }
    }
    if ("models" in c) {
      const models = c.models;
      if (!isRecord(models)) {
        return "concurrency.models must be an object";
      }
      for (const [key, value] of Object.entries(models)) {
        if (!isPositiveInteger(value)) {
          return `concurrency.models.${key} must be a positive integer; got ${JSON.stringify(
            value,
          )}`;
        }
      }
    }
  }

  const retry = raw.retry;
  if (retry) {
    const r = retry as Record<string, unknown>;
    if (
      "wholeTaskMaxRetries" in r &&
      !isNonNegativeInteger(r.wholeTaskMaxRetries)
    ) {
      return `retry.wholeTaskMaxRetries must be a non-negative integer; got ${JSON.stringify(
        r.wholeTaskMaxRetries,
      )}`;
    }
    if (
      "wholeTaskBaseDelayMs" in r &&
      !isNonNegativeInteger(r.wholeTaskBaseDelayMs)
    ) {
      return `retry.wholeTaskBaseDelayMs must be a non-negative integer; got ${JSON.stringify(
        r.wholeTaskBaseDelayMs,
      )}`;
    }
  }

  const output = raw.output;
  if (output) {
    const o = output as Record<string, unknown>;
    if (
      "spillThresholdChars" in o &&
      !isPositiveInteger(o.spillThresholdChars)
    ) {
      return `output.spillThresholdChars must be a positive integer; got ${JSON.stringify(
        o.spillThresholdChars,
      )}`;
    }
    if ("spillTailChars" in o && !isNonNegativeInteger(o.spillTailChars)) {
      return `output.spillTailChars must be a non-negative integer; got ${JSON.stringify(
        o.spillTailChars,
      )}`;
    }
  }

  return null;
}

/** Return a safe positive integer from a possibly malformed config value. */
function safePositiveInteger(value: unknown, defaultValue: number): number {
  return isPositiveInteger(value) ? (value as number) : defaultValue;
}

/** Return a safe non-negative integer from a possibly malformed config value. */
function safeNonNegativeInteger(value: unknown, defaultValue: number): number {
  return isNonNegativeInteger(value) ? (value as number) : defaultValue;
}

/**
 * Validate the user-editable telemetry block at its boundary. An explicitly
 * malformed block disables telemetry rather than silently turning it on with
 * the default database path. Missing telemetry is different: it means the
 * user did not configure the feature, so the default remains enabled.
 */
export function normalizeTelemetryConfig(raw: unknown): TelemetryConfig {
  if (raw === undefined) return { ...DEFAULT_TELEMETRY_CONFIG };
  if (!isRecord(raw)) return { enabled: false };

  const hasEnabled = Object.prototype.hasOwnProperty.call(raw, "enabled");
  const hasDbPath = Object.prototype.hasOwnProperty.call(raw, "dbPath");
  const enabled = raw.enabled;
  const dbPath = raw.dbPath;

  if (hasEnabled && typeof enabled !== "boolean") {
    return { enabled: false };
  }
  if (hasDbPath && (typeof dbPath !== "string" || dbPath.trim().length === 0)) {
    return { enabled: false };
  }

  const normalizedEnabled =
    typeof enabled === "boolean" ? enabled : DEFAULT_TELEMETRY_CONFIG.enabled;
  const normalizedDbPath = typeof dbPath === "string" ? dbPath : undefined;
  return {
    enabled: normalizedEnabled,
    ...(normalizedDbPath === undefined ? {} : { dbPath: normalizedDbPath }),
  };
}

export interface DelegateConfig {
  agent: {
    /** Global default model for all agent types. */
    default: string | null;
    /** Per-agent-type model overrides. Keys are agent names or "default". */
    [agentType: string]: string | null | undefined;
  };
  /** Per-agent model/thinking/tools overrides (agent name → override), from
   *  delegate.json. Applies to every non-`default` agent, including the
   *  built-ins (`scout`/`coder`/`reviewer`) and custom agents. This is the
   *  modern form; the legacy `agent` map above still feeds custom agents. */
  agentOverrides?: Record<string, AgentOverride>;
  /** Parent-model-scoped overrides keyed by the parent's exact
   *  `provider/model-id`. Win over `agentOverrides` on a key match. */
  agentOverridesByParentModel?: Record<string, Record<string, AgentOverride>>;
  /** Per-model and per-provider concurrency limits. */
  concurrency: {
    /** Default concurrency limit for unspecified models. */
    default: number;
    /** Per-provider limits (e.g. "llamacpp": 2). */
    providers?: Record<string, number>;
    /** Per-model limits keyed by "provider/modelId". */
    models?: Record<string, number>;
  };
  /** Hard ceiling on total concurrent agents across all models. */
  maxConcurrent?: number;
  /** Max concurrent async tickets. */
  maxAsyncTickets?: number;
  /** Maximum inactivity before cooperative stall cancellation is requested (0 disables). */
  stallTimeoutMs?: number;
  /** Whole-task transient-error retry settings. */
  retry?: {
    /** Max whole-task retries after the initial attempt (0 = no retry). */
    wholeTaskMaxRetries?: number;
    /** Base delay (ms) for exponential backoff between whole-task retries. */
    wholeTaskBaseDelayMs?: number;
  };
  /** User-scope extension sources to load for subagents by provider. */
  providerExtensions?: {
    [provider: string]: readonly string[];
  };
  /** Local SQLite telemetry for usage/health analytics. See `telemetry.ts`. */
  telemetry?: TelemetryConfig;
  /** LLM-facing output bounding: over-threshold final output is spilled to a
   *  temp file with a tail kept in-context. See `spill.ts`. */
  output?: {
    /** Over this many chars (strictly), spill. Default 8000. */
    spillThresholdChars?: number;
    /** Tail length (chars) kept in-context when spilled. Default 2000. */
    spillTailChars?: number;
  };
}

/** Resolved lazily (not at module scope) so the path follows the live
 *  `os.homedir()` — the test suite swaps homedir via `mock.module`, and an
 *  eagerly-bound path would keep reading the developer's real config. */
function delegateConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "delegate.json");
}

function normalizeProviderExtensions(
  raw: unknown,
): Record<string, readonly string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  // A null-prototype map keeps config keys such as `constructor` and
  // `__proto__` from resolving to Object.prototype members or mutating the
  // map's prototype during normalization.
  const out = Object.create(null) as Record<string, readonly string[]>;
  for (const [provider, entries] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const normalizedProvider = provider.trim().toLowerCase();
    if (!normalizedProvider || !Array.isArray(entries)) continue;
    const normalizedEntries = entries
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry): entry is string => entry.length > 0);
    if (normalizedEntries.length === 0) continue;
    out[normalizedProvider] = [...new Set(normalizedEntries)];
  }

  return out;
}

// Provider-scoped opt-in extension map for subagents. Keep this aligned with
// the currently shipped codex remote-compaction integration. `delegate.json`
// `providerExtensions` replaces a provider's entries (it does not append); an
// empty array is ignored so the default persists. Provenance is classification
// by config presence: every source the user lists is required and fails
// closed when missing, unverifiable, or broken — including an exact re-listing
// of a shipped default. Shipped defaults (providers the user never mentioned)
// are best-effort: they degrade silently to extension-free subagents on Pi's
// native compaction, because absence of an optional integration is not a
// warning condition — that is Pi's normal operation.
const DEFAULT_PROVIDER_EXTENSIONS: Record<string, readonly string[]> =
  Object.assign(Object.create(null) as Record<string, readonly string[]>, {
    "openai-codex": ["npm:@bermudi/pi-codex"],
  });

function resolveProviderExtensions(
  raw: unknown,
): Record<string, readonly string[]> {
  const out = Object.create(null) as Record<string, readonly string[]>;
  Object.assign(
    out,
    DEFAULT_PROVIDER_EXTENSIONS,
    normalizeProviderExtensions(raw),
  );
  return out;
}

const DEFAULT_DELEGATE_CONFIG: DelegateConfig = {
  agent: { default: null },
  concurrency: { default: MAX_CONCURRENCY },
  maxConcurrent: MAX_CONCURRENCY,
  stallTimeoutMs: 15 * 60 * 1000,
  retry: {
    wholeTaskMaxRetries: 3,
    wholeTaskBaseDelayMs: 1_000,
  },
  providerExtensions: {},
  telemetry: {
    enabled: true,
  },
  output: {
    spillThresholdChars: OUTPUT_SPILL_THRESHOLD_CHARS,
    spillTailChars: OUTPUT_SPILL_TAIL_CHARS,
  },
};

/** Module-level config singleton. Loaded lazily, mutated by setters. */
let __delegateConfig: DelegateConfig = {
  ...DEFAULT_DELEGATE_CONFIG,
  agent: { ...DEFAULT_DELEGATE_CONFIG.agent },
  concurrency: { ...DEFAULT_DELEGATE_CONFIG.concurrency },
  telemetry: { ...DEFAULT_DELEGATE_CONFIG.telemetry },
};
let stallTimeoutOverrideForTesting: number | undefined;

type ReadConfigResult =
  | { status: "ok"; config: DelegateConfig }
  | { status: "missing" }
  | { status: "error"; error: unknown };

/** Read and normalize delegate.json from disk. Distinguishes a missing file
 *  (deliberate deletion) from parse/read errors so reload can keep the prior
 *  valid snapshot instead of silently installing defaults. */
function readDelegateConfigFromDisk(): ReadConfigResult {
  try {
    const raw = fs.readFileSync(delegateConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "error",
        error: new Error("top-level value is not an object"),
      };
    }
    const numericError = validateNumericAndNestedFields(
      parsed as Record<string, unknown>,
    );
    if (numericError) {
      return {
        status: "error",
        error: new Error(numericError),
      };
    }
    // Merge with defaults so new fields are always present
    return {
      status: "ok",
      config: {
        ...DEFAULT_DELEGATE_CONFIG,
        ...parsed,
        agent: { ...DEFAULT_DELEGATE_CONFIG.agent, ...(parsed.agent ?? {}) },
        concurrency: {
          ...DEFAULT_DELEGATE_CONFIG.concurrency,
          ...(parsed.concurrency ?? {}),
        },
        retry: { ...DEFAULT_DELEGATE_CONFIG.retry, ...(parsed.retry ?? {}) },
        providerExtensions: normalizeProviderExtensions(
          parsed.providerExtensions,
        ),
        agentOverrides: normalizeAgentOverrides(parsed.agentOverrides),
        agentOverridesByParentModel: normalizeAgentOverridesByParentModel(
          parsed.agentOverridesByParentModel,
        ),
        telemetry: normalizeTelemetryConfig(parsed.telemetry),
        output: {
          ...DEFAULT_DELEGATE_CONFIG.output,
          ...(parsed.output ?? {}),
        },
      } as DelegateConfig,
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { status: "missing" };
    }
    return { status: "error", error };
  }
}

/** Read delegate config from disk. Returns defaults if file missing or corrupt.
 *
 *  The returned `providerExtensions` is the *user-only* view — exactly what the
 *  file said, defaults excluded. `getSubagentProviderExtensionMap()` is the
 *  merged (defaults + user) view, and
 *  `getSubagentProviderExtensionSourcesForProvider()` is the provenance-tagged
 *  view. Keeping the raw user map here is what lets the sources getter
 *  distinguish "the user listed this" from "this is a shipped default" by
 *  config presence rather than string identity. */
export function loadDelegateConfig(): DelegateConfig {
  const result = readDelegateConfigFromDisk();
  if (result.status === "error") {
    console.warn(
      `[delegate] could not load ${DELEGATE_CONFIG_SOURCE}: ${
        result.error instanceof Error
          ? result.error.message
          : String(result.error)
      }; using defaults.`,
    );
    return structuredClone(DEFAULT_DELEGATE_CONFIG);
  }
  if (result.status === "missing")
    return structuredClone(DEFAULT_DELEGATE_CONFIG);
  return result.config;
}

/** Clone a config while retaining the null-prototype override maps.
 *
 * `structuredClone` deliberately preserves data, not object prototypes. That
 * is normally useful, but these maps are a trust boundary: an inherited
 * `constructor` or `toString` must not look like a configured agent.
 */
function cloneDelegateConfig(config: DelegateConfig): DelegateConfig {
  const clone = structuredClone(config);

  if (clone.agentOverrides) {
    clone.agentOverrides = cloneNullPrototypeMap(clone.agentOverrides);
  }
  if (clone.agentOverridesByParentModel) {
    const parentModels = cloneNullPrototypeMap(
      clone.agentOverridesByParentModel,
    );
    for (const [parentModel, overrides] of Object.entries(parentModels)) {
      parentModels[parentModel] = cloneNullPrototypeMap(overrides);
    }
    clone.agentOverridesByParentModel = parentModels;
  }

  return clone;
}

function cloneNullPrototypeMap<T>(map: Record<string, T>): Record<string, T> {
  const clone = Object.create(null) as Record<string, T>;
  for (const [key, value] of Object.entries(map)) {
    clone[key] = value;
  }
  return clone;
}

/** Return an immutable snapshot of the current delegate configuration.
 *
 *  Async tickets and long-lived task runners capture this at dispatch time so
 *  a later `delegate.json` edit cannot retroactively change an in-flight
 *  batch's retry limits, stall timeout, output-spill bounds, or provider
 *  extension allowlist. */
export function getDelegateConfigSnapshot(): DelegateConfig {
  return cloneDelegateConfig(__delegateConfig);
}

/** Initialize module config from disk. Called once at extension load. */
function initDelegateConfig(): void {
  __delegateConfig = loadDelegateConfig();
}

// Auto-init on module load
initDelegateConfig();

/**
 * Test-only seam: reset the module config singleton to compiled defaults.
 *
 * `__delegateConfig` is auto-initialized from `~/.pi/agent/delegate.json` at
 * import time, so any test that exercises the config-dependent renderers
 * (e.g. the `queued (N running)` label, which reads `getMaxConcurrent()`) is
 * otherwise at the mercy of the developer's on-disk `maxConcurrent`. There are
 * no production mutators (the file is the only write path); this restores the
 * deterministic default baseline for tests, mirroring `_resetPoolForTesting` /
 * `_resetGlobalConcurrencyForTesting`.
 */
export function _resetDelegateConfigForTesting(): void {
  __delegateConfig = structuredClone(DEFAULT_DELEGATE_CONFIG);
  stallTimeoutOverrideForTesting = undefined;
}

/** @internal Test-only override; production configuration is file-only. */
export function _setStallTimeoutForTesting(
  timeoutMs: number | undefined,
): void {
  stallTimeoutOverrideForTesting = timeoutMs;
}

/**
 * Test-only seam: replace delegate config at runtime.
 *
 * This is only for deterministic tests; production config is file-only and not
 * expected to mutate at runtime.
 */
export function _setDelegateConfigForTesting(
  config: Partial<DelegateConfig> = {},
): void {
  const numericError = validateNumericAndNestedFields(
    config as Record<string, unknown>,
  );
  if (numericError) {
    throw new Error(`[delegate] _setDelegateConfigForTesting: ${numericError}`);
  }
  __delegateConfig = {
    ...DEFAULT_DELEGATE_CONFIG,
    ...config,
    agent: {
      ...DEFAULT_DELEGATE_CONFIG.agent,
      ...(config.agent ?? {}),
    },
    concurrency: {
      ...DEFAULT_DELEGATE_CONFIG.concurrency,
      ...(config.concurrency ?? {}),
    },
    retry: {
      ...DEFAULT_DELEGATE_CONFIG.retry,
      ...(config.retry ?? {}),
    },
    providerExtensions: normalizeProviderExtensions(config.providerExtensions),
    agentOverrides: normalizeAgentOverrides(config.agentOverrides),
    agentOverridesByParentModel: normalizeAgentOverridesByParentModel(
      config.agentOverridesByParentModel,
    ),
    telemetry: normalizeTelemetryConfig(config.telemetry),
    output: {
      ...DEFAULT_DELEGATE_CONFIG.output,
      ...(config.output ?? {}),
    },
  };
  stallTimeoutOverrideForTesting = undefined;
}

/**
 * Get the configured provider-scoped extension allowlist for subagents:
 * the merged view (shipped defaults + user config, user entries replacing a
 * provider's defaults). The stored `config.providerExtensions` itself is the
 * user-only view; the merge happens here so provenance survives until a
 * consumer asks for it (`getSubagentProviderExtensionSourcesForProvider`).
 * Explicit configs are normalized here too, so callers using the injected
 * config form get the same case-insensitive and replace-per-provider
 * semantics as the file-backed singleton.
 */
export function getSubagentProviderExtensionMap(
  config: DelegateConfig = __delegateConfig,
): Readonly<Record<string, readonly string[]>> {
  return config.providerExtensions
    ? resolveProviderExtensions(config.providerExtensions)
    : DEFAULT_PROVIDER_EXTENSIONS;
}

/**
 * Get extension sources for a specific provider's subagents. Provider matching is
 * case-insensitive.
 */
export function getSubagentProviderExtensionsForProvider(
  provider: string | undefined,
  config: DelegateConfig = __delegateConfig,
): readonly string[] {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return [];
  const extensions = getSubagentProviderExtensionMap(config);
  return Object.prototype.hasOwnProperty.call(extensions, normalized)
    ? (extensions[normalized] ?? [])
    : [];
}

/** Stable signature for the provider-scoped extension allowlist that applies
 *  to a given model provider. Used as a pool compatibility key so a
 *  `delegate.json` edit that revokes or changes an allowlisted extension does
 *  not silently reuse a pooled session whose runtime already loaded the old
 *  extension code. */
export function getProviderExtensionSignature(
  provider: string | undefined,
  config: DelegateConfig = __delegateConfig,
): string {
  const sources = getSubagentProviderExtensionSourcesForProvider(
    provider,
    config,
  );
  if (sources.length === 0) return "";
  // Preserve both ordering and provenance. Extension order may affect their
  // initialization, and a user re-listing a shipped source changes it from
  // best-effort to required. Treating either change as pool-compatible could
  // reuse an extension-free session without performing the required checks.
  return JSON.stringify(sources);
}

/** A provider-extension source together with how it entered the config. */
export interface ProviderExtensionSource {
  /** The normalized source string, as the package manager consumes it. */
  readonly source: string;
  /**
   * Whether the user configured this source themselves (required) or it is a
   * shipped default for a provider the user never mentioned (best-effort).
   * Required sources fail closed when missing, unverifiable, or broken;
   * best-effort defaults degrade silently to extension-free subagents on
   * Pi's native compaction.
   */
  readonly required: boolean;
}

/**
 * Get the provenance-tagged extension sources for a provider's subagents.
 * Classification is by config presence, never by string identity: everything
 * the user lists in `providerExtensions` is `required: true` — including an
 * exact re-listing of a shipped default, because typing it into the config
 * expresses intent. Providers the user never configured fall back to the
 * shipped defaults, tagged `required: false` (best-effort).
 */
export function getSubagentProviderExtensionSourcesForProvider(
  provider: string | undefined,
  config: DelegateConfig = __delegateConfig,
): readonly ProviderExtensionSource[] {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return [];
  // Normalize the injected config map so an unnormalized key like " Custom-Provider "
  // is handled, matching getSubagentProviderExtensionMap / getSubagentProviderExtensionsForProvider.
  const rawUserMap = config.providerExtensions;
  const userMap = rawUserMap
    ? normalizeProviderExtensions(rawUserMap)
    : (Object.create(null) as Record<string, readonly string[]>);
  if (Object.prototype.hasOwnProperty.call(userMap, normalized)) {
    return (userMap[normalized] ?? []).map((source) => ({
      source,
      required: true,
    }));
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      DEFAULT_PROVIDER_EXTENSIONS,
      normalized,
    )
  ) {
    return [];
  }
  return (DEFAULT_PROVIDER_EXTENSIONS[normalized] ?? []).map((source) => ({
    source,
    required: false,
  }));
}

/** Get the effective per-agent overrides from delegate.json
 *  (agent name → override), or undefined when unconfigured. */
export function getAgentOverrides(
  config: DelegateConfig = __delegateConfig,
): Record<string, AgentOverride> | undefined {
  return config.agentOverrides;
}

/** Get the parent-model-scoped overrides (`provider/model-id` → agent →
 *  override), or undefined when unconfigured. */
export function getAgentOverridesByParentModel(
  config: DelegateConfig = __delegateConfig,
): Record<string, Record<string, AgentOverride>> | undefined {
  return config.agentOverridesByParentModel;
}

/** Re-read delegate.json from disk into the config singleton.
 *
 *  Called at the start of every tool execution so user edits to delegate.json
 *  become visible between delegate calls without restarting pi. On parse or
 *  read errors the existing snapshot is kept and a warning is emitted; a
 *  deliberately deleted file falls back to defaults. */
export function reloadDelegateConfig(): void {
  const result = readDelegateConfigFromDisk();
  if (result.status === "error") {
    console.warn(
      `[delegate] could not reload ${DELEGATE_CONFIG_SOURCE}; keeping current config: ${
        result.error instanceof Error
          ? result.error.message
          : String(result.error)
      }`,
    );
    return;
  }
  __delegateConfig =
    result.status === "missing"
      ? structuredClone(DEFAULT_DELEGATE_CONFIG)
      : result.config;
}

// ── Config Getters ───────────────────────────────────────────────────────

/**
 * Get the effective concurrency limit for a model key.
 *
 * Precedence: per-model → per-provider → default. Accepts an injected config
 * so the precedence chain is testable without touching the module singleton
 * (there are no config mutators — `delegate.json` is the only write path).
 */
export function getConcurrencyLimit(
  modelKey: string,
  config: DelegateConfig = __delegateConfig,
): number {
  // 1. Per-model
  const perModel = config.concurrency.models?.[modelKey];
  if (isPositiveInteger(perModel)) return perModel;
  // 2. Per-provider
  const provider = modelKey.split("/")[0];
  const perProvider = config.concurrency.providers?.[provider];
  if (isPositiveInteger(perProvider)) return perProvider;
  // 3. Default
  return isPositiveInteger(config.concurrency.default)
    ? config.concurrency.default
    : MAX_CONCURRENCY;
}

/** Get the effective max async tickets limit. */
export function getMaxAsyncTickets(
  config: DelegateConfig = __delegateConfig,
): number {
  return isPositiveInteger(config.maxAsyncTickets)
    ? config.maxAsyncTickets
    : MAX_ASYNC_TICKETS;
}

/** Get the hard ceiling on total concurrent agents. */
export function getMaxConcurrent(
  config: DelegateConfig = __delegateConfig,
): number {
  return isPositiveInteger(config.maxConcurrent)
    ? config.maxConcurrent
    : MAX_CONCURRENCY;
}

/** Maximum inactivity before cooperative stall cancellation is requested.
 * `0` disables detection; malformed values fall back to the compiled default. */
export function getStallTimeoutMs(
  config: DelegateConfig = __delegateConfig,
): number {
  const configured = stallTimeoutOverrideForTesting ?? config.stallTimeoutMs;
  return isNonNegativeInteger(configured)
    ? configured
    : DEFAULT_DELEGATE_CONFIG.stallTimeoutMs!;
}

/** Get the max whole-task retries after the initial attempt. */
export function getWholeTaskMaxRetries(
  config: DelegateConfig = __delegateConfig,
): number {
  return isNonNegativeInteger(config.retry?.wholeTaskMaxRetries)
    ? config.retry!.wholeTaskMaxRetries
    : 3;
}

/** Get the base delay (ms) for whole-task retry exponential backoff. */
export function getWholeTaskBaseDelayMs(
  config: DelegateConfig = __delegateConfig,
): number {
  return isNonNegativeInteger(config.retry?.wholeTaskBaseDelayMs)
    ? config.retry!.wholeTaskBaseDelayMs
    : 1_000;
}

/** Get the output-spill threshold (chars). Over this, final output is spilled. */
export function getOutputSpillThreshold(
  config: DelegateConfig = __delegateConfig,
): number {
  return isPositiveInteger(config.output?.spillThresholdChars)
    ? config.output!.spillThresholdChars
    : OUTPUT_SPILL_THRESHOLD_CHARS;
}

/** Get the output-spill tail length (chars) kept in-context when spilled. */
export function getOutputSpillTail(
  config: DelegateConfig = __delegateConfig,
): number {
  return isNonNegativeInteger(config.output?.spillTailChars)
    ? config.output!.spillTailChars
    : OUTPUT_SPILL_TAIL_CHARS;
}

/**
 * Resolve an *explicit* model spec string using the precedence chain.
 * Returns the first non-null, non-empty string value, or `undefined` when no
 * explicit spec is set — in which case the caller inherits the parent
 * session's model object directly (see extension.ts).
 *
 * Parent inheritance is intentionally NOT a tier here: the parent model is
 * already a resolved, authenticated Model object. Re-resolving its id string
 * through the registry would be both redundant and lossy for composite ids
 * such as OpenRouter's "provider/upstream/model", whose first segment is an
 * upstream provider name, not a configured pi provider — that misroutes auth
 * lookup to the wrong provider.
 *
 * Precedence (highest to lowest):
 *   1. taskModel                 — per-task explicit override (from API call)
 *   2. config.agent[agentType]   — config per-type (delegate.json)
 *   3. config.agent["default"]   — config global
 *   4. frontmatterModel          — agent .md frontmatter
 */
export function resolveModelSpec(options: {
  taskModel?: string;
  agentType: string;
  frontmatterModel?: string;
  config?: DelegateConfig;
}): string | undefined {
  const {
    taskModel,
    agentType,
    frontmatterModel,
    config = __delegateConfig,
  } = options;

  const candidates: Array<string | null | undefined> = [
    taskModel,
    config.agent[agentType] as string | null | undefined,
    config.agent["default"],
    frontmatterModel,
  ];

  return candidates.find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/** Get the configured telemetry settings. */
export function getTelemetryConfig(
  config: DelegateConfig = __delegateConfig,
): TelemetryConfig {
  return normalizeTelemetryConfig(config.telemetry);
}

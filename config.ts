import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_ASYNC_TICKETS,
  MAX_CONCURRENCY,
  OUTPUT_SPILL_TAIL_CHARS,
  OUTPUT_SPILL_THRESHOLD_CHARS,
} from "./constants.ts";

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

const DELEGATE_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const DELEGATE_CONFIG_PATH = path.join(DELEGATE_CONFIG_DIR, "delegate.json");

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
  try {
    const raw = fs.readFileSync(DELEGATE_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return structuredClone(DEFAULT_DELEGATE_CONFIG);
    // Merge with defaults so new fields are always present
    return {
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
      telemetry: normalizeTelemetryConfig(parsed.telemetry),
      output: { ...DEFAULT_DELEGATE_CONFIG.output, ...(parsed.output ?? {}) },
    } as DelegateConfig;
  } catch {
    return structuredClone(DEFAULT_DELEGATE_CONFIG);
  }
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
  if (perModel != null) return perModel;
  // 2. Per-provider
  const provider = modelKey.split("/")[0];
  const perProvider = config.concurrency.providers?.[provider];
  if (perProvider != null) return perProvider;
  // 3. Default
  return config.concurrency.default;
}

/** Get the effective max async tickets limit. */
export function getMaxAsyncTickets(): number {
  return __delegateConfig.maxAsyncTickets ?? MAX_ASYNC_TICKETS;
}

/** Get the hard ceiling on total concurrent agents. */
export function getMaxConcurrent(): number {
  return __delegateConfig.maxConcurrent ?? MAX_CONCURRENCY;
}

/** Maximum inactivity before cooperative stall cancellation is requested.
 * `0` disables detection; malformed values fall back to the compiled default. */
export function getStallTimeoutMs(
  config: DelegateConfig = __delegateConfig,
): number {
  const configured = stallTimeoutOverrideForTesting ?? config.stallTimeoutMs;
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured >= 0
  ) {
    return configured;
  }
  return DEFAULT_DELEGATE_CONFIG.stallTimeoutMs!;
}

/** Get the max whole-task retries after the initial attempt. */
export function getWholeTaskMaxRetries(): number {
  return __delegateConfig.retry?.wholeTaskMaxRetries ?? 3;
}

/** Get the base delay (ms) for whole-task retry exponential backoff. */
export function getWholeTaskBaseDelayMs(): number {
  return __delegateConfig.retry?.wholeTaskBaseDelayMs ?? 1_000;
}

/** Get the output-spill threshold (chars). Over this, final output is spilled. */
export function getOutputSpillThreshold(): number {
  return (
    __delegateConfig.output?.spillThresholdChars ?? OUTPUT_SPILL_THRESHOLD_CHARS
  );
}

/** Get the output-spill tail length (chars) kept in-context when spilled. */
export function getOutputSpillTail(): number {
  return __delegateConfig.output?.spillTailChars ?? OUTPUT_SPILL_TAIL_CHARS;
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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ASYNC_TICKETS, MAX_CONCURRENCY } from "./constants.ts";

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
}

/** Session-only model overrides. Not persisted — cleared on session_start. */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

const DELEGATE_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const DELEGATE_CONFIG_PATH = path.join(DELEGATE_CONFIG_DIR, "delegate.json");

const DEFAULT_DELEGATE_CONFIG: DelegateConfig = {
  agent: { default: null },
  concurrency: { default: MAX_CONCURRENCY },
  maxConcurrent: MAX_CONCURRENCY,
};

/** Module-level config singleton. Loaded lazily, mutated by setters. */
let __delegateConfig: DelegateConfig = {
  ...DEFAULT_DELEGATE_CONFIG,
  agent: { ...DEFAULT_DELEGATE_CONFIG.agent },
  concurrency: { ...DEFAULT_DELEGATE_CONFIG.concurrency },
};

/** Session-only overrides. Cleared on session_start. */
let sessionOverrides: SessionModelOverrides = { default: null };

export function resetSessionOverrides(): void {
  sessionOverrides = { default: null };
}

/** Read delegate config from disk. Returns defaults if file missing or corrupt. */
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
    } as DelegateConfig;
  } catch {
    return structuredClone(DEFAULT_DELEGATE_CONFIG);
  }
}

/** Write delegate config to disk with atomic rename. */
export function saveDelegateConfigAtomic(config: DelegateConfig): void {
  const tmpPath = DELEGATE_CONFIG_PATH + ".tmp";
  try {
    fs.mkdirSync(DELEGATE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, DELEGATE_CONFIG_PATH);
  } catch (err) {
    console.error(`[delegate] Failed to save config: ${err}`);
  }
}

/** Initialize module config from disk. Called once at extension load. */
function initDelegateConfig(): void {
  __delegateConfig = loadDelegateConfig();
}

// Auto-init on module load
initDelegateConfig();

// ── Config Mutators ──────────────────────────────────────────────────────

/** Set or update a model override for an agent type (or "default" for global). */
export function setModelOverride(type: string, value: string | null): void {
  __delegateConfig.agent[type] = value;
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Set the global default model. */
export function setDefaultModel(value: string | null): void {
  __delegateConfig.agent.default = value;
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Clear a single per-type model override. */
export function clearModelOverride(type: string): void {
  delete __delegateConfig.agent[type];
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Clear all model overrides, preserving non-model config. */
export function clearAllModelOverrides(): void {
  __delegateConfig.agent = { default: null };
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Set the global concurrency default. */
export function setConcurrencyDefault(n: number): void {
  __delegateConfig.concurrency.default = Math.max(1, n);
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Set or update a per-provider concurrency limit. */
export function setConcurrencyProvider(key: string, n: number): void {
  const current = __delegateConfig.concurrency.providers ?? {};
  __delegateConfig.concurrency.providers = {
    ...current,
    [key]: Math.max(1, n),
  };
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Set or update a per-model concurrency limit. */
export function setConcurrencyModel(key: string, n: number): void {
  const current = __delegateConfig.concurrency.models ?? {};
  __delegateConfig.concurrency.models = { ...current, [key]: Math.max(1, n) };
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Remove a per-provider concurrency limit. */
export function removeConcurrencyProvider(key: string): void {
  if (__delegateConfig.concurrency.providers) {
    delete __delegateConfig.concurrency.providers[key];
    saveDelegateConfigAtomic(__delegateConfig);
  }
}

/** Remove a per-model concurrency limit. */
export function removeConcurrencyModel(key: string): void {
  if (__delegateConfig.concurrency.models) {
    delete __delegateConfig.concurrency.models[key];
    saveDelegateConfigAtomic(__delegateConfig);
  }
}

/** Reset all concurrency settings to defaults. */
export function resetConcurrency(): void {
  __delegateConfig.concurrency = { ...DEFAULT_DELEGATE_CONFIG.concurrency };
  saveDelegateConfigAtomic(__delegateConfig);
}

/** Get the effective concurrency limit for a model key. */
export function getConcurrencyLimit(modelKey: string): number {
  // 1. Per-model
  const perModel = __delegateConfig.concurrency.models?.[modelKey];
  if (perModel != null) return perModel;
  // 2. Per-provider
  const provider = modelKey.split("/")[0];
  const perProvider = __delegateConfig.concurrency.providers?.[provider];
  if (perProvider != null) return perProvider;
  // 3. Default
  return __delegateConfig.concurrency.default;
}

/** Get the effective max async tickets limit. */
export function getMaxAsyncTickets(): number {
  return __delegateConfig.maxAsyncTickets ?? MAX_ASYNC_TICKETS;
}

/** Get the hard ceiling on total concurrent agents. */
export function getMaxConcurrent(): number {
  return __delegateConfig.maxConcurrent ?? MAX_CONCURRENCY;
}

/** Set the hard ceiling on total concurrent agents. */
export function setMaxConcurrent(n: number): void {
  __delegateConfig.maxConcurrent = Math.max(1, n);
  saveDelegateConfigAtomic(__delegateConfig);
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
 *   1. taskModel                      — per-task explicit override (from API call)
 *   2. sessionOverrides[agentType]    — session per-type
 *   3. sessionOverrides["default"]    — session global
 *   4. config.agent[agentType]        — config per-type
 *   5. config.agent["default"]        — config global
 *   6. frontmatterModel               — agent .md frontmatter
 */
export function resolveModelSpec(options: {
  taskModel?: string;
  agentType: string;
  frontmatterModel?: string;
  config?: DelegateConfig;
  overrides?: SessionModelOverrides;
}): string | undefined {
  const {
    taskModel,
    agentType,
    frontmatterModel,
    config = __delegateConfig,
    overrides = sessionOverrides,
  } = options;

  const candidates: Array<string | null | undefined> = [
    taskModel,
    overrides[agentType],
    overrides["default"],
    config.agent[agentType] as string | null | undefined,
    config.agent["default"],
    frontmatterModel,
  ];

  return candidates.find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_ASYNC_TICKETS,
  MAX_CONCURRENCY,
  OUTPUT_SPILL_TAIL_CHARS,
  OUTPUT_SPILL_THRESHOLD_CHARS,
} from "./constants.ts";

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
  /** Whole-task transient-error retry settings. */
  retry?: {
    /** Max whole-task retries after the initial attempt (0 = no retry). */
    wholeTaskMaxRetries?: number;
    /** Base delay (ms) for exponential backoff between whole-task retries. */
    wholeTaskBaseDelayMs?: number;
  };
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

const DEFAULT_DELEGATE_CONFIG: DelegateConfig = {
  agent: { default: null },
  concurrency: { default: MAX_CONCURRENCY },
  maxConcurrent: MAX_CONCURRENCY,
  retry: {
    wholeTaskMaxRetries: 3,
    wholeTaskBaseDelayMs: 1_000,
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
};

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
      retry: { ...DEFAULT_DELEGATE_CONFIG.retry, ...(parsed.retry ?? {}) },
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
  const { taskModel, agentType, frontmatterModel, config = __delegateConfig } =
    options;

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

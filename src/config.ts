import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  knownAgentNames,
  parseModelEntry,
  type ModelAssignment,
} from "./profiles.ts";
import type { OutputBounds } from "./types.ts";

export interface ConcurrencyConfig {
  /** Per-model-key bound when no more specific entry applies. */
  readonly default: number | undefined;
  /** Provider id → bound (e.g. "anthropic": 2). */
  readonly providers: Readonly<Record<string, number>>;
  /** "provider/model-id" → bound; wins over providers and default. */
  readonly models: Readonly<Record<string, number>>;
}

export interface TelemetryConfig {
  readonly enabled: boolean;
  readonly dbPath: string | undefined;
}

export interface SessionsConfig {
  /**
   * Pooled-session residency bound (#46): how many *idle* pooled sessions
   * stay live in memory. Beyond it, the least-recently-idle unload to
   * their transcript files and transparently reload on the next
   * same-sessionId task. Checked-out (running) sessions never unload.
   * 0 keeps nothing resident — every reuse reloads.
   */
  readonly maxIdle: number;
}

export interface DelegateConfig {
  /** Operator-selected model-facing schema, fixed until extension reload. */
  readonly surface: DelegateSurface;
  /** Global bound on simultaneously executing tasks. */
  readonly maxConcurrent: number;
  readonly concurrency: ConcurrencyConfig;
  /**
   * Per-agent model assignment: named agent (explore, coder, ...) → model
   * reference with an optional `:effort` suffix. There is deliberately no
   * "default" entry: inline tasks and the `default` profile always mirror
   * the parent's model. Callers never select models; entries here are the
   * only override, user-authored.
   */
  readonly models: Readonly<Record<string, ModelAssignment>>;
  /**
   * Parent-scoped pins, keyed by the parent's exact `provider/model-id`
   * (normalized lowercase). An entry here wins over `models` for the same
   * agent; a non-matching parent key simply never applies.
   */
  readonly modelsByParent: Readonly<
    Record<string, Readonly<Record<string, ModelAssignment>>>
  >;
  /**
   * Inactivity watchdog: a task whose session emits no events for this long
   * is cooperatively aborted as stalled. 0 disables it.
   */
  readonly stallTimeoutMs: number;
  readonly telemetry: TelemetryConfig;
  readonly sessions: SessionsConfig;
  /**
   * User-scope extension sources to load into subagent children, keyed by
   * provider id (#59). The stored map is the user-only view: a provider
   * absent here falls back to `DEFAULT_PROVIDER_EXTENSIONS` at selection
   * time; a listed provider's array REPLACES that provider's defaults
   * (never appends) and its sources become required (fail closed), while
   * shipped defaults degrade silently. Empty arrays are ignored — they do
   * not disable a shipped default.
   */
  readonly providerExtensions: Readonly<Record<string, readonly string[]>>;
  /**
   * LLM-facing output bounding: over `spillThresholdChars` a settled task's
   * output spills to an owner-only temp file and only a `spillTailChars`
   * tail stays in-context (see `spill.ts`). Dispatch-scoped: tickets
   * snapshot these at creation.
   */
  readonly output: OutputBounds;
}

export const DEFAULT_CONFIG: DelegateConfig = {
  surface: "compact",
  // Default 8, not 3 (#41): the 2026-09-28 harness survey found
  // letta/grok/oh-my-pi default to 32 and minimax/deepseek/MiMo/fx ship
  // uncapped — 3 was conservative enough to tax ordinary fan-outs, while
  // 8 stays moderate. `concurrency.models`/`providers` per-model maps
  // remain the real rate-limit guard for providers that need one.
  maxConcurrent: 8,
  concurrency: { default: undefined, providers: {}, models: {} },
  models: {},
  modelsByParent: {},
  stallTimeoutMs: 15 * 60 * 1000,
  telemetry: { enabled: false, dbPath: undefined },
  // Idle residency bound 4 (#46): codex unloads idle agents to their
  // rollout files under memory pressure — a pooled session holds a full
  // in-memory transcript, so resident idles are the expensive resource.
  // Four keeps ordinary sessionId reuse resident while bounding a fleet;
  // checked-out sessions are never counted (in-flight never unloads).
  sessions: { maxIdle: 4 },
  providerExtensions: {},
  output: { spillThresholdChars: 8000, spillTailChars: 2000 },
};

/**
 * The shipped provider-extension allowlist (#59; v1 config.ts:471-473):
 * providers whose children want a companion extension — today
 * `openai-codex` → `npm:@bermudi/pi-codex` (the apply_patch edit/write
 * swap, web_search, and remote compaction codex children are trained
 * for). Sources listed only here are best-effort: missing, unverifiable,
 * or broken, they degrade silently to extension-free children — an
 * absent optional integration is Pi's normal operation, not a warning.
 * A provider the user lists in `providerExtensions` leaves this table:
 * user-listed sources are required instead, including an exact
 * re-listing of a shipped default.
 */
export const DEFAULT_PROVIDER_EXTENSIONS: Readonly<
  Record<string, readonly string[]>
> = Object.assign(Object.create(null) as Record<string, readonly string[]>, {
  "openai-codex": ["npm:@bermudi/pi-codex"],
});

/** A configured provider-extension source with its failure semantics. */
export interface ProviderExtensionSource {
  readonly source: string;
  /**
   * True for every source the user listed in `providerExtensions` —
   * including an exact re-listing of a shipped default, because typing it
   * into the config expresses intent. False for a shipped default at a
   * provider the user never mentioned (best-effort: degrade silently).
   */
  readonly required: boolean;
}

/**
 * Provenance-tagged extension sources for one provider's subagents
 * (v1 config.ts:818-846). Classification is by config presence, never
 * string identity: everything the user lists is required; providers the
 * user never configured fall back to the shipped defaults, tagged
 * best-effort. Provider matching is case-insensitive.
 */
export function getSubagentProviderExtensionSourcesForProvider(
  provider: string | undefined,
  config: DelegateConfig,
): readonly ProviderExtensionSource[] {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return [];
  // The parsed map is already normalized; hasOwn keeps config keys such
  // as "__proto__" from resolving to Object.prototype members.
  if (Object.hasOwn(config.providerExtensions, normalized)) {
    return (config.providerExtensions[normalized] ?? []).map((source) => ({
      source,
      required: true,
    }));
  }
  if (!Object.hasOwn(DEFAULT_PROVIDER_EXTENSIONS, normalized)) return [];
  return (DEFAULT_PROVIDER_EXTENSIONS[normalized] ?? []).map((source) => ({
    source,
    required: false,
  }));
}

/**
 * Opaque signature of the provider-scoped extension allowlist applying to
 * a provider (v1 config.ts:766-789): pooled sessions freeze it so a
 * `delegate.json` edit that revokes or changes the applicable sources can
 * never silently reuse a session whose runtime already loaded different
 * extension code. Order and provenance are both significant — extension
 * order may affect initialization, and re-listing a shipped source flips
 * it from best-effort to required. Opaque on purpose: it crosses the
 * session-pool boundary, so a credential-bearing Git source must never
 * become model-visible through a pool mismatch.
 */
export function getProviderExtensionSignature(
  provider: string | undefined,
  config: DelegateConfig,
): string {
  const sources = getSubagentProviderExtensionSourcesForProvider(provider, config);
  if (sources.length === 0) return "";
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sources), "utf8")
    .digest("hex")}`;
}

/** A `ModelAssignment` plus the config path that produced it, for errors. */
export interface ResolvedModelAssignment extends ModelAssignment {
  /** Config path naming the winning entry (e.g. `models.explore`). */
  readonly origin: string;
}

/**
 * Model pin for one task: the named agent's `modelsByParent` entry when the
 * parent matches (scoped wins over unscoped), else its `models` entry, else
 * undefined (= the parent's model). Inline tasks and the `default` profile
 * never get an entry — mirroring the parent is the invariant, not a
 * configurable.
 */
export function configuredModelFor(
  agent: string | undefined,
  parentKey: string | undefined,
  config: DelegateConfig,
): ResolvedModelAssignment | undefined {
  if (agent === undefined || agent === "default") return undefined;
  const scoped =
    parentKey === undefined ? undefined : config.modelsByParent[parentKey]?.[agent];
  if (scoped) {
    return { ...scoped, origin: `modelsByParent.${parentKey}.${agent}` };
  }
  const entry = config.models[agent];
  return entry === undefined
    ? undefined
    : { ...entry, origin: `models.${agent}` };
}

/** Effective per-model bound: model key, then provider, then default, then global. */
export function modelConcurrencyLimit(
  modelKey: string,
  config: DelegateConfig,
): number {
  const perModel = config.concurrency.models[modelKey];
  if (perModel !== undefined) return perModel;
  const provider = modelKey.split("/")[0] ?? modelKey;
  const perProvider = config.concurrency.providers[provider];
  if (perProvider !== undefined) return perProvider;
  return config.concurrency.default ?? config.maxConcurrent;
}

const CONFIG_FILE = "delegate.json";

export type DelegateSurface = "compact" | "full";

function parseSurface(value: unknown, path: string): DelegateSurface {
  if (value === undefined) return "compact";
  if (value !== "compact" && value !== "full") {
    throw new Error(`${path}: surface must be "compact" or "full".`);
  }
  return value;
}

/** Select presentation without validating unrelated model pins or limits. */
export function loadDelegateSurface(agentDir: string): DelegateSurface {
  const path = configPathOf(agentDir);
  if (!existsSync(path)) return "compact";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object.`);
  }
  return parseSurface((raw as Record<string, unknown>).surface, path);
}

/** Where a resolved agent directory came from. */
export type AgentDirSource = "env" | "session" | "cwd";

export interface AgentDirResolution {
  readonly dir: string;
  readonly source: AgentDirSource;
}

const AGENT_DIR_ENV_VAR = "DELEGATE_AGENT_DIR";
// pi-coding-agent's own agent-dir override (its ENV_AGENT_DIR constant is
// not re-exported from the package index; keep the literal in sync).
const PI_AGENT_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";

/**
 * Resolve the user-global agent directory, with provenance, from these
 * sources in order:
 *
 * 1. `DELEGATE_AGENT_DIR` — delegate-specific operator intent; never
 *    warned about.
 * 2. `PI_CODING_AGENT_DIR` — Pi's own override, resolved through its
 *    exported `getAgentDir()` (which expands `~`). The check is gated on
 *    the variable being set because unset `getAgentDir()` returns Pi's
 *    install default (`~/.pi/agent`), which would preempt the session
 *    inference embedded hosts rely on.
 * 3. The session-store layout (`<agentDir>/sessions/<cwd-slug>`), which is
 *    how the Pi CLI lays sessions out.
 * 4. `ctx.cwd` — the fallback for embedded hosts running in-memory
 *    sessions, which have no session dir.
 *
 * Pi 0.87 does not expose `agentDir` on `ExtensionContext` (tracked
 * upstream as earendil-works/pi#4807). The cwd fallback is warned about
 * once at dispatch (see the extension in `delegate.ts`) rather than thrown,
 * because embedded hosts — including our test harness — legitimately run
 * without a session dir and would otherwise be unusable. When `ctx.agentDir`
 * lands upstream, delete the inference and the fallback and read it
 * directly.
 */
export function resolveAgentDir(ctx: ExtensionContext): AgentDirResolution {
  const fromEnv = process.env[AGENT_DIR_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { dir: fromEnv.trim(), source: "env" };
  }
  const fromPiEnv = process.env[PI_AGENT_DIR_ENV_VAR];
  if (fromPiEnv !== undefined && fromPiEnv.trim() !== "") {
    return { dir: getAgentDir(), source: "env" };
  }
  const sessionDir = ctx.sessionManager.getSessionDir();
  if (sessionDir && basename(dirname(sessionDir)) === "sessions") {
    return { dir: dirname(dirname(sessionDir)), source: "session" };
  }
  return { dir: ctx.cwd, source: "cwd" };
}

/** Path of the user-global delegate.json under a resolved agent directory. */
export function configPathOf(agentDir: string): string {
  return join(agentDir, CONFIG_FILE);
}

/**
 * A defensive raw read of `delegate.json`'s `telemetry` block for the
 * config-load misfire path (SPEC v3 "Observability"): when the load
 * itself threw, this is the only way a malformed `maxConcurrent` (say)
 * still records its row. The `telemetry` block must itself be
 * well-formed for its `enabled` flag to count; when the file is
 * unparseable or the block is malformed, status is unknowable and this
 * returns the disabled default — identical to telemetry off.
 */
export function telemetryConfigHint(agentDir: string): TelemetryConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(configPathOf(agentDir), "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return DEFAULT_CONFIG.telemetry;
    }
    const telemetry = (raw as Record<string, unknown>).telemetry;
    if (telemetry === null || typeof telemetry !== "object" || Array.isArray(telemetry)) {
      return DEFAULT_CONFIG.telemetry;
    }
    const block = telemetry as Record<string, unknown>;
    if (block.enabled !== true) return DEFAULT_CONFIG.telemetry;
    const dbPath = block.dbPath;
    if (
      dbPath !== undefined &&
      (typeof dbPath !== "string" || dbPath.trim() === "" || !isAbsolute(dbPath.trim()))
    ) {
      return DEFAULT_CONFIG.telemetry;
    }
    return {
      enabled: true,
      dbPath: typeof dbPath === "string" ? dbPath.trim() : undefined,
    };
  } catch {
    return DEFAULT_CONFIG.telemetry;
  }
}

/**
 * Load `delegate.json` from a resolved agent directory. A missing file
 * yields defaults; malformed JSON, a non-positive `maxConcurrent`, or a
 * negative `stallTimeoutMs` fails loudly — a half-applied limit is worse
 * than an error.
 *
 * `additionalAgentNames` extends the valid `models`/`modelsByParent` key
 * set beyond the built-ins — pass the globally defined Markdown profile
 * names (project-scoped names are not portable config keys).
 */
export function loadDelegateConfig(
  agentDir: string,
  additionalAgentNames: readonly string[] = [],
): DelegateConfig {
  const path = configPathOf(agentDir);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object.`);
  }
  const config = raw as Record<string, unknown>;
  const maxConcurrent = config.maxConcurrent;
  if (
    maxConcurrent !== undefined &&
    (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) <= 0)
  ) {
    throw new Error(
      `${path}: maxConcurrent must be a positive integer; got ${JSON.stringify(maxConcurrent)}.`,
    );
  }
  const stallTimeoutMs = config.stallTimeoutMs;
  if (
    stallTimeoutMs !== undefined &&
    (!Number.isInteger(stallTimeoutMs) || (stallTimeoutMs as number) < 0)
  ) {
    throw new Error(
      `${path}: stallTimeoutMs must be a non-negative integer; got ${JSON.stringify(stallTimeoutMs)}.`,
    );
  }
  return {
    surface: parseSurface(config.surface, path),
    maxConcurrent: (maxConcurrent as number) ?? DEFAULT_CONFIG.maxConcurrent,
    concurrency: parseConcurrency(config.concurrency, path),
    models: parseModels(config.models, "models", path, additionalAgentNames),
    modelsByParent: parseModelsByParent(
      config.modelsByParent,
      path,
      additionalAgentNames,
    ),
    stallTimeoutMs:
      (stallTimeoutMs as number) ?? DEFAULT_CONFIG.stallTimeoutMs,
    telemetry: parseTelemetry(config.telemetry, path),
    sessions: parseSessions(config.sessions, path),
    providerExtensions: parseProviderExtensions(config.providerExtensions, path),
    output: parseOutput(config.output, path),
  };
}

/**
 * Parse the `providerExtensions` map (provider id → source array).
 * Normalization mirrors v1 (config.ts:437-460): keys trim + lowercase,
 * entries trim, dedupe first-seen, and an array with no usable entries
 * is ignored — it never disables a shipped default. Where v1 dropped
 * malformed shapes silently, this fails loudly naming the key, like the
 * other config blocks: a half-applied allowlist is worse than an error.
 */
function parseProviderExtensions(
  value: unknown,
  path: string,
): Record<string, readonly string[]> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${path}: providerExtensions must be an object mapping a provider id to extension sources.`,
    );
  }
  // A null-prototype map keeps keys such as "__proto__" own-properties.
  const out = Object.create(null) as Record<string, readonly string[]>;
  for (const [key, entries] of Object.entries(value as Record<string, unknown>)) {
    const provider = key.trim().toLowerCase();
    if (provider === "") {
      throw new Error(`${path}: providerExtensions has a blank provider key.`);
    }
    if (!Array.isArray(entries)) {
      throw new Error(
        `${path}: providerExtensions.${key} must be an array of extension source strings; got ${JSON.stringify(entries)}.`,
      );
    }
    const sources: string[] = [];
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error(
          `${path}: providerExtensions.${key}[${index}] must be a non-empty source string; got ${JSON.stringify(entry)}.`,
        );
      }
      const source = entry.trim();
      if (!sources.includes(source)) sources.push(source);
    }
    // An empty array is ignored — the shipped default still applies;
    // there is deliberately no config-only way to disable it (v1 parity).
    if (sources.length === 0) continue;
    if (Object.hasOwn(out, provider)) {
      throw new Error(
        `${path}: providerExtensions key '${key}' duplicates '${provider}' after normalization.`,
      );
    }
    out[provider] = sources;
  }
  return out;
}

/**
 * Parse the optional `output` block: LLM-facing output bounding
 * (`{ spillThresholdChars?, spillTailChars? }`). A malformed bound fails
 * loudly — silently ignoring it could flood the caller's context.
 */
function parseOutput(value: unknown, path: string): OutputBounds {
  if (value === undefined) return DEFAULT_CONFIG.output;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: output must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const threshold = raw.spillThresholdChars;
  if (threshold !== undefined && !isPositiveInteger(threshold)) {
    throw new Error(
      `${path}: output.spillThresholdChars must be a positive integer; got ${JSON.stringify(threshold)}.`,
    );
  }
  const tail = raw.spillTailChars;
  if (
    tail !== undefined &&
    (typeof tail !== "number" || !Number.isInteger(tail) || tail < 0)
  ) {
    throw new Error(
      `${path}: output.spillTailChars must be a non-negative integer; got ${JSON.stringify(tail)}.`,
    );
  }
  return {
    spillThresholdChars:
      (threshold as number) ?? DEFAULT_CONFIG.output.spillThresholdChars,
    spillTailChars: (tail as number) ?? DEFAULT_CONFIG.output.spillTailChars,
  };
}

/**
 * Parse the optional `sessions` block: pooled-session residency (#46).
 * `maxIdle` is a non-negative integer — 0 unloads every idle session.
 * Unknown keys fail loudly, like the other blocks.
 */
function parseSessions(value: unknown, path: string): SessionsConfig {
  if (value === undefined) return DEFAULT_CONFIG.sessions;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: sessions must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "maxIdle") {
      throw new Error(
        `${path}: sessions.${key} is not a known sessions option; known keys: maxIdle.`,
      );
    }
  }
  if (raw.maxIdle !== undefined && !(
    typeof raw.maxIdle === "number" &&
    Number.isInteger(raw.maxIdle) &&
    raw.maxIdle >= 0
  )) {
    throw new Error(
      `${path}: sessions.maxIdle must be a non-negative integer; got ${JSON.stringify(raw.maxIdle)}.`,
    );
  }
  return {
    maxIdle: (raw.maxIdle as number) ?? DEFAULT_CONFIG.sessions.maxIdle,
  };
}

function parseTelemetry(value: unknown, path: string): TelemetryConfig {
  if (value === undefined) return DEFAULT_CONFIG.telemetry;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: telemetry must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "enabled" && key !== "dbPath") {
      throw new Error(
        `${path}: telemetry.${key} is not a known telemetry option; known keys: enabled, dbPath.`,
      );
    }
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(
      `${path}: telemetry.enabled must be a boolean; got ${JSON.stringify(raw.enabled)}.`,
    );
  }
  const enabled = raw.enabled === true;
  const dbPath = raw.dbPath;
  // dbPath is inert while telemetry is disabled: ignore it rather than
  // failing a call that records nothing.
  if (!enabled) {
    return { enabled: false, dbPath: undefined };
  }
  if (
    dbPath !== undefined &&
    (typeof dbPath !== "string" ||
      dbPath.trim() === "" ||
      !isAbsolute(dbPath.trim()))
  ) {
    throw new Error(
      `${path}: telemetry.dbPath must be a non-empty absolute path; got ${JSON.stringify(dbPath)}.`,
    );
  }
  return {
    enabled: true,
    dbPath: typeof dbPath === "string" ? dbPath.trim() : undefined,
  };
}

/**
 * Parse an agent → pin map (`models`, or one inner `modelsByParent` map):
 * keys must name a known non-default agent (a typo fails at load instead
 * of silently never matching); a "default" key is rejected explicitly —
 * inline/default tasks inherit the parent's model, full stop. Values are
 * `provider/model[:effort]` references. A malformed entry fails loudly — a
 * silently dropped assignment would surface later as a confusing per-task
 * failure.
 */
function parseModels(
  value: unknown,
  name: string,
  path: string,
  additionalAgentNames: readonly string[],
): Record<string, ModelAssignment> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${path}: ${name} must be an object mapping a named agent to a model reference.`,
    );
  }
  const known = [
    ...knownAgentNames().filter((n) => n !== "default"),
    ...additionalAgentNames,
  ];
  const out: Record<string, ModelAssignment> = {};
  for (const [agent, entry] of Object.entries(value as Record<string, unknown>)) {
    if (agent === "default") {
      throw new Error(
        `${path}: ${name}.default is rejected — inline/default tasks always run on the parent's model. ` +
          `Configure named agents only: ${known.join(", ")}.`,
      );
    }
    // Preserve migration guidance for the retired built-in name (#40),
    // but an authored global scout is an ordinary exact-name profile (#61).
    if (agent === "scout" && !additionalAgentNames.includes("scout")) {
      throw new Error(
        `${path}: ${name}.scout is rejected — the built-in was renamed "explore". ` +
          `Rename the key to ${name}.explore.`,
      );
    }
    if (!known.includes(agent)) {
      throw new Error(
        `${path}: ${name} key '${agent}' is not a known agent; known agents: ${known.join(", ")}.`,
      );
    }
    out[agent] = parseModelEntry(entry, `${name}.${agent}`, path);
  }
  return out;
}

/**
 * Parse the `modelsByParent` map: parent's exact `provider/model-id` → an
 * agent → pin map. Keys are normalized lowercase (matching is
 * case-insensitive, like model references elsewhere); a key that could
 * never match — empty, missing the slash, an empty provider or model id,
 * doubled slashes, or internal whitespace — is a config error, since it
 * could never match a real parent model. Slashes inside the model id are
 * legal (e.g. OpenRouter's `openrouter/anthropic/claude-sonnet-4`): keys
 * name the provider before the first slash plus the full model id.
 * Colons are legal here: model ids carry them
 * (`ollama/qwen2.5:32b`), and keys name the parent's exact id.
 */
function parseModelsByParent(
  value: unknown,
  path: string,
  additionalAgentNames: readonly string[],
): Record<string, Record<string, ModelAssignment>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${path}: modelsByParent must be an object mapping a parent provider/model-id to per-agent model references.`,
    );
  }
  const out: Record<string, Record<string, ModelAssignment>> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.trim().toLowerCase();
    // Keys are provider + "/" + full model id; the id itself may contain
    // slashes (e.g. OpenRouter's openrouter/anthropic/claude-sonnet-4).
    // Split on the first slash and validate provider and id separately.
    const slash = normalized.indexOf("/");
    const provider = slash === -1 ? "" : normalized.slice(0, slash);
    const modelId = slash === -1 ? "" : normalized.slice(slash + 1);
    const bad =
      slash <= 0 ||
      /\s/.test(provider) ||
      modelId === "" ||
      /\s/.test(modelId) ||
      modelId.startsWith("/") ||
      modelId.endsWith("/") ||
      modelId.includes("//");
    if (bad) {
      throw new Error(
        `${path}: modelsByParent key '${key}' must be an exact provider/model-id; got ${JSON.stringify(key)}.`,
      );
    }
    if (Object.hasOwn(out, normalized)) {
      throw new Error(
        `${path}: modelsByParent key '${key}' duplicates '${normalized}' after normalization.`,
      );
    }
    out[normalized] = parseModels(
      inner,
      `modelsByParent.${key}`,
      path,
      additionalAgentNames,
    );
  }
  return out;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Parse the optional `concurrency` block: `{ default?, providers?, models? }`
 * with positive-integer bounds. Malformed shapes fail loudly — a silently
 * ignored limit is worse than an error.
 */
function parseConcurrency(value: unknown, path: string): ConcurrencyConfig {
  if (value === undefined) return DEFAULT_CONFIG.concurrency;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: concurrency must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const bound = (name: string, v: unknown): number => {
    if (!isPositiveInteger(v)) {
      throw new Error(
        `${path}: concurrency.${name} must be a positive integer; got ${JSON.stringify(v)}.`,
      );
    }
    return v;
  };
  const table = (name: string, v: unknown): Record<string, number> => {
    if (v === undefined) return {};
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`${path}: concurrency.${name} must be an object.`);
    }
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([key, entry]) => [
        key,
        bound(`${name}.${key}`, entry),
      ]),
    );
  };
  return {
    default:
      raw.default === undefined
        ? undefined
        : bound("default", raw.default),
    providers: table("providers", raw.providers),
    models: table("models", raw.models),
  };
}

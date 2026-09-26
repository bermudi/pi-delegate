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

export interface DelegateConfig {
  /** Global bound on simultaneously executing tasks. */
  readonly maxConcurrent: number;
  readonly concurrency: ConcurrencyConfig;
  /**
   * Per-agent model assignment: named agent (scout, coder, ...) → model
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
  /**
   * LLM-facing output bounding: over `spillThresholdChars` a settled task's
   * output spills to an owner-only temp file and only a `spillTailChars`
   * tail stays in-context (see `spill.ts`). Dispatch-scoped: tickets
   * snapshot these at creation.
   */
  readonly output: OutputBounds;
}

export const DEFAULT_CONFIG: DelegateConfig = {
  maxConcurrent: 3,
  concurrency: { default: undefined, providers: {}, models: {} },
  models: {},
  modelsByParent: {},
  stallTimeoutMs: 15 * 60 * 1000,
  telemetry: { enabled: false, dbPath: undefined },
  output: { spillThresholdChars: 8000, spillTailChars: 2000 },
};

/** A `ModelAssignment` plus the config path that produced it, for errors. */
export interface ResolvedModelAssignment extends ModelAssignment {
  /** Config path naming the winning entry (e.g. `models.scout`). */
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
    output: parseOutput(config.output, path),
  };
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
 * case-insensitive, like model references elsewhere); a key without a
 * non-empty `provider/id` shape — or one carrying a `:` — is a config
 * error, since it could never match a real model identity.
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
    if (
      normalized === "" ||
      normalized.includes(":") ||
      normalized.split("/").some((part) => part === "") ||
      !normalized.includes("/")
    ) {
      throw new Error(
        `${path}: modelsByParent key '${key}' must be an exact provider/model-id (no effort suffix); got ${JSON.stringify(key)}.`,
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

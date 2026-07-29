import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { VALID_THINKING } from "./constants.ts";

export interface ResolvedModelRequest {
  model: Model<Api> | undefined;
  /** Thinking level parsed from a Pi-style `model:level` suffix. */
  thinking?: ThinkingLevel;
}

function resolveModelReference(
  spec: string,
  registry: ModelRegistry,
): Model<Api> | undefined {
  const idx = spec.indexOf("/");
  if (idx === -1) {
    // Bare id — match against available models
    const match = registry.getAvailable().find((m) => m.id === spec);
    return match ?? undefined;
  }
  return registry.find(spec.slice(0, idx), spec.slice(idx + 1)) ?? undefined;
}

/** Resolve a model reference and an optional Pi-style thinking suffix.
 *
 * Exact model references win first so provider model IDs containing colons are
 * preserved. If no exact match exists, a final `:<thinking-level>` suffix is
 * peeled off and the base reference is resolved. This mirrors Pi's CLI model
 * syntax, including references such as `openai-codex/gpt-5.6-luna:max`. */
export function resolveModelWithThinking(
  spec: string | undefined,
  registry: ModelRegistry,
  parentModel: Model<Api> | undefined,
): ResolvedModelRequest {
  if (!spec) return { model: parentModel };

  const exact = resolveModelReference(spec, registry);
  if (exact) return { model: exact };

  const colon = spec.lastIndexOf(":");
  if (colon === -1) return { model: undefined };

  const suffix = spec.slice(colon + 1);
  if (!VALID_THINKING.has(suffix)) return { model: undefined };

  return {
    model: resolveModelReference(spec.slice(0, colon), registry),
    thinking: suffix as ThinkingLevel,
  };
}

export function resolveModel(
  spec: string | undefined,
  registry: ModelRegistry,
  parentModel: Model<Api> | undefined,
): Model<Api> | undefined {
  return resolveModelWithThinking(spec, registry, parentModel).model;
}

/** Find an available model with the same id as the given model, preferring
 *  a different provider if the original has no configured auth. */
export function findAvailableAlternative(
  model: Model<Api> | undefined,
  registry: ModelRegistry,
): Model<Api> | undefined {
  if (!model) return undefined;
  if (registry.hasConfiguredAuth(model)) return model;
  // Look for another model with the same id that DOES have auth.
  // Prefer a different provider (avoid returning the same broken model).
  return registry
    .getAvailable()
    .find((m) => m.id === model.id && m.provider !== model.provider);
}

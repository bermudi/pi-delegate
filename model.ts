import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { VALID_THINKING } from "./constants.ts";

export interface ResolvedModelRequest {
  model: Model<Api> | undefined;
  /** Pi-style `:<thinking-level>` suffix stripped to make the reference
   *  resolve. The caller may use it as a last-resort thinking default. */
  strippedSuffix?: ThinkingLevel;
}

function resolveModelReference(
  spec: string,
  registry: ModelRegistry,
): Model<Api> | undefined {
  // Pi's own reference grammar is case-insensitive (model-resolver.ts
  // lowercases provider and id on every match), and callers echo model
  // strings in whatever casing they saw — e.g. a task model of
  // `modal/zai-org/glm-5.3-flash:max` against a registry id of
  // `zai-org/GLM-5.3-Flash`. Matching stricter than pi about case rejects
  // references pi itself accepts. This is still exact matching: no fuzzy,
  // partial, or fallback-model resolution — a typo must fail loudly rather
  // than silently select a different model.
  const target = spec.toLowerCase();
  const idx = spec.indexOf("/");
  if (idx === -1) {
    // Bare id — match against available models
    const match = registry
      .getAvailable()
      .find((m) => m.id.toLowerCase() === target);
    return match ?? undefined;
  }
  const provider = spec.slice(0, idx);
  const id = spec.slice(idx + 1);
  // Exact match first (preserves resolution of unauthenticated models via
  // find), then a case-insensitive scan over the same all-models universe
  // registry.find() searches.
  const exact = registry.find(provider, id);
  if (exact) return exact;
  const providerLower = provider.toLowerCase();
  const idLower = id.toLowerCase();
  const models = registry.getAll();
  const splitMatch = models.find(
    (m) =>
      m.provider.toLowerCase() === providerLower &&
      m.id.toLowerCase() === idLower,
  );
  if (splitMatch) return splitMatch;
  // Pi-grammar fallback: model ids may themselves contain slashes
  // (openrouter-style, or namespaced ids like `zai-org/GLM-5.3-Flash`). When
  // the provider-split reading matches nothing, try the whole spec as an id.
  // The split reading wins when the prefix is a real provider, matching pi's
  // own preference order.
  return models.find((m) => m.id.toLowerCase() === target) ?? undefined;
}

/** Resolve a model reference, tolerating a Pi-style `:<thinking-level>`
 * suffix.
 *
 * Exact model references win first so provider model IDs containing colons are
 * preserved. If no exact match exists, a final `:<thinking-level>` suffix is
 * stripped and the base reference is resolved — models learned this syntax
 * from Pi's CLI (e.g. `openai-codex/gpt-5.6-luna:max`) and keep emitting it,
 * so hard-failing the whole call over it is worse than tolerating it. The
 * suffix is returned separately so task resolution can use it as a
 * last-resort default while keeping explicit `thinking` authoritative. */
export function resolveModelRequest(
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

  const model = resolveModelReference(spec.slice(0, colon), registry);
  return model
    ? { model, strippedSuffix: suffix as ThinkingLevel }
    : { model: undefined };
}

/** Resolve a model spec and return only the selected model instance. */
export function resolveModel(
  spec: string | undefined,
  registry: ModelRegistry,
  parentModel: Model<Api> | undefined,
): Model<Api> | undefined {
  return resolveModelRequest(spec, registry, parentModel).model;
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
    .find(
      (m) =>
        m.id === model.id &&
        m.provider !== model.provider &&
        registry.hasConfiguredAuth(m),
    );
}

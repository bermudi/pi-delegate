import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { VALID_THINKING } from "./constants.ts";

export interface ResolvedModelRequest {
  model: Model<Api> | undefined;
  /** Pi-style `:<thinking-level>` suffix stripped to make the reference
   *  resolve. Reported so the caller can warn — it is NOT honored as a
   *  thinking level; the task's `thinking` field is the only thinking input. */
  strippedSuffix?: ThinkingLevel;
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

/** Resolve a model reference, tolerating a Pi-style `:<thinking-level>`
 * suffix.
 *
 * Exact model references win first so provider model IDs containing colons are
 * preserved. If no exact match exists, a final `:<thinking-level>` suffix is
 * stripped and the base reference is resolved — models learned this syntax
 * from Pi's CLI (e.g. `openai-codex/gpt-5.6-luna:max`) and keep emitting it,
 * so hard-failing the whole call over it is worse than tolerating it. The
 * suffix is deliberately NOT fed into thinking resolution: a single knob
 * (the `thinking` field) beats two knobs with a silent precedence rule. */
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
    .find((m) => m.id === model.id && m.provider !== model.provider);
}

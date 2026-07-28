import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export function resolveModel(
  spec: string | undefined,
  registry: ModelRegistry,
  parentModel: Model<Api> | undefined,
): Model<Api> | undefined {
  if (!spec) return parentModel;
  const idx = spec.indexOf("/");
  if (idx === -1) {
    // Bare id — match against available models
    const match = registry.getAvailable().find((m) => m.id === spec);
    return match ?? undefined;
  }
  return registry.find(spec.slice(0, idx), spec.slice(idx + 1)) ?? undefined;
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

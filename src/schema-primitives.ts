/**
 * TypeBox primitives that are literally the same contract in the strict
 * emitted-details schemas (details.ts — SPEC v3 "Observability", issue
 * #51) and the tolerant ticket-journal record schemas
 * (ticket-journal.ts).
 *
 * Shared here: the enumeration value sets and the provider-emitted
 * usage shape. NOT shared, by design: container strictness. details
 * objects carry `additionalProperties: false` — the emitted boundary
 * must reject stray internal fields like `durationMs` (#127) — while
 * journal records stay tolerant `Type.Object`s so records written by
 * older versions keep parsing (additive evolution; #62/#123/#127). The
 * journal also admits `durationMs` on outcomes and mutable-array
 * `Static` types; neither may leak into the emitted schemas.
 *
 * The value arrays feed different constructors per site — details
 * spells each enum as a JSON-schema `enum` via `literalUnion`, the
 * journal keeps its historical `Type.Union` of literals — but the
 * accepted set is one contract, defined once here and typed against the
 * canonical unions in types.ts.
 */
import { Type } from "typebox";
import type {
  IntegrationStatus,
  TaskStatus,
  TaskVerdict,
} from "./types.ts";

/** Task outcome statuses — one set, emitted and journaled alike. */
export const TASK_STATUS_VALUES = [
  "ok",
  "failed",
  "cancelled",
  "blocked",
  "interrupted",
  "budget-exhausted",
] as const satisfies readonly TaskStatus[];

/** Integration outcomes — one set, emitted and journaled alike. */
export const TASK_INTEGRATION_STATUS_VALUES = [
  "applied_unverified",
  "conflict",
  "retained",
  "no_changes",
  "discarded",
  "apply_failed",
] as const satisfies readonly IntegrationStatus[];

/** Verifier verdicts (#49) — one set, emitted and journaled alike. */
export const TASK_VERDICT_VALUES = [
  "PASS",
  "FAIL",
  "AMBIGUOUS",
] as const satisfies readonly TaskVerdict[];

/** pi-ai `Usage`, mirrored — a provider-emitted shape, pinned loosely. */
export const usageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});

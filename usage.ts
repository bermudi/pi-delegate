import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { TaskResult } from "./types.ts";

/** Snapshot of the cumulative session usage fields we read for delta accounting. */
export interface SessionUsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Return a zero-valued Usage suitable for an action that made no model call. */
export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

/**
 * Read cumulative provider usage from a live AgentSession.
 *
 * `getSessionStats()` covers history that has been compacted away (and, on
 * newer Pi hosts, compaction/branch-summary calls), so this is the right
 * snapshot for pooled or resumed sessions — reading `session.messages` alone
 * would under-count once a compaction boundary is crossed.
 */
export function snapshotSessionUsage(
  session: Pick<AgentSession, "getSessionStats">,
): SessionUsageSnapshot {
  const stats = session.getSessionStats();
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    cost: stats.cost,
  };
}

function delta(after: number, before: number): number {
  // A session can be replaced/branched by host code. Never report a negative
  // billable amount if cumulative stats move backwards between snapshots.
  return Math.max(0, after - before);
}

/** Convert a cumulative-snapshot delta into Pi's nested-tool Usage shape. */
export function usageDelta(
  before: SessionUsageSnapshot,
  after: SessionUsageSnapshot,
): Usage {
  const input = delta(after.input, before.input);
  const output = delta(after.output, before.output);
  const cacheRead = delta(after.cacheRead, before.cacheRead);
  const cacheWrite = delta(after.cacheWrite, before.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    // SessionStats exposes the aggregate cost only; Pi's session/footer
    // accounting reads cost.total for nested tool usage. The component fields
    // stay zero rather than inventing a provider-specific split.
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: delta(after.cost, before.cost),
    },
  };
}

/** Add two Usage values, preserving optional provider breakdowns when present. */
export function addUsage(left: Usage, right: Usage): Usage {
  const cacheWrite1h =
    left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
      ? (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0)
      : undefined;
  const reasoning =
    left.reasoning !== undefined || right.reasoning !== undefined
      ? (left.reasoning ?? 0) + (right.reasoning ?? 0)
      : undefined;

  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

/** Sum optional per-task usage without making callers manufacture zero values. */
export function sumUsage(usages: readonly (Usage | undefined)[]): Usage {
  return usages.reduce<Usage>(
    (total, usage) => (usage ? addUsage(total, usage) : total),
    emptyUsage(),
  );
}

/** Aggregate the completed result rows used by async call telemetry. */
export function aggregateTaskResults(
  results: readonly (TaskResult | undefined)[],
): { totalTokens: number; totalCost: number } {
  return results
    .filter(
      (result): result is TaskResult =>
        result !== undefined && "touchedFiles" in result,
    )
    .reduce(
      (total, result) => ({
        totalTokens: total.totalTokens + result.tokens,
        totalCost: total.totalCost + (result.usage?.cost?.total ?? 0),
      }),
      { totalTokens: 0, totalCost: 0 },
    );
}

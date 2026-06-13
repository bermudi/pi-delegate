import type { Agent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { POOL_TTL_MS } from "./constants.ts";
import { fmtDuration, fmtTokens, shortenPath } from "./format.ts";
import type { SessionManagerLike } from "./types.ts";

interface PooledAgent {
  agent: Agent;
  sessionManager: SessionManagerLike;
  sessionFile: string;
  /** Config frozen at creation time — used for validation on reuse. */
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  };
  lastUsed: number;
  createdAt: number;
  /** Total tokens consumed across all prompts on this agent. */
  totalTokens: number;
  /** Number of prompts sent to this agent. */
  promptCount: number;
}

/** Module-level pool — lives for the entire pi session. */
export const agentPool = new Map<string, PooledAgent>();

/** Per-session lock — serializes access to a pooled agent so concurrent
 *  delegate calls with the same sessionId queue instead of interleaving. */
const sessionLocks = new Map<string, Promise<void>>();

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionLocks.get(sessionId);
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  // Install ourselves BEFORE awaiting — so the next waiter queues behind us,
  // not behind the same predecessor we're waiting on.
  sessionLocks.set(sessionId, promise);
  try {
    if (prev) await prev;
    return await fn();
  } finally {
    resolve();
    // Only clean up if no one queued behind us (our promise is still current).
    // If a waiter installed their own promise, leave it — deleting would
    // clobber their map entry and break the chain.
    if (sessionLocks.get(sessionId) === promise) {
      sessionLocks.delete(sessionId);
    }
  }
}

/** Close and remove a pooled agent. */
export function closePooledAgent(sessionId: string): boolean {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return false;
  try {
    pooled.agent.abort();
  } catch {
    /* best effort */
  }
  agentPool.delete(sessionId);
  return true;
}

/** Evict idle agents that exceeded the TTL. */
export function sweepPool(): void {
  const now = Date.now();
  for (const [id, pooled] of agentPool) {
    // Skip sessions that are actively locked — closing them would abort the
    // in-flight prompt. The wider session lock in runResolvedTask covers
    // first-use, resume, and pool-hit runs, so any locked session has live work.
    if (sessionLocks.has(id)) continue;
    if (now - pooled.lastUsed > POOL_TTL_MS) {
      closePooledAgent(id);
    }
  }
}

/** List active pooled agents for help/status display. */
export function listPooledAgents(): string[] {
  sweepPool();
  const lines: string[] = [];
  if (agentPool.size === 0) return ["_(no active sessions)_"];
  for (const [id, pooled] of agentPool) {
    const idle = fmtDuration(Date.now() - pooled.lastUsed);
    const age = fmtDuration(Date.now() - pooled.createdAt);
    lines.push(
      `- **${id}** · ${pooled.promptCount} prompts · ${fmtTokens(pooled.totalTokens)} tokens · idle ${idle} · age ${age} · ${shortenPath(pooled.sessionFile)}`,
    );
  }
  return lines;
}

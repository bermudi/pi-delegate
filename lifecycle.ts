import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentProgressUpdate, AgentRunConfig, AcquiredSession, ResolvedTask, TaskProgress, TaskResult, TaskRunEnv, SessionManagerLike } from "./types.ts";
import { agentPool, closePooledAgent, listPooledAgents, withSessionLock } from "./pool.ts";
import { isSessionBusy } from "./tickets.ts";
import { rehydrateAgent, createSubagentSessionManager, setParentSession } from "./sessions.ts";
import { createAgent, runAgent } from "./runner.ts";
import { fmtDuration } from "./format.ts";
import { resolveCwd } from "./utils.ts";

/** Build a failed TaskResult. Used for early-failure paths (abort, busy, validation). */
function failTask(
  task: ResolvedTask,
  error: string,
  sessionFile?: string,
): TaskResult {
  return {
    agent: task.agentName,
    output: "",
    error,
    durationMs: 0,
    tokens: 0,
    sessionFile,
    touchedFiles: [],
  };
}

/** Build a successful TaskResult for session-management actions (close/list).
 *  Pass elapsedMs to record wall time since delegate started (matches the live progress UI). */
function completeSessionAction(
  task: ResolvedTask,
  output: string,
  elapsedMs?: number,
): TaskResult {
  return {
    agent: task.agentName,
    output,
    durationMs: elapsedMs ?? 0,
    tokens: 0,
    sessionFile: undefined,
    touchedFiles: [],
  };
}

/** Mirror a progress update from runAgent into a TaskProgress row. */
export function updateProgressFromRun(
  p: TaskProgress,
  u: AgentProgressUpdate,
): void {
  p.tokens = u.tokens;
  p.toolUses = u.toolUses;
  p.durationMs = u.durationMs;
  p.lastActivityAt = u.lastActivityAt;
  p.activities = u.activities;
}

/** Mirror a completed TaskResult into a TaskProgress row (status/duration/error). */
function updateProgressFromResult(p: TaskProgress, r: TaskResult): void {
  p.status = r.error ? "failed" : "done";
  p.durationMs = r.durationMs;
  p.tokens = r.tokens;
  p.error = r.error;
}

/** Apply a TaskResult to progress and notify the env (sync fires onUpdate).
 *  Used at every return point in runResolvedTask — mirrors the old fire() pattern
 *  that the duplicated sync/async bodies used after every early-return. */
function finishTask(
  env: TaskRunEnv,
  p: TaskProgress,
  r: TaskResult,
): TaskResult {
  updateProgressFromResult(p, r);
  env.onStatusChange?.();
  return r;
}

/** Resolve the agent + session for a task. Single source of truth for pool, resume, and miss logic. */
async function acquireAgentSession(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
): Promise<AcquiredSession | { error: TaskResult }> {
  let agent: Agent | undefined;
  let sessionManager: SessionManagerLike | undefined;
  let sessionFile: string | undefined;
  let isPoolHit = false;
  let shouldPoolAfter = false;
  let syncInserted = false;

  if (task.sessionId) {
    const pooled = agentPool.get(task.sessionId);
    if (pooled) {
      // Pool hit — validate frozen config matches the new task's request.
      const frozen = pooled.config;
      const mismatches: string[] = [];
      if (frozen.cwd !== task.cwd)
        mismatches.push(`cwd: '${frozen.cwd}' vs '${task.cwd}'`);
      if (frozen.thinking !== task.thinking)
        mismatches.push(`thinking: '${frozen.thinking}' vs '${task.thinking}'`);
      const frozenToolSet = [...frozen.tools].sort().join(",");
      const newToolSet = [...task.tools].sort().join(",");
      if (frozenToolSet !== newToolSet)
        mismatches.push(`tools: [${frozenToolSet}] vs [${newToolSet}]`);
      if (mismatches.length) {
        return {
          error: failTask(
            task,
            `Session '${task.sessionId}' config mismatch. Close and recreate: ${mismatches.join("; ")}`,
          ),
        };
      }
      agent = pooled.agent;
      sessionManager = pooled.sessionManager;
      sessionFile = pooled.sessionFile;
      pooled.lastUsed = Date.now();
      p.model = frozen.model.id;
      isPoolHit = true;
    } else {
      // Pool miss.
      if (task.resumeFrom) {
        // Defer to the resume block below — creating a session here would orphan an empty .jsonl.
        shouldPoolAfter = true;
      } else {
        const session = createSubagentSessionManager(
          env.parentSessionManager,
          task.cwd,
        );
        sessionManager = session?.manager;
        sessionFile = session?.file;

        if (sessionFile) {
          const rehydrated = rehydrateAgent(
            sessionFile,
            {
              systemPrompt: task.systemPrompt,
              model: task.model,
              thinking: task.thinking,
              tools: task.tools,
              cwd: task.cwd,
            },
            env.modelRegistry,
          );
          if (rehydrated) {
            agent = rehydrated.agent;
            sessionManager = rehydrated.sessionManager;
          }
        }
        if (!agent) {
          agent = createAgent(
            {
              systemPrompt: task.systemPrompt,
              model: task.model,
              thinking: task.thinking,
              tools: task.tools,
              cwd: task.cwd,
            },
            env.modelRegistry,
          );
        }

        // Synchronous pool insertion — close the race window where a concurrent
        // task with the same sessionId (across tickets) could also pass the busy
        // guard and create a second agent. By claiming the sessionId now, a
        // second task's isSessionBusy() will see this one and fail.
        // The drift fix is preserved: isPoolHit stays false, so the run still
        // retries on transient errors. If the run fails, commitPoolCleanup
        // removes the empty entry so a retry starts fresh.
        if (task.sessionId && sessionManager && sessionFile) {
          agentPool.set(task.sessionId, {
            agent: agent!,
            sessionManager,
            sessionFile,
            config: {
              systemPrompt: task.systemPrompt,
              model: task.model,
              thinking: task.thinking,
              tools: task.tools,
              cwd: task.cwd,
            },
            lastUsed: Date.now(),
            createdAt: Date.now(),
            totalTokens: 0,
            promptCount: 0,
          });
          syncInserted = true;
        } else {
          shouldPoolAfter = true;
        }
      }
    }
  }

  // Resume from a previous session file.
  if (task.resumeFrom) {
    if (isPoolHit) {
      return {
        error: failTask(
          task,
          `resumeFrom conflicts with active sessionId '${task.sessionId}'. The pooled agent has its own accumulated context. Close the session first if you want to resume from a different point.`,
          sessionFile,
        ),
      };
    }
    const resolvedPath = resolveCwd(task.resumeFrom);
    if (!fs.existsSync(resolvedPath)) {
      return {
        error: failTask(
          task,
          `resumeFrom: file not found: ${resolvedPath}`,
          resolvedPath,
        ),
      };
    }
    const rehydrated = rehydrateAgent(
      resolvedPath,
      {
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.tools,
        cwd: task.cwd,
      },
      env.modelRegistry,
    );
    if (!rehydrated) {
      return {
        error: failTask(
          task,
          `resumeFrom: empty or corrupt session: ${resolvedPath}`,
          resolvedPath,
        ),
      };
    }
    agent = rehydrated.agent;
    sessionManager = rehydrated.sessionManager;
    sessionFile = resolvedPath;

    // Link resumed session to parent for /resume discoverability.
    const parentFile = (
      env.parentSessionManager as
        | { getSessionFile?(): string | undefined }
        | undefined
    )?.getSessionFile?.();
    if (parentFile) {
      setParentSession(
        rehydrated.sessionManager as unknown as SessionManager,
        parentFile,
      );
    }
  }

  // Fresh task (no sessionId, no resumeFrom) — create session + agent.
  if (!agent) {
    const fresh = createSubagentSessionManager(env.parentSessionManager, task.cwd);
    sessionManager = fresh?.manager;
    sessionFile = fresh?.file;
    agent = createAgent(
      {
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.tools,
        cwd: task.cwd,
      },
      env.modelRegistry,
    );
  }

  // At this point sessionManager/sessionFile are set for all paths except
  // pool-miss-with-resumeFrom (which defers session creation). The agent
  // is guaranteed to exist. Label new sessions.
  if (sessionManager && !isPoolHit && !task.resumeFrom) {
    const label = `⎇ delegate · ${task.agentName}`;
    sessionManager.appendSessionInfo?.(label);
  }

  if (!agent) {
    // Defensive: acquireAgentSession should always produce an agent for run tasks.
    return { error: failTask(task, "Internal: no agent acquired") };
  }

  return {
    agent,
    sessionManager,
    sessionFile,
    isPoolHit,
    shouldPoolAfter,
    syncInserted,
  };
}

/** Insert a freshly-run agent into the pool. Called after a successful run for a new pooled session. */
function commitPoolInsert(
  sessionId: string,
  task: ResolvedTask,
  acquired: AcquiredSession,
  result: { tokens: number },
): void {
  if (!acquired.sessionManager || !acquired.sessionFile) return;
  agentPool.set(sessionId, {
    agent: acquired.agent,
    sessionManager: acquired.sessionManager,
    sessionFile: acquired.sessionFile,
    config: {
      systemPrompt: task.systemPrompt,
      model: task.model,
      thinking: task.thinking,
      tools: task.tools,
      cwd: task.cwd,
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    totalTokens: result.tokens,
    promptCount: 1,
  });
}

/** Update pool stats for a subsequent prompt on an existing pooled session. */
function commitPoolStats(
  sessionId: string,
  result: { tokens: number },
): void {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return;
  pooled.lastUsed = Date.now();
  pooled.totalTokens += result.tokens;
  pooled.promptCount++;
}

/** Remove a synchronously-inserted empty agent from the pool if it's still ours.
 *  Called after a failed run for a fresh pooled session — we claimed the sessionId
 *  to close the race window, but the run failed, so the empty entry is dead weight.
 *  If another task already claimed the slot (pool entry is now a different agent),
 *  leave it alone. */
export function commitPoolCleanup(sessionId: string, acquiredAgent: Agent): void {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return;
  if (pooled.agent !== acquiredAgent) return; // Another task already claimed/replaced it.
  agentPool.delete(sessionId);
}

/** Run a single resolved task. Single source of truth for the per-task lifecycle.
 *  Used by both sync (params.async === false) and async (params.async === true) paths.
 *  When task.sessionId is set, the entire acquire/run/close lifecycle runs under
 *  a per-session mutex so concurrent tasks with the same sessionId serialize
 *  cleanly. The lock also covers action='close' and the early-busy/abort paths. */
export async function runResolvedTask(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  taskIndex: number,
): Promise<TaskResult> {
  if (task.sessionId) {
    return withSessionLock(task.sessionId, () =>
      runResolvedTaskUnlocked(env, task, p, taskIndex),
    );
  }
  return runResolvedTaskUnlocked(env, task, p, taskIndex);
}

async function runResolvedTaskUnlocked(
  env: TaskRunEnv,
  task: ResolvedTask,
  p: TaskProgress,
  taskIndex: number,
): Promise<TaskResult> {
  try {
    // ── Aborted before we started? ───────────────────────────────────
    if (env.signal?.aborted) {
      return finishTask(env, p, failTask(task, "Aborted"));
    }

    // ── Session busy guard (defense-in-depth) ────────────────────────
    // Primary validation is in execute() before ticket creation.
    // This catches edge cases where validation missed a conflict.
    if (task.sessionId) {
      const busyTicketId = isSessionBusy(task.sessionId);
      if (busyTicketId && busyTicketId !== env.ticketId) {
        const msg = `Session '${task.sessionId}' is already in use by ticket ${busyTicketId}. Each session can only handle one task at a time.`;
        return finishTask(env, p, failTask(task, msg));
      }
    }

    p.status = "running";
    p.model = task.model?.id;

    // ── Session action handling ───────────────────────────────────────
    if (task.action === "close") {
      if (!task.sessionId) {
        return finishTask(env, p, failTask(task, "action='close' requires sessionId."));
      }
      const closed = closePooledAgent(task.sessionId);
      return finishTask(
        env,
        p,
        completeSessionAction(
          task,
          closed
            ? `Session '${task.sessionId}' closed.`
            : `Session '${task.sessionId}' not found.`,
          Date.now() - env.delegateStartedAt,
        ),
      );
    }

    if (task.action === "list") {
      return finishTask(
        env,
        p,
        completeSessionAction(
          task,
          `Active sessions:\n${listPooledAgents().join("\n")}`,
          Date.now() - env.delegateStartedAt,
        ),
      );
    }

    // ── Pool / resume / fresh-agent resolution ────────────────────────
    const acquired = await acquireAgentSession(env, task, p);
    if ("error" in acquired) {
      return finishTask(env, p, acquired.error);
    }

    // ── Run the agent ─────────────────────────────────────────────────
    const doRun = async (): Promise<TaskResult> => {
      const config: AgentRunConfig = {
        systemPrompt: task.systemPrompt,
        model: task.model,
        thinking: task.thinking,
        tools: task.tools,
        cwd: task.cwd,
      };
      try {
        const r = await runAgent(
          config,
          task.prompt,
          env.modelRegistry,
          env.signal,
          (u) => env.onProgress(p, u),
          acquired.sessionManager,
          undefined, // maxRetries
          2000, // retryBaseMs
          acquired.agent,
          // allowRetry: pooled agents carry accumulated state — retrying is unsafe.
          // Fresh agents and resumed sessions are safe to retry.
          !acquired.isPoolHit,
          taskIndex,
        );

        // Pool bookkeeping.
        if (task.sessionId) {
          if (r.error && acquired.syncInserted) {
            // Failed first run with a synchronously-claimed sessionId: clean up
            // the empty entry so a retry can try fresh.
            commitPoolCleanup(task.sessionId, acquired.agent);
          } else if (!r.error) {
            if (acquired.shouldPoolAfter) {
              commitPoolInsert(task.sessionId, task, acquired, r);
            } else {
              // Pool hit OR sync-inserted: agent is already in pool, just bump stats.
              commitPoolStats(task.sessionId, r);
            }
          }
        }

        return {
          agent: task.agentName,
          output: r.output,
          error: r.error,
          durationMs: r.durationMs,
          tokens: r.tokens,
          sessionFile: acquired.sessionFile,
          touchedFiles: r.touchedFiles,
        };
      } catch (err) {
        // Abnormal error (e.g., runAgent threw rather than returning r.error).
        // Clean up the sync-inserted entry if it's still ours, then re-throw
        // for the outer catch to convert to a TaskResult.
        if (acquired.syncInserted && task.sessionId) {
          commitPoolCleanup(task.sessionId, acquired.agent);
        }
        throw err;
      }
    };

    // The session lock is now taken at the top of runResolvedTask (covers the
    // full acquire/run/close lifecycle), so doRun executes serially per sessionId
    // without needing an inner lock here.
    const result = await doRun();
    return finishTask(env, p, result);
  } catch (err) {
    // If we synchronously claimed a sessionId before the error, clean it up.
    return finishTask(
      env,
      p,
      failTask(task, err instanceof Error ? err.message : String(err)),
    );
  }
}

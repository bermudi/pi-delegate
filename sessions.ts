import * as path from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { SessionManager, type ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AgentRunConfig, SessionManagerLike } from "./types.ts";
import { createAgent } from "./runner.ts";

export function rehydrateAgent(
  sessionFile: string,
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  },
  modelRegistry: ModelRegistry,
): { agent: Agent; sessionManager: SessionManagerLike } | null {
  try {
    const sm = (
      SessionManager as unknown as { open(p: string): SessionManager }
    ).open(sessionFile);
    const ctx = sm.buildSessionContext();
    if (!ctx.messages.length) return null;

    const agent = createAgent(config, modelRegistry, ctx.messages);

    return { agent, sessionManager: sm as unknown as SessionManagerLike };
  } catch {
    return null;
  }
}

export function setParentSession(sm: SessionManager, parentPath: string): void {
  const header =
    // @ts-expect-error — accessing private fileEntries to mutate header's parentSession
    (sm as { fileEntries: Array<{ type: string; parentSession?: string }> })
      .fileEntries[0];
  if (header && header.type === "session") {
    header.parentSession = parentPath;
  }
}

/**
 * Create a session manager for a subagent run.
 *
 * Always creates a standalone session file in the target cwd.
 * Sets `parentSession` in the header so subagent work is discoverable
 * as a child of the parent session in `/resume`.
 */
export function createSubagentSessionManager(
  parentSessionManager: unknown,
  cwd: string,
): { manager: SessionManagerLike; file: string } | undefined {
  // Resolve parent session file path for linking.
  const parentFile = (
    parentSessionManager as
      | { getSessionFile?(): string | undefined }
      | undefined
  )?.getSessionFile?.();

  // Always persist subagent work so the main agent can search it later.
  const sm = SessionManager.create(cwd);
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) return undefined;

  // Link to parent session so subagent appears as a child in /resume.
  if (parentFile) {
    setParentSession(sm, parentFile);
  }

  return { manager: sm as unknown as SessionManagerLike, file: sessionFile };
}

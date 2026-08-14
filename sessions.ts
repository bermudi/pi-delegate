import * as fs from "node:fs";
import { join } from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Persistent storage for delegate-only conversations. */
export function getDelegateSessionDir(): string {
  return join(getAgentDir(), "delegate-sessions");
}

/**
 * Create a session manager for a subagent run.
 *
 * Delegate sessions are deliberately standalone and live in their own
 * directory. They are not attached to the parent's session tree.
 */
export function createSubagentSessionManager(
  cwd: string,
): { manager: SessionManager; file: string } | undefined {
  // Always persist subagent work separately from the parent's session tree.
  const sm = SessionManager.create(cwd, getDelegateSessionDir());
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) return undefined;

  return { manager: sm, file: sessionFile };
}

/**
 * Force-flush a session's header (and any buffered entries) to disk.
 *
 * pi-coding-agent's SessionManager intentionally does not write the `.jsonl`
 * until the first assistant message lands (its `_persist()` gates the first
 * write behind an "assistant message exists" check — a documented contract).
 * When a subagent's *first* model call dies before producing one — e.g. a
 * Cloudflare 524 gateway timeout — no file is ever created, yet the planned
 * path is already recorded. That leaves delegate reporting a sessionFile that
 * doesn't exist, which in turn leads the parent to attempt (and fail) a
 * `resumeFrom` against a nonexistent file.
 *
 * This flushes via the upstream `_rewriteFile()` seam — the same private method
 * upstream itself calls to recover from empty/corrupt session files — so the
 * reported path becomes real and resumable. Idempotent: no-op when the file
 * already exists or the session manager has no `sessionFile`.
 *
 * Returns true when a resumable file exists on return (whether this call wrote
 * it or it pre-existed), false otherwise.
 */
export function persistSessionHeader(sm: unknown): boolean {
  const inner = sm as {
    getSessionFile?: () => string | undefined;
    _rewriteFile?: () => void;
  };
  const file = inner.getSessionFile?.();
  if (!file) return false;
  if (fs.existsSync(file)) return true;
  try {
    inner._rewriteFile?.();
  } catch {
    /* best effort — caller falls back to reporting no sessionFile */
  }
  return fs.existsSync(file);
}

import * as fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Link a subagent session to its parent and persist the header when possible. */
export function setParentSession(sm: SessionManager, parentPath: string): void {
  const inner = sm as unknown as {
    fileEntries: Array<{ type: string; parentSession?: string }>;
    getSessionFile?: () => string | undefined;
    _rewriteFile?: () => void;
  };
  const header = inner.fileEntries[0];
  if (header && header.type === "session") {
    header.parentSession = parentPath;
    // For a *resumed* session the file already exists on disk and the manager
    // is flushed (SessionManager.open/setSessionFile sets flushed=true). The
    // in-memory header mutation above is otherwise lost: upstream _persist()
    // only *appends* new entries once flushed — it never rewrites the header.
    // So a resumeFrom session would never surface as a child in /resume despite
    // the link being set in memory. Rewrite the whole file (header + entries)
    // so the parentSession field is actually persisted. Fresh sessions skip
    // this (file doesn't exist yet); their first _persist() writes the mutated
    // header along with the rest, and rewriting early would trip the
    // duplicate-header bug in _persist()'s not-yet-flushed path.
    const file = inner.getSessionFile?.();
    if (file && fs.existsSync(file)) {
      try {
        inner._rewriteFile?.();
      } catch {
        /* best effort — link stays in-memory; not fatal */
      }
    }
  }
}

/**
 * Create a session manager for a subagent run.
 *
 * Always creates a standalone session file in the target cwd.
 * Sets `parentSession` in the header so subagent work is discoverable
 * as a child of the parent session in `/resume`.
 *
 * Returns the concrete `SessionManager` (ready to hand to `createAgentSession`)
 * and its file path (for result reporting + pool bookkeeping).
 */
export function createSubagentSessionManager(
  parentSessionManager: unknown,
  cwd: string,
): { manager: SessionManager; file: string } | undefined {
  // Resolve parent session file path for linking.
  const parentFile = (
    parentSessionManager as
      { getSessionFile?(): string | undefined } | undefined
  )?.getSessionFile?.();

  // Always persist subagent work so the main agent can search it later.
  const sm = SessionManager.create(cwd);
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) return undefined;

  // Link to parent session so subagent appears as a child in /resume.
  if (parentFile) {
    setParentSession(sm, parentFile);
  }

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

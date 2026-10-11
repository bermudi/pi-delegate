import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  ModelRuntime,
  type ExtensionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

/**
 * The parent session's ModelRuntime. `ExtensionContext` exposes only the
 * ModelRegistry facade; the wrapped runtime is the same object the parent
 * streams through, and subagents must share it so runtime-registered
 * providers (and their auth) apply to child sessions. The field is
 * TypeScript-private; the guard proves the grabbed value is the real
 * `ModelRuntime` class — not merely present — so an upstream reshuffle
 * fails loudly here instead of mis-wiring child sessions. Tracked upstream
 * as earendil-works/pi#8791 (expose the model runtime to extensions); when
 * it lands, delete the grab. Patching pi-coding-agent locally via
 * patchedDependencies was deliberately rejected: patch rot on every Pi
 * release outweighs one loud, contained failure.
 *
 * Failure policy: fail dispatch loudly. The runtime is a hard dispatch
 * prerequisite — an unrecognized value rejects the dispatch rather than
 * falling back to a fresh ModelRuntime, which would silently drop the
 * parent's registered providers and auth.
 */
export function parentModelRuntime(ctx: ExtensionContext): ModelRuntime {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown })
    .runtime;
  if (!(runtime instanceof ModelRuntime)) {
    throw new Error(
      "delegate cannot reach the parent session's model runtime; subagent dispatch is unavailable.",
    );
  }
  return runtime;
}

interface SessionFileAccess {
  getSessionFile(): string | undefined;
  setSessionFile(file: string): void;
}

export function ensureSessionTranscript(
  sessionManager: SessionManager,
): string {
  const access = sessionManager as unknown as SessionFileAccess & {
    _rewriteFile?: unknown;
  };
  const file = access.getSessionFile();
  if (typeof file !== "string" || file === "") {
    throw new Error(
      "delegate cannot persist the session transcript: the host session manager exposes no file-backed session path (unsupported host capability)",
    );
  }
  const created = !existsSync(file);
  if (created && typeof access._rewriteFile !== "function") {
    throw new Error(
      "delegate cannot persist the session transcript before its first turn: this Pi's SessionManager lacks the header-write capability (unsupported host capability)",
    );
  }
  try {
    if (created) {
      (access._rewriteFile as () => void).call(sessionManager);
    }
    if (!statSync(file).isFile()) {
      throw new Error(
        `the claimed session transcript ${file} is not a regular file`,
      );
    }
    access.setSessionFile(file);
    if (created) {
      chmodSync(file, 0o600);
    }
    let fd: number | undefined;
    let dirFd: number | undefined;
    try {
      fd = openSync(file, "r");
      fsyncSync(fd);
      // Windows cannot open a directory handle for fsync.
      if (process.platform !== "win32") {
        dirFd = openSync(dirname(file), "r");
        fsyncSync(dirFd);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (dirFd !== undefined) closeSync(dirFd);
    }
  } catch (error) {
    throw new Error(
      `persisting the claimed session transcript ${file} failed`,
      { cause: error },
    );
  }
  return file;
}

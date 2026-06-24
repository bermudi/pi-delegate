import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { persistSessionHeader } from "./sessions.ts";

/**
 * persistSessionHeader force-flushes a session's header to disk so a failed
 * subagent run still leaves a resumable .jsonl behind. These tests pin the
 * behavior using a fake SessionManager that mimics the upstream in-memory
 * contract (path computed eagerly, file written only when _rewriteFile fires).
 */

/** Build a fake SM whose _rewriteFile writes a minimal session header line. */
function fakeSessionManager(sessionFile: string, headerId = "test-session-id") {
  return {
    sessionFile,
    getSessionFile: () => sessionFile,
    // Mimic upstream _rewriteFile: write every buffered entry, newline-delimited.
    _rewriteFile() {
      const header = {
        type: "session",
        version: 3,
        id: headerId,
        timestamp: new Date().toISOString(),
        cwd: os.tmpdir(),
      };
      fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
    },
  };
}

describe("persistSessionHeader", () => {
  test("force-writes the header when the file does not yet exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-persist-"));
    const sessionFile = path.join(dir, "2026-01-01T00-00-00Z_abc.jsonl");
    try {
      expect(fs.existsSync(sessionFile)).toBe(false);

      const ok = persistSessionHeader(fakeSessionManager(sessionFile));

      expect(ok).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(true);
      // Header line is valid JSON with type "session".
      const line = fs.readFileSync(sessionFile, "utf8").trim();
      const parsed = JSON.parse(line);
      expect(parsed.type).toBe("session");
      expect(parsed.id).toBe("test-session-id");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — second call is a no-op when the file already exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-persist-"));
    const sessionFile = path.join(dir, "2026-01-01T00-00-00Z_def.jsonl");
    let rewriteCalls = 0;
    try {
      const sm = fakeSessionManager(sessionFile);
      const countingSm = {
        ...sm,
        _rewriteFile() {
          rewriteCalls++;
          sm._rewriteFile();
        },
      };

      expect(persistSessionHeader(countingSm)).toBe(true);
      expect(rewriteCalls).toBe(1);

      // Second call: file now exists, so _rewriteFile must NOT fire.
      expect(persistSessionHeader(countingSm)).toBe(true);
      expect(rewriteCalls).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns false when the session manager has no sessionFile", () => {
    const sm = {
      getSessionFile: () => undefined,
      _rewriteFile: () => {
        throw new Error("must not be called");
      },
    };
    expect(persistSessionHeader(sm)).toBe(false);
  });

  test("returns false when _rewriteFile throws", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-persist-"));
    const sessionFile = path.join(dir, "2026-01-01T00-00-00Z_ghi.jsonl");
    try {
      const sm = {
        getSessionFile: () => sessionFile,
        _rewriteFile() {
          throw new Error("disk full");
        },
      };
      expect(persistSessionHeader(sm)).toBe(false);
      expect(fs.existsSync(sessionFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tolerates a session manager lacking _rewriteFile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-persist-"));
    const sessionFile = path.join(dir, "2026-01-01T00-00-00Z_jkl.jsonl");
    try {
      // No _rewriteFile seam at all — should not throw, returns false.
      const sm = { getSessionFile: () => sessionFile };
      expect(persistSessionHeader(sm)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

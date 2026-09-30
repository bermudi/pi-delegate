import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
  type SubagentModel,
} from "../support/pi-boundary.ts";

/**
 * Console.warn spy: swaps console.warn for a collector and returns a
 * restore function. Issue #12 asserts on the fallback warning, which goes
 * through console.warn on the dispatch path.
 */
function spyConsoleWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((argument) => String(argument)).join(" "));
  };
  return { lines, restore: () => (console.warn = original) };
}

/** Delete DELEGATE_AGENT_DIR for the call, restoring it afterwards. */
function withoutAgentDirEnv(): { restore: () => void } {
  const previous = process.env.DELEGATE_AGENT_DIR;
  delete process.env.DELEGATE_AGENT_DIR;
  return {
    restore: () => {
      if (previous === undefined) delete process.env.DELEGATE_AGENT_DIR;
      else process.env.DELEGATE_AGENT_DIR = previous;
    },
  };
}

/** Set an environment variable for the call, restoring it afterwards. */
function withEnv(name: string, value: string): { restore: () => void } {
  const previous = process.env[name];
  process.env[name] = value;
  return {
    restore: () => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    },
  };
}

describe("regression: agentDir cwd fallback warns before proceeding (#12)", () => {
  let session: TestSession | undefined;
  let subagents: SubagentModel | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
    subagents = undefined;
  });

  test(
    "on an in-memory session the cwd fallback warns once, then dispatch proceeds",
    async () => {
      // Issue #12: with no session dir (in-memory / embedded sessions) the
      // agent dir silently fell back to ctx.cwd — delegate.json read from
      // the project and delegate-* trees written into the user's tree with
      // no notice. The fallback must stay (hosts legitimately need it) but
      // warn exactly once per extension instance before the first dispatch,
      // naming the directory and the DELEGATE_AGENT_DIR escape hatch.
      session = await openDelegateBoundary({ inMemoryAgentDir: true });
      subagents = await installSubagentModel(session);

      const warnings = spyConsoleWarn();
      const restoreEnv = withoutAgentDirEnv();
      try {
        subagents.respond([fauxAssistantMessage("FIRST")]);
        const first = await callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "remember ALPHA-MARKER", sessionId: "fallback-check" },
          ],
        });

        // (b) A warning, not a rejection: the call proceeds normally.
        expect(first.isError).toBe(false);
        // (a) One warning naming DELEGATE_AGENT_DIR and the fallback dir.
        const fallback = warnings.lines.filter((line) =>
          line.includes("DELEGATE_AGENT_DIR"),
        );
        expect(fallback).toHaveLength(1);
        expect(fallback[0]).toContain(session!.cwd);
        expect(fallback[0]).toContain("delegate.json");
        // (c) Warn-and-proceed is real: the sessionId task's pooled
        // transcript was created under the fallback dir.
        expect(existsSync(join(session!.cwd, "delegate-sessions"))).toBe(
          true,
        );

        // The latch: a second dispatch on the same session does not warn
        // again.
        subagents.respond([fauxAssistantMessage("SECOND")]);
        const second = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "again", sessionId: "fallback-check" }],
        });
        expect(second.isError).toBe(false);
        expect(
          warnings.lines.filter((line) =>
            line.includes("DELEGATE_AGENT_DIR"),
          ),
        ).toHaveLength(1);
      } finally {
        restoreEnv.restore();
        warnings.restore();
      }
    },
  );

  test(
    "an async dispatch on an in-memory session warns through the same latch",
    async () => {
      // #12 review: the warning sits before the sync/async split in
      // execute, so a background-ticket dispatch warns too — assert it
      // instead of trusting the placement. A fresh session means a fresh
      // extension instance and a fresh latch.
      session = await openDelegateBoundary({ inMemoryAgentDir: true });
      subagents = await installSubagentModel(session);

      const warnings = spyConsoleWarn();
      const restoreEnv = withoutAgentDirEnv();
      try {
        subagents.respond([fauxAssistantMessage("ASYNC")]);
        const result = await callDelegate(session, {
          tasks: [{ prompt: "remember GAMMA-MARKER" }],
          async: true,
        });

        expect(result.isError).toBe(false);
        const fallback = warnings.lines.filter((line) =>
          line.includes("DELEGATE_AGENT_DIR"),
        );
        expect(fallback).toHaveLength(1);
        expect(fallback[0]).toContain(session!.cwd);
      } finally {
        restoreEnv.restore();
        warnings.restore();
      }
    },
  );

  test(
    "a file-backed session under <agentDir>/sessions/ resolves via the session source",
    async () => {
      // Issue #12, layout shape: when the session dir sits in Pi's
      // session-store layout, the agent dir is inferred from it (the
      // "session" source) — no fallback, no warning, and delegate-owned
      // trees land under the inferred agent dir, not the session cwd.
      // createTestSession cannot express a file-backed session, so this
      // gives the extension runner a real SessionManager laid out like the
      // CLI's <agentDir>/sessions/<slug>; the harness's own persistence is
      // untouched (the runner's field only backs the extensions' ctx).
      session = await openDelegateBoundary({ inMemoryAgentDir: true });
      subagents = await installSubagentModel(session);

      const agentDir = mkdtempSync(join(tmpdir(), "delegate-agentdir-"));
      // Pi's session-store layout: <agentDir>/sessions/<cwd-slug>/ holds
      // the session files, so the session dir is two levels below the
      // agent dir — exactly what the inference strips.
      const sessionsDir = join(agentDir, "sessions", "--project-slug--");
      mkdirSync(sessionsDir, { recursive: true });
      const runner = (
        session.session as unknown as {
          extensionRunner: { sessionManager: unknown };
        }
      ).extensionRunner;
      const originalSessionManager = runner.sessionManager;
      runner.sessionManager = SessionManager.create(session.cwd, sessionsDir);

      const warnings = spyConsoleWarn();
      const restoreEnv = withoutAgentDirEnv();
      try {
        subagents.respond([fauxAssistantMessage("LAYOUT")]);
        const result = await callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "remember BETA-MARKER", sessionId: "layout-check" },
          ],
        });

        expect(result.isError).toBe(false);
        expect(
          warnings.lines.filter((line) =>
            line.includes("DELEGATE_AGENT_DIR"),
          ),
        ).toHaveLength(0);
        expect(existsSync(join(agentDir, "delegate-sessions"))).toBe(true);
        expect(existsSync(join(session.cwd, "delegate-sessions"))).toBe(
          false,
        );
      } finally {
        runner.sessionManager = originalSessionManager;
        restoreEnv.restore();
        warnings.restore();
      }
    },
  );

  test(
    "PI_CODING_AGENT_DIR resolves through Pi's own override, ahead of session inference",
    async () => {
      // Issue #9: the resolution order is DELEGATE_AGENT_DIR →
      // PI_CODING_AGENT_DIR (via pi-coding-agent's exported getAgentDir())
      // → session-store inference → cwd. The default boundary mocks the
      // session-store layout, which alone would resolve to the session
      // cwd — Pi's override must still win, with no fallback warning.
      session = await openDelegateBoundary();
      subagents = await installSubagentModel(session);

      const piAgentDir = mkdtempSync(join(tmpdir(), "delegate-pi-agentdir-"));
      const restoreDelegateEnv = withoutAgentDirEnv();
      const restorePiEnv = withEnv("PI_CODING_AGENT_DIR", piAgentDir);
      const warnings = spyConsoleWarn();
      try {
        subagents.respond([fauxAssistantMessage("PIENV")]);
        const result = await callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "remember DELTA-MARKER", sessionId: "pi-env-check" },
          ],
        });

        expect(result.isError).toBe(false);
        expect(
          warnings.lines.filter((line) =>
            line.includes("DELEGATE_AGENT_DIR"),
          ),
        ).toHaveLength(0);
        expect(existsSync(join(piAgentDir, "delegate-sessions"))).toBe(
          true,
        );
        expect(existsSync(join(session.cwd, "delegate-sessions"))).toBe(
          false,
        );
      } finally {
        warnings.restore();
        restorePiEnv.restore();
        restoreDelegateEnv.restore();
      }
    },
  );
});

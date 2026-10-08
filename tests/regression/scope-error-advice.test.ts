import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { callDelegate, installSubagentModel, openDelegateBoundary } from "../support/pi-boundary.ts";
import { gitEnv } from "../../src/fsx.ts";

// Literal repository #51: fail-closed admission errors must teach repair/retry,
// never suggest scratch as an unconditional workaround for ambiguous scope.
describe("Git scope discovery repair advice (#51)", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];
  function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), "delegate-scope-advice-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    session?.dispose(); session = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Unavailable Git and empty stdout are synthetic boundary fault injection.
  // Ordinary Git failure uses the reachable executable and its observed stderr.
  for (const failure of ["unavailable Git", "malformed Git configuration", "empty Git root"] as const) {
    test(`${failure} rejects with repair and retry advice before any worker starts`, async () => {
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      const source = tempDir(), shim = tempDir();
      execSync("git init -q", { cwd: source, env: gitEnv() });
      const configPath = join(source, ".git", "config");
      const originalConfig = readFileSync(configPath);
      if (failure === "empty Git root") {
        writeFileSync(join(shim, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      } else if (failure === "malformed Git configuration") {
        writeFileSync(configPath, "[core\n");
      }
      const previousPath = process.env.PATH;
      const args = { async: false, tasks: [{ prompt: "write after repair", cwd: source, tools: ["write"] }] };
      try {
        if (failure !== "malformed Git configuration") process.env.PATH = shim;
        const result = await callDelegate(session, args);
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/could not safely determine.*Git scope/i);
        if (failure === "malformed Git configuration") {
          // Observed with real git -C <source> rev-parse --show-toplevel.
          expect(result.text).toContain("fatal: bad config line 1 in file .git/config");
        }
        expect(result.text).toMatch(/repair.*Git.*context.*access.*retry/i);
        expect(result.text).not.toMatch(/scratch/i);
        expect(model.state.callCount).toBe(0);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        writeFileSync(configPath, originalConfig);
      }
      model.respond([fauxAssistantMessage("repaired scope accepted")]);
      const repaired = await callDelegate(session, args);
      expect(repaired.isError).toBe(false);
      expect(repaired.text).toContain("repaired scope accepted");
      expect(model.state.callCount).toBe(1);
    });
  }
});

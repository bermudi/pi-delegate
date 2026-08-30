/**
 * Test-run telemetry isolation.
 *
 * The pi test harness builds real sessions in-process, so this process's
 * environment IS the extension's environment. telemetry.ts resolves the
 * database path as config.dbPath > DELEGATE_TELEMETRY_DB > default; setting
 * the env var here redirects every test that runs on the default path to a
 * throwaway directory instead of the production ~/.pi/agent/delegate-usage.db.
 * Tests that set an explicit config dbPath are unaffected (config wins).
 *
 * Loaded once per `bun test` invocation via bunfig.toml [test] preload.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-telemetry-test-"));
process.env.DELEGATE_TELEMETRY_DB = path.join(dir, "usage.db");

process.on("exit", () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leftover temp dir is harmless.
  }
});

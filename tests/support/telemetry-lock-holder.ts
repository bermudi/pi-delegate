/**
 * Spawned helper for `tests/regression/telemetry-contention.test.ts`: holds
 * a real SQLite write lock on an existing database for a fixed interval so
 * the parent's telemetry writes meet genuine cross-process contention.
 * Mirrors the proven mechanics of `.build/telemetry-contention-probe.ts`'s
 * "lock" argv mode (busy_timeout 0, BEGIN IMMEDIATE, banner on stdout).
 *
 * argv: <dbPath> <holdMs>
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const dbPath = process.argv[2];
const holdMs = Number.parseInt(process.argv[3] ?? "", 10);
if (dbPath === undefined || !Number.isFinite(holdMs) || holdMs <= 0) {
  console.error("usage: telemetry-lock-holder <dbPath> <holdMs>");
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("BEGIN IMMEDIATE");
  process.stdout.write("LOCKED\n");
  setTimeout(() => {
    try {
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }, holdMs);
} catch (error) {
  try {
    db.close();
  } catch {}
  throw error;
}

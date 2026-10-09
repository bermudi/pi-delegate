#!/usr/bin/env bun
// Standing delegate dogfood harness.
//
// Closes the recurring "which model for the dogfood?" loop: the model is
// pinned by owner instruction in docs/verification/dogfood.config.json
// (provenance enforced below), so any future session runs this script
// without asking again. See AGENTS.md "Workflow".
//
// What it does:
//   1. Refuses to launch until the dogfood model is owner-pinned.
//   2. Gates on the provider-free suite + typecheck (the automated half of
//      the pi-upgrade checklist; docs/pi-upgrade-checklist.md carries the
//      manual seam checks).
//   3. A fresh `pi -p` session loading THIS TREE's delegate.ts on the
//      single surface (ADR 0002), scoped by DELEGATE_AGENT_DIR to an
//      owner-only scratch dir, telemetry opted in.
//   4. Asserts on hard evidence only — the marker file the inline task
//      writes, the saved session transcript's delegate tool results, and
//      telemetry rows (calls/tasks/misfires) — never the model's summary.
//
// Usage:
//   bun scripts/dogfood.ts [--dry-run] [--keep] [--timeout-secs N]

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO = resolve(import.meta.dirname, "..");
const CONFIG_PATH = join(REPO, "docs/verification/dogfood.config.json");

function die(message: string, code = 2): never {
  console.error(`[dogfood] FAIL: ${message}`);
  process.exit(code);
}

function log(message: string): void {
  console.error(`[dogfood] ${message}`);
}

interface DogfoodConfig {
  provider: string | null;
  model: string | null;
  thinking: string | null;
  provenance: { specifiedBy: string; specifiedAt: string; note?: string } | null;
}

function loadPinnedModel(): string {
  let config: DogfoodConfig;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as DogfoodConfig;
  } catch (error) {
    die(`unreadable ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { provider, model, thinking, provenance } = config;
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    provenance === null ||
    typeof provenance !== "object" ||
    typeof provenance.specifiedBy !== "string" ||
    typeof provenance.specifiedAt !== "string"
  ) {
    die(
      `dogfood model not pinned — ${CONFIG_PATH} needs provider, model, and ` +
        `provenance (specifiedBy/specifiedAt) from bermudi. The harness ` +
        `never picks a model itself.`,
    );
  }
  const thinkingSuffix = thinking ? `:${thinking}` : "";
  const id = `${provider}/${model}${thinkingSuffix}`;
  log(`pinned model ${id} (by ${provenance.specifiedBy} at ${provenance.specifiedAt})`);
  return id;
}

function run(command: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }): { ok: boolean; output: string } {
  const result = spawnSync(command, args, {
    timeout: options.timeout,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}

function gate(): void {
  log("gate: typecheck");
  const typecheck = run("bun", ["run", "typecheck"], { timeout: 180_000 });
  if (!typecheck.ok) die(`typecheck failed:\n${typecheck.output.slice(-2000)}`);
  log("gate: provider-free suite");
  const suite = run("bun", ["test"], { timeout: 600_000 });
  if (!suite.ok) die(`suite failed:\n${suite.output.slice(-3000)}`);
}

interface SurfacePlan {
  scratch: string;
  agentDir: string;
  markerPath: string;
  marker: string;
  prompt: string;
}

function planSurface(root: string, _modelId: string): SurfacePlan {
  const scratch = join(root, "session");
  const agentDir = join(scratch, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  chmodSync(scratch, 0o700);

  // Telemetry is opt-in (#45); the dogfood opts in inside the scratch dir
  // so the SQLite evidence assertions below have a database to read.
  // One surface (ADR 0002): no "surface" key exists — supplying one
  // rejects at config load.
  const config: Record<string, unknown> = { telemetry: { enabled: true } };
  writeFileSync(join(agentDir, "delegate.json"), `${JSON.stringify(config, null, 2)}\n`);

  const marker = `DOGMARK-${Math.random().toString(36).slice(2, 10)}`;
  const markerPath = join(scratch, "proof.txt");

  // Post-prune surface (#130): no per-task tools, no pause/resume, no
  // timeoutMs — the surviving grammar is dispatch, background default,
  // and a plain wait.
  const prompt = [
    "Use the delegate tool exactly twice in this turn:",
    `(1) one call with async:false, tasks: [{ prompt: "Write exactly ${marker} into ${markerPath} using the bash tool" }]`,
    `(2) one call with async omitted (background), tasks: [{ prompt: "Read ${markerPath} and reply with exactly its contents" }]`,
    "Then use delegate_ticket action:\"wait\" on the background ticket. Keep your final reply under five short lines; no explanations.",
  ].join("\n");

  return { scratch, agentDir, markerPath, marker, prompt };
}

function runSurface(plan: SurfacePlan, modelId: string, timeoutSecs: number): string[] {
  const failures: string[] = [];
  log(`launching fresh pi session (model ${modelId})`);

  const invocation = run(
    "pi",
    [
      "-p",
      "--mode", "json",
      "-ne",
      "-e", join(REPO, "delegate.ts"),
      "--model", modelId,
      "--session-dir", join(plan.scratch, "sessions"),
      "--name", "delegate-dogfood",
      plan.prompt,
    ],
    {
      timeout: timeoutSecs * 1000,
      env: { ...process.env, DELEGATE_AGENT_DIR: plan.agentDir },
    },
  );
  writeFileSync(join(plan.scratch, "pi-stdout.json"), invocation.output);
  if (!invocation.ok) {
    failures.push(
      `pi -p exited nonzero; output tail: ${invocation.output.slice(-800)}`,
    );
    return failures; // no point asserting evidence that never ran
  }
  log("session finished; asserting evidence");

  // (a) The inline task's real side effect.
  if (!existsSync(plan.markerPath)) {
    failures.push(`marker file ${plan.markerPath} missing — inline task never wrote it`);
  } else {
    const content = readFileSync(plan.markerPath, "utf8").trim();
    if (content !== plan.marker) {
      failures.push(`marker file contains ${JSON.stringify(content)}, expected ${JSON.stringify(plan.marker)}`);
    }
  }

  // (b) The session transcript: delegate executions and the async result
  // carrying the marker back.
  const sessionDir = join(plan.scratch, "sessions");
  const transcripts = existsSync(sessionDir)
    ? spawnSync("find", [sessionDir, "-name", "*.jsonl", "-type", "f"], { encoding: "utf8" }).stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
    : [];
  if (transcripts.length === 0) {
    failures.push(`no session transcript found under ${sessionDir}`);
  } else {
    const transcript = readFileSync(transcripts[0]!, "utf8");
    if (!transcript.includes('"delegate"')) {
      failures.push("session transcript shows no delegate tool execution");
    }
    if (!transcript.includes(plan.marker)) {
      failures.push("session transcript never carries the marker — the read task's result did not round-trip");
    }
  }

  // (c) Telemetry: opted-in scratch DB must show the dispatch, task rows on
  // the pinned model, and zero misfires for a clean run.
  const dbPath = join(plan.agentDir, "delegate-usage.db");
  if (!existsSync(dbPath)) {
    failures.push(`telemetry database missing at ${dbPath} despite scratch opt-in`);
  } else {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const calls = db.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number };
      if (calls.n < 2) failures.push(`expected >=2 dispatch rows in calls, found ${calls.n}`);
      const tasks = db
        .prepare("SELECT model FROM tasks WHERE model IS NOT NULL AND model != ?")
        .all(modelId) as unknown[];
      if (tasks.length > 0) {
        failures.push(`${tasks.length} task rows ran on a model other than ${modelId}`);
      }
      const misfires = db.prepare("SELECT COUNT(*) AS n FROM misfires").get() as { n: number };
      if (misfires.n !== 0) {
        failures.push(`clean dogfood produced ${misfires.n} misfire rows (expected 0)`);
      }
    } finally {
      db.close();
    }
  }
  return failures;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const keep = args.includes("--keep") || dryRun;
const timeoutFlag = args.includes("--timeout-secs")
  ? Number(args[args.indexOf("--timeout-secs") + 1])
  : 480;

const modelId = loadPinnedModel();
gate();

const root = mkdtempSync(join(homedir(), ".cache", "pi-delegate-dogfood."));
chmodSync(root, 0o700);
log(`scratch root ${root}${keep ? " (kept for evidence)" : ""}`);

const plan = planSurface(root, modelId);
log(`plan: marker ${plan.marker} → ${plan.markerPath}`);
if (dryRun) {
  log("dry run: gate passed, plan validated, no pi session launched");
  process.exit(0);
}

const allFailures: string[] = runSurface(plan, modelId, timeoutFlag);

if (allFailures.length > 0) {
  for (const failure of allFailures) console.error(`[dogfood] ASSERTION: ${failure}`);
  die(`${allFailures.length} assertion(s) failed; evidence under ${root}`, 1);
}

log(`PASS — single surface green; evidence under ${root}`);
if (!keep) rmSync(root, { recursive: true, force: true });

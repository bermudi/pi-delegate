// Parent runner: executes each scenario in a child node process, samples CPU
// from /proc, classifies the outcome, and (with --profile) captures a V8 CPU
// profile of a hung child via SIGUSR1 + the inspector protocol before killing.
//
// Usage: node run.mjs [--profile] [--timeout 12]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PROFILE = process.argv.includes("--profile");
const TIMEOUT = Number(
  (process.argv.find((a) => a.startsWith("--timeout=")) ?? "--timeout=12").split("=")[1],
);

function cpuTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2);
    const f = rest.split(" ");
    return Number(f[11]) + Number(f[12]); // utime + stime
  } catch {
    return null;
  }
}

async function profileHungChild(pid, label) {
  try {
    process.kill(pid, "SIGUSR1");
    await new Promise((r) => setTimeout(r, 1200));
    const targets = await (await fetch("http://127.0.0.1:9229/json/list")).json();
    const main = targets.find((t) => t.webSocketDebuggerUrl);
    if (!main) return "(no inspector target)";
    const ws = new WebSocket(main.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("ws fail"));
      setTimeout(() => rej(new Error("ws timeout")), 4000);
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((res) => {
        const id = ++seq;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", { interval: 1000 });
    const start = await Promise.race([
      send("Profiler.start"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("start timeout")), 8000)),
    ]).catch((e) => {
      throw e;
    });
    await new Promise((r) => setTimeout(r, 4000));
    const stop = await Promise.race([
      send("Profiler.stop"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("stop timeout")), 8000)),
    ]).catch((e) => ({ error: e.message }));
    if (stop.error) return `(profiler unavailable: ${stop.error} — main thread not servicing inspector)`;
    const prof = stop.result.profile;
    const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
    const agg = new Map();
    for (const s of prof.samples) {
      const n = nodes.get(s);
      if (!n) continue;
      const cf = n.callFrame;
      const key = `${cf.functionName || "(anon)"} ${String(cf.url ?? "").split("/").pop()}:${cf.lineNumber + 1}`;
      agg.set(key, (agg.get(key) ?? 0) + 1);
    }
    const top = [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${(100 * v / prof.samples.length).toFixed(1).padStart(5)}%  ${k}`)
      .join("\n");
    ws.close();
    return top;
  } catch (e) {
    return `(profile failed: ${e.message})`;
  }
}

async function runScenario(name, args, spawnServer) {
  let server = null;
  if (spawnServer) {
    const [port, scenario] = spawnServer;
    server = spawn(process.execPath, ["mock-server.mjs", String(port), scenario], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    await new Promise((r) => setTimeout(r, 700));
  }
  const child = spawn(process.execPath, ["worker.mjs", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));

  const t0 = Date.now();
  let ticks0 = cpuTicks(child.pid);
  let verdict = null;
  let profileText = "";

  while (Date.now() - t0 < TIMEOUT * 1000) {
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode !== null) {
      const ticks1 = cpuTicks(child.pid);
      const cpuPct = ticks0 !== null && ticks1 !== null ? (100 * (ticks1 - ticks0)) / ((Date.now() - t0) / 10) : 0;
      const line = out.trim().split("\n").pop() ?? "";
      verdict = `EXITED(${child.exitCode}) @${((Date.now() - t0) / 1000).toFixed(1)}s :: ${line.slice(0, 120)}`;
      break;
    }
  }

  if (!verdict) {
    const ticks1 = cpuTicks(child.pid);
    const secs = (Date.now() - t0) / 1000;
    const cpuPct = ticks0 !== null && ticks1 !== null ? ((ticks1 - ticks0) / (secs * 100)) * 100 : NaN;
    if (PROFILE) profileText = await profileHungChild(child.pid, name);
    child.kill("SIGKILL");
    verdict = `HANG ≥${TIMEOUT}s cpu=${cpuPct.toFixed(0)}%`;
  }

  if (server) server.kill("SIGKILL");
  const profileBlock = profileText ? `\n    profile:\n    ${profileText.split("\n").join("\n    ")}` : "";
  console.log(`${name.padEnd(16)} ${verdict}${profileBlock}`);
}

console.log(`node ${process.version}, timeout ${TIMEOUT}s${PROFILE ? ", profiling hangs" : ""}\n`);

await runScenario("control", ["control"]);
await runScenario("trunc-clean-end", ["trunc-clean-end"]);
await runScenario("trunc-error", ["trunc-error"]);
await runScenario("idflip-trunc", ["idflip-trunc"]);
await runScenario("dup-args", ["dup-args"]);
await runScenario("empty-spin", ["empty-spin"]);
await runScenario("slow-args", ["slow-args"]);
await runScenario("abort-mid-args", ["abort-mid-args"]);

const L2 = 4790;
await runScenario("L2/control", ["control", "--http", "--port=" + L2], [L2, "control"]);
await runScenario("L2/rst-mid-args", ["rst-mid-args", "--http", "--port=" + (L2 + 1)], [L2 + 1, "rst-mid-args"]);
await runScenario("L2/fin-mid-args", ["fin-mid-args", "--http", "--port=" + (L2 + 2)], [L2 + 2, "fin-mid-args"]);
await runScenario("L2/blackhole", ["blackhole", "--http", "--port=" + (L2 + 3)], [L2 + 3, "blackhole"]);
await runScenario("L2/dup-args", ["dup-args-http", "--http", "--port=" + (L2 + 4)], [L2 + 4, "dup-args"]);

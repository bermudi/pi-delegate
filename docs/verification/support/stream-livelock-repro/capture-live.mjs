// Live wild-trigger capture for the 2026-10-04 stream-livelock incident.
//
// Runs the INSTALLED pi-ai (unpatched) openai-completions stream against a
// real provider (default: zai glm-5.3, the incident model) with a fetch tee
// that records every response byte to disk BEFORE pi-ai parses it. If the
// wedge recurs, the capture shows exactly what the transport delivered.
//
// The open question this instrument exists to answer (repro README): what
// re-delivered/continued args chunks after the zai socket died. Two rival
// hypotheses, both served by the same tee:
//   a) ongoing delivery — bytes keep arriving (provider-edge re-delivery)
//   b) post-stream spin — bytes stop, loop keeps burning (would contradict
//      the code reading: repairJson is single-pass, so (b) needs new chunks)
//
// Usage:
//   node capture-live.mjs [--attempts=N] [--gap=SECS] [--timeout=SECS]
//                         [--observe=SECS] [--bytes-bound=MB] [--out=DIR]
//                         [--mock] [--mock-scenario=S] [--mock-port=P]
//                         [--prompt=...] [--model=ID] [--thinking-level=L]
//   node capture-live.mjs --child ...          (internal: one attempt)
//
// Capture layout per attempt (under captures/<ts>-a<N>/):
//   body.sse     raw response bytes, appended synchronously (SIGKILL-safe)
//   events.jsonl tee + signal + stream lifecycle events, one JSON per line
//   cpu.jsonl    parent's /proc samples of the child (cpu%, state)
//   child.log    child stderr (pi-ai event stream + diagnostics)
//   meta.json    verdict, totals, model, prompt
//
// Credentials: read at runtime from ~/.pi/agent/auth.json (provider "zai",
// schema {type:"api_key", key}). The key is never printed or logged; the
// request Authorization header is never captured.

import { spawn } from "node:child_process";
import { openSync, appendFileSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const arg = (name, dflt) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? dflt : hit.split("=").slice(1).join("=");
};
const flag = (name) => process.argv.includes(`--${name}`);

const DEFAULT_PROMPT =
	"Make exactly one delegate tool call, no prose before or after it. " +
	"The brief field of the arguments must itself contain the complete text: a detailed " +
	"2500-word architecture review of a subagent dispatch pipeline (admission control, " +
	"workspace isolation, ticket queueing, failure handling) with concrete recommendations. " +
	"Write the full review inside the brief — do not describe what a task would write.";

// ── child: one attempt ──────────────────────────────────────────────────────
if (flag("child")) {
	const outDir = arg("out");
	const mock = flag("mock");
	const modelId = arg("model", "glm-5.3");
	const thinkingLevel = arg("thinking-level", "high");

	const os = await import("node:os");
	const { pathToFileURL } = await import("node:url");
	const piAiRoot =
		process.env.PIAI_ROOT ??
		`${os.homedir()}/.pi/agent/install/releases/${readFileSync(`${os.homedir()}/.pi/agent/install/current-version`, "utf8").trim()}/node_modules/@earendil-works/pi-ai`;
	const mod = await import(pathToFileURL(`${piAiRoot}/dist/api/openai-completions.js`).href);
	const { MODELS } = await import(pathToFileURL(`${piAiRoot}/dist/models.generated.js`).href);

	// Credential: loaded here, used once, never displayed.
	let apiKey = "mock-key";
	if (!mock) {
		const auth = JSON.parse(readFileSync(`${os.homedir()}/.pi/agent/auth.json`, "utf8"));
		const cred = auth[arg("provider", "zai")];
		if (cred?.type !== "api_key" || !cred.key) {
			console.error(`[child] no api_key credential for provider "${arg("provider", "zai")}" in auth.json`);
			process.exit(2);
		}
		apiKey = cred.key;
	}

	// Model comes from the INSTALLED catalog — the exact entry the incident
	// stack resolved (baseUrl, compat flags, thinking map). Mock mode only
	// swaps the baseUrl to point at the local server.
	const catalogEntry = MODELS[arg("provider", "zai")]?.[modelId];
	if (!catalogEntry) {
		console.error(`[child] model "${modelId}" not in installed catalog for provider "${arg("provider", "zai")}"`);
		process.exit(3);
	}
	const model = {
		...catalogEntry,
		...(mock ? { baseUrl: `http://127.0.0.1:${arg("mock-port", "4711")}/v1` } : {}),
	};

	const context = {
		system: "You are a capture harness for a streaming incident. Comply exactly.",
		messages: [{ role: "user", content: [{ type: "text", text: arg("prompt", DEFAULT_PROMPT) }] }],
		tools: [
			{
				name: "delegate",
				description: "Dispatch subagent tasks.",
				parameters: {
					type: "object",
					properties: {
						brief: { type: "string" },
						tasks: { type: "array", items: { type: "object" } },
					},
					required: ["tasks"],
				},
			},
		],
	};

	// ── the tee: every response byte hits disk before pi-ai sees it ──
	const bodyFd = openSync(`${outDir}/body.sse`, "a");
	const eventsFd = openSync(`${outDir}/events.jsonl`, "a");
	const logEvent = (ev) => appendFileSync(eventsFd, `${JSON.stringify({ ms: Date.now(), ...ev })}\n`);
	const realFetch = globalThis.fetch;
	let bytesIn = 0;
	const t0 = Date.now();

	const controller = new AbortController();
	const hardStop = setTimeout(() => {
		logEvent({ ev: "attempt_timeout" });
		controller.abort(new Error("attempt timeout"));
	}, Number(arg("timeout", "600")) * 1000);
	hardStop.unref?.();

	const teeFetch = async (url, init) => {
		try {
			const body = JSON.parse(String(init?.body ?? "{}"));
			logEvent({
				ev: "request_start",
				url: String(url),
				tools: body.tools?.length ?? 0,
				toolChoice: body.tool_choice ?? null,
				stream: body.stream ?? null,
				msSinceAttemptStart: Date.now() - t0,
			});
		} catch {
			logEvent({ ev: "request_start", url: String(url), msSinceAttemptStart: Date.now() - t0 });
		}
		const res = await realFetch(url, init);
		logEvent({ ev: "response", status: res.status, contentType: res.headers.get("content-type") ?? "" });
		if (!res.body) return res;
		const [toSdk, toCap] = res.body.tee();
		(async () => {
			const reader = toCap.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						logEvent({ ev: "body_end", offset: bytesIn });
						break;
					}
					appendFileSync(bodyFd, value);
					bytesIn += value.byteLength;
					logEvent({ ev: "bytes", n: value.byteLength, offset: bytesIn });
				}
			} catch (err) {
				logEvent({ ev: "body_error", err: String(err?.message ?? err).slice(0, 200), offset: bytesIn });
			}
		})();
		return new Response(toSdk, { status: res.status, headers: res.headers });
	};

	controller.signal.addEventListener("abort", () =>
		logEvent({ ev: "signal_abort", reason: String(controller.signal.reason?.message ?? "").slice(0, 120) }),
	);

	let events = 0;
	let lastType = "";
	try {
		const stream = mod.stream(model, context, {
			apiKey,
			fetch: teeFetch,
			signal: controller.signal,
			maxRetries: 0,
			thinkingLevel,
			toolChoice: "required",
		});
		for await (const ev of stream) {
			events++;
			lastType = ev.type;
			if (ev.type === "error" || ev.type === "done")
				console.error(`[child] ${ev.type}: ${JSON.stringify(ev).slice(0, 300)}`);
			if (events % 200 === 0) console.error(`[child] ev#${events} ${ev.type} bytes=${bytesIn}`);
		}
		console.error(`[child] COMPLETED events=${events} last=${lastType} bytes=${bytesIn} ms=${Date.now() - t0}`);
		logEvent({ ev: "stream_result", result: lastType || "empty", events, bytes: bytesIn });
		process.exit(0);
	} catch (err) {
		console.error(`[child] ERRORED events=${events} last=${lastType} bytes=${bytesIn} ms=${Date.now() - t0} err=${String(err?.message ?? err).slice(0, 200)}`);
		logEvent({ ev: "stream_result", result: "threw", events, bytes: bytesIn });
		process.exit(0);
	}
}

// ── parent: attempt loop + wedge classifier ────────────────────────────────
const attempts = Number(arg("attempts", "1"));
const gapSecs = Number(arg("gap", "30"));
const timeoutSecs = Number(arg("timeout", "600"));
const observeSecs = Number(arg("observe", "60"));
const bytesBound = Number(arg("bytes-bound", "20")) * 1024 * 1024;
const baseDir = arg("out", `captures/${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(baseDir, { recursive: true });

const self = fileURLToPath(import.meta.url);
const readCpu = (pid) => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { utime: Number(fields[11]), stime: Number(fields[12]), state: fields[0] };
	} catch {
		return null;
	}
};

const verdicts = [];
for (let attempt = 1; attempt <= attempts; attempt++) {
	const outDir = `${baseDir}/a${attempt}`;
	mkdirSync(outDir, { recursive: true });
	const startedAt = new Date().toISOString();
	console.log(`[parent] attempt ${attempt}/${attempts} → ${outDir}`);

	const child = spawn(process.execPath, [
		self,
		"--child",
		`--out=${outDir}`,
		`--timeout=${timeoutSecs}`,
		...(flag("mock") ? ["--mock", `--mock-port=${arg("mock-port", "4711")}`] : []),
		...(arg("model", "") ? [`--model=${arg("model", "glm-5.3")}`] : []),
		...(arg("prompt", "") !== "" ? [`--prompt=${arg("prompt", DEFAULT_PROMPT)}`] : []),
	], { stdio: ["ignore", "inherit", "inherit"] });

	const cpuFd = openSync(`${outDir}/cpu.jsonl`, "a");
	let lastUtime = 0;
	let lastSampleMs = Date.now();
	let peggedSamples = 0;
	let lastBytesOffset = 0;
	let lastBytesMs = Date.now();
	let verdict = null;
	let wedgeMarkedMs = null;

	const classify = setInterval(() => {
		const cpu = readCpu(child.pid);
		if (!cpu) return; // exited; final state handled below
		const now = Date.now();
		const dms = now - lastSampleMs;
		const dcpu = (cpu.utime + cpu.stime - lastUtime) / 100; // jiffies→s, clock=100
		const cpuPct = dms > 0 ? Math.round((dcpu / (dms / 1000)) * 100) : 0;
		lastUtime = cpu.utime + cpu.stime;
		lastSampleMs = now;
		appendFileSync(cpuFd, `${JSON.stringify({ ms: now, cpuPct, state: cpu.state })}\n`);

		// bytes movement read from the child's own events file (SIGKILL-safe)
		let offset = lastBytesOffset;
		try {
			const lines = readFileSync(`${outDir}/events.jsonl`, "utf8").trim().split("\n").filter(Boolean);
			for (let i = lines.length - 1; i >= 0; i--) {
				const ev = JSON.parse(lines[i]);
				if (ev.ev === "bytes" || ev.ev === "body_end") { offset = ev.offset ?? offset; break; }
			}
		} catch { /* child still creating it */ }
		const bytesMoved = offset > lastBytesOffset;
		if (bytesMoved) { lastBytesOffset = offset; lastBytesMs = now; }

		if (wedgeMarkedMs) {
			if (now - wedgeMarkedMs >= observeSecs * 1000) {
				console.error(`[parent] WEDGE observed ${observeSecs}s — SIGKILL (SIGTERM cannot run on a wedged main thread)`);
				child.kill("SIGKILL");
			}
			return;
		}

		peggedSamples = cpuPct >= 70 ? peggedSamples + 1 : 0;
		const stalled = now - lastBytesMs >= 10_000;
		if (peggedSamples >= 8 && stalled) {
			verdict = "WEDGE: cpu pegged, bytes stalled (post-delivery spin)";
			wedgeMarkedMs = now;
			console.error(`[parent] ${verdict} — observing ${observeSecs}s to record what happens next`);
		} else if (offset > bytesBound) {
			verdict = `WEDGE: bytes exceeded ${(bytesBound / 1024 / 1024).toFixed(1)}MB bound (endless delivery)`;
			wedgeMarkedMs = now;
			console.error(`[parent] ${verdict} — observing ${observeSecs}s`);
		}
	}, 500);

	const exitInfo = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
	const code = exitInfo.code;
	clearInterval(classify);
	let totalBytes = lastBytesOffset;
	let streamResult = null;
	try {
		const lines = readFileSync(`${outDir}/events.jsonl`, "utf8").trim().split("\n").filter(Boolean);
		for (let i = lines.length - 1; i >= 0; i--) {
			const ev = JSON.parse(lines[i]);
			if (ev.ev === "bytes" || ev.ev === "body_end") { totalBytes = ev.offset ?? totalBytes; break; }
		}
		for (const l of lines) {
			const ev = JSON.parse(l);
			if (ev.ev === "stream_result") streamResult = ev.result;
		}
	} catch { /* none */ }

	if (verdict === null) {
		verdict =
			streamResult === "threw" || streamResult === "error"
				? `ERRORED (stream result: ${streamResult} — see body.sse and child.log)`
				: totalBytes > 0 || streamResult
					? "COMPLETED"
					: `EXITED code=${code} signal=${exitInfo.signal ?? "-"}`;
	}
	verdicts.push(verdict);
	writeFileSync(
		`${outDir}/meta.json`,
		JSON.stringify({ attempt, startedAt, endedAt: new Date().toISOString(), verdict, totalBytes, childExit: code, childSignal: exitInfo.signal ?? null, bytesBound, timeoutSecs }, null, 2),
	);
	console.log(`[parent] attempt ${attempt} verdict: ${verdict} (bytes=${totalBytes})`);
	if (attempt < attempts) await new Promise((r) => setTimeout(r, gapSecs * 1000));
}

console.log(`\n[parent] done: ${verdicts.length} attempt(s) under ${baseDir}`);
for (const [i, v] of verdicts.entries()) console.log(`  a${i + 1}: ${v}`);
if (verdicts.some((v) => v.startsWith("WEDGE"))) {
	console.log("[parent] WILD TRIGGER CAPTURED — body.sse + events.jsonl in the wedge attempt dir is the artifact.");
	process.exit(0); // success: the instrument did its job
}

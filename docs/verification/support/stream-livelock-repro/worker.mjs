// One scenario, one process. Drives the INSTALLED pi-ai openai-completions
// stream function through two seams:
//
//   layer 1 (default): inject options.fetch returning a synthetic SSE Response
//                      — isolates pi-ai's chunk loop from the network stack.
//   layer 2 (--http):   real HTTP against mock-server.mjs — exercises the
//                      openai SDK + undici read path after connection death.
//
// Exit codes: 0 = stream completed or errored cleanly, 1 = setup failure.
// A scenario that never exits is the phenomenon under test; the parent
// (run.mjs) classifies it as HANG with CPU evidence.

import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const PIAI_ROOT =
  process.env.PIAI_ROOT ??
  (await (async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const ver = fs
      .readFileSync(`${os.homedir()}/.pi/agent/install/current-version`, "utf8")
      .trim();
    return `${os.homedir()}/.pi/agent/install/releases/${ver}/node_modules/@earendil-works/pi-ai`;
  })());

const mod = await import(
  pathToFileURL(`${PIAI_ROOT}/dist/api/openai-completions.js`).href
);

const scenario = process.argv[2] ?? "control";
const httpMode = process.argv.includes("--http");
const httpPort = Number(
  (process.argv.find((a) => a.startsWith("--port=")) ?? "--port=0").split("=")[1],
);

// ── model + context ────────────────────────────────────────────────────────
const variant = (process.argv.find((a) => a.startsWith("--variant=")) ?? "--variant=full-zai").split("=")[1];
const baseModel = {
  id: "glm-5.3",
  api: "openai-completions",
  reasoning: true,
  ...(httpMode
    ? { baseUrl: `http://127.0.0.1:${httpPort}/v1` }
    : { baseUrl: "https://api.z.ai/v1" }),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  input: "text",
};
const VARIANTS = {
  openai: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
  "plain-zai": { provider: "zai", baseUrl: "https://api.z.ai/v1" },
};
const model =
  variant in VARIANTS
    ? { ...baseModel, ...VARIANTS[variant] }
    : {
        ...baseModel,
        provider: "zai",
        compat: {
          zaiToolStream: true,
          thinkingFormat: "zai",
          supportsReasoningEffort: true,
          supportsFinishReason: true,
          maxTokensField: "max_tokens",
          supportsUsageInStreaming: true,
        },
      };

const context = {
  system: "You are a reproducer harness.",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Dispatch one delegate mining task." }],
    },
  ],
  ...(process.argv.includes("--no-tools")
    ? {}
    : {
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
      }),
};

// ── layer 1: synthetic fetch ────────────────────────────────────────────────
const { sse, DONE, roleChunk, toolCallStartChunk, argsDeltaChunk, finishChunk, fragify, DELEGATE_ARGS } =
  await import("./sse.mjs");

function* controlScript() {
  yield sse(roleChunk());
  yield sse(toolCallStartChunk());
  for (const frag of fragify(DELEGATE_ARGS)) yield sse(argsDeltaChunk(frag));
  yield sse(finishChunk());
  yield DONE;
}

function* truncCleanEndScript() {
  // stream cut mid-arguments, body closes WITHOUT finish_reason / [DONE]
  yield sse(roleChunk());
  yield sse(toolCallStartChunk());
  for (const frag of fragify(DELEGATE_ARGS).slice(0, 4)) yield sse(argsDeltaChunk(frag));
}

function* truncErrorScript() {
  yield sse(roleChunk());
  yield sse(toolCallStartChunk());
  for (const frag of fragify(DELEGATE_ARGS).slice(0, 4)) yield sse(argsDeltaChunk(frag));
  throw new Error("socket hang up (simulated)");
}

function* idFlipTruncScript() {
  yield sse(roleChunk());
  yield sse(toolCallStartChunk({ withId: false })); // zai id-flip signature
  for (const frag of fragify(DELEGATE_ARGS).slice(0, 4)) yield sse(argsDeltaChunk(frag));
}

const SCRIPTS = {
  control: controlScript,
  "trunc-clean-end": truncCleanEndScript,
  "trunc-error": truncErrorScript,
  "idflip-trunc": idFlipTruncScript,
};

function syntheticFetch() {
  return async () => {
    const script = SCRIPTS[scenario];
    if (!script) throw new Error(`unknown layer-1 scenario: ${scenario}`);
    const body = new ReadableStream({
      async start(controller) {
        try {
          for (const chunk of script()) controller.enqueue(new TextEncoder().encode(chunk));
        } catch (err) {
          controller.error(err);
          return;
        }
        // Scenarios whose generator simply ends (trunc-clean-end, idflip-trunc)
        // close the body here: socket "died", no [DONE].
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

// Unbounded/paced scenarios share one pull-driven factory (backpressure-faithful):
//   dup-args        the SAME args fragment re-delivered forever
//   empty-spin      SSE keepalive comments only, forever
//   abort-mid-args  args fragments cycling forever; AbortController fires mid-stream
//   slow-args       args fragments ×3, then clean finish (termination sanity check)
function pacedFetch() {
  return async () => {
    const encoder = new TextEncoder();
    const frags = fragify(DELEGATE_ARGS);
    const dupFrag = frags[4] ?? '{"x":';
    let i = 0;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse(roleChunk())));
        controller.enqueue(encoder.encode(sse(toolCallStartChunk())));
        if (scenario === "abort-mid-args") {
          setTimeout(() => abortController.abort(new Error("user pressed escape")), 900);
        }
      },
      pull(controller) {
        if (scenario === "empty-spin") {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
          return;
        }
        if (scenario === "dup-args") {
          controller.enqueue(encoder.encode(sse(argsDeltaChunk(dupFrag))));
          return;
        }
        const frag = frags[i++ % frags.length];
        controller.enqueue(encoder.encode(sse(argsDeltaChunk(frag))));
        if (scenario === "slow-args" && i >= frags.length * 3) {
          controller.enqueue(encoder.encode(sse(finishChunk())));
          controller.enqueue(encoder.encode(DONE));
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

// ── run ─────────────────────────────────────────────────────────────────────
const abortController = new AbortController();
const unbounded =
  scenario === "dup-args" || scenario === "empty-spin" || scenario === "abort-mid-args" || scenario === "slow-args";
const options = {
  apiKey: "repro-key",
  ...(httpMode ? {} : { fetch: unbounded ? pacedFetch() : syntheticFetch() }),
  ...(scenario === "abort-mid-args" ? { signal: abortController.signal } : {}),
  maxRetries: 0,
};

const t0 = Date.now();
let events = 0;
let lastType = "";
try {
  const eventStream = mod.stream(model, context, options);
  for await (const ev of eventStream) {
    events++;
    lastType = ev.type;
    if (ev.type === "error" || ev.type === "done")
      console.error(
        `[worker] ${ev.type}: ` + JSON.stringify(ev).slice(0, 500),
      );
    if (events % 50 === 0) console.error(`[worker] ev#${events} ${ev.type}`);
  }
  console.log(`[worker] COMPLETED events=${events} last=${lastType} ms=${Date.now() - t0}`);
  process.exit(0);
} catch (err) {
  console.log(
    `[worker] ERRORED events=${events} last=${lastType} ms=${Date.now() - t0} err=${String(err?.message ?? err).slice(0, 160)}`,
  );
  process.exit(0);
}

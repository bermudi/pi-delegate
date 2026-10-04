// Shared SSE chunk builders for the stream-livelock reproducer.
// Shapes mirror what zai/GLM emits over the openai-completions wire:
// chat.completion.chunk objects with `tool_calls` deltas.

export const TOOL_NAME = "delegate";

// A delegate-shaped argument payload, the kind that was in flight during the
// 2026-10-04 incident (01a107af): nested object with a long prompt string.
export const DELEGATE_ARGS = JSON.stringify({
  brief: "mine transcripts",
  tasks: [
    {
      prompt:
        "Read-only mining task. Scan the session transcripts under ~/.pi/agent/sessions " +
        "and extract every user message using the pinned jq recipe: " +
        'jq -c \'select(.type=="message") | .message.content[]? | select(.type=="text") | .text\'. '.repeat(12) +
        "Return only counts and anomalies.",
    },
  ],
});

/** chunk id shared across deltas of one completion (per OpenAI semantics) */
const CHUNK_ID = "chatcmpl-repro-0001";

export function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export const DONE = "data: [DONE]\n\n";

export function roleChunk() {
  return {
    id: CHUNK_ID,
    object: "chat.completion.chunk",
    model: "glm-5.3",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  };
}

/** First tool_calls delta. `withId=false` reproduces the documented zai id-flip
 *  signature (first delta chunk arrives without `id`). */
export function toolCallStartChunk({ withId = true } = {}) {
  return {
    id: CHUNK_ID,
    object: "chat.completion.chunk",
    model: "glm-5.3",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(withId ? { id: "call_repro_0001" } : {}),
              type: "function",
              function: { name: TOOL_NAME, arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

/** Arguments fragment delta. `frag` is a raw JSON-text slice. */
export function argsDeltaChunk(frag, { withId = false } = {}) {
  return {
    id: CHUNK_ID,
    object: "chat.completion.chunk",
    model: "glm-5.3",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(withId ? { id: "call_repro_0001" } : {}),
              function: { arguments: frag },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function finishChunk(reason = "tool_calls") {
  return {
    id: CHUNK_ID,
    object: "chat.completion.chunk",
    model: "glm-5.3",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  };
}

/** Split a JSON-args string into stream-sized fragments, provider-style. */
export function fragify(text, size = 96) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

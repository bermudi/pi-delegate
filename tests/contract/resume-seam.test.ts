import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/**
 * Issue #124 — pin pi's session-load tolerance seam. `resumeFrom` and
 * pooled reloads depend on the platform accepting crash-shaped
 * transcripts: malformed final lines skipped, missing trailing newline
 * repaired, and orphaned toolCalls synthesized as error toolResults
 * ("No result provided") by the provider conversion layer, with
 * errored/aborted assistant turns dropped from replay (pi-ai
 * transform-messages.js; verified live against installed pi 1.0.4 with
 * a real provider on 2026-10-08 — a dangling-call session resumed and
 * the model re-did the work through a fresh tool call).
 *
 * The faux provider receives raw context messages and bypasses provider
 * conversion, so the synthesis itself is pinned directly against
 * pi-ai's exported `transformMessages` at the version our peer range
 * resolves; the public-boundary tests below pin the load, the
 * continuation, and the absence of re-execution. If a Pi bump tightens
 * any of this, resumeFrom degrades silently in production — these
 * tests make it fail loudly instead.
 */
describe("resume over crash-shaped transcripts (issue #124)", () => {
  const sessions: TestSession[] = [];
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });

  function entry(id: string, parentId: string | null, message: unknown): string {
    return JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: "2026-10-08T10:00:00.000Z",
      message,
    });
  }

  interface Crafted {
    readonly path: string;
    readonly danglingCallId: string;
  }

  /**
   * A session whose active branch ends mid-turn: the assistant asked
   * for `read` and the host died before the result was recorded — plus,
   * in the "torn" variant, a final line cut mid-write.
   */
  function craftTorn(cwd: string, trailing: "torn" | "clean"): Crafted {
    const path = join(cwd, `torn-${trailing}.jsonl`);
    const danglingCallId = "call_124dangling0001";
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "44444444-4444-4444-8444-444444444444",
        timestamp: "2026-10-08T10:00:00.000Z",
        cwd,
      }),
      entry("e1", null, {
        role: "user",
        content: "Read notes.txt and report its contents.",
        timestamp: 1760000001000,
      }),
      entry("e2", "e1", {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the file now." },
          {
            type: "toolCall",
            id: danglingCallId,
            name: "read",
            arguments: { path: join(cwd, "notes.txt"), offset: 1, limit: 50 },
          },
        ],
        api: "openai-completions",
        provider: "delegate-faux",
        model: "faux-1",
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1760000002000,
      }),
    ];
    let text = `${lines.join("\n")}\n`;
    if (trailing === "torn") {
      // A write cut mid-line: valid JSON prefix, no newline terminator.
      text += `{"type":"message","id":"e3","parent`;
    }
    writeFileSync(path, text, { flag: "wx" });
    return { path, danglingCallId };
  }

  for (const variant of ["torn", "clean"] as const) {
    test(`${variant} transcript: resume loads, continues, never re-executes the orphaned call`, async () => {
      const session = await openDelegateBoundary(); // full surface: resumeFrom
      sessions.push(session);
      const provider = await installSubagentModel(session);
      writeFileSync(join(session.cwd, "notes.txt"), "the seam holds\n");
      const crafted = craftTorn(session.cwd, variant);

      let sawDanglingInContext = false;
      provider.respond([
        async (context: { messages: unknown }) => {
          // Faux sees raw history: the assistant turn is replayed (its
          // stopReason is toolUse, not error/aborted), dangling call and all.
          sawDanglingInContext = JSON.stringify(context.messages).includes(crafted.danglingCallId);
          return fauxAssistantMessage("RESUMED-OK");
        },
      ]);
      const dispatched = await callDelegate(session, {
        tasks: [{ resumeFrom: crafted.path, prompt: "continue the interrupted work" }],
        async: false,
      });
      expect(dispatched.isError).toBe(false);
      expect(dispatched.text).toContain("RESUMED-OK");
      expect(sawDanglingInContext).toBe(true);

      // No re-execution: the orphaned call never produced a toolResult —
      // neither replayed nor run — in the continued transcript.
      const after = readFileSync(crafted.path, "utf8");
      expect(after).not.toContain(`"toolCallId":"${crafted.danglingCallId}"`);
      // The continuation appended its own turn.
      expect(after).toContain("RESUMED-OK");
    });
  }

  test("provider conversion synthesizes the orphaned call's result (pi-ai transformMessages)", () => {
    // The crash-shaped conversation as the resumed session builds it:
    // history ending in an unanswered toolCall, then the new session's
    // system prompt, then the continuation prompt.
    const dangling: ToolCall = {
      type: "toolCall",
      id: "call_124dangling0001",
      name: "read",
      arguments: { path: "/tmp/notes.txt", offset: 1, limit: 50 },
    };
    const history: Message[] = [
      { role: "user", content: "Read notes.txt.", timestamp: 1760000001000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Reading." }, dangling],
        api: "openai-completions",
        provider: "delegate-faux",
        model: "faux-1",
        stopReason: "toolUse",
        timestamp: 1760000002000,
      } as AssistantMessage,
      {
        role: "system",
        content: "",
        sections: { preamble: "p" },
        timestamp: 1760000003000,
      } as Message,
      { role: "user", content: "continue", timestamp: 1760000004000 },
    ];
    const model = {
      id: "faux-1",
      provider: "delegate-faux",
      api: "openai-completions",
      input: ["text"],
      output: ["text"],
    } as unknown as Model<"openai-completions">;
    const transformed = transformMessages(history, model);
    const synthesized = transformed.find(
      (message) =>
        message.role === "toolResult" &&
        (message as { toolCallId?: string }).toolCallId === dangling.id,
    ) as { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
    expect(synthesized).toBeDefined();
    expect(synthesized?.content?.[0]?.text).toBe("No result provided");
    expect(synthesized?.isError).toBe(true);
    // The new user turn still arrives after the synthesized result.
    expect(transformed.at(-1)?.role).toBe("user");
  });
});

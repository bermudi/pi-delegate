import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/**
 * Contract: the composed child base prompt (SPEC "Child base prompt",
 * issue #33). Children without an authored prompt — inline tasks and all
 * built-in profiles — inherit the parent's user-authored prompt inputs
 * (custom base prompt, user-appended text) from the structured
 * system-prompt options, never the assembled string. Extension-contributed
 * guidelines and sections are not inherited; tool documentation is rebuilt
 * from the child's own inventory. The composition appends the built-in
 * role line and closes with the fixed subagent framing, which carries no
 * parent identity. Authored prompts — an explicit task `systemPrompt` or a
 * Markdown profile body — are verbatim: no inheritance, no framing. An
 * extension-force-replaced parent prompt disables inheritance with a
 * logged skip.
 */

/** Render the leading system message's full prompt text (content + sections). */
function systemPromptText(message: unknown): string {
  const sys = message as
    | { content?: unknown; sections?: Record<string, unknown> }
    | undefined;
  if (!sys) return "";
  const content =
    typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content ?? "");
  return [
    content,
    ...Object.values(sys.sections ?? {}).map((s) => String(s)),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

const FRAMING =
  "You are a subagent spawned by the delegate extension on behalf of a parent " +
  "session. No user is watching this session and questions cannot be asked; " +
  "your final message is the only result returned to the caller. Complete the " +
  "task in your brief, then stop. Use only the tools provided.";

const PERSONA = "PARENT-PERSONA: answer in terse haiku.";

const leakFaultPath = resolve(
  import.meta.dirname,
  "../support/prompt-extension-content-fault.ts",
);
const forcedFaultPath = resolve(
  import.meta.dirname,
  "../support/forced-prompt-fault.ts",
);

describe("composed child base prompt contract (#33)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "an inline child inherits the parent persona and is framed as a subagent",
    async () => {
      // v1 evidence: buildSubagentSystemPrompt fell back to the sanitized
      // parent prompt; v2 composes through the structured prompt inputs.
      session = await openDelegateBoundary({ systemPrompt: PERSONA });
      const subagents = await installSubagentModel(session);
      let seenPrompt = "";
      subagents.respond([
        (context) => {
          const sys = context.messages.find((m) => m.role === "system");
          seenPrompt = systemPromptText(sys);
          return fauxAssistantMessage("OK-INLINE");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "say ok" }],
      });

      expect(result.isError).toBe(false);
      expect(seenPrompt).toContain("PARENT-PERSONA: answer in terse haiku.");
      expect(seenPrompt).toContain(FRAMING);
    },
  );

  test(
    "a stock parent still frames the inline child — the framing stands alone",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      let seenPrompt = "";
      subagents.respond([
        (context) => {
          const sys = context.messages.find((m) => m.role === "system");
          seenPrompt = systemPromptText(sys);
          return fauxAssistantMessage("OK-STOCK");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "say ok" }],
      });

      expect(result.isError).toBe(false);
      expect(seenPrompt).toContain(FRAMING);
      expect(seenPrompt).not.toContain("PARENT-PERSONA");
    },
  );

  test(
    "built-in role lines compose under the parent persona, not over it",
    async () => {
      // Deliberate divergence from v1 (COMPATIBILITY "Child base prompt is
      // composed"): v1's built-in role prompts beat the parent persona by
      // precedence; v2 composes persona + role + framing.
      session = await openDelegateBoundary({ systemPrompt: PERSONA });
      const subagents = await installSubagentModel(session);
      const seen: string[] = [];
      subagents.respond([
        (context) => {
          const sys = context.messages.find((m) => m.role === "system");
          seen.push(systemPromptText(sys));
          return fauxAssistantMessage("OK-SCOUT");
        },
        (context) => {
          const sys = context.messages.find((m) => m.role === "system");
          seen.push(systemPromptText(sys));
          return fauxAssistantMessage("OK-CODER");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "scout it", agent: "scout" },
          { prompt: "code it", agent: "coder" },
        ],
      });

      expect(result.isError).toBe(false);
      // Dispatch order is not contract: identify each captured prompt by
      // its built-in role line rather than its position in `seen`.
      const promptFor = (role: string): string => {
        const found = seen.find((prompt) => prompt.includes(role));
        if (found === undefined) {
          throw new Error(`no captured child prompt contains '${role}'`);
        }
        return found;
      };
      const scoutPrompt = promptFor("read-only investigation subagent");
      const coderPrompt = promptFor("implementation subagent");
      expect(seen).toHaveLength(2);
      expect(scoutPrompt).toContain("PARENT-PERSONA");
      expect(scoutPrompt).toContain(FRAMING);
      expect(coderPrompt).toContain("PARENT-PERSONA");
      expect(coderPrompt).toContain(FRAMING);
    },
  );

  test(
    "an explicit task systemPrompt is verbatim: no inheritance, no framing",
    async () => {
      session = await openDelegateBoundary({ systemPrompt: PERSONA });
      const subagents = await installSubagentModel(session);
      let seenPrompt = "";
      subagents.respond([
        (context) => {
          const sys = context.messages.find((m) => m.role === "system");
          seenPrompt = systemPromptText(sys);
          return fauxAssistantMessage("OK-AUTHORED");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "say ok", systemPrompt: "AUTHORED-PROMPT: do the thing." },
        ],
      });

      expect(result.isError).toBe(false);
      expect(seenPrompt).toContain("AUTHORED-PROMPT: do the thing.");
      expect(seenPrompt).not.toContain("PARENT-PERSONA");
      expect(seenPrompt).not.toContain(FRAMING);
    },
  );

  test(
    "a Markdown profile body is verbatim: no inheritance, no framing",
    async () => {
      session = await openDelegateBoundary({ systemPrompt: PERSONA });
      const dir = join(session.cwd, "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "stonemason.md"),
        "---\nname: stonemason\ndescription: carves\n---\nPROFILE-BODY: carve stone.\n",
      );
      const subagents = await installSubagentModel(session);
      let seenPrompt = "";
      subagents.respond([
        (context) => {
          const sys = context.messages.find((m) => m.role === "system");
          seenPrompt = systemPromptText(sys);
          return fauxAssistantMessage("OK-PROFILE");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "carve", agent: "stonemason" }],
      });

      expect(result.isError).toBe(false);
      expect(seenPrompt).toContain("PROFILE-BODY: carve stone.");
      expect(seenPrompt).not.toContain("PARENT-PERSONA");
      expect(seenPrompt).not.toContain(FRAMING);
    },
  );

  test(
    "extension-contributed guidelines and sections are never inherited",
    async () => {
      // The fault extension contributes prompt content through the
      // extension channels before delegate's capture handler runs.
      session = await openDelegateBoundary({
        systemPrompt: PERSONA,
        leadingExtensions: [leakFaultPath],
      });
      const subagents = await installSubagentModel(session);
      let seenPrompt = "";
      subagents.respond([
        (context) => {
          const sys = context.messages.find((m) => m.role === "system");
          seenPrompt = systemPromptText(sys);
          return fauxAssistantMessage("OK-NOLEAK");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "say ok" }],
      });

      expect(result.isError).toBe(false);
      expect(seenPrompt).toContain("PARENT-PERSONA");
      expect(seenPrompt).toContain(FRAMING);
      expect(seenPrompt).not.toContain("EXTENSION-GUIDELINE-MARKER");
      expect(seenPrompt).not.toContain("EXTENSION-SECTION-MARKER");
    },
  );

  test(
    "a force-replaced parent prompt skips inheritance with one logged warning",
    async () => {
      session = await openDelegateBoundary({
        leadingExtensions: [forcedFaultPath],
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const subagents = await installSubagentModel(session);
        let seenPrompt = "";
        subagents.respond([
          (context) => {
            const sys = context.messages.find((m) => m.role === "system");
            seenPrompt = systemPromptText(sys);
            return fauxAssistantMessage("OK-FORCED");
          },
        ]);

        const result = await callDelegate(session, {
          tasks: [{ prompt: "say ok" }],
        });

        expect(result.isError).toBe(false);
        expect(seenPrompt).not.toContain("FORCED-PARENT-PROMPT");
        expect(seenPrompt).toContain(FRAMING);
        expect(
          warn.mock.calls.some((call) =>
            String(call[0]).includes("force-replaced"),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    },
  );
});

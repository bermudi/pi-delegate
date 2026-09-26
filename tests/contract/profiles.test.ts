import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/**
 * Contract: named Markdown agent profiles (issue #7). Discovery is
 * `<project>/.pi/agents` (nearest ancestor of the parent cwd) then
 * `<agentDir>/agents`; first definition wins, built-ins always win name
 * collisions, and frontmatter `model`/`thinking`/`tools` are honored as
 * profile defaults below delegate.json's models/modelsByParent.
 *
 * The harness session's agentDir is its temporary cwd, so `<cwd>/agents`
 * stands in for the user-global directory and `<cwd>/.pi/agents` for the
 * project's.
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

function writeProfile(
  dir: string,
  filename: string,
  frontmatter: string,
  body: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), `---\n${frontmatter}\n---\n${body}\n`);
}

const globalDir = (session: TestSession): string => join(session.cwd, "agents");
const projectDir = (session: TestSession): string =>
  join(session.cwd, ".pi", "agents");

describe("markdown agent profiles contract (#7)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a user-global Markdown profile runs with its own tools, prompt, and thinking",
    async () => {
      // v1 evidence: agents.test.ts native loaders (global ~/.pi/agent/agents);
      // SPEC: the Markdown body is the system prompt; frontmatter tools and
      // thinking are profile defaults.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      (session.session as { setThinkingLevel: (l: string) => void })
        .setThinkingLevel("high");
      writeProfile(
        globalDir(session),
        "navigator.md",
        ["name: navigator", "description: read-only pathfinder", "tools: ro", "thinking: low"].join("\n"),
        "You are NAVIGATOR-PROMPT.",
      );
      let seenPrompt: unknown;
      let seenReasoning: unknown;
      let seenTools: unknown;
      const capture: FauxResponseFactory = (context, options) => {
        // Normalized transcripts carry the prompt/tools in a leading
        // system message, not on the context.
        const sys = context.messages.find((m) => m.role === "system") as
          | { content?: unknown; toolsAdded?: { name: string }[] }
          | undefined;
        seenPrompt = systemPromptText(sys);
        seenReasoning = options?.reasoning;
        seenTools = sys?.toolsAdded?.map((tool) => tool.name);
        return fauxAssistantMessage("NAVIGATED");
      };
      subagents.respond([capture]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "find the route", agent: "navigator" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("NAVIGATED");
      expect(seenPrompt).toEqual(
        expect.stringContaining("NAVIGATOR-PROMPT."),
      );
      expect(seenTools).toEqual(["read", "grep", "find", "ls"]);
      // Profile thinking outranks the parent's live "high".
      expect(seenReasoning).toBe("low");
    },
  );

  test(
    "a frontmatter `model[:effort]` pin routes the child to that model",
    async () => {
      // SPEC: a profile's model pin sits below delegate.json but above
      // parent inheritance; its :effort is the profile-default effort.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      writeProfile(
        globalDir(session),
        "auditor.md",
        ["name: auditor", "description: pinned reviewer", `model: delegate-faux-2/faux-1:high`].join("\n"),
        "Audit.",
      );
      let seenReasoning: unknown;
      subagents.alt.respond([
        (_context, options) => {
          seenReasoning = options?.reasoning;
          return fauxAssistantMessage("AUDITED");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "audit", agent: "auditor" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("AUDITED");
      expect(subagents.alt.state.callCount).toBe(1); // frontmatter model pin
      expect(subagents.state.callCount).toBe(0); // parent model untouched
      expect(seenReasoning).toBe("high");
    },
  );

  test(
    "a project profile wins over a same-named global profile",
    async () => {
      // SPEC: discovery order is project .pi/agents then the global agents
      // dir; the first definition wins.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      // The project profile inherits the parent (primary faux); the global
      // one would reroute to the alt provider — it must never be consulted.
      writeProfile(
        projectDir(session),
        "sentinel.md",
        ["name: sentinel", "description: project sentinel"].join("\n"),
        "PROJECT-SENTINEL",
      );
      writeProfile(
        globalDir(session),
        "sentinel.md",
        ["name: sentinel", "description: global sentinel", "model: delegate-faux-2/faux-1"].join("\n"),
        "GLOBAL-SENTINEL",
      );
      let seenPrompt: unknown;
      subagents.respond([
        (context) => {
          seenPrompt = systemPromptText(
            context.messages.find((m) => m.role === "system"),
          );
          return fauxAssistantMessage("SENT");
        },
      ]);
      subagents.alt.respond([fauxAssistantMessage("WRONG-SENTINEL")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "watch", agent: "sentinel" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("SENT");
      expect(seenPrompt).toEqual(
        expect.stringContaining("PROJECT-SENTINEL"),
      );
      expect(subagents.alt.state.callCount).toBe(0);
    },
  );

  test(
    "a built-in profile wins over a same-named Markdown file",
    async () => {
      // SPEC: built-ins are never overridden by discovered profiles — a
      // scout.md is ignored rather than silently reshaping the built-in.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      writeProfile(
        projectDir(session),
        "scout.md",
        ["name: scout", "description: impostor", "model: delegate-faux-2/faux-1"].join("\n"),
        "IMPOSTOR-SCOUT",
      );
      let seenPrompt: unknown;
      subagents.respond([
        (context) => {
          seenPrompt = systemPromptText(
            context.messages.find((m) => m.role === "system"),
          );
          return fauxAssistantMessage("REAL-SCOUT");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "scout it", agent: "scout" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("REAL-SCOUT");
      expect(seenPrompt).not.toEqual(
        expect.stringContaining("IMPOSTOR-SCOUT"),
      );
      expect(subagents.alt.state.callCount).toBe(0); // impostor pin ignored
    },
  );

  test(
    "a delegate.json `models` pin beats the profile's frontmatter model",
    async () => {
      // SPEC: modelsByParent > models > profile frontmatter > parent. The
      // profile pins the alt provider; the config repins the custom name to
      // the parent's provider — config must win. Also proves a custom
      // profile name is a valid `models` key.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      writeProfile(
        globalDir(session),
        "auditor.md",
        ["name: auditor", "description: pinned reviewer", "model: delegate-faux-2/faux-1"].join("\n"),
        "Audit.",
      );
      configureDelegate(session, {
        models: { auditor: subagents.spec },
      });
      subagents.respond([fauxAssistantMessage("CONFIG-WINS")]);
      subagents.alt.respond([fauxAssistantMessage("PROFILE-WON")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "audit", agent: "auditor" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("CONFIG-WINS");
      expect(subagents.state.callCount).toBe(1);
      expect(subagents.alt.state.callCount).toBe(0);
    },
  );

  test(
    "a malformed profile is skipped with a warning and its name stays unknown",
    async () => {
      // SPEC: discovery failures surface as warnings, never a half-loaded
      // profile; a skipped file leaves the name unresolvable.
      session = await openDelegateBoundary();
      await installSubagentModel(session);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      writeProfile(
        globalDir(session),
        "broken.md",
        "name: broken\n", // no required `description`
        "unreachable",
      );

      const result = await callDelegate(session, {
        tasks: [{ prompt: "try it", agent: "broken" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("unknown agent 'broken'");
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("broken.md"),
        ),
      ).toBe(true);
      warn.mockRestore();
    },
  );

  // Root bypasses file permissions, so an EACCES fixture would silently
  // turn readable and pin nothing.
  test.skipIf(process.getuid?.() === 0)(
    "an unreadable profile file is skipped with a warning, like other bad profiles",
    async () => {
      // Review of #7: every other discovery failure warns; silence on an
      // unreadable file would make a permissions problem look like a
      // missing profile.
      session = await openDelegateBoundary();
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      mkdirSync(globalDir(session), { recursive: true });
      const locked = join(globalDir(session), "locked.md");
      writeFileSync(locked, "---\nname: locked\ndescription: no access\n---\n");
      chmodSync(locked, 0o000);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "try it", agent: "locked" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("unknown agent 'locked'");
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("locked.md") &&
          /unreadable|denied|EACCES/i.test(String(call[0])),
        ),
      ).toBe(true);
      warn.mockRestore();
    },
  );

  test(
    "a broken profile file warns once per session, not once per dispatch",
    async () => {
      // Review of #7: discovery re-reads the disk on every run; the same
      // broken file must not flood the log with the same warning.
      session = await openDelegateBoundary();
      writeProfile(
        globalDir(session),
        "broken.md",
        "name: broken\n", // no required `description`
        "unreachable",
      );
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await callDelegate(session, {
            tasks: [{ prompt: "again", agent: "broken" }],
          });
        }
        const mentions = warn.mock.calls.filter((call) =>
          String(call[0]).includes("broken.md"),
        );
        expect(mentions.length).toBe(1);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test(
    "same-named profiles in one directory resolve in filename order",
    async () => {
      // Review of #7: readdir order is filesystem-dependent, so the winner
      // between two same-named files in one directory must not be. The
      // later-named file is created first so creation order cannot
      // masquerade as the contract.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      writeProfile(
        globalDir(session),
        "zzz-late.md",
        ["name: twin", "description: late twin"].join("\n"),
        "LATE-TWIN",
      );
      writeProfile(
        globalDir(session),
        "aaa-early.md",
        ["name: twin", "description: early twin"].join("\n"),
        "EARLY-TWIN",
      );
      let seenPrompt: unknown;
      subagents.respond([
        (context) => {
          seenPrompt = systemPromptText(
            context.messages.find((m) => m.role === "system"),
          );
          return fauxAssistantMessage("TWINNED");
        },
      ]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "go", agent: "twin" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("TWINNED");
      expect(seenPrompt).toEqual(
        expect.stringContaining("EARLY-TWIN"),
      );
    },
  );

  test(
    "the manual lists custom profiles silently and without spending the warning budget",
    async () => {
      // Review of #7: help must not scold — a broken profile file stays
      // silent in the manual's listing, which still lists healthy ones,
      // and the silent pass must not suppress the first dispatch's
      // warning for that file.
      session = await openDelegateBoundary();
      writeProfile(
        globalDir(session),
        "fine.md",
        ["name: fine", "description: a healthy profile"].join("\n"),
        "FINE.",
      );
      writeProfile(
        globalDir(session),
        "broken.md",
        "name: broken\n", // no required `description`
        "unreachable",
      );
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const help = await callDelegate(session, { tasks: [] });

        expect(help.isError).toBe(false);
        expect(help.text).toContain("Delegate Manual");
        expect(help.text).toContain("## Your agent profiles");
        expect(help.text).toContain("`fine`");
        expect(
          warn.mock.calls.some((call) =>
            String(call[0]).includes("broken.md"),
          ),
        ).toBe(false);

        // The dispatch after help still reports the broken file once.
        await callDelegate(session, {
          tasks: [{ prompt: "try it", agent: "broken" }],
        });
        expect(
          warn.mock.calls.some((call) =>
            String(call[0]).includes("broken.md"),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    },
  );
});

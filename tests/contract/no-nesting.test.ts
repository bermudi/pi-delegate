import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";
import { mockParentTools } from "../support/parent-tools.ts";

/**
 * Contract: no nesting and alias precedence (issue #45, SPEC v3
 * "Surface rules" / "Reflex meeting"). `delegate`, `delegate_ticket`,
 * and `delegate_session` are stripped — silently — from every inventory
 * a child can be given: explicit task `tools`, profile frontmatter
 * `tools`, and the mirrored parent set. And a discovered Markdown
 * profile claims its exact name ahead of the alias table, while
 * built-ins still win same-named collisions.
 *
 * The child's provider-visible toolset is observed through the
 * normalized transcript (`getCurrentTools`), the same seam the parent
 * tool-mirroring regression tests use.
 */

const DELEGATE_FAMILY = ["delegate", "delegate_ticket", "delegate_session"];

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

describe("no nested dispatch and profile precedence (SPEC v3, issue #45)", () => {
  let session: TestSession | undefined;
  const restores: (() => void)[] = [];

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    session?.dispose();
    session = undefined;
  });

  test("explicit task tools drop the delegate family silently", async () => {
    // #45: a trained caller may pass the dispatch family through — the
    // entries simply never exist in the child's inventory.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    let observed: string[] | undefined;
    subagents.respond([
      (context) => {
        observed = getCurrentTools(context.messages).map((tool) => tool.name).sort();
        return fauxAssistantMessage("NEST-FREE");
      },
    ]);

    const result = await callDelegate(session, {
      tasks: [
        {
          prompt: "work",
          tools: ["read", "delegate", "delegate_ticket", "delegate_session", "grep"],
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("NEST-FREE");
    expect(observed).toEqual(["grep", "read"]);
    for (const name of DELEGATE_FAMILY) expect(observed).not.toContain(name);
  });

  test("an inline task's default toolset carries no delegate tools", async () => {
    // #45 acceptance: the default/inline path — the `*` writer group
    // alone, never the dispatch family.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    let observed: string[] | undefined;
    subagents.respond([
      (context) => {
        observed = getCurrentTools(context.messages).map((tool) => tool.name).sort();
        return fauxAssistantMessage("INLINE-OK");
      },
    ]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "work" }],
    });

    expect(result.isError).toBe(false);
    expect(observed).toEqual(["bash", "edit", "read", "write"]);
    for (const name of DELEGATE_FAMILY) expect(observed).not.toContain(name);
  });

  test("the mirrored parent inventory never hands delegate tools down", async () => {
    // #45 acceptance: `agent: "default"` mirrors the parent's active
    // tools — a parent whose inventory includes the delegate family
    // still yields a child without them.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const mocked = mockParentTools(session, () => [
      "read",
      "write",
      ...DELEGATE_FAMILY,
    ]);
    restores.push(mocked.restore);
    let observed: string[] | undefined;
    subagents.respond([
      (context) => {
        observed = getCurrentTools(context.messages).map((tool) => tool.name).sort();
        return fauxAssistantMessage("MIRRORED");
      },
    ]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "default" }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("MIRRORED");
    expect(observed).toEqual(["read", "write"]);
  });

  test("a profile's frontmatter tools drop the delegate family too", async () => {
    // #45: profile `tools:` flows through the same strip — an authored
    // profile cannot smuggle dispatch into a child.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    writeProfile(
      globalDir(session),
      "recruiter.md",
      [
        "name: recruiter",
        "description: tries to fan out",
        "tools: read, delegate, delegate_session",
      ].join("\n"),
      "Recruit.",
    );
    let observed: string[] | undefined;
    subagents.respond([
      (context) => {
        observed = getCurrentTools(context.messages).map((tool) => tool.name).sort();
        return fauxAssistantMessage("PROFILE-CHILD");
      },
    ]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "recruiter" }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("PROFILE-CHILD");
    expect(observed).toEqual(["read"]);
  });

  test("a user profile named `general` claims the name — the alias never fires", async () => {
    // #45: discovered profiles rank above the alias table. `general.md`
    // is the user's agent; the `general` → `default` expansion must not
    // run, so no alias note and the profile's own prompt/tools apply.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    writeProfile(
      globalDir(session),
      "general.md",
      [
        "name: general",
        "description: the user's own generalist",
        "tools: ro",
      ].join("\n"),
      "You are USER-GENERAL-PROFILE.",
    );
    let observed: string[] | undefined;
    let seenPrompt = "";
    subagents.respond([
      (context) => {
        observed = getCurrentTools(context.messages).map((tool) => tool.name).sort();
        seenPrompt = systemPromptText(
          context.messages.find((m) => m.role === "system"),
        );
        return fauxAssistantMessage("CLAIMED");
      },
    ]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "work", agent: "general" }],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("CLAIMED");
    expect(result.text).not.toContain('agent "general" →');
    expect(seenPrompt).toContain("USER-GENERAL-PROFILE.");
    // The profile's `ro` frontmatter ran, not the default mirror.
    expect(observed).toEqual(["find", "grep", "ls", "read"]);
  });

  test("a claimed alias name is listed as itself, not under the built-in's aliases", async () => {
    // #45: the unknown-agent error still teaches the catalog — but a
    // profile-claimed alias name (`general`) must not be advertised as
    // `default`'s alias, since it resolves to the profile.
    session = await openDelegateBoundary();
    await installSubagentModel(session);
    writeProfile(
      globalDir(session),
      "general.md",
      ["name: general", "description: user generalist"].join("\n"),
      "Mine.",
    );

    const result = await callDelegate(session, {
      tasks: [{ prompt: "x", agent: "nonexistent-agent" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("unknown agent 'nonexistent-agent'");
    expect(result.text).toContain("general-purpose");
    expect(result.text).toContain("worker");
    expect(result.text).not.toMatch(/default \(aliases: [^)]*\bgeneral(,|\))/);
  });
});

import { describe, expect, test } from "bun:test";
import { stripInheritedProjectContext } from "./task-resolution.ts";

const START = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
const END = "\n</project_context>\n";

describe("stripInheritedProjectContext", () => {
  test("removes a normal project_context section", () => {
    const prompt = `BASE_PROMPT${START}<project_instructions path="/tmp/AGENTS.md">hello</project_instructions>${END}Current working directory: /tmp`;
    const stripped = stripInheritedProjectContext(prompt);
    expect(stripped).toBe("BASE_PROMPTCurrent working directory: /tmp");
    expect(stripped).not.toContain("hello");
  });

  test("regression: embedded </project_context> inside file does not terminate early", () => {
    const embedded = `file content with fake marker:${END}and more content after fake`;
    const prompt =
      `BASE_PROMPT${START}<project_instructions path="/home/daniel/.agents/AGENTS.md">\n${embedded}\n</project_instructions>\n\n` +
      `TAIL_SHOULD_BE_REMOVED${END}Current working directory: /tmp`;
    const stripped = stripInheritedProjectContext(prompt);
    // The whole project_context section including the tail after the embedded fake
    // must be removed, not leaked.
    expect(stripped).toBe("BASE_PROMPTCurrent working directory: /tmp");
    expect(stripped).not.toContain("TAIL_SHOULD_BE_REMOVED");
    expect(stripped).not.toContain("file content");
    expect(stripped).not.toContain("</project_context>");
  });

  test("returns original when no project_context present", () => {
    const prompt = "BASE_PROMPT with no context";
    expect(stripInheritedProjectContext(prompt)).toBe(prompt);
  });

  test("handles embedded marker with multiple files", () => {
    const prompt =
      `BASE${START}` +
      `<project_instructions path="/a">content A</project_instructions>\n\n` +
      `<project_instructions path="/b">content with${END}embedded</project_instructions>\n\n` +
      `SHOULD_BE_REMOVED${END}SUFFIX`;
    const stripped = stripInheritedProjectContext(prompt);
    expect(stripped).toBe("BASESUFFIX");
    expect(stripped).not.toContain("SHOULD_BE_REMOVED");
    expect(stripped).not.toContain("content A");
  });
});

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

// V2 review regression: opening a second boundary used to redirect the first
// boundary's config reads and pooled transcript writes through process.env.
test("overlapping boundaries keep config and transcripts session-local", async () => {
  const previous = process.env.DELEGATE_AGENT_DIR;
  const first = await openDelegateBoundary();
  const second = await openDelegateBoundary();
  try {
    expect(process.env.DELEGATE_AGENT_DIR).toBe(previous);
    const firstModel = await installSubagentModel(first);
    const secondModel = await installSubagentModel(second);
    configureDelegate(first, { models: { coder: firstModel.alt.spec } });
    configureDelegate(second, { models: { coder: secondModel.spec } });
    firstModel.alt.respond([fauxAssistantMessage("FIRST-BOUNDARY")]);
    secondModel.respond([fauxAssistantMessage("SECOND-BOUNDARY")]);

    const results = await Promise.all([
      callDelegate(first, {
        async: false,
        tasks: [{ agent: "coder", prompt: "first", sessionId: "pooled" }],
      }),
      callDelegate(second, {
        async: false,
        tasks: [{ agent: "coder", prompt: "second", sessionId: "pooled" }],
      }),
    ]);
    expect(results.map((result) => result.isError)).toEqual([false, false]);
    expect(firstModel.alt.state.callCount).toBe(1);
    expect(firstModel.state.callCount).toBe(0);
    expect(secondModel.state.callCount).toBe(1);
    expect(secondModel.alt.state.callCount).toBe(0);

    for (const [session, own, foreign] of [
      [first, "FIRST-BOUNDARY", "SECOND-BOUNDARY"],
      [second, "SECOND-BOUNDARY", "FIRST-BOUNDARY"],
    ] as const) {
      const directory = join(session.cwd, "delegate-sessions");
      const files = readdirSync(directory).filter((file) => file.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const transcript = readFileSync(join(directory, files[0]!), "utf8");
      expect(transcript).toContain(own);
      expect(transcript).not.toContain(foreign);
    }
    expect(process.env.DELEGATE_AGENT_DIR).toBe(previous);
  } finally {
    first.dispose();
    second.dispose();
  }
});

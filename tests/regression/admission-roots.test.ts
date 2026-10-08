import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

describe("admission root overlap (bugs 4+8)", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "delegate-v2-adm-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    session?.dispose();
    session = undefined;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a writer at / rejects with a subdir writer instead of bypassing overlap", async () => {
    // Bug 4: without the sep special-case, "/" + sep is "//", which no
    // absolute path starts with — so a writer at "/" never overlapped
    // anything and escaped both same-call serialization and cross-call
    // rejection. INVARIANTS: canonical ancestor roots overlap. Since #126
    // the detected overlap expresses as the unordered rejection: pre-fix
    // these landed in disjoint groups with no notice and both ran.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const dir = tempDir();
    subagents.respond([
      fauxAssistantMessage("ROOT-DONE"),
      fauxAssistantMessage("SUB-DONE"),
    ]);

    const result = await callDelegate(session, {
      async: false,
      tasks: [
        { prompt: "root writer", cwd: "/", tools: ["write"] },
        { prompt: "subdir writer", cwd: dir, tools: ["write"] },
      ],
    });
    expect(result.isError).toBe(true);
    // Overlap evidence: the unordered rejection names both tasks and the
    // remedies — only the canonical ancestor/descendant overlap produces
    // this message.
    expect(result.text).toMatch(/Unordered shared writers/i);
    expect(result.text).toMatch(/dependsOn/);
    expect(result.text).toMatch(/isolated/);
  });
});

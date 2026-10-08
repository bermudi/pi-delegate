import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

/**
 * #120: isolated worker worktrees are provisioned with the source root's
 * Git-ignored entries (e.g. node_modules) so suite-running tasks work.
 * All assertions go through the public delegate boundary: the worker's
 * own bash output, the source tree's bytes, and the task result text.
 */

function gitInit(dir: string): void {
  // An initial commit is required: isolated baselines are built on HEAD.
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir },
  );
}

/** A committed .gitignore plus an ignored marker dependency. */
function gitInitWithIgnoredDeps(dir: string): void {
  execSync(
    "git init -q && git config user.email t@t && git config user.name t",
    { cwd: dir },
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "dep-marker.txt"),
    "provisioned-dep-42\n",
  );
  execSync("git add .gitignore && git commit -qm init", { cwd: dir });
}

/** Concatenated toolResult text blocks of a worker transcript. */
function toolResultText(context: {
  messages: { role: string; content: unknown }[];
}): string {
  return context.messages
    .filter((message) => message.role === "toolResult")
    .map((message) =>
      (message.content as { type: string; text?: string }[])
        .map((block) => block.text ?? "")
        .join(""),
    )
    .join("");
}

describe("isolated worktree dependency provisioning contract (#120)", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "delegate-v2-prov-"));
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

  test(
    "an isolated worker sees provisioned ignored files",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInitWithIgnoredDeps(dir);

      // The verdict echoes the bash tool result only — the transcript
      // always contains the command's own text, so a raw search for the
      // marker string would self-match the probe.
      const respond: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage(`SAW:${toolResultText(context)}`);
        }
        return fauxAssistantMessage([
          fauxToolCall("bash", { command: "cat node_modules/dep-marker.txt" }),
        ]);
      };
      subagents.respond([respond, respond]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          {
            prompt: "Run: cat node_modules/dep-marker.txt",
            cwd: dir,
            workspace: "isolated",
            tools: ["bash"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("SAW:provisioned-dep-42");
      // The provisioned copy never leaks back into the source.
      expect(readFileSync(join(dir, "node_modules", "dep-marker.txt"), "utf8")).toBe(
        "provisioned-dep-42\n",
      );
    },
    30_000,
  );

  test(
    "worker-local mutations of provisioned files are discarded and never proposed",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInitWithIgnoredDeps(dir);

      const step: FauxResponseFactory = async (context) =>
        context.messages.some((m) => m.role === "toolResult")
          ? fauxAssistantMessage("DONE")
          : fauxAssistantMessage([
              fauxToolCall("bash", {
                command:
                  "echo changed >> node_modules/dep-marker.txt && echo hello > tracked.txt",
              }),
            ]);
      subagents.respond([step, step]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          {
            prompt:
              "Run: echo changed >> node_modules/dep-marker.txt && echo hello > tracked.txt",
            cwd: dir,
            workspace: "isolated",
            tools: ["bash"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      // The tracked edit reconciles into the source …
      expect(result.text).toMatch(/INTEGRATION: applied_unverified/);
      expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("hello\n");
      // … while the ignored file stays byte-identical in the source: the
      // worker mutated its own provisioned copy, discarded with the worktree.
      expect(readFileSync(join(dir, "node_modules", "dep-marker.txt"), "utf8")).toBe(
        "provisioned-dep-42\n",
      );
      // And no ignored path ever reaches the proposal surface.
      const proposedLines = result.text
        .split("\n")
        .filter((line) => line.startsWith("proposed: "));
      expect(proposedLines).toHaveLength(1);
      expect(proposedLines[0]).toContain("tracked.txt");
      expect(proposedLines[0]).not.toContain("node_modules");
    },
    30_000,
  );

  test(
    "delegate trees under an ignored in-repo agent dir are never provisioned",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInitWithIgnoredDeps(dir);
      // The agent dir lives inside the source repo and is gitignored: git
      // lists it under `!! `, and the delegate-isolated tree it holds
      // contains the workers' own worktrees — including this worker's
      // destination. Without the exclusion, provisioning either copies
      // sibling workers' live worktrees into every worker or fails the
      // whole group (fs.cp refuses copying a directory into itself).
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n.trees/\n");
      mkdirSync(join(dir, ".trees"), { recursive: true });
      execSync("git add .gitignore && git commit -qm ignore-trees", {
        cwd: dir,
      });

      const probe: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage(`PROBE:${toolResultText(context)}`);
        }
        return fauxAssistantMessage([
          fauxToolCall("bash", {
            command:
              "cat node_modules/dep-marker.txt; if [ -e .trees ]; then printf 'TREES_PRESENT'; else printf 'TREES_ABSENT'; fi",
          }),
        ]);
      };
      subagents.respond([probe, probe]);

      const previous = process.env.DELEGATE_AGENT_DIR;
      process.env.DELEGATE_AGENT_DIR = join(dir, ".trees");
      let result: Awaited<ReturnType<typeof callDelegate>>;
      try {
        result = await callDelegate(session, {
          async: false,
          tasks: [
            {
              prompt: "probe",
              cwd: dir,
              workspace: "isolated",
              tools: ["bash"],
            },
          ],
        });
      } finally {
        if (previous === undefined) delete process.env.DELEGATE_AGENT_DIR;
        else process.env.DELEGATE_AGENT_DIR = previous;
      }
      expect(result.isError).toBe(false);
      // Real ignored dependencies still provision…
      expect(result.text).toContain("PROBE:provisioned-dep-42");
      // …while the in-repo agent dir never reaches the worker.
      expect(result.text).toContain("TREES_ABSENT");
      expect(result.text).not.toContain("TREES_PRESENT");
    },
    30_000,
  );

  test(
    "a repository with no ignored entries dispatches isolated unchanged",
    async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const step: FauxResponseFactory = async (context) =>
        context.messages.some((m) => m.role === "toolResult")
          ? fauxAssistantMessage("DONE")
          : fauxAssistantMessage([
              fauxToolCall("write", { path: "out.txt", content: "ok\n" }),
            ]);
      subagents.respond([step, step]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          {
            prompt: "write out.txt",
            cwd: dir,
            workspace: "isolated",
            tools: ["write"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toMatch(/INTEGRATION: applied_unverified/);
      expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("ok\n");
    },
    30_000,
  );
});

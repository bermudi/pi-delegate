import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateDetached,
  callDelegateTicket,
  configureDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

function gitInit(dir: string): void {
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir },
  );
}

describe("delegate dependency graph and handoffs", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "delegate-v2-dep-"));
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
    "unknown, self-referencing, and cyclic dependencies reject before any task starts",
    async () => {
      // SPEC: the whole graph validates before any task starts; invalid
      // graphs are whole-call errors, not per-task failures.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const invalid: Record<string, unknown>[] = [
        // Unknown reference.
        {
          tasks: [
            { id: "a", prompt: "x" },
            { prompt: "y", dependsOn: ["nope"] },
          ],
        },
        // Self-dependency.
        {
          tasks: [{ id: "a", prompt: "x", dependsOn: ["a"] }],
        },
        // Two-task cycle.
        {
          tasks: [
            { id: "a", prompt: "x", dependsOn: ["b"] },
            { id: "b", prompt: "y", dependsOn: ["a"] },
          ],
        },
        // Generated-id ambiguity: tasks[0] answers to 'task-1' and
        // tasks[1] claims it explicitly — a reference cannot be resolved.
        {
          tasks: [
            { prompt: "x" },
            { id: "task-1", prompt: "y", dependsOn: ["task-1"] },
          ],
        },
      ];
      for (const arguments_ of invalid) {
        const result = await callDelegate(session, arguments_);
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/depend|cycle|ambiguous|unknown/i);
      }
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "a dependent runs only after its prerequisites and receives their output",
    async () => {
      // SPEC: a task starts only after every prerequisite finished; its
      // prompt carries each prerequisite's bounded final output.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const timeline: string[] = [];
      const prompts: string[] = [];
      const turn: FauxResponseFactory = async (context) => {
        const messages = JSON.stringify(context.messages);
        prompts.push(messages);
        // Dispatch on each task's own prompt phrase — prerequisite outputs
        // arrive inside handoffs and must not re-trigger their branches.
        if (messages.includes("BUILD the thing")) {
          timeline.push("build");
          return fauxAssistantMessage("BUILD-OUTPUT-TOKEN");
        }
        if (messages.includes("REVIEW the build")) {
          timeline.push("review");
          return fauxAssistantMessage("REVIEW-OUTPUT");
        }
        timeline.push("publish");
        return fauxAssistantMessage("PUBLISH-OUTPUT");
      };
      // Three calls: the chain is sequential, so the FIFO order is fixed.
      subagents.respond([turn, turn, turn]);

      const result = await callDelegate(session, {
        tasks: [
          // No explicit id: the generated 'task-1' is a valid reference.
          { prompt: "BUILD the thing" },
          { id: "review", prompt: "REVIEW the build", dependsOn: ["task-1"] },
          { prompt: "PUBLISH it", dependsOn: ["review"] },
        ],
      });
      expect(result.isError).toBe(false);
      expect(timeline).toEqual(["build", "review", "publish"]);

      // The dependent's prompt carries the prerequisite's output, labelled
      // as a handoff — not just raw text spliced in.
      const reviewPrompt = prompts.find((p) => p.includes("REVIEW"))!;
      expect(reviewPrompt).toContain("BUILD-OUTPUT-TOKEN");
      expect(reviewPrompt).toMatch(/handoff|prerequisite/i);
      const publishPrompt = prompts.find((p) => p.includes("PUBLISH"))!;
      expect(publishPrompt).toContain("REVIEW-OUTPUT");
    },
  );

  test(
    "a failed prerequisite blocks its dependent but unrelated branches still run",
    async () => {
      // SPEC: a dependent runs only if every prerequisite ended ok;
      // otherwise it is visibly blocked — consuming no worker — while
      // independent branches proceed.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      // A model-attributable failure does not retry; the free branch and
      // the failer each make exactly one provider call.
      const turn: FauxResponseFactory = async (context) => {
        if (JSON.stringify(context.messages).includes("FAILER")) {
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "usage limit exceeded; upgrade your plan",
          });
        }
        return fauxAssistantMessage("FREE-OUTPUT");
      };
      subagents.respond([turn, turn]);

      const result = await callDelegate(session, {
        tasks: [
          { id: "failer", prompt: "FAILER task" },
          { id: "dependent", prompt: "depends", dependsOn: ["failer"] },
          { id: "free", prompt: "FREE independent" },
        ],
      });
      // Two non-successes and one success → a normal (partial) result.
      expect(result.isError).toBe(false);
      // The dependent never reached a provider: blocked tasks consume no
      // worker, session, or slot.
      expect(subagents.state.callCount).toBe(2);

      const details = objectOf(result.details, "details");
      const results = details.results as
        | { id: string; status: string; error?: string; blockedBy?: string[] }[]
        | undefined;
      const byId = new Map(results?.map((r) => [r.id, r]));
      expect(byId.get("failer")?.status).toBe("failed");
      expect(byId.get("free")?.status).toBe("ok");
      const dependent = byId.get("dependent");
      expect(dependent?.status).toBe("blocked");
      expect(dependent?.blockedBy).toEqual(["failer"]);
      expect(result.text).toContain("blocked");
      expect(result.text).toMatch(/failer/);
    },
  );

  test(
    "blocking cascades through a chain with the original reason visible",
    async () => {
      // SPEC: blocking is per-edge; a blocked task blocks its own
      // dependents, and each blocked outcome names its prerequisites.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "usage limit exceeded; upgrade your plan",
        }),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { id: "a", prompt: "FAILER first" },
          { id: "b", prompt: "mid", dependsOn: ["a"] },
          { id: "c", prompt: "last", dependsOn: ["b"] },
        ],
      });
      const details = objectOf(result.details, "details");
      const results = details.results as
        | { id: string; status: string }[]
        | undefined;
      const byId = new Map(results?.map((r) => [r.id, r]));
      expect(byId.get("a")?.status).toBe("failed");
      expect(byId.get("b")?.status).toBe("blocked");
      expect(byId.get("c")?.status).toBe("blocked");
      // Only the failer consumed a worker.
      expect(subagents.state.callCount).toBe(1);
      // The leaf's block names its own prerequisite, keeping the chain
      // inspectable edge by edge.
      expect(result.text).toMatch(/'b'/);
    },
  );

  test(
    "a blocked dependent stays visible in async wait, poll, and delivery views",
    async () => {
      // SPEC "Dependencies and handoffs": a blocked task is a caller-
      // visible terminal status naming its blocking prerequisites and
      // their reasons. The sync result path proves it above; the async
      // ticket surfaces — wait, settled poll, and the delivered
      // `delegate-result` message — render from the same recorded
      // outcomes and must carry it too. This was the remaining half of
      // the issue #18 coverage gap: the 2026-09-26 hardening review
      // covered cancellation superseding the gate, but no async view of
      // a blocked outcome existed.
      session = await openDelegateBoundary();
      const host = session.session as AgentSession;
      const subagents = await installSubagentModel(session);

      const turn: FauxResponseFactory = async (context) => {
        if (JSON.stringify(context.messages).includes("FAILER")) {
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "usage limit exceeded; upgrade your plan",
          });
        }
        return fauxAssistantMessage("FREE-OUTPUT");
      };
      subagents.respond([turn, turn]);

      const sends = spyOn(host, "sendCustomMessage");
      const dispatched = await callDelegate(session, {
        tasks: [
          { id: "free", prompt: "FREE independent" },
          { id: "failer", prompt: "FAILER task" },
          { id: "dependent", prompt: "depends", dependsOn: ["failer"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(waited.isError).toBe(false);
      // The blocked dependent consumed no worker: after settlement only
      // the free branch and the failer ever reached the provider.
      expect(subagents.state.callCount).toBe(2);
      // One ok, one failed, one blocked → partial settlement.
      expect(waited.text).toContain("partial");
      expect(waited.text).toContain("blocked");
      expect(waited.text).toMatch(/'failer'/);
      const waitResults = objectOf(waited.details).results as
        | { id: string; status: string; error?: string; blockedBy?: string[] }[]
        | undefined;
      const byId = new Map(waitResults?.map((r) => [r.id, r]));
      expect(byId.get("free")?.status).toBe("ok");
      expect(byId.get("failer")?.status).toBe("failed");
      const dependent = byId.get("dependent");
      expect(dependent?.status).toBe("blocked");
      expect(dependent?.blockedBy).toEqual(["failer"]);
      expect(dependent?.error).toMatch(/'failer'/);

      // Settled polls keep the same visibility.
      const poll = await callDelegateTicket(session, {
        action: "poll",
        ticket,
      });
      expect(poll.text).toContain("blocked");
      const pollResults = objectOf(poll.details).results as
        | { id: string; status: string; blockedBy?: string[] }[]
        | undefined;
      expect(
        pollResults?.find((r) => r.id === "dependent")?.status,
      ).toBe("blocked");

      // The delivered delegate-result message carries the blocked
      // outcome: its content names the block, its details keep the
      // structured record.
      const end = Date.now() + 2000;
      while (sends.mock.calls.length === 0) {
        if (Date.now() > end) throw new Error("delivery never fired");
        await Bun.sleep(5);
      }
      const [message] = sends.mock.calls[0]!;
      expect(message.customType).toBe("delegate-result");
      expect(message.content).toContain("blocked");
      expect(message.content).toMatch(/'failer'/);
      const delivered = objectOf(message.details).results as
        | { id: string; status: string; blockedBy?: string[] }[]
        | undefined;
      const deliveredDependent = delivered?.find((r) => r.id === "dependent");
      expect(deliveredDependent?.status).toBe("blocked");
      expect(deliveredDependent?.blockedBy).toEqual(["failer"]);
    },
  );

  test(
    "a dependent on a scratch prerequisite receives output, not edits",
    async () => {
      // SPEC: a scratch prerequisite's edits are discarded with its copy;
      // only its output is handed off, and the handoff says so.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();

      const prompts: string[] = [];
      const turn: FauxResponseFactory = async (context) => {
        const messages = JSON.stringify(context.messages);
        prompts.push(messages);
        if (messages.includes("DEPENDENT")) {
          return fauxAssistantMessage("DEPENDENT-DONE");
        }
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("SCRATCH-FINDINGS");
        }
        return fauxAssistantMessage([
          fauxToolCall("write", { path: "scratch-only.txt", content: "x" }),
        ]);
      };
      subagents.respond([turn, turn, turn]);

      const result = await callDelegate(session, {
        tasks: [
          {
            id: "probe",
            prompt: "PROBE scratch",
            cwd: dir,
            tools: ["write"],
            workspace: "scratch",
          },
          {
            prompt: "DEPENDENT consume",
            cwd: dir,
            tools: ["read"],
            dependsOn: ["probe"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      // The scratch write stayed inside the discarded copy.
      expect(existsSync(join(dir, "scratch-only.txt"))).toBe(false);
      const dependentPrompt = prompts.find((p) => p.includes("DEPENDENT"))!;
      expect(dependentPrompt).toContain("SCRATCH-FINDINGS");
      expect(dependentPrompt).toMatch(/discarded/);
    },
  );

  test(
    "a dependent on an isolated prerequisite sees its applied changes, not just a summary",
    async () => {
      // SPEC: an isolated prerequisite's proposal applies before the
      // dependent phase starts, so a downstream reviewer reads the real
      // tree. Ordering the cross-kind pair is also what admits it.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      let dependentSawFile = false;
      const prompts: string[] = [];
      const turn: FauxResponseFactory = async (context) => {
        const messages = JSON.stringify(context.messages);
        prompts.push(messages);
        if (messages.includes("REVIEW")) {
          // The dependent's cwd is the source tree: the prerequisite's
          // applied file must already be there.
          dependentSawFile = existsSync(join(dir, "dep-built.txt"));
          return fauxAssistantMessage("REVIEW-DONE");
        }
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("BUILD-SUMMARY");
        }
        return fauxAssistantMessage([
          fauxToolCall("write", { path: "dep-built.txt", content: "built" }),
        ]);
      };
      subagents.respond([turn, turn, turn]);

      const result = await callDelegate(session, {
        tasks: [
          {
            id: "build",
            prompt: "BUILD the artifact",
            cwd: dir,
            tools: ["write"],
            workspace: "isolated",
          },
          {
            prompt: "REVIEW the applied work",
            cwd: dir,
            tools: ["read"],
            dependsOn: ["build"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      expect(dependentSawFile).toBe(true);
      expect(readFileSync(join(dir, "dep-built.txt"), "utf8")).toBe("built");
      // The handoff names the applied files so the reviewer knows to look.
      const dependentPrompt = prompts.find((p) => p.includes("REVIEW"))!;
      expect(dependentPrompt).toContain("dep-built.txt");
      expect(dependentPrompt).toContain("BUILD-SUMMARY");
    },
  );

  test(
    "an unordered shared/isolated overlap still rejects; dependsOn ordering admits it",
    async () => {
      // SPEC: same-call shared/isolated overlap is admitted only when the
      // graph orders every overlapping pair. The unordered case is pinned
      // by the workspace contract tests; this proves the ordered case runs.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const timeline: string[] = [];
      const turn: FauxResponseFactory = async (context) => {
        const messages = JSON.stringify(context.messages);
        if (context.messages.some((m) => m.role === "toolResult")) {
          timeline.push(messages.includes("SECOND") ? "second" : "first");
          return fauxAssistantMessage("DONE");
        }
        const file = messages.includes("SECOND")
          ? "second.txt"
          : "first.txt";
        return fauxAssistantMessage([
          fauxToolCall("write", { path: file, content: file }),
        ]);
      };
      subagents.respond([turn, turn, turn, turn]);

      const result = await callDelegate(session, {
        tasks: [
          {
            id: "first",
            prompt: "FIRST write",
            cwd: dir,
            tools: ["write"],
            workspace: "shared",
          },
          {
            prompt: "SECOND write",
            cwd: dir,
            tools: ["write"],
            workspace: "isolated",
            dependsOn: ["first"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      // The isolated task's baseline was taken after the shared write —
      // its proposal merges back on top of it, not beside it.
      expect(timeline).toEqual(["first", "second"]);
      expect(readFileSync(join(dir, "first.txt"), "utf8")).toBe("first.txt");
      expect(readFileSync(join(dir, "second.txt"), "utf8")).toBe("second.txt");
    },
  );

  test(
    "a handoff is bounded — only the prerequisite's output tail reaches the dependent",
    async () => {
      // SPEC: the handoff projection is bounded by
      // output.spillThresholdChars; the full output stays on the
      // prerequisite's own result.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        output: { spillThresholdChars: 40, spillTailChars: 40 },
      });

      const prompts: string[] = [];
      const turn: FauxResponseFactory = async (context) => {
        const messages = JSON.stringify(context.messages);
        prompts.push(messages);
        if (messages.includes("DEPENDENT")) {
          return fauxAssistantMessage("DEPENDENT-DONE");
        }
        return fauxAssistantMessage(`HEAD-${"x".repeat(200)}-TAIL`);
      };
      subagents.respond([turn, turn]);

      const result = await callDelegate(session, {
        tasks: [
          { id: "loud", prompt: "LOUD producer" },
          { prompt: "DEPENDENT consumer", dependsOn: ["loud"] },
        ],
      });
      expect(result.isError).toBe(false);
      const dependentPrompt = prompts.find((p) => p.includes("DEPENDENT"))!;
      // The tail survives; the truncated head does not.
      expect(dependentPrompt).toContain("-TAIL");
      expect(dependentPrompt).not.toContain("HEAD-x");
      // The prerequisite's own outcome keeps the complete output even
      // though its rendered section is spill-bounded too.
      const details = objectOf(result.details, "details");
      const results = details.results as { output?: string }[] | undefined;
      expect(results?.[0]?.output).toContain("HEAD-");
    },
  );

  test(
    "serialized shared writers hold no concurrency slot while waiting their turn",
    async () => {
      // INVARIANTS "Shared writes": serialization MUST NOT consume scarce
      // execution capacity while no task can execute. With a global bound
      // of 1, a successor that held the only slot while waiting for its
      // predecessor's quiescence would deadlock the whole batch — the
      // classic self-starvation. The default bound (3) cannot expose it.
      session = await openDelegateBoundary();
      configureDelegate(session, { maxConcurrent: 1 });
      const subagents = await installSubagentModel(session);
      const dir = mkdtempSync(join(tmpdir(), "delegate-v2-dep-"));
      dirs.push(dir);

      const timeline: string[] = [];
      const timed = (tag: string, text: string): FauxResponseFactory =>
        async () => {
          timeline.push(`start:${tag}`);
          await new Promise((r) => setTimeout(r, 30));
          timeline.push(`end:${tag}`);
          return fauxAssistantMessage(text);
        };
      subagents.respond([
        timed("first", "W1-DONE"),
        timed("second", "W2-DONE"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { id: "w1", prompt: "write one", cwd: dir, tools: ["write"] },
          { id: "w2", prompt: "write two", cwd: dir, tools: ["write"] },
        ],
      });
      expect(result.isError).toBe(false);
      // Both writers completed, strictly serialized in task order: the
      // successor's interval starts only after the predecessor ends.
      expect(timeline).toEqual([
        "start:first",
        "end:first",
        "start:second",
        "end:second",
      ]);
      expect(subagents.state.callCount).toBe(2);
    },
    10_000,
  );

  test(
    "a dependent waiting on its prerequisite holds no concurrency slot",
    async () => {
      // Same invariant through the dependency gate: while the prerequisite
      // is mid-run holding the ONLY slot, the waiting dependent must hold
      // nothing — at a global bound of 1 a slot-holding wait would starve
      // the batch. The dependent must not start until the prerequisite's
      // phase fully settles (confirmed quiescence included).
      session = await openDelegateBoundary();
      configureDelegate(session, { maxConcurrent: 1 });
      const subagents = await installSubagentModel(session);

      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((r) => (started = r));
      const gate = new Promise<void>((r) => (release = r));
      const respond: FauxResponseFactory = async (context) => {
        // Dispatch on the task's OWN first user message: the dependent's
        // transcript mentions PREREQ too, through the handoff appendix.
        const ownPrompt = context.messages.find((m) => m.role === "user");
        const ownText = ownPrompt
          ? typeof ownPrompt.content === "string"
            ? ownPrompt.content
            : ownPrompt.content
                .map((c) => (c.type === "text" ? c.text : ""))
                .join("")
          : "";
        if (ownText.startsWith("PREREQ")) {
          started();
          await gate;
          return fauxAssistantMessage("PREREQ-OUTPUT");
        }
        return fauxAssistantMessage("DEPENDENT-DONE");
      };
      subagents.respond([respond, respond, respond]);

      const pending = callDelegateDetached(session, {
        tasks: [
          { id: "prereq", prompt: "PREREQ runs first" },
          { prompt: "dependent waits", dependsOn: ["prereq"] },
        ],
      });
      await entered;
      // The prerequisite is mid-run; the dependent has not started.
      expect(subagents.state.callCount).toBe(1);

      release();
      const result = await pending;
      expect(result.isError).toBe(false);
      expect(result.text).toContain("PREREQ-OUTPUT");
      expect(result.text).toContain("DEPENDENT-DONE");
      expect(subagents.state.callCount).toBe(2);
    },
    10_000,
  );

  test(
    "a dependent reached after the batch is cancelled is cancelled, not blocked",
    async () => {
      // SPEC "Dependencies and handoffs": cancellation supersedes blocking
      // — a task reached while the batch is cancelled reports cancelled,
      // never `blocked` by its (now cancelled) prerequisite.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hanging: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("LATE");
      };
      subagents.respond([hanging, hanging]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { id: "root", prompt: "hangs" },
          { id: "child", prompt: "waits", dependsOn: ["root"] },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      const running = Date.now() + 5000;
      while (subagents.state.callCount < 1 && Date.now() < running) {
        await new Promise((r) => setImmediate(r));
      }
      expect(subagents.state.callCount).toBe(1);

      await callDelegateTicket(session, { action: "cancel", ticket, force: true });
      release();
      // The terminal view must settle with the child's status before the
      // unconfirmed note clears.
      const settled = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain(`Ticket "${ticket}": cancelled`);
      const childSection = settled.text.slice(
        settled.text.indexOf("### Task child"),
      );
      expect(childSection).toMatch(/### Task child — cancelled/);
      expect(childSection).not.toMatch(/blocked/);
    },
  );
});

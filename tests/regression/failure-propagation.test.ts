import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

describe("regression: failure propagation and retries", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a transient subagent failure retries the task and reports success",
    async () => {
      // v1 evidence: lifecycle.test.ts "transient error → retry → success" and
      // "rate-limit error → retry → success".
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "connection reset by peer",
        }),
        fauxAssistantMessage("RECOVERED"),
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "flaky" }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("RECOVERED");
      expect(subagents.state.callCount).toBe(2);
    },
  );

  test(
    "a usage limit does not retry on the same model and reports the account limit",
    async () => {
      // v1 evidence: lifecycle.test.ts "model-attributable error (usage limit)
      // → failureKind model_error, no whole-task retry, model-swap hint" and
      // delegate.test.ts "model_error failure → hint names the model field".
      // New v2 issue #26: preserve the no-retry regression, but don't
      // suggest switching models for a potentially time-bounded quota.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "usage limit exceeded; upgrade your plan",
        }),
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "quota-bound" }],
      });
      expect(result.text).toMatch(/usage limit|quota|upgrade/i);
      expect(result.text).toMatch(/account|limit resets/i);
      expect(result.text).toContain("No automatic resume");
      expect(subagents.state.callCount).toBe(1);
    },
  );

  test(
    "an incidentally-ordered cross-phase successor still runs after its predecessor fails",
    async () => {
      // #126 keeps cross-phase chaining semantics: a phase-1 writer whose
      // only edge is to a reader is incidentally ordered behind a phase-0
      // writer — sound serialization (a phase settles, quarantine included,
      // before the next admits) — and a failure MUST still let it run;
      // only graph dependents block on failure.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const cwd = session.cwd;

      const ran: string[] = [];
      const turn: FauxResponseFactory = async (context) => {
        const messages = JSON.stringify(context.messages);
        if (messages.includes('"w1"') || messages.includes("first writer")) {
          ran.push("first");
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "usage limit exceeded; upgrade your plan",
          });
        }
        if (messages.includes('"w2"') || messages.includes("second writer")) {
          ran.push("second");
          return fauxAssistantMessage("SECOND-RAN");
        }
        ran.push("reader");
        return fauxAssistantMessage("READ-OK");
      };
      subagents.respond([turn, turn, turn]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          { id: "w1", prompt: "first writer", cwd, tools: ["write"] },
          { id: "r", prompt: "scout", cwd, tools: ["read"] },
          { id: "w2", prompt: "second writer", cwd, tools: ["write"], dependsOn: ["r"] },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("SECOND-RAN");
      expect(ran).toContain("first");
      expect(ran).toContain("reader");
      expect(ran).toContain("second");
    },
  );

  test(
    "an unordered same-root pair whose predecessor would fail rejects instead of chaining",
    async () => {
      // #126 deliberately removed implicit failure-tolerant chaining: v1
      // (dispatch.test.ts "serialized successor still runs after a failed
      // predecessor") let an unordered pair run one-after-the-other with
      // the successor surviving the predecessor's failure. Unordered
      // overlap now rejects before execution; ordered pairs follow
      // dependency semantics (a failed prerequisite blocks dependents —
      // pinned in dependencies.test.ts). Failure-tolerant sequencing is
      // split calls or isolated.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const cwd = session.cwd;

      const ran: string[] = [];
      const fail: FauxResponseFactory = async () => {
        ran.push("first");
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "first writer exploded",
        });
      };
      const succeed: FauxResponseFactory = async () => {
        ran.push("second");
        return fauxAssistantMessage("SECOND-RAN");
      };
      subagents.respond([fail, succeed]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          { prompt: "w1", cwd,  tools: ["write"] },
          { prompt: "w2", cwd,  tools: ["write"] },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/Unordered shared writers/i);
      expect(ran).toEqual([]);
    },
  );

  test(
    "safe retries are not curtailed by a wall-clock budget",
    async () => {
      // #118: attempts and backoff have no task wall-clock limit.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "connection reset by peer",
        }),
        fauxAssistantMessage("RETRIED"),
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          { prompt: "flaky" },
        ],
      });
      expect(result.text).toContain("RETRIED");
      expect(subagents.state.callCount).toBe(2);
    },
  );

  test(
    "batch validation failure starts no tasks at all",
    async () => {
      // SPEC: invalid mode combinations and unresolved references fail the
      // whole call with an actionable error and no started tasks.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("SHOULD-NOT-RUN")]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          { prompt: "ok" },
          { prompt: "bad", agent: "nonexistent-agent" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(subagents.state.callCount).toBe(0);
      expect(result.text).not.toContain("SHOULD-NOT-RUN");
    },
  );
});

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
    "a serialized shared writer still runs after its predecessor fails",
    async () => {
      // v1 evidence: dispatch.test.ts "serialized successor still runs after
      // a failed predecessor". INVARIANTS: a predecessor failure MUST still
      // allow its successor to run.
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
      expect(result.text).toContain("SECOND-RAN");
      expect(ran).toEqual(["first", "second"]);
    },
  );

  test(
    "the deadline budget is shared across attempts and the retry backoff",
    async () => {
      // SPEC: deadlineMs is one wall-clock budget covering attempts and
      // backoff, not a fresh budget per attempt. deadlineMs (100) is shorter
      // than the retry backoff, so the second attempt must never start.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "connection reset by peer",
        }),
        fauxAssistantMessage("SHOULD-NOT-REACH"),
      ]);

      const result = await callDelegate(session, {
        async: false,
        tasks: [
          { prompt: "flaky",  deadlineMs: 100 },
        ],
      });
      expect(result.text).toMatch(/deadline/i);
      expect(result.text).not.toContain("SHOULD-NOT-REACH");
      expect(subagents.state.callCount).toBe(1);
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

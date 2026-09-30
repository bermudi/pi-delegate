import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { callDelegate, openDelegateBoundary } from "../support/pi-boundary.ts";

describe("regression: parent model-runtime grab", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a sabotaged runtime grab fails the whole call with the actionable error",
    async () => {
      // Issue #11: the grab of the TypeScript-private
      // `ctx.modelRegistry.runtime` must prove the value is the real
      // ModelRuntime class, not merely that something is present. This
      // injects a truthy impostor through the raw harness session — exactly
      // what a Pi upgrade repacking the registry would leave behind — and
      // expects dispatch to fail whole-call, before any task starts, with
      // the actionable error instead of blowing up later mid-dispatch.
      session = await openDelegateBoundary();

      // Fault injection at the host boundary: the extension's
      // `ctx.modelRegistry` is the extension runner's registry.
      const raw = session.session as unknown as {
        extensionRunner: { modelRegistry: { runtime?: unknown } };
      };
      raw.extensionRunner.modelRegistry.runtime = {
        getModel: () => undefined,
        getModels: () => [],
      };

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "never starts" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        "delegate cannot reach the parent session's model runtime; subagent dispatch is unavailable.",
      );
    },
  );
});

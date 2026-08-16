import { describe, expect, test } from "bun:test";
import { partitionExtensionLoadFailures } from "./provider-extensions.ts";

/**
 * Unit tests for the load-failure classification.
 *
 * The end-to-end behavior (fail closed for a user-configured root, silently
 * drop a shipped default) is covered against a real ResourceLoader in
 * `delegate.test.ts`. This exercises the decision itself, including the cases
 * that are awkward to stage with real packages: an error attributable to no
 * supplied root, and a root that loads cleanly but exposes nothing.
 */

const root = "/agent/git/example.com/org/required";
const bestEffort = "/agent/npm/node_modules/@vendor/optional";

describe("partitionExtensionLoadFailures", () => {
  test("a root that loaded an extension is neither fatal nor droppable", () => {
    expect(
      partitionExtensionLoadFailures({
        extensionPaths: [root],
        loadedExtensionPaths: [`${root}/extensions/main.ts`],
        extensionErrors: [],
        bestEffortRoots: new Set(),
      }),
    ).toEqual({ fatalCount: 0, droppableRoots: [] });
  });

  test("a required root that exposes no extension is fatal", () => {
    // A package can resolve and contribute only skills or prompts; a malformed
    // manifest can contribute nothing loadable. Either way the required
    // integration is absent.
    const result = partitionExtensionLoadFailures({
      extensionPaths: [root],
      loadedExtensionPaths: [],
      extensionErrors: [],
      bestEffortRoots: new Set(),
    });
    expect(result.fatalCount).toBe(1);
    expect(result.droppableRoots).toEqual([]);
  });

  test("a required root that errored is fatal", () => {
    const result = partitionExtensionLoadFailures({
      extensionPaths: [root],
      loadedExtensionPaths: [`${root}/extensions/main.ts`],
      extensionErrors: [{ path: `${root}/extensions/main.ts` }],
      bestEffortRoots: new Set(),
    });
    expect(result.fatalCount).toBe(1);
  });

  test("a best-effort root that failed is droppable, not fatal", () => {
    const result = partitionExtensionLoadFailures({
      extensionPaths: [bestEffort],
      loadedExtensionPaths: [],
      extensionErrors: [{ path: `${bestEffort}/extensions/main.ts` }],
      bestEffortRoots: new Set([bestEffort]),
    });
    expect(result.fatalCount).toBe(0);
    expect(result.droppableRoots).toEqual([bestEffort]);
  });

  test("an error claimed by no supplied root stays fatal", () => {
    // Attribution matters: an error from somewhere else is not licence to drop
    // an optional root and carry on as if the problem were understood.
    const result = partitionExtensionLoadFailures({
      extensionPaths: [bestEffort],
      loadedExtensionPaths: [`${bestEffort}/extensions/main.ts`],
      extensionErrors: [{ path: "/somewhere/else/extension.ts" }],
      bestEffortRoots: new Set([bestEffort]),
    });
    expect(result.fatalCount).toBe(1);
    expect(result.droppableRoots).toEqual([]);
  });

  test("a mixed batch reports the fatal root and the droppable one separately", () => {
    const result = partitionExtensionLoadFailures({
      extensionPaths: [root, bestEffort],
      loadedExtensionPaths: [],
      extensionErrors: [],
      bestEffortRoots: new Set([bestEffort]),
    });
    expect(result.fatalCount).toBe(1);
    expect(result.droppableRoots).toEqual([bestEffort]);
  });

  test("no supplied roots means nothing to classify", () => {
    expect(
      partitionExtensionLoadFailures({
        extensionPaths: [],
        loadedExtensionPaths: [],
        extensionErrors: [],
        bestEffortRoots: new Set(),
      }),
    ).toEqual({ fatalCount: 0, droppableRoots: [] });
  });
});

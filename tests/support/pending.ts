import { test } from "bun:test";

/**
 * Contract and regression tests for behavior the scaffold does not implement
 * yet. They compile and typecheck like ordinary tests, appear as `(todo)`
 * entries under `bun test`, and are executed for real with:
 *
 *   DELEGATE_RUN_PENDING=1 bun test
 *
 * In that mode every pending test is expected to fail against the scaffold's
 * not-implemented boundary — the failure message is the contract gap. When a
 * subsystem lands, flip its `pendingTest` calls to `test` and delete usages
 * that no longer exist.
 */
export const pendingTest = (
  process.env.DELEGATE_RUN_PENDING === "1" ? test : test.todo
) as typeof test;

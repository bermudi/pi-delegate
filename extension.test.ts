import { afterEach, describe, expect, test } from "bun:test";
import {
  _setShutdownDrainTimeoutForTesting,
  drainAsyncTickets,
} from "./extension.ts";

afterEach(() => {
  _setShutdownDrainTimeoutForTesting(undefined);
});

describe("shutdown cleanup", () => {
  test("bounds a shutdown drain when a worker never settles", async () => {
    _setShutdownDrainTimeoutForTesting(5);

    const result = await drainAsyncTickets([new Promise<void>(() => {})]);

    expect(result).toEqual({ drained: false, failures: [] });
  });
});

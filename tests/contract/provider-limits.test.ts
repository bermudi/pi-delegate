import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { callDelegate, installSubagentModel, openDelegateBoundary } from "../support/pi-boundary.ts";

describe("provider limit guidance (new v2 issue #26 contract)", () => {
  let session: TestSession | undefined;
  afterEach(() => { session?.dispose(); session = undefined; });

  test("a provider reset window is retained; no instant retry or false auto-resume promise", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "429 rate limit; Retry-After: 3600 seconds",
    })]);
    const result = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Retry-After: 3600 seconds");
    expect(result.text).toMatch(/no immediate retry|not.*retry/i);
    expect(result.text).toMatch(/no.*automatic resume/i);
    expect(model.state.callCount).toBe(1);
  });

  test("x-ratelimit-reset header holds a 429 without immediate retry", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "429 rate limit; x-ratelimit-reset: 3600 seconds",
    })]);
    const result = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("x-ratelimit-reset: 3600 seconds");
    expect(result.text).toMatch(/reported reset window|no immediate retry/i);
    expect(model.state.callCount).toBe(1);
  });

  test("a 403 rate limit with an explicit window is not misdiagnosed as authentication", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "403 rate limit resets in 3600 seconds",
    })]);
    const result = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("resets in 3600 seconds");
    expect(result.text).toMatch(/reported reset window/i);
    expect(result.text).not.toMatch(/authentication problem/i);
    expect(model.state.callCount).toBe(1);
  });

  test("snake_case 403 rate_limit_exceeded with a reset window is a provider limit", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "403 rate_limit_exceeded; resets in 3600 seconds",
    })]);
    const result = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("rate_limit_exceeded; resets in 3600 seconds");
    expect(result.text).toMatch(/reported reset window/i);
    expect(result.text).not.toMatch(/authentication problem/i);
    expect(model.state.callCount).toBe(1);
  });

  test("explicit invalid API key takes precedence over an unrelated reset header", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "401 invalid api key; x-ratelimit-reset: 3600",
    })]);
    const result = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid api key; x-ratelimit-reset: 3600");
    expect(result.text).toMatch(/authentication problem/i);
    expect(result.text).not.toMatch(/reported reset window/i);
    expect(model.state.callCount).toBe(1);
  });

  for (const errorMessage of [
    "401 API key is invalid; rate_limit: 10; x-ratelimit-reset: 3600",
    "401 invalid_api_key; x-rate-limit-reset: 3600",
  ]) {
    test(`explicit credentials outrank rate-limit fields: ${errorMessage}`, async () => {
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
      const result = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(errorMessage);
      expect(result.text).toMatch(/authentication problem/i);
      expect(result.text).not.toMatch(/reported reset window|temporary provider rate limit/i);
      expect(model.state.callCount).toBe(1);
    });
  }

  for (const errorMessage of ["403 rate_limit_exceeded", "403 rate-limit-exceeded"]) {
    test(`unhinted provider limit retries before side effects: ${errorMessage}`, async () => {
      session = await openDelegateBoundary();
      const model = await installSubagentModel(session);
      model.respond([
        fauxAssistantMessage("", { stopReason: "error", errorMessage }),
        fauxAssistantMessage("RECOVERED"),
      ]);
      const result = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
      expect(result.text).toContain("RECOVERED");
      expect(model.state.callCount).toBe(2);
    });
  }

  test("bare 403 stays an account problem even with an incidental reset header", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("", {
      stopReason: "error", errorMessage: "403 forbidden; rate_limit: 10; x-rate-limit-remaining: 0; x-ratelimit-reset: 3600",
    })]);
    const result = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
    expect(result.text).toMatch(/authentication problem/i);
    expect(result.text).not.toMatch(/reported reset window/i);
    expect(model.state.callCount).toBe(1);
  });

  test("short rate limit can retry, but exhausted quota is not misreported as temporary", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 too many requests" }),
      fauxAssistantMessage("RECOVERED"),
    ]);
    const retried = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
    expect(retried.text).toContain("RECOVERED");
    expect(model.state.callCount).toBe(2);
    model.respond([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient quota: upgrade your account" }),
    ]);
    const quota = await callDelegate(session, { async: false, tasks: [{ prompt: "report" }] });
    expect(quota.text).toMatch(/account|quota/i);
    expect(quota.text).not.toMatch(/temporary provider rate limit/i);
    expect(model.state.callCount).toBe(3);
  });
});

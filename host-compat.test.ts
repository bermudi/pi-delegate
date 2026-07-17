import { describe, expect, test } from "bun:test";
import {
  hostCompatResult,
  hostCompatError,
  _resetHostCompatCacheForTesting,
} from "./host-compat.ts";

const ALL_PRESENT = {
  ModelRuntime: class {},
  SettingsManager: class {},
  SessionManager: class {},
  DefaultResourceLoader: class {},
  createAgentSession: () => {},
  getAgentDir: () => "",
};

describe("host-compat guard", () => {
  test("returns null when every required symbol is present", () => {
    expect(hostCompatResult(ALL_PRESENT)).toBeNull();
  });

  test("names the missing symbol when one is absent", () => {
    const ns = { ...ALL_PRESENT, ModelRuntime: undefined };
    const result = hostCompatResult(ns);
    expect(result).not.toBeNull();
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain("'ModelRuntime'");
    expect(text).toContain("version mismatch");
    expect(text).toContain("bun run build");
  });

  test("lists every missing symbol when the namespace is empty", () => {
    const result = hostCompatResult({});
    expect(result).not.toBeNull();
    const text = (result!.content[0] as { text: string }).text;
    // All six required symbols should be called out.
    expect((text.match(/'/g) ?? []).length / 2).toBe(6);
    expect(result!.details.tasks).toEqual([]);
    expect(result!.details.results).toEqual([]);
  });

  test("real installed pi exports all required symbols (no compat error)", () => {
    _resetHostCompatCacheForTesting();
    expect(hostCompatError()).toBeNull();
  });
});

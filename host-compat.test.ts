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
  parseFrontmatter: () => ({}),
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
    // All seven required symbols should be called out (the count must stay
    // in sync with REQUIRED_SYMBOLS in host-compat.ts — if you add a symbol
    // there, bump this).
    expect((text.match(/'/g) ?? []).length / 2).toBe(7);
    expect(result!.details.tasks).toEqual([]);
    expect(result!.details.results).toEqual([]);
  });

  test("real installed pi exports all required symbols (no compat error)", () => {
    _resetHostCompatCacheForTesting();
    expect(hostCompatError()).toBeNull();
  });
});

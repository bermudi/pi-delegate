import { describe, expect, test } from "bun:test";
import {
  hostCompatResult,
  hostCompatError,
  _resetHostCompatCacheForTesting,
} from "./host-compat.ts";

const classWithStaticCreate = class {
  static create(): never {
    throw new Error("should not call");
  }
};

const classWithStaticCreateAndOpen = class {
  static create(): never {
    throw new Error("should not call");
  }
  static open(): never {
    throw new Error("should not call");
  }
};

const ALL_PRESENT = {
  ModelRuntime: classWithStaticCreate,
  SettingsManager: classWithStaticCreate,
  SessionManager: classWithStaticCreateAndOpen,
  DefaultResourceLoader: class {},
  DefaultPackageManager: class {},
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
    // All required exports/members should be called out (the count must stay
    // in sync with REQUIRED_EXPORTS in host-compat.ts — if you add a member,
    // bump this).
    expect((text.match(/'/g) ?? []).length / 2).toBe(9);
    expect(result!.details.tasks).toEqual([]);
    expect(result!.details.results).toEqual([]);
  });

  test("reports missing required static members", () => {
    const ModelRuntimeWithoutCreate = class {};
    const SessionManagerWithoutOpen = class {
      static create(): never {
        throw new Error("no-op");
      }
    };

    const ns = {
      ...ALL_PRESENT,
      ModelRuntime: ModelRuntimeWithoutCreate,
      SessionManager: SessionManagerWithoutOpen,
    };

    const result = hostCompatResult(ns);
    expect(result).not.toBeNull();
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain("'ModelRuntime.create'");
    expect(text).toContain("'SessionManager.open'");
  });

  test("real installed pi exports all required symbols (no compat error)", () => {
    _resetHostCompatCacheForTesting();
    expect(hostCompatError()).toBeNull();
  });
});

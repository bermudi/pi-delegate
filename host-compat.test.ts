import { describe, expect, test } from "bun:test";
import {
  hostCompatResult,
  hostCompatError,
  _resetHostCompatCacheForTesting,
} from "./host-compat.ts";

/**
 * Host-compatibility guard tests.
 *
 * These are pure unit tests for `hostCompatResult` — a function that takes a
 * plain namespace object and reports missing Pi exports/members. They do not
 * require a live Pi `AgentSession`, so the Pi test harness is not used here.
 * The harness (`@marcfargas/pi-test-harness` → `createTestSession`) is for
 * integration tests that exercise real extension loading, tool registration,
 * and the agent loop (see `delegate.test.ts`, `lifecycle.test.ts`). For this
 * guard, a lightweight namespace fixture is the appropriate level and avoids
 * the session boot cost. The last test verifies the real installed Pi exports
 * via `hostCompatError()` as an integration smoke check.
 * See harness docs: https://github.com/marcfargas/pi-test-harness#readme
 */

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
  static inMemory(): never {
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
    expect((text.match(/'/g) ?? []).length / 2).toBe(10);
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
    expect(text).toContain("'SessionManager.inMemory'");
  });

  test("real installed pi exports all required symbols (no compat error)", () => {
    _resetHostCompatCacheForTesting();
    expect(hostCompatError()).toBeNull();
  });
});

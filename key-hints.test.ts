import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { toolExpandHint } from "./key-hints.ts";

describe("toolExpandHint", () => {
  test("loads when an older Pi host omits the optional keyText export", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "delegate-key-hint-compat-"));
    const hostDir = join(
      fixtureDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        type: "module",
        exports: "./index.js",
      }),
    );
    // Deliberately no keyText export. Node rejects a named import while a
    // namespace import remains load-compatible and lets the fallback run.
    writeFileSync(join(hostDir, "index.js"), "export const legacy = true;\n");

    try {
      const output = join(fixtureDir, "key-hints.mjs");
      await build({
        entryPoints: [join(import.meta.dirname, "key-hints.ts")],
        outfile: output,
        bundle: true,
        format: "esm",
        platform: "node",
        external: ["@earendil-works/pi-coding-agent"],
        logLevel: "silent",
      });
      writeFileSync(
        join(fixtureDir, "verify.mjs"),
        [
          'import { toolExpandHint } from "./key-hints.mjs";',
          'if (toolExpandHint() !== "") throw new Error("expected no hint");',
        ].join("\n"),
      );
      expect(() =>
        execFileSync("node", [join(fixtureDir, "verify.mjs")], {
          cwd: fixtureDir,
          stdio: "pipe",
        }),
      ).not.toThrow();
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uses the effective Pi keybinding instead of a hardcoded shortcut", () => {
    expect(toolExpandHint("expand", () => "alt+x")).toBe("Alt+X expand");
  });

  test("omits the shortcut when the action is unbound", () => {
    expect(toolExpandHint("expand", () => "")).toBe("");
  });

  test("omits the shortcut if keybinding lookup is unavailable", () => {
    expect(
      toolExpandHint("expand", () => {
        throw new Error("keybindings unavailable");
      }),
    ).toBe("");
  });
});

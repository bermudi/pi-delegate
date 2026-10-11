#!/usr/bin/env bun
// Packed-artifact smoke (umbrella #138, E3): the npm tarball is what Pi
// actually installs — a green suite says nothing about it.
//
//   1. `bun pm pack` the repo into a temp dir.
//   2. Untar and assert the package.json `files` contract: delegate.ts, a
//      nonempty src/, README.md, COMPATIBILITY.md are present — and that
//      patches/, tests/, scripts/, and node_modules are NOT shipped.
//   3. Bundle-build the UNPACKED delegate.ts with the same esbuild options
//      as package.json's build script — the tarball must be
//      self-sufficient (every relative import resolvable).

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(join(import.meta.dir, ".."));
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const work = mkdtempSync(join(tmpdir(), "pi-delegate-pack-"));
try {
  execFileSync(
    "bun",
    ["pm", "pack", "--destination", work, "--ignore-scripts", "--quiet"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const produced = readdirSync(work).filter((name) => name.endsWith(".tgz"));
  if (produced.length !== 1) {
    console.error(`expected exactly one tarball in ${work}, got: ${produced.join(", ") || "none"}`);
    process.exit(1);
  }
  const tgz = join(work, produced[0]!);
  const unpack = join(work, "unpacked");
  mkdirSync(unpack);
  execFileSync("tar", ["-xzf", tgz, "-C", unpack]);
  const pkg = join(unpack, "package");

  const entries = readdirSync(pkg).sort();
  console.log(`       tarball entries: ${entries.join(", ")}`);

  const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
  const srcDir = join(pkg, "src");
  const srcFiles = existsSync(srcDir)
    ? readdirSync(srcDir).filter((name) => name.endsWith(".ts"))
    : [];

  check("pack:delegate.ts", isFile(join(pkg, "delegate.ts")));
  check("pack:src-nonempty", srcFiles.length > 0, `${srcFiles.length} .ts files`);
  check("pack:README.md", isFile(join(pkg, "README.md")));
  check("pack:COMPATIBILITY.md", isFile(join(pkg, "COMPATIBILITY.md")));
  check("pack:no-patches", !existsSync(join(pkg, "patches")));
  check("pack:no-tests", !existsSync(join(pkg, "tests")));
  check("pack:no-scripts", !existsSync(join(pkg, "scripts")));
  check("pack:no-node_modules", !existsSync(join(pkg, "node_modules")));
  {
    // Every top-level shipped entry must be named in package.json `files`.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { files: string[] };
    const allowed = new Set([...manifest.files, "package.json"]);
    const extra = entries.filter((entry) => !allowed.has(entry));
    check(
      "pack:files-manifest-match",
      extra.length === 0,
      extra.length === 0
        ? "all entries covered by `files`"
        : `unexpected: ${extra.join(", ")}`,
    );
  }

  if (isFile(join(pkg, "delegate.ts")) && srcFiles.length > 0) {
    const outfile = join(work, "delegate.bundle.ts");
    const esbuild = await import("esbuild");
    try {
      await esbuild.build({
        entryPoints: [join(pkg, "delegate.ts")],
        bundle: true,
        platform: "neutral",
        packages: "external",
        format: "esm",
        banner: { js: "// @ts-nocheck" },
        outfile,
      });
      check(
        "pack:bundle-builds",
        statSync(outfile).size > 0,
        `${statSync(outfile).size} bytes`,
      );
    } catch (error) {
      check(
        "pack:bundle-builds",
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    check("pack:bundle-builds", false, "skipped — delegate.ts/src missing");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} pack assertion(s) failed`);
  process.exit(1);
}

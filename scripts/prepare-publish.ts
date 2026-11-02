#!/usr/bin/env bun
// Strip dev-only fields from package.json immediately before `npm publish`.
//
// `patchedDependencies` declares the local pi-test-harness compatibility patch
// under patches/, which is deliberately NOT shipped: package.json `files`
// excludes patches/, and scripts/pack-smoke.ts asserts `pack:no-patches`. A
// declaration whose patch file is absent is worse than useless downstream —
// bun's docs are explicit that it reads the field from the root package.json
// ("Bun only reads it from the root `package.json`") and that "`bun install`
// and `bun patch` fail when a file in `patchedDependencies` does not exist" —
// so any consumer installing the published package with bun hard-fails.
//
// No packer drops it for us, so the strip must be explicit. Verified
// 2026-11-02: npm 11.21.1 (the npm bundled with CI's Node 24), `npm publish`,
// and `bun pm pack` all keep the field; only npm 12 happens to omit it, which
// is a version accident, not a contract. Do not let the release depend on it.
//
// This runs in the disposable CI checkout: it mutates package.json in place so
// the unchanged `npm publish --access public` packs the clean manifest. It
// then proves its own work by packing with npm (the publisher's own packer)
// into a temp dir and asserting no dev-only field survived into the tarball.
//
// Local runs mutate your package.json. Restore with `git checkout -- package.json`.
//
// Usage: bun scripts/prepare-publish.ts

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(join(import.meta.dir, ".."));
const MANIFEST = join(ROOT, "package.json");

/**
 * Fields that exist only for this repo's own development install and must
 * never reach the published tarball. Add here when another such field appears.
 */
const DEV_ONLY_FIELDS = ["patchedDependencies"] as const;

function die(message: string): never {
  console.error(`[prepare-publish] FAIL: ${message}`);
  process.exit(1);
}

function log(message: string): void {
  console.error(`[prepare-publish] ${message}`);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;

const stripped = DEV_ONLY_FIELDS.filter((field) => field in manifest);
if (stripped.length === 0) {
  log("no dev-only fields present; package.json unchanged");
} else {
  for (const field of stripped) delete manifest[field];
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`stripped from package.json: ${stripped.join(", ")}`);
}

// Prove the strip against the real packer rather than trusting the edit: pack
// with npm, unpack, and read the manifest that would land on the registry.
const work = mkdtempSync(join(tmpdir(), "pi-delegate-prepublish-"));
try {
  execFileSync("npm", ["pack", "--pack-destination", work, "--ignore-scripts", "--quiet"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarballs = readdirSync(work).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    die(`expected exactly one packed tarball, got: ${tarballs.join(", ") || "none"}`);
  }
  const unpack = join(work, "unpacked");
  mkdirSync(unpack);
  execFileSync("tar", ["-xzf", join(work, tarballs[0]!), "-C", unpack]);
  const packed = JSON.parse(
    readFileSync(join(unpack, "package", "package.json"), "utf8"),
  ) as Record<string, unknown>;

  for (const field of DEV_ONLY_FIELDS) {
    if (field in packed) die(`"${field}" survived into the packed manifest`);
  }
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    die(
      `packed identity ${String(packed.name)}@${String(packed.version)} differs from ` +
        `package.json ${String(manifest.name)}@${String(manifest.version)}`,
    );
  }
  log(`packed manifest verified clean: ${String(packed.name)}@${String(packed.version)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

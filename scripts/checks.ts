#!/usr/bin/env bun
// Static enforcement checks for the pi-delegate tree (umbrella #138, E3).
//
// Each check prints one named pass/fail line; the script exits nonzero if
// any check fails. Everything here is hand-rolled scanning over
// `delegate.ts` + `src/*.ts` — the import graph additionally parses each
// file with the TypeScript compiler API (an existing devDep, nothing new).
//
// Checks:
//   1. module-mutability   no top-level `let`/`var` (AGENTS.md constraint,
//                          the enforcement map's named ladder candidate).
//   2. private-reach       fragile host-internal spellings stay inside
//                          src/pi-compat.ts; `installSubagentModel` (test
//                          harness) never enters production files.
//   3. import-cycles       the static import graph is acyclic.
//   4. details-strictness  every Type.Object in src/details.ts carries
//                          `additionalProperties: false`, and `durationMs`
//                          (journal-only, #127) stays out of every schema.
//   5. diagnostic-context  every diagnostics log call's context keys are in
//                          the CONTEXT_KEYS allowlist in src/diagnostics.ts.
//   6. retry-disabled      the child AgentSession's host auto-retry stays
//                          disabled in memory (verbatim literal pin).
//   7. unused-exports      incremental dead-export ratchet against
//                          scripts/unused-exports-baseline.txt.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(join(import.meta.dir, ".."));
const SRC_DIR = join(ROOT, "src");
const BASELINE = join(ROOT, "scripts", "unused-exports-baseline.txt");

const files: string[] = [join(ROOT, "delegate.ts")];
for (const name of readdirSync(SRC_DIR).sort()) {
  if (name.endsWith(".ts")) files.push(join(SRC_DIR, name));
}
const rel = (path: string): string =>
  path === join(ROOT, "delegate.ts") ? "delegate.ts" : `src/${basename(path)}`;

const sources = new Map<string, string>();
for (const path of files) sources.set(path, readFileSync(path, "utf8"));

/** Replace comments and string/template contents with spaces (positions and
 * line numbers preserved) so scanners see code structure only. */
function stripCommentsAndStrings(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < out.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const start = i;
      while (i < out.length && source[i] !== "\n") i++;
      blank(start, i);
    } else if (c === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < out.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i = Math.min(i + 2, out.length);
      blank(start, i);
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = i;
      i++;
      while (i < out.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i = Math.min(i + 1, out.length);
      blank(start, i);
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Replace comments only (strings preserved, for import-specifier parsing). */
function stripComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < out.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const start = i;
      while (i < out.length && source[i] !== "\n") i++;
      blank(start, i);
    } else if (c === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < out.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i = Math.min(i + 2, out.length);
      blank(start, i);
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < out.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i = Math.min(i + 1, out.length);
    } else {
      i++;
    }
  }
  return out.join("");
}

const stripped = new Map<string, string>();
const codeOnly = new Map<string, string>();
for (const [path, source] of sources) {
  stripped.set(path, stripComments(source));
  codeOnly.set(path, stripCommentsAndStrings(source));
}

/** Match `(` at `openIndex` to its closing `)` inside code-with-strings-stripped
 * text; returns the index of the close. Throws when unbalanced. */
function matchParen(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced delimiters");
}

/** Split a delimited argument list (the text BETWEEN the outer parens) at
 * top-level commas. */
function splitTopLevel(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  args.push(text.slice(start));
  return args.map((arg) => arg.trim());
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

interface CheckResult {
  name: string;
  failures: string[];
  warnings: string[];
  note: string;
}
const results: CheckResult[] = [];
function record(name: string, note: string, failures: string[], warnings: string[] = []): void {
  results.push({ name, failures, warnings, note });
}

// ---------------------------------------------------------------------------
// 1. No module-level mutable state.
// ---------------------------------------------------------------------------
{
  const failures: string[] = [];
  for (const [path, code] of codeOnly) {
    let depth = 0;
    let parenDepth = 0;
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if (c === "{") {
        depth++;
        continue;
      }
      if (c === "}") {
        depth--;
        continue;
      }
      if (c === "(" || c === "[") {
        parenDepth++;
        continue;
      }
      if (c === ")" || c === "]") {
        parenDepth--;
        continue;
      }
      if (
        depth === 0 &&
        parenDepth === 0 &&
        (c === "l" || c === "v") &&
        (i === 0 || !/[\w$]/.test(code[i - 1]!))
      ) {
        const rest = code.slice(i);
        const match = /^(?:let|var)\s+[A-Za-z_$][\w$]*/.exec(rest);
        if (match) {
          failures.push(
            `${rel(path)}:${lineOf(code, i)} module-level \`${match[0].split(/\s+/)[0]} ${match[0].split(/\s+/)[1]}\``,
          );
        }
      }
    }
  }
  record(
    "module-mutability",
    "no module-scope let/var in delegate.ts or src/*.ts",
    failures,
  );
}

// ---------------------------------------------------------------------------
// 2. Private-host-reach containment.
// ---------------------------------------------------------------------------
{
  // `parentModelRuntime` is pi-compat's own exported wrapper — its call
  // sites in host.ts/delegate.ts are the blessed path. These spellings are
  // host internals (or the test-harness-only `installSubagentModel`) that
  // must stay inside src/pi-compat.ts or out of production entirely.
  const forbidden = [
    "_modelRuntime",
    "setRuntimeApiKey",
    "transformMessages",
    "installSubagentModel",
    "streamFunction",
    "_rewriteFile",
  ];
  const pattern = new RegExp(
    `\\b(${forbidden.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "g",
  );
  const failures: string[] = [];
  for (const [path, code] of codeOnly) {
    if (rel(path) === "src/pi-compat.ts") continue;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      failures.push(
        `${rel(path)}:${lineOf(code, match.index)} uses \`${match[1]}\` outside src/pi-compat.ts`,
      );
    }
  }
  record(
    "private-reach",
    `forbidden host-internal spellings outside src/pi-compat.ts: ${forbidden.join(", ")}`,
    failures,
  );
}

// ---------------------------------------------------------------------------
// Shared: static import graph over delegate.ts + src/*.ts.
// ---------------------------------------------------------------------------
interface ModuleGraph {
  edges: Map<string, string[]>;
  /** names imported per target path */
  imported: Map<string, Set<string>>;
  /** names re-exported by each path (`export { x } from "./y"`) */
  reExported: Map<string, Set<string>>;
  /** files importing a target wholesale (`import * as`) */
  starImported: Set<string>;
}
interface ModuleSpecifier {
  /** The `./x.ts` specifier text, unresolved. */
  readonly spec: string;
  /** Exported names the clause refers to ("default" for default bindings).
   * Recorded for usage accounting even when the specifier is type-only —
   * importing a type still uses the export. */
  readonly names: readonly string[];
  /** `export ... from` — names are consumed AND re-exported by this file. */
  readonly reExport: boolean;
  /** `import * as` / `export *` — consumes the target's whole surface. */
  readonly star: boolean;
  /** Names this file's own export surface gains — for `export { a as b }`,
   * `names` carries the consumed target name `a` while `provided` carries
   * the visible re-export `b`; `export * as ns` provides `ns`. */
  readonly provided: readonly string[];
  /** False for a wholly type-only declaration: it uses the module's exports
   * (names still count) but produces no runtime edge, so it cannot take part
   * in an import cycle. */
  readonly runtime: boolean;
}

/**
 * Every module specifier a file carries, via the TypeScript parser —
 * default/named/namespace imports, side-effect imports, `export ... from`
 * re-exports, `import = require()`, and dynamic `import()`. A declaration
 * that is wholly type-only records its names but no runtime edge;
 * per-element `type` modifiers inside a runtime clause still count as uses.
 */
function collectSpecifiers(source: string, fileName: string): ModuleSpecifier[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out: ModuleSpecifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause === undefined) {
        out.push({
          spec,
          names: [],
          reExport: false,
          star: false,
          runtime: true,
          provided: [],
        });
      } else {
        const names: string[] = [];
        let star = false;
        if (clause.name !== undefined) names.push("default");
        const bindings = clause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) {
            star = true;
          } else {
            for (const el of bindings.elements) {
              names.push((el.propertyName ?? el.name).text);
            }
          }
        }
        out.push({
          spec,
          names,
          reExport: false,
          star,
          runtime: !clause.isTypeOnly,
          provided: [],
        });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      const clause = node.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        out.push({
          spec,
          names: [],
          reExport: true,
          star: true,
          runtime: !node.isTypeOnly,
          // `export *` re-provides the target's surface anonymously;
          // `export * as ns` provides `ns` as this file's export name.
          provided:
            clause === undefined ? [] : [clause.name.text],
        });
      } else {
        // `export { a as b }`: `names` is what the target must provide
        // (`a`), `provided` is what importers of this file see (`b`).
        const names = clause.elements.map(
          (el) => (el.propertyName ?? el.name).text,
        );
        out.push({
          spec,
          names,
          reExport: true,
          star: false,
          runtime: !node.isTypeOnly,
          provided: clause.elements.map((el) => el.name.text),
        });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (
        ts.isExternalModuleReference(ref) &&
        ref.expression !== undefined &&
        ts.isStringLiteral(ref.expression)
      ) {
        out.push({
          spec: ref.expression.text,
          names: ["default"],
          reExport: false,
          star: false,
          runtime: !node.isTypeOnly,
          provided: [],
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      // `import("x")` (a second argument is an import-attributes object)
      // or `require("x")` — both produce runtime edges.
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      out.push({
        spec: node.arguments[0].text,
        names: ["default"],
        reExport: false,
        star: false,
        runtime: true,
        provided: [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function buildGraph(): ModuleGraph {
  const edges = new Map<string, string[]>();
  const imported = new Map<string, Set<string>>();
  const reExported = new Map<string, Set<string>>();
  const starImported = new Set<string>();
  for (const [path] of sources) edges.set(path, []);
  const resolveSpecifier = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
    const target = resolve(join(dirname(from), spec));
    return sources.has(target) ? target : undefined;
  };
  for (const [path, source] of sources) {
    for (const entry of collectSpecifiers(source, path)) {
      const target = resolveSpecifier(path, entry.spec);
      if (target === undefined) continue;
      if (entry.runtime) edges.get(path)!.push(target);
      if (entry.star) starImported.add(target);
      if (entry.names.length > 0) {
        const set = imported.get(target) ?? new Set<string>();
        for (const name of entry.names) set.add(name);
        imported.set(target, set);
      }
      if (entry.reExport) {
        const own = reExported.get(path) ?? new Set<string>();
        for (const name of entry.provided) own.add(name);
        reExported.set(path, own);
      }
    }
  }
  return { edges, imported, reExported, starImported };
}
const graph = buildGraph();

/** Depth-first cycle detection: returns each back-edge's cycle path. */
function findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const [path] of edges) color.set(path, WHITE);
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (color.get(next) === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (color.get(next) === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const [path] of edges) if (color.get(path) === WHITE) visit(path);
  return cycles;
}


// ---------------------------------------------------------------------------
// 3. Import-cycle check (DFS for back edges).
// ---------------------------------------------------------------------------
{
  const failures = findCycles(graph.edges).map(
    (cycle) => `import cycle: ${cycle.map(rel).join(" -> ")}`,
  );
  record("import-cycles", "static import graph must be acyclic", failures);
}

// ---------------------------------------------------------------------------
// 3b. Self-test: the cycle detector must catch the specifier forms the old
// regex set missed — a default-import edge and an `export *` edge — while a
// type-only declaration and an acyclic chain produce no cycle. A check that
// cannot fail on a planted cycle proves nothing.
// ---------------------------------------------------------------------------
{
  const fixturePaths = new Set(["/f/a.ts", "/f/b.ts", "/f/c.ts", "/f/d.ts", "/f/e.ts", "/f/f.ts", "/f/g.ts", "/f/h.ts"]);
  const fixtureSources = new Map<string, string>([
    // a↔b two-file cycle through a DEFAULT import (the regex set's miss).
    ["/f/a.ts", `import B from "./b.ts";\nexport const a = 1;\n`],
    ["/f/b.ts", `import { a } from "./a.ts";\nexport default a;\n`],
    // c↔d cycle through `export *` re-export edges (also missed before).
    ["/f/c.ts", `export * from "./d.ts";\n`],
    ["/f/d.ts", `export * from "./c.ts";\n`],
    // e↔f cycle through require() and dynamic import() edges.
    ["/f/e.ts", `const f = require("./f.ts");\nexport const e = 3;\n`],
    ["/f/f.ts", `const e = await import("./e.ts");\nexport const f = 4;\n`],
    // g←h is a real edge, g→h is type-only: no runtime cycle.
    ["/f/g.ts", `import type { H } from "./h.ts";\nexport const g = 2;\n`],
    ["/f/h.ts", `import { g } from "./g.ts";\nexport type H = typeof g;\n`],
  ]);
  const fixtureEdges = new Map<string, string[]>();
  for (const path of fixturePaths) fixtureEdges.set(path, []);
  for (const [path, source] of fixtureSources) {
    for (const entry of collectSpecifiers(source, path)) {
      const target = resolve(join(dirname(path), entry.spec));
      if (fixturePaths.has(target) && entry.runtime) {
        fixtureEdges.get(path)!.push(target);
      }
    }
  }
  const failures: string[] = [];
  const found = findCycles(fixtureEdges).map((cycle) => cycle.join(" -> "));
  const expectCycle = (mustContain: string): void => {
    if (!found.some((cycle) => cycle.includes(mustContain))) {
      failures.push(`self-test fixture missing expected cycle through ${mustContain}`);
    }
  };
  expectCycle("/f/a.ts");
  expectCycle("/f/c.ts");
  expectCycle("/f/e.ts");
  if (found.some((cycle) => cycle.includes("/f/g.ts"))) {
    failures.push("self-test: a type-only import produced a runtime edge");
  }
  record(
    "self-test",
    `cycle detector sees default-import, export-*, require, and dynamic-import edges (${found.length} fixture cycles found)`,
    failures,
  );
}

// ---------------------------------------------------------------------------
// 4. Presentation strictness: src/details.ts schemas.
// ---------------------------------------------------------------------------
{
  const failures: string[] = [];
  const path = join(SRC_DIR, "details.ts");
  const code = codeOnly.get(path)!;
  const callPattern = /\bType\.Object\s*\(/g;
  let match: RegExpExecArray | null;
  let objectCount = 0;
  while ((match = callPattern.exec(code)) !== null) {
    objectCount++;
    const open = code.indexOf("(", match.index);
    const close = matchParen(code, open);
    const args = splitTopLevel(code.slice(open + 1, close)).filter(
      (arg) => arg.length > 0,
    );
    const where = `src/details.ts:${lineOf(code, match.index)}`;
    const last = args[args.length - 1] ?? "";
    if (args.length < 2 || !/additionalProperties\s*:\s*false/.test(last)) {
      failures.push(`${where} Type.Object lacks \`additionalProperties: false\``);
    }
    if (/\bdurationMs\b/.test(args[0] ?? "")) {
      failures.push(
        `${where} \`durationMs\` inside a Type.Object schema (journal-only field, #127)`,
      );
    }
  }
  if (objectCount === 0) failures.push("no Type.Object calls found in src/details.ts — the schema surface moved?");
  record(
    "details-strictness",
    `all ${objectCount} Type.Object calls in src/details.ts must be strict; durationMs stays out of schemas`,
    failures,
  );
}

// ---------------------------------------------------------------------------
// 5. Diagnostic record hygiene: context keys ⊆ CONTEXT_KEYS.
// ---------------------------------------------------------------------------
{
  const failures: string[] = [];
  const diagPath = join(SRC_DIR, "diagnostics.ts");
  const diagSource = stripped.get(diagPath)!;
  const allowlistMatch =
    /CONTEXT_KEYS\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*as\s+const\s*\)/.exec(
      diagSource,
    );
  let scanned = 0;
  if (allowlistMatch === null) {
    failures.push(
      "CONTEXT_KEYS allowlist not found in src/diagnostics.ts — the check cannot run",
    );
  } else {
    const allowlist = new Set(
      [...allowlistMatch[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!),
    );
    // Keys of one object literal: top-level `name:` or shorthand segments;
    // `...spread` segments contribute the keys of any literal they spread.
    const keysOfLiteral = (literal: string, where: string): void => {
      const inner = literal.trim().replace(/^\{/, "").replace(/\}$/, "");
      for (const segment of splitTopLevel(inner)) {
        if (segment.length === 0) continue;
        if (segment.startsWith("...")) {
          const spreads = segment.slice(3);
          for (const braceMatch of spreads.matchAll(/\{[\s\S]*?\}/g)) {
            keysOfLiteral(braceMatch[0], where);
          }
          if (!/\{/.test(spreads)) {
            failures.push(
              `${where} unscannable context spread \`${segment}\` (cannot enumerate keys)`,
            );
          }
          continue;
        }
        const keyMatch = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(segment);
        if (keyMatch === null) {
          failures.push(
            `${where} unscannable context segment \`${segment.slice(0, 60)}\``,
          );
          continue;
        }
        const key = keyMatch[1]!;
        if (!allowlist.has(key)) {
          failures.push(
            `${where} context key \`${key}\` is not in the diagnostics CONTEXT_KEYS allowlist`,
          );
        }
      }
    };
    const callPattern = /\.log\s*\(|\bdiagnostic\s*\(/g;
    for (const [path, code] of codeOnly) {
      callPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = callPattern.exec(code)) !== null) {
        const open = code.indexOf("(", match.index);
        const close = matchParen(code, open);
        const args = splitTopLevel(code.slice(open + 1, close));
        scanned++;
        const where = `${rel(path)}:${lineOf(code, match.index)}`;
        if (args.length < 3 || args[2] === "") continue; // default {}
        const contextArg = args[2]!;
        if (!contextArg.startsWith("{")) {
          failures.push(
            `${where} diagnostic context is not an inline object literal (\`${contextArg.slice(0, 40)}\`) — keys cannot be audited`,
          );
          continue;
        }
        keysOfLiteral(contextArg, where);
      }
    }
    if (scanned === 0) {
      failures.push("no diagnostic log call sites found — the check cannot run");
    }
    record(
      "diagnostic-context",
      `context keys of ${scanned} log call sites ⊆ CONTEXT_KEYS (${allowlist.size} allowed)`,
      failures,
    );
  }
  if (allowlistMatch === null) {
    record(
      "diagnostic-context",
      "CONTEXT_KEYS allowlist enforced on call-site context keys",
      failures,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Retry discipline: the child AgentSession's auto-retry stays off.
// ---------------------------------------------------------------------------
{
  const failures: string[] = [];
  const path = join(SRC_DIR, "host.ts");
  const code = stripped.get(path)!;
  const pin = /\.setRetryEnabled\(\s*false\s*\)/;
  const found = pin.exec(code);
  if (found === null) {
    failures.push(
      "src/host.ts no longer disables the child AgentSession retry (`setRetryEnabled(false)`) — the host's default per-turn retry would run before Delegate's side-effect-aware retry layer",
    );
  }
  record(
    "retry-disabled",
    "child AgentSession auto-retry disabled in memory via `settingsManager.setRetryEnabled(false)` in src/host.ts",
    failures,
  );
}

// ---------------------------------------------------------------------------
// 7. Incremental unused-export check (baseline ratchet).
// ---------------------------------------------------------------------------
{
  const failures: string[] = [];
  const warnings: string[] = [];
  const exportPattern =
    /^\s*export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  const exportsOf = new Map<string, Set<string>>();
  for (const [path, source] of stripped) {
    const set = new Set<string>();
    let match: RegExpExecArray | null;
    exportPattern.lastIndex = 0;
    while ((match = exportPattern.exec(source)) !== null) set.add(match[1]!);
    for (const name of graph.reExported.get(path) ?? []) set.add(name);
    exportsOf.set(path, set);
  }
  const current = new Set<string>();
  for (const [path, names] of exportsOf) {
    const importedNames = graph.imported.get(path) ?? new Set<string>();
    const allUsed = graph.starImported.has(path);
    for (const name of names) {
      if (!allUsed && !importedNames.has(name)) {
        current.add(`${rel(path)}:${name}`);
      }
    }
  }
  let baseline = new Set<string>();
  if (existsSync(BASELINE)) {
    baseline = new Set(
      readFileSync(BASELINE, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    );
  } else {
    failures.push(
      "scripts/unused-exports-baseline.txt missing — generate it and commit it",
    );
  }
  for (const entry of [...current].sort()) {
    if (!baseline.has(entry)) {
      failures.push(
        `new unused export ${entry} — remove it or add it to scripts/unused-exports-baseline.txt`,
      );
    }
  }
  for (const entry of [...baseline].sort()) {
    if (!current.has(entry)) {
      warnings.push(
        `baseline entry ${entry} is now used (or removed) — prune it from scripts/unused-exports-baseline.txt`,
      );
    }
  }
  record(
    "unused-exports",
    `${current.size} exports unused inside the package graph (baseline: ${baseline.size}); new dead exports fail`,
    failures,
    warnings,
  );
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
let failed = 0;
for (const result of results) {
  const ok = result.failures.length === 0;
  if (!ok) failed++;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${result.name} — ${result.note}`,
  );
  for (const warning of result.warnings) console.log(`       warn: ${warning}`);
  for (const failure of result.failures) console.log(`       ${failure}`);
}
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}

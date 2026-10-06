import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import ts from "typescript";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

// #122: enforce diagnostic ownership without importing production internals.
// Worker stdout is the framed protocol, not a diagnostic destination.
test("production console and output-stream writes stay at their owned boundaries", () => {
  const root = join(import.meta.dirname, "../..");
  const paths = ["delegate.ts", ...readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts")).map((path) => `src/${path}`)];
  const violations: string[] = [];
  let protocolWrites = 0;
  for (const path of paths) {
    const source = ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) violations.push(`${path}: explicit any`);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const object = node.expression.getText(source);
        const property = ts.isPropertyAccessExpression(node) ? node.name.text
          : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : "computed";
        if ((object === "console" || object === "globalThis.console") &&
          !(path === "src/diagnostics.ts" && object === "console" && ["error", "warn"].includes(property))) {
          violations.push(`${path}: console.${property}`);
        }
        if (property === "write" && /\b(?:stdout|stderr)\b/.test(object)) {
          const call = node.parent;
          const framed = path === "src/worker/host.ts" && node.getText(source) === "io.stdout.write"
            && ts.isCallExpression(call) && call.arguments.length === 1
            && call.arguments[0]?.getText(source) === "encodeFrame(message)";
          if (framed) protocolWrites += 1;
          else violations.push(`${path}: ${node.getText(source)}`);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  expect(violations).toEqual([]);
  expect(protocolWrites).toBe(1);
});

// V2 review regression: opening a second boundary used to redirect the first
// boundary's config reads and pooled transcript writes through process.env.
test("overlapping boundaries keep config and transcripts session-local", async () => {
  const previous = process.env.DELEGATE_AGENT_DIR;
  const first = await openDelegateBoundary();
  const second = await openDelegateBoundary();
  try {
    expect(process.env.DELEGATE_AGENT_DIR).toBe(previous);
    const firstModel = await installSubagentModel(first);
    const secondModel = await installSubagentModel(second);
    configureDelegate(first, { models: { coder: firstModel.alt.spec } });
    configureDelegate(second, { models: { coder: secondModel.spec } });
    firstModel.alt.respond([fauxAssistantMessage("FIRST-BOUNDARY")]);
    secondModel.respond([fauxAssistantMessage("SECOND-BOUNDARY")]);

    const results = await Promise.all([
      callDelegate(first, {
        async: false,
        tasks: [{ agent: "coder", prompt: "first", sessionId: "pooled" }],
      }),
      callDelegate(second, {
        async: false,
        tasks: [{ agent: "coder", prompt: "second", sessionId: "pooled" }],
      }),
    ]);
    expect(results.map((result) => result.isError)).toEqual([false, false]);
    expect(firstModel.alt.state.callCount).toBe(1);
    expect(firstModel.state.callCount).toBe(0);
    expect(secondModel.state.callCount).toBe(1);
    expect(secondModel.alt.state.callCount).toBe(0);

    for (const [session, own, foreign] of [
      [first, "FIRST-BOUNDARY", "SECOND-BOUNDARY"],
      [second, "SECOND-BOUNDARY", "FIRST-BOUNDARY"],
    ] as const) {
      const directory = join(session.cwd, "delegate-sessions");
      const files = readdirSync(directory).filter((file) => file.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const transcript = readFileSync(join(directory, files[0]!), "utf8");
      expect(transcript).toContain(own);
      expect(transcript).not.toContain(foreign);
    }
    expect(process.env.DELEGATE_AGENT_DIR).toBe(previous);
  } finally {
    first.dispose();
    second.dispose();
  }
});

import {
  createTestSession,
  type TestSession,
  type TestSessionOptions,
} from "@marcfargas/pi-test-harness";
import type {
  AgentSession,
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { DelegateDetails, TaskResult } from "./types.ts";
import { resolve } from "node:path";

export const DELEGATE_EXTENSION = resolve(import.meta.dirname, "./delegate.ts");

export { type TestSession };

export function createDelegateTestSession(
  options: TestSessionOptions = {},
): Promise<TestSession> {
  return createTestSession({
    ...options,
    extensions: [...(options.extensions ?? []), DELEGATE_EXTENSION],
  });
}

export interface TestToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  execute(...args: unknown[]): Promise<AgentToolResult<DelegateDetails>>;
  renderCall: (...args: unknown[]) => Component;
  renderResult: (...args: unknown[]) => Component;
}

export function getToolDef(ts: TestSession, name: string): TestToolDefinition {
  const tool = (ts.session as AgentSession).extensionRunner.getToolDefinition(
    name,
  );
  if (!tool) throw new Error(`${name} tool not found`);
  return tool as unknown as TestToolDefinition;
}

export function getDelegateTool(ts: TestSession): TestToolDefinition {
  return getToolDef(ts, "delegate");
}

export function getExecContext(ts: TestSession): ExtensionContext {
  return (ts.session as AgentSession).extensionRunner.createContext();
}

export function firstText(result: { content: readonly unknown[] }): string {
  const content = result.content[0];
  if (
    !content ||
    typeof content !== "object" ||
    !("type" in content) ||
    content.type !== "text" ||
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error("Expected first tool result content item to be text");
  }
  return content.text;
}

export function taskResultAt(
  results: readonly (TaskResult | { error: string })[],
  index: number,
): TaskResult {
  const result = results[index];
  if (!result || !("agent" in result)) {
    throw new Error(`Expected task result at index ${index}`);
  }
  return result;
}

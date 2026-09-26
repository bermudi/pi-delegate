import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  calls,
  createTestSession,
  says,
  when,
  type MockUIConfig,
  type TestSession,
  type ToolResultRecord,
} from "@marcfargas/pi-test-harness";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  type FauxProviderState,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";

const extensionPath = resolve(import.meta.dirname, "../../delegate.ts");

export interface PublicTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: string[];
}

export async function openDelegateBoundary(
  options: {
    inMemoryAgentDir?: boolean;
    mockUI?: MockUIConfig;
    /** Extensions loaded before delegate.ts (fault injection at the host boundary). */
    leadingExtensions?: string[];
    /** Parent session custom base prompt (the user-authored persona channel). */
    systemPrompt?: string;
  } = {},
): Promise<TestSession> {
  const session = await createTestSession({
    extensions: [...(options.leadingExtensions ?? []), extensionPath],
    propagateErrors: false,
    mockUI: options.mockUI,
    systemPrompt: options.systemPrompt,
  });
  // Model the host session-store layout without changing process.env or
  // enabling parent transcript persistence. The directory getter belongs to
  // this session only; overlapping boundaries cannot redirect each other.
  // Fallback regressions opt out to retain the harness’s empty directory.
  if (!options.inMemoryAgentDir) {
    (session.session as AgentSession).sessionManager.getSessionDir = () =>
      join(session.cwd, "sessions", "--test--");
  }
  return session;
}

export function registeredTool(
  session: TestSession,
  name: string,
): PublicTool {
  const definition = (session.session as AgentSession).extensionRunner
    .getToolDefinition(name);
  if (!definition) throw new Error(`${name} tool was not registered`);
  return definition as unknown as PublicTool;
}

export function delegateTool(session: TestSession): PublicTool {
  return registeredTool(session, "delegate");
}

let callSequence = 0;

/**
 * Fire a call to one of the delegate tools and resolve with its tool
 * result once the surrounding `session.run` settles.
 */
export function callDelegateTool(
  session: TestSession,
  toolName: string,
  arguments_: Record<string, unknown>,
): Promise<ToolResultRecord> {
  const previousResults = session.events.toolResultsFor(toolName).length;
  callSequence += 1;

  return session
    .run(
      when(`${toolName} contract call ${callSequence}`, [
        calls(toolName, arguments_),
        says("done"),
      ]),
    )
    .then(() => {
      const result =
        session.events.toolResultsFor(toolName)[previousResults];
      if (!result) {
        throw new Error(`${toolName} call produced no tool result`);
      }
      return result;
    });
}

export async function callDelegate(
  session: TestSession,
  arguments_: Record<string, unknown>,
): Promise<ToolResultRecord> {
  return callDelegateDetached(session, arguments_);
}

export async function callDelegateTicket(
  session: TestSession,
  arguments_: Record<string, unknown>,
): Promise<ToolResultRecord> {
  return callDelegateTool(session, "delegate_ticket", arguments_);
}

export async function callDelegateSession(
  session: TestSession,
  arguments_: Record<string, unknown>,
): Promise<ToolResultRecord> {
  return callDelegateTool(session, "delegate_session", arguments_);
}

/**
 * Fire a delegate call without awaiting it inline: the returned promise
 * resolves with the tool result once the surrounding `session.run` settles.
 * This lets a test interrupt the in-flight call through the raw session —
 * e.g. `(session.session as AgentSession).abort()` — which the harness's
 * awaited `run` API cannot express.
 */
export function callDelegateDetached(
  session: TestSession,
  arguments_: Record<string, unknown>,
): Promise<ToolResultRecord> {
  return callDelegateTool(session, "delegate", arguments_);
}

export function objectOf(
  value: unknown,
  description = "value",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} is not an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * A provider-free subagent model registered on the test session's own model
 * runtime. The helper also sets the PARENT session's model to it — inline
 * tasks inherit the parent's model, so tests that dispatch unnamed tasks
 * exercise real inheritance and stream through the scripted faux provider.
 * Named-agent overrides come from delegate.json `models` entries (config is
 * the only override source; tasks carry no model field). A second,
 * independent provider (`alt`) exists for override/precedence proofs.
 * No provider calls ever leave the process.
 */
export interface SubagentModel {
  /** The parent session's (and thus inline tasks') model reference. */
  readonly spec: string;
  /** Replace the queued scripted responses for the next stream calls. */
  readonly respond: (steps: FauxResponseStep[]) => void;
  /** Queue additional scripted responses after the existing ones. */
  readonly append: (steps: FauxResponseStep[]) => void;
  /** Live provider counters (e.g. callCount) for observability assertions. */
  readonly state: FauxProviderState;
  /** A second, independent configured model (provider `delegate-faux-2`). */
  readonly alt: {
    readonly spec: string;
    readonly respond: (steps: FauxResponseStep[]) => void;
    readonly state: FauxProviderState;
  };
}

/** Read the session's delegate.json as an object ({} when absent/unparseable). */
function currentDelegateConfig(session: TestSession): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(session.cwd, "delegate.json"), "utf8"),
    );
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Shallow-merge a patch into the session's delegate.json (top-level keys in
 * the patch replace stored ones). The harness session's agentDir is its
 * temporary cwd, so this stands in for editing the user-global config.
 */
export function configureDelegate(
  session: TestSession,
  patch: Record<string, unknown>,
): void {
  const merged = { ...currentDelegateConfig(session), ...patch };
  writeFileSync(
    join(session.cwd, "delegate.json"),
    JSON.stringify(merged, null, 2),
  );
}

export async function installSubagentModel(
  session: TestSession,
): Promise<SubagentModel> {
  // reasoning: true — without it Pi clamps a child's thinking level to
  // "off" before streaming, which would hide configured :effort pins.
  const faux = fauxProvider({
    provider: "delegate-faux",
    models: [{ id: "faux-1", reasoning: true }],
  });
  const alt = fauxProvider({
    provider: "delegate-faux-2",
    models: [{ id: "faux-1", reasoning: true }],
  });
  const runtime = (session.session as AgentSession).modelRuntime;
  runtime.registerNativeProvider(faux.provider);
  runtime.registerNativeProvider(alt.provider);
  await runtime.setRuntimeApiKey("delegate-faux", "test-key");
  await runtime.setRuntimeApiKey("delegate-faux-2", "test-key");
  const spec = "delegate-faux/faux-1";
  const altSpec = "delegate-faux-2/faux-1";
  // The parent runs on the faux model so inline subagents inherit it. The
  // harness playbook replaces the parent's own streamFn, so this model is
  // never streamed by the parent itself — only by inheriting subagents.
  const parentModel = runtime.getModel("delegate-faux", "faux-1");
  if (!parentModel) {
    throw new Error("faux model did not register on the parent runtime");
  }
  await (session.session as AgentSession).setModel(parentModel);
  return {
    spec,
    respond: (steps) => faux.setResponses(steps),
    append: (steps) => faux.appendResponses(steps),
    state: faux.state,
    alt: {
      spec: altSpec,
      respond: (steps) => alt.setResponses(steps),
      state: alt.state,
    },
  };
}

/**
 * Extract a ticket identifier from a delegate tool result. The v2 ticket id
 * format is intentionally unspecified, so this accepts any opaque token the
 * result surfaces.
 */
export function ticketIdOf(text: string): string {
  // Prefer a quoted identifier, then a "ticket <id>" / "ticket: <id>" shape.
  const quoted = /['"`]([A-Za-z0-9][A-Za-z0-9._-]{2,})['"`]/.exec(text);
  const bare =
    quoted ??
    /\bticket\b[\s:=#]*([A-Za-z0-9][A-Za-z0-9._-]{3,})/i.exec(text);
  if (!bare?.[1]) {
    throw new Error(`no ticket id found in tool result: ${text.slice(0, 200)}`);
  }
  return bare[1];
}

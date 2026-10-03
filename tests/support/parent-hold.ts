import { Type } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * The "busy parent" seam for delivery tests: a parent-side tool whose
 * execute parks on a test-controlled gate, so a scripted parent run stays
 * mid-flight while a ticket settles. `armHold()` installs a fresh gate
 * before the run; `releaseHold()` opens it. An unarmed call returns
 * immediately so a playbook can never hang the run forever.
 */
let gate: Promise<void> = Promise.resolve();
let release: (() => void) | undefined;

export function armHold(): void {
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
}

export function releaseHold(): void {
  release?.();
  release = undefined;
}

export default function parentHold(api: ExtensionAPI): void {
  api.registerTool({
    name: "delegate_hold",
    label: "Delegate Hold",
    description: "Test seam: parks until the test releases it.",
    parameters: Type.Object({}),
    execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
      return gate.then(() => ({
        content: [{ type: "text" as const, text: "held" }],
        details: {},
      }));
    },
  });
}

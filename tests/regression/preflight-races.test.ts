import { expect, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  delegateTool,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

interface DirectTool {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (value: unknown) => void,
    ctx: unknown,
  ): Promise<{ content: readonly { text?: string }[] }>;
}

test("deadline expires during resource loading without prompting a child", async () => {
  // Regression: a 25ms budget previously reported success after a 150ms
  // loader reload because the timeout was armed only after that reload.
  const session = await openDelegateBoundary();
  const original = DefaultResourceLoader.prototype.reload;
  const reload = spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(
    async function (this: DefaultResourceLoader) {
      await Bun.sleep(150);
      return original.call(this);
    },
  );
  try {
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("late worker")]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "do nothing", tools: [], deadlineMs: 25 }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("deadline exceeded");
    expect(model.state.callCount).toBe(0);
  } finally {
    reload.mockRestore();
    session.dispose();
  }
});

test("deadline returns even when the resource loader stays blocked", async () => {
  const session = await openDelegateBoundary();
  const original = DefaultResourceLoader.prototype.reload;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reload = spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(
    async function (this: DefaultResourceLoader) {
      await gate;
      return original.call(this);
    },
  );
  try {
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("late worker")]);
    const dispatch = callDelegate(session, {
      tasks: [{ prompt: "do nothing", tools: [], deadlineMs: 25 }],
    });
    const result = await Promise.race([
      dispatch,
      Bun.sleep(300).then(() => { throw new Error("deadline remained stuck in loader"); }),
    ]);
    expect(result.text).toContain("deadline exceeded");
    expect(model.state.callCount).toBe(0);
  } finally {
    release();
    reload.mockRestore();
    session.dispose();
  }
});

test("shutdown during async task resolution cannot start a late worker", async () => {
  // Regression: shutdown snapshots tickets before the Git write-scope
  // probe returns; without a recheck, the newly created ticket escapes it.
  const session = await openDelegateBoundary();
  try {
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("worker started after shutdown")]);
    const host = session.session as AgentSession;
    const tool = delegateTool(session) as unknown as DirectTool;
    const dispatch = tool.execute(
      "shutdown-preflight",
      { async: true, tasks: [{ prompt: "do nothing", tools: ["bash"] }] },
      new AbortController().signal,
      () => {},
      host.extensionRunner.createContext(),
    );
    const shutdown = host.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    await expect(dispatch).rejects.toThrow(/shut down/);
    await shutdown;
    expect(model.state.callCount).toBe(0);
  } finally {
    session.dispose();
  }
});

test("shutdown during sync task resolution cannot start a late worker", async () => {
  const session = await openDelegateBoundary();
  try {
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("worker started after shutdown")]);
    const host = session.session as AgentSession;
    const tool = delegateTool(session) as unknown as DirectTool;
    const dispatch = tool.execute(
      "shutdown-sync-preflight",
      { tasks: [{ prompt: "do nothing", tools: ["bash"] }] },
      new AbortController().signal,
      () => {},
      host.extensionRunner.createContext(),
    );
    const shutdown = host.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    await expect(dispatch).rejects.toThrow(/shut down/);
    await shutdown;
    expect(model.state.callCount).toBe(0);
  } finally {
    session.dispose();
  }
});

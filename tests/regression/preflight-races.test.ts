import { expect, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  callDelegateDetached,
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

test("slow resource loading has no task wall-clock budget", async () => {
  // #118 overrides the old resource-loading deadline regression.
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
      async: false,
      tasks: [{ prompt: "do nothing" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("late worker");
    expect(model.state.callCount).toBe(1);
  } finally {
    reload.mockRestore();
    session.dispose();
  }
});

test("parent cancellation returns even when the resource loader stays blocked", async () => {
  const session = await openDelegateBoundary();
  const original = DefaultResourceLoader.prototype.reload;
  let entered!: () => void;
  const loading = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reloadCompletion: Promise<void> | undefined;
  const reload = spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(
    function (this: DefaultResourceLoader) {
      reloadCompletion = (async () => {
        entered();
        await gate;
        await original.call(this);
      })();
      return reloadCompletion;
    },
  );
  const finishLoading = async (): Promise<void> => {
    release();
    await reloadCompletion;
    // Drain loader consumers' promise continuations before checking or teardown.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("late worker")]);
    const dispatch = callDelegateDetached(session, {
      async: false,
      tasks: [{ prompt: "do nothing" }],
    });
    await loading;
    await (session.session as AgentSession).abort();
    const result = await Promise.race([
      dispatch,
      Bun.sleep(2000).then(() => { throw new Error("cancellation remained stuck in loader"); }),
    ]);
    expect(result.text).toMatch(/cancelled/i);
    expect(model.state.callCount).toBe(0);
    await finishLoading();
    expect(model.state.callCount).toBe(0);
  } finally {
    try {
      await finishLoading();
    } finally {
      reload.mockRestore();
      session.dispose();
    }
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
      { async: true, tasks: [{ prompt: "do nothing" }] },
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
      { async: false, tasks: [{ prompt: "do nothing" }] },
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

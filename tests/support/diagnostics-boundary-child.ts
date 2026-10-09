// #122 public-tool subprocess fixture. PRIVATE_* strings are synthetic privacy sentinels.
import {
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  linkSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
  objectOf,
  registeredTool,
  ticketIdOf,
} from "./pi-boundary.ts";

interface DirectResult {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
  readonly isError?: boolean;
  readonly details?: unknown;
}
interface RenderingTool extends TicketTool {
  renderResult(
    result: DirectResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
    context: { lastComponent: undefined },
  ): { render(width: number): string[] };
}
interface TicketTool {
  execute(
    id: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: unknown,
  ): Promise<DirectResult>;
}
const agentDir = process.env.DELEGATE_AGENT_DIR;
if (!agentDir) throw new Error("Explicit scratch agent directory required");
writeFileSync(
  join(agentDir, "delegate.json"),
  JSON.stringify({ telemetry: { enabled: true } }),
  { mode: 0o600 },
);
mkdirSync(join(agentDir, "delegate-usage.db"));
mkdirSync(join(agentDir, "agents"), { mode: 0o700 });
writeFileSync(
  join(agentDir, "agents", "broken.md"),
  "---\ndescription: [PRIVATE_PROFILE_UNCLOSED\n---\nPRIVATE_PROFILE_BODY",
  { mode: 0o600 },
);
const scenario = process.argv[2] ?? "normal";
const logBase = join(agentDir, "delegate-diagnostics");
const outside = join(agentDir, "..", "outside");
mkdirSync(outside, { mode: 0o700 });
const victim = join(outside, "victim.txt");
writeFileSync(victim, "OUTSIDE_FILE_UNTOUCHED", { mode: 0o600 });
if (scenario === "blocked")
  writeFileSync(logBase, "LOG_DESTINATION_UNTOUCHED", { mode: 0o600 });
else if (scenario === "symlink-directory") symlinkSync(outside, logBase);
else if (scenario !== "normal" && !scenario.startsWith("failure-")) {
  mkdirSync(logBase, { mode: 0o700 });
  const logFile = join(logBase, `${process.pid}.jsonl`);
  if (scenario === "insecure-directory") chmodSync(logBase, 0o755);
  else if (scenario === "symlink-file") symlinkSync(victim, logFile);
  else if (scenario === "hardlink-file") linkSync(victim, logFile);
  else if (scenario === "insecure-file") {
    writeFileSync(logFile, "LOG_FILE_UNTOUCHED", { mode: 0o600 });
    chmodSync(logFile, 0o644);
  } else throw new Error("Unknown diagnostic scenario");
}
const fallback = join(
  tmpdir(),
  `pi-delegate-diagnostics-${process.getuid?.()}-${process.pid}`,
);
function blockBoth(): void {
  if (existsSync(logBase)) renameSync(logBase, logBase + ".saved");
  writeFileSync(logBase, "PRIMARY_BLOCKED", { mode: 0o600 });
  writeFileSync(fallback, "FALLBACK_BLOCKED", { mode: 0o600 });
}
function recoverRouting(): void {
  rmSync(logBase, { force: true });
  if (existsSync(logBase + ".saved")) renameSync(logBase + ".saved", logBase);
  rmSync(fallback, { force: true });
}
if (scenario === "failure-startup") blockBoth();
const session = await openDelegateBoundary();

try {
  const model = await installSubagentModel(session);
  const host = session.session as AgentSession;
  const tool = registeredTool(
    session,
    "delegate_ticket",
  ) as unknown as TicketTool;
  let sequence = 0;
  const rpc = (args: Record<string, unknown>) =>
    tool.execute(
      `diagnostics-${++sequence}`,
      args,
      new AbortController().signal,
      () => {},
      host.extensionRunner.createContext(),
    );
  const text = (result: DirectResult) =>
    result.content.map((c) => c.text ?? "").join("\n");
  if (scenario.startsWith("failure-")) {
    const delegate = registeredTool(
      session,
      "delegate",
    ) as unknown as TicketTool;
    const sessionTool = registeredTool(
      session,
      "delegate_session",
    ) as unknown as TicketTool;
    const execute = (
      target: TicketTool,
      args: Record<string, unknown>,
      brokenNotice = false,
    ) => {
      const context = host.extensionRunner.createContext();
      return target.execute(
        `failure-${++sequence}`,
        args,
        new AbortController().signal,
        () => {},
        brokenNotice
          ? {
              ...context,
              hasUI: true,
              ui: {
                ...context.ui,
                notify: () => {
                  throw new Error("PRIVATE_NOTICE_ERROR");
                },
              },
            }
          : context,
      );
    };
    const assert = (condition: unknown, message: string): void => {
      if (!condition) throw new Error(message);
    };
    const renderedWarning = (target: TicketTool, result: DirectResult, historyTarget?: TicketTool): void => {
      for (const renderer of [target, ...(historyTarget ? [historyTarget] : [])] as RenderingTool[]) {
        for (const expanded of [false, true]) {
          // Content-free replay proves the recorded metadata itself carries the
          // warning; no live notice or original bounded text is needed.
          for (const record of [result, { ...result, content: [] }]) {
            const rendered = renderer.renderResult(record, { expanded, isPartial: false }, {
              fg: (_color, body) => body, bold: (body) => body,
            }, { lastComponent: undefined }).render(8192).join("\n");
            assert(rendered.includes("routing failed"), "Human renderer lost routing warning");
            assert(rendered.split("Warning: Delegate diagnostic").length === 2, "Renderer duplicated routing warning");
            assert(rendered.includes(logBase) && rendered.includes("ENOTDIR"), "Renderer lost safe context");
            assert(rendered.includes("Pi notice also failed"), "Renderer lost failed-notice signal");
            assert(!rendered.includes("PRIVATE_NOTICE_ERROR"), "Renderer leaked notice body");
          }
        }
      }
    };
    let answer = false;
    let shutdown = false;
    let startupRecovery = false;
    let unsupported = false;
    let admissionReleased = false;
    let noticeFailure = false;
    let safeCauses = false;
    let workerNoninterference = false;
    let retryDiagnostic = false;
    if (scenario === "failure-startup") {
      model.respond([
        fauxAssistantMessage("STARTUP_OK"),
        fauxAssistantMessage("RECOVERY_OK"),
      ]);
      const first = await execute(delegate, {
        tasks: [{ prompt: "PRIVATE_STARTUP", tools: [] }],
        async: false,
        operationId: "diagnostic-repeat",
      }, true);
      assert(
        !first.isError && text(first).includes("STARTUP_OK"),
        "Startup logging poisoned dispatch",
      );
      assert(
        text(first).includes("routing failed") &&
          text(first).includes("ENOTDIR") &&
          text(first).includes(logBase),
        "Missing safe routing warning",
      );
      const history = await openDelegateBoundary();
      const historyDelegate = registeredTool(history, "delegate") as unknown as TicketTool;
      const historyTicket = registeredTool(history, "delegate_ticket") as unknown as TicketTool;
      const historySession = registeredTool(history, "delegate_session") as unknown as TicketTool;
      renderedWarning(delegate, first, historyDelegate);
      recoverRouting();
      const replay = await execute(delegate, {
        tasks: [{ prompt: "PRIVATE_STARTUP", tools: [] }],
        async: false,
        operationId: "diagnostic-repeat",
      });
      assert(
        text(replay).includes("STARTUP_OK") &&
          !text(replay).includes("routing failed"),
        "Logger warning mutated cached operation result",
      );
      assert(model.state.callCount === 1, "Replay dispatched new work");
      assert(!JSON.stringify(replay.details).includes("diagnosticWarning"), "Warning polluted cached details");
      const cleanDetails = { ...objectOf(first.details) };
      delete cleanDetails.diagnosticWarning;
      assert(JSON.stringify(cleanDetails) === JSON.stringify(replay.details), "Warning annotation changed original typed details");
      assert(JSON.stringify(cleanDetails.results).includes("STARTUP_OK"), "Original recorded outcome was lost");
      for (const expanded of [false, true]) {
        const rendered = (delegate as RenderingTool).renderResult(replay, { expanded, isPartial: false }, {
          fg: (_color, body) => body, bold: (body) => body,
        }, { lastComponent: undefined }).render(8192).join("\n");
        assert(!rendered.includes("routing failed"), "Repaired operation replay retained warning");
      }
      const second = await execute(delegate, {
        tasks: [{ prompt: "PRIVATE_RECOVERY", tools: [] }],
        async: false,
      });
      assert(
        !second.isError && text(second).includes("RECOVERY_OK"),
        "Routing recovery dispatch failed",
      );
      model.respond([fauxAssistantMessage("TICKET_RENDER_OK")]);
      const receipt = await execute(delegate, { tasks: [{ prompt: "ticket warning", tools: [] }], async: true });
      const ticket = ticketIdOf(text(receipt));
      await rpc({ action: "wait", ticket, timeoutMs: 3000 });
      blockBoth();
      await host.extensionRunner.emit({ type: "session_start", reason: "reload" });
      const poll = await execute(tool, { action: "poll", ticket }, true);
      assert(!poll.isError, "Ticket poll failed");
      renderedWarning(tool, poll, historyTicket);
      await host.extensionRunner.emit({ type: "session_start", reason: "reload" });
      const listing = await execute(sessionTool, { action: "list" }, true);
      assert(!listing.isError, "Session listing failed");
      renderedWarning(sessionTool, listing, historySession);
      await host.extensionRunner.emit({ type: "session_start", reason: "reload" });
      let preflightError: unknown;
      try {
        await execute(delegate, {
          tasks: [{ prompt: "PRIVATE_PREFLIGHT_ERROR", reasoning_effort: "high" }], async: false,
        }, true);
      } catch (error) { preflightError = error; }
      assert(preflightError instanceof Error && preflightError.message.includes("reasoning_effort"), "Logging changed original preflight error");
      // Thrown preflight errors stand; the sink's pending warning belongs to the
      // next returned result. Help exercises the content fallback, not outcomes.
      const helpResult = await execute(delegate, { tasks: [] }, true);
      renderedWarning(delegate, helpResult, historyDelegate);
      await host.extensionRunner.emit({ type: "session_start", reason: "reload" });
      model.respond([fauxAssistantMessage("", {
        stopReason: "error", errorMessage: "invalid request: synthetic fixture failure",
      })]);
      const failed = await execute(delegate, { tasks: [{ prompt: "synthetic failed task", tools: [] }], async: false }, true);
      assert(failed.isError, "Failed worker did not return an error result");
      renderedWarning(delegate, failed, historyDelegate);
      history.dispose();
      recoverRouting();
      startupRecovery = true;
      await host.extensionRunner.emit({
        type: "session_start",
        reason: "reload",
      });
    } else if (scenario === "failure-retry") {
      model.respond([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "ECONNRESET temporarily unavailable PRIVATE_PROVIDER",
        }),
        fauxAssistantMessage("RETRY_OK"),
      ]);
      const result = await execute(delegate, {
        tasks: [{ prompt: "PRIVATE_RETRY", tools: [] }],
        async: false,
      });
      assert(
        !result.isError &&
          text(result).includes("RETRY_OK") &&
          model.state.callCount === 2,
        "Retry fixture failed",
      );
      assert(
        !JSON.stringify(result).includes("diagnosticCause"),
        "Internal diagnostic cause escaped public result",
      );
      retryDiagnostic = true;
    } else if (
      scenario === "failure-worker-default" ||
      scenario === "failure-worker-observer"
    ) {
      // #43's dormant stage-A supervisor has no registered dispatch surface.
      // Exercise its existing real-process boundary, not logger helpers.
      const { spawnWorker } = await import("../../src/worker/spawn.ts");
      blockBoth();
      const spec = {
        taskId: "safe-worker-id",
        label: "stub",
        prompt: "PRIVATE_WORKER_PROMPT",
        cwd: agentDir,
        agentDir,
        model: "faux/faux",
        tools: [],
      };
      const legacyLog =
        scenario === "failure-worker-observer"
          ? () => {
              throw new Error("PRIVATE_OBSERVER");
            }
          : undefined;
      const successfulCode =
        'process.stdout.write(JSON.stringify({type:"hello",protocol:1,pid:process.pid})+"\\n"); process.stderr.write("PRIVATE_STDERR"); setTimeout(()=>{ for(const m of [{type:"result",outcome:{status:"ok"}},{type:"quiescent",reason:"PRIVATE_QUIESCENT"}]) process.stdout.write(JSON.stringify(m)+"\\n"); process.exit(0); }, 50)';
      const successful = spawnWorker({
        command: [process.execPath, "-e", successfulCode],
        spec,
        log: legacyLog,
        startupTimeoutMs: 1000,
      });
      const exit = await successful.settled;
      assert(
        exit.class === "aborted" &&
          exit.diagnosticWarning?.includes("diagnostic"),
        "Default logging changed worker settlement",
      );
      assert(
        !JSON.stringify(exit.diagnosticWarning).includes("PRIVATE_"),
        "Worker warning leaked payload",
      );
      for (const [mode, expected] of [
        ["wrong-version", "protocol-failed"],
        ["silent", "startup-failed"],
        ["wedged", "killed"],
      ]) {
        let hello!: () => void;
        const ready = new Promise<void>((r) => {
          hello = r;
        });
        const worker = spawnWorker({
          command: [
            process.execPath,
            resolve(import.meta.dirname, "stub-worker.ts"),
          ],
          spec,
          env: { ...process.env, STUB_WORKER_MODE: mode },
          graceMs: 40,
          killGraceMs: 40,
          startupTimeoutMs: 500,
          onMessage: () => hello(),
          log: legacyLog,
        });
        if (mode === "wedged") {
          await ready;
          void worker.requestStop();
        }
        const outcome = await worker.settled;
        assert(
          outcome.class === expected && outcome.diagnosticWarning,
          "Logger broke worker " + mode,
        );
      }
      const badSpawn = spawnWorker({
        command: ["/no/delegate/executable"],
        spec,
        log: legacyLog,
      });
      const failed = await badSpawn.settled;
      assert(
        failed.class === "startup-failed" && failed.diagnosticWarning,
        "Logger escaped worker error event",
      );
      recoverRouting();
      // Healthy routing retains operational levels after failure recovery.
      const timeout = spawnWorker({
        command: [
          process.execPath,
          resolve(import.meta.dirname, "stub-worker.ts"),
        ],
        spec,
        env: { ...process.env, STUB_WORKER_MODE: "silent" },
        startupTimeoutMs: 200,
      });
      await timeout.settled;
      const fatalCode = `for(const m of [{type:"hello",protocol:1,pid:process.pid},{type:"fatal",class:"crashed",message:"PRIVATE_FATAL"}]) process.stdout.write(JSON.stringify(m)+String.fromCharCode(10)); setTimeout(()=>process.exit(1),20)`;
      const fatal = spawnWorker({
        command: [process.execPath, "-e", fatalCode],
        spec,
      });
      await fatal.settled;
      workerNoninterference = true;
    } else if (
      ["failure-no-getuid", "failure-no-follow", "failure-foreign"].includes(
        scenario,
      )
    ) {
      // Boundary fault injection only: no claim of testing a foreign filesystem.
      const original = Object.getOwnPropertyDescriptor(
        process,
        scenario === "failure-foreign" ? "platform" : "getuid",
      )!;
      let restoreFs: (() => void) | undefined;
      if (scenario === "failure-no-follow") {
        const { mock } = await import("bun:test");
        const fs = await import("node:fs");
        mock.module("node:fs", () => ({
          ...fs,
          constants: { ...fs.constants, O_NOFOLLOW: undefined },
        }));
        restoreFs = () => mock.restore();
      } else
        Object.defineProperty(
          process,
          scenario === "failure-foreign" ? "platform" : "getuid",
          {
            ...original,
            value: scenario === "failure-foreign" ? "darwin" : undefined,
          },
        );
      try {
        await host.extensionRunner.emit({
          type: "session_start",
          reason: "startup",
        });
        model.respond([fauxAssistantMessage("UNSUPPORTED_OK")]);
        const result = await execute(
          delegate,
          {
            tasks: [{ prompt: "PRIVATE_UNSUPPORTED", tools: [] }],
            async: false,
          },
          true,
        );
        assert(
          !result.isError && text(result).includes("UNSUPPORTED_OK"),
          "Unsupported secure logging broke dispatch",
        );
        assert(
          text(result).includes("DIAGNOSTIC_UNSUPPORTED") &&
            text(result).includes("secure routing is unsupported"),
          "Missing safe unsupported warning",
        );
        assert(
          text(result).includes("Pi notice also failed"),
          "Notice failure was silently lost",
        );
        assert(
          !text(result).includes("PRIVATE_NOTICE_ERROR"),
          "Notice leaked body",
        );
        unsupported = true;
        noticeFailure = true;
      } finally {
        if (scenario !== "failure-no-follow")
          Object.defineProperty(
            process,
            scenario === "failure-foreign" ? "platform" : "getuid",
            original,
          );
        restoreFs?.();
      }
    } else if (scenario === "failure-safe-causes") {
      const runtime = host.modelRuntime;
      const registry = host.extensionRunner.createContext()
        .modelRegistry as unknown as { runtime: unknown };
      const descriptor = Object.getOwnPropertyDescriptor(registry, "runtime");
      let accesses = 0;
      const inner = Object.assign(new TypeError("PRIVATE_CAUSE"), {
        code: "ECONNRESET",
      });
      const wrapped = new Error("PRIVATE_WRAPPER", { cause: inner });
      Object.defineProperty(registry, "runtime", {
        configurable: true,
        get: () => {
          throw wrapped;
        },
      });
      await host.extensionRunner.emit({
        type: "session_start",
        reason: "startup",
      });
      const hostile = new Error("PRIVATE_HOSTILE");
      Object.defineProperty(hostile, "code", {
        get: () => {
          accesses++;
          throw new Error("PRIVATE_ACCESSOR");
        },
      });
      Object.defineProperty(hostile, "name", {
        get: () => {
          accesses++;
          throw new Error("PRIVATE_NAME");
        },
      });
      Object.defineProperty(hostile, "cause", {
        get: () => {
          accesses++;
          throw new Error("PRIVATE_CAUSE_ACCESSOR");
        },
      });
      Object.defineProperty(registry, "runtime", {
        configurable: true,
        get: () => {
          throw hostile;
        },
      });
      await host.extensionRunner.emit({
        type: "session_start",
        reason: "startup",
      });
      if (descriptor) Object.defineProperty(registry, "runtime", descriptor);
      else {
        delete (registry as { runtime?: unknown }).runtime;
        registry.runtime = runtime;
      }
      assert(accesses === 0, "Diagnostic error accessors ran");
      safeCauses = true;
    } else {
      const asks: FauxResponseFactory = (context) =>
        JSON.stringify(context.messages).includes("PRIVATE_ANSWER")
          ? fauxAssistantMessage("PRIVATE_ANSWERED_OUTPUT")
          : fauxAssistantMessage([
              fauxToolCall("ask_parent", { question: "PRIVATE_QUESTION" }),
            ]);
      model.respond([
        fauxAssistantMessage([
          fauxToolCall("ask_parent", { question: "PRIVATE_QUESTION" }),
        ]),
        fauxAssistantMessage("PRIVATE_ANSWERED_OUTPUT"),
        fauxAssistantMessage("PRIVATE_ANSWERED_OUTPUT"),
      ]);
      const dispatched = await execute(delegate, {
        tasks: [
          {
            id: "asker",
            prompt: "PRIVATE_ASK",
            tools: ["write"],
            sessionId: "diagnostic-owned",
          },
        ],
        async: true,
      });
      assert(!dispatched.isError, "Failure fixture dispatch failed");
      const ticket = ticketIdOf(text(dispatched));
      let questionId: string | undefined;
      for (let i = 0; i < 200; i++) {
        questionId = text(await rpc({ action: "poll", ticket })).match(
          /question (q-\d+):/,
        )?.[1];
        if (questionId) break;
        await Bun.sleep(5);
      }
      assert(questionId, "Failure fixture question absent");
      const busy = await execute(sessionTool, {
        action: "close",
        sessionId: "diagnostic-owned",
      });
      assert(
        busy.isError && text(busy).includes("running work"),
        "No admission held before failure",
      );
      blockBoth();
      if (scenario === "failure-answer") {
        const answered = await execute(
          tool,
          {
            action: "answer",
            ticket,
            taskId: "asker",
            questionId,
            answer: "PRIVATE_ANSWER",
          },
          true,
        );
        assert(
          !answered.isError &&
            /accepted|answered|sent|resume/i.test(text(answered)),
          "Answer did not return honest receipt",
        );
        assert(
          text(answered).includes("routing failed") &&
            text(answered).includes("ENOTDIR"),
          "Answer missed routing warning",
        );
        assert(
          text(answered).includes("Pi notice also failed"),
          "Failed notice was lost",
        );
        noticeFailure = true;
        const waited = await rpc({ action: "wait", ticket, timeoutMs: 3000 });
        assert(
          !waited.isError && text(waited).includes("PRIVATE_ANSWERED_OUTPUT"),
          "Logging stranded answered worker: " + text(waited),
        );
        answer = true;
      } else if (scenario === "failure-shutdown") {
        const calls = model.state.callCount;
        const began = Date.now();
        await Promise.race([
          host.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          Bun.sleep(3000).then(() => {
            throw new Error("Shutdown failed to reach quiescence");
          }),
        ]);
        assert(
          Date.now() - began < 1500,
          "Shutdown used timeout instead of quiescence",
        );
        const polled = await rpc({ action: "poll", ticket });
        assert(
          text(polled).includes("cancelled") &&
            !text(polled).includes("Waiting for parent answer"),
          "Shutdown left question running",
        );
        assert(
          !text(polled).includes("termination unconfirmed"),
          "Shutdown falsely finished before worker quiescence",
        );
        assert(
          text(polled).includes("routing failed"),
          "Shutdown routing signal lost",
        );
        assert(
          model.state.callCount === calls,
          "Shutdown resumed cancelled worker",
        );
        const late = await rpc({
          action: "answer",
          ticket,
          taskId: "asker",
          questionId,
          answer: "PRIVATE_LATE",
        });
        assert(late.isError, "Late shutdown answer accepted");
        shutdown = true;
      } else throw new Error("Unknown failure scenario");
      const closed = await execute(sessionTool, {
        action: "close",
        sessionId: "diagnostic-owned",
      });
      assert(
        !text(closed).includes("running work"),
        "Cleanup retained admission after quiescence",
      );
      admissionReleased = true;
      recoverRouting();
    }
    console.log(
      "DIAGNOSTICS_BOUNDARY_RESULT " +
        JSON.stringify({
          tty: process.stderr.isTTY === true,
          pid: process.pid,
          failureScenario: scenario,
          answer,
          shutdown,
          startupRecovery,
          unsupported,
          admissionReleased,
          noticeFailure,
          safeCauses,
          workerNoninterference,
          retryDiagnostic,
        }),
    );
  } else {
    let release!: () => void;
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    model.respond([
      async () => {
        await gated;
        return fauxAssistantMessage("PRIVATE_OUTPUT");
      },
    ]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "PRIVATE_PROMPT", tools: [] }],
      async: true,
    });
    if (dispatched.isError) throw new Error("Diagnostic dispatch failed");
    const ticket = ticketIdOf(dispatched.text);
    const waited = rpc({ action: "wait", ticket, timeoutMs: 3000 });
    await Bun.sleep(10);
    release();
    const result = await waited;
    if (!text(result).includes("PRIVATE_OUTPUT"))
      throw new Error("Successful wait lost output");
    await Bun.sleep(250);
    const asks: FauxResponseFactory = (context) =>
      JSON.stringify(context.messages).includes("PRIVATE_ANSWER")
        ? fauxAssistantMessage("PRIVATE_ANSWERED_OUTPUT")
        : fauxAssistantMessage([
            fauxToolCall("ask_parent", { question: "PRIVATE_QUESTION" }),
          ]);
    model.respond([asks, asks]);
    const questionTicket = ticketIdOf(
      (
        await callDelegate(session, {
          tasks: [{ id: "asker", prompt: "PRIVATE_ASK_PROMPT", tools: [] }],
          async: true,
        })
      ).text,
    );
    let questionId: string | undefined;
    for (let i = 0; i < 200; i++) {
      const polled = await rpc({ action: "poll", ticket: questionTicket });
      questionId = text(polled).match(/question (q-\d+):/)?.[1];
      if (questionId) break;
      await Bun.sleep(5);
    }
    if (!questionId) throw new Error("Question never became visible");
    const answered = await rpc({
      action: "answer",
      ticket: questionTicket,
      taskId: "asker",
      questionId,
      answer: "PRIVATE_ANSWER",
    });
    if (answered.isError) throw new Error("Answer failed");
    const answeredResult = await rpc({
      action: "wait",
      ticket: questionTicket,
      timeoutMs: 3000,
    });
    if (!text(answeredResult).includes("PRIVATE_ANSWERED_OUTPUT"))
      throw new Error("Question settlement failed");
    await Bun.sleep(250);
    let releaseSteer!: () => void;
    const steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const steerResponse: FauxResponseFactory = async () => {
      await steerGate;
      return fauxAssistantMessage("PRIVATE_STEER_OUTPUT");
    };
    model.respond([steerResponse, steerResponse, steerResponse]);
    const steerTicket = ticketIdOf(
      (
        await callDelegate(session, {
          tasks: [{ id: "steered", prompt: "PRIVATE_STEER_PROMPT", tools: [] }],
          async: true,
        })
      ).text,
    );
    const steered = await rpc({
      action: "steer",
      ticket: steerTicket,
      taskId: "steered",
      steerId: "safe-steer-id",
      message: "PRIVATE_STEER_BODY",
    });
    if (steered.isError) throw new Error("Steer failed");
    releaseSteer();
    const steerResult = await rpc({
      action: "wait",
      ticket: steerTicket,
      timeoutMs: 3000,
    });
    if (!text(steerResult).includes("PRIVATE_STEER_OUTPUT"))
      throw new Error("Steer settlement failed");
    await Bun.sleep(250);
    console.log(
      "DIAGNOSTICS_BOUNDARY_RESULT " +
        JSON.stringify({
          tty: process.stderr.isTTY === true,
          pid: process.pid,
          wait: true,
          answer: true,
          steer: true,
        }),
    );
  }
} finally {
  session.dispose();
}

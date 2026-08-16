# `pi-codex-compaction`: stale extension context after asynchronous compaction

## Status

**Confirmed lifecycle defect in `@ogulcancelik/pi-codex-compaction` 0.1.3.**

The defect is present against the installed Pi 0.83.0 host API and is also visible in the repository's Pi 0.80.9 development dependency. It is timing-dependent in normal use, but the unsafe ownership pattern is deterministic from the code: the extension starts asynchronous work, returns ownership to Pi, and later dereferences `ExtensionContext` and `ExtensionAPI` objects that Pi may already have invalidated.

The August 3 investigation reported this failure in a delegated Codex session. This document does not treat that report alone as proof: the mechanism below is independently established from the installed extension and Pi source.

## Executive summary

`pi-codex-compaction` captures Pi's live `ctx` and `pi` capability objects across asynchronous boundaries. The most important path is its `agent_settled` handler:

```ts
ctx.compact({
  onComplete: () => continueAfterCompaction(ctx, compacting),
  onError: (error) => {
    // reads ctx and may call ctx.ui after compaction finishes
  },
});
```

`ctx.compact()` is deliberately fire-and-forget in Pi. It returns `void`; Pi launches an unobserved async function that calls `onComplete` or `onError` later. The extension's `agent_settled` handler therefore returns immediately, even though compaction and its callbacks are still running.

Pi invalidates the extension runtime when `AgentSession.dispose()` runs. Every later `ctx` or `pi` action checks that runtime and throws a stale-context error. `AgentSession.dispose()` does **not** emit `session_shutdown`, so the extension's `session_shutdown` handler is not a lifetime barrier.

The resulting race is:

1. `agent_settled` starts `ctx.compact(...)`.
2. The handler returns without exposing pending ownership.
3. The caller observes the session as settled and disposes it.
4. Pi invalidates the extension context.
5. Compaction finishes or fails.
6. `onComplete`, `onError`, or another post-`await` path accesses `ctx` or `pi`.
7. Pi throws because the capability belongs to a disposed session.

Depending on the exact path, this can cause:

- a stale-context extension error;
- a lost continuation after successful compaction;
- the original compaction failure being masked by a stale-context failure;
- a rejected detached promise with no observer, i.e. an unhandled-rejection hazard;
- process-level instability, depending on the Node/Pi rejection policy.

This is primarily an **availability and lifecycle-correctness defect**. Pi's stale-runtime guard prevents the old extension from silently mutating a disposed or replacement session, so this should not be described as demonstrated cross-session data corruption.

## Affected code

The line references below are for the installed package snapshot:

- `@ogulcancelik/pi-codex-compaction` **0.1.3**
- `~/.pi/agent/npm/node_modules/@ogulcancelik/pi-codex-compaction/index.ts`
- installed Pi host **0.83.0**

### 1. Detached compaction callbacks retain `ctx`

The primary defect is at `index.ts:293-319`:

```ts
pi.on("agent_settled", (_event, ctx) => {
  // ...
  ctx.compact({
    onComplete: () => continueAfterCompaction(ctx, compacting),
    onError: (error) => {
      if (forcedCompaction !== compacting) return;
      forcedCompaction = undefined;
      if (ctx.hasUI) {
        ctx.ui.notify(`OpenAI Codex compaction failed: ${error.message}`, "error");
      }
    },
  });
});
```

The callback closure retains the event-scoped `ctx`. The handler does not return a promise representing the callback work.

`continueAfterCompaction()` at `index.ts:238-247` then performs several live capability operations:

```ts
if (ctx.hasPendingMessages()) return;
if (ctx.isIdle()) {
  pi.sendUserMessage(CONTINUATION_PROMPT);
} else {
  pi.sendUserMessage(CONTINUATION_PROMPT, { deliverAs: "followUp" });
}
```

Both `ctx.*` and `pi.sendUserMessage()` are invalid after the extension runtime is disposed.

### 2. Native checkpoint creation dereferences live capabilities after `await`

`createNativeCheckpoint()` at `index.ts:101-138` begins with asynchronous authentication:

```ts
const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
```

After that await it reads:

```ts
params.ctx.sessionManager.getSessionId();
pi.getAllTools();
params.ctx.getSystemPrompt();
pi.getActiveTools();
```

If the session is disposed while authentication is pending, every one of those post-await capability accesses can fail.

This path normally runs inside Pi's awaited `session_before_compact` event, which makes it less exposed than the detached callback path. It is still unsafe under cancellation/disposal races and should be fixed by snapshotting required values before the first await.

### 3. Status reporting dereferences `ctx`/`pi` after the operation settles

`withCompactionStatus()` at `index.ts:86-99` calls `appendCompactionStatus()` after awaiting the remote operation:

```ts
const result = await operation();
appendCompactionStatus(ctx, { state: "complete" });
```

and in the error branch:

```ts
appendCompactionStatus(ctx, {
  state: "failed",
  error: errorMessage(error),
});
```

`appendCompactionStatus()` reads `ctx.mode` and calls `pi.appendEntry()`. If the context became stale, cosmetic status reporting can replace the real compaction result with a stale-context exception. The success append can throw into the `catch`, after which the failure append can throw again.

Status rendering must never determine compaction correctness.

### 4. The compaction catch block can throw while handling another error

The `session_before_compact` catch at `index.ts:227-234` accesses the same possibly stale context:

```ts
if (forcedCompaction?.sessionId === ctx.sessionManager.getSessionId()) {
  forcedCompaction = undefined;
}
if (!event.signal.aborted && ctx.hasUI) {
  ctx.ui.notify(...);
}
```

A stale-context exception here masks the original authentication, network, cancellation, or compaction error. Pi's extension runner can catch this handler failure, but the intended `{ cancel: true }` result may never be returned.

## Pi host behavior that makes the race real

### `ctx.compact()` does not return ownership

In Pi 0.83.0, `AgentSession` binds `ctx.compact` as:

```js
compact: (options) => {
  void (async () => {
    try {
      const result = await this.compact(options?.customInstructions);
      options?.onComplete?.(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      options?.onError?.(err);
    }
  })();
},
```

The outer function returns `void`. The inner promise is explicitly discarded.

There is a particularly dangerous failure path:

1. `this.compact()` rejects.
2. Pi enters the inner `catch`.
3. The extension's `onError` reads stale `ctx.hasUI` and throws.
4. That throw occurs **inside the catch block**.
5. No outer catch observes it, and the async IIFE was launched with `void`.

That is the direct unhandled-rejection mechanism.

If `onComplete` throws, Pi's `try` catches that callback error and invokes `onError`. In the current extension, `continueAfterCompaction()` clears `forcedCompaction` before its first context read, so `onError` often returns early. That can suppress the thrown callback, but it also loses the continuation. This path is still incorrect even when it does not become unhandled.

### Pi deliberately invalidates old extension capabilities

`AgentSession.dispose()` in Pi 0.83.0:

```js
dispose() {
  // abort retry, compaction, branch summary, bash, and agent
  this._extensionRunner.invalidate("This extension ctx is stale ...");
  this._disconnectFromAgent();
  this._eventListeners = [];
  cleanupSessionResources(this.sessionId);
}
```

The extension runtime's action methods call `runtime.assertActive()` before doing anything. This applies to methods including:

- `pi.appendEntry()`;
- `pi.sendUserMessage()`;
- `pi.getAllTools()`;
- `pi.getActiveTools()`;
- context methods such as `ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.getSystemPrompt()`, and `ctx.compact()`.

The guard is correct. The extension is wrong to use those capabilities after relinquishing event-handler ownership.

### `dispose()` does not emit `session_shutdown`

The extension registers:

```ts
pi.on("session_shutdown", () => {
  payloadShapeBySession.clear();
  forcedCompaction = undefined;
});
```

That handler helps during host-managed shutdown/reload paths that explicitly emit the event. Direct `AgentSession.dispose()` does not emit it. A caller that owns a temporary or failed session can dispose it without giving this extension a shutdown callback.

Even if `session_shutdown` were emitted, merely clearing `forcedCompaction` would not cancel the remote operation or prove that all detached callbacks had stopped. Shutdown notification is not an asynchronous ownership primitive.

### There is a small compaction-observability window

Pi's manual `compact()` does this in order:

```js
this._disconnectFromAgent();
await this.abort();
this._compactionAbortController = new AbortController();
this._emit({ type: "compaction_start", reason: "manual" });
```

Between the initial `await this.abort()` and creation of `_compactionAbortController`/emission of `compaction_start`, external code cannot reliably infer that compaction is pending. Polling `isCompacting()` or waiting for `compaction_start` is therefore mitigation, not proof that all extension work is owned.

## Concrete failure timelines

### Failure timeline A: rejected compaction becomes an unhandled rejection

```text
agent_settled handler
  ├─ forcedCompaction = { phase: "compacting" }
  ├─ ctx.compact({ onComplete, onError })
  └─ returns immediately

caller
  ├─ sees prompt/session settle
  └─ session.dispose()
       └─ extension runtime becomes stale

detached Pi compaction
  ├─ rejects (abort, auth, network, or compaction error)
  └─ invokes onError(error)
       ├─ forcedCompaction = undefined
       └─ reads ctx.hasUI
            └─ throws stale-context error

void async IIFE
  └─ rejects with no observer
```

### Failure timeline B: successful compaction loses its continuation

```text
agent_settled handler starts detached compact and returns
caller disposes session
compaction succeeds
onComplete calls continueAfterCompaction(...)
  ├─ clears forcedCompaction
  └─ reads ctx.hasPendingMessages() -> stale-context throw
Pi catches callback throw and calls onError
onError sees forcedCompaction no longer matches and returns
result: callback error suppressed, continuation never sent
```

### Failure timeline C: status handling masks the original error

```text
session_before_compact awaits remote checkpoint
remote operation fails
withCompactionStatus catch tries pi.appendEntry("failed")
context is stale, so appendEntry throws
outer session_before_compact catch reads ctx again and may throw
result: stale-context failure replaces the useful remote/auth error
```

## Why `pi-delegate` exposes the defect

`pi-delegate` creates temporary child `AgentSession`s. A fresh stateless session is disposed as soon as the task runner returns. A successful session with a `sessionId` transfers ownership to the pool; failed or stateless sessions remain lifecycle-owned and are disposed.

The Codex compaction extension is allowlisted for `openai-codex` subagents because native compaction is important for long-running Codex tool loops. This creates the relevant lifecycle:

```text
child prompt -> extension starts post-settle compaction -> runner returns -> lifecycle disposes child
```

`pi-delegate` now has a post-prompt quiescence barrier in `quiescence.ts`. It waits for the session to be idle and non-compacting across stable event-loop turns, includes a cancellation grace period, re-aborts work that starts after cancellation, and bounds a cancelled unwind so a continuation loop cannot hang the task. Tests cover compaction callbacks and continuation turns.

That barrier reduces the race substantially, but it is not a proof for arbitrary detached extension work:

- Pi exposes no `hasPendingExtensionWork()` primitive;
- `ctx.compact()` returns no promise;
- detached work can pause before compaction becomes observable;
- extension callbacks can perform additional awaited work after `compaction_end`;
- a timer-based quiet period can always be outlasted.

The quiescence barrier is defense in depth. It cannot transfer ownership of work the extension chose not to return.

## Root cause

The root cause is **lost asynchronous ownership**.

Pi's event runner awaits handler return values:

```js
const handlerResult = await handler(event, ctx);
```

The extension could keep the `agent_settled` event alive until compaction callbacks finish. Instead, it invokes a callback-style fire-and-forget API and returns `undefined`. After that return, no caller has a promise representing the remaining extension work.

The stale context is the symptom. The missing ownership edge is the defect.

## Required extension fix

The fix should have three parts.

### 1. Keep `agent_settled` pending until compaction callbacks settle

Wrap `ctx.compact()` in a local promise and return/await that promise from the event handler:

```ts
async function compactAndContinue(
  ctx: ExtensionContext,
  compacting: ForcedCompactionState,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      ctx.compact({
        onComplete: () => {
          try {
            continueAfterCompaction(ctx, compacting);
          } catch (error) {
            reportCallbackFailure("completion", error);
          } finally {
            finish();
          }
        },
        onError: (error) => {
          try {
            handleCompactionError(ctx, compacting, error);
          } catch (callbackError) {
            reportCallbackFailure("error", callbackError);
          } finally {
            finish();
          }
        },
      });
    } catch (error) {
      reportCallbackFailure("start", error);
      finish();
    }
  });
}

pi.on("agent_settled", async (_event, ctx) => {
  // validate state...
  const compacting = { ...state, phase: "compacting" };
  forcedCompaction = compacting;
  await compactAndContinue(ctx, compacting);
});
```

Pi awaits extension event handlers, so this restores an explicit ownership chain:

```text
AgentSession -> ExtensionRunner.emit -> agent_settled handler
             -> local compact promise -> onComplete/onError
```

The promise must settle exactly once on every path, including synchronous `ctx.compact()` failure and callback exceptions.

### 2. Snapshot immutable inputs before awaits

`createNativeCheckpoint()` should gather all session-bound values before awaiting authentication or the network:

```ts
const sessionId = ctx.sessionManager.getSessionId();
const instructions = ctx.getSystemPrompt();
const allTools = pi.getAllTools();
const activeTools = pi.getActiveTools();
const authPromise = ctx.modelRegistry.getApiKeyAndHeaders(model);

const auth = await authPromise;
// Build the request only from snapshots from here onward.
```

No `ctx` or `pi` action should occur after the first await unless the surrounding handler still demonstrably owns the context.

Snapshotting does not make session mutations safe. Operations such as `appendEntry`, UI notification, and continuation dispatch must still happen only while the handler owns the live context.

### 3. Make status/error callbacks non-throwing

Cosmetic status and notification code must not replace the compaction result. Callback bodies need a final defensive boundary:

```ts
function reportCallbackFailure(phase: string, error: unknown): void {
  // Do not call ctx or pi here: they may be the failing stale capabilities.
  console.error(`[pi-codex-compaction] ${phase} callback failed`, error);
}
```

Do not swallow arbitrary errors silently. Report them through a boundary that does not itself depend on the possibly stale context. If the error is recognized as expected disposal, logging can be reduced, but correctness must not depend on parsing one exact error string.

## Recommended Pi host improvements

The extension can fix this defect without a Pi release by returning a promise from `agent_settled`. Pi could nevertheless make this class of defect harder to write:

1. Add an awaitable compaction API, for example `await ctx.compactAsync(options)`.
2. Return the internal promise from `ctx.compact()` rather than discarding it.
3. Expose session-lifetime cancellation separately from the current agent-operation signal.
4. Expose pending extension work to owners, e.g. `AgentSession.waitForExtensionIdle()`.
5. Wrap exceptions thrown by `onError` so a callback cannot reject an unobserved internal IIFE.
6. Consider emitting a disposal-specific lifecycle event, while documenting that notification is not a replacement for awaiting owned work.

The host should still retain stale-context checks. Removing those checks would hide the bug and risk mutation through obsolete capabilities.

## Test plan for the upstream fix

The package should add deterministic lifecycle tests. Sleeping and hoping to hit the race is insufficient.

### Test 1: `agent_settled` owns callback completion

- Register the extension against a fake Pi API.
- Force `forcedCompaction.phase = "waitingForSettle"` through the normal turn path.
- Have fake `ctx.compact()` capture callbacks without invoking them.
- Invoke the registered `agent_settled` handler.
- Assert its returned promise remains pending.
- Invoke `onComplete`.
- Assert continuation is sent and the handler promise resolves.

This test fails against 0.1.3 because the handler returns immediately.

### Test 2: error callback never rejects detached work

- Capture `onError` as above.
- Invalidate the fake context before invoking it.
- Invoke `onError(new Error("remote failure"))`.
- Assert no throw escapes and the owning handler promise settles.
- Assert the failure is logged without accessing stale UI.

### Test 3: dispose during authentication

- Make `getApiKeyAndHeaders()` return a controlled promise.
- Start `session_before_compact`.
- Invalidate the context while authentication is pending.
- Resolve authentication.
- Assert no post-await `ctx`/`pi` access occurs.
- Assert the handler returns a controlled cancellation/failure result rather than throwing a stale-context error.

### Test 4: dispose during remote compaction

- Start a controlled remote request.
- Abort/dispose before completion.
- Complete or reject the request.
- Assert all promises settle, no continuation is sent, and no unhandled rejection occurs.

### Test 5: callback exception containment

- Make continuation dispatch throw a non-stale error.
- Assert the error is reported.
- Assert `onError` does not recursively throw.
- Assert the handler promise still settles exactly once.

### Test 6: normal behavior remains intact

- Successful forced compaction sends exactly one continuation.
- Failed compaction clears forced state and sends no continuation.
- Pi-owned threshold/overflow compaction does not trigger duplicate compaction.
- TUI status entries remain best-effort and never change compaction success.

## Acceptance criteria

The defect is fixed when all of the following hold:

- No event-scoped `ctx` or `pi` capability is used by unowned detached work.
- The `agent_settled` handler remains pending until `ctx.compact` completion/error callbacks finish.
- Every callback path settles its ownership promise exactly once.
- `onComplete` and `onError` cannot throw into Pi's discarded async IIFE.
- Native checkpoint creation performs no session/API reads after its first await.
- Disposal during authentication, compaction, callback execution, and continuation scheduling produces no stale-context error or unhandled rejection.
- Successful compaction still sends exactly one continuation when the session remains live.
- `session_shutdown` is treated as cleanup notification, not as proof that detached work ended.
- Pi's stale-runtime guards remain enabled.

## Mitigation and release policy

Until a fixed package release is available:

- `pi-delegate`'s quiescence barrier should remain enabled as defense in depth.
- Do not add progressively longer arbitrary sleeps as the primary fix.
- Do not hand-edit installed `node_modules`.
- Prefer pinning a reviewed fixed package/fork if the failure is reproducible in release verification.
- Disabling native compaction is not automatically safer: long Codex tool loops can exceed context thresholds and incur substantial reliability/cost problems. Any temporary disablement should be an explicit release decision with that trade-off documented.

Once upstream releases a fix, `pi-delegate` should pin or require the first lifecycle-safe version, retain its quiescence tests, and run a real delegated Codex compaction scenario before removing any mitigation.

## Upstream issue summary

A concise issue description derived from this analysis:

> `pi-codex-compaction` 0.1.3 starts `ctx.compact()` from `agent_settled` and returns before its callbacks finish. Pi's `ctx.compact` is fire-and-forget; `AgentSession.dispose()` can therefore invalidate the extension runtime before `onComplete`/`onError` use their captured `ctx` and `pi`. The error callback can throw from inside Pi's detached async catch block, creating an unhandled-rejection hazard. Other post-await paths (`createNativeCheckpoint`, `withCompactionStatus`, and the `session_before_compact` catch) also dereference live capabilities after async boundaries and can mask the original error. Return a promise from `agent_settled` that settles with the compact callbacks, snapshot immutable request inputs before awaits, and make callback/status error boundaries non-throwing. Add deterministic disposal-during-auth/compaction/callback tests.

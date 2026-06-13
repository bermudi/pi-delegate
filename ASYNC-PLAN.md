# Async Delegate — Implementation Plan

**Status:** Draft (post-oracle review — see Appendix A)
**Date:** 2026-05-25
**Scope:** `pi/delegate/delegate.ts` — single file, no core changes

---

## Problem

`delegate` blocks the parent agent until all subagents complete. The parent can't
do other work (read files, edit code, reason) while subagents run in parallel.

## Solution

Fire-and-forget + poll. Spawn subagents in the background, return a ticket ID
immediately, deliver results when done. The parent agent keeps working.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Parent Agent Loop                                   │
│                                                      │
│  Turn 1:  delegate({async:true, tasks:[...]})        │
│           read("file")                               │
│           edit("file")                               │
│           → returns ticket ID + read/edit results    │
│                                                      │
│  ┌─ context handler ──────────────────────────────┐ │
│  │  Injects "1 async ticket running" reminder     │ │
│  │  on every LLM call until ticket completes      │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  Turn 2:  delegate({action:"poll", ticket:"abc"})    │
│           → "still running" or full results          │
│                                                      │
│  Turn N:  (background ticket completes)              │
│           sendMessage({deliverAs:"followUp"})        │
│           → triggers new turn with results           │
└─────────────────────────────────────────────────────┘
```

No core changes. Uses existing `ExtensionAPI` hooks:

| Hook | Purpose |
|------|---------|
| `pi.sendMessage({deliverAs:"followUp"})` | Push results to parent when background ticket completes |
| `pi.on("session_shutdown")` | Abort all background tickets on session end |

> **Note:** `pi.on("context")` was originally planned for injecting ticket reminders
> into every LLM call. Oracle review identified critical problems with this approach
> (see Appendix A, Issue #3). **Removed in favor of push-only delivery via
> `sendMessage`.** The LLM gets results when they're ready — no polling reminders needed.

---

## New Types

```ts
interface AsyncTicket {
  id: string;                        // nanoid, 8 chars
  created: number;                   // Date.now()
  completedAt?: number;
  tasks: TaskDef[];                  // original task definitions
  resolved: ResolvedTask[];          // resolved configs (model, tools, etc.)
  status: "running" | "done" | "failed" | "cancelled";
  results: TaskResult[];             // filled on completion
  progress: TaskProgress[];          // live-updated by background workers
  controller: AbortController;       // independent lifecycle
  error?: string;                    // top-level error (e.g. all failed)
  parentModelId?: string;
}

// Module-level registry (alongside existing agentPool)
const ticketRegistry = new Map<string, AsyncTicket>();
```

## New Parameters

Added to the **top-level** parameter schema (not per-task):

```ts
async: Type.Optional(Type.Boolean({
  description: "Return immediately with a ticket ID. Poll with action='poll'.",
})),

ticket: Type.Optional(Type.String({
  description: "Ticket ID for poll/cancel actions.",
})),
```

## New Actions

Extended `action` enum: `"prompt" | "close" | "list" | "poll" | "cancel"`

### `delegate({ action: "poll" })`
- No ticket: list all tickets with one-line status each
- With ticket: return progress/results for that ticket

### `delegate({ action: "poll", ticket: "abc123" })`
- Running → terse status (task states, durations, current tool)
- Done → full results (same format as sync delegate)
- Failed → error + partial results

### `delegate({ action: "cancel", ticket: "abc123" })`
- Aborts the ticket's AbortController
- Sets status to "cancelled"
- Returns confirmation

---

## Constants

```ts
const MAX_ASYNC_TICKETS = 5;        // global cap on concurrent background tickets
const ASYNC_TICKET_TTL_MS = 30 * 60 * 1000;  // completed tickets cleaned up after 30 min
const ASYNC_MAX_RUNTIME_MS = 30 * 60 * 1000;  // hard timeout per ticket
```

---

## Implementation Steps

### Step 1: Ticket registry + helpers

Add alongside `agentPool` at module level:

```ts
const ticketRegistry = new Map<string, AsyncTicket>();

function generateTicketId(): string {
  // 8-char alphanumeric, no lookalikes
  return Math.random().toString(36).slice(2, 10);
}

function sweepTickets(): void {
  const now = Date.now();
  for (const [id, ticket] of ticketRegistry) {
    // Hard runtime timeout
    if (ticket.status === "running" && now - ticket.created > ASYNC_MAX_RUNTIME_MS) {
      ticket.controller.abort();
      ticket.status = "failed";
      ticket.error = "Exceeded maximum runtime";
      ticket.completedAt = now;
    }
    // TTL cleanup for completed/failed/cancelled
    if (ticket.status !== "running" && ticket.completedAt && now - ticket.completedAt > ASYNC_TICKET_TTL_MS) {
      ticketRegistry.delete(id);
    }
  }
}
```

### Step 2: Route `action: "poll"` and `"cancel"` at top of `execute()`

```ts
async execute(_id, params, signal, onUpdate, ctx) {
  // ── Poll action ───────────────────────────────────────────────
  if (params.action === "poll") {
    return handlePoll(params, ctx);
  }

  // ── Cancel action ─────────────────────────────────────────────
  if (params.action === "cancel") {
    return handleCancel(params);
  }

  // ... existing help/validation/resolution flow ...
```

### Step 3: `handlePoll()`

```ts
function handlePoll(params, ctx): AgentToolResult<DelegateDetails> {
  sweepTickets();

  // No ticket specified — list all
  if (!params.ticket) {
    const tickets = [...ticketRegistry.values()];
    if (!tickets.length) {
      return {
        content: [{ type: "text", text: "No async tickets." }],
        details: { tasks: [], results: [], progress: [], parentModel: ctx.model?.id },
      };
    }
    const lines = tickets.map(t => {
      const icon = t.status === "running" ? "⏳" : t.status === "done" ? "✓" : "✗";
      const done = t.progress.filter(p => p.status === "done").length;
      const age = fmtDuration(Date.now() - t.created);
      return `${icon} ${t.id} · ${done}/${t.progress.length} tasks · ${t.status} · ${age}`;
    });
    return {
      content: [{ type: "text", text: `Async tickets:\n${lines.join("\n")}` }],
      details: { tasks: [], results: [], progress: [], parentModel: ctx.model?.id },
    };
  }

  // Specific ticket
  const ticket = ticketRegistry.get(params.ticket);
  if (!ticket) {
    return {
      content: [{ type: "text", text: `Ticket '${params.ticket}' not found. It may have expired or never existed.` }],
      details: { tasks: [], results: [], progress: [], parentModel: ctx.model?.id },
    };
  }

  if (ticket.status === "running") {
    // Terse progress — no output dumps
    const lines = ticket.progress.map(p => {
      const icon = p.status === "done" ? "✓" : p.status === "running" ? "⏳" : p.status === "failed" ? "✗" : "○";
      const activity = p.activities.findLast(a => !a.result);
      const currentTool = activity ? ` · ${formatToolCallShort(activity.name, activity.args)}` : "";
      const duration = fmtDuration(Date.now() - ticket.created);
      return `${icon} ${p.agent} · ${p.status}${currentTool} · ${duration}`;
    });
    return {
      content: [{ type: "text", text: `Ticket ${ticket.id}: RUNNING (${fmtDuration(Date.now() - ticket.created)})\n${lines.join("\n")}` }],
      details: { tasks: ticket.tasks, results: [], progress: [...ticket.progress], parentModel: ticket.parentModelId },
    };
  }

  // Done / Failed / Cancelled — full results
  return formatCompletedTicket(ticket);
}
```

`formatCompletedTicket()` reuses the existing result formatting logic from the
sync path (the `parts` array builder at the bottom of `execute()`).

### Step 4: `handleCancel()`

```ts
function handleCancel(params): AgentToolResult<DelegateDetails> {
  if (!params.ticket) {
    return {
      content: [{ type: "text", text: "action='cancel' requires a ticket ID." }],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  const ticket = ticketRegistry.get(params.ticket);
  if (!ticket) {
    return {
      content: [{ type: "text", text: `Ticket '${params.ticket}' not found.` }],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  if (ticket.status !== "running") {
    return {
      content: [{ type: "text", text: `Ticket '${params.ticket}' is already ${ticket.status}.` }],
      details: { tasks: [], results: [], progress: [] },
    };
  }
  ticket.controller.abort();
  ticket.status = "cancelled";
  ticket.completedAt = Date.now();
  return {
    content: [{ type: "text", text: `Ticket '${params.ticket}' cancelled.` }],
    details: { tasks: [], results: [], progress: [] },
  };
}
```

### Step 5: Async dispatch in `execute()`

After existing validation and resolution, before the sync `mapConcurrent` call.

**Critical implementation notes** (from Oracle review):

1. **Signal must be `controller.signal`, not `signal`.** The `signal` parameter
   from `execute()` is the parent turn's abort signal. If the user cancels
   the parent turn, `signal` fires and kills background tasks. Must explicitly
   pass `controller.signal` to `runAgent()`.

2. **Suppress `onUpdate`/`fire()`.** The sync path defines `const fire = () =>
   onUpdate?.(...)`. After `execute()` returns, the TUI component is finalized.
   Background workers must NOT call `fire()` — they update `ticket.progress[]`
   directly instead.

3. **Use `Promise.allSettled` semantics.** `mapConcurrent` uses `Promise.all`
   internally. If one task throws, the whole ticket fails — but sibling tasks
   keep running and mutate state on a "failed" ticket. Wrap each task body in
   try/catch so individual failures populate `ticket.results[i]` without
   rejecting the whole `mapConcurrent`.

```ts
// ── Async mode ─────────────────────────────────────────────────
if (params.async) {
  sweepTickets();
  const runningCount = [...ticketRegistry.values()].filter(t => t.status === "running").length;
  if (runningCount >= MAX_ASYNC_TICKETS) {
    return {
      content: [{ type: "text", text: `Too many async tickets running (${runningCount}/${MAX_ASYNC_TICKETS}). Poll existing tickets or cancel one first.` }],
      details: { tasks: params.tasks, results: [], progress: [], parentModel: parentModelId },
    };
  }

  const ticketId = generateTicketId();
  const controller = new AbortController();
  const ticket: AsyncTicket = {
    id: ticketId,
    created: Date.now(),
    tasks: params.tasks,
    resolved,
    status: "running",
    results: new Array(resolved.length),
    progress: [...progress],  // clone the progress array we already built
    controller,
    parentModelId,
  };
  ticketRegistry.set(ticketId, ticket);

  // Capture values needed in the closure — do NOT use `signal` from execute()
  const ticketSignal = controller.signal;
  const modelRegistry = ctx.modelRegistry;

  // Fire and forget — runs on the event loop
  mapConcurrent(resolved, MAX_CONCURRENCY, async (t, i) => {
    // IMPORTANT: wrap each task in try/catch so one failure
    // doesn't reject the entire mapConcurrent promise.
    try {
      // ... same task body as sync path, with two changes: ...
      //
      // 1. Pass ticketSignal (NOT signal from execute closure) to runAgent:
      //    const r = await runAgent(config, prompt, modelRegistry, ticketSignal, ...);
      //
      // 2. Use a wrapped onProgress that updates ticket.progress[i]
      //    but does NOT call fire()/onUpdate:
      //    const onProgress = (u) => {
      //      p.tokens = u.tokens; p.toolUses = u.toolUses; ...;
      //      // NO fire() call — just mutate ticket state
      //    };
      //
      const result = await runAgent(config, prompt, modelRegistry, ticketSignal, onProgress, ...);
      ticket.results[i] = result;
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ticket.results[i] = {
        agent: t.agentName,
        output: "",
        error: msg,
        durationMs: 0,
        tokens: 0,
        sessionFile: undefined,
        touchedFiles: [],
      };
      ticket.progress[i]!.status = "failed";
      ticket.progress[i]!.error = msg;
      return ticket.results[i];
    }
  }, ticketSignal).then(() => {
    // Check if all individual results were set
    const allDone = ticket.results.every(r => r !== undefined);
    const anyFailed = ticket.results.some(r => r && "error" in r && r.error);
    ticket.status = anyFailed ? "failed" : "done";
    ticket.completedAt = Date.now();
    deliverTicketResults(pi, ticket);
  }).catch((err) => {
    // This should NOT happen if individual tasks catch properly,
    // but defense-in-depth.
    ticket.status = "failed";
    ticket.error = err instanceof Error ? err.message : String(err);
    ticket.completedAt = Date.now();
    deliverTicketResults(pi, ticket);
  });

  const done = progress.filter(p => p.status === "done").length;
  return {
    content: [{
      type: "text",
      text: [
        `Async ticket: ${ticketId}`,
        `${resolved.length} task(s) dispatched · ${runningCount + 1}/${MAX_ASYNC_TICKETS} async slots in use`,
        "",
        "Results will be delivered when all tasks complete.",
        `Poll anytime: delegate({ action: "poll", ticket: "${ticketId}" })`,
        `Cancel if needed: delegate({ action: "cancel", ticket: "${ticketId}" })`,
      ].join("\n"),
    }],
    details: { tasks: params.tasks, results: [], progress: [...progress], parentModel: parentModelId },
  };
}

// ── Sync mode (existing path, unchanged) ────────────────────────
const results = await mapConcurrent(resolved, MAX_CONCURRENCY, ...);
// ...
```

// ── Sync mode (existing path, unchanged) ────────────────────────
const results = await mapConcurrent(resolved, MAX_CONCURRENCY, ...);
// ...
```

### Step 6: `deliverTicketResults()` — push results into parent

```ts
function deliverTicketResults(pi: ExtensionAPI, ticket: AsyncTicket): void {
  if (!ticket.completedAt) return;

  const status = ticket.status === "done" ? "completed" : ticket.status;
  const succeeded = ticket.results.filter(r => r && !("error" in r && r.error)).length;
  const total = ticket.results.length;
  const summary = `Async delegate ${ticket.id} ${status}: ${succeeded}/${total} tasks`;

  pi.sendMessage({
    customType: "async_delegate_result",
    content: { ticketId: ticket.id, summary },
    display: summary,
    details: { ticketId: ticket.id, status: ticket.status },
  }, {
    deliverAs: "followUp",   // triggers new turn after agent would stop
    triggerTurn: true,        // if not streaming, starts a turn
  });
}
```

### ~~Step 7: `pi.on("context")`~~ — REMOVED

**Oracle review killed this.** Problems:

1. **Token bloat**: Injecting a `role: "user"` message on every LLM call
   burns tokens and degrades attention. If the parent does 20 file reads while
   waiting, that's 20 duplicate reminder messages.

2. **Role alternation breakage**: Injecting a `user` message after a
   `toolResult` (which is also `user` role) violates the strict user/assistant
   alternation required by APIs like Anthropic. Will cause API 400 errors.

3. **Wrong primitive**: Reminders are a prompt engineering concern, not a
   runtime injection. The push-based `sendMessage` delivery is sufficient.

**Replacement strategy:** Rely entirely on `deliverTicketResults()` pushing
results via `sendMessage({deliverAs: "followUp"})`. The LLM doesn't need to
poll — results arrive automatically. The `poll` action exists for the human
user or for the LLM to check partial progress if it explicitly wants to.

Prompt guidelines updated to: "Async results are delivered automatically when
complete. You may poll for partial progress with delegate({action:\"poll\"})."

### Step 8: `pi.on("session_shutdown")` — cleanup

```ts
  pi.on("session_shutdown", () => {
    for (const ticket of ticketRegistry.values()) {
      if (ticket.status === "running") {
        ticket.controller.abort();
        ticket.status = "cancelled";
        ticket.completedAt = Date.now();
      }
    }
    ticketRegistry.clear();
  });
```

### Step 9: Pooled session guard for async tickets

**The session busy guard must apply to ALL delegate calls, not just async.**

Oracle identified: if an async ticket holds `sessionId: "auth"`, and the parent
agent later calls `delegate` *synchronously* on `sessionId: "auth"`, it falls
into `withSessionLock` which awaits the lock. This blocks the parent turn
indefinitely (up to 30 min) — the exact problem async was supposed to solve.

**Fix:** Add a `isSessionBusy(sessionId)` check at the top of the task body
for both sync and async paths:

```ts
// Helper — check if any running async ticket holds this session
function isSessionBusy(sessionId: string): string | null {
  for (const ticket of ticketRegistry.values()) {
    if (ticket.status !== "running") continue;
    if (ticket.resolved.some(t => t.sessionId === sessionId)) {
      return ticket.id;
    }
  }
  return null;
}

// At the start of each task in mapConcurrent (sync AND async):
if (t.sessionId) {
  const busyTicketId = isSessionBusy(t.sessionId);
  // For sync path: check if ANOTHER ticket holds it
  // For async path: check if a DIFFERENT ticket holds it
  if (busyTicketId && busyTicketId !== currentTicketId) {
    p.status = "failed";
    p.error = `Session '${t.sessionId}' is busy with async ticket ${busyTicketId}. Poll or cancel that ticket first.`;
    fire();
    return { agent: t.agentName, output: "", error: p.error, durationMs: 0, tokens: 0, sessionFile: undefined, touchedFiles: [] };
  }
}
```

**Pool insertion race condition:** Async tasks that create pooled agents
(`pendingPoolInsert`) must insert into `agentPool` **synchronously** before
`runAgent` starts — not in `.then()`. Otherwise, a second async ticket with
the same `sessionId` will miss the pool, create a duplicate agent, and two
agents will fight over the same session file.

```ts
// Insert placeholder immediately when creating a new pooled agent:
if (t.sessionId && pendingPoolInsert) {
  agentPool.set(t.sessionId, {
    agent: existingAgent!,  // the freshly created agent
    sessionManager: session.manager!,
    sessionFile: session.file!,
    config: { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    totalTokens: 0,
    promptCount: 0,
  });
  pendingPoolInsert = false;  // already inserted
}
```

---

## Parameter Schema Changes

```diff
 parameters: Type.Object({
+  async: Type.Optional(Type.Boolean({
+    description: "Return immediately with a ticket ID. Poll with action='poll'.",
+  })),
+  ticket: Type.Optional(Type.String({
+    description: "Ticket ID for poll/cancel actions.",
+  })),
   tasks: Type.Array(
     Type.Object({
       // ... existing fields ...
       action: Type.Optional(Type.String({
-        enum: ["prompt", "close", "list"],
-        description: "'prompt' (default) runs a task, 'close' tears down a pooled session, 'list' shows active sessions.",
+        enum: ["prompt", "close", "list", "poll", "cancel"],
+        description: "'prompt' (default), 'close' tears down pooled session, 'list' shows sessions, 'poll' checks async tickets, 'cancel' aborts async ticket.",
       })),
       // ...
     }),
   ),
 }),
```

---

## Prompt Guidelines Update

```ts
promptGuidelines: [
  // ... existing guidelines ...
  "For async mode: set async:true to fire tasks in the background. You MUST poll async tickets before telling the user work is complete. Use delegate({action:\"poll\"}) to check status or delegate({action:\"poll\",ticket:\"id\"}) for a specific ticket.",
  "Async results are automatically delivered when complete. You can continue other work while waiting.",
],
```

## Help Text Update

Add to the help output (empty tasks array):

```markdown
## Async Mode

Set `async: true` on the top-level call to fire tasks in the background:

delegate({ async: true, tasks: [{ agent: "scout", prompt: "Investigate auth" }] })
→ Returns ticket ID immediately. Parent keeps working.

- delegate({ action: "poll" }) — list all tickets
- delegate({ action: "poll", ticket: "abc123" }) — check one ticket
- delegate({ action: "cancel", ticket: "abc123" }) — abort a running ticket

Max 5 concurrent async tickets. Completed tickets auto-deliver results.
```

---

## TUI Rendering

The existing `renderCall` and `renderResult` handle the tool display. For async:

- **Async dispatch**: render the ticket ID and status (reuse existing spinner)
- **Poll (running)**: render progress tree (reuse existing partial rendering logic)
- **Poll (done)**: render full results (reuse existing final rendering logic)
- **Cancel**: simple confirmation text

The `renderResult` function already handles `isPartial` (streaming) vs final
states. Async poll of a running ticket uses the same `isPartial: true` path.

---

## Edge Cases

| Case | Handling |
|------|----------|
| LLM fires async, never polls | Results auto-delivered via `sendMessage({deliverAs:"followUp"})` when ticket completes. No polling needed. |
| LLM polls a cancelled ticket | Returns "cancelled" status with whatever partial results exist |
| Parent session ends mid-ticket | `session_shutdown` handler aborts all tickets |
| Two async tickets share a sessionId | Rejected at validation time (existing duplicate sessionId check) |
| Sync delegate called on a sessionId busy with async | Fail fast with "session busy" error + ticket ID |
| Rate limit exhaustion from too many async agents | Global cap (MAX_ASYNC_TICKETS=5) + per-ticket concurrency (MAX_CONCURRENCY=3) = max 15 concurrent API streams |
| Ticket expires before LLM polls | TTL sweeper cleans up. Poll returns "not found". Results already delivered via followUp. |

---

## Test Plan

### Unit tests (delegate.test.ts)

1. **Async dispatch**: `execute()` with `async: true` returns immediately with ticket ID, ticket appears in registry
2. **Poll running**: `action: "poll"` on running ticket returns progress without blocking
3. **Poll completed**: `action: "poll"` on done ticket returns full results
4. **Poll list**: `action: "poll"` with no ticket lists all tickets
5. **Cancel**: `action: "cancel"` aborts the ticket, status becomes "cancelled"
6. **Cap enforcement**: 6th async dispatch is rejected
7. **Pooled session conflict**: async ticket holding sessionId blocks sync call
8. **TTL cleanup**: completed tickets are removed after TTL
9. **Hard timeout**: running ticket is aborted after max runtime
10. **Context injection**: `context` event handler produces reminder when tickets are running
11. **Session shutdown**: all running tickets are aborted on shutdown event
12. **Signal independence**: parent signal abortion does NOT kill async ticket (fresh AbortController)

### Integration test (manual)

1. Fire async delegate with 3 scout tasks
2. While running, call `read` on a file → should return immediately
3. Poll → see progress
4. Wait for completion → followUp message arrives with results
5. Fire async delegate, then cancel → ticket aborted, resources freed

---

## File Changes

**Single file:** `pi/delegate/delegate.ts`

| Section | Change |
|---------|--------|
| Types | Add `AsyncTicket` interface |
| Module-level state | Add `ticketRegistry`, `MAX_ASYNC_TICKETS`, TTL constants |
| Helpers | Add `sweepTickets()`, `generateTicketId()`, `handlePoll()`, `handleCancel()`, `deliverTicketResults()` |
| Parameter schema | Add `async`, `ticket` fields; extend `action` enum |
| `execute()` | Route `poll`/`cancel` at top; add async dispatch branch before sync path |
| `renderCall` / `renderResult` | Handle async-specific display states |
| Extension factory | Register `pi.on("context")`, `pi.on("session_shutdown")` handlers |
| Help text | Add async mode section |
| Prompt guidelines | Add async usage guideline |

Estimated: ~300-400 lines added. No existing sync path logic changes.

---

## Appendix A: Oracle Review Findings

*Source: Deep analysis against `delegate.ts` source code*

### Issue #1: Signal Closure Bug (CRITICAL)

**Problem:** The `signal` parameter in `execute(_id, params, signal, onUpdate, ctx)`
is the parent turn's AbortSignal. If the plan's async task body uses `signal` from
the closure (which the sync path does), Ctrl+C on the parent turn kills all
background tasks.

**Fix:** Explicitly capture `controller.signal` and pass it to `runAgent()`,
never the parent `signal`. Verified in Step 5 above.

### Issue #2: `onUpdate` / `fire()` After Tool Completion (CRITICAL)

**Problem:** The sync path defines `const fire = () => onUpdate?.(...)` and
passes `onProgress` callbacks that call `fire()`. After `execute()` returns,
the TUI component is finalized. Background workers calling `fire()` invoke
`onUpdate` on a dead tool execution context — causing exceptions or silent failures.

**Fix:** Background workers must use a wrapped `onProgress` that mutates
`ticket.progress[i]` directly without calling `fire()`. Verified in Step 5.

### Issue #3: `pi.on("context")` Fake User Message (REMOVED)

**Problem:** Injecting `role: "user"` messages on every LLM call:
1. **Token bloat** — 20 file reads = 20 duplicate reminder messages burning tokens
2. **Role alternation violation** — `toolResult` is `user` role; injecting another
   `user` message immediately after breaks Anthropic API's strict alternation
3. **Wrong abstraction** — context injection is a runtime band-aid for a prompt
   engineering problem

**Decision:** Removed entirely. Rely on push delivery via `sendMessage`.

### Issue #4: `mapConcurrent` / `Promise.all` Partial Failures (CRITICAL)

**Problem:** `mapConcurrent` uses `Promise.all`. If one task throws, the whole
promise rejects — but sibling tasks keep running and mutate state on a ticket
already marked "failed".

**Fix:** Wrap each task body in try/catch so individual failures populate
`ticket.results[i]` without rejecting. Verified in Step 5.

### Issue #5: Sync Delegate Deadlock on Busy Session (CRITICAL)

**Problem:** The session busy guard only applied to async tickets. If an async
ticket holds `sessionId: "auth"`, a subsequent *sync* `delegate` call on the
same session falls into `withSessionLock`, blocking the parent turn indefinitely.

**Fix:** The busy session guard must apply to ALL delegate calls, not just
async. Added `isSessionBusy()` helper. Verified in Step 9.

### Issue #6: Pool Insertion Race Condition

**Problem:** Plan originally said "insert into `agentPool` in `.then()` after
`mapConcurrent` resolves." If a second async ticket uses the same `sessionId`
before `.then()` fires, it misses the pool and creates a duplicate agent.

**Fix:** Insert into `agentPool` synchronously when the agent is created,
before `runAgent` starts. Verified in Step 9.

### Issue #7: `sweepTickets()` in `context` Event

**Problem:** Originally planned to call `sweepTickets()` inside the `context`
event handler (now removed). This was dangerous because `context` fires multiple
times per turn and sweeping (aborting controllers, deleting entries) during
streaming could kill tasks unexpectedly.

**Fix:** Sweeping only happens on explicit tool calls (`poll`, `cancel`, new
`delegate` calls) — never in event handlers.

### Issue #8: `deliverAs: "followUp"` When Agent Is Idle

**Problem:** If the agent is not streaming when `sendMessage` fires,
`deliverAs: "followUp"` queues a message that triggers a new turn. But if the
agent is paused (waiting for tool approval or user input), forcing a turn might
bypass approvals or crash.

**Mitigation:** This is an existing framework behavior, not something we
introduce. `followUp` messages are designed for this exact use case. If the
agent is truly paused, the followUp waits in the queue until the agent resumes.

### Design Decision: Push > Poll

The oracle's strongest recommendation: **design around push, not poll.**
The `sendMessage` followUp is the primary delivery mechanism. `poll` is a
secondary feature for checking partial progress. This eliminates the need
for context injection and reduces the LLM's cognitive burden.

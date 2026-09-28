# Pi-upgrade checklist

Every host boundary pi-delegate v3 depends on. Verify each on every Pi
bump, in order; a failed seam here is a silent contract break (#15).

## Hard seams (breakage = wrong behavior, not errors)

1. **Harness patches (`patches/`)** — three, all required for the test
   harness on the pinned Pi version:
   - `getModel` from `pi-ai/compat` + `_modelRuntime.setRuntimeApiKey`
     + `agent.streamFunction` (pre-0.86 auth preflight and renames).
   - Globally unique playbook tool-call ids (`playbook.js`) — Pi ≥ 0.87
     executes extension tools outside `agent.setTools()` wrappers;
     per-run id restarts make later runs' results vanish from session
     events.
   - The event mirror honors `result.isError` (`session.js`) — Pi sets
     `tool_execution_end.isError` only for THROWN errors; delegate
     reports errors as returned results.
2. **`SessionManager._rewriteFile()`** (private) — failed-run
   transcript persistence force-flushes a header-only session file
   (`src/sessions.ts` `persistSessionHeader`). Upstream gates the
   first write behind the first assistant message. Optional-chained
   and fail-soft: if the method disappears, failed fresh runs report
   no transcript (logged). Verify existence and semantics.
3. **`Agent.steer()` / follow-up queues** — steering rides
   `AgentSession.steer(text)` → queue drained at run start and every
   `turn_end` (`pi-agent-core/dist/agent-loop.js:85,186`); a queued
   steer during the final turn forces one more provider turn. Follow-up
   drains only at would-stop — the wrong seam for steering. Verify
   drain points and durability (drained steering → session messages).
4. **`api.sendMessage(message, { deliverAs: "followUp", triggerTurn })`**
   — wake delivery, question wakes, moved-leaf appends. Verify both
   flag semantics (followUp queues behind a busy parent's tool calls;
   `triggerTurn: false` appends durably without waking).
5. **Session lifecycle asymmetry** — `session.dispose()` does NOT fire
   `session_shutdown` (learned 2026-09-27: a delivery flush computing
   leaf routing against a disposed session's branch throws). Any code
   touching sessions after teardown must guard. Verify on every bump.
6. **`sessionManager.getBranch()` + navigation epochs** — leaf-aware
   delivery computes same-branch from the branch id chain. Verify
   branch representation stays an id-bearing entry list.
7. **`AgentSession.isStreaming`** — covers the whole run including
   turn gaps; `steer()` on a non-streaming session sits until the next
   `prompt()` and never starts a turn itself. Our `activated` receipt
   depends on this. Verify.
8. **Schema enforcement at the host layer** — `additionalProperties:
   false` rejects unknown fields BEFORE extension code runs (misfire
   rows cannot see these). Compat spellings must live in the schema,
   not the handler. Verify the host still enforces TypeBox
   additionalProperties.

## Soft seams (degrade gracefully)

9. **`runtime-credentials`** — pooled-session reload after residency
   unload re-acquires runtime credentials through the standard
   session-open path; no direct API use, but verify reloads under a
   rotated key behave (reject loudly, never silently no-op).
10. **Tool description channel** — the registered schema descriptions
    are the only channel to trained weights. Verify Pi renders the
    full field descriptions to the model (no truncation on bump).
11. **`pi-ai` faux provider** — `installSubagentModel` test strategy
    assumes delegate resolves and streams subagent models through the
    parent session's model runtime. Verify on bump.
12. **`typebox` pin** — must mirror pi-coding-agent's exact pin
    (schema symbol identity across instances). Re-align every bump.

## Bump procedure

Run `bun install` against the bumped pins, re-apply/verify `patches/`,
then `bun run typecheck && bun test` — then a live `pi -ne -e
<repo>/delegate.ts` dogfood dispatching a real batch with telemetry
enabled (the suite cannot catch host-layer seams; the dogfood can).

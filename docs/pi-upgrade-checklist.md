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
2. **`SessionManager._rewriteFile()`** (private) — The private
   header-write capability lives in src/pi-compat.ts. Required
   pre-first-turn persistence fails dispatch on a missing/broken
   capability; post-effect transcript reporting remains best-effort.
   Reopening the identical newly persisted file through public
   setSessionFile must preserve the next append; verify real host death
   before its first assistant event and subsequent successful append.
3. **`Agent.steer()` / follow-up queues** — steering rides
   `AgentSession.steer(text)` → queue drained at run start and every
   `turn_end` (`pi-agent-core/dist/agent-loop.js:85,186`); a queued
   steer during the final turn forces one more provider turn. Follow-up
   drains only at would-stop — the wrong seam for steering. Verify
   drain points and durability (drained steering → session messages).
4. **`api.sendMessage(message, { deliverAs: "steer", triggerTurn: true })`**
   — same-leaf result and worker-question wakes. On a busy parent, verify
   delivery at the next turn boundary after the current tool calls and
   before the next model call; on an idle parent, verify a new turn.
   Moved-leaf messages instead use `triggerTurn: false`, appending durably
   without waking. `followUp` is historical here (replaced 2026-10-02): it
   drains only when the whole parent run would stop. Verify navigation
   cancellation, descendant branches, and exact-view consumption too.
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
8. **Prepared validation and host event ownership** — Delegate's
   `prepareArguments` validates before Pi's schema diagnostic can append
   a full received-arguments dump. The one strict schema remains
   `additionalProperties: false`; removed fields reject with teaching, not
   hidden compatibility acceptance. Verify prepare/schema failures emit
   execution start/end even when no tool result is emitted, so sanitized
   misfires remain observable. Preflight metadata must stay owned until
   actual execute entry: a later tool-call handler can still block after
   an earlier approval. Run surface and telemetry contracts with
   private-body sentinels; no error or row may copy those bodies.
9. **Provider-extension loading (`#59`)** — child resource loaders run
   `noExtensions: true` plus `additionalExtensionPaths` for verified
   user-scope roots (`src/host.ts` `createChildResourceLoader` /
   `loadSubagentResources`). Verify on every bump: the option still
   exists and resolves install dirs, `noExtensions` still excludes the
   parent/project inventory while additional paths still load (a
   regression either silently strips provider extensions or — worse —
   leaks the parent inventory into children), `getExtensions()`
   still reports loaded paths and per-extension load errors, and
   `createAgentSession()` still accepts a caller-supplied
   `resourceLoader`. The trust checks lean on
   `DefaultPackageManager.getInstalledPath`/`parseSource`-family
   exports via `src/pi-package-source.ts` — verify those signatures
   too.
10. **`pi.events` bus (`#60`)** — `delegate:usage` emits on the
    extension-shared event bus (`ExtensionAPI.events.emit/on`).
    Verify the channel name is free-form namespaced and `emit`/`on`
    signatures are unchanged; a listener throw must not propagate.

## Soft seams (degrade gracefully)

11. **`runtime-credentials`** — pooled-session reload after residency
    unload re-acquires runtime credentials through the standard
    session-open path; no direct API use, but verify reloads under a
    rotated key behave (reject loudly, never silently no-op).
12. **Tool description channel** — the registered schema descriptions
    are the only channel to trained weights. Verify Pi renders the
    full field descriptions to the model (no truncation on bump).
13. **`pi-ai` faux provider** — `installSubagentModel` test strategy
    assumes delegate resolves and streams subagent models through the
    parent session's model runtime. Verify on bump.
14. **`typebox` pin** — must mirror pi-coding-agent's exact pin
    (schema symbol identity across instances). Re-align every bump.

## Bump procedure

Run `bun install` against the bumped pins, re-apply/verify `patches/`,
then `bun run typecheck && bun test` — then a live `pi -ne -e
<repo>/delegate.ts` dogfood dispatching a real batch with telemetry
enabled (the suite cannot catch host-layer seams; the dogfood can).

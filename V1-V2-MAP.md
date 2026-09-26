# v1 → v2 difference map

Snapshot generated 2026-09-21 by comparing `../pi-delegate` @ `e17a23c`
against this repo @ `d180a89`; updated 2026-09-23 against `3e316ab`
(v1 HEAD `6b194ae`, prose-only). **Not a behavioral
authority** — `SPEC.md`, `INVARIANTS.md`, and `COMPATIBILITY.md` remain
the contracts. This map organizes what differs, what is missing, and what
still needs a decision.

V1 evidence was read at its public boundary (README, config surface, host
hooks, tool behavior). V1 internals are non-binding per `COMPATIBILITY.md`.

---

## At a glance

| | v1 (`e17a23c`) | v2 (`56e6a14`) |
| --- | --- | --- |
| Shape | ~40 modules, grown organically | 1 entry + 23 `src/` modules, spec-first |
| Test suite | 330 KB+ across 20+ files | 177 live tests, 20 files, **0 fail, 0 pending** |
| Behavioral authority | README + code | `SPEC.md` / `INVARIANTS.md` / `COMPATIBILITY.md` |
| Implemented subsystems | all (incl. TUI) | all planned subsystems — named Markdown profiles shipped (#7); visibility layer shipped (#24) 2026-09-22, output bounding shipped (#25) 2026-09-23 |

---

## 1. Deliberate breaking changes — documented in `COMPATIBILITY.md`

These are decided, recorded, and carry migration guidance. No action needed.

| Change | v1 behavior | v2 behavior |
| --- | --- | --- |
| Parent conversation sharing (#14) | `context: "with-parent-transcript"` injected parent history | `context` field rejected entirely; briefs must be self-contained |
| Mixed async batches (#6) | settled as `completed` with per-task statuses | settle as `partial` — headline never lies |
| Unknown singular ticket RPC (#6) | successful "not found" response | tool error naming the missing ticket |
| Task `model` field | any registry-resolvable model the caller typed | rejected; models are user-config only (`delegate.json` `"models"`/`"modelsByParent"`, named agents only) |
| Task `thinking` field | caller-chosen effort level | rejected (#32); effort is user-config only — `:effort` on `models`/`modelsByParent` entries, else parent/model default |
| Unavailable parent tools | silent fallback to writer tools for `default` profile | whole call fails closed before children start, with cause + guidance |
| Telemetry default | **enabled by default** (v1 `DEFAULT_DELEGATE_CONFIG` has `telemetry.enabled: true`) | disabled by default; requires explicit opt-in |

## 2. New in v2 — no v1 counterpart

- **`operationId`** (#16): duplicate-safe dispatch identity, bounded
  retention (1 h / 256 settled records), in-flight reuse, conflict on
  changed request.
- **Batch-level `workspace`**: `delegate({ workspace: "isolated", tasks })`
  defaults every task — the one-field spelling of parallel same-repo edits.
- **Serialization notices**: results name serialized writer groups and
  point at `isolated` as the remedy (sync frames, final result, and ticket
  views).
- **`concurrency.models` / `concurrency.default`**: per-model and
  provider-scoped bounds below the global `maxConcurrent`.
- **Delivery via stock Pi extension API** (#3): no host patch required;
  navigation-epoch tracking, leaf-aware follow-up vs no-turn append,
  delivery-failure handling that keeps tickets pollable.
- **Scratch hardening**: read-only tasks rejected (copy buys nothing);
  linked-worktree/submodule preflight is a cheap stat, not a paid copy;
  symlink escapes preserved instead of rejected; copies live under
  `agentDir`, never beside the source.
- **Quiescence vs settlement split**: caller settlement can be provisional
  while reservations are held until worker quiescence is confirmed — the
  fix for v1's indefinite-settlement defect.

## 3. Missing in v2

### 3a. Promised by contract, not yet implemented

| Feature | Authority | v2 status |
| --- | --- | --- |
| Named Markdown agent profiles | SPEC + COMPATIBILITY preserve lists; issue #7 | **Shipped** — `discoverProfiles()` reads `<project>/.pi/agents` then `<agentDir>/agents`, first definition wins, built-ins win collisions; frontmatter `model`/`thinking`/`tools`/body honored. Narrower than v1: no `.claude/agents`, no `~/.agents`, no built-in override (COMPATIBILITY). |
| `default`-profile sanitized base-prompt mirroring | SPEC (pre-2026-09-26) promised it; code used Pi's stock prompt | **Resolved 2026-09-26, redesigned** (issue #33, user decision): child base prompts are now *composed* — the parent's user-authored prompt inputs (custom base prompt + user-appended text, read from Pi's structured prompt options, never the assembled string) + the built-in role line + a fixed subagent framing with no model identity. Inline tasks and all built-ins compose; authored prompts (task `systemPrompt`, Markdown bodies) stay verbatim; extension-contributed prompt content is never inherited; a force-replaced parent prompt skips inheritance with a logged warning. Contract-tested in `tests/contract/child-prompt.test.ts`. |
| `allowUnsafeSharedWrites` operator bypass | was `INVARIANTS.md` "operator-only unsafe bypass … visible warning" | **Decided out 2026-09-21** (user decision): INVARIANTS now forbids a bypass; COMPATIBILITY records the breaking change. |

This bypass *is* the scoped "camp 4" door (share-the-tree, accept the risk,
gate off): a deliberate, human-only, warn-while-active way to run unguarded —
never model-selectable, never the default. v1 had it; until this decision,
v2's contract kept it — and since nothing implemented it, v2 ran stricter
than its own contract with no legitimate way to lean camp 4 at all.

**Resolution (2026-09-21): kept out.** The camp-4 door stays closed;
unguarded running is reachable only through deliberate workspace choices —
serial shared batches or parallel `isolated` edits.

### 3b. Decided 2026-09-21; visibility cluster shipped 2026-09-22

| v1 feature | Decision | Record |
| --- | --- | --- |
| Live subagent browser | **Shipped** (2026-09-22) — `/subagents`, Ctrl+Shift+B | issue #24; remaining v1 nits: live sync rows, RUNNING/DONE markers |
| Footer status line | **Shipped** (2026-09-22) | issue #24; contract-tested |
| Settle warning | **Shipped** (2026-09-22) | issue #24; contract-tested |
| Switch/fork confirmation guard | **Shipped** (2026-09-22) — consent UX; the safety half (results never wake the wrong leaf) is covered by v2's delivery design | issue #24 |
| Quit trace / reload warning | **Shipped** (2026-09-22) — names tickets, not agent labels (v1 listed agents too) | issue #24 |
| Tree-navigation consent prompt | **Shipped** (2026-09-22) — 2-way cancel/stay, a deliberate divergence (v1's third "hold" option dropped by owner decision); cancel force-cancels live tickets, stay blocks the transition | issue #24 |
| Output spill | **Shipped** (2026-09-23) — settled/sync output over `output.spillThresholdChars` spills to an owner-only temp file with a bounded tail; running-ticket views tail-only, never write; lossless on write failure; full output in `details` | issue #25; `src/spill.ts`, `SPEC.md` "Output bounding" |
| `agentOverrides` / `agentOverridesByParentModel` | **Partially restored** (#32) | model pins → `models`/`modelsByParent` (agent → `provider/model[:effort]`); per-agent tools → task fields today, frontmatter once #7 lands |
| `maxAsyncTickets` cap | **Dropped** | same entry; tickets uncapped, host-lifetime, bounded by `concurrency` on execution only |
| Ticket TTL cleanup | Already deliberate (SPEC: host-lifetime tickets) | no action |
| Retry bound 3 → 2 | Already covered by "retry machinery" in COMPATIBILITY's may-change list | no action |

Note: v2 silently ignores unknown top-level `delegate.json` keys
(`src/config.ts` reads its five known fields and rejects unknowns only
inside `telemetry` and `models`), so stale v1 keys are silent no-ops —
remove them when upgrading.

### 3c. Test-coverage gaps (implementation may exist; tests don't)

`TEST-MIGRATION.md` still lists "Usage properties" as a remaining slice
(sync-result aggregate usage is wired in `details.usage` but untested at
the boundary), plus the per-subsystem **Gap** entries: overlap warnings
on results, per-provider limit variants, abort-of-queued-while-parked,
aborted-worker-completes-ok, delivered-result suppression after waiter
consumption, mid-turn pause semantics, eviction after stalled/deadline
runs, read-only+writer parallelism, nested-repo gitdirs, cancel-before-apply
retention, retry-count visibility, stall structured outcomes,
async-no-usage.

New with the visibility layer: footer lifecycle, pause/resume footer,
multi-ticket merge, and the once-per-activation settle warning are
contract-tested (`tests/contract/visibility.test.ts`); the browser's TUI
surface and the switch/fork guards cannot be driven through the harness —
an accepted gap, recorded in `TEST-MIGRATION.md`.

## 4. Same feature, different behavior

| Feature | v1 | v2 |
| --- | --- | --- |
| Result rendering | full render layer (branches, transcript text, spill) | compact status/integration/notice summaries + spill bounding; expanded views re-render complete outcomes from `details.results` |
| Session store | in-memory pool + custom layout | `<agentDir>/delegate-sessions/` file-backed, insert-on-success |
| Provider extensions | allowlist | children run extension-free; provider registration and auth come from the parent's shared model runtime (verified live 2026-09-26, issue #5) |
| Scratch vs shared writer | (v1 scratch reserved on source) | scratch holds no source reservation — runs beside a shared writer |
| Config surface | `maxConcurrent`, `concurrency{providers}`, `agentOverrides{,ByParentModel}`, `allowUnsafeSharedWrites`, `stallTimeoutMs`, `telemetry{enabled}`, `maxAsyncTickets`, `output.spill{Threshold,Tail}Chars` | `maxConcurrent`, `concurrency{default,providers,models}`, `stallTimeoutMs`, `models`, `modelsByParent`, `telemetry{enabled,dbPath}`, `output.spill{Threshold,Tail}Chars` |
| Stall watchdog | 15 min default | 15 min default (parity) |
| Package | published `@bermudi/pi-delegate` 0.1.21, esbuild bundle step | no bundle, `files: [delegate.ts, README]` |

## 5. Confirmed carried over (spot-checked)

Four modes and help; input recovery repairs; the four built-in agents
(`default`/`scout`/`coder`/`reviewer`) plus user-defined Markdown profiles
and task-over-profile precedence; parent-model
inheritance; extension/MCP/user-global-AGENTS.md isolation (skills ride
the child's own resource loader in both); scratch and isolated workspaces
with baseline preservation, task-order all-or-nothing reconciliation,
`applied_unverified` wording; shared-write admission (fail-closed overlap,
unknown-tool-is-writer, same-call serialization, cross-call reject);
session pooling with frozen config; `resumeFrom`; pause/resume;
poll/wait/cancel; stall watchdog; deadline wall-clock; usage diffing for
pooled sessions; telemetry with v1 database migration; and, since
2026-09-22, the operator-visibility layer — footer status, settle warning,
switch/fork consent guards, quit/reload traces, and the live subagent
browser (#24).

## 6. Decisions (2026-09-21) and what remains

1. **`allowUnsafeSharedWrites`: kept out** (user decision) — INVARIANTS now
   forbids a bypass outright; COMPATIBILITY records the removal with
   migration.
2. **Switch/fork guard: shipped 2026-09-22** (issue #24) — decline blocks
   the replacement; delivery safety already held either way.
3. **`agentOverrides` maps and housekeeping keys: dropped** — recorded as a
   breaking change with migration guidance.
4. **Visibility layer: shipped 2026-09-22 (issue #24); output bounding:
   shipped 2026-09-23 (issue #25).**
5. **Retry bound: no entry needed** — already covered by the may-change
   list.

Still open from 3a: nothing — **named Markdown agent profiles (issue #7)**
shipped, closing the last 3a-style gap.

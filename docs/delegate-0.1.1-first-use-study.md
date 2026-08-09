# Delegate 0.1.1 first-use study

**Status:** historical UX reference, not an API specification or a work plan.\
**Version under study:** package `0.1.1`.\
**Evidence:** seven supplied cold-read-then-use transcripts: Claude Fable, Kimi K3,
Claude Opus, Qwen 3.8 Max, GPT-5.6 Sol, Grok 4.5, and Spark Muse 2.1.

The raw transcripts were deliberately left outside the repository. This document
preserves their common findings, the important dissent, and the follow-up work
that survived comparison with the implementation. The probes used different
models, credentials, project directories, and local delegate configuration, so
wall times, token counts, and configured concurrency are observations rather
than portable product guarantees.

## Method

Each model first received only the registered tool description and JSON schema.
It described its mental model and uncertainties before using `delegate`. It then
ran small probes in an isolated directory covering some combination of sync and
async dispatch, read-only tools, file mutation, sessions, cancellation, retry,
and help mode.

This is intentionally an LLM-usability study. It measures what the model can
reliably infer from the call surface; it does **not** replace unit tests or
end-to-end compatibility verification.

## Pre-study call-log audit

A supplied, earlier 72-hour JSONL analysis complements the cold-model probes.
It found 345 matching records, deduplicated to **329** calls: 134 dispatches
covering 222 task instances, 114 `wait`, 76 `poll`, 4 `cancel`, and 1 session
`list`. Twenty-three dispatches were async. The low cancellation count and high
wait/poll count support the existing guidance to wait rather than cancel slow
work; they do not establish an ideal API ratio because the sample came from one
operator and configuration.

The audit also drove hardening work. Its recommendations were rechecked against
the current source rather than copied forward at their original severity:

| Earlier finding                                                                                   | Current disposition                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project-controlled package settings could execute while building child resources.                 | Addressed: child resource settings use `projectTrusted: false`, with project-package and npm-command boundary tests.                                                                                                                                                        |
| Fresh-session retries could replay a bash side effect.                                            | Addressed: an observed `bash` activity prevents whole-task retry.                                                                                                                                                                                                           |
| Pool close/shutdown could race materialization; failed pooled turns were missing from statistics. | Addressed: pool operations are serialized, shutdown rejects late inserts, and pooled failures call `recordUse`.                                                                                                                                                             |
| Retry fallback, duration, tokens, and live progress could lose prior-attempt evidence.            | Addressed by retry/compaction capture and monotonic-progress tests.                                                                                                                                                                                                         |
| Host compatibility, dependency cache invalidation, and pinned Git validation were too weak.       | Addressed: static factory checks, per-dispatch cache invalidation, and negative origin/ref/parser tests are present.                                                                                                                                                        |
| `pi-codex-compaction` retained stale Pi context across detached asynchronous callbacks.           | **Residual upstream integration risk.** Delegate's quiescence barrier mitigates its disposal race but cannot establish ownership for arbitrary detached extension work. See [`pi-codex-compaction-stale-context-defect.md`](./pi-codex-compaction-stale-context-defect.md). |
| Async follow-ups cannot attach `usage` to the parent tool result.                                 | **Known host-shape limitation.** Sync usage is folded into parent totals; async task usage is displayed but excluded from that total. The generated manual now says so explicitly.                                                                                          |

The earlier audit passed `bun run typecheck` and `bun test` with 465 tests. Its
counts and risk statements are historical evidence; the source/tests above are
the current disposition.

## Executive summary

Every participant understood the central metaphor: `delegate` is fan-out for
independent subagent work, with synchronous join, asynchronous tickets, and
optional persistent workers. Every participant also found the implementation
more capable than the initial schema implied.

The primary 0.1.1 usability defect was therefore **discoverability**, not a
lack of orchestration machinery. In particular, the full manual, result
metadata, limits, retry story, session lifecycle, and cancellation preview were
largely learned only after calling `delegate({ tasks: [] })` or exercising an
error path.

The clearest safe-use doctrine from the study is:

- Delegate independent, fully specified investigation or file-sharded work.
- Use `tools: ["ro"]` for analysis.
- Keep synthesis and sequencing in the parent.
- Do not concurrently mutate shared files.
- Use `agent: "default"` when the task should mirror the parent; omission means
  an ad-hoc agent, whose default tools are mutating `*`.
- Prefer `wait` over polling; a wait timeout returns control but does not stop
  the background ticket.

## What models inferred before use

### The model that landed

Models consistently inferred a fork/join scheduler:

```text
sync dispatch     tasks[] -> per-task results
async dispatch    tasks[] -> ticket -> poll | wait | cancel
pooled worker     sessionId -> later prompt(s) -> close
recovery          session .jsonl path -> resumeFrom
```

They also correctly suspected that conversations are isolated while overlapping
`cwd` values create a shared-side-effect hazard.

### Repeated first-use friction

| Surface         | What was unclear before use                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Help            | `[]=help` was noticed by some models but read as cryptic shorthand rather than an entry point to the full manual.           |
| Result contract | The schema said sync “returns results,” but not their metadata, failure behavior, output bounding, or task correlation.     |
| Handles         | `ticket`, `sessionId`, and `resumeFrom` were understood as distinct but their lifetimes and relationships were unclear.     |
| `action`        | Top-level ticket control and task-level session control share the same field name with disjoint values.                     |
| Tools           | Models wanted confirmation that presets and explicit native names can be used, and that `ro` is a real capability boundary. |
| Agent defaults  | `agent: "default"` versus omission was surprising; the latter being an ad-hoc mutating task was easy to miss.               |
| `force`         | “cancels after preview” did not communicate the two-phase cancellation flow.                                                |
| Context         | `fresh` was understood as a firewall, but models wanted the direct instruction that their prompt must be self-contained.    |

## What use confirmed

The experiments broadly confirmed the intended architecture.

| Behavior             | Observed outcome                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parallel dispatch    | Independent sync tasks overlapped in wall-clock time. Actual concurrency reflected each probe’s configured limits.                                                                                           |
| Context              | `fresh` did not expose the parent conversation; `with-parent-transcript` was substantially more expensive.                                                                                                   |
| Filesystem           | Workers operated on the real task `cwd`; non-overlapping writes worked, while same-file concurrent writes had no conflict protection.                                                                        |
| Read-only capability | `tools: ["ro"]` omitted mutating and shell functions rather than merely asking the model not to use them.                                                                                                    |
| Async control        | Async dispatch returned a batch ticket; poll/wait showed progress; wait timeouts left tickets running; cancellation had a preview then force-confirm flow. Settled results could also arrive as a follow-up. |
| Sessions             | A caller-provided `sessionId` created a live multi-turn worker whose transcript and conversational memory were reused.                                                                                       |
| Recovery             | Results surfaced an absolute session `.jsonl` path and failure output gave actionable `resumeFrom` guidance.                                                                                                 |
| Validation           | Invalid task configuration rejected the batch before healthy siblings were dispatched.                                                                                                                       |
| Observability        | Results and live progress included status, duration, usage/tokens, tool activity, transcript paths, and touched-file evidence.                                                                               |

## Boundaries worth remembering

These are 0.1.1 behavioral boundaries a caller should design around:

- **No filesystem isolation:** tasks with the same `cwd` can observe and
  overwrite each other. File writes are not transactional and cancellation does
  not roll back completed effects.
- **No recursive delegation:** children do not receive the parent `delegate`
  tool.
- **Context is selective by default:** `fresh` excludes the parent transcript;
  use a self-contained prompt or explicitly request transcript copying.
- **Parent extensions are excluded:** children are headless workers. Project
  context is rebuilt for their `cwd`; parent-global `AGENTS.md` is intentionally
  excluded.
- **Runtime metadata lives elsewhere:** session transcripts are not task output
  files and are stored by Pi outside the task `cwd`.
- **Output is bounded in the model-facing result:** long final output spills to
  an owner-only temporary file; the live result retains a bounded suffix and a
  pointer. The full value remains in structured details and the expanded TUI.
- **Configured limits matter:** sync work queues behind the resolved concurrency
  cap; async dispatch has a ticket cap. These are configuration-dependent.
- **Async totals are incomplete:** async follow-ups cannot attach top-level
  `usage`, so their displayed task usage is excluded from the parent session
  total. Sync dispatch does attach aggregate usage.
- **Pool keys are live state, not durable IDs:** a `sessionId` is retained only
  while pooled and is released on close or parent shutdown. `resumeFrom` is the
  durable recovery mechanism.

## Findings that became immediate documentation changes

After this study, the tool description/schema/manual were updated to make the
following facts visible before a first call:

- `tasks: []` returns the full manual and configured-agent list;
- fresh prompts cannot see the parent chat and should be self-contained;
- tasks share the real filesystem and therefore shared-file work must be
  separated;
- tool presets and the mutating ad-hoc default;
- the cancellation preview/confirmation flow;
- the ticket/session/transcript handle model;
- recursion, global-context filtering, transcript location, and pre-dispatch
  batch validation.

These changes improve the 0.1.1 source baseline; they do not change its runtime
semantics.

## Follow-up issues

The study generated five focused follow-ups. They are intentionally narrower
than the full set of suggestions in the raw reviews.

| Issue                                                                                                           | Why it survived triage                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#36 — enforceable per-task execution budgets](https://github.com/bermudi/pi-delegate/issues/36)                | The inactivity watchdog is not a hard limit; parallel work multiplies spend and elapsed-time exposure.                                                             |
| [#34 — stable optional task IDs](https://github.com/bermudi/pi-delegate/issues/34)                              | Truncated prompts and array positions are weak correlation keys for large or similar batches.                                                                      |
| [#32 — remove the overloaded ticket/session action namespace](https://github.com/bermudi/pi-delegate/issues/32) | The same field name for two state machines repeatedly confused fresh models; changing it needs a compatibility plan.                                               |
| [#33 — define and verify touched-file tracking semantics](https://github.com/bermudi/pi-delegate/issues/33)     | Touched files are valuable evidence, but shell attribution and overlap warnings need a tested, honest contract.                                                    |
| [#35 — reproduce restricted-tool system-prompt mismatch](https://github.com/bermudi/pi-delegate/issues/35)      | Some probes reported a read-only function surface paired with prose advertising unavailable mutating tools. This is an investigation, not an asserted current bug. |

## Suggestions deliberately not adopted yet

- **Default ad-hoc tasks to `ro`:** safer in isolation, but a silent default
  change would break the short existing call form. Documentation makes the
  current mutating default explicit instead.
- **Split into multiple registered tools:** it may reduce ambiguity but increases
  permanent provider tool-definition payload and migration surface. Issue #32
  evaluates the trade-off.
- **DAGs, worktrees, typed output schemas, per-task cancellation, and a complete
  permission object:** plausible future product work, but this study does not
  establish a single design or priority sufficient to add them now.
- **Change output spilling from tail to head/tail:** a minority concern. The
  existing tail policy intentionally preserves the usual closing verdict; any
  change needs representative output data, not a one-off review.

## Evaluation protocol for later releases

Repeat this study when the tool schema or orchestration contract changes:

1. Give multiple models only the registered tool definition.
2. Record their first-use mental model and predicted failure modes.
3. Run a controlled probe matrix in an isolated directory using fixed model,
   configuration, and prompts.
4. Compare observations to documented guarantees and existing tests.
5. Classify each discrepancy as a documentation defect, implementation bug,
   configuration effect, or model behavior.
6. Preserve the synthesis and link only actionable, non-duplicate issues.

A release should be judged not only by whether the happy path works, but by
whether a fresh model can select the safe path without discovering its contract
through failed calls.

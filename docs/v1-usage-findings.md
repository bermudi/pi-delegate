# v1 `delegate` usage analysis: which patterns models get wrong

Empirical study of every `delegate` tool call in the v1 era, run to inform v2
design. Evidence, not contract — SPEC/INVARIANTS/COMPATIBILITY remain
authoritative.

## Corpus & method

- Source: `~/.pi/agent/sessions/*/*.jsonl`, 1,841 files scanned (3.1 GB),
  464 files contain delegate calls. **2,128 delegate tool calls**
  (2026-07-22 → 2026-09-25), 2,123 with joined results.
- **Contract eras.** v1 evolved under the models' feet. Calls before
  2026-08-15 (commit `2ce7651`, "Remove legacy action compatibility") ran an
  older contract in which top-level flat task fields, task-level `action`,
  and `action:"wait"` + `timeoutMs` were *legal*. Split: 1,164 old-era /
  964 modern-era. All difficulty findings below are modern-era only.
- **Two rejection channels.** This is the study's biggest methodological
  finding. Failures surface as (a) Pi-thrown schema validation errors with
  `isError=true` — only 19 — and (b) in-tool corrective rejections
  ("Invalid delegate call: …") delivered as *normal results* with
  `isError=false` — 52. Counting only `isError` undercounts failures by 3x.
  Real failure count: **71 calls (3.3% overall; 6.1% of modern-era calls)**.
- **Weighting.** Per bermudi: Tier A (gpt-5.6 family, gpt-6, glm-5.3,
  opus-5, fable-5, grok-4.5, kimi-k3, qwen3.8-max, muse-spark-1.3) ×1.0;
  Tier B ×0.5; Tier C (flash/free variants) ×0.25. Raw counts given
  alongside everywhere; rankings weight Tier A first.
- Classification: field-level extraction with jq/bun scripts (kept
  ephemeral in /tmp; method reproducible from this document), never raw
  transcript dumps. No prompt content is quoted in this report; examples are
  cited by `session-file:line`.
- Amended 2026-09-25 after independent re-verification against the raw
  corpus: the full-schema completion in #1's calls, the absence of
  `pause`/`resume`/`close` from modern-era calls, and glm-5.3's rejection
  date-spread were each re-checked directly; wording corrected where it
  over-attributed intent or causality.

## Model league table (modern era, raw)

| Tier | Model | Calls | Failures | Rate |
|---|---|---:|---:|---:|
| A | gpt-5.6-sol | 468 | 8 | **1.7%** |
| A | glm-5.3 | 155 | 35 | **22.6%** |
| A | gpt-6-astra | 53 | 0 | 0.0% |
| C | glm-5.3-flash | 42 | 4 | 9.5% |
| C | muse-spark-1.2-contributor-free | 42 | 0 | 0.0% |
| C | muse-spark-1.3-contributor-free | 40 | 0 | 0.0% |
| A | meta/muse-spark-1.3-contributor | 34 | 0 | 0.0% |
| A | gpt-5.6-luna | 24 | 2 | 8.3% |
| A | gpt-5.6-terra | 23 | 2 | 8.7% |
| B | muse-spark-1.2-contributor | 22 | 1 | 4.5% |
| C | zai-org/GLM-5.3-Flash | 16 | 0 | 0.0% |
| A | gpt-6-sol | 13 | 0 | 0.0% |
| C | qwen3.8-flash | 11 | 4 | 36.4% |
| C | hy3-free | 8 | 1 | 12.5% |
| B | zai-org/GLM-5.3 | 3 | 2 | 66.7% |

*Table lists models with ≥3 modern calls — 954 of 964; the remaining 10
calls spread across sub-3-call models, none of which failed.*

Headline: **glm-5.3 is the Tier-A outlier** — 13x the failure rate of
gpt-5.6-sol, which carried 49% of all modern traffic across 100+ varied
sessions. Tier-C small models with non-trivial volume are clean
(muse-spark-*-free 0%), so "small model" ≠ "misuses delegate"; shape
confusion is model-specific, not size-specific.

## Failure taxonomy (ranked by weighted impact)

### 1. Ticket/session control glued onto a dispatch ("kitchen-sink") — 25 failures, all GLM-family

`{ticketAction:"wait", sessionId, tasks:[…], sessionAction:"list", timeoutMs,
async…}` in one call. glm-5.3: 22 rejections, glm-5.3-flash 2, qwen3.8-flash 1.
Worst case: one glm-5.3 session (`--home-daniel-build-agent-extensions--/
2026-09-03T03-55-58…jsonl`, lines 12–132) failed **17/17 delegate calls**,
re-issuing the same kitchen-sink combo with minor variations 15 consecutive
times.

Attribution: **shared — and the calls show the mechanism**. The glm-5.3
kitchen-sinks are not a deliberate grab-bag: all 17 pathology-session calls
populate *every* optional field with a typed default — `async:false`,
`ticket:""`, `sessionId:""`, `timeoutMs:0`, per-task `model:""`,
`deadlineMs:0`, `force:false`. That is full-schema completion — emitting
the schema rather than choosing fields — not an intent to "do everything in
one call". #7's `deadlineMs:0` hits carry the same signature, and #8's
`agent:""` is consistent with it (though those come mostly from muse-spark
models: one tendency, not proven one cause). The contract is exclusive-mode
and the error text names the fix ("call it separately"), which every model
except glm-5.3 read and applied; glm-5.3 re-emitted the same shape 15
consecutive times. The tool *description* never says modes are mutually
exclusive — still worth fixing, but with tempered expectations: prose
targets intent, and the demonstrated recovery mechanism in this corpus is
the corrective error text. Normalizing inert typed defaults (empty string,
zero, false) is an untested alternative that would need per-field rules — a
zero timeout is not an omitted timeout.

### 2. `timeoutMs` on a synchronous dispatch — 13 rejections

sol 4x, glm-5.3 6x, glm-5.3-flash 2x, qwen3.8-flash 1x:
"timeoutMs is valid only with ticketAction 'wait'". Another 14 old-era
`action:"wait"` uses were legal then and excluded.

Attribution: **tool-invited**. Dispatch blocks until completion and offers no
way to bound the wait; `timeoutMs` exists in the schema (for ticket `wait`)
so models reach for it where it's most wanted. Highest-value single fix in
v2.

### 3. Invented/unresolvable `model` names in tasks — 6 throws

`'sonnet'`, `'sol'`, `'deepseek-v4-bogus-nonsense'`,
`'nonexistent/fake-model-9000'`, `'modal/zai-org/glm-5.3-flash'` and
`'…:max'`. Committed by opus-5 and gpt-5.6-luna too. Meanwhile v1 *allowed*
task-level `model` (79 modern uses) and it usually resolved fine.

Attribution: **model-caused** (inventing registry names), and direct
empirical support for v2's decision to reject the task `model` field
entirely.

### 4. Task-level control fields — `async`, `timeoutMs`, legacy `action` inside task entries — ~11 modern failures + silent shims

Schema comment folklore confirmed: task-level `async: true` was submitted in
the wild (glm-5.3, stitch session L124–126) believing work was backgrounded
when it ran synchronously. Pre-Aug-15, task-level `action` was legal and
models used it heavily (112 entries, mostly `action:"prompt"`); post-Aug-15
it becomes a rejection. Old habits persist: ~9 task-level `action` entries
appear after the cutoff.

Attribution: **model-caused**, with an era-confusion assist from long-lived
sessions/context.

### 5. Malformed JSON payload — 5 failures, structural

`tasks` as a stringified array (3, incl. one with a leading newline that
defeated the recovery shim), plus one gpt-5.6-sol call emitting corrupted
tokens as field names (`toolsigeria`, `workspace RadiusBEL Relay` —
little-goblin session L378). Even flagship models occasionally mangle
large-JSON emission.

### 6. Output-token truncation of arguments — 2 failures

glm-5.3 hit the assistant-turn output limit mid-`tasks` twice consecutively
(collie session L290, L292). Prompts are long (modern p50 ≈ 583 chars, p90 ≈
2,715, max 9,608); multi-task dispatches with long prompts can exceed the
turn budget. Structural: no error message can fix a truncated call.

### 7. Field mix-ups — rare but vivid

One gpt-5.6-luna call pasted an entire review prompt into the `thinking`
field (caught by enum validation, VitaShell session L35). Bad enum values
for `workspace`/`thinking` total 3. `deadlineMs <= 0`: 16 silent-shape hits,
mostly old-era glm-5.3 — the same typed-default completion as #1, not a
field mix-up.

### 8. Benign habits the shims absorb — no errors

`agent:""` (15 modern, 14 from muse-spark-1.2-contributor-free), `tools` as
string (21, mostly old-era glm-5.3), flat task fields with no `tasks` array
(5 modern — zai-org/GLM-5.3 3x), `tasks: []` help probes (10, mostly
first-contact test sessions). The shims silently recovered all of these with
no downstream failures — a design that worked. `agent:""` is the benign end
of #1's schema completion (a default-filled field); the format habits
(`tools` as string, flat fields) are separate shape errors, not confusion
about semantics.

## Behavioral findings

- **Models don't poll tickets.** 143 modern async dispatches; 97 were
  ever followed by a `ticketAction`, 46 never were. Of the 46 never managed,
  78% were *not* session-end fire-and-forget — the model moved on. v1's
  auto-delivery carried the load; v2 must not depend on models polling.
- Control usage (modern): `wait` 63 > `poll` 29 > `cancel` 2 >
  `sessionAction:list` 19. **`pause`, `resume`, `sessionAction:close`: zero
  uses in two months.** Dead surface that costs description tokens — and no
  more: no modern-era call contains them (the only corpus occurrences are 19
  legacy `action:"close"` calls, all pre-cutoff), so no observed kitchen-sink
  was built on them.
- `context: "with-parent-transcript"`: 2 of 694. Models respect the
  fresh-context default; the expensive option is avoided without coercion.
- `thinking: "high"` dominates (728/836 task-level uses); xhigh 38, max 11.
- Multi-task dispatch is used heavily: 1 task 43%, 2 tasks 11%, 3+ tasks
  14% of modern calls (rest: control calls). Task options are used
  heavily too: agent 1,295, id 1,222, cwd 985, workspace 895, deadlineMs
  377, resumeFrom 44.
- **Recovery is strong.** Of 71 failures: 57 corrected within the next two
  delegate calls (often a "staircase" — fix one field per attempt, e.g.
  stitch L122→124→126→128 ends in success), 9 identical retries (all in the
  glm-5.3 pathology session), 5 gave up. v1's corrective error messages
  demonstrably work; the two-channel rejection design did not impair model
  recovery.

## What v1 already got right (keep in v2)

1. Errors as corrective text results, naming the field and the fix.
2. Silent lossless recovery shims (stringified `tasks`, `tools` as string,
   `agent: ""`, flat-field wrapping) — zero downstream errors observed.
3. Auto-delivery of async results — models will not poll reliably.
4. Loud rejection of unknown task fields (the `async`-in-task trap).
5. `context: fresh` default — adopted universally without prompting.

## v2 recommendations (ranked)

1. **Give dispatch a way to bound its wait** — accept `timeoutMs` on
   dispatch (snapshot on timeout) or state "dispatch cannot be interrupted;
   use async + wait" in the description. Kills failure family #2 outright.
2. **State mode exclusivity in the tool description**, not only in errors:
   "one operation per call — dispatch tasks OR ticket control OR session
   control." Cheap and correct — but tempered by #1's mechanism: if
   kitchen-sinking is schema completion rather than intent, prose may not
   prevent it (glm-5.3 ignored 15 corrective errors naming the exact fix).
   Do it anyway; every other model recovered via error text, and clearer
   description can only help the intent-driven cases.
3. **Reject the task `model` field** (already spec'd) — validated by data:
   every model-name failure was an invented or mis-scoped name.
4. **Cut or hide `pause`/`resume`/`sessionAction:close`** — zero uses in two
   months. The case is token cost and surface area alone: no observed
   kitchen-sink used them, so the original "contributes to kitchen-sink
   confusion" claim was unsupported. One complication: `close` had 19 legacy
   flat-`action` uses before the Aug-15 cutoff — demand existed under the
   old shape, so its modern absence may be the rename, not vanished need.
5. **Add a payload-size hint to the manual** ("split large multi-task
   dispatches across calls; keep arguments well under the output-token
   budget") — truncation is unrecoverable by error messages.
6. Keep everything in "What v1 got right" exactly as is.

## Caveats

- Single-user corpus (the extension's target user — findings describe the
  real deployment distribution, not the model population at large).
- Runtime build drift within the modern era is not controlled per-session;
  a few "failures" in August sessions hit pre-hardening builds, and some
  old-era habits were counted only when re-emitted post-cutoff.
- gpt-5.6-sol's 468-call sample spans 100+ projects; glm-5.3's 155 calls are
  concentrated in fewer sessions — its 22.6% rate is robust (failures in 10
  distinct sessions; rejections on 11 distinct session-days spanning
  2026-08-17 → 2026-09-25, so not an artifact of one build) but per-session
  variance is high.
- Classification is prefix/heuristic-based on extracted fields; the raw
  extracted dataset was ephemeral (/tmp), this document is the record.

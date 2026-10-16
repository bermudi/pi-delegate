# ADR 0003: Verbatim result delivery with a durable emergency valve

- **Status:** Accepted (owner ruling on #145)
- **Date:** 2026-10-16
- **Authority:** bermudi — "successful runs do not get any truncation at
  all, final message is delivered verbatim like in claude code", plus the
  valve figure (~25k tokens) and the error-payload cap ("copy codex
  payload cap at ~900 tokens"); the framing gap ruling ("inject it") and
  the ok-outcome session pointer ("it should contain a link to the jsonl
  file with full trajectory") from the same session.
- **Revisit trigger:** a parent turn demonstrably flooded by valve-sized
  or many-verbatim finals on the production install (the Claude Code
  failure class, community issue anthropics/claude-code#23463) — the
  response would be lowering the valve, not restoring pre-#145 trimming
  of ordinary results.

## Context

#145 (live evidence, 2026-10-15): two of three ticket outputs exceeded
the 8,000-char `spillThresholdChars` and spilled; the LLM-facing pointer
named only the `/tmp/delegate-output-*.md` copy, "retention follows OS
temp policy". The parent treated that as the only evidence pointer and
spent a turn on scratch-dir archaeology to preserve files that systemd
would eventually sweep — while durable copies (ticket record
`outcome.output`, worker session `.jsonl`) existed the whole time and
were named nowhere. Pointers in transcripts outlived their target.

The v2 design (SPEC-V2 spill section) bounded every over-8k result to a
2k tail + /tmp pointer. A 2026-10-16 survey of the incumbent harnesses
(sources in the #145 orientation) found: most deliver subagent finals
uncapped (Claude Code, Codex, Cursor, Amp); those that cap land at 30k
chars–50KiB (Letta cites "Claude Code's proven production values",
opencode 50KiB, Gemini distills at 15k tokens); and wherever a harness
hands the model a file pointer, the file lives in a retained,
harness-owned directory with an explicit sweep (30d/7d/24h) — never raw
/tmp under OS policy. The 8k threshold taxed ordinary results; the /tmp
pointer was the field's outlier.

## Decision

1. **Successful finals deliver verbatim** up to a high emergency valve —
   `output.spillThresholdChars`, default 100,000 chars (≈25k tokens at
   the 4 chars/token heuristic, the field's ceiling).
2. **Spills are durable**: content-addressed files
   (`delegate-output-<agent>-<hash>.md`, 0600 in a 0700 dir) under
   `<agentDir>/delegate-spills/`, swept once per extension lifetime at
   the first dispatch past 30 days. The content-addressed name makes the
   pointer stable across processes without mutating settled records.
3. **Failed partials cap hard**: `output.errorTailChars`, default 3,600
   chars (≈900 tokens — Codex error-payload parity), tail plus one line
   naming the durable copies; no spill file on the failure path.
4. **Every successful outcome names its session transcript** — a plain
   `session: <path>` line (no resume hint; that stays failure-recovery
   teaching).
5. **The fixed subagent framing reaches authored Markdown profile
   bodies** (previously verbatim, no framing): the final-message contract
   is operational teaching every child needs; the operator's voice
   otherwise stays untouched.
6. **The prerequisite handoff tail is decoupled** from the valve: a fixed
   8,000-char tail, because a dependent worker's prompt budget is not the
   parent's result budget.

Lossless degrade is unchanged: a failed spill write returns the complete
output in-context, never a hard truncation.

## Consequences

- The #145 incident class (perishable-only pointers) is gone: realistic
  results (KB-scale) render whole; valve-busting ones point at a file
  that lives as long as the transcripts naming it, within the 30-day
  window, with the record retaining everything forever.
- Old records render under their snapshotted bounds; recovery fills
  `errorTailChars` from the shipped default when absent.
- The incumbent-trained reflex (a final report arrives whole; oversized
  artifacts sit at a named durable path) now matches the surface.
- Accepted risk: one pathological final (or a wide batch of large ones)
  lands whole in the parent context up to the valve — bounded by
  admission's fan-out limits and the profile teaching ("complete the task
  in your brief, then stop"), and revisit-triggered above.

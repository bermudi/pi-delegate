# #61 live verification

Verified 2026-09-30 UTC against source commit `7891866`.

- Stock installed CLI: Pi **0.99.1**; repository SDK pin remains **0.87.0**.
- Parent model explicitly approved by bermudi: **zai/glm-5.3-flash**.
- Two fresh CLI sessions loaded this tree with `pi -ne -e <repo>/delegate.ts`.
- `DELEGATE_AGENT_DIR` scoped each run to owner-only test directories.
  Native credential machinery remained in place; no auth files were copied
  or printed, no global configuration changed, and nothing was published.
- Raw events, worker transcripts, SQLite stores, and a checked summary remain
  locally under `/home/daniel/.cache/pi-delegate-61-live.ceqxoU/`.
  Those private artifacts are not checked in.

## Observed results

### Compact

- Omitted `async` returned tickets for one-task and multi-task dispatches.
  The model combined the requested multi-task step into a three-task batch,
  and also launched a separate single-task call. Actual cardinalities were
  **3 and 1**, not a claimed two-task run.
- Explicit waits retrieved successful results with all requested markers.
- Two actual `delegate-result` messages also delivered the async outcomes.
- `async:false` returned an inline successful result with no ticket.
- Removed `agent_type`, hidden compact task `id`, and unknown agent `scout`
  each rejected; SQLite contained exactly **three validation misfires**.
- Five workers completed successfully.

### Full

- An authored global profile named `general` supplied its read-only tool
  default and instruction prefix, proving exact authored-name resolution.
- Its actual worker transcript records one `read` of the test `proof.txt`
  and a tool result containing the file's marker. This is not inferred from
  an assistant's assertion that it read the file.
- A two-task inline batch completed with canonical IDs, a shared brief,
  explicit deadlines, and a predecessor dependency.
- Explicit task tools/base-instruction overrides remained accepted; the
  override response contained its marker without the profile prefix.
- Three workers completed successfully; no misfires.

## Evidence boundaries

Assertions use actual tool arguments/results, completion messages, worker
transcripts, and telemetry—not the parent's final success summary. Every
parent assistant event and all **eight** worker model rows match
`zai/glm-5.3-flash`.

Legacy `calls.parent_model`, `tasks.tool_uses`, and `tasks.session_file`
columns are currently hardcoded NULL. Parent selection was checked from
assistant events and tool usage from the public result `sessionFile`
transcript, rather than guessing what those legacy columns contain.

The prior **521-test** provider-free suite, strict typecheck, and independent
review remain the broader safety/feature checks. This live run does not
claim exhaustive verification of every advanced control or delivery timing.

**Result: the #61 live gate passed. The installed extension is unchanged.**

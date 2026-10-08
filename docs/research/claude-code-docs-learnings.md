# What pi-delegate can learn from Claude Code's parallel-work docs

Date: 2026-10-14. Provenance: the six pages below fetched as markdown via
content negotiation (`curl -H "Accept: text/markdown"`), analyzed by six
read-only explore agents grounded in SPEC.md/INVARIANTS.md/COMPATIBILITY.md,
load-bearing claims spot-checked against the raw text (line numbers cited
from the fetched copies; pages are re-fetchable the same way).

- https://code.claude.com/docs/en/worktrees
- https://code.claude.com/docs/en/workflows
- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/agent-view
- https://code.claude.com/docs/en/sub-agents

Why this matters: the 17-repo comparison (`~/build/testing/subagents`)
never included Claude Code — closed source, docs only. These pages are the
public spec of the incumbent whose surfaces the weights were RL-trained
on ("the weights are the platform"). Three of the six (teams,
cross-session messaging, agent view) document machinery that postdates or
directly parallels our sequencing decisions.

## 1. Validations — our decisions that CC's docs confirm

**Async-by-default.** CC runs subagents in the background by default in
every session type; foreground only when the result is needed before
continuing (sub-agents L896–901; fork mode — the interactive default —
forces background always). #61's "omitted `async` backgrounds nonempty
work" is now the incumbent default, not a divergence. Expect callers to
assume backgrounding more, not less.

**Turn-boundary message delivery.** Cross-session messaging L59–62: "The
receiving Claude reads the message between tool calls during an active
turn, so a running tool is never interrupted. When the receiving session
is idle, Claude Code starts a new turn with the message." This is
byte-for-byte the Pi steer semantics we verified 2026-10-02 and adopted
(`deliverAs: "steer"`). Two platforms independently landed on the same
drain discipline — treat it as settled physics.

**In-process children die with the parent.** Teams L483: "a teammate's
background work can't outlive the lead's process" — CC hard-errors
`background: true` from teammates. No `/resume` of in-process teammates
(L478). Workflows: exiting stops the run; only saved results replay.
ADR 0001's physics is CC's documented physics for the subagent layer.
The surviving layer — agent view's detached sessions under an OS
supervisor process, crash → restart-resume (agent-view L158–162) — is a
*host-level* full-session product, not subagents. CC draws exactly our
line: in-process children die; detached sessions are someone else's
machinery.

**No nested orchestration.** Teams: "No nested teams" (L482); at
subagent depth 3 the `Agent` tool is withheld (or errors in forks)
(sub-agents L1016). We are stricter (#45: dispatch tools silently
stripped from every child, depth 1), and CC's own degrade-at-limit is
the same reflex.

**Operator-only model pinning.** Precedence is invocation > frontmatter >
`CLAUDE_CODE_SUBAGENT_MODEL` > parent (sub-agents L390–396), and
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides everything (L401–417) — the
incumbent precedent for our `models`/`modelsByParent` pins plus #32/#44
rejection of caller-picked models.

**Enumerate-or-inherit.** Zero-tools launch errors *name the unresolved
entries* (L468); the concurrency-cap error tells the model not to retry
(L1047). Same remedy shapes as ours.

**Reversibility encoding.** Dispatched agent-view sessions in their own
worktree "commit without asking, and push the branch when the repository
has a remote" — but never push to main/master, never force-push, never
merge (L569–572), and user git instructions take precedence. That is our
red line (branch pushes proceed; protected/irreversible stops) encoded
as product rules.

**Exact names.** `--agent '<name>' not found` fails the launch. Note the
counter-pattern: the Task→Agent rename (v2.1.63) kept `Task(...)` working
as an alias (L486) — CC pays a permanent alias tax where #61 chose one
canonical spelling. Conscious trade on both sides; ours is right for a
small surface, but remember the incumbent absorbs churn via aliases.

## 2. Trained-reflex gaps — what the weights will try at our walls

1. **Call shape.** `Agent(subagent_type: ..., run_in_background: ...,
   model: ...)` with capitalized built-ins (`Explore`,
   `general-purpose`). All rejected by us with teaching errors (#32,
   #61) — handled, but nobody measures the collision rate (see §4.7).
2. **Per-agent structured output.** Workflows' `agent(prompt, {schema})`
   validates the schema for provable contradictions *before* the
   subagent starts and retries validation 5× (workflows L319–321). A
   trained field across two CC surfaces with no analog on ours.
3. **Peer messaging.** One `SendMessage` serves peers, subagents, and
   teammates; messages carry sender + reply address; messaging a
   completed subagent *revives it with full history* (sub-agents
   L1093–1115). Our grammar is closed and parent-owned (results,
   questions, steer). This is the largest semantic gap — and exactly the
   parked "later steering/team messages" phase. These docs are the spec
   of what the weights will expect when that phase opens: mailboxes, a
   Delivered/Held/Refused inbound triad, `notify_when_idle`
   subscriptions (no tokens in the watched session), per-sender rate
   limits, identical-repeat drops, queue caps.
4. **Orchestration scripts.** Models are trained to write a JS workflow
   file and expect a runtime to execute it detached (workflows:
   `agent()`/`pipeline()`/`parallel()`, `ultracode`, `/deep-research`).
   We have no Workflow tool; our idiom is batch + `dependsOn` + wait +
   parent-loop re-dispatch. Nothing at our boundary translates the ask.
5. **Worktree-by-default for writers.** Agent-view sessions move into a
   worktree *before editing* (L537ff); subagents get it via frontmatter
   `isolation: worktree` (worktrees L103–119). Our default is shared +
   admission serialization — stronger on the tree, absent from the
   vocabulary. An operator's trained phrase "use worktrees for your
   agents" has no listener on our surface.
6. **Resume-on-message.** CC revives completed subagents on SendMessage;
   we settle `interrupted` and teach `resumeFrom`. Boundary teaching
   must stay loud (ADR 0001).

## 3. Findings on our side (verified in-tree)

**Profile frontmatter silently drops unknown keys.** `src/profiles.ts`
consumes `name`, `description`, `tools`, `thinking`, `model`
(`frontmatterToData` coerces and the loader reads only those five) —
everything else is a silent no-op. A CC-trained author (or model) adding
`isolation: worktree` to `refactorer.md` gets silent shared execution.
CC ignores unknown keys too (`color`, `experimental` — sub-agents L230)
but *implements* `isolation:`; we ignore it and don't implement it,
which turns a trained reflex into silent misbehavior rather than a
misfire error.

## 4. Issue-sized ideas (ranked)

1. **Profile frontmatter `workspace:` key** (`shared|scratch|isolated`)
   — closes the `isolation: worktree` silent no-op; dispatch-level
   `workspace` remains the override. Recommend also warning on unknown
   frontmatter keys, naming the known set (enumerate-or-inherit applied
   to authored profiles).
2. **Orchestration-guide paragraph in the `delegate` description** — map
   workflow-shaped asks (audit-N-files fans, keep-going-until-green
   loops) onto batch + `dependsOn` + `wait` + parent-loop re-dispatch.
   Pure boundary teaching, no behavior change.
3. **`waitingFor`-style enum on blocked tickets** (question |
   admission-parked | steering-queued) and render the *exact question
   text* on question-blocked rows — mirrors agent-view's enumerated
   `waitingFor` and peek panel.
4. **Per-task output `schema` (full mode)** with pre-start validation —
   the strongest trained field we lack; genuinely useful for fan-outs.
5. **Steer hardening** from their anti-loop section: content-based
   dedupe (retried steers never dedupe today — ids are per-call-unique)
   and a per-task undelivered-steer burst cap with a "batch into one
   steer" teaching error.
6. **Admission-rejection wording**: adopt CC's explicit "do not retry"
   instruction style (L1047).
7. **Misfire telemetry tags** for capitalized built-in names,
   `subagent_type`/`run_in_background`/`schema`-bearing calls — measures
   the collision rate as these docs diffuse into training data; informs
   whether case-folding or alias acceptance ever pays.
8. **Injection-provenance marker on worker reports** (their
   no-authority header analog, sub-agents L945–960) — lower priority.

Not recommended: exit-2 quality-gate hooks (SPEC bars
verdict-as-admission, #49); auto-merge-back for `isolated` (CC leaves
merging to the human; our reconcile-on-merge-in-order is already more
automated than theirs); copying their hold/refuse inbound triad before
the team-messages phase actually opens.

## 5. Strategic read

CC's parallel-work surface is fragmenting — subagents, teams, agent
view, workflows, Projects, channels, scheduled tasks — enough that the
docs ship a dedicated comparison page ("Run agents in parallel"). That
is the opposite of our one-canonical-surface bet (#61). Two
implications: trained reflexes will be heterogeneous (favor teaching at
the boundary over chasing each mechanism), and it is worth watching
*which* mechanism dominates future training data (the misfire telemetry
above is the instrument). The Task→Agent rename shows CC will churn
names and eat the alias tax; our exact-name surface should keep
measuring what that costs us as the `Agent(...)` spelling diffuses.

Nothing in these pages argues against INVARIANTS or ADR 0001 — every
verifiable parallel confirms them.

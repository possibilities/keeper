## Description

**Size:** M
**Files:** src/await-conditions.ts, cli/await.ts, cli/descriptor.ts, test/await-conditions.test.ts, test/await.test.ts, plugins/keeper/skills/watch/SKILL.md

### Approach

Give `drained` a three-value scope axis and make plan scope the default
(ADR 0032). The scope semantics live as pure predicate logic in
src/await-conditions.ts: plan scope counts only keeper-dispatched work
(positive dispatch provenance covering autopilot AND escalation
sessions — verify the exact jobs-projection field; the plan_verb
whitelist alone is WRONG, it misses resolver/deconflict/repair), always
excludes the caller's own session (mirror the agents-idle self-exclusion
mechanism), and still holds on open plan rows and pending dispatches;
inflight scope waits only for in-flight dispatched work (running
dispatched jobs + pending dispatches) to reach zero, ignoring
ready-but-undispatched rows; board scope is the prior strict gate,
byte-identical. The `--fail-on-stuck` jam check applies to all scopes
unchanged — an external session must never mask a real jam. The CLI
assembles scoped inputs where it currently computes the bare running
count; `--scope <plan|inflight|board>` is declared centrally with the
other await flags. The watch skill's wedge alarm call site moves to
`--scope board` in this same change so the strict consumer is never
semantically broken. Enrich the predicate inputs from a bare count to a
holder list (names of the jobs/rows holding the condition) — tasks 2
and 3 consume it; keep the list shape one decision made here.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at
authoring time, but the repo moves.*

**Required** (read before coding):
- src/await-conditions.ts:1263-1340 — DrainedInputs + drainedState +
  the strict-contract docstring (:1283) that board scope keeps
- cli/await.ts:1825-1843 — the bare running-count loop the scoped
  assembly replaces
- src/types.ts:350-363 — Job.plan_verb whitelist (NULL for
  resolver/deconflict/repair/adopted) — why provenance, not verb, is
  the discriminator; find the dispatch-provenance field the autoclose
  worker keys on (src/autoclose-worker.ts ownership doc)
- src/await-conditions.ts:1083-1128 — agentsIdleState self-exclusion
  pattern (caller session id threading)
- cli/descriptor.ts:725-765 — await flag table
- plugins/keeper/skills/watch/SKILL.md:164 — the wedge-alarm call site

**Optional** (reference as needed):
- test/await.test.ts:43,51 — HELP/AGENT_HELP consistency assertions to
  extend for the new flag

### Risks

- The provenance discriminator must cover escalation sessions
  (resolve/deconflict/repair) or plan scope reports drained mid-merge-
  resolution; pin this with an explicit fixture
- Flipping a shipped default: the descriptor summary, HELP, and
  AGENT_HELP must all state the new default and name `--scope board`
  as the strict form

### Test notes

Pure fast-tier. Reproduce the incident as the anchor fixture: board
empty, two external sessions state=working — plan scope met, board
scope waiting. Cover: escalation session holds plan scope; caller's own
session excluded; inflight ignores ready rows but holds on pending
dispatches; jam check fires under all scopes; board scope byte-identical
to the prior predicate over the existing fixture corpus.

## Acceptance

- [ ] Bare `drained` reaches met on a board with no open plan work
  while external sessions are live; the same inputs under
  `--scope board` stay waiting
- [ ] A live escalation session (resolver/deconflict/repair provenance)
  holds plan scope; the caller's own session never does
- [ ] `--scope inflight` fires when in-flight dispatched work and
  pending dispatches reach zero regardless of ready rows
- [ ] The watch skill wedge alarm invokes the strict scope explicitly
- [ ] HELP and agent-help document the axis and new default; the fast
  suite is green

## Done summary
drained gains a plan/inflight/board scope axis with plan as the new default: plan/inflight count only keeper-dispatched work (autopilot+escalation provenance) and self-exclude the caller, board keeps the strict byte-identical gate; the predicate now emits a structured holder list and the watch wedge alarm moves to --scope board.
## Evidence

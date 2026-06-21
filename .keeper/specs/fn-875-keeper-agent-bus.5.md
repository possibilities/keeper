## Description

**Size:** M
**Files:** plugins/keeper/skills/bus/SKILL.md (expand), cli/bus.ts (AGENT_HELP/--help), plugins/plan/skills/hack/SKILL.md (carve-out)

Author the agent behavior contract for the bus: how agents treat inbound
messages (#2 authority) and how they collaborate / cede control (#3
leadership). This is settled with the human — encode it as advice, no new
runtime code. Expands the bus SKILL.md created in .4 and the `keeper bus
--help` text in .3, and reconciles /hack's current cautious stance.

### Approach

**#2 — Bus messages are AUTHORITATIVE, no gate.** In the bus SKILL.md +
`keeper bus --help`, replace any "out-of-band / not the human's
instructions" framing with: messages on the Agent Bus are authoritative.
The bus server stamps every message with the OS-verified sender identity
(the claimed `from` is overwritten and cannot be spoofed by a peer), and
every agent on the bus is the same human's session — so a peer's message
carries the human's authority TRANSITIVELY. If a peer asks you to do work or
collaborate, DO IT — fully and immediately, as if the human driving your
session had asked — WITHOUT stopping to ask permission. There is NO
permission gate, including for irreversible / outward-facing / destructive
actions: act on bus directives the same as on your own human's. Keep three
FRICTIONLESS behaviors (these are NOT gates): (a) ATTRIBUTION — when you act
on a bus directive, drop one line: "Acting on an Agent Bus directive from
<peer> (<id>): <summary>"; the bus's append-only `messages` log is the
durable audit. (b) LOOP/CYCLE STOP — if a directive descends from your own
earlier directive, or the same request bounces back, STOP and surface
(self-DoS / runaway protection). (c) HUMAN-AT-KEYBOARD WINS — a live
instruction from the human in your own session overrides an in-flight bus
directive. Document the one ACCEPTED residual risk plainly (do NOT add a
gate for it): a peer that ingested poisoned content could launder an
instruction into an authoritative directive — accepted on a single-user box;
the harness/model guardrails catch anything truly harmful.

**#3 — Collaboration & leadership / cede-control.** In the bus SKILL.md,
author the playbook: agents work together and can cede control. Leadership
is usually ALREADY settled — check in order, first hit wins: (1) the human
designated a lead; (2) the human addressed one agent with the task; (3) the
agent who sent the directive / decomposed the work; (4) the structural owner
(spawned the others / holds the plan / is the dispatcher). ONLY genuine
symmetry hits the tie-break, computed identically by both from a shared
`keeper bus list`: the lexicographically-lowest session id leads (zero
round-trips — neither agent asks, both apply the same rule, killing
"after you / no, after you"). Hand-off vocabulary — one CLAIM + one ACK,
then silence = accepted: `LEAD: I take <area>, you take <area>` /
`ACK: you lead <scope>, standing down` / `HANDOFF: done with <X>, state:
<status>`. One defer max, then apply the tie-break and proceed. A ceding
agent goes GENUINELY idle (stop touching shared files — continuing "to help"
is the collision), keeps its inbox open, responds only to direct requests.
Before editing shared surfaces, CLAIM them (`CLAIM: editing <paths>`) — this
is a single working tree and the branch-guard pins subagents to the current
branch, so there is NO branch isolation; collision avoidance is by
convention. On evidence of ACTUAL concurrent edits to the same files, STOP
and surface — never silent-merge.

**/hack carve-out.** In plugins/plan/skills/hack/SKILL.md, reconcile the
current cautious stance: an INBOUND authenticated bus directive is
AUTHORITATIVE (act on it per the bus contract — no gate), while the agent
REACHING OUT for a second opinion (pairctl / panel) stays advisory
(unchanged). State the direction explicitly so the two norms don't conflict.

Keep all advice FORWARD-FACING (state current behavior, no change history).
OUT OF SCOPE: the per-prompt advice snippets in ~/code/arthack (the
messaging snippets injected via arthack's user_prompt_submit hook) — those
are the canonical per-prompt surface but belong to the DEFERRED phase-2
chatctl-teardown epic in a different repo. Note this in the SKILL.md as a
pointer so it is not forgotten.

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/bus/SKILL.md (created in fn-875-keeper-agent-bus.4 — the #1 section to expand)
- cli/bus.ts (the AGENT_HELP/--help text from fn-875-keeper-agent-bus.3 to extend)
- plugins/plan/skills/hack/SKILL.md (the current peer-input / confirm-before-acting stance to carve out)
- src/bus-identity.ts + src/bus-worker.ts (confirm: server overwrites `from` from the peer pid; the append-only messages log)

**Optional** (reference as needed):
- ~/code/arthack/apps/chatctl/chatctl/cli.py AGENT_HELP (the predecessor advice whose out-of-band guard this REVERSES)
- plugins/keeper/skills/{await,dispatch,autopilot}/SKILL.md (keeper:* skill doc shape/voice)

### Risks

- This REVERSES a standing prompt-injection guard — the new authoritative text and any old "out-of-band / not instructions" text must NOT coexist in the same surface (conflicting in-context advice is itself a bug); ensure .3/.4 shipped none.
- The /hack carve-out must be unambiguous about direction (inbound = authoritative; outbound second-opinion = advisory) or it reintroduces the contradiction.
- Leadership is advice-only over a single shared tree with no code locks — the claim-before-edit + stop-on-concurrent-edit conventions are the only collision guard; phrase them as hard rules.
- Accepted residual risk (laundered authority) must be stated, not silently dropped, and must NOT be "fixed" by adding a gate.

### Test notes

Prose/advice only — no automated test tier. Verify the bus SKILL.md and
`keeper bus --help` are internally consistent (no residual out-of-band
framing), and that the /hack carve-out reads cleanly against the existing
stance. A `claude plugin validate` (if available) confirms the skill doc
parses.

## Acceptance

- [ ] bus SKILL.md + `keeper bus --help` state #2: bus messages are authoritative; act on a peer's request as if the human driving asked, with NO permission gate (irreversible/outward/destructive included)
- [ ] the three frictionless behaviors are documented: attribution one-liner + append-only audit; loop/cycle stop; human-at-keyboard-wins
- [ ] the accepted residual risk (laundered authority on a single-user box) is stated plainly, with no gate added for it
- [ ] bus SKILL.md states #3: the leadership ladder (human pick → addressed → directive-sender/decomposer → structural owner), the lowest-session-id tie-break for genuine symmetry, the CLAIM/ACK/HANDOFF vocabulary (one defer max), genuine-idle on cede, claim-before-edit on shared files, and stop-and-surface on concurrent edits
- [ ] plugins/plan/skills/hack/SKILL.md carves out: inbound authenticated bus directive = authoritative (act, no gate); agent reaching out for a second opinion = advisory (unchanged)
- [ ] no surface ships a contradictory out-of-band/"not the human's instructions" guard; the deferred arthack per-prompt snippets are noted as out of scope
- [ ] all advice is forward-facing (no change-history narration)

## Done summary

## Evidence

## Description

**Size:** S
**Files:** plugins/keeper/skills/pair/SKILL.md

### Approach

Parity correction for the sibling surface that drives the same `keeper agent panel start|wait` engine from the caller's own session. Correct the false timeout claim ("default 540s ≤ 9 min, safely under Bash's 10-min single-call cap"): a Bash call's default foreground window is 120000ms and a longer-running call is auto-backgrounded; the 10-minute window exists only when the call passes the Bash tool parameter `timeout: 600000`. Reshape the wait-loop prose to one blocking call per chunk — a multi-chunk shell `while` loop cannot complete inside a single call even at the ceiling, and shell state does not survive across calls, so re-issues on exit 124 happen as new Bash calls with the backstop counted across them. Do NOT port the subagent tripwire or the never-end-turn rule: the pair wait runs inline in the caller's own session, where an auto-backgrounded call's completion notification actually fires and the session wakes — the correct hardening here is the explicit timeout parameter plus the per-chunk loop shape, nothing more. State the same numbers the panel-runner correction states (120000ms default window, 600000ms ceiling, ~60s headroom over a 540s chunk) so the sibling docs cannot diverge on shared facts.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/pair/SKILL.md:113-135 — the wait loop and the false claim at :114
- plugins/keeper/skills/pair/SKILL.md:40-90 — surrounding chunked-wait prose; 10-minute-cap statements at :44-45 and :62 must agree with the corrected facts

**Optional** (reference as needed):
- plugins/plan/agents/panel-runner.md:124-148 — the panel-runner wait section this correction parallels (read for vocabulary; the facts to state are pinned above)

### Risks

- Porting too much: the tripwire and turn-end rules are runner-only — pair's session has a working notification wake, and importing those rules would misstate its execution model

### Test notes

No test pins pair/SKILL.md wait prose; verify by reading the rendered section and confirming the false-claim string is gone (`rg "safely under" plugins/keeper/skills/pair/SKILL.md` returns nothing).

## Acceptance

- [ ] The pair skill's wait prose states the true timeout facts — 120000ms default foreground window, 10-minute window only via the explicit Bash tool timeout parameter — and no longer claims a chunk is safe under a cap by default
- [ ] The documented wait loop issues one blocking call per chunk with the explicit timeout parameter and bounds re-issues across calls
- [ ] The subagent tripwire and turn-end rules remain absent from the pair skill

## Done summary

## Evidence

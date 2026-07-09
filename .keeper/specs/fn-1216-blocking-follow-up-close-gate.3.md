## Description

**Size:** M
**Files:** plugins/plan/agents/close-planner.md, plugins/plan/skills/close/SKILL.md, plugins/plan/plugin/hooks/stop-guard.ts, plugins/plan/test/stop-guard.test.ts, plugins/plan/test/consistency-skills.test.ts, plugins/plan/README.md, plugins/plan/CLAUDE.md

### Approach

Activate the gate: teach the planner to emit the decision and the closer skill to drive the new branch — until this lands, the saga task's machinery is dormant. close-planner gains a block-decision step after clustering survivors, only when survivors exist and the verdict is non-fatal: set the blocking decision true ONLY when the surviving work corrects something the source epic establishes and exposes — a contract, schema, API, or invariant a consumer would build on wrongly; internal cleanup, tests, docs, and perf never block; a client-side reverse-dependent scan over the board (keeper query epics, filtering deps that resolve to the source) is confirming evidence, not the gate; block even with zero current dependents when the flaw is consumer-observable; when torn, do not block. The verdict JSON and the one-line return carry blocks_closing/blocks_closing_reason with the same non-empty-iff-true pairing as fatal. Blocking case only: the authored follow-up drops the source provenance dep (the finalize verb substitutes the source's still-resolving deps and enforces never-the-source) and adds one Overview provenance line naming the source and that it blocks its close; the non-blocking case keeps the source provenance dep exactly as today. Close skill: the outcome switch becomes a total five-member switch whose gate branch reports the deferred close (source open, follow-up id, what fires next) instead of closing; on re-entry, a preflight reporting an in-flight blocking follow-up short-circuits straight to finalize — no re-audit, no re-plan; when the board is in armed mode the skill arms the follow-up through the autopilot arm surface or the gate waits on a human; an await monitor on the follow-up may be armed as a latency shortcut but the session ends its turn cleanly either way; a finalize typed-failure for a deleted follow-up is escalated by stamping the source's epic-question. The gate branch's terminal report needs one sanctioned stop-guard pattern (the fixed allow-list would otherwise hook-block the first blocking close's Stop), with the SKILL phrasing and the pattern kept in lockstep by test. README and plan CLAUDE.md prose track the five-member enum and the close-gate flow, plus one guardrail line for the status-blind scaffold carve-out. All prose forward-facing — current behavior only, no history, no epic ids.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/agents/close-planner.md:82-119 — the verdict shape and the fatal/fatal_reason pairing to mirror
- plugins/plan/agents/close-planner.md:138-206 — follow-up authoring rules, including the depends_on_epics source-link line near :145 the blocking case replaces
- plugins/plan/skills/close/SKILL.md:254-259 — the outcome switch; :99-141 — the QUESTION protocol whose escalation phrasing the deleted-follow-up path mirrors
- plugins/plan/plugin/hooks/stop-guard.ts:43-55 — CLOSE_ALLOW_PATTERNS and closeStopAllowed
- plugins/plan/test/consistency-skills.test.ts:420-425 — the SKILL/enum consistency gate

**Optional** (reference as needed):
- plugins/plan/test/stop-guard.test.ts — the pattern test home
- plugins/plan/README.md — close-flow, outcome enum, and stop-guard prose to update
- plugins/plan/CLAUDE.md — guardrail placement

### Risks

- The rubric is the feature's judgment surface: too eager and every audit blocks its source; too shy and the gate never fires. The consumer-observable test plus default-do-not-block is the calibrated line — keep the prose exactly that sharp.
- The stop-guard pattern and the SKILL phrasing can drift independently — the test pinning both is the guard.

### Test notes

stop-guard: closeStopAllowed is true for the new deferred-report line and existing patterns are untouched; consistency: SKILL.md carries all five outcomes in backticks; the saga task's truth-table suite already exercises the mechanics this prose drives, so no further executable surface here.

## Acceptance

- [ ] close-planner's contract emits and explains the blocking decision with the consumer-observable rubric, authors the blocking-case follow-up without a source dep and with the provenance Overview line, and keeps the non-blocking case identical to today
- [ ] The close skill's switch handles all five outcomes totally, short-circuits a re-entry past audit to finalize, arms the follow-up under armed mode, and escalates a deleted-follow-up failure via the source's epic-question
- [ ] The stop-guard sanctions the deferred terminal report, test-pinned to the SKILL phrasing, and plugin README/CLAUDE.md prose match shipped behavior
- [ ] The plan-plugin suite is green

## Done summary
Activated the blocking-follow-up close gate: close-planner emits the consumer-observable blocks_closing decision and authors the blocking follow-up without a source dep; the closer skill switches the five-member outcome enum totally, short-circuits a gated re-entry to finalize, arms the follow-up under armed mode, and escalates a deleted follow-up via the source epic-question; stop-guard sanctions the deferred-close report in lockstep with the SKILL phrasing; README + plan CLAUDE.md track the five-member enum, gate flow, and the status-blind scaffold carve-out.
## Evidence

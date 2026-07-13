## Description

**Size:** M
**Files:** src/daemon.ts, src/reconcile-core.ts, test/daemon.test.ts, CLAUDE.md

### Approach

Per ADR 0054: the repair escalation sweep classifies a repair session that is stopped or
dead WITHOUT a recorded terminal outcome, past an injectable grace anchored on the
existing repair-dispatched marker, as DECLINED — paging once through the existing notify
path and re-arming only via the retry wire. The existing died/declined verdict split is
preserved; the grace gate lives in the repair sweep producer (its deps interface), NEVER
in the shared escalation classifier (unblock/deconflict semantics untouched). No new
column: the grace anchor is the existing dispatch marker. Additionally, the
SHARED_BASE_BROKEN candidate path attaches a bounded failing-tests digest (the merge
gate's bounded-join shape: first 8 names + "(+K more)") and the baseline leaf key, sourced
from the red leaf's failing set, onto the sticky reason/brief — diagnosis by reference, no
new leaf writer, no schema change. Revise the CLAUDE.md Autopilot repair sentence in place
to state the terminal semantics.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1547-1990 — runRepairEscalationSweep + RepairEscalationSweepDeps; repairOutcome at :1918; notify gate ~:2087
- src/daemon.ts:3698 — classifyEscalationOutcome (SHARED with unblock/deconflict — do not change its verdict mapping)
- src/daemon.ts:1790,1817 — classifyBaselineForRepair / buildBaselineRepairCandidates (digest attach point)
- src/baseline-store.ts:171-234 — SuiteRedResult.failing + caps; :44-64 leaf key derivation
- src/autopilot-worker.ts:5836,5905-5930 — MERGE_GATE_MAX_FAILING_NAMES bounded-join to reuse
- src/reducer.ts:3839-3851 — dispatch_failures UPSERT preserve-list (context: confirm no new column needed)

### Risks

- False-decline of a slow-healthy repair is the dominant failure mode: the grace is generous and injectable; a working session never classifies.
- A repair stopped to park a question also classifies declined after the grace — accepted overlap (both surfaces page), note in the page copy.

### Test notes

Injected-deps sweep tests: stopped repair inside grace → no page; past grace → declined +
page-once + retry re-arms; working → never; digest present and bounded on the candidate
brief/reason; classifier verdict table unchanged for unblock/deconflict.

## Acceptance

- [ ] A stopped-without-outcome repair pages exactly once after the grace and re-arms via the retry wire; within-grace and working sessions never classify
- [ ] The shared escalation classifier's verdict mapping is byte-unchanged for unblock/deconflict
- [ ] The SHARED_BASE_BROKEN sticky/brief carries the bounded failing-tests digest and baseline leaf key
- [ ] CLAUDE.md's repair prose matches shipped behavior and lint stays green

## Done summary
Repair escalation sweep now classifies a stopped-without-outcome repair as declined past an injectable grace anchored on the existing dispatch marker, paging once and re-arming only via the retry wire, while working sessions never classify. The shared escalation classifier's verdict mapping is untouched. SHARED_BASE_BROKEN stickies/briefs now carry a bounded failing-tests digest (first 8 + more-count) and baseline leaf key. CLAUDE.md's repair prose revised to match.
## Evidence

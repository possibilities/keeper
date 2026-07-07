## Description

**Size:** M
**Files:** plugins/plan/skills/close/SKILL.md, plugins/plan/src/verbs/selection_review.ts, plugins/plan/src/cli.ts, plugins/plan/src/descriptor.ts, plugins/plan/agents/selection-auditor.md, plugins/plan/CLAUDE.md, plugins/plan/README.md, docs/problem-codes.md, plugins/plan/test/saga-selection-review.test.ts, plugins/plan/test/cli-help.test.ts, plugins/plan/test/src-cli-groups.test.ts, plugins/plan/test/verbs-readonly.test.ts, plugins/plan/test/consistency-skills.test.ts

### Approach

Remove the close-time grading beat and the board-flag verb. /plan:close keeps Phase 3.6a (assemble + commit the brief, idempotent re-close per task 1's guard) and loses 3.6b/3.6c (auditor spawn + submit relay); every cross-reference to the audit beat is scrubbed so the close skill reads as capture-only — the Phase 3.5 follow-up cell-selection beat is a different mechanism and stays untouched. The `selection-review` verb is deleted end to end (module, descriptor entry, cli dispatch case + imports, its saga test, help/group/readonly test rows) and entered in the removed-verbs list. The selection-auditor agent is reframed venue-neutral and blinded: it grades from a brief it is handed (no close-time framing, brief ref doc pointing at the committed path), judges difficulty from observable evidence, never sees selector rationale/confidence, and its evidence output is bounded to pointer-style references — no raw diff quotes. README and problem-codes surfaces update per the epic Docs gaps. All prose stays forward-facing — the close skill and README describe only the capture-only present; history lives in task 4's ADR and the removed-verbs entry.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/close/SKILL.md:219-270 — Phase 3.6a/b/c; cross-refs at 15, 19, 64, 92-93, 148, 319-324, 332
- plugins/plan/src/verbs/selection_review.ts — the verb to delete; descriptor.ts:568-586 and cli.ts:56-59 + 826-841 registrations
- plugins/plan/agents/selection-auditor.md:3,10,18,39,54 — close-time framing, old state path in AUDIT_BRIEF_REF, and the confidence-grading lines the blinding removes
- plugins/plan/CLAUDE.md "Removed verbs (do not re-add)" — the tombstone list shape
- plugins/plan/README.md:52, 89-96, 174-178, 187-193 — the four README surfaces

**Optional** (reference as needed):
- plugins/plan/test/consistency-skills.test.ts — will fail on any lingering selection-review ref in a skill; run it early
- plugins/plan/plugin/hooks/stop-guard.ts — verified unaffected; do not edit

### Risks

- The close SKILL.md is shared surface with recently-landed depth-band edits — rebase carefully around the Phase 1/2 depth pin, touch only the 3.6 beat and its cross-refs
- Missing one cross-ref fails consistency-skills; grep the whole skills tree for the verb name before finishing

## Acceptance

- [ ] `keeper plan selection-review` is an unknown command; the removed-verbs list carries it
- [ ] /plan:close's flow commits the brief and contains no auditor spawn, no submit call, and no dangling reference to either
- [ ] The selection-auditor agent definition reads venue-neutral, points at the committed brief path, and instructs grading without selector rationale/confidence and with pointer-bounded evidence
- [ ] README and problem-codes carry only the surviving surfaces
- [ ] Plan-plugin suite green including consistency-skills
- [ ] The Phase 3.5 follow-up cell-selection beat is byte-untouched

## Done summary

## Evidence

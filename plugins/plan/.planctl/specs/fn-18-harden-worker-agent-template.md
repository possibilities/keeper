## Overview

Bound the worker's test phase, cheapen predecessor pickup, and close the
trust gaps mined from 46 live worker transcripts: every observed worker death
was an unbounded full-suite rerun loop, successors re-paid full verification
of green predecessor work, and one worker burned ~15 calls improvising around
a wrapper envelope that contradicted git ground truth. All behavior lands in
template/agents/worker.md.tmpl (four tiers render from it); the work-skill
template and one reference doc get matching one-liners.

## Quick commands

- `grep -n "full-suite\|full suite\|never background\|trust git log\|note lines" template/agents/worker.md.tmpl` — budget, trust, and cap rules landed
- `promptctl render-plugin-templates --project-root /Users/mike/code/planctl && git status --short` — re-render clean, nothing tracked drifts
- `uv run pytest tests/` — green (test_work_skill_consistency + generated-guard fixtures are the relevant gates)

## Acceptance

- [ ] Phase 3 prescribes targeted-tests-then-ONE-full-pass with a hard cap of two full-suite runs per worker invocation, a serial re-run rule for failures confined to untouched tests, and bans backgrounding tests or idle-waiting on them
- [ ] Test-disabling (skip markers, commented assertions, weakened matchers) is named a hard-blocked action
- [ ] Predecessor pickup verifies via the predecessor commit's diff + task-targeted tests only, with explicit routing for partial coverage and for failures in code the worker did not write
- [ ] Envelope-vs-git disagreement rule: on-suspicion trigger (failure report or missing expected field while worker state says otherwise), exact git log queries given, one wrapper retry, then BLOCKED: TOOLING_FAILURE carrying both outputs
- [ ] No `planctl done --help`; the post-done `planctl show` nudge is a hard ban; the Phase 1 conditional `$PLANCTL show` survives
- [ ] Return summary hard-capped at the 5 template lines plus at most 3 note lines, no self-check narration, with note precedence flake/blocked > predecessor > similar-code
- [ ] Delivery self-check via `keeper session-state` is mandatory on every path including no-op tasks; raw git porcelain reasoning is banned
- [ ] The verbatim similar-code grep command is gone; the search-before-writing principle and the reuse/extend/new report line remain
- [ ] Every new budget/trust/cap rule is echoed in the Rules block (resume directives skip phase text)
- [ ] work-skill template: resume nudge carries the cap guard; return-summary description names the cap; self-check wording matches mandatory language. commit-at-mutation-boundary.md no longer says "free-text return summary"
- [ ] Rendered worker-*.md + sidecars regenerated in the same commit; all prose present-tense forward rules

## Early proof point

Task that proves the approach: ordinal 1. If the Rules-block growth makes the
template unwieldy, recovery: group the new bullets under a single "Budgets &
trust" rule with sub-bullets rather than ten flat lines.

## References

- Transcript evidence base: 6/46 worker deaths all in unbounded suite loops; successor runs re-spent 30-60% of calls re-proving green work; one false-success envelope cost ~15 calls of improvisation
- Trust hierarchy: git log / git cat-file are ground truth; wrapper envelopes are derived; the model never adjudicates a disagreement by reasoning — it re-runs the ground-truth query and sides with it
- Targeted-selector degradation: ecosystems without a per-file selector (zig) collapse targeted into the single full pass; the two-run cap is unchanged
- The full-suite cap bounds full passes only — fix-then-targeted-rerun iteration on the worker's own failing code is not capped by it

## Best practices

- **Flaky vs deterministic before rerunning:** mixed pass/fail across runs = flaky (annotate in `Tests:` and proceed); 100% fail = deterministic (fix or escalate); never code-fix-loop a flaky untouched test
- **Budget-exhaustion pressure is when agents cheat:** the test-disabling ban must sit adjacent to the cap, not in a distant section
- **Truncated envelopes parse:** a success envelope missing an expected field is truncation, not success — treat as suspicion, cross-check git
- **Return-value tokens are parent-context tax on every later turn:** evidence by reference ("1 assertion failed: expected X got Y"), never full test output

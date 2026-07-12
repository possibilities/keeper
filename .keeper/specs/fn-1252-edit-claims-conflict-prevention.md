## Overview

Plan-time conflict prevention becomes structured and mechanical: tasks declare their
predicted write surface as edit claims, the scaffold overlap gate refuses near-certain
collisions between unordered tasks, a pre-arm sweep catches cross-epic collisions
(including same-session siblings), inter-epic overlap wiring is risk-tiered instead of
uniformly serializing, and an out-of-band calibration report scores predictions against
landed Commit ground truth. The escalation backend (resolver → deconflict) remains the
safety net for the residual; this epic makes the frontend stop over-serializing what
would merge clean and stop missing what won't. Design record: ADR 0042.

## Quick commands

- `cd plugins/plan && bun test` — fast suite including the new claims/gate/sweep tests
- Scaffold two unordered tasks claiming the same expected path → expect `write_overlap_unordered` naming the pair; re-run with `--allow-overlap` → warns and commits
- `keeper plan overlap-sweep <epic>` — JSON envelope of hard/soft cross-epic claim hits
- `keeper plan claims-report <epic>` — per-tier predicted-vs-actual precision/recall for a landed epic

## Acceptance

- [ ] Every newly scaffolded task carries structured edit claims (present, possibly empty) and its spec's Files: line is derived from them, never hand-authored
- [ ] Scaffold refuses DAG-incomparable same-repo tasks with colliding expected exact claims unless --allow-overlap; softer intersections warn without blocking
- [ ] A pre-arm sweep reports cross-epic claim collisions including same-session siblings; hard hits wire depends_on_epics through the existing add-deps verb
- [ ] Inter-epic overlap guidance is risk-tiered in lockstep across the plan skill, epic-scout, and gap-analyst — no surface still states the uniform overlap-to-edge rule
- [ ] Worktree merge conflicts record the conflicted file set structurally; the escalation brief consumes it without stderr regex when present
- [ ] A calibration verb scores claims against landed Commit files per certainty tier (precision AND recall, never accuracy) and lists unclaimed tasks
- [ ] The diagnostic spike's verdict is recorded; a not-dominant verdict paused the epic at the check-in instead of building

## Early proof point

Task that proves the approach: ordinal 1 (the conflict-cause diagnostic spike). If it
fails or returns a not-dominant verdict: the epic pauses at the designed check-in and is
refined toward the dominant conflict class (base-drift → rebase-cadence work) instead of
building the claims machinery.

## References

- ADR 0042 (edit claims + risk-tiered overlap wiring); ADR 0018 (out-of-band review precedent); ADR 0020 (merge-time schema renumber)
- `fn-1239` (overlap) — its in-flight task edits src/reducer.ts and appends a SCHEMA_STEPS entry + SCHEMA_FINGERPRINT re-pin; this epic's conflict-files column is a sibling ladder bump on the singleton migration ladder, serialized via the wired epic dep
- Named follow-up (calibration-gated, OUT of scope): dispatch-time overlap defer — an ephemeral producer probe twin of computeDeferredEpicIds applied at the reconciler's per-row work gate before the losing lane is cut; build only if the calibration report shows a non-trivial residual after this epic lands
- Named follow-up: a dedicated post-decomposition edit-surface scout — promote from planner-inline claim seeding if calibration recall stays low
- Future enhancement: counterfactual replay (offline pairwise merge dry-run of hard-serialized pairs' landed diffs) to de-bias the selective-labels gap in calibration
- Known holes (accepted): rename collisions are invisible to path claims (git rename detection is content-based); semantic conflicts are invisible to file claims — the resolver pipeline remains the backstop
- Working-tree coordination: worker-implement partials and the render-plugin-templates fixture were dirty from prior epic work at plan time — a worker regenerating templates must verify current state first

## Docs gaps

- **docs/problem-codes.md**: add `claims_invalid` and `write_overlap_unordered` rows in the same change each code lands (the file's own contract)
- **plugins/plan/README.md**: document the edit_claims task field, the overlap gate + --allow-overlap, and the two new verbs; prune the prose-Files framing
- **plugins/plan/CLAUDE.md**: one-line guardrail — edit claims are the write-surface source of truth; never hand-author the Files: line

## Best practices

- **Certainty-tiered gating:** only ~7–20% of concurrent same-file edits conflict textually — reject only near-certain collisions, let the rest race into the resolver [merge-conflict mining studies]
- **Selective-labels bias:** hard-serialized pairs never race; never read their absence of conflicts as gate precision — keep one evaluation path uninfluenced by the gate's own decisions
- **Per-tier precision AND recall, never accuracy:** a 10–20% base rate makes accuracy meaningless; false positive = silent lost parallelism, false negative = one resolver invocation — asymmetric costs, tracked separately
- **Glob discipline:** pin semantics explicitly (`*` never crosses `/`), reject invalid patterns (`..`, absolute, backslash) loudly, bound complexity — claims are agent-authored input
- **Rename blindness:** path claims cannot see rename collisions — a documented recall hole, not a bug to fix in globs

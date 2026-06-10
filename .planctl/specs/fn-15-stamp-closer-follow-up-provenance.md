## Overview

`close-finalize` discovers "the follow-up epic a prior crashed close run
scaffolded" by scanning for the first open epic whose `depends_on_epics`
contains the source (`_find_followup_epic`, `planctl/run_close_finalize.py:183`).
That structural heuristic falsely matches human-planned epics that legitimately
depend on the source: a task-count mismatch wedges the close in perpetual
`partial_followup` (keeper autopilot re-dispatches `close::<source>` forever —
the fn-12/fn-13 incident, 2026-06-10), and an exact count match would silently
adopt an unrelated epic as the audit follow-up. The fix is positive provenance:
the scaffold step of the close saga stamps `created_by_close_of: <source_epic_id>`
onto the minted follow-up epic JSON, and discovery matches ONLY on that stamp.
End state: a pre-existing open dependent is invisible to the closer; the real
follow-up scaffolds; the source closes `closed_with_followup`; autopilot unwedges.

## Quick commands

- `cd /Users/mike/code/planctl && uv run pytest tests/test_close_finalize.py -q`
- `cd /Users/mike/code/planctl && uv run pytest tests/ -q` (fast bucket gate)

## Acceptance

- [ ] `_find_followup_epic` matches only an epic whose `created_by_close_of` equals the source epic id; `depends_on_epics` membership is never consulted, not even as a fallback or sanity check
- [ ] `run_scaffold` stamps the field onto the minted epic JSON only when the internal arg is supplied (read via `getattr(args, "created_by_close_of", None)`); no CLI flag, no `followup.yaml` key, YAML validators untouched
- [ ] fn-13 regression test: a pre-existing open dependent (dep edge, no stamp, wrong task count) is ignored — the real follow-up scaffolds and the source closes `closed_with_followup`
- [ ] Crash-resume adopt and `partial_followup` paths key on the stamp; the `actual_tasks == expected` count gate is unchanged
- [ ] Docs updated: README `/plan:close` source-link sentence, CLAUDE.md close-finalize contract sentence, `docs/reference/planctl-bug-history.md` incident entry

## Early proof point

Task that proves the approach: `.1` (the only task). If it fails: the predicate
change is isolated to one function with two call sites — keep the stamp write
(harmless additive field) and rework the predicate alone.

## References

- Incident record: `~/docs/2026-06-10-autopilot-closer-loop-fn-12-symptoms.md` (symptoms-only handoff; root cause diagnosed in keeper session 2026-06-10)
- **fn-12 reverse-dependency (deliberately NOT wired as `depends_on_epics`)**: this epic edits files fn-12 built, but fn-12's tasks are all done and the files are landed on main — there is no work-ordering need. The true ordering is the reverse: fn-12's `/plan:close` re-run succeeds only after this fix lands. Wiring fn-12 as a dep would deadlock armed autopilot (dep-closure re-arms fn-12, resuming the broken close loop, while this epic stays dep-gated until fn-12 completes).
- Keeper's `epics.created_by_closer_of` (keeper `src/reducer.ts:6048`) is derived from job lineage and is fully independent of this on-disk field — same concept, different substrate; do not wire them together.
- Pattern analog: Kubernetes `ownerReferences` (positive owner ref) vs label-selector adoption (structural heuristic) — the latter is the documented false-adoption failure class.

## Docs gaps

- **README.md:164**: `/plan:close` table entry describes `epic.depends_on_epics: [<source_eid>]` as "the source-link" — rewrite: discovery rides `created_by_close_of`; the dep edge remains a real dependency but is not the provenance signal
- **CLAUDE.md:48** (AGENTS.md is a symlink — one edit): add the `_find_followup_epic` matching contract sentence (stamped internally at scaffold; not part of `followup.yaml`; never dep-edge scanning)
- **docs/reference/planctl-bug-history.md**: new incident entry (Symptom / Root Cause / Implementation Summary / Key Files Changed / Verification format)

## Best practices

- **Stamp at mint, atomically:** the field rides the same `atomic_write_json(epic_path, epic_def)` as the rest of the epic — a crash leaves either no follow-up file or a complete stamped one; there is no stampless-epic window [saga orchestration: persist the step marker with the action]
- **Absence = not mine:** an open epic without the stamp is never adopted — no heuristic fallback for pre-fix records [k8s ownerReferences: unowned objects are not adopted by label inference]
- **No backfill:** old closer-minted follow-ups (fn-14 etc.) stay unstamped — backfilling via dep-edge inference would re-execute the heuristic being removed; the only effect is the cosmetic replay label on already-done epics [schema evolution: consume-before-produce, no backfill]
- **Count gate stays:** a stamped hit with `actual_tasks < expected` is still `partial_followup` — provenance match does not relax the validity gate
- **Correlate on the source epic id**, never session/run id (rotates per crash-resume attempt; the epic id is the stable saga key)

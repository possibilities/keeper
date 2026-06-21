## Description

**Size:** S
**Files:** `CLAUDE.md`, `README.md`, `docs/planctl-strip.md`, `test/refold-equivalence.test.ts` (doc comment), `cli/find-file-history.ts`

### Approach

Forward-facing docs for the new projection-class model, after `.1` lands. **CLAUDE.md** event-sourcing-invariants block: add the projection-class taxonomy (deterministic-replayed / live-producer-fed / control), the skip-floor rule, the boot-producer contract, and the "a fold whose per-event cost grows with history is a re-fold time-bomb — model it live-only or constant-bounded" rule; Migrations block: the no-wipe-live-projections discipline (rewinding wipes enumerate only deterministic projections; live ones reset-floor+seed_required). **README ## Architecture:** scope the re-fold-determinism prose to deterministic-replayed projections; document the git surface as live-only (no historical replay, boot-seeded). **docs/planctl-strip.md §3a/§4:** note the cursor-rewind constraint is now bounded by the live-only carve-out. **Charter test doc comment:** declare git_status/file_attributions the canonical live-only counter-example. **cli/find-file-history.ts:** reword/repoint — it presents `file_attributions` as history, which live-only no longer provides (point at event history instead).

### Investigation targets

**Required** (read before coding):
- `CLAUDE.md` event-sourcing-invariants + Migrations blocks
- `README.md` ## Architecture (fold model, the GitSnapshot fold section, the rewind-and-redrain list)
- `docs/planctl-strip.md` §3a/§4; `test/refold-equivalence.test.ts:1-37` doc comment + `rewindAndWipeProjections()` :768-777
- `cli/find-file-history.ts:120`

### Risks

- Forward-facing only — state the present projection-class model; do not narrate "git used to be re-folded".

### Test notes

- No code logic; verify `cli/find-file-history.ts` still functions after the reword/repoint.

## Acceptance

- [ ] CLAUDE.md taxonomy + skip-floor + time-bomb rule + no-wipe-live-projections discipline added
- [ ] README architecture + charter doc comment scope re-fold determinism to deterministic-replayed projections; git documented live-only
- [ ] `cli/find-file-history.ts` reworded/repointed (live-only loses ancient attributions)

## Done summary
Documented the live-only git projection class: CLAUDE.md taxonomy + skip-floor + boot-producer contract + time-bomb rule + no-wipe-live-projections migration discipline; README/charter-doc/planctl-strip scope re-fold determinism to deterministic-replayed projections and document the git surface as live-only; find-file-history repoints deep history at the event log.
## Evidence

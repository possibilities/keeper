## Description

Originating findings: F1 (kept) and F2 (merged-into-F1) from the
fn-1186 audit. At commit 033e4bc8 the Stop fold in `src/reducer.ts:8608`
does `JSON.parse(event.data)` -> `computeMonitors(...)` -> `UPDATE jobs SET
monitors = ?`. `computeMonitors`'s own doc (`src/reducer.ts` ~line 9678)
declares `jobs.monitors` "byte-identical across re-folds", and
`test/refold-equivalence.test.ts:3552` pins it in the from-scratch re-fold
charter (`:3480`: the FINAL per-session Stop is the surviving one, so there
is no later Stop to re-derive it). Yet `RETENTION_NULL_TOLERANT_KEEP_PREDICATE`
in `src/compaction.ts` lists `Stop` as a class "whose body no fold reads" —
false for a final Stop, blinding `countAbsentBlobs` on a charter fold input
exactly where a stray NULLing write / corrupt restore would ALSO cause a
cursor-0 re-fold divergence (`monitors` -> `'[]'`).

Pick one remedy and make the code and its justification agree:
- Narrow: drop `Stop` from `RETENTION_NULL_TOLERANT_KEEP_PREDICATE` so the
  sentinel keeps flagging a NULL Stop body (its body is a charter input); or
- Keep + correct: leave the exemption but replace the "no fold reads its
  body" rationale (in the predicate doc-comment in `src/compaction.ts`) with
  a statement that the Stop body feeds `jobs.monitors` (a byte-identical
  charter projection) and why a final-Stop `'[]'` divergence is acceptable.

Files: `src/compaction.ts` (predicate + `countAbsentBlobs` doc),
`test/compaction.test.ts` (pinning test); consult `src/reducer.ts` (Stop
fold, `computeMonitors`) and `test/refold-equivalence.test.ts` for the
charter shape.

## Acceptance

- [ ] The Stop clause no longer rests on a false re-fold-safety claim —
      `Stop` is either removed from the exemption or its justification is
      corrected to name `jobs.monitors` as the charter projection its body
      feeds and why the divergence is benign.
- [ ] A pinning test in `test/compaction.test.ts` NULLs a final-Stop body
      carrying live `background_tasks` monitors and re-folds (cursor=0),
      asserting the chosen behavior (sentinel flags it, or the
      `monitors -> '[]'` divergence is proven benign).
- [ ] `bun test` green (root + plan suites unaffected).

## Done summary
Corrected the false 'no fold reads its body' rationale for the Stop clause of RETENTION_NULL_TOLERANT_KEEP_PREDICATE (kept the exemption): documented that a final Stop's background_tasks feed jobs.monitors, a byte-identical charter projection, and why the NULLed-body monitors->'[]' divergence is a benign, cheap-header-indistinguishable drop-when-dead. Added a cursor=0 re-fold pinning test proving the divergence and that countAbsentBlobs stays exempt.
## Evidence

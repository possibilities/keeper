## Description

Originating findings F1 (kept) and F2 (merged-into-F1), both tracing to the
same two doc-comment blocks. Evidence path from Phase 2:

- types.ts:585-594 and reducer.ts:4848-4856 assert `active_since` is
  "stamped once... then frozen at that ts." This is false: reducer.ts:6939-6942
  (UserPromptSubmit arm, `CASE WHEN state != 'working' THEN ?`) and
  reducer.ts:7307 / 7327 (Pre/PostToolUse un-stop arms,
  `CASE WHEN state = 'stopped' THEN ?`) each overwrite `active_since` on
  every resume — it is the most-recent-edge timestamp, not frozen. (F1)
- types.ts:590 and reducer.ts:4854 say "absent ≡ null for a pre-v90 stored
  element"; v90 does not exist — the embedded field first appears in v84, so
  the boundary is "pre-v84". (F2, same blocks as F1 — file-touch overlap is
  why they bundle.)

Also update the `anyEmbeddedJobBoundPending` doc in src/readiness.ts if it
carries the same "frozen" wording. Correct the invariant text to: null until
the FIRST un-stop edge, then non-null thereafter (re-stamped on each
subsequent edge). Forward-facing invariant wording only — no behavior change.

## Acceptance

- [ ] All `active_since` comments state the field is null until the first un-stop edge, then non-null and re-stamped on subsequent edges (no "frozen" / "stamped once").
- [ ] The schema boundary reads "pre-v84" or omits the version; no "v90" remains.
- [ ] No production logic or test assertion changes — comments only.

## Done summary
Corrected the active_since doc comments in types.ts, reducer.ts, and readiness.ts: the field is re-stamped on every un-stop edge (not frozen), and the schema boundary is pre-v84 (not the non-existent v90). Comments only — no behavior change.
## Evidence

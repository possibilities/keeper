## Description

Originating finding: F1 (Should fix) from the source epic's close audit.
Evidence path: `4e54993c` carries only a `Job-Id:` trailer and no
`Task:` trailer, so `src/transcript/codex.ts` (817 lines) and
`test/transcript-codex.test.ts` (597 lines) never entered the audit's
`commit_groups` and were never reviewed by the close gate, unlike the
pi (.2) and seam (.1) readers.

Files:
- `src/transcript/codex.ts` — the reader to review/harden.
- `test/transcript-codex.test.ts` — its test suite; extend if review surfaces an untested path.
- `src/transcript/registry.ts` — the +2 registry lines wiring the codex reader.

Review `codex.ts` against the defensive-parse and security discipline
the pi/claude readers hold (per the auditor's Standards axis): bounded
per-line reads, fold-to-skip that never throws on unknown
response_item/event_msg types, TOCTOU-safe listing, and path-traversal
guards on the cwd-scoped day-dir listing and filename-uuid find. Fix any
correctness or security defect found. Then repair the codex code's
provenance so it is traceable to task .3.

## Acceptance

- [ ] codex.ts reviewed against the sibling readers' defensive-parse and security posture, with any defect found fixed (or a clean-review conclusion recorded)
- [ ] the codex reader's commit is traceable to task .3 (Task trailer restamped, or the residual gap recorded for the closer if a safe rewrite is not possible)

## Done summary
Reviewed src/transcript/codex.ts against the pi/claude defensive-parse and security posture: CLEAN. All five axes hold — read-and-catch over existsSync-then-read (list inspect + all dir scans wrapped; load's existsSync-then-read matches piLoad and its throw is caught by the CLI read_failed handler), per-line byte cap (in BOTH parseCodexLine and scanCodexHead), fold-to-skip never throwing on unknown response_item/event_msg/top-level types, stable modifiedMs-desc + sessionId total-order sort, and a strict-uuid path-traversal guard (isSafeCodexSessionId) on find plus content-compared (never path-built) list project scope. codex EXCEEDS pi in two spots: byte cap also applied in the scanCodexHead pass, and a stricter uuid id-guard. No correctness or security defect found; the windowedDayDirs date-range walk is driven only by trusted CLI flags (never attacker content) and terminates for all realistic inputs. Added 2 regression tests locking in the two previously-untested find() branches the review surfaced (path-traversal id rejection; ambiguous uuid across day-dirs). PROVENANCE GAP recorded for the closer: the codex reader commit 4e54993c carries a Job-Id but no Task trailer and is an ancestor of main AND origin/main (public/pushed), so no safe history rewrite is possible — the trailer cannot be restamped; this fn-1259.1 review discharges F1 in place of the missing provenance.
## Evidence

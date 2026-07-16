## Description

Findings F1 (Should fix) and F2 (Consider), bundled: both concern the
`harnessOrClaude` throw-on-unknown contract this epic introduced, and land
as one commit across `src/agent/harness.ts` and its batch-restore consumers.

F1 — the whole-batch derivations reject the entire set when any single
unregistered-harness row is present:
- `src/restore-worker.ts:423` (`buildRestoreTier`)
- `src/restore-set.ts:605` (`deriveRestoreSet`)
- `src/tabs-core.ts:179` (`assertSupportedCandidateHarnesses`)
Each loops over the live session set and calls `harnessOrClaude`, which
throws at `src/agent/harness.ts:240`. The pulses catch the throw
(`src/restore-worker.ts:1146` / `:1161`) so the daemon does not crash, but
`restore.json` / `revive.sh` go stale for every healthy Claude/Pi session
while one live legacy Codex/Hermes session (`working`/`stopped`) persists.
Rework these three surfaces to skip-and-surface an unregistered-harness row
(mirroring the visible-skip `adoptedCoordlessSkipCount` pattern already in
`src/restore-set.ts`) instead of throwing the whole derivation, so a lone
retired row cannot blank the mirror for healthy sessions. Apply the same
treatment to the `keeper tabs restore` / `dump` CLI path so it degrades to a
surfaced skip rather than one loud whole-batch failure.

F2 — the `harnessOrClaude` docstring at `src/agent/harness.ts:229-233` still
reads "defaulting a NULL/empty/unknown tag to claude" while the body throws
on an unknown non-empty value. Correct it to match the implementation (NULL/
empty defaults to claude; an unknown non-empty harness throws), consistent
with the already-correct `buildHarnessResumeArgv` docstring below it.

Files: src/restore-worker.ts, src/restore-set.ts, src/tabs-core.ts,
src/agent/harness.ts

## Acceptance

- [ ] Each batch derivation skips-and-surfaces an unregistered-harness row
      and still emits a complete restore set for the healthy sessions.
- [ ] `keeper tabs restore` / `dump` degrade to a surfaced skip, not a
      whole-batch throw.
- [ ] The `harnessOrClaude` docstring states the throw-on-unknown contract.
- [ ] Coverage asserts a mixed set (one retired row + healthy Claude/Pi rows)
      yields the healthy sessions plus a surfaced skip, not an empty/frozen set.

## Done summary
Retired-harness restore rows now skip-and-surface instead of wedging the restore set; operator-verified 231/0 across restore-set/restore-worker/tabs suites and landed via plain-git escape (orphaned leg claims 571e6310/b03e75f9/893e19cc unadoptable) as 67b1f187 on the epic lane
## Evidence
- Commits: 67b1f187
- Tests: bun test restore-set+restore-worker+tabs 231/0 (operator re-run in lane)
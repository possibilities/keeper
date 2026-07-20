## Description

Surviving audit findings F1 and F2, both in
`plugins/plan/src/verbs/close_finalize.ts` (trunk-lease integration path).

F1 (coverage): `integrateRepoUnderLease` (close_finalize.ts:742-944) and
its parent `integrateEpicBases` — the code that merges an epic branch into
local default under a fenced lease — have no verb-level unit coverage. A
grep over `plugins/plan/test/` and `test/` finds only the daemon producer
`runTrunkLeaseSweep` and the pure `decideTrunkIntegrationFence` exercised;
`saga-close-finalize.test.ts` touches no trunk path. Add saga-level tests
behind a pure git seam covering: ancestor-skip / already-integrated,
conflict-retains-lease (TRUNK_INTEGRATION_CONFLICT exits holding the
lease), off-branch, dirty, pre-existing MERGE_HEAD residue, tip-drift over
the 3-attempt fenced loop, and the release-on-failure paths.

F2 (behavior/doc mismatch): close_finalize.ts:1034
`if (grade === "ancestor") continue;` returns early without adopting or
releasing a lingering active lease left by a prior conflicted attempt —
contradicting the SKILL.md recovery contract at
`plugins/plan/skills/close/SKILL.md` lines 88 and 275, which promise the
ancestry grade "adopts and releases the still-live trunk lease before
close" on the deconflict-`resolved` re-run. Reconcile the two: either make
the ancestor re-grade adopt-and-release a still-active lease before
continuing, or amend SKILL.md to state daemon claimant-death reclaim is
the intended cleanup. Whichever route, the F1 tests should assert the
chosen behavior.

Files: `plugins/plan/src/verbs/close_finalize.ts`,
`plugins/plan/test/saga-close-finalize.test.ts`,
`plugins/plan/skills/close/SKILL.md` (only if the doc-amend route is taken).

## Acceptance

- [ ] Saga-level tests over integrateRepoUnderLease exercise the merge, ancestor-skip, conflict-retains-lease, off-branch, dirty, residue, tip-drift, and release-fail exits behind a pure git seam.
- [ ] The ancestor re-grade path and SKILL.md agree on lease cleanup, and a test asserts it.
- [ ] Named plan gate green (bun run test:gate).

## Done summary

## Evidence

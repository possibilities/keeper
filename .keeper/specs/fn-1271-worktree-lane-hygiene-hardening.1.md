## Description

**Size:** M
**Files:** scripts/rebase-schema-migration.ts, test/rebase-schema-migration.test.ts

### Approach

Rekey the merge-time ladder alignment on step IDENTITY — version plus canonicalized body
signature — instead of the version-number lookup, so the post-merge union shape resolves
mechanically. Live repro (must become a regression fixture): a working-tree db.ts contains
main's full ladder (…v119 account_route, v120 drop, v121, v122) PLUS one branch-local
additive step also numbered v119 with a different body; the current walk flags main's own
v120 (byte-identical to main's) as a lane duplicate and refuses identical-content. Under
identity keying: any lane step matching a main step's (version, body-signature) is main's
own step — shared, regardless of file position; only body-not-in-main steps are
branch-local candidates; branch-local steps may appear mid-file. Provably
additive-idempotent branch-local steps renumber to main-tail+1..+k and the fingerprint
re-pins (existing computeRepinnedFingerprint + rewriteTestAssertions keep test pins in
lockstep). Same-version+same-body absorbs as shared; same-body at a DIFFERENT version
still refuses for a human, and every destructive-step refusal (proofGate +
scanBodyDenylist) is untouched.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/rebase-schema-migration.ts:386 — apply()'s divergence walk; :394-407 the version-keyed lookup + identical-content refusal being replaced; :167 bodySignatureOf (the canonicalized identity half)
- scripts/rebase-schema-migration.ts:290 — proofGate; :269 scanBodyDenylist (keep every refusal)
- scripts/rebase-schema-migration.ts:466 — computeRepinnedFingerprint / applyFingerprintRepin; :336 rewriteTestAssertions

**Optional** (reference as needed):
- test/rebase-schema-migration.test.ts — pure string-fixture suite the regressions extend
- docs/adr/0053-lane-dirt-backup-and-bounded-teardown.md + docs/adr/0020 — the decision + the trunk-keeps-numbers rule

### Risks

- Silent dedup creep: absorbing same-body-different-version would hide a human-judgment case — that path must keep refusing.
- The fingerprint recompute assumes renumber shifts labels only; a different-body local step must yield byte-identical DDL under old and new numbers (additive-idempotent gate guarantees it — assert in a test).

### Test notes

Pure apply() fixtures: the union-shape live repro (renumbers, no refusal); mid-file
branch-local step; same-version+same-body coincidence (absorbs); same-body different
version (refuses); destructive local step (refuses); multi-step renumber to tail+1..+k
with fingerprint + test-assertion rewrite verified.

## Acceptance

- [ ] The recorded union-shape repro renumbers mechanically (no identical-content misfire) and re-pins the fingerprint
- [ ] A branch-local additive step is detected by body identity regardless of file position
- [ ] Same-body-at-different-version and every destructive class still refuse for a human
- [ ] Regression fixtures cover all the above in the fast suite

## Done summary
Rekeyed the merge-time schema-ladder alignment on step identity (version + canonicalized body signature) instead of version-number lookup, so a branch-local additive step is detected by body identity regardless of file position, the recorded union-shape repro renumbers mechanically without a false identical-content refusal, same-body-at-a-different-version and every destructive class still refuse, and regression fixtures cover all of it in the fast suite.
## Evidence

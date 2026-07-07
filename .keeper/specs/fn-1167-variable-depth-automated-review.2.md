## Description

**Size:** M
**Files:** plugins/plan/src/vcs.ts, plugins/plan/test/fake-vcs.ts, plugins/plan/src/verbs/close_preflight.ts, plugins/plan/test/saga-close-preflight.test.ts

### Approach

Give close-preflight the signals depth derivation needs, additively within the existing audit schema version (the auditor hard-checks the version — additive fields are safe, a bump is not; do not bump). The PlanVcs facade gains a commit-set numstat: per-commit numstat summed over a sha list (the only well-defined aggregate over non-linear commit_groups), with a fake-vcs twin so the fast tier never touches git. close-preflight enriches the brief: per-task tier (read from task JSONs), per-repo diff stats from the new numstat, refs to any per-task audit artifacts already persisted for the epic (path + finding status only — the brief stays content-light), and the derived depth band computed from audit-policy.yaml's thresholds and written into the brief. Every failure — numstat git error (shallow, rewritten shas), missing policy, unreadable artifacts — degrades that signal and lands the band at lean; close-preflight still succeeds; the degrade reason rides the brief so the close report can surface it.

### Investigation targets

*Verify before relying.*

**Required**:
- plugins/plan/src/vcs.ts — the PlanVcs facade shape (shortStatusAndDiff precedent) and getVcs seam
- plugins/plan/test/fake-vcs.ts — the fake twin contract
- plugins/plan/src/verbs/close_preflight.ts:129-205 — brief assembly, contextForRoot routing, AllReposBrokenError posture
- plugins/plan/src/audit_artifacts.ts — AUDIT_SCHEMA_VERSION fold into commit_set_hash (the do-not-bump constraint) and artifact enumeration helpers

### Risks

- A huge mechanical diff (generated files) inflating LOC into deep — thresholds live in policy (task 1's file) so tuning is config, not code; consider a per-file LOC cap noted in the policy comments.
- commit_set_hash stability: adding brief fields must not feed the hash inputs in a way that spuriously staleness-trips in-flight audits — verify what the hash covers before touching.

### Test notes

Fake-vcs drives numstat cases (normal, error, empty); preflight saga asserts enrichment, band derivation per threshold fixtures, and each degrade arm.

## Acceptance

- [ ] The vcs facade exposes a commit-set numstat with a fake twin; no test touches real git
- [ ] Close briefs carry per-task tier, per-repo diff stats, prior per-task finding refs, and a derived depth band; the audit schema version is unchanged
- [ ] Every signal failure degrades to lean with the reason recorded in the brief; close-preflight never fails on a depth-signal error
- [ ] Plan suite green

## Done summary
close-preflight now enriches the audit brief with per-task tier, per-repo diff stats (from a new commitSetNumstat facade + fake twin), prior per-task finding refs, and a policy-derived depth band (lean/standard/deep); every depth signal degrades independently to lean with the reason recorded, so close-preflight never fails on a depth-signal error and the audit schema version is unchanged.
## Evidence

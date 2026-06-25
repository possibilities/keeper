## Description

From audit finding F5 (src/restore-set.ts:739-758, resolvePaneJobId): the
projection-join fallback keys on (backend_exec_generation_id,
backend_exec_pane_id) precisely so a recycled tmux pane id (%N) from a different
generation never resolves to the wrong job. That recycle guard — the stated
reason for the compound key — is asserted only implicitly today (the present-match
case is covered). Add a test that seeds the same pane_id under two distinct
generations and proves resolvePaneJobId returns the job for the queried
generation and NOT the wrong-generation job. This pins the central %N-recycle
defense so a regression that dropped generation_id from the join key would fail.

## Acceptance

- [ ] A test seeds two jobs sharing one pane_id under two different
      generation_ids and asserts resolvePaneJobId resolves only the queried
      generation's job.
- [ ] The test fails if the join key is reduced to pane_id alone.

## Done summary

## Evidence

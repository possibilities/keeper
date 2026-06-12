## Description

**Size:** M
**Files:** test/saga-claim.test.ts, test/saga-close-preflight.test.ts, test/saga-close-finalize.test.ts, test/saga-reconcile.test.ts, test/saga-worker-resume.test.ts, test/saga-find-task-commit.test.ts, test/saga-commit.test.ts (all new)

### Approach

Translate the worker/saga lifecycle cluster onto the landed harness — the half the creation-modules task recorded as deferred: test_claim (22 inventory nodes), test_close_preflight (27), test_close_finalize (20), test_reconcile (23), test_worker_resume (11), test_find_task_commit (13), test_commit (19) — 135 nodes total per test/fixtures/pytest-inventory.txt, which is the arithmetic truth. Same discipline as the landed sibling translations: every node carries its pytest source-comment and classifies as translated | cited | drop-with-reason; python_only nodes are the drops; reconcile and find-task-commit portions already covered by src-git-lookup.test.ts are citations. test_commit's split is explicit: its in-process portions are the cited src-commit.test.ts units; its real-git CLI portions translate here with the harness git assertion helpers. Parametrized cases land as test.each rows preserving node counts. Real-git tests ride the PLANCTL_RUN_SLOW gate. Existing saga-*.test.ts files from the creation cluster and all cited src-*.test.ts files are READ-ONLY — never extend a citation target. If a translated assertion goes red against the binary, that is a real conformance gap: fix src/ as part of this task; if the fix is genuinely out of scope, block with the specific failure — never drop a real behavior.

### Investigation targets

**Required** (read before coding):
- The seven pytest source files — the spec, node by node
- test/fixtures/pytest-inventory.txt — the node-count truth per module
- test/harness.ts — runCli, withProject, seedState, gitLogCount/gitHeadMessage/gitFilesInHead, SLOW_ENABLED
- test/src-git-lookup.test.ts and src-commit.test.ts — the citation targets (frozen)

### Risks

close-finalize's outcome matrix and reconcile's verdict truth table are the dense nests — translate node-by-node against the source, never cluster-summarize.

### Test notes

bun test green fast and with PLANCTL_RUN_SLOW=1; uv run pytest suite untouched and green; per-module node sub-totals self-checked against the inventory before handoff to the gate.

## Acceptance

- [ ] All 135 inventory nodes mapped by source-comment (translated | cited | drop-with-reason); sub-totals match the inventory file
- [ ] Owned files only; citation targets and prior saga files untouched
- [ ] bun test green (fast + slow); any red translation resolved by fixing src/, recorded in Evidence

## Done summary

## Evidence

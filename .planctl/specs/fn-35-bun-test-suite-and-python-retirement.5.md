## Description

**Size:** S
**Files:** test/fixtures/pytest-inventory.txt (annotated or paired with the mapping ledger), no production changes expected

### Approach

The completeness gate. Re-capture the live --collect-only count and reconcile against the committed inventory; sweep for zero test.todo; build the ledger: every inventory node → {bun test file:name | cited bun unit | drop reason}; verify (inventory − enumerated drops) equals the bun suite's test()+each-case count; spot-audit the dense files (test_scaffold, test_validate_marker, test_cross_project_epic_deps) node-by-node against their translations; run both suites green one final time side by side (pytest fast + --run-slow + conformance at the production binary; bun fast + PLANCTL_RUN_SLOW=1). Any mismatch blocks the deletion task — fix the suite, never adjust the ledger to fit.

### Investigation targets

**Required** (read before coding):
- test/fixtures/pytest-inventory.txt and every translated module's source-comments

### Risks

The gate exists to catch exactly the silent losses that feel fine — parametrize collapses and cluster-summarized translations; the spot-audit is non-negotiable.

## Acceptance

- [ ] Ledger complete and arithmetic exact; zero todos; both suites green; deletion unblocked in writing

## Done summary
Completeness gate passed: all 900 pytest-inventory nodes mapped (870 translated/cited + 30 enumerated drops: 29 python_only + stub_contracts), zero test.todo, dense-file spot-audit clean, both suites green side by side (bun 960 pass under slow gate, pytest 898+2 full + conformance against the production binary). Committed the ledger and task .4's orphaned generated-guard translation; Python deletion unblocked.
## Evidence

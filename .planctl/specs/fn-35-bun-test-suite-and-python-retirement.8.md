## Description

**Size:** M
**Files:** test/audit-verdict-submit.test.ts, test/audit-followup-submit.test.ts, test/audit-submit.test.ts, test/audit-artifacts.test.ts, test/session-markers.test.ts, test/cross-project-deps.test.ts, test/roots-discovery.test.ts (all new)

### Approach

Translate the submits/artifacts/markers/multi-root cluster onto the landed harness: test_verdict_submit (16 inventory nodes), test_followup_submit (14), test_audit_submit (8), test_audit_artifacts (24), test_session_markers (28), test_cross_project_epic_deps (19), test_roots_discovery (15) — 124 nodes total per test/fixtures/pytest-inventory.txt, the arithmetic truth. Same source-comment mapping and translated | cited | drop discipline; audit_artifacts portions already covered by src-audit-spine.test.ts are citations (that file is READ-ONLY); session_markers' in-process helper-spy nodes (IO-error swallowing, no-env no-op) are python_only drops while its CLI-observable marker behavior translates — resolve the exact drop list against the inventory, not the planning estimate; cross_project_epic_deps' 8 python_only nodes drop, the 11 CLI nodes translate via the harness setRoots; roots_discovery rides setRoots the same way. Parametrized cases land as test.each rows preserving node counts. If a translated assertion goes red against the binary, fix src/ as part of this task; out-of-scope fixes block with specifics — never drop a real behavior.

### Investigation targets

**Required** (read before coding):
- The seven pytest source files — the spec, node by node
- test/fixtures/pytest-inventory.txt — the node-count truth per module
- test/harness.ts — setRoots, withProject, seedState, fixedClock
- test/src-audit-spine.test.ts — the citation target (frozen)

### Risks

The session_markers drop boundary (helper-spies vs CLI-observable) is the one judgment seam — enumerate it explicitly in the mapping comments so the gate's spot-audit can verify it.

### Test notes

bun test green fast and with PLANCTL_RUN_SLOW=1; pytest suite untouched and green; per-module sub-totals self-checked against the inventory.

## Acceptance

- [ ] All 124 inventory nodes mapped by source-comment; sub-totals match the inventory file
- [ ] Owned files only; src-audit-spine untouched
- [ ] bun test green (fast + slow); any red translation resolved by fixing src/, recorded in Evidence

## Done summary
Translated the submits/artifacts/markers/multi-root cluster (124 inventory nodes) to bun: audit-submit (8), verdict-submit (16), followup-submit (14), audit-artifacts (24 cited to src-audit-spine), session-markers (28: 20 translated, 6 cited to lib.test, 4 python_only dropped), cross-project-deps (19: 11 translated, 8 python_only dropped), roots-discovery (15: 6 translated, 9 cited). bun test green fast + PLANCTL_RUN_SLOW=1; lint/typecheck clean; uv run pytest untouched and green. No src/ changes needed.
## Evidence

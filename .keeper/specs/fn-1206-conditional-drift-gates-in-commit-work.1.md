## Description

**Size:** M
**Files:** src/commit-work/lint-matrix.ts, test (matrix suite)

### Approach

Add conditional stages to the lint matrix following its existing staged-suffix routing: (1) vendor-corpus drift (the existing repo-root check script) when staged paths touch the vendored corpus or the hack-skill BAKE-guard files; (2) model-guidance drift (the existing plan check script) when staged paths touch the plan model config or subagents matrix; (3) the root import-boundary/depgraph test files when staged paths touch plugins/plan/src — the cross-package ratchet that would have caught the incident's violation at commit time. Each stage fires only on a staged-path match (zero cost otherwise), runs concurrently with its peers like existing stages, and reports through the standard LintFailure aggregation so the lint_failed envelope and recovery contract are unchanged. Resolve paths from the repo toplevel so lane-cwd commits map correctly. Name a sanctioned, visible escape hatch for pathological cases (env-var skip that logs loudly) rather than leaving --no-verify as the only out; keep it out of the default path.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/commit-work/lint-matrix.ts:182 runLintMatrix — the numbered-stage registry; :284 the py-staged→project-wide precedent; :111 nearestPackageJson; :55 LintFailure
- scripts/vendor-corpus.ts:5-13,166-198 — the check being wired (self-contained, sub-second)
- plugins/plan/scripts/model-guidance-check.ts — the sibling check

### Risks

- The depgraph tests spawn bun test — measure the added latency and keep the file set tight (the boundary test files only, not the whole root suite).

### Test notes

Matrix tests with synthetic staged sets: corpus file staged → vendor stage runs; plan config staged → guidance stage; plugins/plan/src staged → boundary stage; unrelated set → none of the three; failing check → LintFailure aggregation intact.

## Acceptance

- [ ] Each drift stage fires exactly on its staged-path trigger set and not otherwise
- [ ] A drifted corpus/config/boundary violation fails the commit through the standard lint_failed envelope
- [ ] Unrelated commits show no measurable added latency
- [ ] The escape hatch is visible-and-logged, never silent
- [ ] keeper fast suite green

## Done summary

## Evidence

## Overview

Two of the incident's trunk breaks (stale oracle goldens, corpus lock drift) passed commit because the sub-second drift gates only run inside test suites, and a third (the import-boundary violation) landed because a plan-package committer never ran the root suite where the cross-package ratchet lives. This epic wires the existing drift checks into commit-work's lint matrix as staged-path-conditional stages, plus a cross-package mapping so plan-source changes run the root boundary tests.

## Quick commands

- `bun test test/commit-work` (or the matrix suite file)
- Post-deploy: staging a plugins/prompt/corpus file and committing runs the vendor-corpus check inline

## Acceptance

- [ ] Staging corpus/BAKE-guard files makes commit-work run the vendor-corpus drift check; staging plan model config runs the model-guidance check; unrelated commits pay zero added latency
- [ ] Staging plugins/plan/src files makes commit-work run the root import-boundary/depgraph tests
- [ ] Failures surface through the existing lint_failed envelope with the standard fix→restage→re-invoke recovery

## Early proof point

Task that proves the approach: `.1`. If the boundary-test run proves too slow for the commit path: scope it to the depgraph test files only (they run in well under a second).

## References

- Incident: 5980558a landed the import-boundary violation from a plan-package context; 1a2ccdbe/51e8774b landed golden+lock drift — all three invisible at commit time
- GTA affected-dependents model: over-aggressive on non-source files, always-run smoke tier, documented escape hatch [practice-scout]

## Docs gaps

- **plugins/plan/CLAUDE.md** (commit behavior + drift-gate lines): consolidate the drift-gate story where line 40 already documents vendor-corpus --check

## Best practices

- **Gate on staged-path match before any hashing** — the zero-cost path for unrelated commits [practice-scout]
- **Escape hatch documented** — large refactors need a sanctioned bypass that is visible, not --no-verify [practice-scout]

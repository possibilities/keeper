## Overview

De-vendor `plugins/plan/`: drop the `git subtree` linkage and its
never-squash/extractable discipline, delete the vendored dependency's own
dev board (`plugins/plan/.planctl/`, ~322 tracked files), and absorb
`plugins/plan/` as ordinary native keeper source IN PLACE (it stays under
`plugins/`; agentwrap still loads it as a plugin). Then remove the now-dead
vendored-prune special-casing. This is Phase 1 of the planctl strip —
mechanically independent: producer-side only, no schema, no re-fold impact.

## Quick commands

- `git -C /Users/mike/code/keeper ls-files plugins/plan/.planctl | wc -l` → `0` after landing
- `rg -n 'isVendoredPlanPath' src/ test/` → no matches after landing
- `rg -n 'git subtree|vendored.*subtree' CLAUDE.md README.md` → no matches after landing
- `bun run test:full` (mandatory — touches plan-worker + git-worker)

## Acceptance

- [ ] Vendored board `plugins/plan/.planctl/` deleted; `plugins/plan/src/` and `cli/plan.ts:22` import untouched
- [ ] Vendored-prune code + globs removed; commit-forwarding (`isPlanctlChangedPath` `.keeper` classification) intact
- [ ] Subtree discipline removed from docs, forward-facing; `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` (the whole de-vendor is one cohesive
task). Likely failure mode: over-scoped `isPlanctlChangedPath` removal that
silently breaks commit-forwarding — recovery is to scope removal to the
`plugins/plan` reject branch only, keeping the function and its `.keeper`
classification.

## References

- `docs/planctl-strip.md` §5 Problem C — the source spec (panel-vetted)
- Subtree-add commit `e6c8f01e` (from upstream `2a508b80`) — the linkage being dropped; deleting files does NOT break past extractability, only squashing/rebasing that merge commit would
- `fn-856` (open) bumps schema v77 and touches `README.md` — no code overlap with this epic; `README.md:380` is a one-line prose co-edit, coordinate at merge

## Docs gaps

- **CLAUDE.md / README.md / src/commit-work/attribution.ts**: forward-facing rewrites handled IN task `.1`
- **docs/planctl-strip.md**: §5/§6/§7/§8/§9 updates to reflect Problem C landing + the panel reframe are owned by the planning session (orchestrator), NOT a worker task — keep workers out of this living artifact

## Best practices

- De-vendoring a subtree needs NO special git command — it's `git rm` + dropping the workflow discipline; the merge-commit `git-subtree-*` trailers stay inert in history [practice-scout / git-subtree.sh]
- Do NOT squash/rebase/filter-repo the original subtree-add merge commit (the real one-way door), and do NOT `git subtree split --rejoin` after deletion (corrupts the split cache) [practice-scout]

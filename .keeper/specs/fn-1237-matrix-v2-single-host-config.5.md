## Description

**Size:** S
**Files:** plugins/plan/subagents.yaml (delete), plugins/plan/src/subagents_config.ts (delete), plugins/plan/test/src-subagents-config.test.ts (delete), src/commit-work/lint-matrix.ts, plugins/plan/scripts/promote.sh, scripts/daemon-load-roots.txt, test/daemon-load-surface.test.ts, test/reconcile-core-depgraph.test.ts (grandfather entries)

### Approach

With every consumer cut over (the three dependency tasks), delete subagents.yaml, subagents_config.ts, and
the module's test, then sweep every point that encodes the file or its embed: the compile-time text-import
is gone with the module; lint-matrix's isModelGuidancePath commit-gate trigger repoints to the surviving
guidance surfaces; promote.sh drops its embed==on-disk drift-guard block; daemon-load-roots.txt drops the
subagents.yaml line and daemon-load-surface's asset-import assertions update; the depgraph test's
grandfather entries for subagents_config (and yaml_input, if now unreachable from the closure) are pruned
only if genuinely dead — the closure pin itself stays. Finish with a repo-wide search proving no code,
script, or test references subagents.yaml or subagents_config (docs are the next task's sweep), and verify
the compiled plan binary builds without the embed.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/commit-work/lint-matrix.ts:124-125 — the hard-coded subagents.yaml trigger path
- plugins/plan/scripts/promote.sh:37-61 — the embed-drift guard block to remove
- scripts/daemon-load-roots.txt:16 and test/daemon-load-surface.test.ts:66-141 — the embed's load-surface encodings
- test/reconcile-core-depgraph.test.ts:73-84 — grandfather entries to audit after the import drop

**Optional** (reference as needed):
- plugins/plan/package.json — the build script whose compile must succeed embed-free

### Risks

- A missed encode-point (the embed is pinned in four separate guards) — the acceptance search is the backstop

### Test notes

`rg -l 'subagents_config|subagents\.yaml' src plugins scripts test --hidden` returns only docs/ hits or
nothing; `bun run build` in plugins/plan succeeds; full test:full green.

## Acceptance

- [ ] No file named subagents.yaml and no module subagents_config.ts exist in the tree
- [ ] A repo-wide search over code, scripts, and tests finds zero references to either (documentation excluded — swept by the docs task)
- [ ] The compiled keeper-plan binary builds successfully without the embed
- [ ] The load-surface, depgraph, promote, and commit-gate guards all pass with the deletion reflected

## Done summary

## Evidence

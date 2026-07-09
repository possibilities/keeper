## Overview

keeperd restarts on every green CI build because the install reload gate fingerprints whole-repo HEAD while keeper main moves ~200 commits/day, the majority of them board checkpoints and docs that never reach the resident daemon process. This epic scopes the bounce to the daemon's actual load surface: clean the import boundary (cli→src and hooks→src inversions), declare it in a checked-in roots manifest, hash it content-addressed in install.sh through one shared seam, enforce it with a fast-tier boundary test, and stop `.keeper/`-only commits from triggering keeper builds at all. End state: keeperd bounces only when daemon-loaded code actually changed (~73% fewer bounce triggers at current commit mix), and a future backwards import edge fails CI instead of silently widening the load surface. Decision record: docs/adr/0029.

## Quick commands

- `bun test test/daemon-load-surface.test.ts` — boundary check (daemon closure ⊆ manifest roots)
- `bun run scripts/daemon-fingerprint.ts` — print the load-surface composite fingerprint
- `cd /Users/mike/code/agentbuilds && bash scripts/checkconfig.sh` — buildbot config gate for the change filter

## Acceptance

- [ ] keeperd reload keys on the load-surface fingerprint: a docs-only or board-checkpoint commit leaves the composite unchanged; a src edit moves it
- [ ] The daemon import closure ⊆ manifest roots invariant is enforced in the fast suite, including worker-spawn and attribute-import edges
- [ ] Commits touching only `.keeper/` produce no keeper build request in buildbot; mixed commits still build
- [ ] CLAUDE.md's sanctioned helper list and docs/install.md reflect the new contracts

## Early proof point

Task that proves the approach: ordinal 1 (cli→src inversion). If it fails: keep the helpers in place and widen the manifest to declare cli/ as a root — the fingerprint still narrows sharply even with the wider boundary.

## References

- docs/adr/0029-daemon-load-surface-fingerprint.md — this epic's decision record (layering + failure directions)
- docs/adr/0008-pure-data-cli-descriptor-modules.md — layering precedent pinned by an import-graph purity test
- test/reconcile-core-depgraph.test.ts — walker template the boundary test extends (closure walk, type-erasure, self-tests)
- /Users/mike/code/agentbuilds/system/buildbot/master.cfg — build/install job wiring (GitPoller ~:756-767, scheduler construction ~:341-370)
- scripts/install.sh:80-144 — the reload gate being re-keyed

## Docs gaps

- **CLAUDE.md**: extend the sanctioned dep-free hook-importable helper list with the two new src modules (task 2 deliverable)
- **docs/install.md**: state the reload-trigger contract — load-surface fingerprint over the roots manifest, not repo HEAD (task 3 deliverable)

## Best practices

- **Declared-input hashing** (Turborepo/Nx/Bazel pattern): hash a declared, sorted input set and include the manifest itself in the hash [practice-scout]
- **Model every real edge class**: type-only imports are non-edges; re-exports, dynamic imports, worker spawns, and `with { type: ... }` attribute imports are real edges — miss one and the boundary claim is hollow
- **Filter at the change-consuming scheduler**: buildbot Dependent schedulers never re-run file filters; `filter_fn` takes no renderables; empty `change.files` needs an explicit let-through policy
- **No shell interpolation of manifest paths** — argv arrays only; the manifest is reviewed config (a trust boundary)

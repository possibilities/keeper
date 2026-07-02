## Description

**Size:** S
**Files:** test/reconcile-core-depgraph.test.ts (new)

### Approach

A transitive import-boundary test, generalizing the repo's single-file grep pattern: starting at src/reconcile-core.ts, resolve and walk the relative-import closure (readFileSync + import-statement parse; strip comments; distinguish and DROP `import type` / `export type` — erased at runtime, legal across the boundary). Assert that no module in the closure value-imports any banned specifier: bun:sqlite, bun:* generally, node:fs, node:os, node:child_process, node:net, node:http, ../src/db, worktree-git, exec-backend — allow node:path (pure). Additionally assert no file in the closure calls Date.now( or new Date( (reconcile takes `now` as data). Keep it a fast-tier test (source-file reads only, no subprocess). Include one self-check: the walker must visit more than one file (guards against a silent resolution bug making the test vacuously pass).

### Investigation targets

**Required** (read before coding):
- test/agent-run-capture-depgraph.test.ts — the existing boundary-test idiom to generalize
- src/reconcile-core.ts — the closure root (post task .1)

### Risks

False positives on `import type` from a module that also has value exports — the parser must classify per-import-statement, not per-source-module. Keep the banned list explicit and commented with why each entry is banned.

### Test notes

Prove the test can fail: temporarily add a `node:os` value import to the core in a scratch branch/working tree and watch it trip, then revert; note the check in Evidence.

## Acceptance

- [ ] Transitive walker covers the full relative-import closure of reconcile-core.ts, import-type-aware
- [ ] Banned value imports and wall-clock calls fail the test; node:path and type-only imports pass
- [ ] Demonstrated to fail on an injected violation
- [ ] Runs in the fast tier

## Done summary
Added test/reconcile-core-depgraph.test.ts — a fast-tier transitive import-boundary walker over reconcile-core.ts's relative-import closure (import-type aware, comment-stripped) that hard-bans impure drivers (bun:sqlite/bun:*, a db gateway, worktree-git, exec-backend, node:child_process/net/http) and wall-clock (Date.now/new Date). node:fs/os module-load reads (KEEPER_ROOT, worktrees fallback, model-effort YAML parse) and readiness.ts's one read-path diagnostic clock are grandfathered as shrink-only ratchet baselines, since the literal node:fs/os hard-ban was infeasible against the move-only .1 core; drivers + wall-clock bans pass cleanly and a new banned edge from any other closure file hard-fails.
## Evidence

## Overview

The autopilot reconciler's re-fold-determinism boundary (pure verdict logic never shells git, never reads wall-clock/env/fs) is held today by comment convention inside a 6,191-line module, and dispatch-failure routing runs on ~37 hand-written string prefixes — the failure class behind the recover/finalize key-collision incidents. This epic makes the boundary structural (a pure module that cannot import the impure drivers, enforced by a transitive import test) and replaces substring routing with one typed, semantics-preserving classifier. Zero behavior change; zero durable-vocabulary change; no migration — dispatch_failures rows already store verb/id/reason/dir as separate columns.

## Quick commands

- `bun test test/autopilot-worker.test.ts` — the 338 pure-seam tests; must pass unchanged (imports untouched via re-exports)
- `bun test` — full fast suite green at every task boundary

## Acceptance

- [ ] Pure verdict core lives in its own module; reconcile/geometry/failure-key logic imports no git driver, no bun:sqlite, no node IO, no wall-clock — enforced by a transitive import-boundary test, not convention
- [ ] All dispatch-failure routing decisions flow through one typed classifier with literal-union kinds and an assertNever exhaustiveness tripwire
- [ ] Old-vs-new routing proven identical over the full catalog of minted reason/id shapes, including the historical recover/finalize collision cases
- [ ] test/autopilot-worker.test.ts import block unchanged; durable reason-string vocabulary unchanged; no SCHEMA_VERSION bump

## Early proof point

Task that proves the approach: `.1` (move-only extraction with the full suite green and test imports untouched). If it fails: fall back to extracting only reconcile, attachWorktreeGeometry, and recoverFailureDispatchId without the helper closure, and re-scope.

## References

- src/dispatch-failure-pill.ts — CLASSIFY_RULES ordered prefix-table: the in-repo template for the classifier (and the second vocabulary table that must not drift — share one source)
- src/collections.ts:604-628 — dispatch_failures columns (verb/id/reason/dir already separate; pk verb + liveKeyColumns [verb,id])
- test/agent-run-capture-depgraph.test.ts — the existing single-file grep boundary pattern the new transitive walker generalizes
- Resolved design decisions: transitive value-import walk (import-type stripped); homedir hoisted via injected worktrees root; classifier is a semantics-PRESERVING router (exact-token vs prefix vs id-prefix each preserved); await-conditions.ts adopts the classifier only if it stays a clean leaf, else its drift-pin test pins against the classifier's constants
- Do NOT touch: laneKeyById parameterization in src/readiness.ts, the GitRunner + WorktreeDriver DI seams, src/worktree-eligibility.ts

## Alternatives

- Enum column for failure kinds in dispatch_failures: rejected — a re-fold-changing migration; the string vocabulary is the durable API, the type lives at the read boundary
- Full recoverWorktrees/finalize/message-pump restructure: rejected for this epic — deferred to the architecture phase; this epic is the minimal cut that de-risks it
- Graph tooling (dependency-cruiser/madge) for the boundary: rejected — a ~50-line transitive walker in a test matches repo convention (no third-party deps) and is enough

## Architecture

Target module layout: src/reconcile-core.ts (pure verdict engine: reconcile, geometry, pure helpers, and the reconcile-side types) and src/dispatch-failure-key.ts (dep-free classifier leaf importable by daemon.ts and await-conditions.ts without dragging the core). autopilot-worker.ts keeps the impure remainder (snapshot loading incl. computeDeferredEpicIds, drivers, recover/finalize, message pump) and re-exports every moved symbol so all existing imports keep working. reducer.ts re-exports the row types that move to the pure side.

## Rollout

Worktree-mode autopilot is live on this machine and this epic edits the reconciler running it. Land .1 (move-only) first and let the full suite plus the promote-time slow tier (upstream epic) gate it. If post-land autopilot misbehaves, `keeper autopilot pause` is the immediate brake; the LaunchAgent restart path plus the previous binary is the rollback.

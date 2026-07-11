## Description

**Size:** M
**Files:** plugins/plan/src/edit_claims.ts, plugins/plan/src/deps.ts, plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/emit.ts, docs/problem-codes.md, plugins/plan/test/saga-scaffold.test.ts

### Approach

Enforce the intra-epic same-write-surface rule mechanically (see CONTEXT.md: Overlap
gate; ADR 0042). Add a comparability predicate to the DAG helpers — A and B are
comparable iff either transitively reaches the other over the validated acyclic
graph (adjacency is not enough: A→B→C sharing a file is already ordered). Add the
pairwise claim-intersection verdict to the claims module: REJECT iff both claims are
expected AND the hit is same-kind exact (equal normalized path, or equal resource
token); every softer intersection — a glob on either side, possible on either side —
is WARN. A glob-vs-path hit is the matcher's verdict; glob-vs-glob warns only on a
deterministic conservative heuristic (identical pattern or one literal prefix
containing the other) — no false REJECTs from globs, ever. resource never intersects
path/glob (distinct namespaces). The gate runs in scaffold after cycle detection
(reachability is meaningless on a cyclic graph — a cycle short-circuits it), over
same-repo pairs only (resolved target_repo; two null-target tasks share the primary
repo). Rejections mint `write_overlap_unordered` listing each unordered pair with its
colliding claim; `--allow-overlap` (all-or-nothing, mirroring --allow-duplicate)
downgrades rejects to warnings; warnings ride the success envelope non-fatally.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/scaffold.ts:511-589 — the priority cascade and cycle detection the gate slots after; the --allow-duplicate flag plumbing to mirror
- plugins/plan/src/deps.ts — detectCycles/findDependents; the reachability closure lands beside them
- plugins/plan/src/emit.ts:244 — the problem-code registry
- plugins/plan/test/saga-scaffold.test.ts — existing dep_invalid/dep_cycle failure-shape tests the gate cases extend

**Optional** (reference as needed):
- docs/problem-codes.md — the Plan family table the new row joins

### Risks

- Over-firing is the failure mode that matters: a false REJECT silently serializes benign parallelism — the matrix errs toward WARN everywhere except expected same-kind exact hits
- Pairwise is O(n²) per epic — fine at epic task counts; do not add premature bucketing

### Test notes

Matrix table test covering every kind×certainty pair verdict; saga cases: unordered
expected path collision rejects naming the pair, adding the dep edge passes,
--allow-overlap warns and commits, transitively-ordered pair passes, possible/glob
variants warn, cycle+overlap yields dep_cycle only.

## Acceptance

- [ ] Two DAG-incomparable same-repo tasks with the same expected path (or resource token) fail scaffold with write_overlap_unordered naming the pair and claim
- [ ] The same input passes when a dep edge orders the pair, and warns-but-commits under --allow-overlap
- [ ] Pairs involving a glob or possible certainty warn without blocking; a transitively ordered chain sharing a path passes silently
- [ ] A cyclic input reports dep_cycle without a spurious overlap verdict
- [ ] docs/problem-codes.md carries the write_overlap_unordered row naming --allow-overlap as recovery in the same change

## Done summary

## Evidence

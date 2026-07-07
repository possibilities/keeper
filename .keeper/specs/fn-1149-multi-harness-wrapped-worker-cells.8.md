## Description

**Size:** M
**Files:** test/slow/wrapped-cell-e2e.test.ts, docs/plugin-composition-map.md, plugins/plan/README.md, README.md

### Approach

Prove the whole pipe against a fixture roster, then consolidate the docs. A slow-tier
test (gated on KEEPER_RUN_SLOW, skipping cleanly when the harness binary is absent):
sandboxed config dir with a fixture matrix → render the matrix → resolveWorkerCell picks
the wrapped cell → providers resolve orders candidates → one real detached keeper agent
run from a real temporary git worktree → chunked wait → envelope captured, and the
foreign edits land inside that worktree (the cwd-anchoring probe this design leans on).
The fast suite must never spawn the subprocess path. Include a short operator checklist
in the epic Done summary trail for the first real wrapped task on this host (author
matrix.yaml, add guidance block if a new model, re-render, watch the first dispatch).
Docs per the gap scan, consolidating rather than appending: plugin-composition-map's
cell-rendering and launch-path sections describe matrix-driven wrapped cells; the plan
README's worker-matrix narrative covers wrapped cells, auto-presets, and the selector
entry; the root README's keeper agent section gains matrix.yaml and the providers verbs.
All prose forward-facing — no staleness narration, no claude-only or single-source claims
left behind.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/plugin-composition-map.md — the claims being revised
- plugins/plan/README.md — worker-matrix narrative and model-selector entry
- scripts/test-gate.ts and an existing KEEPER_RUN_SLOW test — the slow-tier gating convention

**Optional** (reference as needed):
- README.md keeper agent section
- plugins/prompt/src/check_generated.ts — sidecar expectations the rendered fixture tree must satisfy

### Risks

- The e2e depends on a harness binary being installed; the skip path must be explicit and
  loud in its skip reason so a green run without the binary is not mistaken for coverage.

### Test notes

Slow tier only; assert the envelope outcome, the worktree-anchored diff, and leg cleanup
(no orphan process, pidfile reaped).

## Acceptance

- [ ] A slow-tier e2e proves render → resolve → detached run → chunked wait → envelope
      against a fixture roster from a real worktree, and skips cleanly with a loud reason
      when the harness binary is absent.
- [ ] The three docs read as current behavior with wrapped cells and the matrix config
      described, no stale claude-only or single-source claims, and every docs lint gate green.

## Done summary

## Evidence

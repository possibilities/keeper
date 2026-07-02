## Overview

The map the next phase reads must match shipped reality. The CLAUDE.md autopilot section still assigns merge-gate stuck-state ownership to "the parked observability plan" although the visibility half (lane_merged / keeper await landed) has shipped; a bounded set of source comments carries fn-id provenance that violates the repo's forward-facing-only rule; and the README front door says nothing about worktree mode. Bounded by design: no full fn-id sweep, no historical-spec rewrites.

## Quick commands

- `bun scripts/lint-claude-md.ts` — must stay green (CLAUDE.md is at 117/120 lines; reword must be net-neutral and byte-cap aware)
- `grep -nE '\bfn-[0-9]+' src/readiness.ts src/board-render.ts` — must return nothing when done

## Acceptance

- [ ] CLAUDE.md autopilot section states current merge-gate stuck-state behavior (visibility shipped; detection/remediation an explicit tracked deferral) with no net line growth and lint green
- [ ] README carries a short worktree-mode pointer within its front-door budget
- [ ] fn-id provenance comments purged from the scoped file set, load-bearing WHY preserved as present-tense statements
- [ ] src/autopilot-worker.ts, test files, and historical .keeper/specs explicitly untouched

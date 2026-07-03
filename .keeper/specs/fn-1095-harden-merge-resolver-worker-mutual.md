## Overview

The merge-resolver worker uses the GLOBAL `keeper autopilot pause` as its
mutual-exclusion mechanism against the recover sweep: its brief pauses the
board at step 0 and plays at the terminal step. This robustness follow-up
scopes that exclusion so a rare-but-real resolver crash or concurrent fan-in
cannot durably strand or race the whole board's automation. It matters
because the blast radius is disproportionate — a single autonomous worker
can silently halt autopilot for every unrelated epic until a human notices.

## Acceptance

- [ ] A resolver that dies/reaps after pausing but before its terminal play cannot leave autopilot durably paused for unrelated epics.
- [ ] Concurrent stuck merge-conflict fan-ins cannot let one resolver's `play` re-arm the recover sweep while another resolver is mid-merge.
- [ ] The human escalation (merge-escalation notify) and close audit paths remain unchanged.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Confirmed src/daemon.ts:6432 (pause gate read once per tick) + buildResolverBrief pause step 0 (line 1326) / terminal play (line 1345): global pause is the resolver mutex, so concurrent fan-ins race on play and a crash after pause durably halts all autopilot. |
| F2 | culled | — | Cosmetic test-quality nit: resolver-conflict-harness.ts:420-426 declCount check is self-fulfilling over a hand-built literal in a manual-tier illustration, not a regression gate. |
| F3 | culled | — | Low-priority test-coverage gap; dispatchResolver cwd derivation (src/daemon.ts:6397-6400) is covered transitively by the harness and unit-tested at the brief layer. |

## Out of scope

- The manual-tier harness `declCount` illustration (F2) — cosmetic, no regression-gate value.
- A dedicated unit test for the `dispatchResolver` cwd derivation (F3) — already covered transitively.

## Overview

Readiness renders `running:sub-agent-stale` for wrapped workers whose owned
Provider leg is actively progressing, because the staleness rule reads only
the frozen wrapper-side invocation timestamp. This epic makes positive
owned-leg activity outrank age-only staleness with a distinct
`provider-leg-active` running reason (ADR 0087), keeping the conservative
no-evidence stale path byte-identical. End state: the warn pill means "no
positive evidence anywhere", and healthy delegated execution reads as
active on task and close rows alike.

## Quick commands

- `bun test ./test/readiness.test.ts ./test/readiness-client.test.ts ./test/board.test.ts`
- `bun run typecheck`
- Operator post-deploy: with a wrapped cell mid-delegation, `keeper status --json | jq '[.data.board.epics[].tasks[].pill]'` shows `[running:provider-leg-active]` instead of `[running:sub-agent-stale]` while the leg is active.

## Acceptance

- [ ] Active wrapped delegation (fresh owned live leg) never renders sub-agent-stale on task or close rows.
- [ ] No-positive-evidence rows keep the conservative stale rendering and mutex occupancy unchanged.
- [ ] Reconciler and board consume one shared leg-activity map builder; empty input is byte-inert for replay/simulator equivalence.

## Early proof point

Task that proves the approach: ordinal 1 (its red-repro fixture). If the
new-reason blast radius surprises: fall back to feeding leg evidence into
the existing staleness helper so the row renders sub-agent-running with no
new kind — same precedence, minimal taxonomy change.

## References

- docs/adr/0087-provider-leg-activity-precedence.md — the recorded decision (precedence, distinct reason, shared window)
- docs/adr/0083-status-stale-running-taxonomy.md — tally structure the new reason slots into (fresh running, never stale_running)
- docs/adr/0056, 0069, 0071 — wrapped leg lifecycle, death notices, durable ownership
- Live reproductions (wrapper yielded, invocation frozen, leg active): captures logged in ~/docs/keeper-review-remediation.md

## Docs gaps

- **CONTEXT.md**: add the provider-leg-active glossary line when the reason ships (task deliverable)

## Best practices

- **Positive evidence outranks age; absence falls through to the conservative rule** — never "newest timestamp wins" across evidence sources [failure-detector literature]
- **Distinct state per signal** — a truthful reason beats a reused healthy label [SWIM / phi-accrual detectors]
- **Self-expiring evidence** — judge the advancing timestamp against the same window rather than adding a second ceiling [watermark vs TTL]

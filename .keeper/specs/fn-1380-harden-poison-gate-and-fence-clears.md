## Overview

One poison dead-letter row must never again cost a host-wide commit
outage, and a dispatch clear must never release a live worker's claim.
Three host-wide outages in one day traced to these two gaps; ADR 0099
records the decisions (amending ADR 0070 and ADR 0063/0068). End state:
poison rows carry a visible, scoped, operator-resolvable lifecycle, the
stuck-birth GC stops feeding the blocking class, and the operator clear
path refuses to release live claims absent an audited, identity-fenced
force.

## Quick commands

- sqlite3 -readonly ~/.local/state/keeper/keeper.db "select status, count(*) from dead_letters group by status;"
- keeper status --json | jq .data.needs_human
- keeper autopilot retry 'work::<key>'  # against a live bound attempt must refuse with the typed outcome

## Acceptance

- [ ] A poison row whose evidence names a session/worktree blocks only that scope; unscopable rows still block globally and surface loudly
- [ ] The needs-human surface shows poison rows distinctly (count + blocking scope), never zero while the commit rail is blocked
- [ ] An operator clear naming a live bound attempt refuses with a typed outcome; --force overrides the liveness refusal only, never the identity match
- [ ] Classifiable stuck births never mint the globally-blocking poison status
- [ ] Poison rows are operator-resolvable (audited) and re-classifiable through the current parser, with retention pruning every terminal status

## Early proof point

Task that proves the approach: ordinal 1 (the clear-refusal fence). If the
process-identity liveness probe proves unreliable at the clear site, fall
back to refusing on any state!='released' bound claim (reaper-lag
tolerated) while keeping the identity CAS unchanged.

## References

- docs/adr/0099-poison-lifecycle-and-live-clear-refusal.md (the decision record; amends 0070 and 0063/0068)
- docs/adr/0070-attempt-and-incident-fenced-dispatch-clears.md, 0063/0068 (the amended decisions)
- docs/adr/0072 (owner-fenced cancel + --force precedent; decideAwaitCancel is the reusable shape)
- ~/docs/keeper-phase2-backlog.md #65 + #5 (full evidence trail, four outage post-mortems)
- Overlap (report-only, no dep wired): the armed escalation arc fn-1350/1351/1352 shares the daemon.ts dispatch-clear band, the db.ts schema tail, and the needs-human render surface; this epic lands first or concurrent, and fn-1352.2 rebases its latch-collapse onto the fenced clear path
- Sibling backlog: #75 (grant-timeout tune + dead-at-gate birth retirement) couples to the producer items here — check overlap at its scaffold

## Docs gaps

- **docs/problem-codes.md**: add the poison/dead-letter needs-human row (code | meaning | recovery | retry-safe) near Operator paging; REVISE the stale_attempts/stale-pending recovery text — with the fence the clear self-refuses, so TERM-confirm-dead stops being a manual precondition
- **CLAUDE.md**: the RPC-surface guardrail line changes ONLY if the resolve verb lands as a new RPC rather than extending replay_dead_letter — the implementing task settles it and updates the line in the same change

## Best practices

- **Fence at the resource, atomically:** the clear's identity check is a CAS at the write site inside one BEGIN IMMEDIATE; a liveness probe is a fast-path refusal, never the load-bearing guarantee (TOCTOU) [Kleppmann; Kafka producer-epoch]
- **Force is break-glass:** overrides the liveness refusal only, never the identity match, and is loudly audited (operator identity, target, reason)
- **Refuse on uncertainty:** deny-by-default when process identity is ambiguous — over-refusing a reused pid is the safe direction
- **Replay is rate-bounded and root-cause-first:** mass redrive before the producer fix re-poisons [SQS redrive velocity]
- **Scope from trusted producer state:** attacker-influenced record fields must never widen their own blast radius

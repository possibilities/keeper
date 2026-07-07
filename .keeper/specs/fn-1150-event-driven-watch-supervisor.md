## Overview

The six needs-human signals (dead letters, block escalations, parked questions, stuck dispatches, finalize-non-ff, instant-death wall) become first-class push events: crisp `keeper watch` NDJSON deltas, per-signal + umbrella `keeper await` conditions, and a rewritten `keeper:watch` skill that arms persistent Monitors once and hands back token-free instead of polling via /loop. The keystone is ADR 0011's gated `dispatch_failures` fold onto the shared ReadinessClientSnapshot — one socket, one row-set, one shared projector so status/watch/await can never drift on what "stuck" means. Alarm surfaces fire on the operator-jam class only; status keeps its broad sticky count.

## Quick commands

- `bun test test/needs-human.test.ts test/readiness-client.test.ts test/status.test.ts test/watch.test.ts test/await-conditions.test.ts` — the projector/fold/delta/condition gate
- `keeper status --json | jq .data.needs_human` — envelope parity check (schema v5, byte-identical output)
- `keeper watch --json --filter dead-letter` — live smoke of a new delta type
- `keeper await needs-human --timeout 5s --json` — umbrella condition arms and times out clean on a quiet board
- `bun test test/lint-skill-ids.test.ts test/lint-retired-name.test.ts` — the skill-rewrite lint gates

## Acceptance

- [ ] All six needs-human families emit filterable additive watch deltas and are awaitable per-signal plus umbrella `needs-human`
- [ ] Non-opt-in readiness consumers' first paint is byte-identical (subscribe-collection count unchanged when the flag is off)
- [ ] status, watch, and await derive needs-human math from one shared pure projector; alarm surfaces fire on the operator-jam class only
- [ ] The keeper:watch skill arms Monitors and hands back; the watchdog script verifies watcher liveness and emits only on debounced anomaly
- [ ] Full test suite green including the skill lint gates

## Early proof point

Task that proves the approach: `.2` (the gated fold with its byte-identity off-path test). If it fails: fall back to per-surface collection subscriptions (ADR 0011's rejected alternative) without touching the snapshot — deltas and conditions survive on that shape at the cost of extra sockets.

## References

- `docs/adr/0011-gated-dispatch-failures-snapshot-fold.md` — the settled keystone decision (gated fold, limit 0, jam-class alarm semantics)
- `CONTEXT.md` — needs-human, operator jam, parked question, instant-death wall glossary entries; "watch" as a noun stays bound to the Agent Bus channel
- `src/readiness-client.ts:1671` — the includeRecentDoneEpics gated-fold recipe the keystone mirrors
- epic-scout: no open-epic dependencies or overlaps (fn-1146, fn-1148 disjoint)

## Docs gaps

- **plugins/keeper/skills/await/SKILL.md**: condition-derivation table, pre-check-exempt list, and armed/met event-shape enumeration gain the new tokens (task .6)
- **plugins/keeper/skills/autopilot/SKILL.md**: 3-of-6 needs_human parenthetical aligned to the six-signal set (task .6)
- **plugins/keeper/skills/query/SKILL.md**: verify collection-allowlist prose — the raw `dispatch_failures` query verb survives, likely no change (task .6)
- **orient snippet template**: needs_human enumeration already stale (missing parked_questions, instant_death_wall); bring to six and regenerate the baked index, never hand-edit (task .6)

## Best practices

- **Additive-only NDJSON evolution:** new delta types are new top-level types old consumers no-op-skip; never route new data through an existing type's shape [Conduktor/Solace schema-evolution]
- **Baseline captured once:** an edge condition's baseline must never re-anchor on a reconnect re-paint — re-anchoring silently swallows signals that landed mid-disconnect [Companies House streaming]
- **Anomaly-only emitters need a distinct liveness proof:** silence is indistinguishable from death; the harness Monitor exit-notification is the liveness channel, and anomalies debounce at 2 consecutive misses [watchdog design lore]
- **Level-triggered presence semantics:** reconnect-safe because state is re-observable on any re-paint; edges are reserved for "a NEW one appeared" via the signature anchor [Prometheus alerting lore]

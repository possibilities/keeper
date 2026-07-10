## Overview

`keeper await` fails the agents that arm it: bare `drained` requires the
whole board at rest (every tracked session counts, so it is unreachable on
any host with a live session), waits are silent for hours, there is no
one-shot "would this fire now and why not" probe, and terminal lines carry
no diagnosis. This epic flips bare `drained` to plan scope (keeper-
dispatched work only, caller self-excluded), adds `--scope inflight|board`
for the other two meanings, surfaces periodic holder-naming heartbeats and
a last-waiting-detail terminal envelope, adds a probe mode with a
branchable additive exit code, measures-then-fixes the reconnect loop's
CPU cost, and rewrites the await skill's steering so the next agent picks
the right condition. Decision record: docs/adr/0032.

## Quick commands

- keeper await drained --probe (evaluates now, names holders, exits)
- bun test test/await-conditions.test.ts test/await.test.ts

## Acceptance

- [ ] Bare `drained` fires on a board with no open plan work while
  adopted/external sessions are live; `--scope board` preserves the prior
  strict gate; `--scope inflight` waits only on in-flight dispatched work
- [ ] A long wait emits periodic heartbeats naming the holders, and a
  timeout/failure terminal carries the last waiting detail
- [ ] A probe invocation evaluates once, explains, and exits with the
  documented additive code when the condition does not hold
- [ ] The reconnect loop's CPU cost is measured, the dominant cost is
  addressed, and the soak gate asserts CPU alongside RSS
- [ ] The await skill carries a when-to-use table covering the scope axis
  and the stdout terminal contract is byte-stable for existing listeners

## Early proof point

Task that proves the approach: ordinal 1 (the scoped predicate + default
flip with the incident reproduced as a fixture — external sessions live,
board empty, plan scope fires where board scope waits). If it fails: the
provenance discriminator is wrong — re-derive from the jobs projection
fields against the incident fixture.

## References

- docs/adr/0032-drained-scope-axis-and-agent-legible-await.md
- Incident: two `keeper await drained` watchers waited hours on an empty
  board while adopted/external sessions held runningJobCount>0; one burned
  ~15 CPU-minutes in ~3h across daemon bounces (reconnect-forever worked;
  the cost is unmeasured)
- plugins/keeper/skills/watch/SKILL.md wedge alarm — the single strict
  consumer, moves to `--scope board` atomically with the flip

## Docs gaps

- **plugins/keeper/skills/await/SKILL.md**: revise-and-consolidate — scope
  axis on the drained row, when-to-use table, heartbeat/probe/terminal
  grammar, stale only-server-up-reconnects prose
- **CONTEXT.md**: dual-scope drained + board-work-session vocabulary
  (avoid "unmanaged" — banned by the Adopted job entry)
- **plugins/prompt corpus landed-vs-complete snippet**: note where
  plan-scope drained fits vs complete/landed — only via the sanctioned
  re-vendor flow, skip if the canonical source is unreachable

## Best practices

- **Probe exit modeled on systemctl is-active**: 0 = holds, additive
  non-zero = evaluated-clean-does-not-hold; never reuse 1, avoid 124 (GNU
  timeout collision — agents wrap awaits in timeout(1))
- **Streams split by role**: machine terminals on stdout, heartbeats on
  stderr as complete flushed lines (no \r, no ANSI); holder names are
  attacker-influenced — serialize and size-bound
- **Global timeout budget, never per-clause** (kubectl per-resource
  footgun)
- **Adaptive level-triggered waiting**: measure before tuning; coalesce
  one eval + at most one heartbeat per wake

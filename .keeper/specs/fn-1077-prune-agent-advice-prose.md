## Overview

The skills and worker template are calibrated for weaker models: every skill closes with
What-NOT-to-do + Guardrails bookends restating the body, key warnings repeat three to five
times, and the worker template's Rules block verbatim-restates its own phases — a per-turn token
tax on ~300-turn workers. This epic deletes the prose that machine contracts now cover
(enforce-then-delete: it depends on the single-sourcing, envelope, and telemetry epics landing
first). The method is the no-op test applied sentence by sentence: does this line change
behavior for a frontier model against the default? Delete restatement; keep every invariant,
contract table, envelope shape, failure taxonomy, and routing discriminator — density is earned
for unattended workers, so this prunes REDUNDANCY, never capability.

## Quick commands

- `wc -l plugins/keeper/skills/await/SKILL.md` — ~250 or less (from 421)
- `grep -c "What NOT to do" plugins/*/skills/*/SKILL.md` — bookends collapsed

## Acceptance

- [ ] Worker template carries no Rules recap of its own phases; the four cells re-rendered
- [ ] No skill states the same warning more than once; bookend sections carry only non-duplicated items
- [ ] await/dispatch pre-checks read the status/query projections, never keeper plan show hand-parsing
- [ ] Scout/auditor design-system guidance fires only when the target repo has a design system
- [ ] Sacred contracts verbatim-intact (see References)

## Early proof point

Task that proves the approach: `.1` (worker template prune) — the highest per-turn payoff and
the cleanest before/after measurement.

## References

- Sacred (never prune): bus authoritative-directive doctrine + anti-spoof + claim-before-edit; dispatch race-guard surface-and-ask; await failure taxonomy + envelope shapes + exit codes; autopilot capture-then-restore contract; pair billing + chunked-wait + BACKSTOP; handoff 64KB/slug/exit taxonomy + request-not-order; worker heredoc-truncation ban + Edit/Write self-check + trust-git + BLOCKED: escalation + two-suite cap; panel independence-then-synthesis; prompt-injection fencing
- Duplication inventory: await warnings x3 at :202-207/:212/:397-398 and :113-120/:361-364/:412-415 and :62/:282-283/:338-355/:405-411; autopilot capture/restore x5, --watch x3; hack panel routing x3, commit rule x3, quiet-wrapup x2; worker Rules :217-231 vs phases; escape-hatch para worker:149 = hack:263 = corpus snippet

## Docs gaps

- **plugins/plan/skills/plan/SKILL.md**: its own orientation reads move status-first alongside the pre-check repointing

## Description

**Size:** S
**Files:** plugins/keeper/skills/bus/SKILL.md, plugins/plan/template/skills/work.md.tmpl

### Approach

Close the prompt-level hole that amplified the misattribution: an agent whose
directed reply hit an offline target fell back to `keeper bus chat broadcast`,
spraying the whole fleet. In `plugins/keeper/skills/bus/SKILL.md`, (a) revise the
anti-spoof claim (~:140) so it states sender identity is `(pid, start_time)`-keyed,
not pid-only; (b) add an explicit prohibition near the send/offline semantics
(~:25-36, :117): a directed send returning `not_connected` / `unknown_target` MUST
NOT be retried via `broadcast` — broadcast reaches every connected agent, not the
intended target, and is not a delivery fallback; instead surface the miss, re-target
the correct agent, or leave it to `queued_for_wake`. In
`plugins/plan/template/skills/work.md.tmpl` (~:187, the `not_connected` arm of the
bus-escalation branch), add the same MUST-NOT-broadcast rule. Forward-facing prose
only (no change history); match the existing bold-imperative DON'T style.

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/bus/SKILL.md:117 — the broadcast section; :140 — the anti-spoof claim; :25 — offline/`not_connected` semantics
- plugins/plan/template/skills/work.md.tmpl:177 — the bus-escalation branch; the `not_connected` arm (~:187) where the prohibition slots in

### Risks

- The work skill is template-generated — edit the `.tmpl` source, not a rendered copy, so the rule survives regeneration.

## Acceptance

- [ ] bus `SKILL.md` explicitly forbids `broadcast` as a fallback for a missed/offline directed send (bold MUST NOT) and states the intended handling (surface / re-target / `queued_for_wake`).
- [ ] bus `SKILL.md` anti-spoof wording describes `(pid, start_time)`-keyed identity, not pid-only.
- [ ] `work.md.tmpl` `not_connected` arm forbids a broadcast retry.
- [ ] All edits are forward-facing prose (no change-history narration).

## Done summary
Forbade broadcast as a fallback for a missed/offline directed send in bus SKILL.md and the work.md.tmpl not_connected arm, and revised the anti-spoof wording to describe (pid, start_time)-keyed sender identity.
## Evidence

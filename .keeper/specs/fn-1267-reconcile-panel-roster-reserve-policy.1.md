## Description

Findings F1 (kept) and F3 (merged) — same root cause. The
`/plan:panel-guidance` skill at `plugins/plan/skills/panel-guidance/SKILL.md`
states a "closed and non-negotiable" reserve policy (lines 56-57: "Reserve the
premium GPT flagship `gpt-5.6-sol` for exactly one high-effort slot in the
ceiling (`max`) panel. Do not scatter it through strong rungs…"; line 71:
"Keep the premium flagship in its reserved ceiling slot…"). The committed
roster it owns, `plugins/plan/panel-selector.yaml`, contradicts this by using
`codex::gpt-5.6-sol` in `deep-duo` (strength `strong`, line 123; its
description at line 125 reads "opus and the top GPT tier") and `triad`
(strength `strong`, line 137), in addition to `apex` (`max`, line 152).

Reconcile the contradiction in ONE direction, then enforce it (this is the
F3 half — today neither `plugins/plan/scripts/panel-guidance-check.ts` nor
`plugins/plan/test/consistency-panel-selector.test.ts` asserts the policy):

- Recommended default: the roster was human-approved and committed verbatim
  (source epic task .2), so treat it as the source of truth and correct the
  skill's reserve-policy prose (SKILL.md lines 56-57 and 71) to describe the
  actual `gpt-5.6-sol` placement across the strong-and-max rungs.
- Alternative, only if the reserve policy is judged genuinely load-bearing:
  instead correct the roster (keep `gpt-5.6-sol` in `apex` only, re-word the
  `deep-duo`/`triad` members and descriptions) and add a gate assertion.

Either way, add an enforcement check so the two artifacts cannot silently
diverge again — extend `panel-guidance-check.ts` and/or
`consistency-panel-selector.test.ts` to pin the reconciled policy.

Files: `plugins/plan/skills/panel-guidance/SKILL.md`,
`plugins/plan/panel-selector.yaml`,
`plugins/plan/scripts/panel-guidance-check.ts`,
`plugins/plan/test/consistency-panel-selector.test.ts`.

## Acceptance

- [ ] Skill reserve-policy prose and the committed roster agree on `gpt-5.6-sol` placement.
- [ ] A gate check and/or consistency test fails if the two diverge again.
- [ ] Plan suite green (`bun test` in `plugins/plan`), and the panel gate exits 0 (`bun plugins/plan/scripts/panel-guidance-check.ts --check`).

## Done summary
Reconciled the panel-guidance skill's reserve-policy prose with the committed roster: gpt-5.6-sol is now described as reserved for the strong-and-max rungs (matching its actual deep-duo/triad/apex placement), and a new consistency test pins that placement so the two artifacts cannot silently diverge again.
## Evidence

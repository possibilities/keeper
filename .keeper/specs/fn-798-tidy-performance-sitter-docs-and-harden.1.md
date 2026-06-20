## Description

Resolves audit finding F2 (and merged F3). F2: agents/performance.md
lines 207-209 claim `latest.md` mirrors "the LEAD (highest-severity)
finding", but the code does not do this — watch.ts:2402 loops
`writeFollowup` once per `selectNew` result, and `selectNew`
(watch.ts:2177) is a plain filter that preserves gated order with no
severity sort, so `latest.md` ends mirroring the LAST-written finding.
Lines 53-54 and 69 of the same doc already say "most-recent written
followup", so the doc contradicts itself. Either soften lines 207-209 to
match (most-recently-written) or sort `selected` by severity in watch.ts
before the write loop so the doc becomes true — pick one and make doc and
code agree.

Merged F3: the rewritten README.md and agents/performance.md carry dated
human-decision provenance stamps ("The human decision (2026-06-11): …",
"No notification path, no watchdog (human, 2026-06-11)", the recurring
"2026-06-10 false-critical" anecdote) that violate keeper/CLAUDE.md's
"Forward-facing advice only … not change history (which lives in the
diff)" rule. Both F2 and F3 touch agents/performance.md and are
doc-accuracy fixes — land them as one commit.

## Acceptance

- [ ] The `latest.md` description is consistent across the whole doc and matches actual code behavior.
- [ ] If code is changed instead of the doc, `selected` is severity-ordered before the write loop and tests still pass.
- [ ] Dated change-history/provenance stamps are pruned from README.md and agents/performance.md to current-contract phrasing.

## Done summary
Softened agents/performance.md latest.md description to LAST-written (gated order, no severity sort) to match writeFollowup and lines 53/69, and pruned the dated human-decision and false-critical provenance stamps from README.md and agents/performance.md per the forward-facing-advice rule.
## Evidence

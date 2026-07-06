## Description

Finding F2 (auditor `Should fix`, `PROVENANCE_COMMENT`). Evidence path:
`src/autopilot-worker.ts:1047`, the doc comment on
`SHARED_CHECKOUT_DIRTY_GRACE_SEC`, embeds the past-tense clause
"(the incident where one stray file dirt-skipped four epics' finalizes
invisibly)". CLAUDE.md rule #0 forbids past-tense provenance in code
comments — its home is `docs/adr/` and commit messages.

Delete the parenthetical incident clause from the comment, keeping the
forward-facing rationale intact (the ~5min watermark tradeoff:
transient in-flight commit-work settles inside the window; persistent
operator dirt surfaces fast). If the incident rationale is not already
captured in `docs/adr/` or the shipping commit message, record it there.

Files: `src/autopilot-worker.ts`.

## Acceptance

- [ ] The `SHARED_CHECKOUT_DIRTY_GRACE_SEC` comment contains no past-tense incident provenance
- [ ] The forward-facing watermark-tradeoff rationale is preserved
- [ ] `bun scripts/lint-claude-md.ts` (and the fast suite) stay green

## Done summary

## Evidence

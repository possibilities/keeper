## Description

F1 (Should Fix): the `## Autopilot` guardrail at CLAUDE.md:116 reads
"finalize instead DEGRADES a dirty/off-branch/non-ff shared-checkout into a
`retry` skip that mints no sticky row at all", but src/autopilot-worker.ts:2634-2646
`case "non-ff":` now returns `{ ok: false, reason: "worktree-finalize-non-fast-forward..." }`
with no `retry: true` — a VISIBLE sticky DispatchFailed (outside the
`worktree-recover*` auto-clear prefix). Update the guardrail so non-ff is
described as a visible `worktree-finalize-non-fast-forward` sticky needing an
operator, while dirty/off-branch and the new lock/local timeouts stay
non-sticky `retry` skips. Docs-only; do not touch the code path.

## Acceptance

- [ ] CLAUDE.md no longer lists non-ff among the non-sticky retry skips
- [ ] CLAUDE.md states a genuine origin-ahead non-ff mints a visible worktree-finalize-non-fast-forward sticky outside the worktree-recover* auto-clear prefix
- [ ] dirty/off-branch + lock/local timeouts remain documented as non-sticky retry skips
- [ ] `bun scripts/lint-claude-md.ts` stays green

## Done summary

## Evidence

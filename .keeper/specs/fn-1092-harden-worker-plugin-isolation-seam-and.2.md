## Description

Finding F3 (evidence path: `src/agent/main.ts:2213`,
`test/plugin-composition-map.test.ts:171`,
`plugins/prompt/test/vendored-corpus.test.ts:11-13` and `:171-173`). Several
new comments carry past-tense provenance that CLAUDE.md rule #0 bans in
comments/docs: "task .1 made that", "task .1's keeper-owned posture", and
"dissolution study §4 row 12, 'drop'". These cite task ordinals and a study
row to justify a decision rather than stating current behavior, and are
unresolvable to a future reader. Rewrite each to state the current invariant
forward-facing (e.g. "keyed on `--dangerously-skip-permissions`, keeper's
human-less worker posture"; "the arthack prompt-reminder bundle is
deliberately upstream-only and must never be cited keeper-side"), preserving
the genuine non-obvious invariant each comment carries while dropping the
task/study back-references.

## Acceptance

- [ ] No comment in the cited files references a task ordinal, fn-id, or study-row citation; each states current behavior forward-facing.
- [ ] The load-bearing invariants (worker-ness keyed on the flag; arthack bundle stays upstream-only) remain stated.

## Done summary

## Evidence

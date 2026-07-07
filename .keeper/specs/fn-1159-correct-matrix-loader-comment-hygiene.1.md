## Description

Two comment-hygiene fixes surfaced by the fn-1158 audit, bundled because they
share the same two files and land as one commit.

F1 — `plugins/plan/test/src-subagents-config.test.ts` lines 155-158: the
cross-island parity `describe` comment reads "They drifted once on the
present-but-unreadable path (F1) — this pins them together...". Drop the
past-tense provenance clause and the `(F1)` audit-id; keep the forward-facing
half ("two hand-written parsers of the same matrix.yaml shape; this pins them
so drift is caught mechanically"). CLAUDE.md rule #0 bans past-tense
provenance and finding-ids in code comments.

F2 — `plugins/plan/src/subagents_config.ts` lines 217-222: `loadHostMatrix`'s
doc-comment says it returns null "when absent/not-a-file" and that a present
file that fails to parse "throws", but the body at lines 243-245 returns null
on an empty/whitespace-only present file (`parsed === null → return null`).
Restore an "empty/whitespace" mention to the null-return clause so the
doc-comment matches the three-way branch (absent/not-a-file → null;
empty/whitespace → null; unreadable or malformed-shape → throw).

Files:
- plugins/plan/src/subagents_config.ts
- plugins/plan/test/src-subagents-config.test.ts

## Acceptance

- [ ] Parity-test comment has no past-tense provenance and no `(F1)` id, only forward-facing advice.
- [ ] loadHostMatrix doc-comment names the empty/whitespace present-file → null branch alongside absent/not-a-file → null and the throw case.
- [ ] No behavior change; existing subagents-config tests still pass.

## Done summary

## Evidence

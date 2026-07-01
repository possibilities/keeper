## Description

Reword the provenance comments that survived the pair-CLI retirement and
still name deleted surfaces. Findings F1 (kept) and F2 (merged-into-F1)
share one root cause and one file-touch sweep:

- `src/agent/launch-handle.ts:2-3, 9, 77` (F1) — JSDoc frames the seam as
  backing "both `agent run` (posture-free) and `pair send` (posture-full)",
  "Both callers", and "the two callers ... `pair send` fills the full
  posture". `pair send` is deleted; restate as the current single-caller
  (`agent run` + panel legs) shape.
- `test/agent-launch-handle.test.ts:3` (F1) — same two-caller framing in the
  test's header comment; keep it consistent with the reworded JSDoc.
- `src/agent/main.ts:923-928` (F2) — "mirroring pair's `assemblePrompt` block
  order" and "so pair never double-prepends" name the deleted `assemblePrompt`
  helper and `pair` verb; restate the caller-side compose order without them.
- `src/pair/panel.ts:257, 260` (F2) — "replaces `pair send`'s bespoke drive
  loop" and "codex-only (mirrors `pair send`)" name the deleted verb; restate
  as current behavior.

Comment-only rewording — no behavior change to the launch/panel seam.

## Acceptance

- [ ] Grep of the tree for `pair send` and `assemblePrompt` in comments returns
      nothing outside the retired-name guard's own fixtures.
- [ ] Reworded comments state current single-caller / current behavior, no
      past-tense provenance (rule #0).
- [ ] typecheck + lint + full suite green, retired-name guard still passes.

## Done summary

## Evidence

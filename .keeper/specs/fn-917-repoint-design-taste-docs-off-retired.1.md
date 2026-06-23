## Description

Two arthack docs still reference the retired `pairctl` CLI (sources F1, F2 —
same docs-drift root cause, bundled as one commit since both edit arthack
doc files):

- F1: `apps/tastectl/tastectl/prompts/improve-taste.md` — Step 2 (lines
  366, 379-380, 384) tells the agent to run `pairctl send-message
  ... --output-file` and `pairctl list-models`, and the Tools Reference
  table (line 435) lists `pairctl send-message`. An agent running the
  design-taste synthesis flow hits command-not-found. Repoint at the keeper
  replacement (`keeper pair send`) or drop the pairctl-specific section,
  preserving the surrounding synthesis guidance.
- F2 (merged into F1): `scripts/CLAUDE.md:3` lists "pairctl prompts" as an
  `install.sh` step; the package is gone, so drop that clause.

## Acceptance

- [ ] improve-taste.md no longer references `pairctl` (send-message,
  list-models, or the Tools Reference row); the synthesis step is either
  repointed at `keeper pair send` or the pairctl-specific guidance removed
- [ ] scripts/CLAUDE.md:3 no longer lists "pairctl prompts" as an install step
- [ ] `grep -rn pairctl apps/tastectl/tastectl/prompts/improve-taste.md scripts/CLAUDE.md` returns nothing

## Done summary

## Evidence

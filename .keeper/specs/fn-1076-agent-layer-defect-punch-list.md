## Overview

Small verified defects across the skill and agent surfaces, batched by plugin so each task is
one coherent review. All are wrong-today items (phantom error codes, stale model ids, missing
config rows, misattributed comments) — no restructuring, no pruning (that is the prose-prune
epic). Where the fix quotes a CLI contract, the CLI is the source of truth.

## Quick commands

- `grep -rn "ref_invalid" plugins/` — zero hits when done
- `grep -rn "claude-sonnet-4-6\|Opus 4.7" plugins/` — zero hits when done

## Acceptance

- [ ] No skill or agent brief quotes an error code, result field, or model id that the code does not emit
- [ ] The autopilot skill documents every durable config verb including worktree_multi_repo
- [ ] A skill-id lint gates plugin skill names against the double-prefix defect class

## Early proof point

Task that proves the approach: `.1` (plan-plugin sweep) — mechanical, verifiable by grep.

## References

- Real scaffold codes (from src): bad_yaml, spec_invalid, dep_invalid, epic_dep_invalid, repo_invalid, tier_invalid, model_invalid, repo_required, dep_cycle, duplicate_epic, id_collision
- epic_add_deps.ts:151-170 — results carry {dep_id,status} only; no reason field
- The keeper:keeper-await double-prefix bug shipped 5 days / 36 misfires before correction

## Docs gaps

- **plugins/keeper/skills/autopilot/SKILL.md**: config table + argument-hint gain worktree_multi_repo
- **CLAUDE.md**: hook-rule sentence rewordered to permit the sidecar-writer provenance read explicitly

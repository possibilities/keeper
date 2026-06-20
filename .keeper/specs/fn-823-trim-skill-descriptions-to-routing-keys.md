## Overview

Trim every Claude-skill `description:` frontmatter across two repos (keeper + arthack, 12 skills) down to a minimal routing key: one clause of what the skill does plus just enough "Use when…" trigger signal to disambiguate it from sibling skills. A skill description is the model's SOLE auto-invocation signal and is loaded for every installed skill on every turn, so bloat is both a routing-quality and a per-turn token cost. Remove three patterns: internal mechanism (duplicates the SKILL.md body), caveats/refusal/edge behavior (belongs in the body), and exhaustive synonym phrase-lists (the model generalizes). The flagship offenders, `keeper:await` (1682 chars) and `arthack:panel` (1042 chars), currently exceed Anthropic's 1024-char spec cap.

## Quick commands

- Char-count check (run per repo): `for d in <skill-dirs>; do awk 'f&&/^[a-z_-]+:/{exit} /^description:/{f=1} f' "$d/SKILL.md" | wc -c; done` — confirm each is well under 1024 (target ≤ ~600). (awk via /usr/bin/awk if PATH is odd.)
- Generated-file sanity (keeper): after editing the template + `promptctl render-plugin-templates --project-root /Users/mike/code/keeper`, `git diff --stat plugins/plan/skills/work/` should show SKILL.md + its `.managed-file-dont-edit` marker changed together (no dirty mismatch).

## Acceptance

- [ ] All 12 skill descriptions read as a minimal routing key — both "what it does" AND "when to use it" — with no internal mechanism, no caveat/refusal prose, and no exhaustive synonym dumps.
- [ ] Every description is ≤ ~600 chars (hard ceiling 1024); `await` and `panel` brought under the cap.
- [ ] Genuine disambiguators preserved: await's condition categories, next's "does not scaffold", panel's non-tiny/expensive gate, tmux's interactive-CLI examples.
- [ ] `plan:work` edited via its source template + regenerated (never the generated SKILL.md directly).
- [ ] Human-only (`disable-model-invocation`) skills reviewed under the same principle but kept human-readable — not over-tightened.
- [ ] Forward-facing present-tense prose only; no "formerly/used-to/replaces".
- [ ] Each repo committed separately via `keeper commit-work`.

## Early proof point

Task that proves the approach: `.1` (keeper) — landing the flagship `await` rewrite (1682 → ≤600 chars) plus the generated-file template+render dance validates the whole pattern. If it fails: re-confirm the render verb via `promptctl render-plugin-templates --help` and that the template `description:` is literal (no var injection) before retrying. The arthack task follows the identical principle on in-place files.

## References

- Anthropic / agentskills "Optimizing skill descriptions": the 1024-char hard limit, the synonym-overfitting trap, and "Use when…" trigger phrasing — https://github.com/agentskills/agentskills/tree/main/docs/skill-creation/optimizing-descriptions.md
- agentskills specification (description = what + when; good/poor examples) — https://github.com/agentskills/agentskills/tree/main/docs/specification.md
- Routing is description-driven, loaded every turn (cumulative token cost) — https://code.claude.com/docs/en/agent-sdk/skills
- Repo invariant: `plugins/plan/` is a git subtree — editing files in-tree is fine; never squash/rebase its merge commit (see keeper CLAUDE.md).

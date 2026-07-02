## Overview

After the sprint, agent-facing surfaces carry retired-tool vocabulary (planctl/chatctl) that misroutes agents, root CLAUDE.md's plugin-layout paragraph contradicts the tree, and README has structural holes: no builds-worker section (with a dangling cross-reference), a broken worker-ordinal numbering scheme, and zero mention of keeper prompt. This epic purges the residue, corrects the layout paragraph, lands one atomic README structural pass, and extends the retired-name lint with a forbid-record kind so the class cannot regrow. It deliberately runs after the four sibling stabilization epics whose README edits it would otherwise collide with.

## Quick commands

- `bash scripts/lint-retired-name.sh` — green with the new forbid records active
- `bun scripts/lint-claude-md.ts` — green after the plugin-paragraph edit
- `grep -rn 'chatctl\|planctl' README.md CLAUDE.md .keeper/CLAUDE.md keeper/api.py plugins/plan/.claude-plugin plugins/plan/hooks plugins/plan/agents scripts/commands.ts scripts/resume.ts` — only sanctioned hits remain

## Acceptance

- [ ] No live agent-facing surface names planctl or chatctl in present tense; frozen wire-format surfaces untouched
- [ ] Root CLAUDE.md accurately describes three plugins-dir peers (two claude-plugins + the prompt engine) and the four per-cell work-plugin manifests
- [ ] README carries a builds-worker section, no dangling cross-reference, no worker ordinals, and a keeper prompt paragraph
- [ ] The lint's new forbid records cover every cleaned file so regrowth fails CI

## Early proof point

Task that proves the approach: `.2` — the forbid-kind lint arm with fixture tests, landing in the same commit as the purge so the real-tree lint test stays green. If it fails: the purge still lands and the guard extension splits into a follow-up.

## References

- Read verbs emit NO trailing envelope (plugins/plan/test/verbs-envelope.test.ts:352) — the epic-scout.md fix is a reword of a clause describing a nonexistent trailer, not a field rename
- src/builds-worker.ts:1-49 — the authoritative header the new README section distills
- Sibling epics fn-1050/1051/1052/1054 edit disjoint README sections first; every spec here anchors by CONTENT, never by line number

## Docs gaps

- This epic IS the docs pass; the one meta-gap: .keeper/CLAUDE.md sits outside lint-claude-md's scope, so its rewrite self-polices forward-facing wording and gains a forbid record as its only regression guard

## Best practices

- **Occurrence-level guards over line counts** for prose surfaces; fixed-string case-insensitive matching; missing guard target = FAIL
- **Wire-format fixtures are permanently sanctioned** — they live in the frozen tier with mandatory comments, never in a ratchet
- **Prune agent rule files as aggressively as you add** — instruction compliance decays with rule count

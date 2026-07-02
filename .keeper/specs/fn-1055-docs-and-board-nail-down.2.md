## Description

**Size:** M
**Files:** CLAUDE.md, .keeper/CLAUDE.md, plugins/plan/.claude-plugin/plugin.json, plugins/plan/hooks/hooks.json, keeper/api.py, src/derivers.ts, src/bus-identity.ts, src/bus-worker.ts, plugins/plan/agents/epic-scout.md, plugins/keeper/skills/bus/SKILL.md, scripts/commands.ts, scripts/resume.ts, scripts/lint-retired-name.sh, scripts/frozen-allowlist.txt, test/lint-retired-name.test.ts

### Approach

Purge + guard in one commit (the real-tree lint test at test/lint-retired-name.test.ts:194 runs the live allowlist against the live tree, so forbid records and the purge must land together). The purge: plugins/plan/.claude-plugin/plugin.json description drops "planctl projects" (verb-phrase description naming keeper plan); plugins/plan/hooks/hooks.json description prefix "planctl generated-file guard" → "plan generated-file guard" (the `_promptctl_path` marker named later in the line is a LIVE key — untouched); .keeper/CLAUDE.md:1-5 rewrites to current vocabulary (the dir is .keeper/, commits are chore(plan): — the behavioral instruction stays; forward-facing wording, and note this file sits OUTSIDE lint-claude-md's scope so the wording self-polices); keeper/api.py:18 and :651 chatctl consumer attributions → the Agent Bus (surgical — the frozen planctl_* schema comments at :99-310 in the same file are untouchable); src/derivers.ts:308, src/bus-identity.ts:150, src/bus-worker.ts:520 chatctl comments restated forward-facing; plugins/plan/agents/epic-scout.md — the clause about "the trailing planctl_invocation envelope" describes a trailer READ VERBS DO NOT EMIT (plugins/plan/test/verbs-envelope.test.ts:352) — reword the sentence to the actual contract (read verbs emit exactly one JSON value, no trailer) rather than renaming the field, and fix the "runs planctl" phrase near :39; plugins/keeper/skills/bus/SKILL.md ~:231-236 — prune the completed-work-narrated-as-future chatctl-retirement paragraph but PRESERVE the live cross-repo boundary instruction ("out of scope, do not edit from here"); scripts/commands.ts :4/:68 "planctl id" → "plan id" and the :83-84 example slugs swap to a neutral current slug; scripts/resume.ts:5 likewise.

Root CLAUDE.md plugin paragraph: state CURRENT structure — three peers under plugins/ of which keeper and plan are claude-plugins, prompt is the engine behind keeper prompt (no .claude-plugin manifest); plan additionally carries four per-cell work-plugin manifests under workers/opus-*/ selected at launch via --plugin-dir. No change-narration words (lint bans formerly/no longer/retired/replaced/previously); stay under the 120-line/16KB gates.

The guard: a new `forbid|<relpath>|<substring>` record kind in scripts/lint-retired-name.sh — fixed-string (grep -F), case-insensitive (-i), SINGLE FILE only (never a directory walk — the .keeper archive is saturated with sanctioned planctl and only .keeper/CLAUDE.md is a target), missing target file = FAIL (consistent with anchor/count), implemented `if grep -Fqi …` so set -e is safe, with a `forbid)` parser arm (the `*)` unknown-kind arm otherwise fires). Add forbid records for the full cleaned set: plugins/plan/.claude-plugin/plugin.json, plugins/plan/hooks/hooks.json, .keeper/CLAUDE.md, plugins/plan/agents/epic-scout.md, scripts/commands.ts, scripts/resume.ts (all |planctl). Update the frozen-allowlist.txt header from three record kinds to four. Fixture tests for the new kind (hit, miss, missing-file, case variants) in test/lint-retired-name.test.ts.

### Investigation targets

**Required** (read before coding):
- scripts/lint-retired-name.sh — the parser case arms, Check A/B structure, set -e discipline
- scripts/frozen-allowlist.txt — record grammar + header
- test/lint-retired-name.test.ts — fixture harness shape + the real-tree test at :194
- plugins/plan/test/verbs-envelope.test.ts:352 — the no-trailer proof grounding the epic-scout.md reword

**Optional** (reference as needed):
- scripts/lint-claude-md.ts:12-14 — confirming .keeper/CLAUDE.md is out of its scope
- .gitignore + plugins/plan/test/consistency-generated-guard.test.ts — the live _promptctl_path marker

### Risks

- Touching a frozen surface (Planctl-Op trailer files, src/db.ts count-pin, api.py schema comments, docs/plan-name-retirement.md, .keeper archive) trips Check A/B or orphans history — the untouchable list is absolute
- scripts/serve-fold-load.ts planctl_* identifiers are LIVE SQL COLUMN NAMES, not docs — out of scope entirely

### Test notes

bash scripts/lint-retired-name.sh green on the purged tree with forbid records active; lint-claude-md green; the new fixture cases cover hit/miss/missing/case; full fast suite green (the lint test rides in it).

## Acceptance

- [ ] Every named surface purged with forward-facing wording; untouchables untouched
- [ ] Root CLAUDE.md paragraph matches the tree; both lints green
- [ ] forbid kind implemented per the pinned semantics; records guard the full cleaned set; allowlist header updated; fixtures cover the kind
- [ ] Full fast suite green

## Done summary
Purged retired planctl/chatctl vocabulary from all live agent-facing surfaces (frozen schema/trailer literals untouched), corrected the root CLAUDE.md three-peer plugin paragraph, and added a forbid-kind arm to lint-retired-name.sh with allowlist header + fixtures pinning the cleaned set to zero regrowth. Both lints and the full fast suite are green.
## Evidence

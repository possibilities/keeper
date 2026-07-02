## Description

**Size:** M
**Files:** plugins/keeper/skills/{autopilot,handoff}/SKILL.md, CLAUDE.md, plugins/keeper/plugin/bin/git (doc note)

### Approach

Autopilot skill: add the worktree_multi_repo row to the config parse table (~:70) and `config`
to the argument-hint; note the status-envelope caveat honestly (absent from
status .data.autopilot today — drop the caveat text if/when the envelope epic lands it, which
task specs there already cover). Drop Monitor from allowed-tools and delete the
self-justifying aside (:185-186) — the await cross-reference stands on its own. Handoff skill:
generalize the six hardcoded /hack references to "the configured handoff_prompt_prefix
(currently /hack)" stated once, generic thereafter. CLAUDE.md hook rule: reword the
"~/docs repo only" sentence to state the real intent — no mutating git or DB writes outside
~/docs — so sidecar-writer's read-only rev-parse provenance probe (sidecar-writer.ts:165,169)
is explicitly inside the contract; keep the lint gate green (minimal delta). Add the one-line
PATH-activation note for plugin/bin/git where an operator will find it (README or the shim's
own header): the Session-Id trailer silently disappears if PATH ordering ever drops the shim.

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/autopilot/SKILL.md:70,137-140,185-186 — config table, capture set, Monitor aside
- plugins/keeper/plugin/hooks/sidecar-writer.ts:158-169 — the provenance read being legitimized
- scripts/lint-claude-md.ts — the gate the CLAUDE.md edit must satisfy

### Risks

- The CLAUDE.md hook-rule sentence is an invariant statement — the reword must not accidentally widen it to permit mutating operations.

### Test notes

lint-claude-md green; skill argument-hints match documented verbs; grep for /hack in handoff
shows only the single "(currently /hack)" mention.

## Acceptance

- [ ] Autopilot skill documents worktree_multi_repo with an honest envelope caveat; Monitor grant removed
- [ ] Handoff references the configured prefix generically after one concrete mention
- [ ] CLAUDE.md hook rule states the no-mutating-writes intent; shim PATH note landed

## Done summary

## Evidence

## Description

**Size:** S
**Files:** plugins/plan/scripts/promote.sh (or the build/promote path), plugins/plan/test/consistency-skills.test.ts, plugins/plan/README.md, plugins/plan/CLAUDE.md, plugins/plan/skills/work/SKILL.md

### Approach

Add a promote/build-time drift guard: after building the binary, re-render the plugin templates and assert
a clean tree (`git status --porcelain`), AND assert the resolver's embedded snapshot equals the on-disk
`subagents.yaml` — so a config edit that was not rebuilt+re-rendered fails LOUD at promote (a `bun test`
cannot catch a stale compiled binary, so the guard must live at build/promote). Drive the
`consistency-skills.test.ts` worker loop off the parsed `subagents.yaml` matrix instead of a hardcoded
`TIERS` const (the test already reads config-ish files — follow that precedent). Final doc sweep: any
residual four-name / "opus constant" language across plan README, plan CLAUDE.md/AGENTS.md (edit in place;
run `bun scripts/lint-claude-md.ts`), and the work SKILL.md invariant list.

### Investigation targets

**Required** (read before coding):
- plugins/plan/scripts/promote.sh — where a rebuild-and-diff / git-clean gate slots in
- plugins/plan/test/consistency-skills.test.ts:386-413 — the hardcoded `TIERS` loop to drive off config
- plugins/plan/CLAUDE.md + scripts/lint-claude-md.ts — the size/prose gate to keep green

**Optional** (reference as needed):
- plugins/plan/README.md:55,155 — resolve-task envelope + /plan:work row, if not already updated in task 2/3

### Risks

- The guard MUST run at build/promote, not as a suite test — in-process tests resolve the embed to the same on-disk file and always pass, hiding a stale binary.

### Test notes

Consistency test drives off `subagents.yaml`; a promote dry-run with a deliberately un-rebuilt config edit
fails the guard. Forward-facing prose only (no fn-ids/dates/past-tense).

## Acceptance

- [ ] A promote/build-time drift guard fails loud when the embedded snapshot or rendered files diverge from `subagents.yaml`.
- [ ] `consistency-skills.test.ts` drives its worker assertions off the parsed config, not a hardcoded tier list.
- [ ] No residual four-name / "opus constant" language remains; `lint-claude-md.ts` is green.

## Done summary

## Evidence

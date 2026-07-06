## Description

**Size:** M
**Files:** cli/session.ts (new), cli/keeper.ts, cli/descriptor.ts, cli/session-state.ts, cli/show-session-files.ts, cli/show-session-events.ts, cli/session-summary.ts, plugins/plan/skills/work/SKILL.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/deconflict/SKILL.md, plugins/plan/skills/unblock/SKILL.md, plugins/keeper/skills/query/SKILL.md, plugins/keeper/skills/debug/SKILL.md, plugins/plan/template/agents/worker.md.tmpl, plugins/plan/template/skills/work.md.tmpl, plugins/prompt/corpus (re-vendor), test/keeper-cli.test.ts, test/completions.test.ts

### Approach

Cut the four session-scoped flat leaves over to one group: `keeper session state|files|events|summary` map to the existing session-state / show-session-files / show-session-events / session-summary mains, each preserving its flags, envelope shape, and exit codes byte-for-byte — only the invocation spelling changes. The group dispatcher follows the descriptor pattern: pure group `--help`, per-subverb leaf help, unknown subverb exit 2. The four retired top-level names hard-fail (unknown subcommand). search-history, find-file-history, show-job, escalation-brief, and baseline stay top-level (history-, job-, incident-, and commit-scoped — not one-session-scoped). Migrate every advice caller: skill prose AND allowed-tools frontmatter globs (`Bash(keeper session-summary:*)` → the grouped form — load-bearing permissions, not just prose), worker/work templates, then re-vendor the corpus from the arthack authoring home (`bun scripts/vendor-corpus.ts --sync`) and re-render the hack SKILL.md BAKE blocks so `vendor-corpus --check` and the prompt-suite BAKE assertions are green. daemon.test.ts's escalation-brief literals cite only search-history/find-file-history, which keep their names — verify, don't churn.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/keeper.ts:41-46,585-599 — the four leaves' wiring to regroup
- plugins/plan/src/subgroup.ts:131-174 — the group-dispatcher pattern (or ordinal 1's native equivalent)
- plugins/plan/skills/deconflict/SKILL.md:10 and plugins/plan/skills/unblock/SKILL.md:10 — the allowed-tools globs that break silently if missed
- plugins/prompt/corpus/vendor.lock + scripts/vendor-corpus.ts — the sync + check contract
- test/daemon.test.ts:4982-4983,5016 — escalation-brief literals to verify unaffected

**Optional** (reference as needed):
- plugins/plan/template/agents/worker.md.tmpl:27,80,83,194 — template citation sites

### Risks

- A missed allowed-tools glob silently strips a skill's permission at runtime — grep for `keeper session-` and each retired verb across plugins/ after migration, not just the known sites.
- The corpus sync depends on the arthack-side task having landed (dep ordinal 9); a sync against stale sources re-introduces dead verbs.

### Test notes

Suites: grouped verbs dispatch to the same handlers (stub-level identity), retired names exit as unknown-subcommand, group/leaf help purity rides the ordinal-5 walk, completions list the group; `bun scripts/vendor-corpus.ts --check` green.

## Acceptance

- [ ] `keeper session state|files|events|summary` serve the four reads with byte-identical envelopes, flags, and exit codes; the retired flat names hard-fail
- [ ] Group and subverb help are pure and leaf-specific; unknown subverb exits 2
- [ ] Every in-repo skill (prose + allowed-tools globs), template, and the vendored corpus cite only the grouped forms; vendor-corpus --check and the BAKE assertions are green

## Done summary
Grouped the four session-scoped reads under `keeper session <state|files|events|summary>` via a new cli/session.ts dispatcher (pure group + per-leaf help, unknown subverb exit 2); retired flat names hard-fail. Migrated skill prose + allowed-tools globs, worker/work templates, and the vendored history-forensics corpus to grouped forms (vendor-corpus --check + BAKE green). Kept show-job --session as-is (grammar wave, not landed on this branch).
## Evidence

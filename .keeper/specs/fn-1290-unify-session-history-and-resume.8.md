## Description

**Size:** M
**Files:** cli/search-history.ts, cli/find-file-history.ts, cli/keeper.ts, cli/descriptor.ts, scripts/maintenance-window.ts, README.md, docs/problem-codes.md, CLAUDE.md, plugins/keeper/skills/query/SKILL.md, plugins/keeper/skills/debug/SKILL.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/cell-review/SKILL.md, plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/keeper-history-forensics.md.tmpl, plugins/prompt/corpus/vendor.lock, test/keeper-cli.test.ts, test/refold-equivalence.test.ts, test/maintenance-window.test.ts, plugins/prompt/test/vendored-corpus.test.ts

### Approach

Finish the build-forward cutover in one Keeper repository state. Remove the two obsolete top-level command modules and registrations, migrate maintenance/reclaim/forensics callers and tests to `keeper history`, vendor the landed arthack snippet through the supported corpus workflow, and consolidate public/agent documentation around the unified surface.

Update the existing sole-writer guardrail compactly so the lock-serialized private History index ownership is unambiguous without expanding CLAUDE.md into design narration. Prune stale caveats rather than appending parallel explanations.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/keeper.ts:35 — public command set and lazy route removal
- cli/descriptor.ts:1211 — obsolete descriptor leaves
- scripts/maintenance-window.ts — prompt-survival verification caller
- plugins/prompt/corpus/vendor.lock:1 — upstream provenance and regeneration workflow
- plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/keeper-history-forensics.md.tmpl:1 — vendored authored guidance
- scripts/lint-claude-md.ts:1 — CLAUDE.md size/content gate

**Optional** (reference as needed):
- README.md — lean capability front door
- docs/problem-codes.md — in-binary reader error taxonomy
- test/refold-equivalence.test.ts:425 — literal old-reader path coupling

### Risks

There are dozens of references across descriptors, skills, daemon/maintenance material, tests, and hash-pinned prompt corpus. Removing command files before every consumer moves creates broken help, maintenance checks, guard allowlists, or generated guidance.

### Test notes

Use repository-wide exact-name search as a coverage assertion, then run focused CLI/help, maintenance, prompt-vendor, problem-code/doc, and refold tests. The full commit gate owns aggregate lint/type/test execution.

### Detailed phases

1. Vendor the upstream snippet with the supported script and verify provenance hashes.
2. Migrate every in-repository invocation, help string, allowlist, skill, prompt, and test to the final history grammar.
3. Remove old command modules, routes, descriptors, and stale problem-code rows.
4. Consolidate README/problem-code/guardrail prose and ensure future-facing docs contain no transition history.
5. Prove exact old command names are absent outside sanctioned historical artifacts such as git/ADR provenance.

### Alternatives

Hidden forwarding aliases are rejected by the accepted build-forward contract. Leaving stale authored guidance for a later task is rejected because the public removal and agent recipes must agree atomically.

### Non-functional targets

No duplicate public routes, no stale completions, no vendored-corpus drift, no CLAUDE.md bloat, no unrelated dirty-file staging, and no history-index content in logs.

### Rollout

This is the final public switch. Rollback reverts this task and the new command registrations together; deleting the closed private index is always safe because native transcripts remain authoritative.

## Acceptance

- [ ] `search-history` and `find-file-history` are absent from public routing, descriptors, completions, help, source modules, scripts, skills, prompts, and non-historical tests.
- [ ] Every in-repository history recipe uses `keeper history` and the shared Session-reference contract with truthful standalone/evidence caveats.
- [ ] The Keeper prompt corpus is regenerated from the landed arthack authoring source and its lock/hash tests pass.
- [ ] README and problem-code documentation describe the final Claude/Pi history, index, evidence, and foreground-resume contracts without transition narration.
- [ ] The sole-writer guardrail identifies the private index owner compactly and all CLAUDE.md discipline checks pass.
- [ ] Focused routing/help, maintenance, refold, prompt-vendor, and documentation tests pass, and repository search finds no unsanctioned old command names.

## Done summary

## Evidence

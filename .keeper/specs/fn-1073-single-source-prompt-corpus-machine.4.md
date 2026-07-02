## Description

**Size:** M
**Files:** claude/arthack/template/_partials/snippets/** (arthack repo), /Users/mike/code/CLAUDE.md

### Approach

Clean the authoring corpus in arthack so the vendored subset locks against healthy canonicals.
Sync the stale canonical: escalate-inline-or-plan.md.tmpl:16 still recommends the removed
/plan:next — adopt the corrected autopilot phrasing that already lives in keeper's hack
SKILL.md bake ("autopilot runs it when it reaches the front of the board"). Resolve all four
[[wikilink]] leaks (code-comment-style:14,17; claude-md-scope:18; commit-via-keeper-default:30)
into real cites, matching how the hack bake already rewrote commit-hygiene-flags. Trim
commit-via-keeper-default's "temporary escape hatch we'll repair" paragraph (~130 words) to a
forward-facing rule. Delete or bundle the 19 orphaned snippets (all worker-teams/, all collab/,
4 of 5 source-dirs/, 4 messaging/, plus bun-opentui-rules, design-taste-pointer,
artbird-deploy-hook, human-only-subcommand-marker) — check the orphan-sweep caveat at
arthack/claude/arthack/CLAUDE.md:4 first. Pick devctl as the one classifier binary and sweep
choosectl/assistctl from project-manifest-description:11, polyglot-manifest-description:15, and
/Users/mike/code/CLAUDE.md (verify that file's repo before committing; if it is outside a git
repo, edit without commit and note it).

### Investigation targets

**Required** (read before coding):
- claude/arthack/template/_partials/snippets/engineering/escalate-inline-or-plan.md.tmpl:16
- claude/arthack/template/_partials/snippets/engineering/commit-via-keeper-default.md.tmpl:30
- claude/arthack/CLAUDE.md:4 — the used-in/orphan caveat

### Risks

- An "orphan" may have consumers outside the scanned repos; deletion is cheap to revert (git), but prefer bundling over deletion where intent is ambiguous.

### Test notes

arthack's build-snippets --check stays green after edits; re-render each touched snippet and
eyeball for leaked template syntax.

## Acceptance

- [ ] escalate-inline-or-plan canonical carries the corrected phrasing; no /plan:next anywhere in the corpus
- [ ] Zero [[wikilink]] occurrences render as literal text
- [ ] 19 orphans deleted or wired into bundles; choosectl/assistctl swept to devctl in both snippets and the parent CLAUDE.md

## Done summary

## Evidence

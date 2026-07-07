## Description

**Size:** M
**Files:** claude/matt/skills/init/SKILL.md

### Approach

The new-build adoption skill: /matt:init migrates the cwd repo into the domain-docs convention. User-invoked, migration-only, never auto-fires, never nags. Flow: (1) Explore read-only — CLAUDE.md/AGENTS.md, README, docs/, code comments, recent git history — harvesting three buckets: terms of art as candidate CONTEXT.md entries (1-2 present-tense sentences naming role and behavior, an Avoid line of rejected synonyms, zero implementation detail), embedded rationale as candidate ADRs filtered hard through the 3-part test (hard to reverse AND surprising without context AND a real trade-off), and definitional prose squatting in CLAUDE.md as the prune list (definitions move out, imperative guardrails stay). (2) Present exactly ONE clustered proposal — draft CONTEXT.md, ADR shortlist, before/after CLAUDE.md diff — and wait; offer, never auto-write. A sparse repo yielding three terms is a small honest proposal, never padded; a repo where nothing qualifies gets told so in one line. (3) Landing follows the human's words: a plain-text greenlight lands inline via keeper commit-work (point at engineering/commit-via-keeper-default for the contract — the domain-docs lint arm gates these files; a false positive is pain-ledger material, and the inline escape marker requires its annotation); "defer it" scaffolds a single-task epic via plan:defer carrying the approved draft as the declared deliverable. (4) Idempotent by content: every run re-harvests and diffs against the existing CONTEXT.md/docs/adr, proposing only the delta — an empty delta says so and stops; no hidden state markers. Edge behavior is explicit in the skill: no git repo → harvest and propose but only the defer path is offered after warning; existing CONTEXT.md → delta-update in place, never clobber; a generated CLAUDE.md (managed-file sidecar or generation marker) → flag it and exclude it from the prune list. For genre rules the skill points at keeper prompt render engineering/domain-docs rather than restating. Keep the skill under ~150 lines by pointing at the two snippets and plan:defer for their own mechanics.

### Investigation targets

*Verify before relying.*

**Required**:
- ~/code/arthack/claude/arthack/template/_partials/snippets/engineering/domain-docs.md.tmpl — the reflex and genre boundaries this skill operationalizes
- ~/code/arthack/claude/arthack/template/_partials/snippets/engineering/commit-via-keeper-default.md.tmpl — the landing contract, incl. lint_failed recovery
- /Users/mike/code/keeper/CONTEXT.md and /Users/mike/code/keeper/docs/adr/ — the landed exemplar of the target shape (what a finished adoption looks like)
- claude/matt/README.md and a task-1 skill's frontmatter — plugin conventions to match

### Risks

- The harvest is judgment-heavy: a term earns an entry only when repo-specific and load-bearing; general programming vocabulary is rejected at entry.
- Prune proposals against CLAUDE.md files in active repos can collide with open work — the skill checks keeper status before offering the inline landing.

### Test notes

Frontmatter greps as in task 1. Interactive smoke lives at the epic level (run /matt:init in a scratch repo).

## Acceptance

- [ ] /matt:init is discoverable, user-invoked, and its flow enforces read-only harvest, one clustered proposal, offer-don't-auto-write, and the two landing paths keyed to the human's wording
- [ ] Re-run behavior is content-keyed delta-only with an honest empty-delta exit; no state markers
- [ ] Edge behaviors (non-git dir, existing CONTEXT.md, generated CLAUDE.md, sparse repo) are each specified in the skill body
- [ ] Genre rules and commit mechanics are pointed at, not restated

## Done summary
Added /matt:init: a new-build, user-invoked skill that migrates a repo into the domain-docs convention via a read-only harvest, one clustered proposal, and two landing paths (keeper commit-work greenlight or plan:defer), with content-keyed delta-only re-runs and specified edge behaviors.
## Evidence

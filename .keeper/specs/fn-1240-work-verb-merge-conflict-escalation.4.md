## Description

**Size:** S
**Files:** CLAUDE.md, CONTEXT.md, plugins/keeper/skills/watch/SKILL.md

Reconcile the forward-facing docs with the new work-verb escalation channel.
Consolidate, never append.

### Approach

Rewrite the CLAUDE.md Autopilot section so the close-vs-work asymmetry is gone
and the `worktree-merge-conflict` vs `worktree-lane-premerge` classification
(per task .1's ADR) is stated once; prune redundant clauses, keep
`bun scripts/lint-claude-md.ts` green (the edit lands in the `AGENTS.md`
symlink too — edit in place). Disambiguate the CONTEXT.md `Resolver` /
`Deconflict session` / `Lane pre-merge` entries (broaden to "epic OR
task/lane" per the identity decision), add any new work-verb term and the
fan-in-vs-premerge distinction with `Avoid:` lists. Update watch SKILL.md
rung-2 (resolver sequencing now covers `work::<taskId>`) and rung-4 (a work
conflict is a live escalation channel, not a manual gap), and check the
`keeper watch --filter` list for a work-verb-merge-escalation surface. No
fn-ids / dates / past-tense provenance in any forward-facing doc.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required** (read before coding):
- CLAUDE.md — the Autopilot section paragraph describing the close-scoped `resolve::`/`deconflict::` sequencing and the `worktree-lane-premerge`/`worktree-lane-wedge` path.
- CONTEXT.md — `Resolver` / `Deconflict session` / `Lane pre-merge` entries.
- plugins/keeper/skills/watch/SKILL.md — rung-2 (close-sweep) and rung-4 (notify) text; the `keeper watch --filter` list.
- docs/adr/00NN-work-verb-merge-conflict-escalation.md — task .1's ADR (the source of truth for the reconciled prose).

### Risks

- `lint-claude-md.ts` bans size growth and re-narration — this must be a net consolidation, not an append.

### Test notes

`bun scripts/lint-claude-md.ts` green. Docs-only; no behavior tier.

## Acceptance

- [ ] CLAUDE.md Autopilot section reconciled (no close-only asymmetry remains); `bun scripts/lint-claude-md.ts` green.
- [ ] CONTEXT.md disambiguates the two conflict classes and the resolver/deconflict scope; new terms carry `Avoid:` lists.
- [ ] watch SKILL.md rung-2 / rung-4 reflect the `work::<taskId>` live escalation channel; the `--filter` list is reconciled.
- [ ] No fn-ids, dates, or past-tense provenance in any forward-facing doc edited.

## Done summary

## Evidence

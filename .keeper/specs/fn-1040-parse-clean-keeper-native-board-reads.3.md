## Description

**Size:** S
**Files:** CLAUDE.md (keeper root), plugins/plan/CLAUDE.md, plugins/plan/README.md, plugins/plan/src/cli.ts (`--help`/DESCRIPTION strings)

### Approach

Point agents at the already-clean surfaces so they stop reaching for the wrong
tool. Add a terse (1-2 line) board-orient guardrail to the keeper root CLAUDE.md
after the "Plans are READ-ONLY" rule: orient with `keeper status`; per-task detail
(tier/model/title/deps) with `keeper query epics --json | jq '.data[]'`; never
hand-parse `keeper plan <verb>`. Update plugins/plan/README.md — scope the
`plan_invocation` trailer to mutating verbs (`## Auto-commit` ~L99), state the
single-JSON guarantee + truncation-envelope shape (`## Output Contract` ~L136-146),
fix the `validate --epic` paragraph (~L144), and add the orient signpost to
`## Help for Agents` (~L171). Update plugins/plan/CLAUDE.md (L12 validate
divergence bullet, L28 validation-marker section, L51 Running-Things table → add
the new guard test). Extend the `keeper plan --help` DESCRIPTION/printHelp with the
signpost. Forward-facing only — describe the system as it is now, no "used to
emit" provenance; keep the root CLAUDE.md addition under the size gate.

### Investigation targets

**Required** (read before coding):
- plugins/plan/README.md ~L99, ~L136-146, ~L144, ~L171 — the sections to revise
- plugins/plan/CLAUDE.md L12, L28, L51 — validate divergence, validation-marker, Running-Things table
- CLAUDE.md (keeper root) — the "Writes are tightly scoped" block; place the guardrail after "Plans are READ-ONLY"
- plugins/plan/src/cli.ts:241 (DESCRIPTION) + :752-768 (printHelp)

**Optional** (reference as needed):
- README.md (keeper root) L72-73 — already scopes the fold to mutating verbs (stays correct; reference for wording)

### Risks

- keeper root CLAUDE.md is size-gated by `scripts/lint-claude-md.ts` — keep the addition to 1-2 lines and prune elsewhere if needed.
- Forward-facing rule — no tombstones / "formerly emitted" narration in any doc or help string.

### Test notes

`bun scripts/lint-claude-md.ts` green; help/DESCRIPTION strings match the new
single-JSON + truncation contract.

## Acceptance

- [ ] keeper root CLAUDE.md carries a terse board-orient guardrail naming `keeper status` + `keeper query epics` as the read-before-act surfaces; `bun scripts/lint-claude-md.ts` green.
- [ ] plugins/plan/README.md `## Auto-commit`, `## Output Contract`, `validate --epic`, and `## Help for Agents` sections describe the single-JSON contract + truncation envelope, forward-facing.
- [ ] plugins/plan/CLAUDE.md validation-marker section, validate divergence bullet, and Running-Things table updated (guard test listed).
- [ ] `keeper plan --help` signposts the orient surfaces and "don't hand-parse read verbs".

## Done summary

## Evidence

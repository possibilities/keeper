## Description

**Size:** S
**Files:** plugins/keeper/skills/query/SKILL.md

### Approach

New model-invocable keeper skill `keeper:query` — the read-plane reference teaching any agent how to efficiently read keeper's control data. Tiered hierarchy: (1) stable session-history JSON verbs first (`keeper find-file-history`, `keeper search-history`, `keeper show-session-events`, `keeper session-summary`, `keeper show-job`); (2) live projections second (`keeper status --json`; `keeper query <collection> [--filter k=v] [--json]` over the 18-collection read allowlist); (3) `sqlite3 -readonly` last, ad-hoc columns only — `.schema` first, single-statement SELECT with a LIMIT. State plainly: the read-only connection is the guard (prose is not an enforcement layer) and the daemon is the DB's sole writer. House conventions exactly: frontmatter `name: query` (== dir), folded trigger-dense `description` ending in NOT-for exclusions naming `/plan:hack` (investigate-and-route), `keeper:debug` (bug hunting), `keeper:autopilot` (board control); `allowed-tools: Bash`. Thin body in the debug band (~130-180 lines): identity → When this fires → tier hierarchy → POINTER blocks for `engineering/orient` and `engineering/keeper-history-forensics` mirroring the sibling shapes → collection walkthrough → guardrails. POINTER markers only, never a BAKE guard; zero render cites beyond the two vendored refs. Enumerate the 18 collections and defer to `keeper query --help` as the canonical list. Forward-facing prose throughout.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/debug/SKILL.md:91 — the keeper-history-forensics POINTER block shape to mirror; the whole file is the thin-skill skeleton
- plugins/keeper/skills/dispatch/SKILL.md:89 — the orient POINTER block shape
- plugins/keeper/skills/autopilot/SKILL.md:1-17 — the frontmatter/description formula (triggers, "even when they never say keeper", NOT-for tail)
- src/collections.ts:973-991 — QUERY_READ_ALLOWLIST, the authoritative 18 collections; copy exactly at authoring time
- docs/skill-authoring.md — the governing authoring method

**Optional** (reference as needed):
- cli/query.ts — the verb's --help text (quote flags and the collection list accurately)
- test/lint-skill-ids.test.ts:118 — naming rules (lowercase-hyphen dir, frontmatter name == dir, no keeper- double-prefix)
- plugins/prompt/test/vendored-corpus.test.ts — the reachability gate every render cite must satisfy

### Risks

- A render cite not present in the vendored subset `_index.yaml` fails the prompt suite — use only the two named refs.
- The prose collection list can drift from the source allowlist — copy it at authoring time and name `keeper query --help` as canonical in the body.

### Test notes

`bun test test/lint-skill-ids.test.ts`; `bun scripts/vendor-corpus.ts --check`; prompt suite (`cd plugins/prompt && bun test`). Manual: `keeper prompt render engineering/orient` and `engineering/keeper-history-forensics` both resolve; `keeper query tasks --json` matches the documented shape.

## Acceptance

- [ ] The query skill exists, loads as a model-invocable keeper skill (frontmatter name matches the dir, `allowed-tools: Bash`), and its description ends with NOT-for exclusions naming the hack, debug, and autopilot skills
- [ ] The body teaches the three-tier read hierarchy (history verbs → status/query projections → read-only sqlite last, SELECT-only) and enumerates all 18 read-allowlist collections, deferring to `keeper query --help` as canonical
- [ ] Exactly two POINTER markers (orient, keeper-history-forensics), zero BAKE guards, zero other render cites
- [ ] Skill-id lint, vendored-corpus drift check, and the prompt test suite all pass

## Done summary

## Evidence

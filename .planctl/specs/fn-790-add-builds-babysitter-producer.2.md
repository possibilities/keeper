## Description

**Size:** S
**Files:** babysitters/builds/charter.md, babysitters/builds/README.md

### Approach

Targeted prune-and-replace of the `## Sitter facts` section in
`~/docs/babysitters/builds/charter.md` against the producer task 1
actually shipped: the real category list, the exact key scheme and
sanitization, the followups path, and the occurrence-ts semantics. Drop
every "does not exist yet" / "contract defaults" caveat (the charter
flags them explicitly). Touch nothing above `## Sitter facts` — Goals
and Heuristics are human-authored, Understanding belongs to triage
rounds. Give README.md the same caveat-prune (it says the producer
isn't built). Commit to the ~/docs repo.

### Investigation targets

**Required** (read before coding):
- ~/docs/babysitters/builds/charter.md — the `## Sitter facts` section and its update-me notes
- ~/code/keeper/babysitters/agents/builds.md — the shipped category list and key scheme (source of truth, exists after task 1)

**Optional** (reference as needed):
- ~/code/keeper/babysitters/FINDINGS-LEDGER.md — the contract the facts restate

### Risks

- None structural; the only failure mode is rewriting human-authored sections — don't.

## Acceptance

- [ ] `## Sitter facts` states the shipped categories, key scheme, and followups path verbatim from agents/builds.md; no "producer not built" caveats remain in charter.md or README.md
- [ ] Goals / End-state / Heuristics byte-identical to before
- [ ] Committed to the ~/docs repo

## Done summary
Replaced charter.md ## Sitter facts with the shipped producer's real category list (test/lint/typecheck-failure, build-exception), key scheme (<category>:<sanitized-step>:<builder>), sanitization, and followups path from agents/builds.md; pruned producer-not-built caveats from charter Sitter facts and README. Goals/End-state/Heuristics untouched.
## Evidence

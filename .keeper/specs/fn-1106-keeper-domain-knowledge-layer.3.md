## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/engineering/domain-docs.md.tmpl, claude/arthack/template/_partials/snippets/engineering/future-facing-docs.md.tmpl, claude/arthack/template/_partials/snippets/engineering/claude-md-scope.md.tmpl, claude/arthack/template/_partials/snippets/engineering/code-comment-style.md.tmpl, claude/arthack/template/_partials/snippets/_index.yaml

### Approach

Upstream corpus work for the domain layer, in the arthack repo keeper vendors from. (1) Author engineering/domain-docs: the active domain-modeling reflex for interactive design skills — read CONTEXT.md and relevant ADRs before non-trivial design answers; challenge terms against the glossary; sharpen fuzzy or overloaded words; when a term resolves, offer one clustered update (offer, don't auto-write — the human confirms) and write inline the moment it's confirmed, never batched; offer an ADR only when all three hold: hard to reverse, surprising without context, a real trade-off; ADRs are written at plan time while the decision is freshest; supersession moves the old record to a superseded/ subdirectory. Also state the genre boundaries: CONTEXT.md is a pure glossary (1-2 sentence definitions, Avoid-synonym lines, zero implementation detail); decision rationale lives only in docs/adr and commit messages. (2) Revise the three existing snippets to the per-genre policy: future-facing-docs gains the docs/adr sole-exception (an ADR records a past decision with rationale and may reference what it rejected or supersedes); claude-md-scope gains the genre pointers (vocabulary → CONTEXT.md, decisions → docs/adr, CLAUDE.md stays imperative rules); code-comment-style stays no-history in comments but points rationale at the ADR home. Update index rows (summaries, token estimates) for all four.

### Investigation targets

*Verify before relying.*

**Required**:
- The three existing snippet bodies in this repo — revise in place, keep each snippet's voice and length discipline
- _index.yaml rows for the three — the row shape to extend for the new snippet

### Risks

- The revised wording lands verbatim in many prompt surfaces via bakes — every sentence must pass the no-op test; state the policy once per snippet, no cross-snippet duplication.

## Acceptance

- [ ] An engineering/domain-docs snippet exists teaching the interactive domain-modeling reflex (challenge, sharpen, offer-don't-auto-write, inline-on-confirm, 3-part ADR test, supersession, genre boundaries) with a valid index row
- [ ] The three revised snippets state the per-genre history policy consistently: docs/adr is the sole sanctioned history home; no snippet still states a blanket no-history rule
- [ ] Corpus tooling in this repo passes

## Done summary

## Evidence

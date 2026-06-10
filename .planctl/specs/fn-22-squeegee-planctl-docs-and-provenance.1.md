## Description

**Size:** S
**Files:** CLAUDE.md, docs/reference/skills-and-agents.md (new), docs/reference/commit-at-mutation-boundary.md, README.md (optional one-liner)

### Approach

Three moves, all under the epic Scrub standard. (1) CLAUDE.md "Commit behavior" section: collapse the entire body to one trip-wire line plus the existing pointer ("Commit behavior: every mutating verb auto-commits inline at output.emit(). Full contract: docs/reference/commit-at-mutation-boundary.md.") — the body duplicates the 800-line authoritative memo; delete, do not migrate. Audit the memo first: any fact in the CLAUDE.md body genuinely absent from the memo gets folded in (present-tense, no fn ids) before the body is deleted. (2) CLAUDE.md "Skills and agents" section: move to new docs/reference/skills-and-agents.md using the house header format; the new file cross-references commit-at-mutation-boundary.md for envelope/claim/reconcile details instead of copying them; CLAUDE.md keeps one pointer line. (3) Scrub the 29 fn-NNN provenance refs from commit-at-mutation-boundary.md — including the "Applies to: planctl CLI v1 (fn-587 and later)" header — rewriting each as present-tense fact. Keep the remaining CLAUDE.md sections (Doc & comment style, Convention Divergences, Validation marker, Removed verbs, Running things) intact but strip any provenance ids inside them. AGENTS.md is a symlink — it follows automatically.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md (whole file) and docs/reference/commit-at-mutation-boundary.md — overlap audit before deleting the Commit behavior body
- docs/reference/cross-project-epic-deps.md — house header/style reference

### Risks

Deleting a Commit-behavior fact that is NOT in the memo loses a real contract detail — the overlap audit is the safeguard; when in doubt, fold into the memo first.

### Test notes

`uv run pytest tests/ --run-slow` green (no test asserts repo-root CLAUDE.md content — verified); ruff/ty green; `ls -la AGENTS.md` still a symlink.

## Acceptance

- [ ] CLAUDE.md Commit behavior is <= 2 lines (trip-wire + pointer); Skills and agents is a one-line pointer; no orchestration paragraph remains
- [ ] docs/reference/skills-and-agents.md exists in house format, present-tense, no fn provenance, no duplication of the commit memo
- [ ] commit-at-mutation-boundary.md has zero provenance fn-refs and remains self-consistent
- [ ] AGENTS.md symlink intact; full slow suite + ruff + ty green
- [ ] Done summary reports lines and chars deleted (CLAUDE.md char count before/after)

## Done summary

## Evidence

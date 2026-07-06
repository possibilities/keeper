## Description

**Size:** S
**Files:** src/restore-set.ts, test/restore-set.test.ts, README.md, CLAUDE.md, CONTEXT.md, docs/adr/0006-positive-evidence-session-adoption.md

### Approach

Restore surfaces adopted-coordless skips instead of silently dropping them: the topology row lookup exposes the adopted marker, and the coordless-skip path increments a surfaced count/note on the restore result (following the existing fallback-note and excluded-count convention — never a new silent continue). Classification keys on coord-absence plus the marker, harness-agnostic, so a coordless adopted hermes job reports identically to codex. Keep it stdout/report-level — no new exit code unless the existing report shape genuinely cannot carry it (only then does the problem-codes table gain a row). Docs sweep, forward-facing and prune-not-append: consolidate the README harness-tracking narrative to cover self-seeded hermes adoption and gated codex adoption with one clause on pi deliberately not built; one-line CLAUDE.md hermes-shim bullet refinement (self-seeds under the native id only when KEEPER_JOB_ID is absent — keep the lint gate green); CONTEXT.md gains the Adopted-job glossary entry (with the originator ownership discriminator) in the session-surface section; a new MADR-lite ADR records the coordless positive-evidence adoption decision (status, context, decision, consequences — next id 0006).

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/restore-set.ts:1072-1118 — buildCandidatesFromSnapshot: the backend-session fallback :1101 and the silent coordless skip :1105-1107 to surface; resume seam :1112
- src/restore-set.ts:167-186 — isRestorableCandidate + fallbackNote/excludedIdleCount: the surfaced-count convention to mirror
- CONTEXT.md session-surface section + docs/adr/0001-0005 — the glossary entry shape and the MADR-lite template
- README.md harness-tracking narrative sentence — the consolidation target

**Optional** (reference as needed):
- docs/problem-codes.md tabs family — only if a new exit code proves necessary
- bun scripts/lint-claude-md.ts — the CLAUDE.md gate

### Risks

- CLAUDE.md is contended across the open board (doc-only overlaps) — the epic-level dep edges serialize; keep the edit to the single bullet refinement

### Test notes

Restore suite: a coordless adopted row yields the surfaced count and note while coordful adopted rows restore normally; a coordless NON-adopted row keeps today's behavior. Docs verified by the CLAUDE.md linter and the corpus drift gate staying green.

## Acceptance

- [ ] A restore plan over a topology containing coordless adopted jobs reports their count and reason distinctly while restoring everything restorable, and coordful adopted jobs restore like launched ones
- [ ] The README, CLAUDE.md, and CONTEXT.md describe the adoption surface accurately and forward-facing with all doc lint/drift gates green, and an ADR records the adoption model decision
- [ ] The restore fast suite passes with the new classification coverage

## Done summary

## Evidence

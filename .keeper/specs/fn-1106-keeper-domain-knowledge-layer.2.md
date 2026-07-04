## Description

**Size:** S
**Files:** plugins/plan/src/brief.ts, plugins/plan/test/src-brief-claim.test.ts

### Approach

Worker briefs gain a glossary_md field: the target repo's root CONTEXT.md (the repo whose code the worker edits — target_repo when set, else primary_repo), read at brief-assembly time, capped at 16KiB with truncation at a line boundary plus an explicit truncation marker line. Always present in the dict — empty string when the file is absent or unreadable — mirroring snippet_context's stable-key discipline. The brief stays a regeneratable cache: the glossary is re-read on every claim, never folded into any projection. Check for a live Python twin of assembleBrief (the brief surface is described as byte-parity with the planctl port); if one exists, mirror the key and serialization there in the same commit; if none is live, record that finding in the done summary instead.

### Investigation targets

*Verify before relying.*

**Required**:
- plugins/plan/src/brief.ts:24 (readSpecMd missing-file → "" pattern) and :46 (assembleBrief fixed key set; snippet_context precedent; BRIEF_SCHEMA_VERSION)
- plugins/plan/src/verbs/claim.ts:239 and verbs/worker_resume.ts:115 — the callers threading repo context; how target_repo reaches brief assembly
- Python parity surface: search keeper/ (api.py siblings) for an assemble_brief twin before assuming it exists

### Risks

- Multi-repo epics: the wrong repo's glossary is worse than none — resolve target repo per-task, not per-epic.
- Key-set stability: an omitted-when-absent key breaks the stable-key contract; present-but-empty always.

### Test notes

Extend the existing brief/claim tests: absent file → "", present → verbatim, oversize → capped-at-line-boundary with marker, target_repo ≠ primary_repo → target's glossary.

## Acceptance

- [ ] Claimed-task briefs carry glossary_md with the target repo's CONTEXT.md content, empty when absent, capped with a visible truncation marker when oversize
- [ ] The brief key set is stable across presence/absence and byte-parity with any live Python twin (or its absence is verified and recorded)
- [ ] Editing CONTEXT.md requires no re-fold or migration — the field is assembly-time only
- [ ] Plan suite is green

## Done summary
Worker briefs now carry glossary_md: target repo's root CONTEXT.md read at assembly time, capped at 16KiB with line-boundary truncation + marker, present-but-empty when absent. No live Python assemble_brief twin exists (searched keeper/*.py and all .py — the TS assembler under plugins/plan/src is the sole implementation), so no byte-parity mirror was needed; recorded here per the approach.
## Evidence

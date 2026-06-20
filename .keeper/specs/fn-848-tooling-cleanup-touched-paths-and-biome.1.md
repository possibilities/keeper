## Description

**Size:** S
**Files:** plugins/plan/src/store.ts (the touched-paths read/validate path that throws)

### Approach

Find the throw site ("Touched-paths record contains a non-data-dir path" — the loop that
reads `.keeper/state/sessions/<sid>/touched/*.txt` records and validates each path). Make a
record whose path isn't under the resolved data dir (a stale legacy `.planctl/` path, or
otherwise unreadable) SKIP — log once and `continue` — rather than throw, so one stale record
can't wedge the whole op. Keep the path-traversal (`..`) reject as a hard error (that IS a bug
signal); only the non-data-dir case softens to skip. Forward-facing: a stale record is benign
migration residue, not a fault.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/store.ts — recordTouched + the touched-paths reader/validator (the throw on a non-data-dir raw path)

### Risks

- Don't soften the path-traversal (`..`) check — that stays a hard reject.
- Vendored subtree: edit in place; do not restructure the subtree.

### Test notes

- a touched dir containing one stale `.planctl/`-prefixed record + valid records: the op succeeds, skipping the stale one.
- `bun test` under plugins/plan green.

## Acceptance

- [ ] non-data-dir / unreadable touched-paths record is skipped (logged), not thrown; path-traversal still hard-rejects; plugin tests green

## Done summary
Touched-paths reader now logs+skips a non-data-dir record (e.g. stale legacy .planctl/ residue) instead of throwing, so one stale record can't wedge a planctl op; path-traversal stays a hard reject. Updated the unit test to assert skip + added a mixed stale/valid records case.
## Evidence

## Description

**Size:** S
**Files:** CLAUDE.md, AGENTS.md, README.md, tests/test_query_verbs.py + tests/test_restamp_verbs.py (only if a pin proves wrong against real Python output)

### Approach

Run the grown scoped gate against the compiled binary serially and with -n, the new modules against Python, the untouched fast gate, and the full Python conformance run; fix fallout in src/ by preference, never weakening a pin without confirming against real Python output. Revise docs in place: authority-statement bullet gains the grown verb set (or an accurate scope phrase) in CLAUDE.md and AGENTS.md together; gate rows gain the two new modules; README prerequisites and bun-section scope phrases updated. Present-tense only, both mirrors in sync.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md authority statement + Running Things rows (and AGENTS.md mirrors); README.md:16/:34

**Optional** (reference as needed):
- tests/conftest.py — env forwarding, if fallout appears

### Risks

With ~27 verbs meeting five test modules, expect a real long tail; the fix lives in src/.

## Acceptance

- [ ] All gate invocations green (bun serial + -n, Python module set, fast gate, full Python conformance)
- [ ] Docs revised in place, mirrors in sync, gate rows truthful

## Done summary

## Evidence

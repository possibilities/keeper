## Description

**Size:** S
**Files:** CLAUDE.md, AGENTS.md, README.md, tests/test_worker_verbs.py (only if a pin proves wrong against real Python output)

### Approach

Cap the wave. Run the full scoped gate — test_cli.py, test_readonly_verbs.py, test_init.py, test_worker_verbs.py — against the compiled dist/planctl-bun, serially and with -n; the same module set against Python; the untouched Python fast gate and full Python conformance. Fix fallout in the bun implementation by preference (never weaken a pin without confirming against real Python output). Then revise docs in place: the polyglot authority statement in CLAUDE.md and AGENTS.md gains the new verbs and loses the read-only qualifier (no tombstone, no formerly-wording); the bun conformance gate row gets the grown path list and a neutral label; README's prerequisites bullet and bun section get the same treatment. Both files stay in sync.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md:14 and :55 (and the AGENTS.md mirrors) — the exact lines being revised
- README.md:16 and :34 — the read-only characterizations to revise

**Optional** (reference as needed):
- tests/conftest.py — minimal env, if env-coupling fallout appears

### Risks

The long tail of an eight-verb binary meeting four test modules; expect small divergences (error wording, envelope field presence) — the fix lives in src/, not in the harness.

## Acceptance

- [ ] All gate invocations green (bun serial, bun -n, Python module set, Python fast gate, full Python conformance)
- [ ] Docs revised in place, present-tense, both mirrors in sync
- [ ] Canonical gate invocation in the Running Things tables matches reality

## Done summary

## Evidence

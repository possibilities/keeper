## Description

**Size:** S
**Files:** scripts/lint-claude-md.ts, test/lint-claude-md.test.ts, src/commit-work/lint-matrix.ts

### Approach

Reverse the intake valve and add the exhaust gate, following the script's existing
pure-core + thin `main()` shape.

1. Retarget BOTH funnel messages in `scripts/lint-claude-md.ts`: the header docstring
   (line 8, "Architecture/rationale prose lives in README `## Architecture` instead") and
   the failure epilogue (lines 136-142, "Relocate the offending lines there"). New guidance:
   tighten or delete — consolidate into an existing rule, move a local contract into a code
   comment, or drop it; README is NOT a relocation target. If either message survives
   verbatim anywhere, agents keep re-growing README.
2. Add a pure `scanReadme(text: string)` (exported, parallel to `scanText`) enforcing
   `README_MAX_LINES = 250` and `README_MAX_BYTES = 24576` hard caps (no warn tier), plus
   the content fingerprints (fn-ids, dates, version numbers, past-tense provenance) so
   incident history cannot re-accrete. Reuse the existing fingerprint regexes/false-positive
   guards rather than duplicating them; boundary semantics (strict `>`, line counting) must
   match `scanText` (:66-102) exactly.
3. `main()` gains a second `readFileSync` for README.md, guarded by `existsSync` (mirror
   lint-matrix.ts:392's pattern). The two-file scan coupling is accepted by design: a
   README over cap blocks CLAUDE.md-staged commits too — that is the gate working.
4. Extend the commit-time trigger in `src/commit-work/lint-matrix.ts:389-407` so the
   order-10 task also fires when README.md is staged (extend the staged-files condition or
   add a sibling entry — match the file's existing style; keep the existsSync(script) guard
   so non-keeper repos are unaffected).
5. Extend `test/lint-claude-md.test.ts` with `scanReadme` fixture cases in the existing
   no-fs style: clean pass, over-line, over-byte (multibyte content so bytes≠chars),
   each content-fingerprint class, boundary-exact pass. Use cap messages distinct from the
   CLAUDE.md ones (e.g. "exceeds the 250-line cap") and assert them. Also pin the new
   tighten/delete epilogue wording with one assertion so the funnel reversal can't silently
   regress.

Task 1 has already landed README under both caps, so the gate goes green on arrival —
never land the gate in a state where the live README fails it.

### Investigation targets

**Required** (read before coding):
- scripts/lint-claude-md.ts — whole file (~150 lines): consts :29-31, scanText :66-102, main :114+, epilogue :136-142
- test/lint-claude-md.test.ts — fixture style + message assertions (:38,:49)
- src/commit-work/lint-matrix.ts:389-407 — the CLAUDE.md-staged trigger to extend

**Optional** (reference as needed):
- package.json:15 — the `lint:claude-md` npm script (name stays; it now covers both files)

### Risks

- Content fingerprints on README may false-positive on legitimate front-door prose (e.g. a literal `SCHEMA_VERSION` identifier) — carry over the existing false-positive guards and add fixture cases for any new ones.

### Test notes

`bun test test/lint-claude-md.test.ts` green; `bun scripts/lint-claude-md.ts` exits 0
against the real trimmed files; temporarily padding README past 250 lines makes it exit
non-zero (manual smoke, don't commit the padding).

## Acceptance

- [ ] Neither the docstring nor the epilogue of scripts/lint-claude-md.ts directs prose to README; new guidance is tighten/delete
- [ ] Exported pure `scanReadme` enforces 250-line + 24576-byte hard caps and the content fingerprints; `main()` scans README when present
- [ ] Commit-time lint fires when README.md is staged (with or without CLAUDE.md)
- [ ] Fixture tests cover scanReadme pass/over-line/over-byte/fingerprint/boundary and pin the new epilogue wording; `bun test` green
- [ ] `bun scripts/lint-claude-md.ts` exits 0 on the repo as landed

## Done summary

## Evidence

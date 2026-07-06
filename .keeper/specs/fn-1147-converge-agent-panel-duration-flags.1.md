## Description

Finding F1 (audit `Consider`, src/pair/panel.ts): `panel start --timeout`
(parsed at line ~1831 via `Number(parsed.values.timeout)`) and
`panel wait --chunk` (line ~1979 via `Number(parsed.values.chunk)`) remain
bare-seconds while the source epic converged every other duration flag to
the unit-required grammar in `cli/duration.ts`. Verified at audited sha
6d0966ad that neither flag routes through that shared parser.

Route both flags through the shared `cli/duration.ts` `parseDuration` grammar
(it lives in `src/`-reachable CLI code, not a hook, so the import is
unconstrained), preserving the existing `MAX_CHUNK_SECONDS` ceiling and the
per-leg stop-timeout ms translation panel already performs.

Files: `src/pair/panel.ts` (arg parsing for `start`/`wait` + the USAGE/help
text at ~line 1750), `cli/duration.ts` (the shared grammar to import).

## Acceptance

- [ ] `panel start --timeout 5m` and `panel wait --chunk 30s` parse via the
      shared grammar; unitless values are rejected with the shared hint
- [ ] `MAX_CHUNK_SECONDS` ceiling and the per-leg stop-timeout ms translation
      still hold
- [ ] Help/usage text for both flags states the unit-required grammar

## Done summary
Routed panel start --timeout and panel wait --chunk through the shared cli/duration.ts parseDuration grammar (unit-required, self-healing hint on bare numbers); updated help/usage text; preserved MAX_CHUNK_SECONDS ceiling and the ms stop-timeout translation.
## Evidence

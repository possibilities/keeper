## Overview

The prompt plugin's differential-parity suite (plugins/prompt/test/parity.test.ts) compares
engine output byte-for-byte against goldens captured from the retired Python promptctl. Two
deliberate changes moved the world out from under those frozen captures: the corpus hygiene
sweep deleted/edited snippets the goldens reference, and the check-generated root-resolution
fix changed the envelope the goldens pinned (they now pin the old bug). Result: 28 render-parity
and 40 check-generated-parity failures with zero real regressions — every other prompt suite is
green. The port the suite guarded is long complete; convert it from Python-parity to a
regression-pin snapshot suite of the current engine.

## Quick commands

- `cd plugins/prompt && bun test` — fully green when done

## Acceptance

- [ ] Goldens re-recorded from the current engine over the current corpus; fixtures for deleted refs pruned
- [ ] The suite header and capture tooling describe the regression-pin role (Python-parity framing retired)
- [ ] Harness-integrity half of the suite retained; full prompt suite green on main

## Early proof point

Task `.1`. If re-recording proves unsound for some fixture class, prune that class with rationale rather than hand-editing bytes.

## References

- plugins/prompt/test/parity.test.ts — suite header documents the original two-half design
- plugins/prompt/test/oracle/{capture.ts,fixture-types.ts,normalize.ts,fixtures/}
- Evidence: main fails 29/164 in parity.test.ts after the corpus sweep; the epic lane adds 40 check-generated envelope divergences that are the intended fix

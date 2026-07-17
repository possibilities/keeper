## Overview

The daemon-restart honest-verdict CLI reads the boot ledger through a
private, hardcoded home path instead of the canonical resolver, so a
supported `KEEPER_RESTART_LEDGER` override makes the reader miss the fresh
boot and invert the verdict (reporting failure on a genuinely successful
restart). Alongside the path fix, the honest-verdict machinery's two most
correctness-critical paths are untested: the real ledger parse (stubbed in
every case) and the "healthy probes but a stale, non-fresh boot" branch that
must resolve to a timeout rather than a false success. This follow-up routes
the reader through the canonical path resolution and closes both coverage
gaps so the verdict stays honest under every supported config.

## Acceptance

- [ ] The restart-verb ledger reader resolves its path through the same
      override-honoring resolution the daemon writer uses, so writer and
      reader agree under `KEEPER_RESTART_LEDGER`.
- [ ] The stale `SOLE reader/writer` invariant comment is corrected to
      reflect the CLI as a second (path-shared) reader.
- [ ] The real ledger parse is exercised by a unit test (torn trailing line,
      interleaved non-boot lines, last-valid-boot-wins).
- [ ] A test asserts that an exit-0 kickstart with healthy probes but a
      never-fresh boot resolves to `health-timeout` (not success, not
      kickstart-failed).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/restart.ts:244 hardcodes the home ledger path, bypassing resolveRestartLedgerPath() (src/db.ts:5089) which honors KEEPER_RESTART_LEDGER; under the override the reader misses the fresh boot and inverts the verdict, and src/db.ts:5087 SOLE-reader comment is now stale. |
| F2 | culled | — | Advisory missing-ADR for the verdict-semantics shift; no user-facing impact and the change is captured in commit + code, so it does not clear the keep bar. |
| F3 | culled | — | Hand-rolled NDJSON parse vs parseRestartLedgerLine (src/daemon.ts:5094) is theoretical drift; both parsers agree on the current boot-line shape and the honest fix is the path (F1), not a parser-extraction refactor. |
| F4 | culled | — | Speculative-generality micro-nit to inline the retainedKickstart intermediate (cli/restart.ts:360); zero user impact and no correctness change. |
| F5 | kept | .1 | cli/restart.ts:240 readLatestBoot (real file read, per-line parse, torn-tail, last-valid-wins) is stubbed in every test; it is the honest-verdict evidence gate and a parse bug yields a wrong verdict. |
| F6 | kept | .1 | The exit-0 healthy-probes-but-stale-boot -> health-timeout path (cli/restart.ts:376-422) is untested; the existing health-timeout test uses never-healthy probes, so the epic's core do-not-trust-a-stale-daemon branch is unexercised. |

## Out of scope

- Extracting a shared NDJSON ledger parser between the CLI and daemon (F3) — the two parsers agree on the current boot-line shape; revisit on the next boot-line shape change.
- An ADR note for the verdict-semantics shift (F2) and inlining the retainedKickstart intermediate (F4) — both culled as sub-threshold.

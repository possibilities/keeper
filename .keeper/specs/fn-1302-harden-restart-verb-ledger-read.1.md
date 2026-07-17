## Description

Three related defects in the daemon-restart honest-verdict CLI, all in
`cli/restart.ts` and its test suite, landing as one commit.

F1 (bug): `readLatestBoot` at `cli/restart.ts:240` hardcodes
`join(homedir(), ".local","state","keeper","restart-ledger.json")`
(line 244), bypassing `resolveRestartLedgerPath()` at `src/db.ts:5089`,
which the daemon writer uses and which honors the `KEEPER_RESTART_LEDGER`
override (also set by the test sandbox, `test/helpers/sandbox-env.ts:132`).
Under the override the reader looks at the default-home ledger, never sees
the fresh boot, and reports `kickstart-failed`/`health-timeout` on an
actually-successful restart — the inverse of the honest-verdict goal.
Route the reader through the canonical resolution (import
`resolveRestartLedgerPath()` or a shared pure copy) so writer and reader
agree. The `Main is the SOLE reader/writer` comment at `src/db.ts:5087` is
now false (the CLI is a second reader); update it to reflect the shared
path.

F5 (test gap): every test injects `readLatestBoot` via deps, so the real
file read + per-line parse + `kind`/`boot_id`/`ts` filtering + torn-tail
`catch` + last-valid-boot-wins (`cli/restart.ts:240-268`) is never
exercised. A parse bug here silently produces a wrong verdict. Add a unit
test over the real parse with a malformed/torn trailing line and
interleaved non-`boot` lines, asserting the last valid boot wins.

F6 (test gap): the exit-0 + healthy-probes + never-fresh-boot path that
resolves to `health-timeout` (`cli/restart.ts:376-422`) is untested — the
existing `health-timeout` test uses probes that are never healthy, so the
"healthy but stale daemon must not be reported as success" branch (the
epic's core promise) is unexercised. Add a case: kickstart exit 0, probes
healthy, boot stays stale -> `code: "health-timeout"`.

Files: `cli/restart.ts`, `src/db.ts` (comment), `test/restart-cli.test.ts`
and/or `test/restart-verb.test.ts`.

## Acceptance

- [ ] `readLatestBoot` resolves the ledger path through the same
      override-honoring resolution the daemon writer uses; a set
      `KEEPER_RESTART_LEDGER` points reader and writer at the same file.
- [ ] `src/db.ts:5087` no longer claims a sole reader/writer; it reflects
      the CLI reader on the shared path.
- [ ] A unit test exercises the real ledger parse (torn trailing line,
      interleaved non-boot lines, last-valid-boot-wins).
- [ ] A test asserts exit-0 kickstart + healthy probes + never-fresh boot
      -> `health-timeout`.
- [ ] Existing restart-verb tests stay green.

## Done summary
Routed cli/restart.ts's readLatestBoot through resolveRestartLedgerPath() so a KEEPER_RESTART_LEDGER override reaches both writer and reader; corrected the stale sole-reader/writer comment in src/db.ts; added a real-ledger-parse test (torn line, interleaved non-boot lines, last-valid-boot-wins) and a healthy-probes-but-stale-boot -> health-timeout test.
## Evidence

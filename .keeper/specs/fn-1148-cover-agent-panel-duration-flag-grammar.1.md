## Description

Finding F1 (auditor Consider / Test Gaps). Evidence path:
`test/agent-panel-cli.test.ts` at commit 131b9872 — grep shows no
`--timeout` token anywhere in the suite, and the only test edits for this
epic were four suffix-only literal bumps (`540`->`540s`, `9999`->`9999s`).
The unit-required rejection (exit 2 + self-healing hint) shipped in
`src/pair/panel.ts` (`runPanel`, the `parseDuration(...) -> if (!dur.ok)
write + exit(2)` blocks for both `--timeout` at start and `--chunk` at
wait) is exercised only indirectly (a `9999s` case trips the
MAX_CHUNK_SECONDS ceiling, a `540s` case passes) — the unitless-rejection
path itself is never directly asserted.

Files:
- `test/agent-panel-cli.test.ts` — add the missing CLI-level cases.

Add: (1) a `panel wait --chunk <unitless>` case asserting exit 2 with the
"needs a unit" hint on stderr; (2) a `panel start --timeout <unitless>`
case asserting exit 2 with the same hint; (3) a `panel start --timeout
<dur>` happy-path case asserting the accepted unit maps to the correct
`stopTimeoutMs`. Reuse the existing stdout+exit capture harness; keep the
test-budget ratio lean (no over-testing).

## Acceptance

- [ ] `--chunk <unitless>` exits 2 and stderr carries the self-healing unit hint
- [ ] `--timeout <unitless>` exits 2 and stderr carries the self-healing unit hint
- [ ] `--timeout <dur>` happy path asserts the accepted unit maps to the correct stop-timeout ms
- [ ] `bun test test/agent-panel-cli.test.ts` is green

## Done summary

## Evidence

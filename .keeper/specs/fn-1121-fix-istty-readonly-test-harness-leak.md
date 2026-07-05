## Overview

Under a shared-process `bun test` run at the repo root, ~578 plan-suite tests
fail with `TypeError: Attempted to assign to readonly property`. Root cause:
`test/setup-tmux.test.ts` redefines `process.stdout` / `process.stdin` `isTTY`
via `Object.defineProperty(..., { value, configurable: true })` — omitting
`writable`, which defaults to `false` — leaving a non-writable global; the plan
harness `plugins/plan/test/harness.ts` `setTTY` then bare-assigns `stream.isTTY`,
which throws against that readonly property. The sanctioned `bun run test:full`
isolates each suite in its own process, so it is green and the buildbot is
unaffected — this is a raw-`bun test` developer-ergonomics fix. Fix both ends so
no suite leaves a non-writable global and the harness writes defensively.

## Quick commands

- `bun test 2>&1 | grep -c 'readonly property'` → expect `0`
- `cd plugins/plan && bun test` → stays green

## Acceptance

- [ ] Raw `bun test` at the repo root reports zero `readonly property` errors.
- [ ] No test leaves `process.stdout` / `process.stdin` `isTTY` as a non-writable global.
- [ ] The sanctioned suites (`bun run test`, `cd plugins/plan && bun test`) remain green.

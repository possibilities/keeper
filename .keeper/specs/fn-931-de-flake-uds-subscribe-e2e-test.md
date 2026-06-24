## Overview

The keeper end-to-end test "UDS subscribe server — query→result, then
patch after a fold" (test/integration.test.ts) fails intermittently in CI.
Roughly one in three recent `test:full` builds go red on ONLY this test
(buildbot builds 516 fail, 517 fail, 518/519/520 pass, 521 fail; build 521
= 4244 pass / 1 fail). The suite is otherwise green. End state: this test is
stable so `bun run test:full` is reliably green and the keeper builder stops
flapping. Surfaced by the builds babysitter (finding test-failure:test_full:keeper).

## Quick commands

- `cd ~/code/keeper && for i in $(seq 1 25); do bun test test/integration.test.ts -t "UDS subscribe" 2>&1 | tail -1; done`  # 25x green = stable

## Acceptance

- [ ] Root cause identified: test-side deadline/race vs. server delivery-ordering race
- [ ] The UDS subscribe e2e test passes reliably across repeated runs (no flake)
- [ ] `bun run test:full` green; keeper builder no longer flaps on this test

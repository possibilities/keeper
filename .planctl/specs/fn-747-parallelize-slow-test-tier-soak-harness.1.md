## Description

**Size:** S
**Files:** scripts/soak-slow-tests.ts (new), package.json

### Approach

Two coupled changes that land together and are verified by running the
new harness:

1. **Add `scripts/soak-slow-tests.ts`** — `#!/usr/bin/env bun`,
   executable, matching the repo's Bun-native `scripts/*.ts` convention
   (NOT a `.sh` — that would be the repo's first shell script and drag in
   shellcheck). It runs the slow tier N times (default 20; override via
   argv/env), **sequentially** (parallel iterations would multiply socket
   collisions and become a flake source themselves), **run-all** (don't
   stop on first fail — a full N gives a flake-RATE, e.g. 2/20, not just
   a yes/no), with an optional `--bail`/stop flag. Each iteration shells
   a fresh `bun test <slow-tier files>` via `Bun.spawn` (NOT
   `bun test --rerun-each`, which has a known beforeEach/afterEach count
   bug, oven-sh/bun#13493), captures exit code + elapsed + stderr to a
   per-run log file, prints a per-run line, and ends with a summary
   table (Runs / Passes / Fails / which runs failed / PASS|FLAKY).
   **Exit non-zero iff any iteration failed.** Mirror
   `scripts/backstop-stats.ts` aggregation/reporting style.
2. **Flip `test:slow`** in `package.json` to add `--parallel` across the
   3 files, and add a `test:soak` npm script invoking the harness.
3. **Verify by soaking** ≥20x with 0 failures before considering done.

### Investigation targets

**Required** (read before coding):
- package.json:11-16 — the `test:*` block; `test:slow` is the line to flip, `test` is the umbrella to keep accurate
- scripts/backstop-stats.ts — Bun `.ts` reporter shape + aggregation style to mirror
- .planctl/specs/fn-722-fast-two-tier-keeper-test-gate.md (and `.1`) — the plan-worker `@parcel/watcher` `--parallel`-panic carve-out: the exact premise this task must re-verify
- test/helpers/wait-for-daemon.ts — why the slow tier carries 30s boot ceilings (contention sensitivity); informs why soak gates on pass/fail, not timing

**Optional** (reference as needed):
- test/helpers/sandbox-env.ts — the six-path sandbox; the harness only shells `bun test`, so it inherits the test files' own sandboxing and must NOT invent its own un-sandboxed daemon spawn
- src/plan-worker.ts:23-51 — `@parcel/watcher` external-resource ownership (the native addon in question)

### Risks

- **plan-worker may panic under `--parallel`** — the documented reason
  (9558382) it was made serial. Lighter 3-file load + Bun 1.3.14's
  parallel/isolate fix mean it MAY be clean now, but the soak must prove
  it. **Fallback:** parallelize `integration`+`daemon` only, keep
  `plan-worker` serial (e.g. `test:slow` =
  `bun test --parallel test/integration.test.ts test/daemon.test.ts && bun test test/plan-worker.test.ts`),
  and point the harness at the final tier composition.
- **Contention-driven wall-time spikes** — fn-722.7 saw the tier slip
  10s→36s under box load. The harness must gate on pass/fail ONLY; treat
  timing as informational, never a hard threshold.
- **Real-feed pollution** — safe only because the slow test files
  self-sandbox the six `KEEPER_*` state paths. The harness must not spawn
  its own daemon; it only reruns `bun test`.

### Test notes

- Verification IS the soak: ≥20 consecutive runs, 0 failures; paste the
  summary table as Evidence. Mirror the repo's existing
  "0 flakes over N consecutive runs" vocabulary (fn-722 / fn-683).
- Confirm the full `bun run test` umbrella stays green after the flip.

## Acceptance

- [ ] `scripts/soak-slow-tests.ts` exists, `#!/usr/bin/env bun`, executable; runs the slow tier N times (default 20) sequentially, run-all, per-run + summary output, exits non-zero on any failure
- [ ] `test:soak` npm script added; `test:slow` runs `--parallel` over the verified-safe tier composition (all 3, or integration+daemon parallel + plan-worker serial if the soak shows plan-worker panics)
- [ ] A ≥20-iteration soak completes with 0 failures (summary table in Evidence)
- [ ] `bun run test` umbrella green
- [ ] No README/CLAUDE.md prose left asserting the slow tier is inherently serial (light touch — fix only a sentence that now reads false)

## Done summary

## Evidence

## Overview

The buildbot `keeper` builder flaps red on `test:full` near-daily (30 red onsets since Jun 24 per the builds sitter). Root cause, verified from build logs + repo: five root-suite tests exceed the 10s per-test ceiling (`package.json:18` `--timeout=10000`) under host contention — timeout kills, not assertion failures — plus one plan-suite subprocess race (stop-guard, fails at 5.4s under a 30s budget). End state: the named tests are structurally robust under load, the fast tier keeps its tight hang-detection budget, and the builder stops crying wolf.

## Quick commands

- `bun run test` — fast tier stays green and fast (no usage-picker heavy loops left in it)
- `KEEPER_RUN_SLOW=1 bun test test/usage-picker.slow.test.ts` — the relocated distribution proofs pass
- `cd plugins/plan && bun test test/stop-guard.test.ts --rerun-each 20` — the de-raced ladder test survives a sweep

## Acceptance

- [ ] The six named tests stop appearing as red-step causes on the buildbot `keeper` builder for 7 consecutive days post-land
- [ ] Root suite `--timeout=10000` is unchanged (no global widening; scoped per-test 3rd-arg budgets only, each with a one-line rationale)
- [ ] The weighted-balancing proportionality band (4.5–5.5) and iteration counts are preserved wherever the proofs run

## Early proof point

Task that proves the approach: ordinal 1 (usage-picker two-tier split — the repeat offender). If the slow-tier relocation doesn't fit, fall back to scoped per-test timeout bumps on the four heavy loops.

## References

- Builds-sitter triage evidence (2026-07-01): builds #1203/#1209/#1210 failed-step logs; the builder runs `bun run test:full` WITHOUT `--slow`, so `.slow.test.ts` files are excluded from the flapping lane
- `test/pair-panel.slow.test.ts` — the existing `KEEPER_RUN_SLOW` slow-tier gate precedent
- `scripts/test-full.ts` — tier plumbing (`KEEPER_RUN_SLOW`/`KEEPER_PLAN_RUN_SLOW` injection, per-suite 300s budgets)
- fn-931 (closed) — prior de-flake; its retryUntil lever does NOT generalize to these six synchronous tests

## Docs gaps

- **CLAUDE.md `## Test isolation`**: only if a new named helper or the slow-sibling pattern is minted — one imperative peer bullet with the file path (must pass `bun scripts/lint-claude-md.ts`)
- **README.md test-infrastructure paragraph (~694–730)**: one-sentence revise-in-place if a new helper is named

## Best practices

- **Two-tier statistical proofs:** keep a cheap deterministic check in the per-PR gate, run the large-N distribution proof in the slow lane [Gradle/minware/Datadog convergent guidance]
- **A retry-pass is a flake by definition:** if a rerun lane is ever added, record retried tests, never let retries silently green the build [trunk.io]
- **Don't cut N to save wall-clock:** the flap is time, not variance — reduce per-iteration cost or relocate the proof instead [triage verification: picker is deterministic, no Math.random]

## Overview

The fast `bun run test` tier is ~11s, and two of its long poles are single
real-OS-process tests that don't belong in a fast unit tier:
`usage-picker.test.ts`'s real multi-process flock-contention test (~5.5s, spawns 30
child processes) and `agent-tmux-launch.test.ts`'s `defaultTmuxCommandRunner(["sleep","30"])`
timeout-classification test (~5s, blocks the product's real 5s spawn-timeout floor).
Both are genuine integration tests miscategorized into the fast tier — the rest of
each file already runs in-process and is fast. Extract each to its own
`*.slow.test.ts` (mirroring the existing `agent-tmux-launch-stripped-env.slow.test.ts`
precedent) and add it to the fast-tier ignore-list. End state: fast tier drops from
~11s toward ~6s, with zero coverage loss — both tests still run under `bun run test:full`.

## Quick commands

- `KEEPER_TEST_NO_GATE=1 bun run test 2>&1 | tail -3` — fast tier wall-clock (target: ~6s, was ~11s)
- `KEEPER_TEST_NO_GATE=1 bun test test/usage-picker-flock.slow.test.ts test/agent-tmux-launch-timeout.slow.test.ts` — extracted tests still pass
- `bun run test:full` — stays green (the slow files auto-run here)
- `bun run test:hygiene` — real-git allowlist guard stays green (no entries added)

## Acceptance

- [ ] Fast-tier `bun run test` wall-clock drops to roughly ~6s (from ~11s)
- [ ] The flock test and the tmux `sleep 30` timeout test each live in their own `*.slow.test.ts`, removed from their fast files, and pass under `test:full`
- [ ] Both new `*.slow.test.ts` files added to the fast `test` script's `--path-ignore-patterns`; NEITHER added to `scripts/test-real-git-allowlist.txt` (no git spawns)
- [ ] `bun run test`, `bun run test:full`, `bun run test:hygiene` all green; no fast test lost (only the two real-process tests moved tiers)

## Early proof point

Task that proves the approach: `.1`. Extract the usage-picker flock test first and
re-time the fast tier. If the drop isn't ~5s, the cost attribution is wrong — re-measure
per-test before extracting the tmux one.

## References

- `test/agent-tmux-launch-stripped-env.slow.test.ts` — the canonical "one heavy test split out of a fast file" precedent (own header comment, own gate, own teardown)
- `test/usage-scrape-runner.slow.test.ts` — second `*.slow` precedent (host-capability gate)
- `test/usage-picker.test.ts:386-426` — the flock test + its `beforeEach`/`afterEach` (L41-60: tmpdir, `setStateDir`, `XDG_CONFIG_HOME`) and helpers (`writeConfig`/`writeEnvelope`/`readCounts`) the extracted file must carry; `test/fixtures/pick-once.ts` is the child entrypoint (stays put)
- `test/agent-tmux-launch.test.ts:682-694` — the `defaultTmuxCommandRunner(["sleep","30"])` test; imports `defaultTmuxCommandRunner` from `src/agent/tmux-launch.ts`
- Overlap with `fn-952` (tmux control-mode) — both edit `package.json` test-script `--path-ignore-patterns`; wired as a dep to avoid a concurrent same-file conflict

## Docs gaps

- **CLAUDE.md** "Test isolation" + **README.md** test-infrastructure paragraph: the `*.slow.test.ts` rule reads as whole-file demotion; this epic is the canonical case of extracting an INDIVIDUAL slow case into a `*.slow` sibling while the rest of the file stays fast. Tighten the wording in place (no new paragraph).

## Best practices

- **Move, don't skip:** extract the test body unchanged into `*.slow.test.ts` — never `test.skip`/comment-out (a skipped test runs nowhere; a slow-tier test runs in `test:full`). [tiering guidance]
- **A flock/multi-process test has no in-process substitute:** it IS the thing under test (proving two OS processes respect one lock), so demotion — not mocking — is the only correct lever. [practice-scout]
- **The 5s tmux timeout is a product floor** (`TMUX_DEFAULT_TIMEOUT_MS`), not a test inefficiency — can't be tuned away, so demote the test. [repo-scout]

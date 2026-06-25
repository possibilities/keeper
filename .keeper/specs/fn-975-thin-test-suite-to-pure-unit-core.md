## Overview

Make the `bun test` suite watchdog-free by construction: no test boots real
infrastructure (daemon, Worker thread, UDS socket, real subprocess, real git
or tmux), and no test can enter a synchronous CPU spin. A sync spin blocks
Bun's event-loop-based `--timeout` so it can hang a run indefinitely — only an
external watchdog could catch it, and the project has chosen not to add one.
The answer is removal: delete the infra-boot tests and the whole slow-tier
machinery, bound the one helper that can spin, and accept reduced coverage with
production as the integration safety net (keeper is high-velocity; integration
regressions surface fast in prod). The two test scripts collapse into a single
fast pure-in-process tier.

## Quick commands

- `bun test 2>&1 | tail -3` — the single fast tier, green, well under target wall-time
- `for i in $(seq 1 20); do timeout 120 bun run test 2>&1 | tail -1; done` — stress loop proving zero hangs/spins under repetition and real load

## Acceptance

- [ ] No test in the suite boots a real daemon / Worker thread / UDS socket / real subprocess / real git / real tmux
- [ ] No unbounded synchronous loop remains in the suite's hot helpers (the `drainAll` spin is bounded to throw on a non-advancing fold)
- [ ] The `.slow.test.ts` tier and its machinery are gone (allowlist, `lint-no-real-git`, `test:hygiene`, the `test` script's path-ignore list)
- [ ] `test` and `test:full` collapse to one fast tier (only the `test:opentui` split remains)
- [ ] The three hooks (events-writer, sidecar-writer, branch-guard) keep pure in-process tests of their decision logic
- [ ] CLAUDE.md Test-isolation + README Architecture test narrative rewritten to the new model; `bun scripts/lint-claude-md.ts` green
- [ ] The full suite runs 20×+ under real load with zero hangs/spins, all green

## Early proof point

Task that proves the approach: `.1` (bound the `drainAll` sync-spinner). If the
cursor-non-advance guard false-fails a legitimate long migration, fall back to a
generous absolute iteration ceiling as the bound instead of the non-advance check.

## References

- The lock-free test gate (`--parallel=5` + `--no-orphans`) and the 10s global per-test timeout already landed this session; this epic builds on that lock-free, bounded-timeout base.
- Overlapping epics wired as deps below — both touch `package.json` test scripts / add an infra-style test this epic's rules ban.

## Docs gaps

- **CLAUDE.md `## Test isolation`**: prune/rewrite — the two-tier + `test:full`-mandatory, `.slow.test.ts` extraction, no-real-git allowlist, and (if orphaned) poll-don't-sleep bullets become false.
- **README.md `## Architecture`**: prune the two-tier / `.slow` / `test:hygiene` / allowlist narrative; also fix the already-stale "parallel=4 behind a host-wide flock" line.
- **plugins/plan/CLAUDE.md "Running Things"**: assess only — the plan plugin's `test:slow` is an independent `KEEPER_PLAN_RUN_SLOW` mechanism and is OUT of scope; leave it unless it cross-references the keeper-root tiers.

## Best practices

- **Delete from the top of the pyramid:** prune infra/E2E first, keep the fast in-process core — the inverse of the ice-cream-cone anti-pattern.
- **A synchronous spin defeats every in-process timeout** (Bun #32056): the fix for a pure-unit suite is to bound/delete the spinning code, never to add a watchdog.
- **Consolidate survivors into `test.each`** where multiple tests vary one pure input — coverage held, file count down.

## Overview

Two correctness/documentation fixes surfaced by the inline audit of
`fn-576-job-liveness-detection`. The dominant work fixes a real
user-visible regression: when a `killed` row is resumed via
`UserPromptSubmit` with a new pid, the persisted `start_time` stays
stale, so the next daemon boot's seed sweep emits a synthetic `Killed`
that the reducer folds — silently killing a healthy resumed session
that the default jobs view (introduced by fn-576 task `.5`) then hides.
The rider task fixes a JSDoc that contradicts its own implementation
(and would silently break a future refactor of the Darwin `ps` probe).

## Acceptance

- [ ] A `killed` row resumed via `UserPromptSubmit` with a new pid no
      longer gets re-folded to `killed` by the seed sweep on the next
      daemon boot.
- [ ] The reducer test that codified the bug-prone intermediate state
      (`test/reducer.test.ts:492-510`) asserts the corrected end state
      (`start_time === null` after pid change), and a new cross-boot
      integration test reproduces the full kill → UPS-resume → restart
      → drain chain and asserts the resumed row stays `working`.
- [ ] `scrapeSpawnInfo`'s JSDoc at `events-writer.ts:212` matches the
      actual `ps -o lstart=,args=` invocation and correctly states
      that `lstart` is the 24-char fixed-width PREFIX.
- [ ] `bun test` green; no Q7 invariants weakened (no liveness reprobe
      in the reducer, no terminal-guard bypass, no new write path).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| f-001 (stale-start-time-after-ups-resume) | kept | .1 | User-visible: resumed working session silently disappears from default jobs view post daemon bounce; chain verified end-to-end against `reducer.ts:594-600`, `seed-sweep.ts:226-234`, `reducer.test.ts:492-510`. |
| f-002 (docstring-ps-column-order-wrong) | kept | .2 | `events-writer.ts:212` docstring states `args=,lstart=` but `:230` uses `lstart=,args=`; the qualifier "lstart is 24-char fixed-width at the end" is also wrong (it is the PREFIX). Misleads next reader of `splitArgsLstart`. |

## Out of scope

- The four tier-0 findings from the classifier verdict (verifier vs
  reducer loose-match divergence, unused `SYS_pidfd_open_aarch64`
  constant, glibc-hardcoded `dlopen` name, Linux pidfd drop-pass fd
  window). Each was reviewed in `/plan:close` and judged below the
  bar: no user-visible consequence, behavior correct on the actual
  deployment targets, fd count bounded by live processes. The full
  reasoning is persisted on `jobs.closer_verdict` for the source
  epic.
- Adding a kqueue/pidfd self-heal or watchdog. Out of scope; the
  single-recovery-path LaunchAgent invariant governs.
- Any change to the `Killed` event payload shape, the schema, or the
  reducer's terminal-state guards. Both fixes are local: task .1
  adjusts an UPDATE statement in the `UserPromptSubmit` fold; task
  .2 changes only a JSDoc comment.

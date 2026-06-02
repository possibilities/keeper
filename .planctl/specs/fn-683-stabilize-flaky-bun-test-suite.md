## Overview

keeper's lint, type, and Python suites are green, but the full
`bun test --isolate` run carries two non-deterministic failure clusters
that keep it from being reliably green. This epic eliminates both:
(1) leaked `victim-launcher` processes from the integration e2e tests that
spin at high CPU and cascade into timeout flakes, and (2) a `@opentui/core`
native top-level-await TDZ that errors when two test files cold-load the
native binding in one process. A poisoned Bun transpiler cache and an
in-flight fn-678 commit were resolved out-of-band; these two clusters are
all that remains between the suite and reliably-green.

## Quick commands

- `bun test --isolate` — full suite; target is 0 fail / 0 errors across repeated runs
- `bun test --isolate test/ansi-to-styled.test.ts test/live-shell.test.ts` — minimal @opentui repro (Task 2)
- `bun test test/integration.test.ts; pgrep -f victim-launcher.ts` — e2e run + leaked-process check (Task 1)

## Acceptance

- [ ] Full `bun test --isolate` is green (0 fail, 0 errors) across 5 consecutive runs
- [ ] No leaked victim-launcher processes remain after integration runs
- [ ] 0 "Cannot access 'default'" occurrences in full-suite output

## Early proof point

Task that proves the approach: `.1` (victim reap) — it is the dominant
flake driver and has a known fix shape; landing it should swing the e2e
suite to consistently green. If it fails: the leak is not the whole story
and the e2e deadlines need a deeper race investigation.

## References

- Bun `--isolate` semantics: "Run each test file in a fresh global object" (same process; `--parallel` is separate processes).
- @opentui/core 0.3.0 native loader TLA at zig.ts:67-68 (via sourcemap). Verified non-fixes: 0.3.1 bump, `--parallel`.

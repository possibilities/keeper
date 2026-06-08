## Overview

Delete the OS-coupled slow tests so the whole suite runs as ONE fast
`--parallel` tier (<8s target). fn-747 proved the slow tier
(`integration`/`daemon`/`plan-worker`) can't be made 0-flake under
`--parallel`: a handful of tests assert OS/runtime behavior (macOS FSEvents
delivery, `@parcel/watcher` native-addon dlopen/teardown, real subprocess
SIGTERM/SIGKILL, reflog-watch latency races) rather than keeper's own logic.
Those seams are ALREADY unit-tested in the fast tier (reducer folds,
transcript `scanFile`/`scanJobsForTitles` + line parser, PlanScanner, hook
append/ingest, exit-watcher FFI). Stance: the OS is not our application —
delete the OS coverage outright (no smoke/soak lane); keeper is dogfooded
continuously so low-level regressions surface immediately. The one piece
worth preserving is the fn-737 reflog watch-SET WIRING (which repos get
watched) — dogfooding can't catch a boot-subscribe regression — so extract
it to pure helpers and unit-test it before deleting its live tests.

## Quick commands

- `bun run test` — the whole suite, `--parallel`, green, target <8s
- `bun test test/plan-worker.test.ts` — pure seam unit tests included

## Acceptance

- [ ] fn-737 reflog watch-set wiring extracted to pure helpers + unit-tested (no Worker/watcher/real-git)
- [ ] All OS-coupled tests deleted (subprocess-daemon e2e, FSEvents/watcher smokes, spawned-Worker, fn-737 latency/lever); each deletion's OUR-logic coverage cited as surviving elsewhere
- [ ] `package.json` runs a single `--parallel` `test` (+ a separate `test:opentui` phase — the OpenTUI ignores stay); `test:slow`/`test:soak` and `scripts/soak-slow-tests.ts` gone
- [ ] `bun run test` green over repeated runs (0 flakes); wall-time measured + reported, <8s target
- [ ] Stale test-tier doc comments fixed; CLAUDE.md Test-isolation section trimmed

## Early proof point

Task that proves the approach: `.1` (extract the fn-737 reflog seam to pure
helpers with NO behavior change, existing live tests still green). If
`reconcileReflogWatches` can't be split cleanly without changing runtime
behavior: fall back to extracting only `resolveReflogTarget` +
`discoverPlanctlRepos` (the cheap pure wins) and keep ONE minimal reflog
smoke rather than fully deleting the live reflog tests.

## References

- fn-747 (PREDECESSOR, effectively done): shipped the in-process daemon
  harness (`test/helpers/in-process-daemon.ts`), the serial-fallback
  `test:slow`, and `scripts/soak-slow-tests.ts` — this epic supersedes the
  serial fallback and deletes the soak harness. Build on its
  `disableNativeWatcher` seam.
- fn-749 (OVERLAP — coordinate, land this FIRST): both edit
  `test/helpers/in-process-daemon.ts` + `package.json`; fn-749's task spec
  references `bun run test:slow` + a 20x soak, BOTH of which this deletes —
  fn-749.1's spec text will need updating after this lands. Left UNWIRED as a
  hard dep so this active cleanup isn't blocked behind a dormant epic
  (mirrors fn-747's own overlap-handling precedent).
- fn-748 (reverse-dep, advisory): planned to reuse the soak-harness
  `scripts/` skeleton this deletes — it must inline/source it elsewhere.
- fn-744 / fn-751 (advisory overlaps): `package.json` test scripts /
  `in-process-daemon.ts` + `daemon.test.ts`.
- ACCEPTED coverage drops (the OS layer, per the stance): live-FSEvents
  transcript-tail, real subprocess-daemon SIGTERM/SIGKILL stitch, real
  subprocess-daemon boot, and `@parcel/watcher` native addon-LOAD (after
  this, zero test dlopens the addon — `isDropError` covers its error-string
  contract without loading it). Dogfooding is the backstop.

## Docs gaps

- **CLAUDE.md / AGENTS.md (symlink — edit in place)**: trim the Test-isolation section's "CLI-spawn tests" guidance (`clearAmbientIds`) once the subprocess-spawn tests are gone.
- **test/live-shell.test.ts (~L19-26)**: comment references a retired `test:isolated` script — fix to the real script name.
- **test/plan-worker.test.ts (file header + the fn-737 `(z3)` section header)** and **test/integration.test.ts (~L1063-1069/1173-1176)**: drop the "test:slow stays SERIAL" / serial-tier framing.

## Snippet context

No snippets/bundles attached: `promptctl find-snippets` returned empty for
"test parallel bun", "test isolation sandbox", and "reflog watcher seam" —
no repo snippet substrate covers this area; conventions are sourced from
CLAUDE.md + in-file test docs.

## Overview

The slow test tier (`integration`, `daemon`, `plan-worker`) cannot be
parallelized by flag-flip. A 20x soak proved 16/20 (runs 4,5,6,13 failed)
because every file boots the FULL keeperd daemon and/or dlopens the
`@parcel/watcher` NAPI addon in worker threads: `integration.test.ts` is
10 tests each `Bun.spawn`-ing a real daemon subprocess; `daemon.test.ts`
and `plan-worker.test.ts` spawn watcher Worker threads directly. Under
`--parallel` the addon SIGTRAPs on teardown (daemon exits 133 on SIGTERM)
and bun:sqlite's native binding races on concurrent open (`not an error`,
errno 0). Per-test state isolation does NOT make the tests light — the
heavyweight boot is both the cost and the flake source.

This epic GUTS the heavyweight boot. Carve a programmatic in-process
`startDaemon`/`stop` path out of `runDaemon` (no `process.exit`), add a
`@parcel/watcher` seam so the in-process tier runs the fold pipeline
WITHOUT worker-thread native-addon dlopens, and migrate the daemon-
dependent slow tests onto an in-process harness (keeping ~1-2 true
subprocess smoke tests for the real process boundary). Lightening makes
the tier both faster AND parallel-safe; the already-written
`scripts/soak-slow-tests.ts` then proves 0 flakes over 20x.

## Quick commands

- `bun run test:slow` — the slow tier, now in-process + parallel
- `bun scripts/soak-slow-tests.ts 20` — soak 20x; expect 0 fails
- `bun run test` — full umbrella, still green

## Acceptance

- [ ] Programmatic in-process daemon `startDaemon`/`stop` exported; production `import.meta.main → runDaemon` boot and the SIGTERM→exit-0 contract unchanged
- [ ] A `@parcel/watcher` seam lets the in-process tier run the fold pipeline without worker-thread native-addon dlopens
- [ ] Slow-tier daemon-dependent tests run in-process; ~1-2 true subprocess smoke tests retained
- [ ] `test:slow` runs `--parallel` over the lightened tier; a ≥20x soak completes with 0 failures
- [ ] `bun run test` umbrella green

## Early proof point

Task that proves the approach: `.2` (the in-process daemon + watcher-seam
keystone). If the `@parcel/watcher` worker-thread dlopen cannot be avoided
without breaking the plan-worker's live `.planctl` watch: fall back to
accepting the serial baseline (restore the 9558382 serial `test:slow`) and
ship `scripts/soak-slow-tests.ts` as a general flake-regression guard — the
speedup is forfeit but the durable guard survives.

## References

- Commit `9558382` "two-tier test gate" + its `fn-722.1` done-summary:
  `plan-worker` was carved serial because `@parcel/watcher`'s NAPI addon
  panicked under whole-suite `--parallel`. The fn-747 soak proved the panic
  ALSO fires on a 3-file parallel run AND on daemon shutdown (exit 133) —
  confirming the native addon, not load alone, is the issue.
- Soak evidence (`.1` first attempt, 16/20): runs 4/5/6 = daemon exit 133
  (SIGTRAP on SIGTERM teardown), run 13 = bun:sqlite `not an error`
  (errno 0) concurrent-open race.
- `src/daemon.ts:1246` `runDaemon` (unexported, arg-less, `process.exit(0)`
  teardown closure at `:3332`/`:3475`, import-safety guard at `:3490`) +
  `:1218` `prewarmWatcherAddon(loader?)` — the existing injectable-loader
  precedent for the seam. `daemon.test.ts:2189` is the in-process
  worker-spawn style template.
- `src/plan-worker.ts:3588` — the hardcoded worker-thread `@parcel/watcher`
  import (no polling fallback today); `:3015` the reflog watcher.
- Bun pinned **1.3.14** (the `--parallel`/`--isolate` segfault fix); a
  downgrade re-breaks parallel.
- **Reverse dep (advisory):** `fn-748.1`'s git-worker CPU sampler reuses
  fn-747's `scripts/` harness skeleton — this re-scope reshapes that
  harness, so fn-748.1 must re-verify against what lands here.
- **Overlap (advisory, NOT wired):** `fn-744-board-serve-and-fold-latency-under-load`
  also touches `package.json` test scripts, may add a `test/helpers/` load
  harness, and edits `src/server-worker.ts`. Both unstarted; coordinate the
  `package.json` + `test/helpers/` edits. Wire `epic add-deps` only if you
  want to serialize — left unwired so this active epic isn't blocked behind
  a dormant one.

## Docs gaps

- **README.md** (~L510-528): once the slow tier runs in-process + parallel,
  fix any prose implying it is inherently serial; mention
  `scripts/soak-slow-tests.ts`.
- **CLAUDE.md** (Test isolation): the `sandboxEnv` six-path contract is what
  makes in-process parallel safe; keep omission from implying slow=serial.

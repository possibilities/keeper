## Description

**Size:** S
**Files:** package.json, scripts/soak-slow-tests.ts, test/live-shell.test.ts, test/plan-worker.test.ts, test/integration.test.ts, CLAUDE.md

### Approach

With the OS-coupled tests gone, the former slow files are pure/in-process
and parallel-safe. Restructure `package.json`:
- Drop `test:slow` and `test:soak`.
- Remove the THREE slow-file `--path-ignore-patterns`
  (`integration`/`daemon`/`plan-worker`) from the parallel script, but KEEP
  the TWO OpenTUI ignores (`ansi-to-styled`, `live-shell`) — those are
  load-bearing (`@opentui/core` TDZ crash under `--isolate`/parallel).
- Make `test` a single `--parallel` pass over everything-except-OpenTUI,
  plus the separate `test:opentui` phase (`test = <parallel pass> &&
  test:opentui`). Keep the umbrella's OpenTUI phase serial.
- Delete `scripts/soak-slow-tests.ts`.

Fix stale docs: the `test:isolated` reference in `test/live-shell.test.ts`
(~L19-26); the file-header `(b)` smoke + fn-737 `(z3)` section comments in
`test/plan-worker.test.ts`; any remaining serial-tier comments in
`test/integration.test.ts`; and trim the CLAUDE.md (== AGENTS.md symlink)
Test-isolation section's now-obsolete "CLI-spawn tests" guidance.

Verify: run `bun run test` repeatedly (e.g. 5x), 0 flakes, and measure +
report wall-time. Target <8s (the fast tier is 6.16s today; the additions
are pure/sub-second in-process tests). If it lands marginally over 8s,
report the number — it's a target, and the win is "one parallel tier, 0
flakes," not a hard millisecond gate.

### Investigation targets

**Required** (read before coding):
- package.json:13-18 — the test-script block (`test:fast`/`test:slow`/`test:soak`/`test:opentui`/`test`)
- test/live-shell.test.ts:18-33 — the OpenTUI TDZ rationale + stale `test:isolated` comment
- CLAUDE.md — the `## Test isolation` section

### Risks

- Folding the OpenTUI files into the parallel pass re-trips the TDZ and reds
  the suite — remove ONLY the 3 slow-file ignores, keep the 2 OpenTUI ones.
- <8s is a tight target; treat as goal + measured report, not a hard fail.

### Test notes

- `bun run test` green; capture wall-time across ~5 runs; confirm no
  `test:slow`/`test:soak`/`soak` references remain (grep package.json + repo).

## Acceptance

- [ ] `package.json`: single `--parallel` `test` path (+ separate `test:opentui`); `test:slow` + `test:soak` removed; the 2 OpenTUI ignores retained, the 3 slow-file ignores gone
- [ ] `scripts/soak-slow-tests.ts` deleted; no dangling `soak`/`test:slow` refs in the repo
- [ ] Stale doc comments fixed (live-shell `test:isolated`, plan-worker header/`z3`, integration serial-tier); CLAUDE.md Test-isolation trimmed
- [ ] `bun run test` green over ~5 repeated runs (0 flakes); wall-time measured + reported (<8s target)

## Done summary

## Evidence

## Overview

The `test:slow` tier runs its 3 files (`integration`, `daemon`,
`plan-worker`) SERIALLY (~10.45s) while every other tier runs
`--parallel`. The files are isolated (per-test tmpdir + own UDS socket),
so a 3-file `--parallel` run drops the tier to ~5s. Because the serial
split was a DELIBERATE de-flake (commit 9558382), reintroducing
parallelism here ships with a committed flake-soak harness
(`scripts/soak-slow-tests.ts`) that reruns the tier N times and reports
any failure — the durable guard that keeps the tier from silently
regressing to flaky.

## Quick commands

- `bun run test:slow` — the slow tier, now parallel (~5s vs ~10.45s)
- `bun scripts/soak-slow-tests.ts 20` — soak the slow tier 20x; expect 0 fails
- `bun run test` — full umbrella (`test:fast && test:slow && test:opentui`), still green

## Acceptance

- [ ] `test:slow` runs `--parallel` over the verified-safe tier composition
- [ ] `scripts/soak-slow-tests.ts` exists and gates on pass/fail (not wall-clock)
- [ ] A ≥20-iteration soak completes with 0 failures (summary table pasted as evidence)
- [ ] `bun run test` umbrella still green

## Early proof point

Task that proves the approach: `.1`. The risky premise is plan-worker
under `--parallel`. If the soak shows plan-worker's `@parcel/watcher`
native addon still panics in the 3-file tier: fall back to parallelizing
`integration`+`daemon` only and keep `plan-worker` serial — the tier still
speeds up, the harness still guards it.

## References

- Commit `9558382` "two-tier test gate" + its `fn-722.1` done-summary, which
  records plan-worker being carved into the *serial* tier because its
  `@parcel/watcher` native NAPI addon panicked under `--parallel`. That
  panic was observed in the WHOLE-SUITE (~50-file) parallel run; a 3-file
  parallel run is a genuinely lighter load — must-verify, not assume.
- `.planctl/specs/fn-722-fast-two-tier-keeper-test-gate.md`,
  `.planctl/specs/fn-683-stabilize-flaky-bun-test-suite.md` — both phrase
  acceptance as "0 flakes over 5 consecutive runs"; this harness formalizes
  that manual ritual at 20x.
- `scripts/backstop-stats.ts` — closest in-repo shape for a "run N, report
  aggregate" Bun `.ts` reporter; mirror its style.
- Bun is pinned at **1.3.14** (the `--parallel`/`--isolate` segfault fix); a
  downgrade re-breaks parallel.
- **Overlap (advisory, NOT a wired dep):** `fn-744-board-serve-and-fold-latency-under-load`
  also touches the `package.json` scripts block (it may add its own test
  script). Additive, no line collision. Wire
  `planctl epic add-deps <this-epic> fn-744` only if you want to serialize
  the package.json edits.

## Docs gaps

- **README.md** (the spawn-test/state-path prose, ~L510-528): once the slow
  tier runs `--parallel`, ensure no sentence implies it is inherently
  serial; add a one-line mention of `scripts/soak-slow-tests.ts` alongside
  the other utility-script mentions.
- **CLAUDE.md** (Test isolation section): the `sandboxEnv` six-path contract
  is what makes parallel safe in BOTH tiers — keep omission from implying
  slow=serial.

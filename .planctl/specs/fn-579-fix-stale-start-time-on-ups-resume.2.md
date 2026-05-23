## Description

Fixes finding `f-002` (`docstring-ps-column-order-wrong`) from the
`fn-576-job-liveness-detection` inline audit.

The JSDoc on `scrapeSpawnInfo` at
`plugin/hooks/events-writer.ts:212` reads:

    Darwin: ONE `ps -o args=,lstart=` fork captures both fields
    (lstart is 24-char fixed-width at the end; see `splitArgsLstart`).

The actual `Bun.spawnSync` call at `:230` is:

    ["ps", "-ww", "-p", String(process.ppid), "-o", "lstart=,args="]

The inline comment at `:227` ("args MUST come last so macOS ps
doesn't truncate it mid-string") is correct; the `splitArgsLstart`
helper around line 130 parses `lstart` as the 24-char fixed-width
PREFIX (not suffix). The function header docstring at `:212` is
doubly wrong:

1. Column order — it says `args=,lstart=` but the code passes
   `lstart=,args=`.
2. Position-of-lstart — it says "24-char fixed-width AT THE END"
   but under the real code lstart is the 24-char fixed-width PREFIX.

A maintainer reading the docstring first and then trying to refactor
`splitArgsLstart` (or reproduce its column-order constraint) would
silently break Darwin `start_time` capture — exactly the path Q7
relies on for recycle-safe `(pid, start_time)` identity.

**Fix:** docstring-only edit. Change `:212` to:

    Darwin: ONE `ps -o lstart=,args=` fork captures both fields
    (lstart is the 24-char fixed-width PREFIX; see
    `splitArgsLstart` and the column-order comment below).

No code change. No test change.

## Acceptance

- [ ] `plugin/hooks/events-writer.ts:212` docstring matches the
      implementation at `:230` — both reference
      `ps -o lstart=,args=`.
- [ ] The "fixed-width at the end" qualifier is corrected to
      "fixed-width PREFIX" (or equivalent wording that matches the
      actual position of `lstart` in the `ps` output).
- [ ] No behavior change: `bun test` still green, no impact on
      the hook's exit-0 contract or SessionStart 1.5s budget.

## Done summary
Corrected scrapeSpawnInfo JSDoc to reference 'ps -o lstart=,args=' and describe lstart as the 24-char fixed-width PREFIX, matching the actual implementation.
## Evidence

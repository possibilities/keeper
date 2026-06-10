## Description

**Size:** S
**Files:** package.json, CLAUDE.md, README.md

### Approach

Extend the fn-752 script pattern: default `test` = `bun test --parallel --timeout=30000` with `--path-ignore-patterns` for the slow list AND the two opentui files, chained `&& bun run test:opentui` (opentui stays in the default tier — it is 0.6s and serial-safe). New `test:full` = the same bun test with ONLY the opentui files excluded (no slow-list patterns) `&& bun run test:opentui` — every file runs exactly once, opentui never double-runs. Initial slow list (empirical — measure and adjust): daemon, integration, git-worker, git-wrapper, git, plan-worker, events-writer, db, exit-watcher, exit-watcher-ffi, events-ingest-worker, wake-worker, maintenance-worker, dead-letter-worker, commit-work, commit-work-foundation, session-state, keeper-cli, babysitter-build, exec-backend if needed. Then MEASURE: `time bun test` three runs; any fast-tier file keeping the wall over 5s moves to slow (and vice versa — pull a file back in if it is now cheap). Patterns are globs pruned at discovery, so a typo silently matches nothing — sanity-check by comparing the "Ran N tests across M files" counts of fast + slow against the pre-split total. Then docs: CLAUDE.md `## Test isolation` gains the template-helper rule and the tier line ("fast tier is the default; `test:full` is mandatory before landing changes touching daemon/worker/db/hook/git process paths or any slow-tier file"); README's sandboxEnv paragraph (~549-568) revised — not appended — to name both helpers.

### Investigation targets

**Required** (read before coding):
- package.json scripts — the exact fn-752 `--path-ignore-patterns` + chained-`&&` shape to extend
- CLAUDE.md `## Test isolation` section — voice and density to match
- README.md:549-568 — the sandboxEnv paragraph to revise

**Optional** (reference as needed):
- Solo-time table in the epic References — the starting point for tier membership

### Risks

- The dominant two-tier failure mode is the slow tier breaking silently; the CLAUDE.md wording is the only tripwire until the follow-up local-CI epic — make the "when is test:full mandatory" line unambiguous.
- File-count conservation check guards against glob typos silently shrinking coverage.

### Test notes

`time bun test` <5s wall (three consecutive runs), `bun run test:full` green, fast-count + slow-only-count == pre-split total file count.

## Acceptance

- [ ] `time bun test` <5s wall on the 10-core dev machine, three consecutive runs
- [ ] `bun run test:full` green and runs every test file exactly once (opentui included, not doubled)
- [ ] File/test-count conservation verified against the pre-split total
- [ ] CLAUDE.md + README updated per the docs gaps in the epic spec

## Done summary

## Evidence

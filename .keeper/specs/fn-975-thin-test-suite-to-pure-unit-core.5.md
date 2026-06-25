## Description

**Size:** M
**Files:** package.json, CLAUDE.md, README.md, scripts/test-gate.ts, test/helpers/in-process-daemon.ts, test/helpers/wait-for-daemon.ts, test/helpers/git-repo.ts, test/helpers/retry-until.ts

### Approach

With all infra files/tests gone (.2/.3/.4) and the spinner bound (.1), finalize.
Collapse package.json: `test` and `test:full` become ONE fast tier — drop the
~45 `--path-ignore-patterns` entries, keeping only the 4 opentui exclusions and
the `&& bun run test:opentui` append (which stays). Delete now-orphaned helpers
after grep-confirming zero importers: `in-process-daemon.ts` +
`wait-for-daemon.ts` (orphan together), `git-repo.ts` (real-git initRepo),
`retry-until.ts` (verify no survivor still calls `retryUntil`; if one does, keep
it and the poll-don't-sleep doc bullet). Note `sandbox-env.ts` does NOT orphan —
`template-db.ts` imports it. Rewrite CLAUDE.md `## Test isolation`: kill the
two-tier/`test:full`-mandatory, `.slow.test.ts`-extraction, no-real-git-allowlist,
and (if `retryUntil` orphaned) poll-don't-sleep bullets; new rules state the
present: one fast pure-in-process tier, no real daemon/worker/socket/subprocess/
git/tmux in any test, no watchdog (a test must not be able to hang or sync-spin),
production is the integration safety net. Prune the README `## Architecture` test
narrative AND fix its stale "parallel=4 / host-wide flock" line. Update the
test-gate.ts header comment (drop the `test:full` reference). Keep CLAUDE.md
under 120 lines (`bun scripts/lint-claude-md.ts`), forward-facing only (no
"removed"/fn-id narration). VERIFY: run the suite 20×+ under real load, confirm
zero hangs/spins, all green, well under target wall-time.

### Investigation targets

**Required** (read before coding):
- package.json — the two test scripts (collapse target)
- CLAUDE.md:97-111 (Test isolation), README.md ~685-724 (test helpers + stale flock/parallel line)
- The helper import graph — grep each helper for surviving importers before deleting

### Risks

Orphaned-helper deletion must grep-confirm zero importers (a dangling import
fails the whole suite). CLAUDE.md must stay under the 120-line cap and avoid
re-narration (lint gates both). The verify must actually STRESS (20×+ under
load) — a single green run would not catch an intermittent spin.

### Test notes

`for i in $(seq 1 20); do timeout 120 bun run test 2>&1 | tail -1; done` — every
run exits 0, none time out. biome + tsc green. lint-claude-md green.

## Acceptance

- [ ] package.json has one fast tier (no test/test:full split beyond the opentui invocation); no dead path-ignores
- [ ] Orphaned helpers deleted (zero-importer confirmed); surviving helpers untouched
- [ ] CLAUDE.md Test-isolation + README Architecture rewritten, forward-facing, lint-claude-md green
- [ ] Suite runs 20×+ under load with zero hangs/spins, all green; biome + tsc green

## Done summary

## Evidence

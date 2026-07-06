## Description

**Size:** M
**Files:** src/usage-scrape-runner.ts, src/db.ts, src/daemon.ts, test/usage-scrape-runner.test.ts, test/usage-scrape-runner.slow.test.ts, test/fixtures/scrape-in-worker.ts

### Approach

Collapse the scrape spawn seam to one shape: `buildScrapeArgs` always returns
`[process.execPath, <internal scrape-cli path>, --target, ..., --profile, ...]`
with no runtime fork and no config lookup. The internal entry path resolves
from `import.meta.url` following the established repo-relative pattern
(fileURLToPath → dirname → resolve → realpathSync with fallback-on-throw);
`spawnScrape` passes an explicit `cwd` (the keeper repo root, derived from the
same resolution) so tsconfig/bunfig discovery is deterministic under launchd,
and `SpawnScrapeOptions` gains an optional entry-path override as the test
seam for exercising `spawn_failed` and pointing tests at fixtures. The runner
drops its `./db` import entirely (the seam returns to db-free). Delete the
four `usage_scraper_*` config keys end-to-end: the type fields, the yaml
parse arms, and the `resolveUsageScraperRuntime` /
`resolveUsageScraperRuntimeKind` / `normalizeUsageScraperRuntime` family plus
the `UsageScraperRuntime` union; a config still carrying those keys parses
fine (open content model — unknown keys ignored). `agentusage_root` is NOT
one of the four — it stays. The daemon's worker gate simplifies to the plain
worker selector: the usage-scraper worker spawns unconditionally (the scraped
set is governed by config declaring models, a sibling task). Keep the
concurrent-drain + manual SIGKILL-deadline spawn discipline verbatim. Rewrite
the runner test suite: the uv-leg, runtime-kind, and runtime-resolution
describe blocks delete with their subjects; the worker-context fixture and
the slow suite update in lockstep to the new options shape, and the slow
suite keys its skip-gate on the INTERNAL entry so it survives the source
repo's archival.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/usage-scrape-runner.ts:227-268 (buildScrapeArgs), :395-458 (spawnScrape), :467-485 (runScrape gate to remove)
- src/db.ts:158-179 (type fields), :416-437 (yaml parse arms), :587-670 (resolver family + union) — the deletion scope; expandTilde/firstNonEmpty are shared, keep
- src/daemon.ts:114-115 (import), :6676-6685 (arm-gate + stateDir threading)
- src/keeper-agent-path.ts:31-42 — the import.meta resolution pattern to mirror
- test/usage-scrape-runner.test.ts:278-469 — suites bound to deleted symbols
- test/usage-scrape-runner.slow.test.ts:23,31,34,62-66 and test/fixtures/scrape-in-worker.ts:19-27 — lockstep updates; :31 is the skip-gate that must repoint

**Optional** (reference as needed):
- src/usage-scrape-runner.ts:481-511 (scrapeChildPath / withDirOnPath — PATH augmentation stays)

### Risks

- Child cwd/config discovery under launchd: the daemon's cwd may be `/`; the explicit cwd must make bunfig/tsconfig resolution independent of it.
- Env vars `KEEPER_USAGE_SCRAPER_*` become inert — confirm nothing in the LaunchAgent plist or test harness still sets them expecting effect.

### Test notes

Unit-assert the new argv shape and the entry-path override seam; the slow
suite (KEEPER_RUN_SLOW) proves the real spawned round-trip against the
internal entry, including the worker-thread non-empty-stdout proof.

## Acceptance

- [ ] The scrape spawn builds one argv shape — the daemon's own bun binary plus the internal entry — with no runtime branching, config lookup, or DB import in the runner
- [ ] The four usage_scraper config keys are fully deleted while configs still carrying them parse without error, and the state-root override key is untouched
- [ ] The usage-scraper worker spawns on the plain worker selector with no runtime-resolution gate
- [ ] Spawned scrapes receive an explicit cwd and an injectable entry path; the spawn-failure arm is exercisable via that seam in tests
- [ ] The slow-tier round-trip suite gates on the internal entry (not the external project dir) and the full fast suite is green

## Done summary

## Evidence

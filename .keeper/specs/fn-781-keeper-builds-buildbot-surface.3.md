## Description

**Size:** S
**Files:** cli/builds.ts, cli/keeper.ts, test/builds.test.ts, test/keeper-cli.test.ts

### Approach

`cli/builds.ts` on the cli/git.ts template (the simplest existing view):
parseArgs (--sock, --snapshot, --watch, --timeout, --help), 
resolveSnapshotMode, createViewShell, subscribeCollection({collection:
"builds", sort: project ASC, onRows -> view emit}). Pure exported
renderers: one line per project — name, status glyph + label mapped from
buildbot results codes (0 SUCCESS, 1 WARNINGS, 2 FAILURE, 3 SKIPPED,
4 EXCEPTION, 5 RETRY, 6 CANCELLED; results NULL + complete=0 renders as
RUNNING — a documented state, not an error), build number, state_string,
and an age derived from updated_at (client-side wall-clock is fine here —
cosmetic render concern, never folded). Optionally dim rows whose age
exceeds ~3x the poll cadence as the staleness affordance. Keep the
restrained near-monochrome look of the sibling views: color only as
signal (fail/red, success/green or plain, running/dim pulse glyph).

Register "builds" in cli/keeper.ts: SUBCOMMANDS array, lazy handler map,
USAGE line. Empty table renders the view shell's normal empty state — a
one-line hint ("no builds yet — is buildbot_url configured?") in the
empty body is welcome but keep it client-side prose, not new protocol.

### Investigation targets

**Required** (read before coding):
- cli/git.ts — the whole-file template: arg parsing, snapshot-vs-live resolution, view-shell wiring, subscribeCollection call shape, exported pure renderRowLines/renderRowBlocks
- cli/keeper.ts:26-36,48,133-145 — SUBCOMMANDS, USAGE text, lazy handler map
- test/git.test.ts — renderer unit-test shape against the exported pure functions

**Optional** (reference as needed):
- src/view-shell.ts — createViewShell options (renderBody contract, sidecars)
- test/keeper-cli.test.ts — dispatch test that must learn the new subcommand

### Test notes

Renderer unit tests against the exported pure functions: one case per
results code plus RUNNING and a stale row; snapshot of the line layout.
test/keeper-cli.test.ts gains the "builds" route. Fast tier covers the
renderers; the view-shell/CLI process path is slow-tier, so run
`bun run test:full` before landing.

## Acceptance

- [ ] `keeper builds` (live) and `keeper builds --snapshot` (one-shot) render one row per project: name, status glyph/label, build number, state_string, age
- [ ] All seven results codes + RUNNING render distinctly (unit-tested); running is not an error state
- [ ] "builds" registered in SUBCOMMANDS/USAGE/handler map; keeper-cli dispatch test updated
- [ ] bun run test:full green

## Done summary
Added 'keeper builds' TUI subcommand (cli/builds.ts) on the git.ts template: pure renderers mapping all 7 buildbot result codes + RUNNING to status glyph/label, build number, state string, and client-side age with a 3x-cadence staleness marker; registered in the dispatcher SUBCOMMANDS/USAGE/handler map. Renderer + dispatch tests added; bun run test:full green.
## Evidence

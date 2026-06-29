## Description

**Size:** M
**Files:** src/usage-scraper-worker.ts, test/usage-scraper-worker.test.ts, README.md

### Approach

Fix the live split-brain: `resolveMultiplierOrNull("default")` currently reads
`~/.claude-profiles/default/.claude.json` (the stranded Max-20x shadow) at
usage-scraper-worker.ts:248, while default's USAGE is scraped from `~/.claude`.
Special-case INSIDE `resolveMultiplierOrNull` so `default` → `join(homeDir, ".claude",
".claude.json")` (mirror the scraper's special-case); placing it there means both the boot
path (`resolveMultiplier` :291-293, default homedir) and `reResolveMultiplier` (:302-319,
threaded homeDir) inherit it for free — no need to thread homeDir through the boot path.
Audit + update EVERY default-tier test fixture in test/usage-scraper-worker.test.ts (the
bug is encoded at :219 via `writeProfileClaudeJson(tmpDir,"default",...)` which writes
`~/.claude-profiles/default/.claude.json`; the helper must write `~/.claude/.claude.json`
for the default tier — add a param or a sibling helper). Transition is benign: after this
lands, signed-out `~/.claude` honestly resolves default to 1x/no-subscription (vs the
misleading 20x-from-shadow); it self-corrects on operator re-auth. Add docs: a sentence
to the README producer section (~:2944-2962) that default's tier reads from `~/.claude`;
and a new `### Re-homing a stranded account` numbered runbook under `## Backup & restore`
(~:3787) — recognise via `keeper agent profiles check`, the manual re-home steps (sign
`~/.claude` into the account, verify `keeper usage` shows default healthy, THEN remove the
shadow), and the explicit non-automation note (keeper never moves/deletes; never delete
before verified re-auth).

### Investigation targets

**Required** (read before coding):
- src/usage-scraper-worker.ts:244-267 (resolveMultiplierOrNull, path at :248), :280-287 (oauthAccount read), :291-293 (resolveMultiplier boot), :302-319 (reResolveMultiplier)
- test/usage-scraper-worker.test.ts:54 (homeDir seam), :212-221 (default-tier fixtures incl. :219), writeProfileClaudeJson helper — audit ALL default-tier fixtures
- README.md:~2944-2962 (producer section), :3787 (`## Backup & restore`, `### Restore a snapshot` as the runbook format template), ~:482/:2249 (adjacent default/profile context)

### Risks

- Test-fixture coupling: any default-tier assertion that assumes `~/.claude-profiles/default` will break unless the fixture writer is updated to `~/.claude` for default.
- Don't thread homeDir through the boot path unnecessarily — the in-resolveMultiplierOrNull special-case covers both callers.

### Test notes

Add/adjust fixtures so the default tier is written to `~/.claude/.claude.json`; assert
`resolveMultiplierOrNull("default", tmpHome)` reads `~/.claude`, and a non-default profile
still reads `~/.claude-profiles/<name>`. Assert a signed-out `~/.claude` (no oauthAccount)
→ null → 1x.

## Acceptance

- [ ] `resolveMultiplierOrNull("default")` reads `~/.claude/.claude.json`; non-default profiles unchanged. Boot + re-resolve both inherit it.
- [ ] All default-tier test fixtures updated to write `~/.claude`; suite green.
- [ ] README producer section notes the default→`~/.claude` tier read.
- [ ] `### Re-homing a stranded account` runbook added under `## Backup & restore` with the explicit non-automation note.
- [ ] `bun test test/usage-scraper-worker.test.ts` green.

## Done summary
Fixed the default-tier split-brain: resolveMultiplierOrNull now reads default's tier from ~/.claude/.claude.json (not the ~/.claude-profiles/default shadow), inherited by both boot and per-cycle re-resolve. Updated test fixtures, added split-brain + signed-out pins, and README producer note + Re-homing runbook.
## Evidence

## Description

**Size:** M
**Files:** babysitters/ (delete), test/babysitter-build.test.ts (delete), test/keeper-watch.test.ts (delete), test/keeper-watchdog.test.ts (delete), commands/babysit-init.md (delete), commands/babysit-triage.md (delete), plist/arthack.babysitter.performance.watch.plist (delete), plist/arthack.babysitter.performance.watchdog.plist (delete), package.json, tsconfig.json, CLAUDE.md, README.md

### Approach

Pure subtraction in keeper, only after tasks 3+4 prove the sitter repo
is live and the launchd jobs run from it. Delete the babysitters/
tree, the three test files, the two command files, and the two plist
files. Un-wire every reference: package.json lint script's
`babysitters` biome target (line 12) and the two test-ignore patterns
for babysitter-build/keeper-watch in the default test script (line 16);
tsconfig.json `include` entry; CLAUDE.md's "Babysitters carve-out"
bullet and "Babysitters are pure read-only external scanners" bullet
(both now live in sitter's CLAUDE.md); README.md's babysitter
Architecture/Install/Uninstall blocks → one-line pointer to
~/code/sitter. Sweep for stragglers: `rg -il babysit` over keeper
(excluding .planctl/, which is historical plan data and stays).

### Investigation targets

**Required** (read before coding):
- package.json:12,16 — the lint target + test-ignore patterns to un-wire
- tsconfig.json — the include array
- CLAUDE.md:17-19,74 — the two bullets to remove
- README.md:452-505,1176-1183,2365-2406 — the three blocks to prune

**Optional** (reference as needed):
- src/integrity-probe.ts:48-69 — mentions the babysitter in comments (KEEPER_TOPIC); reword the comment, keep the constant

### Risks

- This is the point of no return for keeper-side files — confirm task 4's
  cutover is verified-live before deleting plist/ (the LaunchAgents
  symlinks must already point at sitter).
- Missing one package.json un-wire makes lint/test reference a deleted
  dir and fail the suite — the rg sweep is the backstop.

### Test notes

`bun run test:full` green in keeper (mandatory — this touches test
wiring); `bun run lint` green; `rg -il babysit` clean outside .planctl/.

## Acceptance

- [ ] babysitters/, the 3 tests, 2 commands, 2 plists deleted from keeper
- [ ] package.json/tsconfig/CLAUDE.md/README references removed; pointer to ~/code/sitter added
- [ ] keeper `bun run test:full` and `bun run lint` green
- [ ] `rg -il babysit` finds nothing outside .planctl/

## Done summary
Removed the extracted babysitter tree from keeper: deleted babysitters/, 5 sitter tests, 2 babysit commands, and 4 sitter plists; un-wired package.json/tsconfig and pruned CLAUDE.md/README references to ~/code/sitter pointers. test:full and lint green; rg -il babysit clean outside .planctl/.
## Evidence

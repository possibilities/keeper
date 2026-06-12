## Description

**Size:** M
**Files:** performance/* -> sitters/performance/*, gitpolice/* -> sitters/gitpolice/*, tsconfig.json, package.json, test/build-pin.test.ts, test/watch.test.ts, test/watchdog.test.ts, test/gitpolice.test.ts, test/git-detect.test.ts, test/schema-pin.test.ts, plist/arthack.babysitter.performance.watch.plist, plist/arthack.babysitter.gitpolice.watch.plist, README.md, CLAUDE.md

### Approach

git mv the two existing sitter directories under a new sitters/ tree, bump their lib imports one level (`../lib/` -> `../../lib/`), and rewire every path reference: tsconfig include, package.json lint glob, test import paths, build-pin SITTER_MODULES. Update the two plists' ProgramArguments/log paths to the new locations, then bootout + bootstrap the live performance job in the same sitting so it keeps ticking from the new path (the loaded launchd state has the old path baked in; sequence move -> plist -> bootout -> bootstrap to bound missed ticks). Docs describe the sitters/ tree as current state — no relocation narrative.

### Investigation targets

**Required** (read before coding):
- test/build-pin.test.ts:29 — SITTER_MODULES paths to repoint; the fence walk skips test/ and node_modules so it auto-covers sitters/; correct the stale "(lib/ + performance/)" comment while in there
- plist/arthack.babysitter.performance.watch.plist — ProgramArguments/WorkingDirectory/StandardOut+ErrPath shapes
- package.json (lint glob "agents commands gitpolice lib performance") and tsconfig.json include array

**Optional** (reference as needed):
- test/watch.test.ts:93-130 — sandbox env discipline; only import paths change here

### Risks

- The live performance launchd job runs from the old path until re-bootstrapped — do the move and re-bootstrap in one task, never leave the tree split across commits.

### Test notes

bun test green; zero-keeper-import fence still empty for source files; `bun run sitters/performance/watch.ts --json` and `bun run sitters/gitpolice/watch.ts --json` both run; `launchctl list` shows the performance job loaded with last exit 0 after re-bootstrap.

## Acceptance

- [ ] performance/ and gitpolice/ live under sitters/; no sitter dirs remain at the repo root
- [ ] bun test green; build-pin link + fence tests green
- [ ] both --json scans run clean from the new paths
- [ ] performance launchd job re-bootstrapped from the updated plist, listed, last exit 0
- [ ] tsconfig include, lint glob, README and CLAUDE.md layout all reflect the sitters/ tree

## Done summary

## Evidence

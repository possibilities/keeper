## Description

**Size:** S
**Files:** test/daemon.test.ts, test/daemon.slow.test.ts (new, conditional), package.json, CLAUDE.md, README.md

### Approach

With task `.1`'s migrate tax gone, re-measure and resolve the ~9 genuine
daemon-spawn/Worker tests against the real remaining number:

- **If the spawn tests are still a meaningful drag on `test:full`** (the ruthless
  default): move the genuine daemon-boot set (`withInProcessDaemon` bodies +
  `Worker` autopilot spawns + the contending-writer/lock-holder subprocess tests)
  into a new `test/daemon.slow.test.ts`. Keep a thin smoke (one boot-drain + one
  socket round-trip) in `test/daemon.test.ts` so `test:full` still proves the
  daemon boots. Add `test/daemon.slow.test.ts` to BOTH `--path-ignore-patterns`
  lists in package.json (the `test` fast script AND `test:full`). Do NOT add it to
  `scripts/test-real-git-allowlist.txt` — it has zero real-git tokens.
- **If `.1` already made `test:full` fast enough** that the spawns are negligible:
  skip the demotion, optionally thin the kept boots via `withInProcessDaemon`'s
  `opts.workers` selector (e.g. `["wake","server"]`) where the body doesn't need
  the full worker set, and note the decision.

Then fix the stale docs regardless of the demotion call: `freshDb()` → `freshMemDb()`
in CLAUDE.md (~L102) and README.md (~L670); orthogonalize CLAUDE.md's
`*.slow.test.ts` guidance so "path-ignored from the fast tier" and "allowlisted in
test-real-git-allowlist.txt" read as independent conditions (a file is allowlisted
ONLY if it actually spawns git).

### Investigation targets

**Required** (read before coding):
- task `.1` Done summary — the re-measured `test:full` time and what the spawns now cost
- package.json — the `test` (fast) and `test:full` `--path-ignore-patterns` lists; existing `*.slow.test.ts` entries as the template
- test/helpers/in-process-daemon.ts:72 — `opts.workers` selector
- CLAUDE.md ~L102 "Test isolation"; README.md ~L670 — the stale `freshDb()` text

**Optional** (reference as needed):
- test/git-worker-realgit.slow.test.ts, test/keeper-guard.slow.test.ts — `*.slow.test.ts` precedent (naming + ignore-list wiring)

### Risks

- A new `daemon.slow.test.ts` must land in BOTH ignore-lists or it either double-runs (fast tier) or vanishes from every tier. Verify with a dry `bun run test:full` (slow file runs) and `bun run test` (slow file skipped).
- Demoting moves real daemon-boot coverage out of the mandatory pre-land tier — keep a thin smoke in `test:full` so a daemon boot is still exercised there.
- Adding `daemon.slow.test.ts` to the real-git allowlist would make `test:hygiene` flag an unused entry — leave it out.

### Test notes

`bun run test` (fast: slow file skipped, still green), `bun run test:full` (slow file runs, green), `bun run test:hygiene` (green), `bun run lint`. Record final `test:full` and `test/daemon.slow.test.ts` times in the Done summary.

## Acceptance

- [ ] Spawn-test fate decided against task `.1`'s measured numbers and the rationale recorded
- [ ] If demoted: `test/daemon.slow.test.ts` created, in both package.json ignore-lists, NOT in the real-git allowlist, with a thin daemon-boot smoke retained in `test:full`
- [ ] `freshDb()` → `freshMemDb()` fixed in CLAUDE.md and README.md; `*.slow` vs real-git-allowlist guidance orthogonalized
- [ ] `bun run test`, `bun run test:full`, `bun run test:hygiene`, `bun run lint` all green

## Done summary
Spawn-test fate DECIDED: skip demotion. Measured against .1's numbers — full daemon.test.ts is 11.22s/97 tests (124.7s->11.2s = ~11x, the epic's order-of-magnitude goal already met by .1); the 12 genuine spawn/Worker/subprocess tests (starvation/usage-mint/autopilot-worker/fn-747/751/774/seed-sweep) are only 5.17s of that. Demoting would yield ~5s for the cost of moving real daemon-boot coverage out of mandatory test:full + duplicating helper scaffolding — net negative, so NO daemon.slow.test.ts created. opts.workers thinning already in place: 4/5 withInProcessDaemon bodies use {workers:[wake,server]}; the 5th (fn-747) is the deliberate full-boot keystone smoke. Docs (freshDb->freshMemDb in CLAUDE.md L102 + README L688, slow-tier/real-git-allowlist orthogonalization in CLAUDE.md L105-108) were all landed by .1 — verified present. No source changes needed; tree clean. NOTE: bun run lint is RED on a PRE-EXISTING unrelated break in src/agent/cwd-ordinal.ts (import-format nit committed today in b0a8f008 refactor(usage)), not touched by this task; test:hygiene green.
## Evidence

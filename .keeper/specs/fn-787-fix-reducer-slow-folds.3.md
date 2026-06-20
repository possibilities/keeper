## Description

**Size:** M
**Files:** src/reducer.ts, src/db.ts + keeper/api.py (only if an index is proven needed), README.md

### Approach

Data-driven: read task .1's Evidence aggregate and fix what it convicts,
starting with GitSnapshot pass1_explicit (84% of a 17s avg across 568
historical breakdown lines; ~2.6s of 3.0s in the freshest post-restart
sample). Every pass1 statement EQPs to a sub-ms covering seek from the CLI,
so the leading hypotheses are in-process: (1) `db.prepare()` per call —
bun:sqlite does not cache `prepare()`; findExplicitAttributions compiles 4-5
statements per dirty file per fold — hoist to prepared-once statements
following main's existing stmts pattern; (2) per-snapshot hoisting — the bash
json_each scan (1130 rows) and deletion scan (70 rows) re-run per dirty file;
hoist once-per-snapshot and match in JS, mirroring computeRepoBashWindows
(reducer.ts:1419) prior art; (3) page-cache thrash from the 2.0GB event_blobs
table — if convicted, scope the response (cache_size review is cheap;
blob-retention redesign is a follow-up epic, not this task); (4) a genuinely
missing index — full migration ritual (SCHEMA_VERSION + keeper/api.py, same
commit). Apply the same data-driven treatment to whatever .1 convicts in the
Commit and PostToolUse arms (likely the shared syncIfPlanRef fan-out or the
same prepare-per-call cost — fix the shared mechanism once).

Constraints (non-negotiable): reads stay INSIDE the BEGIN IMMEDIATE
transaction (cursor + projection co-advance — never split them); keep the
ARM A/ARM B split + `e.data IS NULL` partition + `json_valid` CASE guards
(no COALESCE over indexed predicates); never throw in a fold; build derived
arrays from stable total-order sorts. Update the two README spots (the
Architecture pass narrative + latency numbers, and the diagnostics prose
naming the breakdown-tag family) — this is the numbers-moving task, present
tense, no change-history framing.

### Investigation targets

**Required** (read before coding):
- Task .1's Done summary / Evidence — the conviction data; do not fix blind
- src/reducer.ts:1154-1362 — pass1 arms (the hoist/pre-prepare surface)
- src/reducer.ts:1419-1520 — computeRepoBashWindows: the per-snapshot-hoist prior art
- src/reducer.ts:3911,4095 — syncJobIntoEpic/syncIfPlanRef RMW fan-out
- test/git.test.ts — attribution test shard; the refold pattern to extend

**Optional** (reference as needed):
- test/reducer-projections.test.ts:613,804,1041 — refold-determinism test exemplars
- README.md ~561-565, ~1540-1560 — the two doc spots that go stale

### Risks

Hoisting changes evaluation order — the newest-wins (ts, id) tie-break must
produce byte-identical file_attributions rows; cover git-rm/git-mv attribution
with a refold case if test/git.test.ts lacks one. If .1's data convicts
something outside the reducer (e.g. daemon-side checkpoint/pacing, which is
tmux-agent territory), stop and surface it as a cross-agent dependency instead
of editing off-limits files.

### Test notes

Byte-identical refold (rewind + DELETE projection + re-drain) for every touched
fold; a before/after soak aggregate of `[fold-slow]` + breakdown lines in
Evidence proving steady-state folds under the 2s bar.

## Acceptance

- [ ] Steady-state GitSnapshot folds under the 2s realtime bar in a post-fix soak window (boot-drain excluded); pass1 share drops measurably
- [ ] Commit and PostToolUse convicted costs addressed by the same evidence standard, both under the 2s bar
- [ ] Refold-determinism byte-identical for every touched fold, including a git-rm/git-mv attribution case
- [ ] README Architecture numbers + diagnostics prose updated in place
- [ ] `bun run test:full` green

## Done summary
Hoisted GitSnapshot pass-1 explicit-attribution scans out of the per-file loop: the bash exact-match scan, the git-rm/git-mv deletion scan, and the two tool prepared statements now run once per snapshot (matched per file in JS), mirroring computeRepoBashWindows. Live 2.65GB DB 615-file fold: pass-1 dropped ~5.3s -> ~2.2s. Added an fn-787 refold-determinism test covering tool + bash-exact + git-rm/git-mv arms; full suite green.
## Evidence

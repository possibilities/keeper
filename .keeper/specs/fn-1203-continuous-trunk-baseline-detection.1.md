## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/baseline-store.ts, cli/baseline.ts, test/autopilot-worker.test.ts

### Approach

Add a tip-change producer to the autopilot reconciler: when the tracked default-branch tip of a repo with plan presence changes (source the tip signal from the projections the git-worker already feeds — never probe git inside a fold), compose a baseline request through the existing baseline-store API and write it to the spool, coalescing to the latest tip per repo (a rapid push train must not queue every intermediate sha; the store's keying makes duplicate requests idempotent). Scope: repos carrying open epics, not every tracked repo. Persist nothing new: the last-observed tip may be re-derived per cycle; a boot re-spool of the current tip is harmless (compute-once by key). Re-scope the sole-spool-writer rule in CLAUDE.md in the same change — either the producer writes through baseline-store as a sanctioned second writer, or delegates through the CLI path; state which and why.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/baseline-store.ts:152-168 — buildRequest/writeRequest/baselineKey (the request path to reuse)
- src/baseline-worker.ts — single-slot poll + coalescing semantics (what dedupe already exists)
- src/git-worker.ts:1021-1065 — default-branch tip tracking feeding the projections
- cli/baseline.ts header — the sole-writer claim being re-scoped

### Risks

- Compute cost: every trunk landing now runs the suite once; coalescing and compute-once keying bound it, but confirm the single-slot worker's backlog behavior under a push train.

### Test notes

Pure producer tests: tip-change snapshots yield one spool request for the latest tip only; unchanged tip yields none; repos without open epics yield none.

## Acceptance

- [ ] A default-branch tip change on a repo with open epics produces exactly one baseline request for the newest tip, idempotent across cycles and boots
- [ ] Rapid successive tips coalesce to the latest
- [ ] The spool sole-writer rule in CLAUDE.md matches the shipped write path
- [ ] keeper fast suite green

## Done summary
Added a tip-triggered baseline producer to the autopilot reconciler: it spools one trunk baseline request per open-epic repo whose git_status default-branch tip moved, coalesced to the latest tip and idempotent across cycles/boots, joining the keeper baseline CLI as a sanctioned spool writer (re-scoped in CLAUDE.md, baseline-store.ts, cli/baseline.ts).
## Evidence

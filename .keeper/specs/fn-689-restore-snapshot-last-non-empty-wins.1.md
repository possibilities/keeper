## Description

**Size:** S
**Files:** src/restore-worker.ts, test/restore-worker.test.ts, scripts/restore-agents.ts, README.md, CLAUDE.md

### Approach

In `restorePulse` (`src/restore-worker.ts`), after `buildRestoreDescriptor`
returns (line ~284) and BEFORE the hash gate (line ~290), add an
UNCONDITIONAL early return when the descriptor is empty:

```ts
if (Object.keys(descriptor.sessions).length === 0) {
  return; // last-non-empty-wins: never overwrite a populated snapshot with empty
}
```

Critically the skip is NOT gated on `state.lastHash` — the practice-scout's
`isEmpty && lastHash !== null` form is WRONG: on reboot the worker is a fresh
process (`lastHash===null`) and `seedKilledSweep` has already emptied the live
set, so that guard would fail to skip and write empty, destroying the
pre-crash file (the exact bug). Returning before the hash computation also
means `state.lastHash` is left untouched, so a later non-empty pulse writes
correctly. `buildRestoreDescriptor` never creates empty buckets, so
`Object.keys(descriptor.sessions).length === 0` is an exact emptiness test.

Then update the prose: the `restore-worker.ts` and `restore-agents.ts` file
headers, the README's two write-policy sites, and CLAUDE.md's sole-writer
sentence — from "write-on-change" to "last-non-empty-wins" (see epic Docs gaps).

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:260-323 — `restorePulse`; insert the guard after line 284, before the line-290 hash gate
- src/restore-worker.ts:168-211 — `buildRestoreDescriptor`; confirms `sessions` is `Record<string,RestoreSession>` with no empty buckets
- src/restore-worker.ts:245-249 — `PulseState` (`{lastHash, parentDirEnsured}`); the guard touches neither
- test/restore-worker.test.ts:308-338 — existing `restorePulse` write/dedup tests; model the new tests on the mtime+`lastHash` assertions there
- test/restore-worker.test.ts:76-101 — `insertJob` helper (drives the end-to-end pulse path; the new tests need a state mutation, e.g. `UPDATE jobs SET state='ended'`, to empty the live set)

**Optional** (reference as needed):
- scripts/restore-agents.ts:587-596 — reader already tolerates missing/`{}` sessions; no reader-logic change needed, only the doc comment
- README.md ~434-438 and ~1638-1658 — the two doc sites

### Risks

- **Mis-placed guard reintroduces the bug.** If gated on `lastHash` or placed after the write, the reboot case still zeroes the file. The reboot-preservation test is the backstop.
- **Cold-start behavior change:** first-ever pulse with empty `jobs` and no prior file now writes nothing (previously wrote `{sessions:{}}`). This is fine — `restore-agents` treats a missing file as "nothing to restore" (exit 0). Assert it explicitly.
- **Doc drift is in-scope:** leaving the "write-on-change" prose makes the headers half-true. The acceptance gate requires updating all sites.

### Test notes

Add to test/restore-worker.test.ts (keep the `KEEPER_RESTORE_FILE`-only sandbox — these drive pure functions / `restorePulse` against a tmp DB, no hook spawn):
- (a) populated→empty: pulse with a job, then `UPDATE jobs SET state='ended'` (or delete), re-pulse → file still holds the prior agents, mtime unchanged, `state.lastHash` unchanged
- (b) reboot case: write a populated file, then a FRESH `state={lastHash:null,...}` pulse against empty `jobs` → file intact (this is the load-bearing assertion)
- (c) empty→non-empty still writes
- (d) cold start: empty `jobs`, no prior file, fresh state → no file created (`existsSync===false`)
- keep existing dedup/redundant-write tests green

## Acceptance

- [ ] `restorePulse` early-returns on `Object.keys(descriptor.sessions).length === 0`, unconditionally (no `lastHash` gate), before the hash computation
- [ ] `state.lastHash` is not advanced by the empty-skip; a subsequent non-empty pulse writes
- [ ] populated→empty pulse leaves the prior `restore.json` byte-intact (mtime unchanged)
- [ ] reboot case: fresh `lastHash===null` state + empty live set preserves a populated on-disk file
- [ ] cold start (no prior file, empty jobs) creates no file
- [ ] file headers in restore-worker.ts + restore-agents.ts, README's two sites, and CLAUDE.md sole-writer line all say last-non-empty-wins (no lingering "write-on-change")
- [ ] `bun test test/restore-worker.test.ts` passes

## Done summary
Added unconditional empty-descriptor skip in restorePulse before the hash gate so reboot (fresh lastHash=null + emptied live set) preserves the pre-crash restore.json; updated headers, README, and CLAUDE.md prose to last-non-empty-wins.
## Evidence

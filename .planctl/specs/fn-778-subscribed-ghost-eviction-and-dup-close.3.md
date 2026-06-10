## Description

**Size:** M
**Files:** whatever the diagnosis implicates (usage-worker/reducer/daemon)

### Approach

The 2026-06-10 18:57:29 daemon restart was a CRASH: server.stderr shows repeated
`[keeperd] uncaught exception: 1988 | hookEvent = "UsageDeleted";` followed by
`panic: Segmentation fault at address 0x152348000`. Diagnose-first: find the
code at/near that line emitting or folding the `UsageDeleted` event kind (recent
usage-surface epics changed this area), determine why it throws uncaught (a
worker error path not routed to fatalExit? a throw inside a fold — forbidden —
or main-side mint?), and whether the segfault is a separate bun:sqlite fault
(the fn-746 class) or a consequence. Fix the exception properly (never-throw
fold rules / safe extractor), route any remaining uncaught path loudly, and pin
with a test folding a malformed/edge UsageDeleted. Check server.stderr history
for how often this crash has fired today (each crash = unpaused-boot dup window
until .2 lands).

### Investigation targets

**Required**: grep src/ for "UsageDeleted" (mint + fold sites); server.stderr
crash context; src/usage-worker.ts; the reducer's usage fold arm; CLAUDE.md
never-throw-in-fold invariant.

## Acceptance

- [ ] verdict in Evidence (throw site, why uncaught, segfault relation, crash frequency today)
- [ ] exception fixed per the never-throw rules + test; full bun test green

## Done summary

## Evidence

## Description

**Size:** S
**Files:** sitters/builds/watch.ts, test/builds-watch.test.ts, agents/builds.md

### Approach

Add `export const STILL_RED_REEMIT_SECS = 7 * 24 * 60 * 60` (module-scope
named constant, matching the other sitters' time constants). Extend the
pure selection so an already-seen fingerprint whose red age crossed the
window re-selects for a fresh write: OR an aging clause into
`selectOnsets` (still-red AND `nowSecs - <aging anchor> >= STILL_RED_REEMIT_SECS`).
Add an OPTIONAL aging-anchor field to `SeenEntry` (e.g. `last_emitted`,
defaulting to `first_seen` when absent via `?? first_seen`) so
`SEEN_STATE_VERSION` does NOT bump — a bump would invalidate live
seen-state and re-onset every currently-red step in one burst. Re-arm in
`foldSeenState`: a successful re-emit advances the anchor to `nowSecs`;
a `writeFailed` re-emit must NOT advance it (retries next tick, the
existing best-effort contract). The re-emit flows through the existing
`tick` write loop and `lib/followups` writer unchanged — the fresh
filename ts from `nowSecs` IS the new occurrence the ledger consumes.
Keep detectors pure (clock via injected `nowSecs`); never throw inside
tick; green-clear and newest-build-only redness rules untouched.

Document the re-emit class in agents/builds.md (the producer doc's
occurrence-semantics section): still-red past 7 days re-emits one fresh
followup and re-arms; note for triage that a `stale`/`needs-work`
verdict on a still-red key will see a fresh occurrence file even though
the ledger's automatic resurface rule only re-enters
fixed/routed/landed-elsewhere — the fresh file re-enters triage as a new
unprocessed occurrence either way.

### Investigation targets

**Required** (read before coding):
- sitters/builds/watch.ts:498-500 — selectOnsets, the suppress gate the aging clause ORs into
- sitters/builds/watch.ts:512-546 — foldSeenState, the re-arm point + writeFailed carve-out
- sitters/builds/watch.ts:356-372 — SeenEntry/SeenState shape; :345,:449 — SEEN_STATE_VERSION load gate (why the new field must be optional)
- test/builds-watch.test.ts:540-639 — the multi-tick stay-red/green-clear template to extend; :89-111 — capturingWriter + sandbox helpers (nowSecs is injectable via TickDeps)

**Optional** (reference as needed):
- sitters/gitpolice/watch.ts:701-801 — SEEN_TTL_SECS precedent (prune-shaped; this task is the inverse, keep-and-re-emit)
- FINDINGS-LEDGER.md:184-208 — the resurface rule consuming the fresh occurrence ts

## Acceptance

- [ ] still-red fingerprint past STILL_RED_REEMIT_SECS re-selects and writes exactly one fresh followup with a new filename ts, then re-arms
- [ ] sub-threshold still-red stays suppressed (existing "stays red is NOT re-collected" test green); green-clear/onset behavior unchanged
- [ ] failed re-emit write does not advance the aging anchor (retries next tick)
- [ ] no SEEN_STATE_VERSION bump; legacy seen.json entries default the anchor safely
- [ ] agents/builds.md documents the re-emit class; bun test passes

## Done summary
Added a bounded still-red aging re-emit to the builds sitter: STILL_RED_REEMIT_SECS (7d) + an optional last_emitted anchor on SeenEntry (no SEEN_STATE_VERSION bump), an aging clause ORed into selectOnsets, and an anchor re-arm in foldSeenState that advances only on a successful re-emit. Documented the re-emit class in agents/builds.md.
## Evidence

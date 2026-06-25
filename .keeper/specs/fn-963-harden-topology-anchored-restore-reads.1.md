## Description

From audit finding F1 (src/restore-set.ts:686-688, selectDyingGenerationSnapshot):
the scan `SELECT id, data FROM events WHERE hook_event = 'TmuxTopologySnapshot'
ORDER BY id DESC` runs `.all()` with no LIMIT, pulling every retained snapshot
row AND body into memory before iterating newest-first. Now that
RETENTION_KEEP_CLASS_PREDICATE (src/compaction.ts:201) keeps every
TmuxTopologySnapshot row unconditionally, these rows accumulate for the DB's
lifetime, so the load grows without bound. The dying generation is always near
the DESC head (the deriver stops at the first non-G_now row), so a LIMIT on the
scan — or a streamed cursor — bounds the read without changing behavior. This is
a restore-time read, not a fold or the subscribe serve path, so it does not trip
the re-fold time-bomb invariant; the fix is purely to stop loading all of history.

## Acceptance

- [ ] The scan is bounded near the DESC head (a LIMIT sized to comfortably
      cover the dying generation, or a streamed cursor) rather than `.all()`
      over the full retained history.
- [ ] Existing deriver-selection behavior is unchanged: G_now-null, multi-dead-gen,
      malformed-skip, and fallback scenarios still select the same snapshot.
- [ ] The bound is large enough that a legitimately deep dying generation is
      never truncated below its correct snapshot.

## Done summary

## Evidence

## Overview

Tighten the transcript worker's `@parcel/watcher` change handling so only
real `.jsonl` transcript files reach the line stream. Today the
`ignore: ["**/*.!(jsonl)"]` glob does not fully exclude directory events and
non-`.jsonl` paths, so `stream.onChange` runs `statSync`/`openSync`/`readSync`
on every such event and logs `EISDIR` to stderr on directory events. This is
log pollution + wasted syscalls on every active session in a live
`~/.claude/projects` tree — observable, not a correctness defect.

## Acceptance

- [ ] Directory events and non-`.jsonl` paths no longer reach `stream.onChange`
      / the per-file tail (no `statSync`/`openSync`/`readSync` for them).
- [ ] No `EISDIR` stderr line is produced for directory change events.
- [ ] `TranscriptLineStream.onChange` is defensive against a non-file path
      (directory) reaching it directly.
- [ ] The stale `:480` comment is corrected to reflect that the callback (not
      only the ignore glob) is what guarantees `.jsonl`-only processing.
- [ ] A test asserts a non-`.jsonl` / directory event is ignored (closes
      tier-0 `test-gap-non-jsonl-filter`, folded in opportunistically).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | fn-551-filter-non-jsonl-events-in-transcript.1 | Confirmed at `src/transcript-worker.ts:477-488` (callback calls `onChange` for every non-delete event) + `onChange:211-273` (directory path → `openSync` succeeds, `readSync` throws EISDIR → logged at :270-272). Real per-session stderr noise + wasted I/O; the `:480` comment claiming the ignore glob filters is wrong. Auditor confirmed empirically with a live `@parcel/watcher` subscription. |

## Out of scope

- The 9 tier-0 advisory findings on the source epic, EXCEPT
  `test-gap-non-jsonl-filter` which is folded into this fix's test (it directly
  pins F1's fix). The rest (`pump-wakes-no-catch`, `parcel-watcher-restart-loop`,
  `transcript-path-no-canonicalize`, the other test gaps, etc.) are deferred —
  file a future epic if any earns promotion.
- Any change to the `ignore` glob semantics beyond adding the in-callback guard;
  the belt-and-suspenders approach (keep the glob, add the explicit `.jsonl`
  check) is intentional.
